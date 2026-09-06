#!/usr/bin/env node

/**
 * Telegram OSINT ingestion (public channels) → Early Signals feed.
 *
 * Ported from the Telegram MTProto poll loop that used to live inside
 * scripts/ais-relay.cjs (P14 Phase 2 tail — WS-core + Telegram extraction, see
 * PLATFORM_ARCHITECTURE.md decision P18). In the platform model the AIS relay
 * becomes ONE shared deploy; a per-tenant Telegram poller cannot ride it
 * (Telegram creds are not public data and each org polls its own channel set
 * with its own MTProto session), so this runs as a per-org Cloud Scheduler
 * `--once` job instead.
 *
 * HAND-ROLLED rather than built on runSeed(): the loop's real output is a
 * *rolling window* of the last N message objects merged into
 * `intelligence:telegram-feed:v1` (not one freshly-computed canonical value),
 * plus per-channel read cursors persisted to Redis so a one-shot job dedupes
 * across ticks the way the long-lived relay process did in memory. Same
 * hand-rolled shape as scripts/seed-social-velocity.mjs.
 *
 * Concurrency: a single Redis lock (P18) — an overrunning tick skips instead of
 * opening a second MTProto session, which invalidates the first with
 * AUTH_KEY_DUPLICATED.
 *
 * No @notification-source tag — the Telegram path never emitted notification
 * events; only Oref did, and Oref stays in ais-relay.cjs.
 *
 * Required env: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION
 * (StringSession). TELEGRAM_ENABLED is derived from all three being present;
 * absent → this is a clean no-op (exit 0).
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  acquireLockSafely,
  atomicPublish,
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
  readCanonicalValue,
  releaseLock,
} from './_seed-utils.mjs';

const require = createRequire(import.meta.url);
loadEnvFile(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FEED_KEY = 'intelligence:telegram-feed:v1';
const SEED_META_KEY = 'seed-meta:intelligence:telegram-feed:v1';
const CURSOR_KEY = 'intelligence:telegram-feed:cursor:v1';
// Data key TTL must outlive maxStaleMin (10 min = 600s) by enough buffer so
// health sees hasData=true + stale seed-meta → STALE_SEED. If both keys expire
// together health jumps straight to EMPTY and the stale window is never
// visible. 1800s (30 min) data vs 900s (15 min) meta gives a 15-min STALE_SEED
// window before EMPTY. Verbatim from the ais-relay.cjs loop.
const FEED_TTL = 1800;
const META_TTL = 900;
const CURSOR_TTL = 30 * 24 * 60 * 60; // 30 days — survives a long outage

const LOCK_DOMAIN = 'intelligence:telegram-poll';
// Lock must outlast a full poll cycle (TELEGRAM_POLL_CYCLE_TIMEOUT_MS = 180s) +
// connect + margin, so a slow tick still holds the lock for its whole run.
const LOCK_TTL_MS = 5 * 60 * 1000;

const TELEGRAM_ENABLED = Boolean(
  process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH && process.env.TELEGRAM_SESSION,
);
const TELEGRAM_MAX_FEED_ITEMS = Math.max(50, Number(process.env.TELEGRAM_MAX_FEED_ITEMS || 200));
const TELEGRAM_MAX_TEXT_CHARS = Math.max(200, Number(process.env.TELEGRAM_MAX_TEXT_CHARS || 800));
const TELEGRAM_CHANNEL_TIMEOUT_MS = 15_000; // per channel (getEntity + getMessages)
const TELEGRAM_POLL_CYCLE_TIMEOUT_MS = 180_000; // whole cycle
const TELEGRAM_RATE_LIMIT_MS = Math.max(300, Number(process.env.TELEGRAM_RATE_LIMIT_MS || 800));

// ── Channel list (verbatim from ais-relay.cjs loadTelegramChannels) ───────────
export function loadTelegramChannels() {
  // Product-managed curated list lives in repo root under data/ (shared by
  // web + desktop). This script runs from scripts/, so resolve ../data.
  const p = path.join(__dirname, '..', 'data', 'telegram-channels.json');
  const set = String(process.env.TELEGRAM_CHANNEL_SET || 'full').toLowerCase();
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const bucket = raw?.channels?.[set];
    const channels = Array.isArray(bucket) ? bucket : [];
    const parsed = channels
      .filter((c) => c && typeof c.handle === 'string' && c.handle.length > 1)
      .map((c) => ({
        handle: String(c.handle).replace(/^@/, ''),
        label: c.label ? String(c.label) : undefined,
        topic: c.topic ? String(c.topic) : undefined,
        region: c.region ? String(c.region) : undefined,
        tier: c.tier != null ? Number(c.tier) : undefined,
        enabled: c.enabled !== false,
        maxMessages: c.maxMessages != null ? Number(c.maxMessages) : undefined,
      }))
      .filter((c) => c.enabled);
    if (!parsed.length) {
      console.warn(`[Telegram] channel set "${set}" is empty — no channels to poll`);
    }
    return parsed;
  } catch (e) {
    console.warn(`[Telegram] failed to load telegram-channels.json: ${e?.message || String(e)}`);
    return [];
  }
}

// ── Message normalization (verbatim from ais-relay.cjs) ───────────────────────
export function normalizeTelegramMessage(msg, channel) {
  const textRaw = String(msg?.message || '');
  const text = textRaw.slice(0, TELEGRAM_MAX_TEXT_CHARS);
  const ts = msg?.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString();
  return {
    id: `${channel.handle}:${msg.id}`,
    source: 'telegram',
    channel: channel.handle,
    channelTitle: channel.label || channel.handle,
    url: `https://t.me/${channel.handle}/${msg.id}`,
    ts,
    text,
    topic: channel.topic || 'other',
    tags: [channel.region].filter(Boolean),
    earlySignal: true,
  };
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function destroyTelegramClient(client) {
  if (!client) return;
  try { client.disconnect(); } catch {}
  try {
    if (client._sender) {
      client._sender._reconnecting = false;
      client._sender._autoReconnect = false;
      if (client._sender._connection) {
        try { client._sender._connection.socket?.destroy?.(); } catch {}
        try { client._sender._connection.close?.(); } catch {}
      }
    }
  } catch {}
}

// ── Cursor state (replaces the relay's in-process cursorByHandle Map) ─────────
async function readCursors() {
  try {
    const raw = await readCanonicalValue(CURSOR_KEY);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
  } catch (e) {
    console.warn(`[Telegram] cursor read failed (${e?.message || e}) — starting from 0`);
  }
  return Object.create(null);
}

async function writeCursors(cursors) {
  try {
    const { url, token } = getRedisCredentials();
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', CURSOR_KEY, JSON.stringify(cursors), 'EX', CURSOR_TTL]]),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) console.warn(`[Telegram] cursor write failed: HTTP ${resp.status}`);
  } catch (e) {
    console.warn(`[Telegram] cursor write threw: ${e?.message || e}`);
  }
}

async function writeSeedMeta(recordCount) {
  try {
    const { url, token } = getRedisCredentials();
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['SET', SEED_META_KEY, JSON.stringify({ fetchedAt: Date.now(), recordCount }), 'EX', META_TTL],
      ]),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) console.warn(`[Telegram] seed-meta write failed: HTTP ${resp.status}`);
  } catch (e) {
    console.warn(`[Telegram] seed-meta write threw: ${e?.message || e}`);
  }
}

// ── Poll one cycle. Returns { channelsPolled, newItems, connected }. ──────────
async function pollTelegramOnce(cursors) {
  const apiId = parseInt(String(process.env.TELEGRAM_API_ID || ''), 10);
  const apiHash = String(process.env.TELEGRAM_API_HASH || '');
  const sessionStr = String(process.env.TELEGRAM_SESSION || '');

  let TelegramClient;
  let StringSession;
  try {
    ({ TelegramClient } = await import('telegram'));
    ({ StringSession } = await import('telegram/sessions/index.js'));
  } catch (e) {
    const em = e?.message || String(e);
    if (e?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find package|Directory import/.test(em)) {
      console.warn('[Telegram] telegram package not installed — nothing to poll');
      return { channelsPolled: 0, newItems: [], connected: false, fatal: false };
    }
    throw e;
  }

  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
    connectionRetries: 3,
  });

  try {
    await client.connect();
  } catch (e) {
    const em = e?.message || String(e);
    destroyTelegramClient(client);
    if (/AUTH_KEY_DUPLICATED/.test(em)) {
      console.error('[Telegram] session invalidated (AUTH_KEY_DUPLICATED) — generate a new TELEGRAM_SESSION with: node scripts/telegram/session-auth.mjs');
      return { channelsPolled: 0, newItems: [], connected: false, fatal: true };
    }
    console.warn(`[Telegram] connect failed: ${em}`);
    return { channelsPolled: 0, newItems: [], connected: false, fatal: false };
  }

  console.log('[Telegram] client connected');

  const channels = loadTelegramChannels();
  if (!channels.length) {
    destroyTelegramClient(client);
    return { channelsPolled: 0, newItems: [], connected: true, fatal: false };
  }

  const newItems = [];
  const pollStart = Date.now();
  let channelsPolled = 0;
  let channelsFailed = 0;
  let mediaSkipped = 0;

  for (const channel of channels) {
    if (Date.now() - pollStart > TELEGRAM_POLL_CYCLE_TIMEOUT_MS) {
      console.warn(`[Telegram] poll cycle timeout (${Math.round(TELEGRAM_POLL_CYCLE_TIMEOUT_MS / 1000)}s), polled ${channelsPolled}/${channels.length} channels`);
      break;
    }

    const handle = channel.handle;
    const minId = cursors[handle] || 0;

    try {
      const entity = await withTimeout(client.getEntity(handle), TELEGRAM_CHANNEL_TIMEOUT_MS, `getEntity(${handle})`);
      const msgs = await withTimeout(
        client.getMessages(entity, {
          limit: Math.max(1, Math.min(50, channel.maxMessages || 25)),
          minId,
        }),
        TELEGRAM_CHANNEL_TIMEOUT_MS,
        `getMessages(${handle})`,
      );

      for (const msg of msgs) {
        if (!msg || !msg.id) continue;
        if (!msg.message) { mediaSkipped++; continue; }
        newItems.push(normalizeTelegramMessage(msg, channel));
        if (!cursors[handle] || msg.id > cursors[handle]) cursors[handle] = msg.id;
      }

      channelsPolled++;
      await new Promise((r) => setTimeout(r, TELEGRAM_RATE_LIMIT_MS));
    } catch (e) {
      const em = e?.message || String(e);
      channelsFailed++;
      console.warn(`[Telegram] poll ${handle} failed: ${em}`);
      if (/AUTH_KEY_DUPLICATED/.test(em)) {
        console.error('[Telegram] session invalidated (AUTH_KEY_DUPLICATED) — generate a new TELEGRAM_SESSION with: node scripts/telegram/session-auth.mjs');
        destroyTelegramClient(client);
        return { channelsPolled, newItems, connected: true, fatal: true };
      }
      if (/FLOOD_WAIT/.test(em)) {
        const wait = parseInt(em.match(/(\d+)/)?.[1] || '60', 10);
        console.warn(`[Telegram] FLOOD_WAIT ${wait}s — stopping poll cycle early`);
        break;
      }
    }
  }

  const elapsed = ((Date.now() - pollStart) / 1000).toFixed(1);
  console.log(`[Telegram] poll: ${channelsPolled}/${channels.length} channels, ${newItems.length} new msgs, ${channelsFailed} errors, ${mediaSkipped} media-only skipped (${elapsed}s)`);

  destroyTelegramClient(client);
  return { channelsPolled, newItems, connected: true, fatal: false };
}

// ── Merge new items into the rolling window (replaces telegramState.items) ────
export function mergeFeed(existingItems, newItems) {
  const seen = new Set();
  return [...newItems, ...(Array.isArray(existingItems) ? existingItems : [])]
    .filter((item) => {
      if (!item || !item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
    .slice(0, TELEGRAM_MAX_FEED_ITEMS);
}

export async function main() {
  const startedAt = Date.now();

  if (!TELEGRAM_ENABLED) {
    console.log('[Telegram] TELEGRAM_API_ID/API_HASH/SESSION not all set — nothing to poll (no-op)');
    return;
  }

  const runId = `telegram:${startedAt}`;
  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });
  if (lock.skipped) return;
  if (!lock.locked) {
    console.log('[Telegram] Lock held, skipping');
    return;
  }

  try {
    const cursors = await readCursors();
    const { channelsPolled, newItems, connected, fatal } = await pollTelegramOnce(cursors);

    if (!connected) {
      // Client never connected: do NOT touch the feed key — its existing
      // contents + TTL are still the best available. A dead session surfaces
      // via the aging seed-meta key.
      throw new Error(fatal ? 'telegram session invalidated (AUTH_KEY_DUPLICATED)' : 'telegram client did not connect');
    }

    if (channelsPolled === 0) {
      console.warn('[Telegram] 0 channels polled — leaving feed key untouched');
      // Not a hard failure when the session is fine but every channel errored
      // this tick; the next tick retries. Exit non-zero only if the run also
      // hit a fatal session error.
      if (fatal) throw new Error('telegram session invalidated (AUTH_KEY_DUPLICATED)');
      return;
    }

    const existing = await readCanonicalValue(FEED_KEY).catch(() => null);
    const existingItems = existing && typeof existing === 'object' ? existing.items : [];
    const items = mergeFeed(existingItems, newItems);

    const payload = {
      enabled: true,
      updatedAt: new Date().toISOString(),
      count: items.length,
      items,
    };
    await atomicPublish(FEED_KEY, payload, null, FEED_TTL);
    await writeCursors(cursors);
    await writeSeedMeta(items.length);

    logSeedResult('intelligence:telegram-feed', items.length, Date.now() - startedAt);
    console.log(`[Telegram] Seeded ${items.length} items (${newItems.length} new this tick)`);

    if (fatal) {
      // Data was still published above; surface the session death so the
      // operator rotates TELEGRAM_SESSION.
      throw new Error('telegram session invalidated (AUTH_KEY_DUPLICATED) — feed published but rotate TELEGRAM_SESSION');
    }
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

if (process.argv[1]?.endsWith('seed-telegram.mjs')) {
  main().catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
