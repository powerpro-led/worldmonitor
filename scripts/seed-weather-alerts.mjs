#!/usr/bin/env node

/**
 * @notification-source: domain
 *   publishNotificationEvent() calls in this file build payload.title from
 *   structured NWS alert fields (headline/event). Events are NOT RSS-origin
 *   and MUST NOT set payload.description. Enforced by
 *   tests/notification-relay-payload-audit.test.mjs.
 *
 * Notification-publishing ported from the startWeatherSeedLoop() that used to
 * live inside scripts/ais-relay.cjs (stripped as part of the P14 loop-deletion
 * pass — see PLATFORM_ARCHITECTURE.md session 61/62). Unlike ais-relay's
 * long-lived process, this is a one-shot cron invocation, so there is no
 * in-process Set to dedupe repeated alerts across ticks — the Redis-backed
 * SETNX dedup inside publishNotificationEvent (keyed by coalesceKey/title
 * hash, TTL-bounded) is the only guard, exactly as it already was for every
 * OTHER call site of ais-relay's publishNotificationEvent.
 */

import { loadEnvFile, CHROME_UA, runSeed, getRedisCredentials } from './_seed-utils.mjs';
import notificationDedup from './shared/notification-dedup.cjs';

const { buildDedupMaterial, classifySetNxResult, recordDedupOutcome } = notificationDedup;

loadEnvFile(import.meta.url);

const NWS_API = 'https://api.weather.gov/alerts/active';
const CANONICAL_KEY = 'weather:alerts:v1';
const CACHE_TTL = 900; // 15 min

function extractCoordinates(geometry) {
  if (!geometry) return [];
  try {
    if (geometry.type === 'Polygon') {
      return geometry.coordinates[0]?.map(c => [c[0], c[1]]) || [];
    }
    if (geometry.type === 'MultiPolygon') {
      return geometry.coordinates[0]?.[0]?.map(c => [c[0], c[1]]) || [];
    }
  } catch { /* ignore */ }
  return [];
}

function calculateCentroid(coords) {
  if (coords.length === 0) return undefined;
  const sum = coords.reduce((acc, [lon, lat]) => [acc[0] + lon, acc[1] + lat], [0, 0]);
  return [sum[0] / coords.length, sum[1] / coords.length];
}

async function fetchAlerts() {
  const resp = await fetch(NWS_API, {
    headers: { Accept: 'application/geo+json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`NWS API error: ${resp.status}`);

  const data = await resp.json();
  const features = data.features || [];

  const alerts = features
    .filter(f => f?.properties?.severity !== 'Unknown')
    .slice(0, 50)
    .map(f => {
      const p = f.properties;
      const coords = extractCoordinates(f.geometry);
      // NWS VTEC string. NWS wraps VTEC in an array under
      // properties.parameters.VTEC; pick the first entry (most alerts have
      // one; multi-VTEC alerts use the primary). Used by
      // dispatchWeatherNotifications() below to derive a coalesce family key
      // so adjacent-zone alerts for the same logical event collapse at the
      // publisher and at the per-user dedup, instead of flooding one
      // notification per affected county.
      const vtec = Array.isArray(p?.parameters?.VTEC) ? p.parameters.VTEC[0] : undefined;
      return {
        id: f.id || '',
        event: p.event || '',
        severity: p.severity || 'Unknown',
        headline: p.headline || '',
        description: (p.description || '').slice(0, 500),
        areaDesc: p.areaDesc || '',
        onset: p.onset || '',
        expires: p.expires || '',
        coordinates: coords,
        centroid: calculateCentroid(coords),
        vtec,
      };
    });

  return { alerts };
}

function validate(data) {
  return Array.isArray(data?.alerts) && data.alerts.length >= 1;
}

export function declareRecords(data) {
  return Array.isArray(data?.alerts) ? data.alerts.length : 0;
}

// ─── Notification publishing ─────────────────────────────────────────────────
// Mirrors ais-relay.cjs::publishNotificationEvent (same inline-Upstash-helpers
// pattern already used by scripts/seed-aviation.mjs): LPUSH the event onto
// wm:events:queue, guarded by a SETNX dedup key (TTL = dedupTtl). On LPUSH
// failure, rollback the dedup key so the next tick can retry.

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
      surface: 'seed-weather-alerts',
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
 * Slot B helper: derive a coalesce-family key from an NWS VTEC string.
 * Ported verbatim from ais-relay.cjs::deriveWeatherCoalesceKey — see that
 * function's header comment for the full VTEC-format breakdown.
 *
 * NWS VTEC format (https://www.weather.gov/vtec/):
 *   /O.NEW.KSGF.SV.W.0034.250427T1257Z-250427T1330Z/
 * The (office, phenomenon, significance, eventID) tuple identifies one
 * logical event across adjacent zones; the action (NEW/CON/CAN/...) is
 * dropped so bulletins for the same event also collapse.
 */
function deriveWeatherCoalesceKey(vtec) {
  if (typeof vtec !== 'string') return undefined;
  const m = vtec.match(/\/[OTEX]\.[A-Z]+\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\./);
  if (!m) return undefined;
  return `nws:${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
}

// afterPublish hook: fires only after a successful atomicPublish of `data`
// (runSeed awaits it before returning/exiting). Ported from ais-relay.cjs's
// post-seed notification block.
async function dispatchWeatherNotifications(data) {
  const alerts = Array.isArray(data?.alerts) ? data.alerts : [];
  const highSeverityAlerts = alerts.filter((a) => a.severity === 'Extreme' || a.severity === 'Severe');
  // Pick up to 3 DISTINCT event families before publishing. The naive
  // `slice(0, 3)` would silently lose distinct families: if the first 3 raw
  // alerts are adjacent-zone duplicates for one VTEC family (one storm
  // crossing 3 counties), the publisher-side dedup collapses them to 1
  // notification and a 4th genuinely-distinct family (tornado / flood /
  // different storm) sitting at index 3+ would NEVER be considered.
  // Dedupe by coalesceKey FIRST, then take the top 3 distinct families.
  const seenFamilyKeys = new Set();
  const distinctFamilyAlerts = [];
  for (const a of highSeverityAlerts) {
    const familyKey = deriveWeatherCoalesceKey(a.vtec) ?? `nws:fallback:${a.id || a.headline || a.event || ''}`;
    if (seenFamilyKeys.has(familyKey)) continue;
    seenFamilyKeys.add(familyKey);
    distinctFamilyAlerts.push(a);
    if (distinctFamilyAlerts.length >= 3) break;
  }
  for (const a of distinctFamilyAlerts) {
    const coalesceKey = deriveWeatherCoalesceKey(a.vtec);
    await publishNotificationEvent({
      eventType: 'weather_alert',
      payload: {
        title: a.headline || a.event || 'Weather alert',
        source: 'NWS',
        countryCode: 'US',
        ...(coalesceKey ? { coalesceKey } : {}),
      },
      severity: a.severity === 'Extreme' ? 'critical' : 'high',
      variant: undefined,
    });
  }
}

runSeed('weather', 'alerts', CANONICAL_KEY, fetchAlerts, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'nws-active',

  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 45,
  afterPublish: dispatchWeatherNotifications,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
