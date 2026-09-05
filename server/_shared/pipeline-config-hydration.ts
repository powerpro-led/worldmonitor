/**
 * Worker-side `pipeline_config → process.env` hydration (OQ-P7,
 * PLATFORM_ARCHITECTURE.md Workstream 5).
 *
 * P3/P5 say an org admin edits the org's ~26 data-source keys live, in
 * Supabase, via the cloud admin panel (Workstream 6). But
 * `config-store.mjs`'s own header notes ~600 `process.env.<KEY>` reads
 * scattered across the compiled `api/`/`server/worldmonitor/**` route
 * bundles, none rewriteable to a config-accessor call — so the only
 * tractable way for a live edit to reach a running worker is the same trick
 * the LOCAL backend already uses (`vscode-extension/sidecar/config-store.mjs`'s
 * `loadConfigIntoEnv()`): periodically copy config rows into `process.env`
 * in place.
 *
 * This is the worker-side mirror of that function, with one simplification:
 * every `pipeline_config` row is "brokered" by definition (there is no
 * operator-supplied-`.env`-wins branch here — the worker's `.env` never
 * holds a live data-source key under this pivot, P2), so every row
 * unconditionally overwrites `process.env`. That's the whole point of
 * OQ-P7: a revoked/rotated key must not be shadowed by a stale value
 * forever.
 *
 * Reuses `getSupabaseAdmin()` (already pinned to the `worldmonitor` schema
 * per P15) rather than standing up a second Supabase-client bootstrap.
 */

import { getSupabaseAdmin } from './supabase-admin';

/** OQ-P7's contract, restated in the Workstream 6 admin-panel copy: "changes
 * apply within 5 minutes." */
export const HYDRATION_INTERVAL_MS = 5 * 60_000;

let _didWarnUnconfigured = false;

/**
 * Reads every row of `pipeline_config` and writes it into `env`. Fail-soft:
 * an unconfigured client or a query error is logged and swallowed, never
 * thrown — a transient Supabase outage must not crash the worker process or
 * block its own startup (same failure policy Workstream 1 chose for the
 * local backend's broker calls: stale-but-authorised beats a crash-looping
 * service).
 *
 * Returns the keys actually written (value changed or newly set), for
 * callers that want to log what changed.
 */
export async function hydratePipelineConfig(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    if (!_didWarnUnconfigured) {
      _didWarnUnconfigured = true;
      console.warn('[pipeline-config-hydration] Supabase service-role client unconfigured; skipping hydration');
    }
    return [];
  }

  const { data, error } = await supabase.from('pipeline_config').select('key, value');
  if (error) {
    console.error('[pipeline-config-hydration] failed to read pipeline_config:', error.message);
    return [];
  }

  const changed: string[] = [];
  for (const row of data ?? []) {
    if (typeof row.key !== 'string' || row.key.length === 0) continue;
    if (typeof row.value !== 'string') continue;
    if (env[row.key] === row.value) continue;
    env[row.key] = row.value;
    changed.push(row.key);
  }
  return changed;
}

/**
 * Awaits one immediate hydration, then re-hydrates every
 * `HYDRATION_INTERVAL_MS` for the lifetime of the process. Call once at
 * startup, before registering routes/schedules, in each long-lived runtime
 * that reads data-source keys from `process.env` (currently `gcp/api/main.ts`
 * and `gcp/scheduler/main.ts` — the scheduler's spawned children inherit the
 * hydrated `process.env` automatically, since `child_process.spawn` inherits
 * the parent's env when no explicit `env` option is passed). The initial
 * hydration is awaited, not fire-and-forget, so a fresh Cold Run cold start
 * never serves its first request/scheduled tick with unhydrated (missing)
 * data-source keys.
 *
 * Returns the interval handle so a caller (tests; a future graceful-shutdown
 * hook) can `clearInterval()` it — production callers can ignore the return
 * value, since a Cloud Run instance's process lifetime is the interval's own
 * natural bound.
 */
export async function startPipelineConfigHydration(env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.Timeout> {
  const initial = await hydratePipelineConfig(env);
  if (initial.length > 0) {
    console.log(`[pipeline-config-hydration] startup hydration set ${initial.length} key(s)`);
  }
  return setInterval(() => {
    void hydratePipelineConfig(env).then((changed) => {
      if (changed.length > 0) {
        console.log(`[pipeline-config-hydration] refresh set ${changed.length} key(s): ${changed.join(', ')}`);
      }
    });
  }, HYDRATION_INTERVAL_MS);
}

/** Test-only reset of the module-scope warn-once flag. */
export function __resetPipelineConfigHydrationForTests(): void {
  _didWarnUnconfigured = false;
}
