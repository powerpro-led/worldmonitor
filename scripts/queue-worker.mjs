#!/usr/bin/env node
//
// queue-worker.mjs — one scheduled `--once` tick of all three forecast/
// scenario queue consumers (P14 Phase 1, PLATFORM_ARCHITECTURE.md
// Workstream 5).
//
// WHY THIS EXISTS
// ----------------
// Under Railway, `process-simulation-tasks.mjs`, `process-deep-forecast-
// tasks.mjs`, and `scenario-worker.mjs` were three separate always-on
// services, each blocking on its own poll/BLMOVE loop. Under P14's "no
// pinned instances per org" decision, none of the three needs to be
// always-on: all three are already async pending→poll flows (a queue
// latency of ~1-2 minutes is fine), so gcp/scheduler/main.ts can drive them
// on a Cloud Scheduler cadence instead of three permanently-billed Cloud Run
// services.
//
// This script is the merge point. It does NOT re-implement any of the three
// workers — it imports each one's already-`{ once }`-capable entry point and
// calls it exactly once per invocation:
//   - runSimulationWorker({ once: true })   — from seed-forecasts.mjs
//   - runDeepForecastWorker({ once: true }) — from seed-forecasts.mjs
//   - runWorker({ once: true })             — from scenario-worker.mjs
//     (scenario-worker.mjs previously had NO `{ once }` support at all —
//     added alongside this script, see its own `runOneIteration()` /
//     `runWorker()` for the extraction)
//
// Deliberately bypasses the process-simulation-tasks.mjs / process-deep-
// forecast-tasks.mjs WRAPPER scripts — both execute their worker at module
// top level and call `process.exit(1)` on error, which would kill this
// merged process before the other two workers ever ran. Importing the real
// worker functions directly from seed-forecasts.mjs avoids that entirely.
//
// FAILURE POLICY
// ---------------
// Same partial-failure tolerance as seed-news-digest.mjs (W7): the three
// workers run concurrently via Promise.allSettled so one throwing does not
// prevent the other two from getting their tick, and the exit code is
// non-zero only when ALL THREE failed — a real outage worth surfacing to
// the scheduler, not a transient blip that self-heals next tick (~1 min
// later, per gcp/scheduler/main.ts's registration).
//
// Railway service config: NOT a Railway service — GCP/Nitric-only
// (gcp/scheduler/main.ts registers this directly; scripts/railway-services.json
// is untouched, since Railway is still the live deploy for the pre-pivot
// single-tenant fork and keeps running the three original always-on
// services unchanged).

import { loadEnvFile } from './_seed-utils.mjs';
import { runSimulationWorker, runDeepForecastWorker } from './seed-forecasts.mjs';
import { runWorker as runScenarioWorker } from './scenario-worker.mjs';

const WORKERS = [
  { name: 'simulation', run: () => runSimulationWorker({ once: true }) },
  { name: 'deep-forecast', run: () => runDeepForecastWorker({ once: true }) },
  { name: 'scenario', run: () => runScenarioWorker({ once: true }) },
];

/**
 * @param {typeof WORKERS} workers Injectable for tests — defaults to the
 * real three queue consumers. Never pass a stub in production.
 */
export async function run(workers = WORKERS) {
  console.log(`[queue-worker] starting one-shot tick across ${workers.length} queue consumer(s)`);

  const outcomes = await Promise.allSettled(workers.map((w) => w.run()));

  let ok = 0;
  outcomes.forEach((outcome, i) => {
    const { name } = workers[i];
    if (outcome.status === 'fulfilled') {
      ok += 1;
      const status = outcome.value?.status || 'done';
      console.log(`[queue-worker] ${name}: ${status}`);
    } else {
      console.error(`[queue-worker] ${name} failed:`, outcome.reason?.message || outcome.reason);
    }
  });

  console.log(`[queue-worker] done — ${ok}/${WORKERS.length} succeeded`);
  // Exit non-zero only when EVERY consumer failed — a partial failure
  // self-heals on the next ~1-minute tick and must not wedge the scheduler.
  return ok > 0 ? 0 : 1;
}

// True only when run directly (the scheduler's spawn() invocation) — so
// importing this module (e.g. from a test) never fires a live run. Mirrors
// seed-news-digest.mjs's _isDirectRun gate.
const _isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (_isDirectRun) {
  loadEnvFile(import.meta.url);
  run()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[queue-worker] fatal:', err?.stack || err);
      process.exit(1);
    });
}
