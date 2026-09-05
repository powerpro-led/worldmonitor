#!/usr/bin/env node

/**
 * @notification-source: domain
 *   publishNotificationEvent() calls in this file build payload.title from
 *   the structured stress score/level. Events are NOT RSS-origin and MUST NOT
 *   set payload.description. Enforced by
 *   tests/notification-relay-payload-audit.test.mjs.
 *
 * Shipping Stress Index seed — Yahoo Finance carrier/ETF market data. Averages
 * the day's % change across a small basket of dry-bulk / container carriers,
 * turns it into a 0-100 stress score (neutral market → 40), and stores the
 * result under supply_chain:shipping_stress:v1 for the GetShippingStress RPC.
 *
 * Ported verbatim (carrier basket, score formula, level thresholds, and the
 * >=75 notification threshold) from the startShippingStressSeedLoop() that
 * used to live inside scripts/ais-relay.cjs — P14 Phase 2 loop-extraction pass
 * (see PLATFORM_ARCHITECTURE.md session 63). Deviations from the relay loop:
 *   1. Yahoo fetching goes through the shared scripts/_yahoo-fetch.mjs
 *      (direct → curl-proxy fallback + retry/backoff), not the relay's
 *      ais-relay-local fetchYahooChartDirect. Same endpoint
 *      (query1.finance.yahoo.com/v8/finance/chart/<sym>, no range params),
 *      same parse (parseYahooChart) — this is exactly what
 *      scripts/seed-market-quotes.mjs already does.
 *   2. The relay kept a 20-min setTimeout retry on an empty fetch. A one-shot
 *      cron has no such timer — runSeed's RETRY-on-empty path preserves
 *      last-good + extends the key TTL, and the next scheduled 15-min tick is
 *      the retry.
 *   3. One-shot invocation, so the notification's only dedup guard is the
 *      Redis SETNX inside publishNotificationEvent (title hash, TTL-bounded) —
 *      as it already was for every other call site of the relay's publisher.
 */

import { loadEnvFile, runSeed, sleep, parseYahooChart, getRedisCredentials } from './_seed-utils.mjs';
import { fetchYahooJson } from './_yahoo-fetch.mjs';
import notificationDedup from './shared/notification-dedup.cjs';

const { buildDedupMaterial, classifySetNxResult, recordDedupOutcome } = notificationDedup;

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'supply_chain:shipping_stress:v1';
// 1h — 4x the 15-min cron cadence, and STRICTLY above the 45-min (2700s)
// health staleness gate (tests/seed-ttl-outlives-staleness-fleet.test.mjs) so
// a merely-late seeder escalates STALE_SEED→EMPTY in order. Matches the relay
// loop's SHIPPING_STRESS_TTL exactly (3600 > 2700, already safe — no ratchet
// bump needed).
const CACHE_TTL = 3600;

const SHIPPING_CARRIERS = [
  { symbol: 'BDRY', name: 'Breakwave Dry Bulk ETF',  carrierType: 'etf' },
  { symbol: 'ZIM',  name: 'ZIM Integrated Shipping', carrierType: 'carrier' },
  { symbol: 'MATX', name: 'Matson Inc',              carrierType: 'carrier' },
  { symbol: 'SBLK', name: 'Star Bulk Carriers',      carrierType: 'carrier' },
  { symbol: 'EGLE', name: 'Eagle Bulk Shipping',     carrierType: 'carrier' },
];

async function fetchYahooQuote(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const chart = await fetchYahooJson(url, { label: symbol });
    return parseYahooChart(chart, symbol);
  } catch (err) {
    console.warn(`  [Yahoo] ${symbol} error: ${err.message}`);
    return null;
  }
}

async function fetchShippingStress() {
  const results = [];
  for (const carrier of SHIPPING_CARRIERS) {
    await sleep(150);
    const quote = await fetchYahooQuote(carrier.symbol);
    if (!quote) continue;
    results.push({
      symbol: carrier.symbol,
      name: carrier.name,
      carrierType: carrier.carrierType,
      price: quote.price,
      changePct: Number(quote.change.toFixed(2)),
      sparkline: quote.sparkline,
    });
  }
  if (!results.length) {
    // declareRecords → 0 → runSeed RETRY: last-good preserved, TTL extended,
    // next 15-min tick retries. Mirrors the relay loop's "no carrier data —
    // extending TTL, retrying" branch.
    return { carriers: [], stressScore: 0, stressLevel: 'low', fetchedAt: Date.now() };
  }
  const avgChange = results.reduce((a, b) => a + b.changePct, 0) / results.length;
  // Neutral market (0% change) → score=40 (moderate). Positive change = lower stress.
  const stressScore = Math.min(100, Math.max(0, Math.round(40 - avgChange * 3)));
  const stressLevel = stressScore >= 75 ? 'critical' : stressScore >= 50 ? 'elevated' : stressScore >= 25 ? 'moderate' : 'low';
  console.log(`  ${results.length} carriers score=${stressScore}/${stressLevel} avgChange=${avgChange.toFixed(2)}%`);
  return { carriers: results, stressScore, stressLevel, fetchedAt: Date.now() };
}

function validate(data) {
  return !!data && Array.isArray(data.carriers) && data.carriers.length >= 1 && typeof data.stressScore === 'number';
}

export function declareRecords(data) {
  return Array.isArray(data?.carriers) ? data.carriers.length : 0;
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
      surface: 'seed-shipping-stress',
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
// ais-relay.cjs's post-seed shipping-stress notification block — publish only
// when the score crosses the critical band (>= 75).
async function dispatchShippingStressNotifications(data) {
  const { stressScore, stressLevel } = data || {};
  if (typeof stressScore !== 'number' || stressScore < 75) return;
  await publishNotificationEvent({
    eventType: 'shipping_stress',
    payload: { title: `Global shipping stress: score ${stressScore}/100 (${stressLevel})`, source: 'Shipping Index' },
    severity: stressScore >= 90 ? 'critical' : 'high',
    variant: undefined,
    dedupTtl: 7200,
  });
}

runSeed('supply_chain', 'shipping_stress', CANONICAL_KEY, fetchShippingStress, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'shipping-stress',

  declareRecords,
  schemaVersion: 1,
  // 45min — matches api/health.js's SEED_META.shippingStress.maxStaleMin (relay
  // loop every 15min; 45 = 3x interval). That entry predates this script.
  maxStaleMin: 45,
  afterPublish: dispatchShippingStressNotifications,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
