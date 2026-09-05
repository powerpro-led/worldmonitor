#!/usr/bin/env node
//
// seed-rpc-warmpings.mjs — keep a small set of read-through-cached RPC keys warm.
//
// WHY THIS EXISTS
// --------------
// Four RPC handlers own their own `seed-meta:*` freshness key and write it
// themselves on every LIVE upstream fetch — there is no seeder that produces
// their canonical Redis data. Left alone, the key expires and /api/health
// reports STALE_SEED until the next organic dashboard request happens to hit a
// cold handler. ais-relay.cjs carried four near-identical in-process
// `startBootSeedLoop` warm-ping loops for exactly this; they moved here as one
// script in P14 Phase 2 (see PLATFORM_ARCHITECTURE.md) since the per-org deploy
// is losing its pinned ais-relay instance.
//
// WHAT IT DOES
// -----------
// A plain HTTP GET to each RPC (the same warm path scripts/seed-news-digest.mjs
// and scripts/seed-insights.mjs already use). The handler runs, refreshes its
// canonical key + its own `seed-meta:*` on a fresh fetch, and returns — so this
// script writes NO Redis keys itself. `_wm_warm_ping` busts any CDN/edge cache
// so the request always reaches the origin handler.
//
// CONSOLIDATION NOTE
// -----------------
// The four ais-relay loops ran at 8 / 30 / 30 / 15 min. This runs all four on
// one cadence (see gcp/scheduler/main.ts, every 8 min — the tightest of the
// four, CII, whose live cache TTL is 10 min). Over-pinging the 30-min ones is
// harmless: each handler serves from its OWN internal cache and only re-fetches
// upstream when THAT expires, independent of ping frequency. If any of these
// RPCs is later found to have thin internal caching that turns an 8-min ping
// into 4× upstream load, split that one back into its own script + cadence.
//
// Railway service config (manual, mirrors the other nixpacks-root jobs):
//   - Service name: seed-rpc-warmpings
//   - startCommand: node seed-rpc-warmpings.mjs
//   - Cron schedule: "*/8 * * * *"
//   - Required env: APP_DOMAIN (or API_BASE_URL)
//   - Optional env: WORLDMONITOR_RELAY_KEY

import { loadEnvFile, CHROME_UA } from './_seed-utils.mjs';
import { resolveApiOrigin, resolveAppOrigin } from './_domain-config.mjs';

const PING_TIMEOUT_MS = 60_000;

// path — RPC route, relative to the API origin.
// label — log tag.
// count — best-effort record count from the JSON body, informational only.
export const WARM_PING_TARGETS = [
  {
    label: 'cii-risk-scores',
    path: '/api/intelligence/v1/get-risk-scores',
    count: (d) => d?.ciiScores?.length ?? 0,
  },
  {
    label: 'chokepoint-status',
    path: '/api/supply-chain/v1/get-chokepoint-status',
    count: (d) => d?.chokepoints?.length ?? 0,
  },
  {
    label: 'cable-health',
    path: '/api/infrastructure/v1/get-cable-health',
    count: (d) => (d?.cables ? Object.keys(d.cables).length : 0),
  },
  {
    label: 'temporal-anomalies',
    path: '/api/infrastructure/v1/list-temporal-anomalies',
    count: (d) => d?.anomalies?.length ?? 0,
  },
];

async function pingOne(apiBase, headers, target) {
  const url = `${apiBase}${target.path}?_wm_warm_ping=${Date.now()}`;
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    if (!resp.ok) {
      const keyNote = headers['X-WorldMonitor-Key'] ? '' : ' (WORLDMONITOR_RELAY_KEY not set — 401 expected)';
      console.warn(`  ${target.label}: HTTP ${resp.status}${keyNote}`);
      return false;
    }
    let n = null;
    try { n = target.count(await resp.json()); } catch { /* body not JSON — resp.ok is the success signal */ }
    console.log(`  ${target.label}: warmed${n == null ? '' : ` (${n})`}`);
    return true;
  } catch (err) {
    console.warn(`  ${target.label}: ${err?.message || err}`);
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

  console.log(`[seed-rpc-warmpings] warming ${WARM_PING_TARGETS.length} RPC(s) via ${apiBase}`);

  let ok = 0;
  for (const target of WARM_PING_TARGETS) {
    if (await pingOne(apiBase, headers, target)) ok += 1;
  }

  console.log(`[seed-rpc-warmpings] done — ${ok}/${WARM_PING_TARGETS.length} warmed`);
  if (ok === 0) {
    // Fleet convention for best-effort warm-ping seeders (see
    // seed-service-statuses.mjs / seed-military-maritime-news.mjs): a missed
    // ping loses no data (the RPC handlers own their Redis keys), so total
    // failure is surfaced via a grep-able WARN marker for log alerting, NOT a
    // non-zero exit that would wedge / page the scheduler.
    console.log('WARN: all warm-pings failed — RPC caches may go cold (check WORLDMONITOR_RELAY_KEY and gateway auth)');
  }
  return ok;
}

// True only when run directly as a cron entry — importing in a test loads no
// .env and fires no live run. Mirrors seed-news-digest.mjs.
const _isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (_isDirectRun) {
  loadEnvFile(import.meta.url);
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed-rpc-warmpings] fatal:', err?.stack || err);
      process.exit(0);
    });
}
