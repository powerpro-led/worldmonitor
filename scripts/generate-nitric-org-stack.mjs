#!/usr/bin/env node
// Generates `nitric.<org>.yaml` (a Nitric stack file — deploy-target config:
// provider, region, gcp-project-id, per-service resource overrides).
// Workstream 5 (PLATFORM_ARCHITECTURE.md).
//
// `nitric.gcp.yaml` (this repo's only stack file before this pivot) hardcoded
// `gcp-project-id: apps-453107` / `region: us-central1` — every org would
// deploy into the same GCP project without this step. `nitric select`s a
// stack by filename, and `.github/workflows/nitric-deploy.yml` already
// exposes a `stack-name` input, so the lever exists; this script is what
// feeds it a real per-org value instead of the single shared `gcp` stack.
//
// Run: node scripts/generate-nitric-org-stack.mjs --org=<org> --gcp-project=<id> --gcp-region=<region>
// Writes: nitric.<org>.yaml at the repo root (overwritten each run — treat
// generated stack files as build output, not something to hand-edit).
//
// PER_ORG_PROVISIONING_CONTRACT.md §9 step 5 (2026-09-10): used to read
// `deploy/orgs/<org>.yml` (a per-org config file this repo owned). That
// registry now lives in `org-provisioning/orgs/<org>.yml` instead — this
// repo never contains the org list (contract §1) — so `deploy-org.reusable.yml`
// passes the two values this script actually needs (`gcp.projectId` /
// `gcp.region` — nothing else in the old file was ever read by
// `buildOrgStack()`) straight through as `workflow_call` inputs → CLI flags.
// `--org=` is kept only to name the output file; it is no longer a lookup key.
//
// Deliberately NOT diffed/merged against nitric.gcp.yaml at runtime — every
// org's stack file is generated fresh from these flags, so a change to the
// shared `config.default` block below (e.g. a memory/timeout tuning) applies
// to every org the next time each org's stack is (re)generated, with no
// per-org drift to reconcile.

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');

/**
 * P14 Phase 2 tail (session 67): a per-org deploy now has ZERO pinned
 * instances. The AIS WebSocket relay — P14 Phase 1's one stopgap — is no
 * longer deployed per org: its persistent aisstream.io connection runs as
 * ONE shared deploy (deploy/shared/ais-ingest.yml + nitric.ais-shared.yaml +
 * .github/workflows/deploy-ais-shared.yml, min-instances: 1 there). Its 28
 * seed/warm-ping loops are all standalone crons (gcp/scheduler/main.ts
 * CADENCES); Telegram + the TransitSummary merge are per-org `--once` jobs
 * (P18 / P14 Phase 2 tail); the pure-AIS transit counts reach each org via
 * scripts/sync-ais-results.mjs (P17). Every per-org service scales to zero.
 */
const PINNED_SERVICES = Object.freeze({});

/**
 * biovita GCP cost incident follow-up (2026-09-23,
 * biovita_gcp_scheduler_cost_pause_2026_09_21.md): config.default's
 * cloudrun.timeout (120s, raised from 60s by the a1f053a fix above) is
 * enough for every genuinely fast cron, but two seed-bundle-macro sections
 * have a real documented worst case above that: seed-bis-lbs.mjs's own
 * comment ("Parallel-4 caps wall time at ~240s on the slow path") and
 * seed-fatf-listing.mjs's 6-tier fallback chain ("Worst-case ≤250s"). Both
 * now run as their own independent Cloud Scheduler entry (gcp/scheduler/
 * main.ts, one per macro section) rather than stacked sequentially inside
 * one request, so the remaining ceiling only needs to cover ONE section's
 * own worst case, not all 15 summed on an unlucky day — but that one
 * section's request still needs more than 120s. 360s covers both real
 * worst cases (240s/250s) with 100s+ margin, while capping the cost of a
 * future undiscovered hang at 6 minutes of billed time instead of blindly
 * matching the 600s/300s `timeoutMs` values declared in
 * scripts/seed-bundle-macro.mjs (which are themselves conservative
 * ceilings above the documented real worst case, not the real worst case
 * itself). Scoped to the `scheduler` service only (matches gcp/scheduler/
 * main.ts's `runtime: scheduler` in nitric.yaml) — api-main/mcp keep the
 * 120s default; every other cron hosted by this same service still returns
 * in seconds either way, so this doesn't change their cost.
 */
const SERVICE_CLOUDRUN_OVERRIDES = Object.freeze({
  scheduler: { cloudrun: { timeout: 360 } },
});

/** @param {{gcpProject: string, gcpRegion: string}} orgConfig */
export function buildOrgStack(orgConfig) {
  if (!orgConfig.gcpProject || !orgConfig.gcpRegion) {
    throw new Error('buildOrgStack() needs both gcpProject and gcpRegion.');
  }
  return {
    provider: 'nitric/gcp@1.27.6',
    region: orgConfig.gcpRegion,
    'gcp-project-id': orgConfig.gcpProject,
    apis: {
      api: { description: 'worldmonitor public REST API — ported api/*.ts Vercel Edge handlers' },
      mcp: { description: 'worldmonitor agent-facing MCP server (already shipped surface, isolated for its own scaling/timeout tuning)' },
    },
    config: {
      default: {
        cloudrun: {
          memory: 512,
          // Found 2026-09-22 (biovita GCP cost investigation, post-cpu-idle-
          // fix follow-up): seed-positive-events.mjs's own 50s internal
          // deadline (see that file) DOES fire correctly and return real
          // data instead of hanging forever, but a single already-in-flight
          // GDELT query can still push total wall-clock past this platform
          // ceiling — a forced re-run after the cpu-idle fix landed still
          // 504'd at exactly 60.0s (~62s actual). This 60 value was this
          // repo's own explicit choice, not a Nitric default (confirmed via
          // `gcloud run services describe`: it's what's actually deployed).
          // 120s (matching seed-conflict-intel.mjs's own GDELT_SWEEP_BUDGET_MS
          // precedent for "reasonable GDELT sweep budget") gives the internal
          // deadline real margin instead of needing every retry/timeout
          // constant across every GDELT-touching seeder re-tuned to fit
          // inside 60s. Applies to every per-org Cloud Run service via
          // config.default — trivially-fast jobs are unaffected in practice
          // (they still return in seconds either way); only genuinely
          // degraded ones now get more grace before Cloud Run kills them.
          timeout: 120,
          'min-instances': 0,
          'max-instances': 10,
          concurrency: 80,
        },
      },
      ...PINNED_SERVICES,
      ...SERVICE_CLOUDRUN_OVERRIDES,
    },
  };
}

function flag(name) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : undefined;
}

function main() {
  const org = flag('org');
  const gcpProject = flag('gcp-project');
  const gcpRegion = flag('gcp-region');
  if (!org || !gcpProject || !gcpRegion) {
    console.error(
      'Usage: node scripts/generate-nitric-org-stack.mjs --org=<org> --gcp-project=<id> --gcp-region=<region>',
    );
    process.exit(1);
  }
  const stack = buildOrgStack({ gcpProject, gcpRegion });
  const outPath = resolve(REPO_ROOT, `nitric.${org}.yaml`);
  const header =
    `# GENERATED — do not hand-edit. Produced by\n` +
    `# scripts/generate-nitric-org-stack.mjs --org=${org} --gcp-project=${gcpProject} --gcp-region=${gcpRegion}.\n` +
    `# Re-run that script after changing the org's gcp project/region (see\n` +
    `# org-provisioning/orgs/${org}.yml for those values); this file is\n` +
    `# overwritten on every deploy-org.reusable.yml run.\n\n`;
  writeFileSync(outPath, header + stringifyYaml(stack));
  console.log(`Wrote ${outPath}`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main();
}
