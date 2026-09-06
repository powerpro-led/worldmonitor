/**
 * @notification-source: domain
 *   The market_alert payload.title is built from structured quote fields
 *   (symbol/name + rounded % move). NOT RSS-origin; never sets
 *   payload.description. Enforced by tests/notification-relay-payload-audit.test.mjs.
 *
 * Shared `market_alert` notification dispatch for the market seed crons.
 *
 * Ported from the three inline `publishNotificationEvent({ eventType:
 * 'market_alert' })` sites in ais-relay.cjs's seedMarketQuotes /
 * seedCommodityQuotes / seedCryptoQuotes when that Market loop was decomposed
 * into standalone crons (P14 Phase 2, session 63 — see PLATFORM_ARCHITECTURE.md).
 * All three did the identical thing — take the day's quotes, keep the ones that
 * moved past a threshold, publish the top 3 by absolute move with a hidden
 * asset-family coalesce key — differing only in the thresholds and the label.
 * That is this module: one publisher, called from each seed's afterPublish.
 *
 * The inline Upstash LPUSH + SETNX-dedup publisher is the same pattern
 * seed-aviation.mjs / seed-weather-alerts.mjs / seed-corridor-risk.mjs /
 * seed-shipping-stress.mjs each carry; kept here once because market_alert has
 * three call sites.
 */

import { getRedisCredentials } from '../_seed-utils.mjs';
import notificationDedup from './notification-dedup.cjs';
import marketAlertCoalesceKeyMod from './market-alert-coalesce-key.cjs';

const { buildDedupMaterial, classifySetNxResult, recordDedupOutcome } = notificationDedup;
const { marketAlertCoalesceKey } = marketAlertCoalesceKeyMod;

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

async function publishNotificationEvent({ eventType, payload, severity, variant, dedupTtl = 1800, surface }) {
  try {
    const variantSuffix = variant ? `:${variant}` : '';
    const dedupMaterial = buildDedupMaterial(eventType, payload?.title, payload?.coalesceKey);
    const dedupKey = `wm:notif:scan-dedup:${eventType}${variantSuffix}:${notifyHash(dedupMaterial)}`;
    const dedupResult = await upstashSetNx(dedupKey, '1', dedupTtl);
    const dedupDecision = recordDedupOutcome(dedupResult, {
      surface,
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

/**
 * @param {object}   opts
 * @param {Array}    opts.quotes            - the day's quote rows ({ symbol, name?, change }).
 * @param {string}   opts.assetClass        - 'equity' | 'commodity' | 'crypto' (goes in the coalesce key).
 * @param {string}   opts.source            - human label for payload.source ('Equity Market', …).
 * @param {string}   opts.surface           - dedup-telemetry surface tag ('seed-market-quotes', …).
 * @param {number}   opts.moveThreshold     - |change%| at or above which a row is "moving".
 * @param {number}   opts.criticalThreshold - |change%| at or above which severity is 'critical' (else 'high').
 * @param {(q) => string} [opts.titleSubject] - how to name the instrument in the title (default: symbol).
 *
 * Verbatim behavior from ais-relay.cjs: filter by |change| >= moveThreshold,
 * sort by |change| desc, publish the top 3, dedupTtl 3600.
 */
export async function dispatchMarketAlerts({ quotes, assetClass, source, surface, moveThreshold, criticalThreshold, titleSubject }) {
  const rows = Array.isArray(quotes) ? quotes : [];
  const subject = titleSubject || ((q) => q.symbol);
  const moving = rows
    .filter((q) => Math.abs(q.change ?? 0) >= moveThreshold)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  for (const q of moving.slice(0, 3)) {
    const pct = Math.round(q.change);
    const dir = q.change < 0 ? 'decline' : 'surge';
    const severity = Math.abs(q.change) >= criticalThreshold ? 'critical' : 'high';
    await publishNotificationEvent({
      eventType: 'market_alert',
      payload: {
        title: `${subject(q)}: ${pct > 0 ? '+' : ''}${pct}% ${dir}`,
        source,
        coalesceKey: marketAlertCoalesceKey(assetClass, q.symbol || q.name, dir, severity),
      },
      severity,
      variant: undefined,
      dedupTtl: 3600,
      surface,
    });
  }
}
