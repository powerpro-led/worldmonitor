#!/usr/bin/env node

/**
 * GSCPI seed — NY Fed Global Supply Chain Pressure Index.
 * CSV fetched from newyorkfed.org (no API key required). Published monthly;
 * seeded daily to catch fresh releases. Stored in FRED-compatible format
 * under economic:fred:v1:GSCPI:0 so the existing GetFredSeriesBatch RPC
 * serves it without changes.
 *
 * Ported from the startGscpiSeedLoop() that used to live inside
 * scripts/ais-relay.cjs (extracted as part of the P14 Phase 2 loop-extraction
 * pass — see PLATFORM_ARCHITECTURE.md). No @notification-source tag needed:
 * that loop never called publishNotificationEvent.
 */

import { createRequire } from 'node:module';
import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

const require = createRequire(import.meta.url);

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:fred:v1:GSCPI:0'; // FRED-compatible key
const CACHE_TTL = 259200; // 72h — 3x the 24h cron interval; survives 2 missed cycles
const CSV_URL = 'https://www.newyorkfed.org/medialibrary/research/interactives/data/gscpi/gscpi_interactive_data.csv';

const MONTH_MAP = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

function parseGscpiCsv(text) {
  const lines = text.trim().split('\n').filter((l) => l.trim() && !l.startsWith(','));
  const observations = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const dateStr = cols[0]?.trim();
    if (!dateStr) continue;
    // Find last non-empty, non-#N/A value (latest vintage estimate).
    let value = null;
    for (let j = cols.length - 1; j >= 1; j--) {
      const v = cols[j]?.trim();
      if (v && v !== '#N/A' && v !== '') {
        const num = parseFloat(v);
        if (!Number.isNaN(num)) { value = num; break; }
      }
    }
    if (value === null) continue;
    // Parse "31-Jan-2026" → "2026-01-01".
    const parts = dateStr.split('-');
    if (parts.length !== 3) continue;
    const mon = MONTH_MAP[parts[1]];
    const year = parts[2];
    if (!mon || !year) continue;
    observations.push({ date: `${year}-${mon}-01`, value });
  }
  // Return oldest-first (FRED convention).
  return observations.sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchGscpi() {
  let text;
  try {
    const resp = await fetch(CSV_URL, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv,text/plain' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    text = await resp.text();
  } catch (directErr) {
    const { resolveProxyConfig, proxyFetch } = require('./_proxy-utils.cjs');
    const proxy = resolveProxyConfig();
    if (!proxy) throw directErr;
    console.warn(`  Direct failed (${directErr.message}) — retrying via proxy`);
    const result = await proxyFetch(CSV_URL, proxy, {
      accept: 'text/csv,text/plain',
      headers: { 'User-Agent': CHROME_UA },
      timeoutMs: 20_000,
    });
    if (!result.ok) throw new Error(`Proxy HTTP ${result.status}`);
    text = result.buffer.toString('utf8');
  }

  const observations = parseGscpiCsv(text);
  const latest = observations[observations.length - 1];
  if (latest) console.log(`  Latest: ${latest.date} = ${latest.value.toFixed(2)}`);

  return {
    series: {
      series_id: 'GSCPI',
      title: 'Global Supply Chain Pressure Index',
      units: 'Standard Deviations',
      frequency: 'Monthly',
      observations,
    },
  };
}

function validate(data) {
  return Array.isArray(data?.series?.observations) && data.series.observations.length > 0;
}

export function declareRecords(data) {
  return Array.isArray(data?.series?.observations) ? data.series.observations.length : 0;
}

runSeed('economic', 'gscpi', CANONICAL_KEY, fetchGscpi, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'nyfed-gscpi',

  declareRecords,
  schemaVersion: 1,
  // 2880min = 48h = 2x the 24h cron interval — matches api/health.js's
  // existing SEED_META.gscpi.maxStaleMin exactly (that entry predates this
  // script; it was written against ais-relay.cjs's identical cadence).
  maxStaleMin: 2880,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
