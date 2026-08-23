#!/usr/bin/env node
/**
 * Local operator real-time sync — fast-path push, LISTENER side.
 *
 * Companion to local-sync.mjs (the periodic full-rescan reader) and
 * scripts/_seed-utils.mjs / server/_shared/sync-notify.ts (the write-side
 * notify). This process:
 *   1. Opens ONE persistent connection to Upstash's REST-based Server-Sent
 *      Events endpoint (`POST {UPSTASH_URL}/subscribe/sync:notify`) — plain
 *      HTTPS, not a raw RESP/TCP connection. That distinction matters: an
 *      earlier hand-rolled raw-protocol sync attempt was rejected as
 *      "unreliable from an operator workstation on a VPN" (see local-sync.mjs's
 *      own header comment) — this uses the same transport class as every
 *      other REST call this repo already makes, so it does not reopen that
 *      failure mode.
 *   2. On each message, applies exactly one row to local-cache.db — either
 *      directly (small values ride inline in the message) or via one
 *      targeted read for that single key (oversized values / non-string
 *      types only send a signal). Either way this is orders of magnitude
 *      cheaper than local-sync.mjs's full rescan, because cost now scales
 *      with what actually changed, not with wall-clock ticks.
 *   3. On (re)connect — including the very first connect after the process
 *      starts, which covers "the operator's laptop just woke from sleep":
 *      no explicit sleep/wake detection is needed. A suspended process's
 *      timers/connections don't fire while the machine is asleep, but
 *      wall-clock time (Date.now(), the stream's own TCP state) still
 *      advances via the RTC; the OS resumes the process on wake and the
 *      dropped SSE connection surfaces as an ordinary stream error, which
 *      this file's normal reconnect path already handles — first backfills
 *      via a changelog catch-up (XRANGE sync:changelog from the last
 *      persisted cursor), so anything published while disconnected/asleep
 *      still lands, cheaply (only the gap, not a full rescan).
 *   4. local-sync.mjs's own full rescan stays in place as the correctness
 *      backstop for whatever this file's best-effort design can still miss
 *      (a write whose own notify silently failed, a message this process
 *      was down for AND whose changelog entry has since been trimmed) — see
 *      that file for its own (now much less frequent) schedule.
 *
 * Credentials: UPSTASH_REDIS_REST_READONLY_TOKEN only, matching local-sync.mjs's
 * own blast-radius rationale — SUBSCRIBE, XRANGE, and every targeted
 * follow-up read (GET/ZRANGE/HGETALL/...) are all read verbs.
 */

import { DatabaseSync } from 'node:sqlite';
import { Redis } from '@upstash/redis';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMirroredKey } from '../../scripts/shared/sync-domains.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_READONLY_TOKEN = process.env.UPSTASH_REDIS_REST_READONLY_TOKEN;
const SQLITE_PATH = process.env.LOCAL_SQLITE_PATH || path.join(__dirname, 'local-cache.db');
// Stored beside the mirror, not inside it — the mirror itself gets replaced
// wholesale by local-sync.mjs's atomic rename swap, and a cursor tracks THIS
// process's progress through the changelog, not a property of the file.
const CURSOR_PATH = `${SQLITE_PATH}.sync-cursor.json`;

const SYNC_NOTIFY_CHANNEL = 'sync:notify';
const SYNC_CHANGELOG_STREAM = 'sync:changelog';

const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
// No confirmed keep-alive comment from Upstash's SSE implementation (not
// documented either way) — this is a self-imposed idle watchdog rather than
// trusting the stream to error out on its own. Mirrors local-sync.mjs's own
// documented finding that a stuck connection can "just hang await fetch()
// forever — no error ever gets thrown" when nothing upstream tears it down
// cleanly; reconnecting proactively on silence sidesteps that class of hang
// entirely instead of trying to detect it after the fact.
const IDLE_TIMEOUT_MS = 90_000;

/** Matches local-sync.mjs's READ_FOR_TYPE exactly — same one-command-per-real-type discipline. */
const READ_FOR_TYPE = {
  string: (redis, key) => redis.get(key),
  zset: (redis, key) => redis.zrange(key, 0, -1, { withScores: true }),
  hash: (redis, key) => redis.hgetall(key),
  set: (redis, key) => redis.smembers(key),
  list: (redis, key) => redis.lrange(key, 0, -1),
};

function assertEnv() {
  if (!UPSTASH_URL) throw new Error('UPSTASH_REDIS_REST_URL not set.');
  if (!UPSTASH_READONLY_TOKEN) {
    throw new Error(
      'UPSTASH_REDIS_REST_READONLY_TOKEN not set — see local-sync.mjs\'s own assertEnv() for why this ' +
        'never falls back to the write-capable token.',
    );
  }
}

function createReadClient() {
  return new Redis({ url: UPSTASH_URL, token: UPSTASH_READONLY_TOKEN });
}

function readCursor() {
  try {
    const raw = JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf-8'));
    return typeof raw.lastStreamId === 'string' ? raw.lastStreamId : '0';
  } catch {
    return '0'; // never caught up before, or file missing/corrupt — re-read from stream start
  }
}

function writeCursor(id) {
  try {
    fs.writeFileSync(CURSOR_PATH, JSON.stringify({ lastStreamId: id, updatedAt: Date.now() }));
  } catch (err) {
    console.warn(`[sync-listener] failed to persist cursor (non-fatal — next catch-up re-reads from the last saved point): ${err.message}`);
  }
}

/**
 * Opens local-cache.db fresh for exactly one write, then closes it —
 * deliberately NOT a persistent handle. local-sync.mjs's periodic full
 * reconciliation pass replaces the whole file via an atomic fs.renameSync()
 * swap (see that file's own header comment for why), and a long-lived
 * handle on POSIX keeps writing to the OLD inode forever after a rename
 * replaces the path. Opening fresh per write means every write targets
 * whatever file is actually live at that moment, sidestepping that trap
 * entirely rather than trying to detect the swap.
 *
 * WAL mode is set on every open (cheap, idempotent) so this small, fast,
 * single-row write never blocks a concurrent reader (sidecar-cache.ts's
 * loadMirror()) behind the default rollback-journal's exclusive lock. WAL
 * is NOT sticky across local-sync.mjs's rebuild (that scratch file starts
 * fresh, journal_mode unset) — reset here on every write, not assumed.
 */
function upsertRow(key, value, type) {
  fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });
  const db = new DatabaseSync(SQLITE_PATH);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        type TEXT NOT NULL,
        synced_at INTEGER NOT NULL
      )
    `);
    db.prepare(
      'INSERT INTO kv_cache (key, value, type, synced_at) VALUES (?, ?, ?, ?) '
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, type = excluded.type, synced_at = excluded.synced_at',
    ).run(key, value, type, Date.now());
  } finally {
    db.close();
  }
}

/**
 * Applies one change. Uses the inline value when the publisher sent one
 * (the common case — most rows are a few KB); otherwise does one targeted
 * read for just this key via the read-only token. Either path ends with
 * the exact same storage rule local-sync.mjs's readValues() uses (`typeof
 * raw === 'string' ? raw : JSON.stringify(raw)`) so kv_cache stays
 * byte-for-byte compatible with what a full rescan would have written —
 * sidecar-cache.ts's decodeMirrorEntry() can't tell which path produced a
 * given row.
 */
async function applyChange(redis, { key, type, value }) {
  if (!isMirroredKey(key)) return; // defense in depth — the write side already gates on this
  if (value !== undefined) {
    upsertRow(key, value, type);
    return;
  }
  const reader = READ_FOR_TYPE[type];
  if (!reader) {
    console.warn(`[sync-listener] unknown type "${type}" for ${key} — skipping targeted read`);
    return;
  }
  let raw;
  try {
    raw = await reader(redis, key);
  } catch (err) {
    console.warn(`[sync-listener] targeted read failed for ${key} (non-fatal — the periodic full reconciliation will cover it): ${err.message}`);
    return;
  }
  if (raw == null) return; // vanished between notify and this read
  upsertRow(key, typeof raw === 'string' ? raw : JSON.stringify(raw), type);
}

/**
 * Backfills anything missed while offline/asleep/disconnected: reads
 * sync:changelog from the last persisted cursor forward (exclusive lower
 * bound — Redis Streams' '(' prefix), applies each entry, and advances the
 * cursor as it goes so a crash mid-catch-up resumes from where it left off
 * rather than re-reading the whole thing. Runs on every (re)connect,
 * including the process's very first connect — see this file's header
 * comment for why that alone covers "caught up after the laptop woke up."
 */
async function catchUp(redis) {
  const cursor = readCursor();
  const startExclusive = cursor === '0' ? '-' : `(${cursor}`;
  let entries;
  try {
    entries = await redis.xrange(SYNC_CHANGELOG_STREAM, startExclusive, '+');
  } catch (err) {
    console.warn(`[sync-listener] changelog catch-up failed (non-fatal — the periodic full reconciliation will cover the gap): ${err.message}`);
    return;
  }
  const ids = Object.keys(entries || {}).sort();
  if (ids.length === 0) return;
  console.log(`[sync-listener] catch-up: ${ids.length} changelog entr${ids.length === 1 ? 'y' : 'ies'} since last cursor`);
  for (const id of ids) {
    const fields = entries[id];
    const key = fields?.key;
    const type = typeof fields?.type === 'string' ? fields.type : 'string';
    if (typeof key === 'string') {
      // Signal-only — the changelog never carries a value, only key+type
      // (see notifyChange()/notifyKeyChanged()'s own comment for why).
      await applyChange(redis, { key, type, value: undefined });
    }
    writeCursor(id);
  }
}

/**
 * Parses one buffered chunk of an SSE stream into complete frames (each
 * frame ends at a blank line per the SSE spec), extracting every `data:`
 * line. Returns [frames, remainder] — remainder is the incomplete tail to
 * prepend to the next chunk.
 */
function extractFrames(buffer) {
  const frames = [];
  const parts = buffer.split('\n\n');
  const remainder = parts.pop() ?? '';
  for (const part of parts) {
    const dataLines = part
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length > 0) frames.push(dataLines.join('\n'));
  }
  return [frames, remainder];
}

/**
 * Decodes one SSE `data:` payload into {key, type, value?}. Defensive about
 * shape because Upstash's exact /subscribe wire format for the data field
 * isn't pinned down in their public docs beyond "streams incoming messages"
 * — handles both "data: is the raw PUBLISH message string itself" and
 * "data: is a {channel, message} envelope" so this works either way. NOT
 * yet verified against a live Upstash endpoint — first real run should
 * confirm which shape actually arrives (see this file's own startup log).
 */
function decodeFrame(raw) {
  let outer;
  try {
    outer = JSON.parse(raw);
  } catch {
    return null; // not JSON at all — e.g. a keep-alive comment/ping frame
  }
  const inner = typeof outer?.message === 'string' ? outer.message : outer;
  const payload = typeof inner === 'string' ? JSON.parse(inner) : inner;
  if (!payload || typeof payload.key !== 'string' || typeof payload.type !== 'string') return null;
  return payload;
}

/**
 * Holds one SSE connection open until it errors, closes, or goes idle past
 * IDLE_TIMEOUT_MS. Resolves normally on any of those — the caller
 * (runForever) treats every return as "reconnect", there's no persistent
 * "healthy" exit.
 */
async function runOneConnection(redis) {
  const controller = new AbortController();
  let idleTimer;
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  };
  resetIdleTimer();

  let response;
  try {
    response = await fetch(`${UPSTASH_URL}/subscribe/${encodeURIComponent(SYNC_NOTIFY_CHANNEL)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_READONLY_TOKEN}`, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(idleTimer);
    throw err;
  }
  if (!response.ok || !response.body) {
    clearTimeout(idleTimer);
    throw new Error(`subscribe failed: HTTP ${response.status}`);
  }

  console.log('[sync-listener] connected — listening for changes');
  // Catch up AFTER the subscribe connection is open, not before, so a
  // notify published in between can't fall in the gap between the catch-up
  // read and the subscription taking effect.
  await catchUp(redis);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      resetIdleTimer();
      buffer += decoder.decode(value, { stream: true });
      const [frames, remainder] = extractFrames(buffer);
      buffer = remainder;
      for (const frame of frames) {
        const payload = decodeFrame(frame);
        if (payload) await applyChange(redis, payload);
      }
    }
  } finally {
    clearTimeout(idleTimer);
    reader.releaseLock?.();
  }
}

async function runForever() {
  assertEnv();
  const redis = createReadClient();
  let attempt = 0;
  for (;;) {
    try {
      await runOneConnection(redis);
      attempt = 0; // a clean connection that later dropped isn't a repeated-failure signal
    } catch (err) {
      console.warn(`[sync-listener] connection lost (${err.message}) — reconnecting`);
    }
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
    attempt++;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

// Only run when invoked directly (e.g. `node sync-listener.mjs`), not when
// imported — matches how local-api-server.mjs is expected to start this
// (see its own wiring), and keeps this file importable for tests without
// opening a real connection as a side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  runForever();
}

export { applyChange, catchUp, decodeFrame, extractFrames, upsertRow, runForever };
