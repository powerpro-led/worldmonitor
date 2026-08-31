/**
 * worldmonitor's Nitric scheduler entrypoint (Cloud Run, matched by
 * nitric.yaml's `services: - match: gcp/scheduler/main.ts`).
 *
 * Registers one Nitric `schedule()` per genuinely periodic entry in
 * scripts/railway-services.json's `deployMode: "nixpacks-*"` list (the 5
 * `dockerfile` entries are long-running processes, wired directly as their
 * own Cloud Run services in root nitric.yaml, not here). Driven off that JSON
 * file rather than hand-listing blocks, so this stays in sync with whatever
 * Railway's own registry says without a second source of truth.
 *
 * Each handler spawns the EXISTING script unchanged via child_process — not
 * an in-process import — because scripts/_seed-utils.mjs's `runSeed()` calls
 * `process.exit()` on completion, which would kill this entire long-lived
 * Cloud Run container if imported directly. This mirrors how Railway already
 * runs each one as its own process.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Cadences (2026-08-06): real per-script cadences, not the earlier
 * `DEFAULT_SCAFFOLD_RATE` placeholder. Sourced from, in priority order:
 *   1. An exact cron expression already documented in
 *      docs/railway-seed-consolidation-runbook.md (bundle services) or a
 *      script's own header docblock (e.g. seed-bundle-regional.mjs).
 *   2. A plain interval confirmed by the script's own code — most reliably
 *      the "`N`× the cron interval" TTL comments load-bearing seed scripts
 *      carry (e.g. seed-forecasts.mjs: "TTL 6h — 6x the 1h cron interval").
 *   3. The runbook's "inferred cadence" table (`seed-*` entries added after
 *      the 2026-04-10 snapshot) — the runbook itself flags these as
 *      TTL-inferred, not confirmed against live Railway config.
 * Two entries (marked below) have NO cron source anywhere in the repo —
 * flagged with an explicit comment rather than silently guessed, per this
 * file's existing discipline. Confirm both against the Railway dashboard
 * before a real deploy.
 * ─────────────────────────────────────────────────────────────────────────
 * Three nixpacks entries are NOT scheduled here despite matching
 * `deployMode: "nixpacks-*"` — discovered while doing this cadence pass, not
 * present in the original scaffold's assumption that all nixpacks entries
 * are one-off crons:
 *   - `process-simulation-tasks.mjs` / `process-deep-forecast-tasks.mjs` —
 *     both default to an infinite `for (;;) { ...; if (once) return; await
 *     sleep(POLL_INTERVAL_MS); }` loop (scripts/seed-forecasts.mjs
 *     `runSimulationWorker`/`runDeepForecastWorker`) unless invoked with
 *     `--once`. The runbook's own "Long-running services (4)" table lists
 *     `simulation-worker`/`deep-forecast-worker` as always-on Railway
 *     services, not crons — the registry's nixpacks/dockerfile split doesn't
 *     track long-running-vs-periodic the way this file originally assumed.
 *   - `scenario-worker.mjs` — its own header says so directly: "Railway
 *     config: cronSchedule: <none> (always-on long-running process)". It
 *     blocks on Redis `BLMOVE` waiting for queue items.
 *   Registering any of these three via `schedule().every()`/`.cron()` would
 *   spawn a child process that never exits, permanently hanging that
 *   invocation's handler (and, depending on Cloud Run concurrency, every
 *   invocation sharing the instance). See
 *   docs/architecture/nitric-gcp-scaffold.md's "Next steps" — these three
 *   need real long-running Cloud Run service wiring (new Dockerfiles), the
 *   same treatment as the existing 5 `dockerfile`-mode services, not a
 *   schedule.
 *
 * Scaffold-only pass — see docs/architecture/nitric-gcp-scaffold.md.
 */

import { schedule } from '@nitric/sdk';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

interface RailwayServiceEntry {
  entry: string;
  deployMode: string;
  service: string;
}

const railwayServices = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'scripts', 'railway-services.json'), 'utf8'),
) as RailwayServiceEntry[];

/**
 * The three always-on workers described above. Excluded from scheduling
 * entirely rather than given a (wrong) cadence.
 */
const ALWAYS_ON_NOT_SCHEDULED = new Set(['process-simulation-tasks', 'process-deep-forecast-tasks', 'scenario-worker']);

type Cadence = { kind: 'cron'; expr: string } | { kind: 'every'; rate: string };

/**
 * service name -> real cadence. Every `nixpacks-*` entry in
 * scripts/railway-services.json NOT in ALWAYS_ON_NOT_SCHEDULED must have an
 * entry here — enforced below at module load, not just by convention.
 */
const CADENCES: Record<string, Cadence> = {
  // ---- Bundle services: exact cron from docs/railway-seed-consolidation-runbook.md ----
  'seed-bundle-ecb-eu': { kind: 'cron', expr: '0 13 * * *' }, // daily 13:00 UTC (see runbook: avoids €STR's empty-window)
  'seed-bundle-portwatch': { kind: 'cron', expr: '0 */1 * * *' }, // hourly
  'seed-bundle-static-ref': { kind: 'cron', expr: '0 3 * * 0' }, // weekly, Sunday 03:00 UTC
  'seed-bundle-resilience': { kind: 'cron', expr: '0 */6 * * *' }, // every 6h
  'seed-bundle-resilience-energy-v2': { kind: 'cron', expr: '0 6 * * *' }, // daily 06:00 UTC
  'seed-bundle-derived-signals': { kind: 'cron', expr: '*/5 * * * *' }, // every 5min (Redis-only, fast)
  'seed-bundle-climate': { kind: 'cron', expr: '0 */3 * * *' }, // every 3h
  'seed-bundle-energy-sources': { kind: 'cron', expr: '30 7 * * *' }, // daily 07:30 UTC
  'seed-bundle-macro': { kind: 'cron', expr: '0 8 * * *' }, // daily 08:00 UTC
  'seed-bundle-health': { kind: 'cron', expr: '0 */1 * * *' }, // hourly
  'seed-bundle-market-backup': { kind: 'cron', expr: '*/5 * * * *' }, // every 5min (ais-relay backup)
  'seed-bundle-relay-backup': { kind: 'cron', expr: '*/30 * * * *' }, // every 30min (ais-relay backup)
  // seed-bundle-regional.mjs's own header docblock gives this cron directly.
  'seed-bundle-regional': { kind: 'cron', expr: '0 */6 * * *' }, // every 6h

  // ---- Confirmed via each script's own "Nx the cron interval" TTL comment ----
  'seed-forecasts': { kind: 'every', rate: '1 hours' },
  // Both of these were ORPHANED until 2026-08-20 (session 31): present in scripts/ but
  // absent from railway-services.json, so nothing ever ran them. Their Redis keys expired
  // and two dashboard panels rendered as broken. See TASKS.md item C.
  'seed-economy': { kind: 'every', rate: '1 hours' }, // STRESS_INDEX_TTL=21600 "6h — 6x the 1h cron interval"
  'seed-prediction-markets': { kind: 'every', rate: '30 minutes' }, // CACHE_TTL=10800 "3h — 6x the 30 min cron interval"
  // Same story, found 2026-08-21 while chasing the Trade Policy panel: both were
  // orphaned, so `trade:*` had ZERO keys. Cadences here are the ones each script's
  // own TTL comments are already written against — don't retune one without the other.
  'seed-supply-chain-trade': { kind: 'cron', expr: '0 */6 * * *' }, // TTLs are "8h — 2h buffer over 6h cron cadence"
  'seed-trade-flows': { kind: 'cron', expr: '0 4 * * *' }, // CACHE_TTL=259200 "72h = 3x daily interval"; off the 6h ticks // TTL_SECONDS=21600 "6h — 6x the 1h cron interval"
  'seed-insights': { kind: 'every', rate: '30 minutes' }, // CACHE_TTL=10800 "3h — 6x the 30 min cron interval"
  'seed-hs2-chokepoint-exposure': { kind: 'every', rate: '1 days' }, // TTL_SECONDS=172800 "48h — 2x daily cron interval"
  'seed-comtrade-bilateral-hs4': { kind: 'every', rate: '30 days' }, // own code comment: "new monthly Railway cron"

  // ---- Explicit docblock cadence ----
  'seed-forecast-resolutions': { kind: 'every', rate: '1 days' }, // header: "Cron: daily"
  'seed-military-cii': { kind: 'every', rate: '10 minutes' }, // header: "Run cadence ~10 min"

  // ---- runbook's "Standalone seed crons added after this snapshot" table — ----
  // ---- TTL-inferred, runbook itself says confirm against live Railway config ----
  'seed-aaii-sentiment': { kind: 'every', rate: '7 days' }, // weekly (7d TTL)
  'seed-market-quotes': { kind: 'every', rate: '30 minutes' }, // ~30min (30m TTL)
  'seed-commodity-quotes': { kind: 'every', rate: '30 minutes' }, // ~30min (30m TTL)
  'seed-crypto-sectors': { kind: 'every', rate: '1 hours' }, // hourly (1h TTL)
  'seed-market-breadth': { kind: 'every', rate: '1 days' }, // daily (30d history window)
  'seed-weather-alerts': { kind: 'every', rate: '15 minutes' }, // ~15min (15m TTL)
  'seed-fx-yoy': { kind: 'every', rate: '1 days' }, // daily (25h TTL)

  // ---- UNCONFIRMED — no cron source found anywhere in the repo. Flagged, ----
  // ---- not guessed. Confirm against the live Railway dashboard before deploy. ----
  // runbook: "Monthly recovery cadence; use the active Railway schedule for
  // the existing service" — no exact day/time given anywhere.
  'seed-bundle-resilience-recovery': { kind: 'every', rate: '30 days' },
  // runbook only says "frequent (relay-fallback)"; the script itself
  // (scripts/seed-service-statuses.mjs) carries no TTL/interval constant.
  'seed-service-statuses': { kind: 'every', rate: '15 minutes' },

  // ──────────────────────────────────────────────────────────────────────
  // 2026-08-21 (session 32) — ORPHANED-SEEDER SWEEP.
  //
  // 30 scripts existed in scripts/ but appeared in NO registry, bundle, npm
  // script, scheduler entry, or GitHub workflow, so nothing had ever run
  // them. /api/health was reporting 43 EMPTY + 13 STALE_SEED checks and the
  // two lists corresponded almost one-to-one (earthquakes ↔ seed-earthquakes,
  // cyberThreats ↔ seed-cyber-threats, and so on). This is the same failure
  // class as session 31's four orphans, found by widening the search from
  // "scripts carrying a `Service name:` header" to ALL scripts/seed-*.mjs —
  // the follow-up TASKS.md had already flagged as highest-value.
  //
  // Cadence sources, in the priority order this file's header mandates:
  //   1. the script's own "Nx the cron interval" TTL comment (most entries)
  //   2. the health check's declared maxStaleMin, where no TTL comment exists
  //   3. explicitly flagged UNCONFIRMED below where neither exists
  //
  // THREE orphans were deliberately NOT registered — see ORPHANS_NOT_SCHEDULED.
  // ──────────────────────────────────────────────────────────────────────
  'seed-aviation': { kind: 'every', rate: '30 minutes' }, // TTL=10800 "3h — survives ~5 consecutive missed 30min cron ticks"
  'seed-bigmac': { kind: 'every', rate: '7 days' }, // TTL=864000 "10 days — weekly seed with 3-day cron-drift buffer"
  'seed-bundle-imf-extended': { kind: 'every', rate: '30 days' }, // header: "same monthly cadence as seed-imf-macro"; each sub-seeder intervalMs=30*DAY
  'seed-conflict-intel': { kind: 'every', rate: '30 minutes' }, // own comment: "this seeder's 30min cron cadence"
  'seed-cot': { kind: 'every', rate: '7 days' }, // COT_TTL=604800 (7d); "CFTC releases COT every Friday"
  'seed-cyber-threats': { kind: 'cron', expr: '0 */2 * * *' }, // TTL=10800 "3h — survives 1 missed 2h cron cycle"
  'seed-earnings-calendar': { kind: 'cron', expr: '0 */12 * * *' }, // TTL=129600 "36h — 3× a 12h cron interval"
  'seed-earthquakes': { kind: 'every', rate: '1 hours' }, // TTL=21600 "6h — 6x the 1h cron interval"
  'seed-economic-calendar': { kind: 'cron', expr: '0 */12 * * *' }, // TTL=129600 "36h — 3× a 12h cron interval"
  'seed-electricity-prices': { kind: 'every', rate: '1 days' }, // ELECTRICITY_TTL_SECONDS=3d = 3× daily; health maxStaleMin=2880 (48h)
  'seed-ember-electricity': { kind: 'every', rate: '1 days' }, // TTL_SECONDS=259200 "72h = 3× daily cron interval"
  'seed-energy-intelligence': { kind: 'cron', expr: '0 */6 * * *' }, // TTL_SECONDS=86400 "24h = 4× 6h interval"
  // ais-relay.cjs:11659 documents this one's cron exactly — a better source than
  // the TTL inference: "Energy spine seed — standalone Railway cron (0 6 * * *)".
  'seed-energy-spine': { kind: 'cron', expr: '0 6 * * *' },
  'seed-fear-greed': { kind: 'cron', expr: '0 */6 * * *' }, // TTL=64800 "18h = 3x 6h interval"
  // No TTL comment in the script. Cadence from health's own maxStaleMin=360
  // (6h) for `wildfires`/`wildfiresBootstrap`, with the 3× buffer this file
  // treats as the gold standard.
  'seed-fire-detections': { kind: 'cron', expr: '0 */2 * * *' },
  'seed-forecast-bets': { kind: 'every', rate: '1 days' }, // header: "mirrors the seed-forecast-resolutions service" (registered daily above)
  'seed-fuel-prices': { kind: 'every', rate: '7 days' }, // TTL=864000 "10 days — weekly seed with 3-day cron-drift buffer"
  'seed-fx-rates': { kind: 'every', rate: '1 days' }, // TTL=25*3600 "25 hours — covers daily cron with 1h drift buffer"
  'seed-grocery-basket': { kind: 'every', rate: '7 days' }, // TTL=864000 "10 days — weekly seed with 3-day cron-drift buffer"
  'seed-hormuz': { kind: 'cron', expr: '0 6 * * *' }, // header: "Cron: every 24 hours (0 6 * * *)"
  'seed-military-flights': { kind: 'every', rate: '10 minutes' }, // LIVE_TTL=600 (10min); health maxStaleMin=30
  // UNCONFIRMED — warm-ping seeder with no TTL constant and no health entry
  // naming a staleness bound. 6h is a deliberate conservative placeholder for
  // a USNI-fleet/NGA-warnings scrape, flagged rather than presented as sourced.
  'seed-military-maritime-news': { kind: 'cron', expr: '0 */6 * * *' },
  // CACHE_TTL=7200 is the READ cache, not the write cadence. Health declares
  // maxStaleMin=30 for `radiationWatch`, so the seeder must run inside 30min.
  'seed-radiation-watch': { kind: 'every', rate: '15 minutes' },
  'seed-research': { kind: 'every', rate: '1 hours' }, // own comment: "the ~hourly cron"
  'seed-sanctions-pressure': { kind: 'cron', expr: '0 */12 * * *' }, // TTL=15h "3h buffer over 12h cron cadence"
  'seed-security-advisories': { kind: 'every', rate: '1 hours' }, // TTL=10800 "180min — 2h buffer over 1h cron cadence"
  'seed-thermal-escalation': { kind: 'cron', expr: '0 */3 * * *' }, // own comment: "cron is `0 */3 * * *` — every THREE hours, not two"
  'seed-unrest-events': { kind: 'every', rate: '45 minutes' }, // TTL=16200 "4.5h — 6x the 45 min cron interval"
  // ──────────────────────────────────────────────────────────────────────
  // 2026-08-22 (session 35) — found never registered by session 32's own
  // sweep: globalTendersCanadaBuys/globalTendersContractsFinder showed
  // SEED_ERROR because seed-global-tenders.mjs was absent from BOTH the old
  // Railway registry and this file — nothing had ever invoked it. TTL source:
  // own comment "CACHE_TTL_SECONDS = 10_800; // 3h, safely beyond the hourly
  // Railway cadence" — confirms the intended cadence was hourly.
  // ──────────────────────────────────────────────────────────────────────
  'seed-global-tenders': { kind: 'every', rate: '1 hours' },
  // ──────────────────────────────────────────────────────────────────────
  // 2026-08-31 (session 40) — scripts/fetch-gpsjam.mjs was scheduled
  // NOWHERE (not here, not in nitric.yaml, not in any GitHub workflow),
  // so any Redis reset wiped `intelligence:gpsjam:v2` and nothing
  // repopulated it until someone ran the script by hand — /api/gpsjam
  // 503'd in the meantime. Diagnosed originally at the twenty-ninth-session
  // TASKS.md entry, re-hit session 40. Cadence source: the script's own
  // header ("Cadence: daily") backed by REDIS_TTL=172800 ("48h" = 2× a
  // daily run) — same TTL/reasoning as seed-hs2-chokepoint-exposure above.
  // Registered by service name `fetch-gpsjam` (the script is fetch-*, not
  // seed-*; scripts/audit-railway-watch-paths.mjs already whitelists that
  // exact basename as a seed-command shape).
  // ──────────────────────────────────────────────────────────────────────
  'fetch-gpsjam': { kind: 'every', rate: '1 days' },
};

/**
 * Orphaned scripts found by the session-32 sweep that are deliberately NOT
 * scheduled. Recorded here so the next sweep does not "rediscover" them and
 * register them by mistake — the reason is in each script's own header.
 *
 *   seed-recall-benchmark  — runs in .github/workflows/feed-validation.yml;
 *                            its header says so: "no Railway slot".
 *   seed-consumer-prices   — header: "IMPORTANT: This is a MANUAL FALLBACK
 *                            script only. Do NOT configure as a Railway cron."
 *                            consumer-prices-core's publish.ts is the writer.
 *   seed-iran-events       — header: "Iran-events domain sunset (war ended
 *                            2026-07). Default OFF" + manually re-seeded.
 *   seed-webcams           — health alarm removed by operator decision
 *                            (session 26); also needs WINDY_API_KEY, unset.
 *   seed-chokepoint-flows  — NOT an orphan: scripts/ais-relay.cjs:6566 spawns it
 *                            via execFile. Caught only after registering it — a
 *                            name match in a long-running service's source is
 *                            ambiguous between a comment and a real invocation,
 *                            and ais-relay.cjs contains BOTH shapes (its :11656
 *                            block names seed-aviation / seed-energy-spine /
 *                            seed-cyber-threats only to say a standalone cron
 *                            owns them, which is why those three ARE registered).
 */
const ORPHANS_NOT_SCHEDULED = ['seed-recall-benchmark', 'seed-consumer-prices', 'seed-iran-events', 'seed-webcams', 'seed-chokepoint-flows'] as const;
void ORPHANS_NOT_SCHEDULED;

function runScriptOnce(entryRelativePath: string): () => Promise<void> {
  return () =>
    new Promise<void>((resolve, reject) => {
      const child = spawn('node', [entryRelativePath], { cwd: REPO_ROOT, stdio: 'inherit' });
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${entryRelativePath} exited with code ${code}`));
      });
      child.on('error', reject);
    });
}

const nixpacksEntries = railwayServices.filter((svc) => svc.deployMode.startsWith('nixpacks'));

for (const svc of nixpacksEntries) {
  if (ALWAYS_ON_NOT_SCHEDULED.has(svc.service)) continue;

  const cadence = CADENCES[svc.service];
  if (!cadence) {
    // A new nixpacks-* entry landed in railway-services.json since this file
    // was last updated. Fail loudly at deploy/build time rather than falling
    // back to a silent guessed rate for a script nobody's looked at yet.
    throw new Error(
      `gcp/scheduler/main.ts: no cadence registered for railway service "${svc.service}" ` +
        `(${svc.entry}). Add it to CADENCES or ALWAYS_ON_NOT_SCHEDULED before deploying.`,
    );
  }

  const run = runScriptOnce(svc.entry);
  const handler = async () => {
    await run();
  };

  if (cadence.kind === 'cron') {
    schedule(svc.service).cron(cadence.expr, handler);
  } else {
    schedule(svc.service).every(cadence.rate, handler);
  }
}
