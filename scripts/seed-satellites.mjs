#!/usr/bin/env node

/**
 * Satellite TLE seed — CelesTrak NORAD elements (no API key required).
 * Fetches the `military` and `resource` GP catalogs in TLE format, keeps only
 * the recon/ISR birds matched by SAT_NAME_FILTERS, classifies each by
 * type/country, and stores them under intelligence:satellites:tle:v1 so the
 * existing ListSatellites RPC serves them without changes.
 *
 * Ported verbatim (filters, satClassify, TLE triple-line parse) from the
 * startSatelliteSeedLoop() that used to live inside scripts/ais-relay.cjs —
 * extracted as part of the P14 Phase 2 loop-extraction pass (see
 * PLATFORM_ARCHITECTURE.md). No @notification-source tag: this loop never
 * called publishNotificationEvent. The relay's 20-min in-loop retry on an
 * empty/failed fetch is dropped — runSeed() extends last-good TTL on failure
 * and the next cron tick (2h) is the retry, matching the seed-gscpi.mjs
 * precedent from the same pass.
 */

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:satellites:tle:v1';
const CACHE_TTL = 21_600; // 6h — 3x the 2h cron interval; survives 2 missed cycles
const SAT_GROUPS = ['military', 'resource'];
const MAX_TLE_BYTES = 2 * 1024 * 1024; // 2MB per group catalog

const SAT_NAME_FILTERS = [
  /^YAOGAN/i, /^GAOFEN/i, /^JILIN/i,
  /^COSMOS 2[4-9]\d{2}/i,
  /^COSMO-SKYMED/i, /^TERRASAR/i, /^PAZ$/i, /^SAR-LUPE/i,
  /^WORLDVIEW/i, /^SKYSAT/i, /^PLEIADES/i, /^KOMPSAT/i,
  /^SAPPHIRE/i, /^PRAETORIAN/i,
  /^SENTINEL/i,
  /^CARTOSAT/i,
  /^GOKTURK/i, /^RASAT/i,
  /^USA[ -]?\d/i,
  /^ZIYUAN/i,
];

function satClassify(name) {
  const n = name.toUpperCase();
  let type = 'military';
  if (/COSMO-SKYMED|TERRASAR|PAZ|SAR-LUPE|YAOGAN/i.test(n)) type = 'sar';
  else if (/WORLDVIEW|SKYSAT|PLEIADES|KOMPSAT|GAOFEN|JILIN|CARTOSAT|ZIYUAN/i.test(n)) type = 'optical';
  else if (/SAPPHIRE|PRAETORIAN|USA|GOKTURK/i.test(n)) type = 'military';

  let country = 'OTHER';
  if (/^YAOGAN|^GAOFEN|^JILIN|^ZIYUAN/i.test(n)) country = 'CN';
  else if (/^COSMOS/i.test(n)) country = 'RU';
  else if (/^WORLDVIEW|^SAPPHIRE|^PRAETORIAN|^USA|^SKYSAT/i.test(n)) country = 'US';
  else if (/^SENTINEL|^COSMO-SKYMED|^TERRASAR|^SAR-LUPE|^PAZ|^PLEIADES/i.test(n)) country = 'EU';
  else if (/^KOMPSAT/i.test(n)) country = 'KR';
  else if (/^CARTOSAT/i.test(n)) country = 'IN';
  else if (/^GOKTURK|^RASAT/i.test(n)) country = 'TR';

  return { type, country };
}

async function fetchSatelliteTLEs() {
  const byNorad = new Map();

  for (const group of SAT_GROUPS) {
    let text;
    try {
      const resp = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) throw new Error(`CelesTrak ${group}: HTTP ${resp.status}`);
      text = await resp.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_TLE_BYTES) throw new Error(`CelesTrak ${group}: payload > 2MB`);
    } catch (e) {
      console.warn(`  Skipping group ${group}: ${e?.message || e}`);
      continue;
    }

    const lines = text.split('\n').map((l) => l.trimEnd());
    for (let i = 0; i < lines.length - 2; i++) {
      const l1 = lines[i + 1];
      const l2 = lines[i + 2];
      if (!l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;
      if (l1.length !== 69 || l2.length !== 69) continue;
      const name = lines[i].trim();
      const noradId = l1.substring(2, 7).trim();
      if (!byNorad.has(noradId)) {
        byNorad.set(noradId, { noradId, name, line1: l1, line2: l2 });
      }
      i += 2;
    }
  }

  const satellites = [];
  for (const sat of byNorad.values()) {
    if (!SAT_NAME_FILTERS.some((rx) => rx.test(sat.name))) continue;
    const { type, country } = satClassify(sat.name);
    satellites.push({ ...sat, type, country });
  }

  console.log(`  Matched ${satellites.length} recon TLEs from ${byNorad.size} catalog entries`);
  return { satellites, fetchedAt: Date.now() };
}

function validate(data) {
  return Array.isArray(data?.satellites) && data.satellites.length > 0;
}

export function declareRecords(data) {
  return Array.isArray(data?.satellites) ? data.satellites.length : 0;
}

runSeed('intelligence', 'satellites', CANONICAL_KEY, fetchSatelliteTLEs, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'celestrak',

  declareRecords,
  schemaVersion: 1,
  // 240min — matches api/health.js's existing SEED_META.satellites.maxStaleMin
  // (CelesTrak every 120min; 240min absorbs one missed cycle). That entry
  // predates this script; it was written against ais-relay.cjs's identical
  // 2h cadence.
  maxStaleMin: 240,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
