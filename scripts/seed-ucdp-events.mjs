#!/usr/bin/env node

/**
 * @notification-source: domain
 *   publishNotificationEvent() calls in this file build payload.title from
 *   structured UCDP fields (country/parties/deaths). Events are NOT RSS-origin
 *   and MUST NOT set payload.description. Enforced by
 *   tests/notification-relay-payload-audit.test.mjs.
 *
 * Notification-publishing ported from the startUcdpSeedLoop() that used to
 * live inside scripts/ais-relay.cjs (stripped as part of the P14 loop-deletion
 * pass — see PLATFORM_ARCHITECTURE.md session 61/62). ais-relay's loop ran in
 * a long-lived process and kept an in-memory `ucdpPrevAlertedIds` Set (capped
 * at 500, cleared on overflow) so the same conflict-escalation event wasn't
 * re-notified every 6h tick for as long as it stayed inside the newest-pages
 * fetch window (which can be weeks — much longer than the 24h SETNX dedup TTL
 * on the notification queue itself). A one-shot cron script has no such
 * process-lifetime memory, so that Set is persisted to Redis here instead
 * (UCDP_PREV_ALERTED_KEY) using the same read-filter-merge-write pattern
 * scripts/seed-aviation.mjs already uses for its own prev-alerted state.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { compactUcdpDashboardPayload } from './_ucdp-dashboard.mjs';
import { getRedisCredentials } from './_seed-utils.mjs';
import notificationDedup from './shared/notification-dedup.cjs';
import countryNameMap from './shared/country-name-to-iso2.cjs';

const { buildDedupMaterial, classifySetNxResult, recordDedupOutcome } = notificationDedup;
const { countryNameToIso2 } = countryNameMap;

const __dirname = dirname(fileURLToPath(import.meta.url));

const REDIS_KEY = 'conflict:ucdp-events:v1';
// Dashboard-sized projection. The bootstrap slow tier hydrates from THIS key so
// every client stops downloading 2,000 events (662 KB) to render 150 rows and a
// handful of derived numbers (#5300). The canonical key above is untouched and
// still serves the RPC, MCP and the map layer.
const BOOTSTRAP_KEY = 'conflict:ucdp-events-bootstrap:v1';
const BOOTSTRAP_META_KEY = 'seed-meta:conflict:ucdp-events-bootstrap';
const UCDP_PAGE_SIZE = 1000;
const MAX_PAGES = 6;
// A single pagesize=1000 page measured ~105s in production (2026-08-17 seed-source
// review) — the previous 90s AbortSignal timeout guaranteed every page would abort,
// masquerading as a UCDP outage/auth failure. 180s leaves real margin above the
// measured latency without being unbounded.
const UCDP_FETCH_TIMEOUT_MS = 180_000;
const MAX_EVENTS = 2000; // Redis payload guard; widening needs live UCDP volume + Upstash payload validation.
// Retained Redis input window. CII v8's classifier accepts a 2-year window, but
// this writer fetches the newest pages only and keeps at most MAX_EVENTS from a
// 365-day trailing slice until retention is deliberately widened.
const TRAILING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

const VIOLENCE_TYPE_MAP = {
  1: 'UCDP_VIOLENCE_TYPE_STATE_BASED',
  2: 'UCDP_VIOLENCE_TYPE_NON_STATE',
  3: 'UCDP_VIOLENCE_TYPE_ONE_SIDED',
};

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function loadEnvFile() {
  let envPath = join(__dirname, '..', '.env.local');
  if (!existsSync(envPath)) {
    envPath = join('/Users/eliehabib/Documents/GitHub/worldmonitor', '.env.local');
  }
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

function maskToken(token) {
  if (!token || token.length < 8) return '***';
  return token.slice(0, 4) + '***' + token.slice(-4);
}

function buildVersionCandidates() {
  const year = new Date().getFullYear() - 2000;
  return [...new Set([`${year}.1`, `${year - 1}.1`, '25.1', '24.1'])];
}

async function fetchGedPage(version, page, token) {
  const headers = { Accept: 'application/json', 'User-Agent': CHROME_UA };
  if (token) headers['x-ucdp-access-token'] = token;
  const resp = await fetch(
    `https://ucdpapi.pcr.uu.se/api/gedevents/${version}?pagesize=${UCDP_PAGE_SIZE}&page=${page}`,
    { headers, signal: AbortSignal.timeout(UCDP_FETCH_TIMEOUT_MS) },
  );
  if (!resp.ok) throw new Error(`UCDP GED API error (${version}, page ${page}): ${resp.status}`);
  return resp.json();
}

async function discoverVersion(token, fetchPage = fetchGedPage, candidates = buildVersionCandidates()) {
  console.log(`  Probing versions sequentially: ${candidates.join(', ')}`);
  for (const version of candidates) {
    try {
      console.log(`  Trying v${version}...`);
      const page0 = await fetchPage(version, 0, token);
      if (!Array.isArray(page0?.Result) || page0.Result.length === 0) continue;
      console.log(`  Found v${version} with ${page0.Result.length} events on page 0`);
      return { version, page0 };
    } catch (err) {
      console.warn(`  v${version} failed: ${err.message}`);
    }
  }
  throw new Error('No valid UCDP GED version found');
}

function parseDateMs(value) {
  if (!value) return NaN;
  return Date.parse(String(value));
}

function getMaxDateMs(events) {
  let maxMs = NaN;
  for (const event of events) {
    const ms = parseDateMs(event?.date_start);
    if (!Number.isFinite(ms)) continue;
    if (!Number.isFinite(maxMs) || ms > maxMs) maxMs = ms;
  }
  return maxMs;
}

// ─── Notification publishing ─────────────────────────────────────────────────
// Mirrors ais-relay.cjs::publishNotificationEvent (same inline-Upstash-helpers
// pattern already used by scripts/seed-aviation.mjs): LPUSH the event onto
// wm:events:queue, guarded by a SETNX dedup key (TTL = dedupTtl). On LPUSH
// failure, rollback the dedup key so the next run can retry.

// Persisted prev-alerted-IDs state — see file header comment for why this
// exists (a one-shot cron has no in-process memory across ticks). 30 days
// comfortably outlives the 365-day TRAILING_WINDOW_MS *without* trying to
// match it — the primary bound on this list's size is the 500-entry cap
// below (mirroring ais-relay's in-memory Set), not the TTL. The TTL only
// protects against the key surviving forever if this seeder is ever retired.
const UCDP_PREV_ALERTED_KEY = 'conflict:ucdp-events:prev-alerted:v1';
const UCDP_PREV_ALERTED_TTL_SECONDS = 30 * 24 * 60 * 60;
const UCDP_PREV_ALERTED_CAP = 500;

function notifyHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

async function upstashCommand(cmd) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Upstash ${cmd[0]} failed: HTTP ${resp.status}`);
  return resp.json();
}

async function upstashGetJson(key) {
  try {
    const result = await upstashCommand(['GET', key]);
    if (!result?.result) return null;
    try { return JSON.parse(result.result); } catch { return null; }
  } catch { return null; }
}

async function upstashSetJson(key, value, ttlSeconds) {
  try {
    const result = await upstashCommand(['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)]);
    return result?.result === 'OK';
  } catch { return false; }
}

async function upstashSetNx(key, value, ttlSeconds) {
  try {
    const result = await upstashCommand(['SET', key, value, 'NX', 'EX', String(ttlSeconds)]);
    return classifySetNxResult(result?.result);
  } catch { return 'error'; }
}

async function upstashLpush(key, value) {
  try {
    const result = await upstashCommand(['LPUSH', key, value]);
    return typeof result?.result === 'number' && result.result > 0;
  } catch { return false; }
}

async function upstashDel(key) {
  try {
    const result = await upstashCommand(['DEL', key]);
    return result?.result === 1;
  } catch { return false; }
}

function normalizeNotificationCountryCode(raw) {
  return countryNameToIso2(raw) ?? undefined;
}

async function publishNotificationEvent({ eventType, payload, severity, variant, dedupTtl = 1800 }) {
  try {
    const variantSuffix = variant ? `:${variant}` : '';
    const dedupMaterial = buildDedupMaterial(eventType, payload?.title, payload?.coalesceKey);
    const dedupKey = `wm:notif:scan-dedup:${eventType}${variantSuffix}:${notifyHash(dedupMaterial)}`;
    const dedupResult = await upstashSetNx(dedupKey, '1', dedupTtl);
    const dedupDecision = recordDedupOutcome(dedupResult, {
      surface: 'seed-ucdp-events',
      eventType,
      severity,
      fallbackKey: dedupKey,
      fallbackTtlSeconds: dedupTtl,
      emitTelemetry: ({ line }) => console.warn(line),
    });
    if (!dedupDecision.shouldPublish) {
      if (!dedupDecision.isDuplicate) return;
      console.log(`[Notify] Dedup hit — ${eventType}: ${String(payload.title ?? '').slice(0, 60)}`);
      return;
    }
    const msg = JSON.stringify({ eventType, payload, severity: dedupDecision.severity, ...(variant ? { variant } : {}), publishedAt: Date.now() });
    const ok = await upstashLpush('wm:events:queue', msg);
    if (ok) {
      console.log(`[Notify] Queued ${dedupDecision.severity} event: ${eventType} — ${String(payload.title ?? '').slice(0, 60)}`);
    } else {
      console.warn(`[Notify] LPUSH failed for ${eventType} — rolling back dedup key`);
      await upstashDel(dedupKey);
    }
  } catch (e) {
    console.warn(`[Notify] publishNotificationEvent error (${eventType}):`, e?.message || e);
  }
}

// Ported from ais-relay.cjs's post-seed notification block. Called only after
// a successful canonical publish, with the same `capped` events array that
// was just written to Redis.
async function dispatchUcdpNotifications(events) {
  const prev = await upstashGetJson(UCDP_PREV_ALERTED_KEY);
  const prevAlertedIds = new Set(Array.isArray(prev) ? prev : []);

  const newConflicts = events
    .filter((e) => e.deathsBest >= 10 && !prevAlertedIds.has(e.id))
    .sort((a, b) => b.deathsBest - a.deathsBest);

  for (const e of newConflicts.slice(0, 2)) {
    prevAlertedIds.add(e.id);
    const parties = e.sideA && e.sideB ? `${e.sideA.slice(0, 40)} vs ${e.sideB.slice(0, 40)}` : e.sideA || e.sideB || 'Unknown parties';
    const countryCode = normalizeNotificationCountryCode(e.country);
    await publishNotificationEvent({
      eventType: 'conflict_escalation',
      payload: { title: `${e.country}: ${parties} — ${e.deathsBest} casualties`, source: 'UCDP', ...(countryCode ? { countryCode } : {}) },
      severity: e.deathsBest >= 50 ? 'critical' : 'high',
      variant: undefined,
      dedupTtl: 86400,
    });
  }

  // Cap-then-clear mirrors ais-relay's in-memory Set behavior exactly: once
  // the persisted list exceeds the cap, drop it entirely rather than
  // trimming, so a later dedupTtl-expired re-scan of an old event isn't
  // silently protected by a partial history. Overflow is rare in practice —
  // at most 2 IDs are added per run.
  const nextAlertedIds = prevAlertedIds.size > UCDP_PREV_ALERTED_CAP ? [] : [...prevAlertedIds];
  await upstashSetJson(UCDP_PREV_ALERTED_KEY, nextAlertedIds, UCDP_PREV_ALERTED_TTL_SECONDS);
}

async function main() {
  loadEnvFile();

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const ucdpToken = (process.env.UCDP_ACCESS_TOKEN || process.env.UC_DP_KEY || '').trim();

  if (!redisUrl || !redisToken) {
    console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
    process.exit(1);
  }

  console.log('=== UCDP Events Seed ===');
  console.log(`  Redis:      ${redisUrl}`);
  console.log(`  Redis Token: ${maskToken(redisToken)}`);
  console.log(`  UCDP Token: ${ucdpToken ? maskToken(ucdpToken) : '(none — unauthenticated)'}`);
  console.log();

  const { version, page0 } = await discoverVersion(ucdpToken);
  const totalPages = Math.max(1, Number(page0?.TotalPages) || 1);
  const newestPage = totalPages - 1;
  console.log(`  Version: ${version} | Total pages: ${totalPages}`);

  const FAILED = Symbol('failed');
  const pagesToFetch = [];
  for (let offset = 0; offset < MAX_PAGES && (newestPage - offset) >= 0; offset++) {
    const page = newestPage - offset;
    if (page === 0) {
      pagesToFetch.push(Promise.resolve(page0));
    } else {
      pagesToFetch.push(fetchGedPage(version, page, ucdpToken).catch((err) => {
        console.warn(`  [UCDP] page ${page}: ${err.message || err}`);
        return FAILED;
      }));
    }
  }

  const pageResults = await Promise.all(pagesToFetch);

  const allEvents = [];
  let latestDatasetMs = NaN;
  let failedPages = 0;

  for (const rawData of pageResults) {
    if (rawData === FAILED) { failedPages++; continue; }
    const events = Array.isArray(rawData?.Result) ? rawData.Result : [];
    allEvents.push(...events);
    const pageMaxMs = getMaxDateMs(events);
    if (!Number.isFinite(latestDatasetMs) && Number.isFinite(pageMaxMs)) {
      latestDatasetMs = pageMaxMs;
    }
  }

  console.log(`  Raw events: ${allEvents.length} | Failed pages: ${failedPages}`);

  const filtered = allEvents.filter((event) => {
    if (!Number.isFinite(latestDatasetMs)) return true;
    const eventMs = parseDateMs(event?.date_start);
    if (!Number.isFinite(eventMs)) return false;
    return eventMs >= (latestDatasetMs - TRAILING_WINDOW_MS);
  });

  console.log(`  After 1-year trailing window: ${filtered.length}`);

  const mapped = filtered.map((e) => ({
    id: String(e.id || ''),
    dateStart: Date.parse(e.date_start) || 0,
    dateEnd: Date.parse(e.date_end) || 0,
    location: {
      latitude: Number(e.latitude) || 0,
      longitude: Number(e.longitude) || 0,
    },
    country: e.country || '',
    sideA: (e.side_a || '').substring(0, 200),
    sideB: (e.side_b || '').substring(0, 200),
    deathsBest: Number(e.best) || 0,
    deathsLow: Number(e.low) || 0,
    deathsHigh: Number(e.high) || 0,
    violenceType: VIOLENCE_TYPE_MAP[e.type_of_violence] || 'UCDP_VIOLENCE_TYPE_UNSPECIFIED',
    sourceOriginal: (e.source_original || '').substring(0, 300),
  }));

  mapped.sort((a, b) => b.dateStart - a.dateStart);
  const capped = mapped.slice(0, MAX_EVENTS);
  if (mapped.length > MAX_EVENTS) console.log(`  Capped: ${mapped.length} → ${MAX_EVENTS}`);

  // Guard: never overwrite existing data with empty results.
  // Extend TTL on existing key instead so health stays OK.
  if (capped.length === 0) {
    console.warn(`  0 events after processing — extending existing key TTL (preserving last good data)`);
    try {
      const r1 = await fetch(redisUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['EXPIRE', REDIS_KEY, 86400]),
        signal: AbortSignal.timeout(5_000),
      });
      if (!r1.ok) console.warn(`  EXPIRE ${REDIS_KEY} failed: HTTP ${r1.status}`);
      const r2 = await fetch(redisUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['EXPIRE', 'seed-meta:conflict:ucdp-events', 604800]),
        signal: AbortSignal.timeout(5_000),
      });
      if (!r2.ok) console.warn(`  EXPIRE seed-meta failed: HTTP ${r2.status}`);
      if (r1.ok && r2.ok) console.log(`  Extended TTL on ${REDIS_KEY} and seed-meta`);
    } catch (e) { console.warn(`  TTL extension failed: ${e.message}`); }
    process.exit(0);
  }

  const payload = {
    events: capped,
    fetchedAt: Date.now(),
    version,
    totalRaw: allEvents.length,
    filteredCount: mapped.length,
  };

  console.log(`  Mapped: ${mapped.length} events`);
  if (mapped[0]) {
    console.log(`  Newest: ${new Date(mapped[0].dateStart).toISOString().slice(0, 10)} — ${mapped[0].country}`);
  }
  console.log();

  const body = JSON.stringify(['SET', REDIS_KEY, JSON.stringify(payload), 'EX', 86400]);
  const resp = await fetch(redisUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${redisToken}`,
      'Content-Type': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error(`Redis SET failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
    process.exit(1);
  }

  const result = await resp.json();
  console.log('  Redis SET result:', result);

  // Compact dashboard projection (#5300): rows the panel renders + aggregates and
  // classifications it derives from the full set. Best-effort — a failure here
  // must not fail the canonical publish; bootstrap falls back to reporting the key
  // missing and the client re-fetches from the RPC.
  try {
    const compact = compactUcdpDashboardPayload(payload);
    const compactBody = JSON.stringify(['SET', BOOTSTRAP_KEY, JSON.stringify(compact), 'EX', 86400]);
    const compactResp = await fetch(redisUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
      body: compactBody,
      signal: AbortSignal.timeout(15_000),
    });
    if (!compactResp.ok) throw new Error(`HTTP ${compactResp.status}`);

    const compactMeta = JSON.stringify({ fetchedAt: Date.now(), recordCount: compact.events.length });
    const compactMetaResp = await fetch(redisUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', BOOTSTRAP_META_KEY, compactMeta, 'EX', 604800]),
      signal: AbortSignal.timeout(5_000),
    });
    if (!compactMetaResp.ok) throw new Error(`seed-meta HTTP ${compactMetaResp.status}`);
    console.log(`  Wrote ${BOOTSTRAP_KEY}: ${compact.events.length} rows, ${Object.keys(compact.classifications).length} classifications (from ${compact.totalEvents} events)`);
  } catch (e) {
    console.error(`  Compact projection write failed: ${e.message} — canonical key is published, dashboard will fall back to the RPC`);
  }

  // Write seed-meta for health endpoint freshness tracking
  const metaKey = 'seed-meta:conflict:ucdp-events';
  const meta = { fetchedAt: Date.now(), recordCount: capped.length };
  const metaBody = JSON.stringify(['SET', metaKey, JSON.stringify(meta), 'EX', 604800]);
  await fetch(redisUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
    body: metaBody,
    signal: AbortSignal.timeout(5_000),
  }).catch(() => console.error('  seed-meta write failed'));
  console.log(`  Wrote seed-meta: ${metaKey}`);

  // Best-effort — a notification failure must not fail the canonical publish
  // (the data write above already succeeded and returned OK).
  try {
    await dispatchUcdpNotifications(capped);
  } catch (e) {
    console.warn(`  Notification dispatch failed: ${e.message}`);
  }

  const getResp = await fetch(`${redisUrl}/get/${encodeURIComponent(REDIS_KEY)}`, {
    headers: { Authorization: `Bearer ${redisToken}` },
    signal: AbortSignal.timeout(15_000), // match the SET call's budget above — this
    // read-back is verification-only (the write above already returned OK), but a too-
    // tight timeout here throws a scary top-level FATAL over a purely cosmetic recheck.
  });
  if (getResp.ok) {
    const getData = await getResp.json();
    if (getData.result) {
      const parsed = unwrapEnvelope(JSON.parse(getData.result)).data;
      console.log(`\n  Verified: ${parsed.events?.length} events in Redis`);
      console.log(`  Version: ${parsed.version} | fetchedAt: ${new Date(parsed.fetchedAt).toISOString()}`);
    }
  }

  console.log('\n=== Done ===');
}

export { buildVersionCandidates, discoverVersion };

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(err => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
    // Exit gracefully for cron — crashing restarts the container unnecessarily.
    // The health endpoint will flag stale data via seed-meta.
    process.exit(0);
  });
}
