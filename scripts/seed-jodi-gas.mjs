#!/usr/bin/env node
// @ts-check

import { inflateRaw } from 'node:zlib';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import {
  loadEnvFile,
  CHROME_UA,
  runSeed,
  writeExtraKey,
  readSeedSnapshot,
  extendExistingTtl,
} from './_seed-utils.mjs';
import {
  assessChinaJodiCoverage,
  hasFiniteMeasurementAtPaths,
} from './shared/jodi-content-age.mjs';

loadEnvFile(import.meta.url);
const require = createRequire(import.meta.url);
const JODI_MEASUREMENT_FIELDS = require('./shared/jodi-measurement-fields.json');

const inflateRawAsync = promisify(inflateRaw);

export const CANONICAL_KEY = 'energy:jodi-gas:v1:_countries';
export const KEY_PREFIX = 'energy:jodi-gas:v1:';
export const LNG_VULNERABILITY_KEY = 'energy:lng-vulnerability:v1';
export const GAS_TTL = 3_024_000;

/**
 * The `/gas/<n>/` path segment is a release counter, NOT a stable "latest"
 * pointer — JODI mints a new id per gas publication (~monthly, sometimes twice
 * when a release is re-cut: ids 21/22/23 all landed 22-24 Jun 2026). Pinning it
 * silently freezes the dataset: id 17 (16 Mar 2026) tops out at TIME_PERIOD
 * 2026-01 with China data ending 2025-11, which blows the 6-month China
 * content-age gate and blocks publishes entirely.
 *
 * The downloads page injects its links via JS, so there is nothing to scrape.
 * Instead probe upward from a known-good floor and take the highest id that
 * still resolves.
 */
const GAS_ZIP_BASE = 'https://www.jodidata.org/jodi-publisher/gas';
/** Highest id verified to exist (2026-07-19 release). Only ever raise this. */
export const KNOWN_GAS_RELEASE_ID = 24;
/** Consecutive misses that end the upward scan — tolerates a single skipped id. */
const RELEASE_PROBE_GAP = 2;
/** Bound on forward probes so a served-200-for-everything origin can't loop. */
const MAX_FORWARD_PROBES = 36;
/** How far below the floor to search if the floor itself stops resolving. */
const MAX_BACKWARD_PROBES = 24;

export function gasZipUrl(releaseId) {
  return `${GAS_ZIP_BASE}/${releaseId}/GAS_world_NewFormat.zip`;
}
const CSV_FILENAME = 'STAGING_world_NewFormat.csv';
const UNIT_FILTER = 'TJ';
export const MIN_COUNTRIES = 50;

export const FLOW_MAP = {
  IMPLNG:   'lngImportsTj',
  IMPPIP:   'pipeImportsTj',
  EXPLNG:   'lngExportsTj',
  EXPPIP:   'pipeExportsTj',
  INDPROD:  'productionTj',
  TOTIMPSB: 'totalImportsTj',
  TOTDEMO:  'totalDemandTj',
  CLOSTLV:  'closingStockTj',
};

export function parseObsValue(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '' || s === '-' || s === 'x') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseCsvRows(csvText) {
  const lines = csvText.split(/\r?\n/);
  if (lines.length < 2) return [];

  const header = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const idxArea   = header.indexOf('REF_AREA');
  const idxPeriod = header.indexOf('TIME_PERIOD');
  const idxFlow   = header.indexOf('FLOW_BREAKDOWN');
  const idxUnit   = header.indexOf('UNIT_MEASURE');
  const idxObs    = header.indexOf('OBS_VALUE');
  const idxAssess = header.indexOf('ASSESSMENT_CODE');

  if (idxArea < 0 || idxPeriod < 0 || idxFlow < 0 || idxUnit < 0 || idxObs < 0) {
    throw new Error('CSV missing required columns');
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = line.split(',');
    const unit = cells[idxUnit]?.trim().replace(/^"|"$/g, '');
    if (unit !== UNIT_FILTER) continue;
    const flow = cells[idxFlow]?.trim().replace(/^"|"$/g, '');
    if (!FLOW_MAP[flow]) continue;
    const assessRaw = idxAssess >= 0 ? cells[idxAssess]?.trim().replace(/^"|"$/g, '') : '';
    const assessNum = Number(assessRaw);
    if (assessNum !== 1 && assessNum !== 2) continue;
    const obs = parseObsValue(cells[idxObs]);
    rows.push({
      area:   cells[idxArea]?.trim().replace(/^"|"$/g, ''),
      period: cells[idxPeriod]?.trim().replace(/^"|"$/g, ''),
      flow,
      obs,
    });
  }
  return rows;
}

export function buildCountryRecords(rows) {
  const byArea = new Map();
  for (const row of rows) {
    if (!byArea.has(row.area)) byArea.set(row.area, []);
    byArea.get(row.area).push(row);
  }

  const records = [];
  for (const [iso2, areaRows] of byArea) {
    const periods = [...new Set(areaRows.map(r => r.period))].sort().reverse();
    let chosen = null;
    for (const p of periods) {
      if (areaRows.some(r => r.period === p)) {
        chosen = p;
        break;
      }
    }
    if (!chosen) continue;

    const chosenRows = areaRows.filter(r => r.period === chosen);
    const fields = {};
    for (const row of chosenRows) {
      const fieldName = FLOW_MAP[row.flow];
      if (fieldName) fields[fieldName] = row.obs;
    }

    const lngImports   = fields.lngImportsTj  ?? null;
    const totalImports = fields.totalImportsTj ?? null;
    let lngShare = null;
    if (lngImports !== null && totalImports !== null && totalImports > 0) {
      lngShare = +(lngImports / totalImports).toFixed(4);
    }

    records.push({
      iso2,
      dataMonth:         chosen,
      productionTj:      fields.productionTj    ?? null,
      lngImportsTj:      fields.lngImportsTj    ?? null,
      pipeImportsTj:     fields.pipeImportsTj   ?? null,
      lngExportsTj:      fields.lngExportsTj    ?? null,
      pipeExportsTj:     fields.pipeExportsTj   ?? null,
      totalImportsTj:    fields.totalImportsTj  ?? null,
      totalDemandTj:     fields.totalDemandTj   ?? null,
      closingStockTj:    fields.closingStockTj  ?? null,
      lngShareOfImports: lngShare,
      seededAt:          new Date().toISOString(),
    });
  }

  return records;
}

export function validateGasCountries(iso2Array) {
  return Array.isArray(iso2Array) && iso2Array.length >= MIN_COUNTRIES;
}

function hasGasMeasurements(record) {
  return hasFiniteMeasurementAtPaths(record, JODI_MEASUREMENT_FIELDS.gas);
}

export function assessChinaGasCoverage(records, now = new Date()) {
  return assessChinaJodiCoverage(records, now, hasGasMeasurements);
}

/**
 * Reject unusable China coverage without letting the prior per-country
 * snapshot expire behind the still-preserved canonical country list.
 *
 * @param {Parameters<typeof assessChinaGasCoverage>[0]} records
 * @param {Date} now
 * @param {{
 *   readSnapshot?: (key: string) => Promise<unknown>,
 *   extendTtl?: (keys: string[], ttlSeconds: number) => Promise<unknown>,
 * }} deps
 */
export async function enforceChinaGasCoverage(records, now = new Date(), deps = {}) {
  const chinaCoverage = assessChinaGasCoverage(records, now);
  if (chinaCoverage.ok) return chinaCoverage;

  const readSnapshot = deps.readSnapshot ?? readSeedSnapshot;
  const extendTtl = deps.extendTtl ?? extendExistingTtl;
  const previousIso2List = await readSnapshot(CANONICAL_KEY).catch(() => null);
  const previousCountryKeys = Array.isArray(previousIso2List)
    ? previousIso2List
      .filter((iso2) => typeof iso2 === 'string' && /^[A-Z]{2}$/.test(iso2))
      .map((iso2) => `${KEY_PREFIX}${iso2}`)
    : [];

  if (previousCountryKeys.length > 0) {
    await extendTtl(previousCountryKeys, GAS_TTL).catch(() => {});
  }

  const error = new Error(`China JODI gas coverage failed: ${chinaCoverage.reason} (dataMonth=${chinaCoverage.dataMonth ?? 'missing'})`);
  // The coverage result is deterministic for the downloaded snapshot. Tell
  // runSeed's outer withRetry loop not to download and parse the same ZIP
  // again after last-good country TTLs have already been preserved.
  error.nonRetryable = true;
  throw error;
}

function findZipEntry(buf, filename) {
  const LOCAL_SIG = 0x04034b50;
  let offset = 0;
  while (offset < buf.length - 30) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== LOCAL_SIG) {
      offset++;
      continue;
    }
    const flags        = buf.readUInt16LE(offset + 6);
    const compression  = buf.readUInt16LE(offset + 8);
    const compSize     = buf.readUInt32LE(offset + 18);
    const fnameLen     = buf.readUInt16LE(offset + 26);
    const extraLen     = buf.readUInt16LE(offset + 28);
    const entryName    = buf.slice(offset + 30, offset + 30 + fnameLen).toString('utf8');
    const dataOffset   = offset + 30 + fnameLen + extraLen;
    if (!filename || entryName === filename || entryName.endsWith('/' + filename)) {
      if ((flags & 0x08) && compSize === 0) {
        throw new Error(`JODI Gas ZIP: entry uses data-descriptor (bit 3) — compSize unknown in local header`);
      }
      return { dataOffset, compSize, compression, entryName };
    }
    // If bit 3 is set, compSize in local header is 0 — fall back to byte scan
    if ((flags & 0x08) && compSize === 0) { offset++; continue; }
    offset = dataOffset + compSize;
  }
  return null;
}

async function releaseExists(releaseId) {
  try {
    const resp = await fetch(gasZipUrl(releaseId), {
      method: 'HEAD',
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15_000),
    });
    return resp.ok;
  } catch {
    // Network error is not evidence of absence — treat as "unknown", which the
    // caller handles by stopping the scan rather than by skipping past the id.
    return false;
  }
}

/**
 * Resolve the newest gas release id. Scans up from KNOWN_GAS_RELEASE_ID; if the
 * floor itself no longer resolves (JODI pruning old releases), walks back down.
 * Returns the floor unchanged when probing is inconclusive, so a transient
 * network failure degrades to today's behaviour instead of failing the seed.
 */
export async function resolveLatestGasRelease(exists = releaseExists) {
  if (!(await exists(KNOWN_GAS_RELEASE_ID))) {
    for (let id = KNOWN_GAS_RELEASE_ID - 1; id >= KNOWN_GAS_RELEASE_ID - MAX_BACKWARD_PROBES && id > 0; id--) {
      if (await exists(id)) return id;
    }
    return KNOWN_GAS_RELEASE_ID;
  }

  let newest = KNOWN_GAS_RELEASE_ID;
  let misses = 0;
  for (let probe = 1; probe <= MAX_FORWARD_PROBES && misses < RELEASE_PROBE_GAP; probe++) {
    const id = KNOWN_GAS_RELEASE_ID + probe;
    if (await exists(id)) {
      newest = id;
      misses = 0;
    } else {
      misses++;
    }
  }
  return newest;
}

async function fetchAndParseCsv() {
  const releaseId = await resolveLatestGasRelease();
  const zipUrl = gasZipUrl(releaseId);
  if (releaseId > KNOWN_GAS_RELEASE_ID) {
    console.log(`  Resolved gas release ${releaseId} (${releaseId - KNOWN_GAS_RELEASE_ID} newer than pinned floor ${KNOWN_GAS_RELEASE_ID})`);
  } else if (releaseId < KNOWN_GAS_RELEASE_ID) {
    console.warn(`  WARNING: gas release floor ${KNOWN_GAS_RELEASE_ID} no longer resolves — fell back to ${releaseId}`);
  }
  console.log(`  Fetching JODI Gas ZIP from ${zipUrl}`);
  const resp = await fetch(zipUrl, {
    headers: { 'User-Agent': CHROME_UA, 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) throw new Error(`JODI Gas ZIP fetch failed: HTTP ${resp.status} for ${zipUrl}`);

  const arrayBuf = await resp.arrayBuffer();
  const zipBuf = Buffer.from(arrayBuf);
  console.log(`  ZIP downloaded: ${(zipBuf.length / 1024 / 1024).toFixed(1)} MB`);

  const entry = findZipEntry(zipBuf, CSV_FILENAME);
  if (!entry) throw new Error(`Could not find ${CSV_FILENAME} in ZIP`);
  console.log(`  Found entry: ${entry.entryName} (compression=${entry.compression})`);

  const compressed = zipBuf.slice(entry.dataOffset, entry.dataOffset + entry.compSize);
  let csvBuf;
  if (entry.compression === 0) {
    csvBuf = compressed;
  } else if (entry.compression === 8) {
    csvBuf = await inflateRawAsync(compressed);
  } else {
    throw new Error(`Unsupported ZIP compression method: ${entry.compression}`);
  }

  const csvText = csvBuf.toString('utf8');
  console.log(`  CSV size: ${(csvText.length / 1024 / 1024).toFixed(1)} MB`);
  return csvText;
}

async function fetchJodiGas() {
  const csvText = await fetchAndParseCsv();
  console.log('  Parsing CSV rows...');
  const rows = parseCsvRows(csvText);
  console.log(`  Rows after TJ/flow/assessment filter: ${rows.length}`);
  const records = buildCountryRecords(rows);
  console.log(`  Countries with gas data: ${records.length}`);
  await enforceChinaGasCoverage(records);
  return records;
}

/**
 * @typedef {{ iso2: string, lngShareOfImports: number|null, lngImportsTj: number|null, pipeImportsTj: number|null, dataMonth: string }} GasRecord
 */

/**
 * Build the LNG vulnerability index from country records.
 * @param {GasRecord[]} members
 * @param {string} dataMonth
 * @param {string} updatedAt
 */
export function buildLngVulnerabilityIndex(members, dataMonth, updatedAt) {
  const withLng = members.filter(
    r => r.lngShareOfImports !== null && typeof r.lngShareOfImports === 'number' && (r.lngImportsTj ?? 0) > 0,
  );
  const withPipe = members.filter(
    r => r.lngShareOfImports !== null && typeof r.lngShareOfImports === 'number' && (r.pipeImportsTj ?? 0) > 0,
  );

  const top20LngDependent = withLng
    .sort((a, b) => /** @type {number} */ (b.lngShareOfImports) - /** @type {number} */ (a.lngShareOfImports))
    .slice(0, 20)
    .map(r => ({
      iso2: r.iso2,
      lngShareOfImports: /** @type {number} */ (r.lngShareOfImports),
      lngImportsTj: /** @type {number} */ (r.lngImportsTj),
    }));

  const top20PipelineDependent = withPipe
    .sort((a, b) => /** @type {number} */ (a.lngShareOfImports) - /** @type {number} */ (b.lngShareOfImports))
    .slice(0, 20)
    .map(r => ({
      iso2: r.iso2,
      lngShareOfImports: /** @type {number} */ (r.lngShareOfImports),
      pipeImportsTj: /** @type {number} */ (r.pipeImportsTj),
    }));

  return { updatedAt, dataMonth, top20LngDependent, top20PipelineDependent };
}

const isMain = process.argv[1]?.endsWith('seed-jodi-gas.mjs');

export function declareRecords(data) {
  return Array.isArray(data) ? data.length : 0;
}

if (isMain) {
  await runSeed('energy', 'jodi-gas', CANONICAL_KEY, fetchJodiGas, {
    ttlSeconds: GAS_TTL,
    metaTtlSeconds: GAS_TTL,
    validateFn: validateGasCountries,
    publishTransform: (records) => records.map(r => r.iso2),
    recordCount: (records) => (Array.isArray(records) ? records.length : 0),
    extraKeys: [
      {
        key: LNG_VULNERABILITY_KEY,
        ttl: GAS_TTL,
        transform: (records) => {
          const updatedAt = new Date().toISOString();
          const dataMonths = records.map(r => r.dataMonth).filter(Boolean).sort();
          const dataMonth = dataMonths[dataMonths.length - 1] ?? '';
          return buildLngVulnerabilityIndex(records, dataMonth, updatedAt);
        },
      },
    ],
    afterPublish: async (records) => {
      for (const record of records) {
        await writeExtraKey(`${KEY_PREFIX}${record.iso2}`, record, GAS_TTL);
      }
      // LNG vulnerability index is now written via extraKeys (gets TTL-preserved on failure)
    },
  
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 57600,
    sourceVersion: 'jodi-gas-v1',
  });
}
