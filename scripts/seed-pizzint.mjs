#!/usr/bin/env node

/**
 * PizzINT seed — Pentagon Pizza Index + GDELT tension pairs from
 * pizzint.watch (no API key required; the datacenter-IP block that made this
 * relay-only on Vercel Edge does not apply to a Railway/Cloud Run cron).
 * Computes the DEFCON-style activity rollup and stores it under
 * intelligence:pizzint:seed:v1 so the existing GetPizzint RPC serves it
 * without changes.
 *
 * Ported verbatim (location mapping, DEFCON thresholds, GDELT tension-pair
 * shaping) from the startPizzintSeedLoop() that used to live inside
 * scripts/ais-relay.cjs — P14 Phase 2 loop-extraction pass (see
 * PLATFORM_ARCHITECTURE.md). The GDELT batch fetch stays non-fatal. No
 * @notification-source tag — this loop never called publishNotificationEvent.
 */

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:pizzint:seed:v1';
const CACHE_TTL = 1800; // 30 min — 3x the 10-min cron interval
const PIZZINT_API = 'https://www.pizzint.watch/api/dashboard-data';
const GDELT_BATCH_API = 'https://www.pizzint.watch/api/gdelt/batch';
const DEFAULT_GDELT_PAIRS = 'usa_russia,russia_ukraine,usa_china,china_taiwan,usa_iran,usa_venezuela';

async function fetchPizzint() {
  const resp = await fetch(PIZZINT_API, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const raw = await resp.json();
  if (!raw.success || !Array.isArray(raw.data)) throw new Error('No data in API response');

  const locations = raw.data.map((d) => ({
    placeId: d.place_id || '',
    name: d.name || '',
    address: d.address || '',
    currentPopularity: typeof d.current_popularity === 'number' ? d.current_popularity : 0,
    percentageOfUsual: typeof d.percentage_of_usual === 'number' ? d.percentage_of_usual : 0,
    isSpike: !!d.is_spike,
    spikeMagnitude: typeof d.spike_magnitude === 'number' ? d.spike_magnitude : 0,
    dataSource: d.data_source || '',
    recordedAt: d.recorded_at || '',
    dataFreshness: d.data_freshness === 'fresh' ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE',
    isClosedNow: !!d.is_closed_now,
    lat: d.lat ?? 0,
    lng: d.lng ?? 0,
  }));

  const openLocations = locations.filter((l) => !l.isClosedNow);
  const activeSpikes = locations.filter((l) => l.isSpike).length;
  const avgPop = openLocations.length > 0
    ? openLocations.reduce((s, l) => s + l.currentPopularity, 0) / openLocations.length
    : 0;

  let adjusted = avgPop;
  if (activeSpikes > 0) adjusted += activeSpikes * 10;
  adjusted = Math.min(100, adjusted);
  let defconLevel = 5;
  let defconLabel = 'Normal Activity';
  if (adjusted >= 85) { defconLevel = 1; defconLabel = 'Maximum Activity'; }
  else if (adjusted >= 70) { defconLevel = 2; defconLabel = 'High Activity'; }
  else if (adjusted >= 50) { defconLevel = 3; defconLabel = 'Elevated Activity'; }
  else if (adjusted >= 25) { defconLevel = 4; defconLabel = 'Above Normal'; }

  const hasFresh = locations.some((l) => l.dataFreshness === 'DATA_FRESHNESS_FRESH');

  const pizzint = {
    defconLevel,
    defconLabel,
    aggregateActivity: Math.round(avgPop),
    activeSpikes,
    locationsMonitored: locations.length,
    locationsOpen: openLocations.length,
    updatedAt: Date.now(),
    dataFreshness: hasFresh ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE',
    locations,
  };

  // GDELT tensions — non-fatal if unavailable.
  let tensionPairs = [];
  try {
    const gdeltUrl = `${GDELT_BATCH_API}?pairs=${encodeURIComponent(DEFAULT_GDELT_PAIRS)}&method=gpr`;
    const gdeltResp = await fetch(gdeltUrl, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (gdeltResp.ok) {
      const gdeltRaw = await gdeltResp.json();
      tensionPairs = Object.entries(gdeltRaw).map(([pairKey, dataPoints]) => {
        const countries = pairKey.split('_');
        const latest = dataPoints[dataPoints.length - 1];
        const prev = dataPoints.length > 1 ? dataPoints[dataPoints.length - 2] : latest;
        const change = prev && prev.v > 0 ? ((latest.v - prev.v) / prev.v) * 100 : 0;
        const trend = change > 5 ? 'TREND_DIRECTION_RISING' : change < -5 ? 'TREND_DIRECTION_FALLING' : 'TREND_DIRECTION_STABLE';
        return {
          id: pairKey,
          countries,
          label: countries.map((c) => c.toUpperCase()).join(' - '),
          score: latest?.v ?? 0,
          trend,
          changePercent: Math.round(change * 10) / 10,
          region: 'global',
        };
      });
    }
  } catch { /* GDELT unavailable — non-fatal */ }

  console.log(`  ${locations.length} locations (open:${openLocations.length} spikes:${activeSpikes} defcon:${defconLevel} gdelt:${tensionPairs.length})`);
  return { pizzint, tensionPairs };
}

function validate(data) {
  return !!data && typeof data.pizzint === 'object' && Array.isArray(data.pizzint.locations);
}

export function declareRecords(data) {
  return Array.isArray(data?.pizzint?.locations) ? data.pizzint.locations.length : 0;
}

runSeed('intelligence', 'pizzint', CANONICAL_KEY, fetchPizzint, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'pizzint',
  // The relay loop published unconditionally, including a zero-location
  // response; keep that — a well-formed empty payload is still a valid write.
  zeroIsValid: true,

  declareRecords,
  schemaVersion: 1,
  // 30min — matches api/health.js's SEED_META.pizzint.maxStaleMin (relay loop
  // every 10min; 30 = 3x interval). That entry predates this script.
  maxStaleMin: 30,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
