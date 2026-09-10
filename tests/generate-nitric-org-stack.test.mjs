import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { buildOrgStack } from '../scripts/generate-nitric-org-stack.mjs';

// Workstream 5 (PLATFORM_ARCHITECTURE.md), reworked for PER_ORG_PROVISIONING_CONTRACT.md
// §9 step 5 (2026-09-10): scripts/generate-nitric-org-stack.mjs templates a per-org
// Nitric stack file (region + gcp-project-id) from two CLI flags fed by
// deploy-org.reusable.yml's workflow_call inputs — org-provisioning/orgs/<org>.yml
// is the registry now, not a file in this repo. This is pure config generation — no
// live infra, no network — so it's fully testable here without deno/GH
// Environments/a real GCP project.

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');
const SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/generate-nitric-org-stack.mjs');

describe('buildOrgStack()', () => {
  it('templates gcp-project-id and region from the given flags', () => {
    const stack = buildOrgStack({ gcpProject: 'acme-gcp-project', gcpRegion: 'europe-west1' });
    assert.equal(stack['gcp-project-id'], 'acme-gcp-project');
    assert.equal(stack.region, 'europe-west1');
    assert.equal(stack.provider, 'nitric/gcp@1.27.6');
  });

  it('scales EVERY per-org service to zero — no pinned instances (P14 Phase 2 tail)', () => {
    const stack = buildOrgStack({ gcpProject: 'acme-gcp-project', gcpRegion: 'us-central1' });
    assert.equal(stack.config.default.cloudrun['min-instances'], 0);
    // The ais-relay stopgap (P14 Phase 1) is gone — it's now ONE shared
    // deploy (nitric.ais-shared.yaml), not per org. Zero per-org overrides.
    const serviceOverrideKeys = Object.keys(stack.config).filter((k) => k !== 'default');
    assert.deepEqual(serviceOverrideKeys, []);
    assert.equal(stack.config['ais-relay'], undefined);
  });

  it('throws rather than silently generating a stack missing either value', () => {
    assert.throws(() => buildOrgStack({ gcpProject: 'acme' }));
    assert.throws(() => buildOrgStack({ gcpRegion: 'us-central1' }));
    assert.throws(() => buildOrgStack({}));
  });
});

describe('generate-nitric-org-stack.mjs CLI', () => {
  it('writes nitric.<org>.yaml from --gcp-project/--gcp-region flags', () => {
    const outPath = resolve(REPO_ROOT, 'nitric.test-fixture-org.yaml');
    try {
      execFileSync(
        process.execPath,
        [SCRIPT_PATH, '--org=test-fixture-org', '--gcp-project=acme-gcp-project', '--gcp-region=us-central1'],
        { cwd: REPO_ROOT },
      );
      assert.ok(existsSync(outPath));
      const written = parseYaml(readFileSync(outPath, 'utf8'));
      assert.equal(written['gcp-project-id'], 'acme-gcp-project');
      assert.equal(written.region, 'us-central1');
      assert.equal(written.config['ais-relay'], undefined, 'no per-org ais-relay pin — it is a shared deploy now');
    } finally {
      rmSync(outPath, { force: true });
    }
  });

  it('fails loudly rather than silently deploying into a default project when a flag is missing', () => {
    assert.throws(() => {
      execFileSync(process.execPath, [SCRIPT_PATH, '--org=test-fixture-org', '--gcp-project=acme'], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      });
    });
    assert.throws(() => {
      execFileSync(process.execPath, [SCRIPT_PATH, '--gcp-project=acme', '--gcp-region=us-central1'], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      });
    });
  });
});
