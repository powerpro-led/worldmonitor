#!/usr/bin/env node

/**
 * Positive Events seed — GDELT v1 GKG GeoJSON, one positive-theme tag per
 * call, fanned out + merged into per-location hotspots. Stores the capped
 * event list under positive-events:geo:v1 (RPC) + positive_events:geo-bootstrap:v1
 * (bootstrap) so the existing ListPositiveEvents RPC serves it without changes.
 *
 * Ported from the startPositiveEventsSeedLoop() that used to live inside
 * scripts/ais-relay.cjs (P14 Phase 2 loop-extraction pass — see
 * PLATFORM_ARCHITECTURE.md). The loop's hand-rolled `setTimeout(5_500)` between
 * the 6 theme queries is replaced by _gdelt-fetch.mjs's cross-process rate gate
 * (GDELT_RATE_WINDOW_MS = 5_500 — the exact same 5s+ floor, now coordinated
 * with the other GDELT-hitting seeders), which fetchGdeltJson claims per attempt
 * and which also adds the direct→proxy fallback the raw https.get loop lacked.
 * No @notification-source tag — this loop never called publishNotificationEvent.
 */

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { fetchGdeltJson } from './_gdelt-fetch.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'positive-events:geo:v1';
const BOOTSTRAP_KEY = 'positive_events:geo-bootstrap:v1';
// 75 min — 5x the 15-min cron interval, and STRICTLY above the 60-min (3600s)
// health staleness gate (api/health.js SEED_META.positiveGeoEvents) so a late
// seeder escalates STALE_SEED→EMPTY in order. The relay loop wrote this key at
// 45 min (== 3x interval, BELOW the gate) — invisible there because it isn't a
// seed-*.mjs file; not replicated. See seed-ttl-outlives-staleness-fleet.test.mjs.
const CACHE_TTL = 4500;
const MAX_EVENTS = 500;
const TONE_THRESHOLD = 2; // keep only articles with urltone strictly above this

// Found live 2026-09-22 (biovita GCP cost investigation): fetchGdeltJson()'s
// DEFAULT retry budget (4 direct attempts × 15s timeout + up to 60s of
// backoff between them, THEN 5 proxy attempts) is 150s+ in the worst case
// for a SINGLE call — this loop makes 6 of them sequentially, one per
// theme, with no override, so a single unlucky query could already consume
// the whole 60s Cloud Run request timeout on its own; Cloud Run logs showed
// this job failing 93% of the time with a hard 60.000s timeout, not a fast
// error. Individual query failure is already treated as non-fatal here
// (`continue` below, `anyQuerySucceeded` only needs ONE of the six) — the
// same fast-fail tuning `seed-conflict-intel.mjs`'s `GDELT_COUNTRY_FETCH_OPTS`
// already uses for its own "runs N× per cycle, keep each call cheap" sweep
// applies just as directly here.
const GDELT_THEME_FETCH_OPTS = Object.freeze({ maxRetries: 0, proxyMaxAttempts: 1 });

// Single-theme queries — v1 GKG accepts one theme tag per call.
// http://data.gdeltproject.org/documentation/GKG-MASTER-THEMELIST.TXT
const QUERIES = [
  'SOC_INNOVATION',
  'EDUCATION',
  'MEDICAL',
  'TOURISM',
  'WB_1765_CULTURE_HERITAGE_AND_SUSTAINABLE_TOURISM',
  'PEACEKEEPING',
];

// Mirrors CATEGORY_KEYWORDS from src/services/positive-classifier.ts — keep in sync
const CATEGORY_KEYWORDS = [
  ['clinical trial', 'science-health'], ['study finds', 'science-health'],
  ['researchers', 'science-health'], ['scientists', 'science-health'],
  ['breakthrough', 'science-health'], ['discovery', 'science-health'],
  ['cure', 'science-health'], ['vaccine', 'science-health'],
  ['treatment', 'science-health'], ['medical', 'science-health'],
  ['endangered species', 'nature-wildlife'], ['conservation', 'nature-wildlife'],
  ['wildlife', 'nature-wildlife'], ['species', 'nature-wildlife'],
  ['marine', 'nature-wildlife'], ['forest', 'nature-wildlife'],
  ['renewable', 'climate-wins'], ['solar', 'climate-wins'],
  ['wind energy', 'climate-wins'], ['electric vehicle', 'climate-wins'],
  ['emissions', 'climate-wins'], ['carbon', 'climate-wins'],
  ['clean energy', 'climate-wins'], ['climate', 'climate-wins'],
  ['robot', 'innovation-tech'], ['technology', 'innovation-tech'],
  ['startup', 'innovation-tech'], ['innovation', 'innovation-tech'],
  ['artificial intelligence', 'innovation-tech'],
  ['volunteer', 'humanity-kindness'], ['donated', 'humanity-kindness'],
  ['charity', 'humanity-kindness'], ['rescued', 'humanity-kindness'],
  ['hero', 'humanity-kindness'], ['kindness', 'humanity-kindness'],
  [' art ', 'culture-community'], ['music', 'culture-community'],
  ['festival', 'culture-community'], ['education', 'culture-community'],
];

function classifyPositiveName(name) {
  const lower = ` ${name.toLowerCase()} `;
  for (const [kw, cat] of CATEGORY_KEYWORDS) {
    if (lower.includes(kw)) return cat;
  }
  return 'humanity-kindness';
}

function gkgFeatureUrl(p) {
  return p?.url || p?.source_url || p?.sourceUrl
      || p?.document_url || p?.documentUrl
      || p?.article_url || p?.articleUrl || null;
}

// Ported verbatim from fetchGdeltGeoPositive()'s response-parse body.
function extractEvents(data, seenUrlLocs) {
  const features = Array.isArray(data?.features) ? data.features : [];
  const locationMap = new Map();
  for (const f of features) {
    const tone = f.properties?.urltone;
    if (typeof tone !== 'number' || tone <= TONE_THRESHOLD) continue;
    const name = String(f.properties?.name || '').substring(0, 200);
    if (!name) continue;
    if (name.startsWith('ERROR:') || name.includes('unknown error')) continue;
    const coords = f.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const [lon, lat] = coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    const key = `${lat.toFixed(1)}:${lon.toFixed(1)}`;
    // GKG v1 emits one feature per (article, location) pair; dedup on
    // (url, lat/lon bucket) so each (article × location) counts once across
    // all theme calls.
    const url = gkgFeatureUrl(f.properties);
    const dedupKey = url ? `${url}|${key}` : null;
    if (dedupKey && seenUrlLocs.has(dedupKey)) continue;
    if (dedupKey) seenUrlLocs.add(dedupKey);
    const existing = locationMap.get(key);
    if (existing) { existing.count++; }
    else { locationMap.set(key, { latitude: lat, longitude: lon, name, count: 1 }); }
  }
  const events = [];
  for (const [, loc] of locationMap) {
    if (loc.count < 3) continue;
    events.push({
      latitude: loc.latitude, longitude: loc.longitude, name: loc.name,
      category: classifyPositiveName(loc.name), count: loc.count, timestamp: Date.now(),
    });
  }
  return events;
}

// Mirrors seed-conflict-intel.mjs's launchCutoffAt/GDELT_SWEEP_BUDGET_MS
// pattern ("stop LAUNCHING once the deadline passes"), scaled down for 6
// sequential queries instead of a 20-country batched sweep.
// GDELT_RATE_WINDOW_MS's 5.5s-per-attempt floor alone is 33s for all 6
// even with instant, zero-retry responses, so this is real margin, not a
// formality.
//
// Found 2026-09-22: this deadline check only runs BEFORE starting a new
// query, so it doesn't bound a query that's already in flight when the
// deadline passes — a single query's own worst case under
// GDELT_THEME_FETCH_OPTS (one direct attempt + one proxy attempt, both
// rate-gated) is still ~35-40s. The original 50_000 here left only a 10s
// margin under Cloud Run's PLATFORM request timeout — not enough: a forced
// re-run genuinely hit that ceiling at ~62s wall-clock even though this
// function's own early-exit fired correctly and would have returned real
// data a couple seconds later. Fixed at the platform level too
// (scripts/generate-nitric-org-stack.mjs's cloudrun.timeout: 60 → 120), so
// this can now keep a real ~40s margin instead of a tight 10s one — same
// worst-case-single-query math, just against the corrected ceiling.
const FETCH_DEADLINE_MS = 80_000;

async function fetchPositiveEvents() {
  const allEvents = [];
  const seenNames = new Set();
  // Cross-call (article × location) dedup — same article tagged with multiple
  // themes would otherwise double-count its location buckets.
  const seenUrlLocs = new Set();
  let anyQuerySucceeded = false;
  const deadlineAt = Date.now() + FETCH_DEADLINE_MS;

  for (const query of QUERIES) {
    if (Date.now() >= deadlineAt) {
      console.warn(`  ${query}: skipped — fetch deadline reached, stopping the sweep early`);
      break;
    }
    let data;
    try {
      // fetchGdeltJson claims a cross-process rate slot (>=5.5s spacing) per
      // attempt and does the direct→proxy retry itself.
      data = await fetchGdeltJson(
        `https://api.gdeltproject.org/api/v1/gkg_geojson?QUERY=${encodeURIComponent(query)}&MAXROWS=500`,
        { label: `positive:${query}`, ...GDELT_THEME_FETCH_OPTS },
      );
    } catch (err) {
      console.warn(`  ${query}: ${err?.message || err}`);
      continue; // individual query failure is non-fatal
    }
    anyQuerySucceeded = true;
    for (const e of extractEvents(data, seenUrlLocs)) {
      if (!seenNames.has(e.name)) {
        seenNames.add(e.name);
        allEvents.push(e);
      }
    }
  }

  if (!anyQuerySucceeded) throw new Error('all GDELT theme queries failed');

  const capped = allEvents.slice(0, MAX_EVENTS);
  console.log(`  ${capped.length} positive events from ${QUERIES.length} theme queries`);
  return { events: capped, fetchedAt: Date.now() };
}

function validate(data) {
  return !!data && Array.isArray(data.events);
}

export function declareRecords(data) {
  return Array.isArray(data?.events) ? data.events.length : 0;
}

runSeed('positive-events', 'geo', CANONICAL_KEY, fetchPositiveEvents, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'positive-events',
  // The relay loop published unconditionally once ANY query succeeded, even a
  // zero-event result; keep that.
  zeroIsValid: true,

  // Bootstrap copy — same payload, same TTL, no separate seed-meta (mirrors the
  // loop's second envelopeWrite; both keys shared seed-meta:positive-events:geo).
  extraKeys: [{ key: BOOTSTRAP_KEY, transform: (d) => d, ttl: CACHE_TTL, declareRecords }],

  declareRecords,
  schemaVersion: 1,
  // 60min — matches api/health.js's SEED_META.positiveGeoEvents.maxStaleMin.
  maxStaleMin: 60,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
