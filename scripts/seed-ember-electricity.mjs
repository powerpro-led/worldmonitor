#!/usr/bin/env node

import {
  acquireLockSafely,
  CHROME_UA,
  extendExistingTtl,
  getRedisCredentials,
  httpsProxyFetchRaw,
  loadEnvFile,
  logSeedResult,
  notifyMirroredWrites,
  releaseLock,
  withRetry,
} from './_seed-utils.mjs';
import { resolveIso2 } from './_country-resolver.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';

loadEnvFile(import.meta.url);

export const EMBER_KEY_PREFIX = 'energy:ember:v1:';
export const EMBER_ALL_KEY = 'energy:ember:v1:_all';
export const EMBER_META_KEY = 'seed-meta:energy:ember';
export const EMBER_TTL_SECONDS = 259200; // 72h = 3× daily cron interval

const EMBER_CSV_URL =
  'https://storage.googleapis.com/emb-prod-bkt-publicdata/public-downloads/monthly_full_release_long_format.csv';

// Env-tunable so a constrained link can raise it without a code change, same
// pattern as the news-digest timeout knobs. Clamped to a sane floor so a typo
// cannot make the fetch unwinnable.
const EMBER_CSV_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.EMBER_CSV_TIMEOUT_MS) || 15 * 60 * 1000,
);

// The DIRECT attempt gets its own, much smaller budget. Giving it the full
// EMBER_CSV_TIMEOUT_MS is actively harmful: on a throttled link the direct
// path can never finish (see fetchEmberCsv), so the seeder would burn the
// whole budget, burn it AGAIN on withRetry's second attempt, and only then
// reach the proxy — 30+ minutes to do a 155-second job. A healthy link
// downloads the file in seconds, so 3 minutes is generous there and this
// costs it nothing. Separate knob so either half can be tuned alone.
const EMBER_DIRECT_TIMEOUT_MS = Math.min(
  EMBER_CSV_TIMEOUT_MS,
  Math.max(30_000, Number(process.env.EMBER_DIRECT_TIMEOUT_MS) || 3 * 60 * 1000),
);

/**
 * Fetch the ~70 MB CSV, direct first and via PROXY_URL on failure — the same
 * direct-first/proxy-fallback shape ais-relay.cjs already uses for 8 upstreams
 * and that rssTryProxy uses for feeds.
 *
 * Why this seeder needs it (measured 2026-08-21): on a throttled link the
 * direct connection does not merely start slow, it DECAYS — 83 KB/s over the
 * first 3 MB, but only 21.8 KB/s averaged over 300s (6.5 MB transferred). At
 * that rate the file needs ~54 minutes, so no sane cron timeout can rescue it
 * and raising EMBER_CSV_TIMEOUT_MS alone does not work. The same file through
 * PROXY_URL ran at 454 KB/s (~155s for the whole CSV) — 21x faster.
 *
 * A route-level bypass is NOT an option here the way it is for a single-/24
 * host: storage.googleapis.com rotates across many addresses spanning both
 * 142.250.0.0/16 and 142.251.0.0/16.
 *
 * Direct stays first so unthrottled deployments never pay the proxy hop.
 */
async function fetchEmberCsv() {
  try {
    const resp = await fetch(EMBER_CSV_URL, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(EMBER_DIRECT_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`Ember HTTP ${resp.status}`);
    return await resp.text();
  } catch (err) {
    const proxyAuth = process.env.PROXY_URL;
    if (!proxyAuth) throw err;
    console.warn(`[EmberElectricity] direct fetch failed (${err.message}) — retrying via PROXY_URL`);
    const { buffer } = await httpsProxyFetchRaw(EMBER_CSV_URL, proxyAuth, {
      accept: 'text/csv',
      timeoutMs: EMBER_CSV_TIMEOUT_MS,
    });
    console.log(`[EmberElectricity] proxy fetch OK (${buffer.length} bytes)`);
    return buffer.toString('utf8');
  }
}
const LOCK_DOMAIN = 'energy:ember';
const LOCK_TTL_MS = 20 * 60 * 1000; // 20 min
const MIN_COUNTRIES = 60;
const MIN_COUNT_RATIO = 0.75; // abort if new count < 75% of previous

function parseDelimitedRow(line, delimiter) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let idx = 0; idx < line.length; idx += 1) {
    const char = line[idx];
    const next = line[idx + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        idx += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function parseDelimitedText(text, delimiter) {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\r|\n/) // tolerate LF, CRLF, and bare CR (Ember switched to CR-only Jun 2026)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const headers = parseDelimitedRow(lines[0], delimiter);
  return lines.slice(1).map((line) => {
    const values = parseDelimitedRow(line, delimiter);
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
  });
}

function safeFloat(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize an Ember date cell to canonical YYYY-MM-DD so downstream
 * lexicographic max/equality/slice stay correct.
 * Handles legacy ISO (YYYY-MM-DD) and the Jun-2026 DD/MM/YYYY format.
 * @param {string} value
 * @returns {string} canonical YYYY-MM-DD, or '' when unrecognized
 */
function normalizeDate(value) {
  const s = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return '';
}

/**
 * Parse Ember long-format monthly CSV.
 * Returns Map<iso2, EmberCountryData>.
 * @param {string} csvText
 * @returns {Map<string, {dataMonth: string, fossilShare: number|null, renewShare: number|null, nuclearShare: number|null, coalShare: number|null, gasShare: number|null, demandTwh: number|null}>}
 */
// Real Ember monthly CSV column names (confirmed from header row)
const COLS = {
  iso3: 'ISO 3 code',
  series: 'Variable',
  unit: 'Unit',
  value: 'Value',
  date: 'Date',
};

export function parseEmberCsv(csvText) {
  const rows = parseDelimitedText(csvText, ',');
  if (rows.length === 0) throw new Error('Ember CSV: no data rows');

  // Schema sentinel — abort if Fossil series is missing entirely
  const hasFossil = rows.some((r) => String(r[COLS.series] || '').trim() === 'Fossil');
  if (!hasFossil) {
    throw new Error('Ember CSV schema changed — "Fossil" series not found; update parser');
  }

  // Group by ISO 3 code, filter to TWh rows only
  /** @type {Map<string, Array<{date: string, series: string, value: number}>>} */
  const byIso3 = new Map();
  for (const row of rows) {
    const iso3 = String(row[COLS.iso3] || '').trim();
    if (!iso3) continue;
    if (String(row[COLS.unit] || '').trim() !== 'TWh') continue;

    const value = safeFloat(row[COLS.value]);
    if (value === null) continue;

    const series = String(row[COLS.series] || '').trim();
    const date = normalizeDate(row[COLS.date]);
    if (!series || !date) continue;

    if (!byIso3.has(iso3)) byIso3.set(iso3, []);
    byIso3.get(iso3).push({ date, series, value });
  }

  /** @type {Map<string, object>} */
  const result = new Map();

  for (const [iso3, entries] of byIso3) {
    const iso2 = resolveIso2({ iso3 });
    if (!iso2) continue;

    // Find most recent month — max date string (YYYY-MM-DD lexicographic order works)
    const maxDate = entries.reduce((best, e) => (e.date > best ? e.date : best), '');
    if (!maxDate) continue;

    const monthEntries = entries.filter((e) => e.date === maxDate);

    // Build series lookup for this month
    const seriesMap = new Map();
    for (const e of monthEntries) {
      seriesMap.set(e.series, e.value);
    }

    const total = seriesMap.get('Total Generation') ?? null;
    if (!total || total === 0) continue;

    const fossil = seriesMap.get('Fossil') ?? null;
    const renew = seriesMap.get('Renewables') ?? null;
    const nuclear = seriesMap.get('Nuclear') ?? null;
    const coal = seriesMap.get('Coal') ?? null;
    const gas = seriesMap.get('Gas') ?? null;

    const fossilShare = fossil !== null ? (fossil / total) * 100 : null;
    const renewShare = renew !== null ? (renew / total) * 100 : null;
    const nuclearShare = nuclear !== null ? (nuclear / total) * 100 : null;
    const coalShare = coal !== null ? (coal / total) * 100 : null;
    const gasShare = gas !== null ? (gas / total) * 100 : null;

    // dataMonth = YYYY-MM from YYYY-MM-DD
    const dataMonth = maxDate.slice(0, 7);

    result.set(iso2, {
      dataMonth,
      fossilShare,
      renewShare,
      nuclearShare,
      coalShare,
      gasShare,
      demandTwh: total,
    });
  }

  return result;
}

/**
 * Build compact bulk map of all countries keyed by ISO2.
 * Omits redundant fields to reduce payload size.
 * @param {Map<string, object>} countries
 * @returns {Record<string, {dataMonth: string, fossilShare: number|null, renewShare: number|null, nuclearShare: number|null, coalShare: number|null, gasShare: number|null, demandTwh: number|null}>}
 */
export function buildAllCountriesMap(countries) {
  const result = {};
  for (const [iso2, entry] of countries) {
    result[iso2] = {
      dataMonth: entry.dataMonth,
      fossilShare: entry.fossilShare,
      renewShare: entry.renewShare,
      nuclearShare: entry.nuclearShare,
      coalShare: entry.coalShare,
      gasShare: entry.gasShare,
      demandTwh: entry.demandTwh,
    };
  }
  return result;
}

async function redisPipeline(commands) {
  const { url, token } = getRedisCredentials();
  const response = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Redis pipeline failed: HTTP ${response.status} — ${text.slice(0, 200)}`);
  }
  return response.json();
}

async function redisGet(key) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.result ? unwrapEnvelope(JSON.parse(data.result)).data : null;
}

async function preservePreviousSnapshot(errorMsg, stashedAllMap = null, newCountryKeys = null, dataWritten = false) {
  console.error('[EmberElectricity] Preserving previous snapshot:', errorMsg);

  const existingMeta = await redisGet(EMBER_META_KEY).catch(() => null);

  if (stashedAllMap && typeof stashedAllMap === 'object' && !dataWritten) {
    const restoreCmds = [];
    for (const [iso2, val] of Object.entries(stashedAllMap)) {
      restoreCmds.push([
        'SET', `${EMBER_KEY_PREFIX}${iso2}`, JSON.stringify(val), 'EX', EMBER_TTL_SECONDS,
      ]);
    }
    restoreCmds.push(['SET', EMBER_ALL_KEY, JSON.stringify(stashedAllMap), 'EX', EMBER_TTL_SECONDS]);
    if (newCountryKeys) {
      const oldIso2Set = new Set(Object.keys(stashedAllMap));
      for (const iso2 of newCountryKeys) {
        if (!oldIso2Set.has(iso2)) {
          restoreCmds.push(['DEL', `${EMBER_KEY_PREFIX}${iso2}`]);
        }
      }
    }
    await redisPipeline(restoreCmds).catch((e) =>
      console.error('[EmberElectricity] Snapshot restore failed:', e),
    );
  } else if (!dataWritten) {
    const existingAll = await redisGet(EMBER_ALL_KEY).catch(() => null);
    const iso2Keys = existingAll && typeof existingAll === 'object'
      ? Object.keys(existingAll).map((iso2) => `${EMBER_KEY_PREFIX}${iso2}`)
      : [];

    await extendExistingTtl(
      [...iso2Keys, EMBER_ALL_KEY, EMBER_META_KEY],
      EMBER_TTL_SECONDS,
    );
  }

  const metaPayload = {
    fetchedAt: Date.now(),
    recordCount: existingMeta?.recordCount ?? null,
    status: 'error',
    error: errorMsg,
  };
  await redisPipeline([
    ['SET', EMBER_META_KEY, JSON.stringify(metaPayload), 'EX', EMBER_TTL_SECONDS],
  ]);
}

export async function main() {
  const startedAt = Date.now();
  const runId = `energy:ember:${startedAt}`;
  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });
  if (lock.skipped) {
    console.log('[EmberElectricity] Lock held by concurrent run, skipping');
    return;
  }
  if (!lock.locked) {
    console.log('[EmberElectricity] Lock held by another run, skipping');
    return;
  }

  let oldAllMap = null;
  let newCountryKeys = null;
  let dataWritten = false;

  try {
    const csvText = await withRetry(() => fetchEmberCsv(), 2, 2000);

    const countries = parseEmberCsv(csvText);
    console.log(`[EmberElectricity] Parsed ${countries.size} countries`);

    if (countries.size < MIN_COUNTRIES) {
      throw new Error(
        `Ember: only ${countries.size} countries parsed, expected >=${MIN_COUNTRIES}`,
      );
    }

    // Count-drop guard: abort if new count < 75% of previous
    const prevMeta = await redisGet(EMBER_META_KEY).catch(() => null);
    if (prevMeta && typeof prevMeta === 'object' && prevMeta.recordCount > 0) {
      if (countries.size < prevMeta.recordCount * MIN_COUNT_RATIO) {
        throw new Error(
          `Ember: country count dropped from ${prevMeta.recordCount} to ${countries.size} (<75% threshold) — aborting`,
        );
      }
    }

    newCountryKeys = new Set(countries.keys());

    const allCountriesMap = buildAllCountriesMap(countries);

    const metaPayload = {
      fetchedAt: Date.now(),
      recordCount: countries.size,
      sourceVersion: 'ember-monthly-v1',
    };

    // Stash old _all for restore on failure
    oldAllMap = await redisGet(EMBER_ALL_KEY).catch(() => null);

    // Phase A: write all per-country keys + _all in a single pipeline
    const dataCommands = [];
    for (const [iso2, payload] of countries) {
      dataCommands.push([
        'SET',
        `${EMBER_KEY_PREFIX}${iso2}`,
        JSON.stringify(payload),
        'EX',
        EMBER_TTL_SECONDS,
      ]);
    }
    dataCommands.push([
      'SET',
      EMBER_ALL_KEY,
      JSON.stringify(allCountriesMap),
      'EX',
      EMBER_TTL_SECONDS,
    ]);

    // DEL obsolete per-country keys no longer in the new dataset
    const oldIso2Set = oldAllMap && typeof oldAllMap === 'object' ? new Set(Object.keys(oldAllMap)) : new Set();
    for (const iso2 of oldIso2Set) {
      if (!newCountryKeys.has(iso2)) {
        dataCommands.push(['DEL', `${EMBER_KEY_PREFIX}${iso2}`]);
      }
    }

    const dataResults = await redisPipeline(dataCommands);
    const dataFailures = dataResults.filter((r) => r?.error || r?.result === 'ERR');
    if (dataFailures.length > 0) {
      throw new Error(
        `Redis pipeline: ${dataFailures.length}/${dataCommands.length} data commands failed`,
      );
    }
    dataWritten = true;

    // Nudge the real-time sync listener for every mirrored key just written
    // (per-country energy:ember:v1:* rows + _all; the DEL entries and the
    // Phase-B seed-meta:* write are not notified here — same rule
    // notifyPipelineWrites() uses on the RPC side). Without this these only
    // refresh on the sidecar's 6h full reconciliation (data-pipeline review #4).
    const { url, token } = getRedisCredentials();
    await notifyMirroredWrites(url, token, dataCommands);

    // Phase B: seed-meta (only after all data is fully written)
    await redisPipeline([['SET', EMBER_META_KEY, JSON.stringify(metaPayload), 'EX', EMBER_TTL_SECONDS]]);

    logSeedResult('energy:ember', countries.size, Date.now() - startedAt);
    console.log(`[EmberElectricity] Seeded ${countries.size} countries`);
  } catch (err) {
    await preservePreviousSnapshot(String(err), oldAllMap, newCountryKeys, dataWritten).catch((e) =>
      console.error('[EmberElectricity] Failed to preserve snapshot:', e),
    );
    throw err;
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

if (process.argv[1]?.endsWith('seed-ember-electricity.mjs')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
