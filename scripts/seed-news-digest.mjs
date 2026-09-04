#!/usr/bin/env node
//
// seed-news-digest.mjs — keep the regional-news digest key family warm.
//
// WHY THIS EXISTS
// --------------
// server/worldmonitor/news/v1/list-feed-digest.ts is the one RPC in the
// pipeline with NO seeder: it read-through-caches a live ~190-feed RSS crawl
// under `news:digest:v1:<variant>:<lang>` (TTL 900s, set by the RPC's own
// cachedFetchJson call). On a cold or expired key the first dashboard request
// eats the crawl latency and every regional-news panel renders "unavailable"
// until a background rebuild lands — data only shows on a second open.
//
// Under the platform pivot (PLATFORM_ARCHITECTURE.md P2) the operator local
// backend does ZERO fetching — it is a read-only Upstash mirror. So this key
// family has to be produced server-side, on a schedule, and mirrored to
// operators like every other seeded domain. `classifyKey('news:digest:v1:*')`
// already returns 'mirror' (scripts/shared/sync-domains.mjs), so no Workstream
// 4 change is needed — this seeder is the missing producer.
//
// WHAT IT DOES
// -----------
// It does NOT re-implement the crawl. scripts/ cannot import from server/ under
// the nixpacks `rootDirectory: scripts` packaging (tests/nixpacks-seeder-
// import-graph.test.mjs enforces this), and buildDigest() is not exported
// anyway. Instead it HTTP-pings the worker's own `/api/news/v1/list-feed-digest`
// for each (variant, lang) pair — the same warm path scripts/seed-insights.mjs
// (warmDigestCache) and scripts/ais-relay.cjs already use. The RPC runs
// buildDigest(), writes `news:digest:v1:<variant>:<lang>` via setCachedJson()
// (which also fires the fast-path mirror notify), and stamps a fresh
// `generatedAt` — which is what the regional-news panels read for their
// freshness badge, so no seed-meta:* write is needed here.
//
// CADENCE
// -------
// gcp/scheduler/main.ts registers this at `*/10 * * * *` (every 10 min). That
// MUST stay below list-feed-digest.ts's 900s (15 min) `news:digest:v1` cache
// TTL so the key never expires between runs — a longer interval reintroduces
// exactly the cold-hole bug this seeder removes (which is what today's
// seed-insights side-effect suffers from at its 30-min cadence).
//
// Railway service config (manual, mirrors the other nixpacks-root-scripts jobs):
//   - Service name: seed-news-digest
//   - Builder: NIXPACKS ; rootDirectory: scripts
//   - startCommand: node seed-news-digest.mjs
//   - Cron schedule: "*/10 * * * *"
//   - Required env: APP_DOMAIN (or API_BASE_URL)
//   - Optional env: WORLDMONITOR_RELAY_KEY, NEWS_DIGEST_SEED_VARIANTS,
//                   NEWS_DIGEST_SEED_LANGS

import { loadEnvFile, CHROME_UA } from './_seed-utils.mjs';
import { resolveApiOrigin, resolveAppOrigin } from './_domain-config.mjs';

// Per-pair ceiling. list-feed-digest.ts responds within its own
// DIGEST_RESPONSE_TIMEOUT_MS (default 14s) even on a cold build — buildDigest's
// internal OVERALL_DEADLINE_MS (~10s) fires first and it returns whatever it
// gathered. 30s is generous headroom over that; a ping that actually exceeds
// it counts as a failure for this run.
const PING_TIMEOUT_MS = 30_000;

const DEFAULT_VARIANTS = 'full';
const DEFAULT_LANGS = 'en,zh';

/**
 * Parse a comma/space-separated env list into a deduped, trimmed, non-empty
 * array. `fallback` is used verbatim when the env var is unset or parses empty.
 */
export function parseList(raw, fallback) {
  const source = (raw ?? '').trim() ? raw : fallback;
  const out = [];
  for (const token of String(source).split(/[,\s]+/)) {
    const t = token.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Cartesian product of variants × langs, ordered so every `en` pair comes
 * first. `en` first matters: the English (no-lang) feeds dominate every
 * variant's feed list, and list-feed-digest.ts caches each fetched feed under
 * `rss:feed:v8:<variant>:<url>` for an hour — so warming `en` first lets the
 * `zh` (and any other lang) run reuse those per-feed caches instead of
 * re-fetching ~190 feeds. Mirrors the ordering the old sidecar warm-ping used.
 */
export function buildPairs(variants, langs) {
  const pairs = [];
  for (const variant of variants) {
    for (const lang of langs) pairs.push({ variant, lang });
  }
  return pairs.sort((a, b) => Number(b.lang === 'en') - Number(a.lang === 'en'));
}

/** The digest RPC URL for one (variant, lang) pair. */
export function digestUrl(apiBase, variant, lang) {
  return `${apiBase}/api/news/v1/list-feed-digest?variant=${encodeURIComponent(variant)}&lang=${encodeURIComponent(lang)}`;
}

async function pingOne(apiBase, headers, { variant, lang }) {
  const url = digestUrl(apiBase, variant, lang);
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    if (!resp.ok) {
      const keyNote = headers['X-WorldMonitor-Key'] ? '' : ' (WORLDMONITOR_RELAY_KEY not set — Origin-only auth)';
      console.warn(`  ${variant}/${lang}: HTTP ${resp.status}${keyNote}`);
      return false;
    }
    // Informational only — an empty window is not a seeder failure, and the
    // RPC caches a short negative sentinel (120s) so the next run retries.
    let catCount = null;
    try {
      const body = await resp.json();
      catCount = body && body.categories ? Object.keys(body.categories).length : 0;
    } catch { /* body not JSON / truncated — resp.ok is the success signal */ }
    console.log(`  ${variant}/${lang}: warmed${catCount == null ? '' : ` (${catCount} categories)`}`);
    return true;
  } catch (err) {
    console.warn(`  ${variant}/${lang}: ${err?.message || err}`);
    return false;
  }
}

export async function run() {
  const apiBase = process.env.API_BASE_URL || resolveApiOrigin(process.env.APP_DOMAIN);
  const headers = {
    'User-Agent': CHROME_UA,
    Origin: resolveAppOrigin(process.env.APP_DOMAIN),
  };
  if (process.env.WORLDMONITOR_RELAY_KEY) headers['X-WorldMonitor-Key'] = process.env.WORLDMONITOR_RELAY_KEY;

  const variants = parseList(process.env.NEWS_DIGEST_SEED_VARIANTS, DEFAULT_VARIANTS);
  const langs = parseList(process.env.NEWS_DIGEST_SEED_LANGS, DEFAULT_LANGS);
  const pairs = buildPairs(variants, langs);

  console.log(`[seed-news-digest] warming ${pairs.length} digest key(s) via ${apiBase}`);

  let ok = 0;
  // Sequential, en-first — see buildPairs. Concurrency here would only race the
  // per-feed rss:feed:v8:* cache writes and re-fetch feeds N times.
  for (const pair of pairs) {
    if (await pingOne(apiBase, headers, pair)) ok += 1;
  }

  console.log(`[seed-news-digest] done — ${ok}/${pairs.length} warmed`);
  // Exit non-zero only when EVERY ping failed — that is a real outage worth
  // surfacing to the scheduler's alerting. A partial failure is self-healing
  // on the next tick and must not wedge the cron.
  return ok > 0 || pairs.length === 0 ? 0 : 1;
}

// True only when run directly as a cron entry — so importing the module in a
// test doesn't load .env or fire a live run. Mirrors seed-insights.mjs.
const _isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (_isDirectRun) {
  loadEnvFile(import.meta.url);
  run()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[seed-news-digest] fatal:', err?.stack || err);
      process.exit(1);
    });
}
