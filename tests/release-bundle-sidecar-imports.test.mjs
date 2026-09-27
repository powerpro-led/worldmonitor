// scripts/build-release-bundle.mjs copies an EXPLICIT list of sidecar files
// (SIDECAR_FILES). A bundled sidecar file that imports a sibling missing from
// that list builds fine, passes every test in the repo, and then crashes at
// startup on every install with ERR_MODULE_NOT_FOUND. This checks the list
// is closed over its own relative imports. (Added with read-chunking.mjs,
// 2026-09-27 — the first new sidecar module since the list was written.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR = path.join(ROOT, 'vscode-extension', 'sidecar');

function bundledSidecarFiles() {
  const src = readFileSync(path.join(ROOT, 'scripts', 'build-release-bundle.mjs'), 'utf8');
  const block = src.match(/const SIDECAR_FILES = \[([\s\S]*?)\];/);
  assert.ok(block, 'SIDECAR_FILES list not found in build-release-bundle.mjs');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('every same-directory import of a bundled sidecar file is itself bundled', () => {
  const files = bundledSidecarFiles();
  const bundled = new Set(files);
  const missing = [];
  for (const f of files.filter((name) => name.endsWith('.mjs'))) {
    const src = readFileSync(path.join(SIDECAR, f), 'utf8');
    // static `from './x.mjs'` and dynamic `import('./x.mjs')`
    for (const m of src.matchAll(/(?:from\s+|import\(\s*)['"]\.\/([^'"]+)['"]/g)) {
      if (!bundled.has(m[1])) missing.push(`${f} → ./${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `add these to SIDECAR_FILES: ${missing.join(', ')}`);
});

test('every file in SIDECAR_FILES exists', () => {
  for (const f of bundledSidecarFiles()) assert.ok(existsSync(path.join(SIDECAR, f)), `${f} is listed but missing`);
});
