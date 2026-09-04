#!/usr/bin/env node
/**
 * build-backend-lockfile — (re)generate scripts/release/backend-package-lock.json
 * to match scripts/release/backend-package.json.
 *
 * The release bundle ships backend-package.json AS package.json and runs
 * `npm ci --omit=dev` against it (Local App Initiative D4). `npm ci` refuses to
 * run unless the lockfile exactly satisfies the manifest, so the two must be
 * committed as a pair and regenerated together.
 *
 *   node scripts/build-backend-lockfile.mjs           # regenerate
 *   node scripts/build-backend-lockfile.mjs --check   # CI: fail if stale
 *
 * Implementation: copy the manifest into a scratch dir, `npm install
 * --package-lock-only` there (no node_modules, no network beyond metadata),
 * copy the resulting lock back. Asserts the manifest version matches the root
 * package.json so a release bump can't leave the bundle on a stale version.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'scripts', 'release', 'backend-package.json');
const LOCKFILE = path.join(ROOT, 'scripts', 'release', 'backend-package-lock.json');
const check = process.argv.includes('--check');

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const rootPkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (manifest.version !== rootPkg.version) {
  console.error(
    `backend-package.json version (${manifest.version}) != root package.json (${rootPkg.version}).\n`
    + 'Bump scripts/release/backend-package.json to match, then re-run this script.',
  );
  process.exit(1);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wm-backend-lock-'));
try {
  // Strip the "//" doc key — npm tolerates it, but keep the scratch manifest clean.
  const { '//': _doc, ...clean } = manifest;
  writeFileSync(path.join(tmp, 'package.json'), `${JSON.stringify(clean, null, 2)}\n`);
  execFileSync(
    'npm',
    ['install', '--package-lock-only', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: tmp, stdio: 'inherit' },
  );
  const generated = readFileSync(path.join(tmp, 'package-lock.json'), 'utf8');

  if (check) {
    let current = '';
    try { current = readFileSync(LOCKFILE, 'utf8'); } catch { /* missing */ }
    if (current !== generated) {
      console.error('backend-package-lock.json is stale — run: node scripts/build-backend-lockfile.mjs');
      process.exit(1);
    }
    console.log('backend-package-lock.json is up to date.');
  } else {
    writeFileSync(LOCKFILE, generated);
    console.log(`wrote ${path.relative(ROOT, LOCKFILE)}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
