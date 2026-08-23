#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { loadEnvFile, runSeed, sleep } from './_seed-utils.mjs';
import { CLIMATE_ZONES, MIN_CLIMATE_ZONE_COUNT, hasRequiredClimateZones } from './_climate-zones.mjs';
import { chunkItems, fetchOpenMeteoArchiveBatch } from './_open-meteo-archive.mjs';

loadEnvFile(import.meta.url);

export const CLIMATE_ZONE_NORMALS_KEY = 'climate:zone-normals:v1';
// Keep the previous baseline available across monthly cron gaps; health.js enforces freshness separately.
const NORMALS_TTL = 95 * 24 * 60 * 60; // 95 days = >3x a 31-day monthly interval
const NORMALS_START = '1991-01-01';
const NORMALS_END = '2020-12-31';
const NORMALS_BATCH_SIZE = 2;
const NORMALS_BATCH_DELAY_MS = 3_000;

function round(value, decimals = 2) {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function computeMonthlyNormals(daily) {
  const dailyBucketByYearMonth = new Map();
  for (let month = 1; month <= 12; month++) {
    dailyBucketByYearMonth.set(month, new Map());
  }

  const times = daily?.time ?? [];
  const temps = daily?.temperature_2m_mean ?? [];
  const precips = daily?.precipitation_sum ?? [];

  for (let i = 0; i < times.length; i++) {
    const time = times[i];
    const temp = temps[i];
    const precip = precips[i];
    if (typeof time !== 'string' || temp == null || precip == null) continue;
    const year = Number(time.slice(0, 4));
    const month = Number(time.slice(5, 7));
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) continue;
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const bucket = dailyBucketByYearMonth.get(month);
    const existing = bucket.get(key);
    if (existing) {
      existing.temps.push(Number(temp));
      existing.precips.push(Number(precip));
      continue;
    }
    bucket.set(key, {
      temps: [Number(temp)],
      precips: [Number(precip)],
    });
  }

  return Array.from(dailyBucketByYearMonth.entries())
    .map(([month, bucket]) => {
      const monthlyMeans = Array.from(bucket.values())
        .map((entry) => ({
          tempMean: average(entry.temps),
          precipMean: average(entry.precips),
        }))
        .filter((entry) => Number.isFinite(entry.tempMean) && Number.isFinite(entry.precipMean));

      if (monthlyMeans.length === 0) return null;

      return {
        month,
        tempMean: round(average(monthlyMeans.map((entry) => entry.tempMean))),
        precipMean: round(average(monthlyMeans.map((entry) => entry.precipMean))),
      };
    })
    .filter((entry) => entry != null && Number.isFinite(entry.tempMean) && Number.isFinite(entry.precipMean));
}

export function buildZoneNormalsFromBatch(zones, batchPayloads) {
  return zones.flatMap((zone, index) => {
    const data = batchPayloads[index];
    const months = computeMonthlyNormals(data?.daily);
    if (months.length !== 12) {
      console.warn(`  [CLIMATE_NORMALS] Open-Meteo normals incomplete for ${zone.name}: expected 12 months, got ${months.length}`);
      return [];
    }

    return [{
      zone: zone.name,
      location: { latitude: zone.lat, longitude: zone.lon },
      months,
    }];
  });
}

// Extra whole-function passes to reclaim only the zones still missing after
// the first sweep. Added 2026-08-23 alongside the maxRetries trim above: with
// Open-Meteo 429-ing this heavily, SOME batch fails on almost every full
// sweep (different one each time — not a fixed bad zone), so a clean
// all-13-batches pass essentially never happens by chance. Before this,
// runSeed's own outer `withRetry(fetchFn)` was the only retry mechanism, and
// it re-invokes this whole function from scratch on failure — throwing away
// every already-succeeded batch and re-fetching all 25 zones again each
// time, which is why a live run burned the entire 540s budget across 4 full
// passes without ever landing one clean sweep. Retrying only the zones still
// missing converges much faster: each pass only needs the STRAGGLERS to
// clear, not all 13 batches simultaneously.
// Bumped 2 -> 4 same day (2026-08-23): a live run with 2 passes made real
// progress (25 -> 14 -> 12 zones still missing, unlike the pre-fix version
// which never converged at all) but ran out of internal passes at 13/25 —
// short of MIN_CLIMATE_ZONE_COUNT (17) — and fell through to runSeed's own
// outer `withRetry(fetchFn)`, which throws away all 13 accumulated zones and
// restarts from all 25 again. More internal passes over a SHRINKING set
// converges faster than that outer full-restart ever can.
const NORMALS_MISSING_ZONE_RETRY_PASSES = 4;

async function fetchZoneNormalsBatches(zones, normals, failedZoneNames) {
  for (const batch of chunkItems(zones, NORMALS_BATCH_SIZE)) {
    try {
      const payloads = await fetchOpenMeteoArchiveBatch(batch, {
        startDate: NORMALS_START,
        endDate: NORMALS_END,
        daily: ['temperature_2m_mean', 'precipitation_sum'],
        timeoutMs: 30_000,
        // Trimmed from 4 (2026-08-23): live run showed EVERY batch 429'ing on
        // every direct attempt (5+10+20+40s backoff, all exhausted, all 13
        // batches run serially) — the fetch-phase deadline was hit after only
        // 4/13 batches, all spent on futile same-IP direct retries that never
        // reached fetchOpenMeteoArchiveBatch's own proxy fallback (a different
        // Decodo egress IP, not yet rate-limited). Same root cause and same fix
        // as the GDELT rate-gate work: an exhausted per-IP 429 rarely clears
        // within a few more direct retries, so burning the budget on them
        // starves the leg that actually has a chance. One retry (5s) still
        // absorbs a genuinely transient blip; the proxy fallback gets to run
        // for nearly every batch instead of ~1 of 13.
        maxRetries: 1,
        retryBaseMs: 5_000,
        label: `normals batch (${batch.map((zone) => zone.name).join(', ')})`,
      });
      const batchNormals = buildZoneNormalsFromBatch(batch, payloads);
      normals.push(...batchNormals);
      const succeededNames = new Set(batchNormals.map((zone) => zone.zone));
      for (const zone of batch) {
        if (!succeededNames.has(zone.name)) failedZoneNames.add(zone.name);
      }
    } catch (err) {
      console.log(`  [CLIMATE_NORMALS] ${err?.message ?? err}`);
      for (const zone of batch) failedZoneNames.add(zone.name);
    }
    await sleep(NORMALS_BATCH_DELAY_MS);
  }
}

export async function fetchClimateZoneNormals() {
  const normals = [];
  let failedZoneNames = new Set();

  await fetchZoneNormalsBatches(CLIMATE_ZONES, normals, failedZoneNames);

  for (let pass = 1; pass <= NORMALS_MISSING_ZONE_RETRY_PASSES && failedZoneNames.size > 0; pass++) {
    const succeededNames = new Set(normals.map((zone) => zone.zone));
    const stillMissing = CLIMATE_ZONES.filter((zone) => failedZoneNames.has(zone.name) && !succeededNames.has(zone.name));
    if (stillMissing.length === 0) break;
    console.log(`  [CLIMATE_NORMALS] retry pass ${pass}/${NORMALS_MISSING_ZONE_RETRY_PASSES}: ${stillMissing.length} zone(s) still missing`);
    failedZoneNames = new Set();
    await fetchZoneNormalsBatches(stillMissing, normals, failedZoneNames);
  }

  const failures = CLIMATE_ZONES.length - normals.length;
  if (normals.length < MIN_CLIMATE_ZONE_COUNT) {
    throw new Error(`Only ${normals.length}/${CLIMATE_ZONES.length} zones returned normals (${failures} errors)`);
  }
  if (!hasRequiredClimateZones(normals, (zone) => zone.zone)) {
    throw new Error('Missing one or more required climate-specific zone normals');
  }

  return {
    referencePeriod: '1991-2020',
    fetchedAt: Date.now(),
    normals,
  };
}

function validate(data) {
  return Array.isArray(data?.normals)
    && data.normals.length >= MIN_CLIMATE_ZONE_COUNT
    && hasRequiredClimateZones(data.normals, (zone) => zone.zone)
    && data.normals.every((zone) => Array.isArray(zone?.months) && zone.months.length === 12);
}

// Contract opt-in: records = number of climate zones with 1991-2020 normals.
// Custom shape `{referencePeriod, fetchedAt, normals[]}` — computeRecordCount
// auto-detect historically missed this, causing the phantom EMPTY_DATA symptom
// documented in the plan's discrepancy class 1.
export function declareRecords(data) {
  return Array.isArray(data?.normals) ? data.normals.length : 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runSeed('climate', 'zone-normals', CLIMATE_ZONE_NORMALS_KEY, fetchClimateZoneNormals, {
    validateFn: validate,
    ttlSeconds: NORMALS_TTL,
    sourceVersion: 'open-meteo-wmo-1991-2020-v1',
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 89280, // matches api/health.js SEED_META (monthly cron on 1st; 62d window)
    // runSeed's own default fetch-phase deadline (lockTtlMs 120s + margin 120s
    // = 240s) was silently truncating this well short of the 600s
    // seed-bundle-climate.mjs already allocates before its own SIGTERM — 13
    // zone-pair batches run serially, each with a real 429-retry + proxy-
    // fallback cost, now compounded by up to 4 missing-zone retry passes on a
    // severe-429-rate day. Set explicitly to leave a 30s SIGTERM margin under
    // the bundle's real ceiling (tightened from 60s alongside the pass bump
    // above) instead of the unrelated 240s default.
    fetchPhaseTimeoutMs: 570_000,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
