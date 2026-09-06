#!/usr/bin/env node

/**
 * Pre-assembled chokepoint Transit Summaries.
 *
 * Split out of scripts/ais-relay.cjs (P14 Phase 2 tail — WS-core + Telegram
 * extraction). This SUPERSEDES decision P16's "TransitSummary stays
 * relay-local forever": P16 was taken when ais-relay.cjs ran once *per org*,
 * so co-locating the merge with the in-process AIS `chokepointCrossings` Map
 * was free. The platform model makes the relay ONE shared deploy, and this
 * merge's other two inputs — `supply_chain:portwatch:v1` and
 * `supply_chain:corridorrisk:v1` — are written by *per-org* seeders into the
 * *org's* Upstash. Running it in the shared service would read a store with
 * no per-org portwatch/corridor-risk data. So:
 *   - the shared service still publishes `supply_chain:chokepoint_transits:v1`
 *     (pure AIS crossing counts — seedChokepointTransits, still relay-local)
 *   - a per-org sync job bridges that key into each org's Upstash
 *     (scripts/sync-ais-results.mjs)
 *   - THIS per-org cron does the merge: bridged AIS counts + the org's own
 *     portwatch + corridor-risk → `supply_chain:transit-summaries:v1`
 *     (+ per-id history keys + seed-meta).
 *
 * Hand-rolled (not runSeed): writes one compact canonical key PLUS 13 per-id
 * history keys PLUS a bespoke seed-meta whose recordCount is portwatch
 * coverage (not the always-13 canonical shape), and skips the whole publish
 * when portwatch is absent. Same hand-rolled shape as
 * scripts/seed-social-velocity.mjs / seed-classify.mjs.
 *
 * No @notification-source tag — this loop never published notification events.
 */

import {
  acquireLockSafely,
  atomicPublish,
  loadEnvFile,
  logSeedResult,
  readCanonicalValue,
  releaseLock,
  writeExtraKey,
  writeSeedMeta,
} from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CHOKEPOINT_TRANSIT_KEY = 'supply_chain:chokepoint_transits:v1';
const PORTWATCH_REDIS_KEY = 'supply_chain:portwatch:v1';
const CORRIDOR_RISK_REDIS_KEY = 'supply_chain:corridorrisk:v1';
const TRANSIT_SUMMARY_REDIS_KEY = 'supply_chain:transit-summaries:v1';
const TRANSIT_SUMMARY_HISTORY_KEY_PREFIX = 'supply_chain:transit-summaries:history:v1:';
const TRANSIT_SUMMARY_META_KEY = 'seed-meta:supply_chain:transit-summaries';
// 1h — STRICTLY > api/health.js's SEED_META.transitSummaries.maxStaleMin (30 →
// 1800s), so a merely-late cron escalates STALE_SEED → EMPTY in order
// (tests/seed-ttl-outlives-staleness-fleet.test.mjs). Verbatim from the relay
// loop's TRANSIT_SUMMARY_TTL — 3600 already clears the gate, no ratchet bump.
const TRANSIT_SUMMARY_TTL = 3600;
const META_TTL = 604_800; // 7 days

const LOCK_DOMAIN = 'supply_chain:transit-summaries';
const LOCK_TTL_MS = 5 * 60 * 1000;

// Threat levels for anomaly detection. MUST stay in sync with
// CHOKEPOINTS[].threatLevel in
// server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts. Only war_zone
// and critical trigger anomaly signals. Verbatim from ais-relay.cjs.
const CHOKEPOINT_THREAT_LEVELS = {
  suez: 'high', malacca_strait: 'normal', hormuz_strait: 'war_zone',
  bab_el_mandeb: 'critical', panama: 'normal', taiwan_strait: 'elevated',
  cape_of_good_hope: 'normal', gibraltar: 'normal', bosphorus: 'elevated',
  korea_strait: 'normal', dover_strait: 'normal', kerch_strait: 'war_zone',
  lombok_strait: 'normal',
};

// AIS geofence name -> canonical chokepoint ID. Verbatim from ais-relay.cjs.
// The keys match `supply_chain:chokepoint_transits:v1`'s `transits` map keys
// (which seedChokepointTransits builds from CHOKEPOINTS[].name).
const RELAY_NAME_TO_ID = {
  'Suez Canal': 'suez', 'Malacca Strait': 'malacca_strait',
  'Strait of Hormuz': 'hormuz_strait', 'Bab el-Mandeb Strait': 'bab_el_mandeb',
  'Panama Canal': 'panama', 'Taiwan Strait': 'taiwan_strait',
  'Cape of Good Hope': 'cape_of_good_hope', 'Gibraltar Strait': 'gibraltar',
  'Bosporus Strait': 'bosphorus', 'Korea Strait': 'korea_strait',
  'Dover Strait': 'dover_strait', 'Kerch Strait': 'kerch_strait',
  'Lombok Strait': 'lombok_strait',
  'South China Sea': null, 'Black Sea': null, // area geofences, not chokepoints
};

const ID_TO_RELAY_NAME = Object.fromEntries(
  Object.entries(RELAY_NAME_TO_ID).filter(([, id]) => id != null).map(([name, id]) => [id, name]),
);

// Duplicated from server/worldmonitor/supply-chain/v1/_scoring.mjs (verbatim
// from ais-relay.cjs's detectTrafficAnomalyRelay). Keep in sync.
export function detectTrafficAnomaly(history, threatLevel) {
  if (!history || history.length < 37) return { dropPct: 0, signal: false };
  const sorted = [...history].sort((a, b) => b.date.localeCompare(a.date));
  let recent7 = 0;
  let baseline30 = 0;
  for (let i = 0; i < 7 && i < sorted.length; i++) recent7 += sorted[i].total;
  for (let i = 7; i < 37 && i < sorted.length; i++) baseline30 += sorted[i].total;
  const baselineAvg7 = (baseline30 / Math.min(30, sorted.length - 7)) * 7;
  if (baselineAvg7 < 14) return { dropPct: 0, signal: false };
  const dropPct = Math.round(((baselineAvg7 - recent7) / baselineAvg7) * 100);
  const isHighThreat = threatLevel === 'war_zone' || threatLevel === 'critical';
  return { dropPct, signal: dropPct >= 50 && isHighThreat };
}

/**
 * Build one compact summary row for a canonical chokepoint id. Pure — the
 * merge logic ported verbatim from ais-relay.cjs's seedTransitSummaries loop.
 *
 * @param {string} cpId  canonical chokepoint id (a key of CHOKEPOINT_THREAT_LEVELS)
 * @param {object|undefined} pwEntry  this chokepoint's `supply_chain:portwatch:v1` entry
 * @param {object|null} transitCounts  {tanker,cargo,other,total} from the bridged AIS key, or null
 * @param {object|undefined} risk  this chokepoint's `supply_chain:corridorrisk:v1` entry
 */
export function buildSummaryRow(cpId, pwEntry, transitCounts, risk) {
  const threatLevel = CHOKEPOINT_THREAT_LEVELS[cpId] || 'normal';
  const history = pwEntry?.history ?? [];
  const anomaly = detectTrafficAnomaly(history, threatLevel);
  const t = transitCounts && transitCounts.total > 0 ? transitCounts : null;
  return {
    todayTotal: t?.total ?? 0,
    todayTanker: t?.tanker ?? 0,
    todayCargo: t?.cargo ?? 0,
    todayOther: t?.other ?? 0,
    wowChangePct: pwEntry?.wowChangePct ?? 0,
    riskLevel: risk?.riskLevel ?? '',
    incidentCount7d: risk?.incidentCount7d ?? 0,
    disruptionPct: risk?.disruptionPct ?? 0,
    riskSummary: risk?.riskSummary ?? '',
    riskReportAction: risk?.riskReportAction ?? '',
    anomaly,
    // Distinguishes genuine zero-traffic (pwEntry present, 0 crossings) from
    // zero-state fill (upstream missing this cycle).
    dataAvailable: Boolean(pwEntry),
  };
}

export { CHOKEPOINT_THREAT_LEVELS, RELAY_NAME_TO_ID, ID_TO_RELAY_NAME };

export async function main() {
  const startedAt = Date.now();
  const runId = `transit-summaries:${startedAt}`;
  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });
  if (lock.skipped) return;
  if (!lock.locked) {
    console.log('[TransitSummary] Lock held, skipping');
    return;
  }

  try {
    const pw = await readCanonicalValue(PORTWATCH_REDIS_KEY);
    if (!pw || typeof pw !== 'object' || Array.isArray(pw) || Object.keys(pw).length === 0) {
      // No portwatch → the summary would be all zero-state. Skip entirely (as
      // the relay loop did) so the last good key ages out via its own TTL
      // rather than being overwritten with empties.
      console.warn(`[TransitSummary] Skipped — ${PORTWATCH_REDIS_KEY} empty or absent (upstream seeder has not written it yet)`);
      return;
    }

    const [transitsDoc, corridorRisk] = await Promise.all([
      readCanonicalValue(CHOKEPOINT_TRANSIT_KEY).catch(() => null),
      readCanonicalValue(CORRIDOR_RISK_REDIS_KEY).catch(() => null),
    ]);
    const transits = transitsDoc && typeof transitsDoc === 'object' ? (transitsDoc.transits || {}) : {};
    const cr = corridorRisk && typeof corridorRisk === 'object' ? corridorRisk : {};

    const now = Date.now();
    const summaries = {};
    // Iterate the canonical chokepoint ID set, not whatever pw carries today —
    // if seed-portwatch dropped 3 of 13 (flaky ArcGIS), emitting all 13 with
    // zero-state keeps the RPC shape consistent and surfaces the shortfall via
    // recordCount only. Verbatim rationale from the relay loop.
    const CANONICAL_IDS = Object.keys(CHOKEPOINT_THREAT_LEVELS);
    let pwCovered = 0;

    for (const cpId of CANONICAL_IDS) {
      const cpData = pw[cpId];
      if (cpData) pwCovered++;

      // AIS transit counts for this chokepoint — from the bridged
      // supply_chain:chokepoint_transits:v1 (shared AIS-ingest service output),
      // keyed by geofence name. Was an in-process Map lookup + 24h-window
      // filter in the relay; the shared service already did that windowing +
      // per-type counting before writing the key.
      const relayName = ID_TO_RELAY_NAME[cpId];
      const transitCounts = relayName ? transits[relayName] : null;

      summaries[cpId] = buildSummaryRow(cpId, cpData, transitCounts, cr?.[cpId]);
      const history = cpData?.history ?? [];

      // Per-id history key — fetched only on card expand via GetChokepointHistory.
      // Best-effort: a failure here doesn't block the summary publish.
      try {
        await writeExtraKey(
          `${TRANSIT_SUMMARY_HISTORY_KEY_PREFIX}${cpId}`,
          { chokepointId: cpId, history, fetchedAt: now },
          TRANSIT_SUMMARY_TTL,
          { fetchedAt: now, recordCount: history.length, sourceVersion: 'transit-summaries-history', schemaVersion: 1, state: 'OK' },
        );
      } catch (e) {
        console.warn(`[TransitSummary] history write failed for ${cpId}: ${e?.message || e}`);
      }
    }

    if (pwCovered < CANONICAL_IDS.length) {
      console.warn(`[TransitSummary] portwatch coverage shortfall: ${pwCovered}/${CANONICAL_IDS.length} — missing chokepoints publish zero-state until next upstream success`);
    }

    let published = false;
    try {
      const result = await atomicPublish(TRANSIT_SUMMARY_REDIS_KEY, { summaries, fetchedAt: now }, null, TRANSIT_SUMMARY_TTL, {
        envelopeMeta: {
          fetchedAt: now,
          // recordCount = actual portwatch coverage, not the always-13 shape —
          // lets api/health.js see a coverage shortfall as a freshness anomaly.
          recordCount: pwCovered,
          sourceVersion: 'transit-summaries',
          schemaVersion: 1,
          state: 'OK',
        },
      });
      published = !result?.skipped;
    } catch (e) {
      console.error('[TransitSummary] Canonical write threw:', e?.message || e);
    }

    if (!published) {
      console.error('[TransitSummary] Canonical write failed — not advancing seed-meta');
      throw new Error('transit-summaries canonical write failed');
    }

    await writeSeedMeta(TRANSIT_SUMMARY_REDIS_KEY, pwCovered, TRANSIT_SUMMARY_META_KEY, META_TTL);
    logSeedResult('supply_chain:transit-summaries', pwCovered, Date.now() - startedAt);
    console.log(`[TransitSummary] Seeded ${pwCovered}/${CANONICAL_IDS.length} from portwatch + per-id history`);
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

if (process.argv[1]?.endsWith('seed-transit-summaries.mjs')) {
  main().catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
