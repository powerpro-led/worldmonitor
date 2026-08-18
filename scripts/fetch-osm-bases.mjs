#!/usr/bin/env node

import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const RAW_PATH = join(DATA_DIR, 'osm-military-raw.json');
const PROCESSED_PATH = join(DATA_DIR, 'osm-military-processed.json');

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// A single unbounded global query (no bbox) times out server-side on the
// public overpass-api.de instance even at 840s — measured: 550KB delivered
// in the original 5min budget then a 504 OSM3S error page after 14min. The
// standard fix for a query this size against a shared public instance is
// geographic partitioning: split into regional bboxes so each request is
// small enough to complete within the server's per-query budget. Some
// individual regions may still fail (dense areas, transient throttling) —
// that's logged and skipped rather than failing the whole fetch; partial
// global coverage from N-1 regions is far better than zero from an
// all-or-nothing single query.
const REGIONS = [
  { label: 'N. America',      bbox: [5, -170, 72, -50] },
  { label: 'S. America',      bbox: [-56, -82, 13, -33] },
  { label: 'Europe',          bbox: [35, -25, 72, 45] },
  { label: 'Africa',          bbox: [-35, -18, 38, 52] },
  { label: 'Middle East',     bbox: [12, 25, 42, 63] },
  { label: 'Central/S. Asia', bbox: [5, 60, 42, 100] },
  { label: 'E./SE Asia',      bbox: [-11, 90, 55, 150] },
  { label: 'Oceania',         bbox: [-48, 110, 0, 180] },
];

function regionQuery([south, west, north, east]) {
  return `
[out:json][timeout:120][bbox:${south},${west},${north},${east}];
(
  node["military"]["name"];
  way["military"]["name"];
  relation["military"]["name"];
);
out center tags;
`.trim();
}

const TIMEOUT_MS = 3 * 60 * 1000; // per-region curl budget

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
    console.log(`Created directory: ${DATA_DIR}`);
  }
}

async function fetchOverpassData(query) {
  // Node's fetch() gets 406/504 from overpass-api.de even with identical headers
  // that succeed via curl — a client-fingerprinting difference (TLS/HTTP client
  // signature, not anything in the declared headers; tested User-Agent and Accept
  // individually and together, still failed under fetch). curl works reliably.
  // Same workaround pattern as ais-relay.cjs's OREF fetch (orefCurlFetch) for the
  // same class of problem. execFileSync avoids shell interpolation entirely, and
  // -o writes straight to a temp file so a large response never sits in curl's
  // (or execFileSync's ~1MB default) stdout buffer.
  const tmpFile = join(tmpdir(), `overpass-military-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    const httpCode = execFileSync(
      'curl',
      [
        '-sS',
        '--compressed',
        '-X', 'POST',
        '--max-time', String(TIMEOUT_MS / 1000),
        '-H', 'Content-Type: application/x-www-form-urlencoded',
        '-H', 'Accept: */*',
        '-H', 'User-Agent: worldmonitor-military-bases-fetch/1.0',
        '--data-urlencode', `data=${query}`,
        '-o', tmpFile,
        '-w', '%{http_code}',
        OVERPASS_URL,
      ],
      { encoding: 'utf-8' }
    ).trim();
    // curl only exits non-zero on network-level failures (DNS, timeout, TLS) —
    // an HTTP error status still exits 0 and still writes to -o, so check
    // %{http_code} explicitly rather than relying on execFileSync throwing.
    if (httpCode !== '200') {
      const body = readFileSync(tmpFile, 'utf-8').slice(0, 500);
      throw new Error(`Overpass API returned ${httpCode}: ${body}`);
    }
    console.log('Response received, reading body...');
    const raw = readFileSync(tmpFile, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.status !== undefined) {
      // execFileSync's own spawn-error shape (has .status/.stderr) — curl
      // exited non-zero, a network-level failure (DNS, timeout, TLS), not an
      // HTTP error status (those are handled above via %{http_code}).
      throw new Error(`Overpass API curl request failed: ${err.stderr || err.message}`);
    }
    throw err;
  } finally {
    try { unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }
  }
}

function processFeatures(raw) {
  const elements = raw.elements || [];
  console.log(`Raw elements count: ${elements.length}`);

  const processed = elements.map((el) => {
    const tags = el.tags || {};

    // Coordinates: nodes have lat/lon directly; ways/relations use center
    const lat = el.lat ?? el.center?.lat ?? null;
    const lon = el.lon ?? el.center?.lon ?? null;

    const typePrefix = el.type; // node, way, relation
    const osmId = `${typePrefix}/${el.id}`;

    const name = tags['name:en'] || tags.name || '';
    const country = tags['addr:country'] || '';
    const kind = tags.military || '';
    const operator = tags.operator || '';
    const description = tags.description || '';
    const militaryBranch = tags.military_branch || '';

    return {
      osm_id: osmId,
      name,
      country,
      kind,
      lat,
      lon,
      operator,
      description,
      military_branch: militaryBranch,
    };
  });

  // Filter out entries without coordinates
  const withCoords = processed.filter((f) => f.lat != null && f.lon != null);
  const skipped = processed.length - withCoords.length;
  if (skipped > 0) {
    console.log(`Skipped ${skipped} features without coordinates`);
  }

  return withCoords;
}

function printSummary(features) {
  console.log(`\n--- Summary ---`);
  console.log(`Total processed features: ${features.length}`);

  // Count by kind
  const kindCounts = {};
  for (const f of features) {
    kindCounts[f.kind] = (kindCounts[f.kind] || 0) + 1;
  }
  console.log('\nBy military tag value:');
  const sorted = Object.entries(kindCounts).sort((a, b) => b[1] - a[1]);
  for (const [kind, count] of sorted) {
    console.log(`  ${kind}: ${count}`);
  }

  // Count with country
  const withCountry = features.filter((f) => f.country).length;
  console.log(`\nFeatures with country tag: ${withCountry}`);

  // Sample entries
  console.log('\nSample entries (first 5):');
  for (const f of features.slice(0, 5)) {
    console.log(`  ${f.osm_id} | ${f.name} | ${f.kind} | ${f.lat?.toFixed(4)},${f.lon?.toFixed(4)} | ${f.country || '(no country)'}`);
  }
}

async function main() {
  const start = Date.now();
  ensureDataDir();

  const allElements = [];
  const failedRegions = [];
  for (const region of REGIONS) {
    console.log(`\nQuerying ${region.label} (bbox: ${region.bbox.join(',')})...`);
    try {
      const raw = await fetchOverpassData(regionQuery(region.bbox));
      const count = raw.elements?.length || 0;
      console.log(`  ${region.label}: ${count} elements`);
      allElements.push(...(raw.elements || []));
    } catch (err) {
      console.warn(`  ${region.label} FAILED: ${err.message.slice(0, 200)}`);
      failedRegions.push(region.label);
    }
  }

  if (allElements.length === 0) {
    throw new Error(`All ${REGIONS.length} regional queries failed — no data to process.`);
  }
  if (failedRegions.length > 0) {
    console.warn(`\nWARNING: ${failedRegions.length}/${REGIONS.length} region(s) failed and are missing from this dataset: ${failedRegions.join(', ')}`);
  }

  // Dedup across regions — a way/relation can appear in >1 tile if it has
  // member nodes on both sides of a bbox boundary (node results are strictly
  // clipped to the bbox by Overpass; way/relation results are not).
  const seen = new Set();
  const dedupedElements = allElements.filter((el) => {
    const key = `${el.type}/${el.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`\nTotal across regions: ${allElements.length}, deduped: ${dedupedElements.length}`);

  const raw = { elements: dedupedElements };

  // Save raw
  console.log(`Saving raw response to ${RAW_PATH}...`);
  writeFileSync(RAW_PATH, JSON.stringify(raw, null, 2));
  console.log('Raw data saved.');

  // Process
  const features = processFeatures(raw);

  // Save processed
  console.log(`Saving processed data to ${PROCESSED_PATH}...`);
  writeFileSync(PROCESSED_PATH, JSON.stringify(features, null, 2));
  console.log('Processed data saved.');

  printSummary(features);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
