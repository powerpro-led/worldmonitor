import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { buildOrgStack } from '../scripts/generate-nitric-org-stack.mjs';

// Workstream 5 (PLATFORM_ARCHITECTURE.md): scripts/generate-nitric-org-stack.mjs
// templates a per-org Nitric stack file (region + gcp-project-id) from
// deploy/orgs/<org>.yml. This is pure config generation — no live infra, no
// network — so it's fully testable here without deno/GH Environments/a real
// GCP project.

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');
const SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/generate-nitric-org-stack.mjs');
const ORGS_DIR = resolve(REPO_ROOT, 'deploy', 'orgs');

describe('buildOrgStack()', () => {
  it('templates gcp-project-id and region from the org config', () => {
    const stack = buildOrgStack({
      org: 'acme',
      domain: 'acme.example.com',
      supabase: { projectRef: 'abcdefghijklmnop' },
      gcp: { projectId: 'acme-gcp-project', region: 'europe-west1' },
      variant: 'full',
    });
    assert.equal(stack['gcp-project-id'], 'acme-gcp-project');
    assert.equal(stack.region, 'europe-west1');
    assert.equal(stack.provider, 'nitric/gcp@1.27.6');
  });

  it('scales everything to zero except the pinned ais-relay stopgap (P14 Phase 1)', () => {
    const stack = buildOrgStack({
      org: 'acme',
      domain: 'acme.example.com',
      supabase: { projectRef: 'abcdefghijklmnop' },
      gcp: { projectId: 'acme-gcp-project', region: 'us-central1' },
      variant: 'full',
    });
    assert.equal(stack.config.default.cloudrun['min-instances'], 0);
    assert.equal(stack.config['ais-relay'].cloudrun['min-instances'], 1);
    // Nothing else gets a pinned override — P14's whole point is zero
    // pinned instances per org beyond the one stopgap.
    const serviceOverrideKeys = Object.keys(stack.config).filter((k) => k !== 'default');
    assert.deepEqual(serviceOverrideKeys, ['ais-relay']);
  });
});

describe('generate-nitric-org-stack.mjs CLI (against the real mosiq fixture)', () => {
  it('writes nitric.<org>.yaml matching deploy/orgs/mosiq.yml', () => {
    assert.ok(existsSync(resolve(ORGS_DIR, 'mosiq.yml')), 'deploy/orgs/mosiq.yml must exist for this fixture test');

    const outPath = resolve(REPO_ROOT, 'nitric.mosiq.yaml');
    try {
      execFileSync(process.execPath, [SCRIPT_PATH, '--org=mosiq'], { cwd: REPO_ROOT });
      assert.ok(existsSync(outPath));
      const written = parseYaml(readFileSync(outPath, 'utf8'));
      assert.equal(written['gcp-project-id'], 'apps-453107-mosiq');
      assert.equal(written.region, 'us-central1');
      assert.equal(written.config['ais-relay'].cloudrun['min-instances'], 1);
    } finally {
      rmSync(outPath, { force: true });
    }
  });

  it('fails loudly on a missing org config rather than silently deploying into a default project', () => {
    assert.throws(() => {
      execFileSync(process.execPath, [SCRIPT_PATH, '--org=does-not-exist'], { cwd: REPO_ROOT, stdio: 'pipe' });
    });
  });

  it('fails when the org file is missing required fields', () => {
    const tmpOrg = 'test-fixture-incomplete';
    const tmpPath = resolve(ORGS_DIR, `${tmpOrg}.yml`);
    mkdirSync(ORGS_DIR, { recursive: true });
    writeFileSync(tmpPath, `org: ${tmpOrg}\ndomain: test.example.com\n`);
    try {
      assert.throws(() => {
        execFileSync(process.execPath, [SCRIPT_PATH, `--org=${tmpOrg}`], { cwd: REPO_ROOT, stdio: 'pipe' });
      });
    } finally {
      rmSync(tmpPath, { force: true });
    }
  });
});
