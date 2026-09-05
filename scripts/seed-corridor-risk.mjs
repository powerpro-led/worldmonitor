#!/usr/bin/env node

/**
 * @notification-source: domain
 *   publishNotificationEvent() calls in this file build payload.title from
 *   structured Corridor Risk fields (chokepoint label / risk score / risk
 *   summary). Events are NOT RSS-origin and MUST NOT set payload.description.
 *   Enforced by tests/notification-relay-payload-audit.test.mjs.
 *
 * Corridor Risk seed — corridorrisk.io open-beta API (no auth). Maps the
 * upstream corridor list onto WorldMonitor's canonical chokepoint IDs and
 * stores the per-chokepoint risk rollup under supply_chain:corridorrisk:v1
 * so the GetCorridorRisk RPC and the relay's TransitSummary loop serve it
 * unchanged.
 *
 * Ported verbatim (fetch, Cloudflare-challenge guard, CORRIDOR_RISK_NAME_MAP,
 * risk-level derivation, output-field shaping, and the >=50 notification
 * threshold) from the startCorridorRiskSeedLoop() that used to live inside
 * scripts/ais-relay.cjs — P14 Phase 2 loop-extraction pass (see
 * PLATFORM_ARCHITECTURE.md session 63). Two deliberate deviations from the
 * relay loop:
 *   1. The relay kicked seedTransitSummaries() immediately after a successful
 *      corridor-risk write. A standalone cron cannot reach that relay-internal
 *      function; TransitSummary already Redis-hydrates supply_chain:corridorrisk:v1
 *      on its own 10-min tick when its in-process copy is null, so the only
 *      change is that corridor data reaches transit summaries on the next
 *      TransitSummary tick instead of instantly.
 *   2. Unlike ais-relay's long-lived process, this is a one-shot invocation, so
 *      the only dedup guard on the notification is the Redis-backed SETNX inside
 *      publishNotificationEvent (keyed by title hash, TTL-bounded) — exactly as
 *      it already was for every OTHER call site of the relay's publisher.
 */

import { loadEnvFile, CHROME_UA, runSeed, getRedisCredentials } from './_seed-utils.mjs';
import notificationDedup from './shared/notification-dedup.cjs';

const { buildDedupMaterial, classifySetNxResult, recordDedupOutcome } = notificationDedup;

loadEnvFile(import.meta.url);

const BASE_URL = 'https://corridorrisk.io/api/corridors';
const CANONICAL_KEY = 'supply_chain:corridorrisk:v1';
// 4h — 4x the 1h cron cadence, and STRICTLY above the 120-min (7200s) health
// staleness gate (tests/seed-ttl-outlives-staleness-fleet.test.mjs) so a
// merely-late seeder escalates STALE_SEED→EMPTY in order. Matches the relay
// loop's CORRIDOR_RISK_TTL exactly (14400 > 7200, already safe — no ratchet
// bump needed, unlike USNI/PizzINT/PositiveEvents earlier this pass).
const CACHE_TTL = 14400;

// API name -> canonical chokepoint ID (partial substring match). Ported verbatim.
const CORRIDOR_RISK_NAME_MAP = [
  { pattern: 'hormuz', id: 'hormuz_strait' },
  { pattern: 'bab-el-mandeb', id: 'bab_el_mandeb' },
  { pattern: 'red sea', id: 'bab_el_mandeb' },
  { pattern: 'suez', id: 'suez' },
  { pattern: 'south china sea', id: 'taiwan_strait' },
  { pattern: 'black sea', id: 'bosphorus' },
];

async function fetchCorridorRisk() {
  const resp = await fetch(BASE_URL, {
    headers: {
      Accept: 'application/json',
      'User-Agent': CHROME_UA,
      Referer: 'https://corridorrisk.io/dashboard.html',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`[CorridorRisk] HTTP ${resp.status} (${resp.headers.get('content-type') || 'unknown'}) — ${body.slice(0, 200)}`);
  }
  const text = await resp.text();
  if (text.startsWith('<')) {
    throw new Error(`[CorridorRisk] Got HTML instead of JSON (Cloudflare challenge?) — ${text.slice(0, 150)}`);
  }
  const corridors = JSON.parse(text);
  if (!Array.isArray(corridors) || !corridors.length) {
    throw new Error('[CorridorRisk] No corridors returned');
  }

  const result = {};
  for (const corridor of corridors) {
    const name = (corridor.name || '').toLowerCase();
    const mapping = CORRIDOR_RISK_NAME_MAP.find(m => name.includes(m.pattern));
    if (!mapping) continue;
    const score = Number(corridor.score ?? 0);
    const riskLevel = score >= 70 ? 'critical' : score >= 50 ? 'high' : score >= 30 ? 'elevated' : 'normal';
    result[mapping.id] = {
      riskLevel,
      riskScore: score,
      incidentCount7d: Number(corridor.incident_count_7d ?? 0),
      eventCount7d: Number(corridor.event_count_7d ?? 0),
      disruptionPct: Number(corridor.disruption_pct ?? 0),
      vesselCount: Number(corridor.vessel_count ?? 0),
      riskSummary: String(corridor.risk_summary || '').slice(0, 200),
      riskReportAction: String((corridor.risk_report?.action) || '').slice(0, 500),
    };
  }

  console.log(`  ${Object.keys(result).length} matching corridors (of ${corridors.length} upstream)`);
  return result;
}

function validate(data) {
  return !!data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length >= 1;
}

export function declareRecords(data) {
  return data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).length : 0;
}

// ─── Notification publishing ─────────────────────────────────────────────────
// Mirrors ais-relay.cjs::publishNotificationEvent (same inline-Upstash-helpers
// pattern already used by scripts/seed-aviation.mjs / seed-weather-alerts.mjs):
// LPUSH the event onto wm:events:queue, guarded by a SETNX dedup key
// (TTL = dedupTtl). On LPUSH failure, roll back the dedup key so the next run
// can retry.

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

async function publishNotificationEvent({ eventType, payload, severity, variant, dedupTtl = 1800 }) {
  try {
    const variantSuffix = variant ? `:${variant}` : '';
    const dedupMaterial = buildDedupMaterial(eventType, payload?.title, payload?.coalesceKey);
    const dedupKey = `wm:notif:scan-dedup:${eventType}${variantSuffix}:${notifyHash(dedupMaterial)}`;
    const dedupResult = await upstashSetNx(dedupKey, '1', dedupTtl);
    const dedupDecision = recordDedupOutcome(dedupResult, {
      surface: 'seed-corridor-risk',
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

// afterPublish hook: fires only after a successful atomicPublish of `data`
// (runSeed awaits it before returning/exiting). Ported verbatim from
// ais-relay.cjs's post-seed corridor-risk notification block — publish a
// notification for every corridor whose risk score is >= 50.
async function dispatchCorridorRiskNotifications(data) {
  for (const [corridorId, c] of Object.entries(data || {})) {
    if (c.riskScore < 50) continue;
    const label = corridorId.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
    await publishNotificationEvent({
      eventType: 'corridor_risk',
      payload: { title: `${label}: risk score ${c.riskScore}${c.riskSummary ? ' — ' + c.riskSummary.slice(0, 80) : ''}`, source: 'Corridor Risk' },
      severity: c.riskScore >= 70 ? 'critical' : 'high',
      variant: undefined,
      dedupTtl: 3600,
    });
  }
}

runSeed('supply_chain', 'corridorrisk', CANONICAL_KEY, fetchCorridorRisk, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'corridor-risk',

  declareRecords,
  schemaVersion: 1,
  // 120min — matches api/health.js's SEED_META.corridorrisk.maxStaleMin (relay
  // loop every 60min; 120 = 2x interval). That entry predates this script.
  maxStaleMin: 120,
  afterPublish: dispatchCorridorRiskNotifications,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
