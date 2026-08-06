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
  'seed-forecasts': { kind: 'every', rate: '1 hours' }, // TTL_SECONDS=21600 "6h — 6x the 1h cron interval"
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
};

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
