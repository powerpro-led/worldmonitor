#!/usr/bin/env node
// Generates `nitric.<org>.yaml` (a Nitric stack file — deploy-target config:
// provider, region, gcp-project-id, per-service resource overrides) from
// `deploy/orgs/<org>.yml` (the non-secret per-org config, see
// deploy/orgs/README.md). Workstream 5 (PLATFORM_ARCHITECTURE.md).
//
// `nitric.gcp.yaml` (this repo's only stack file before this pivot) hardcoded
// `gcp-project-id: apps-453107` / `region: us-central1` — every org would
// deploy into the same GCP project without this step. `nitric select`s a
// stack by filename, and `.github/workflows/nitric-deploy.yml` already
// exposes a `stack-name` input, so the lever exists; this script is what
// feeds it a real per-org value instead of the single shared `gcp` stack.
//
// Run: node scripts/generate-nitric-org-stack.mjs --org=<org>
// Writes: nitric.<org>.yaml at the repo root (overwritten each run — treat
// generated stack files as build output, not something to hand-edit).
//
// Deliberately NOT diffed/merged against nitric.gcp.yaml at runtime — every
// org's stack file is generated fresh from its deploy/orgs/<org>.yml, so a
// change to the shared `config.default` block below (e.g. a memory/timeout
// tuning) applies to every org the next time each org's stack is
// (re)generated, with no per-org drift to reconcile.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');

/**
 * P14 Phase 1's one pinned stopgap: the AIS WebSocket relay is the sole
 * long-running Cloud Run service left per org (everything else P14 moves to
 * `min-instances: 0` + Cloud Scheduler — see gcp/scheduler/main.ts). A
 * scale-to-zero AIS relay would drop its persistent aisstream.io connection
 * between requests, which is the exact failure OQ-P1/P8 exists to avoid.
 */
const PINNED_SERVICES = Object.freeze({
  'ais-relay': { cloudrun: { 'min-instances': 1 } },
});

/** @param {string} org */
function loadOrgConfig(org) {
  const orgPath = resolve(REPO_ROOT, 'deploy', 'orgs', `${org}.yml`);
  let raw;
  try {
    raw = readFileSync(orgPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`No deploy/orgs/${org}.yml found. Create it first — see deploy/orgs/README.md.`);
    }
    throw err;
  }
  const config = parseYaml(raw);
  for (const field of ['org', 'domain', 'supabase', 'gcp', 'variant']) {
    if (config[field] == null) {
      throw new Error(`deploy/orgs/${org}.yml is missing required field "${field}".`);
    }
  }
  if (config.org !== org) {
    throw new Error(`deploy/orgs/${org}.yml's "org" field ("${config.org}") does not match the filename ("${org}").`);
  }
  if (!config.gcp.projectId || !config.gcp.region) {
    throw new Error(`deploy/orgs/${org}.yml's "gcp" block needs both "projectId" and "region".`);
  }
  return config;
}

/** @param {ReturnType<typeof loadOrgConfig>} orgConfig */
export function buildOrgStack(orgConfig) {
  return {
    provider: 'nitric/gcp@1.27.6',
    region: orgConfig.gcp.region,
    'gcp-project-id': orgConfig.gcp.projectId,
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

function main() {
  const orgArg = process.argv.find((a) => a.startsWith('--org='));
  if (!orgArg) {
    console.error('Usage: node scripts/generate-nitric-org-stack.mjs --org=<org>');
    process.exit(1);
  }
  const org = orgArg.slice('--org='.length);
  const orgConfig = loadOrgConfig(org);
  const stack = buildOrgStack(orgConfig);
  const outPath = resolve(REPO_ROOT, `nitric.${org}.yaml`);
  const header =
    `# GENERATED — do not hand-edit. Produced by\n` +
    `# scripts/generate-nitric-org-stack.mjs from deploy/orgs/${org}.yml.\n` +
    `# Re-run that script after changing the org config; this file is\n` +
    `# overwritten on every deploy-org.yml run.\n\n`;
  writeFileSync(outPath, header + stringifyYaml(stack));
  console.log(`Wrote ${outPath}`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main();
}
