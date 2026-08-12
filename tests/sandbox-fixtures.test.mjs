import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SANDBOX_OPERATIONS } from '../scripts/generate-sandbox-fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The sandbox (public/sandbox/) advertises deterministic sample responses.
// This used to also regenerate the fixtures from the generated OpenAPI
// examples (docs/api/*.openapi.json) and byte-diff against the committed
// files, so a proto/example regeneration could never leave the sandbox
// drifted from the published contract. The OpenAPI generation pipeline
// (docs/api/) was retired along with the rest of the public API docs
// product (private fork, no public API docs), so that drift check no
// longer has a source to regenerate from — scripts/generate-sandbox-fixtures.mjs
// is kept for reference but is no longer wired into this guard. What
// remains validates the already-committed fixtures are internally
// consistent with each other and with SANDBOX_OPERATIONS.
describe('sandbox fixtures (public/sandbox/)', () => {
  it('index.json lists every curated operation with a resolvable fixture file', () => {
    const index = JSON.parse(readFileSync(join(ROOT, 'public/sandbox/index.json'), 'utf8'));
    assert.equal(index.kind, 'sandbox-index');
    assert.equal(index.operations.length, SANDBOX_OPERATIONS.length);
    for (const op of index.operations) {
      assert.ok(SANDBOX_OPERATIONS.includes(op.path), `unexpected sandbox operation ${op.path}`);
      const slug = op.path.split('/').at(-1);
      assert.equal(op.fixture, `https://www.worldmonitor.app/sandbox/${slug}.json`);
      const fixture = JSON.parse(readFileSync(join(ROOT, `public/sandbox/${slug}.json`), 'utf8'));
      assert.equal(fixture.sandbox, true, `${slug}: fixtures must self-identify as sandbox data`);
      assert.equal(fixture.operation.path, op.path);
      assert.equal(fixture.response.status, 200);
      assert.ok(
        fixture.response.body && typeof fixture.response.body === 'object',
        `${slug}: fixture must carry a non-empty example body`,
      );
    }
  });
});
