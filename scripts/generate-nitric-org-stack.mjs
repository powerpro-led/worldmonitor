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
          timeout: 60,
          'min-instances': 0,
          'max-instances': 10,
          concurrency: 80,
        },
      },
      ...PINNED_SERVICES,
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
