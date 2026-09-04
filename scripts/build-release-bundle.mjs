#!/usr/bin/env node
/**
 * build-release-bundle — assemble the downloadable macOS release bundle for
 * `worldmonitor-local` (the standalone local backend + the VS Code Local
 * Dashboard extension).
 *
 * Output (under release/, git-ignored):
 *   worldmonitor-local-<version>.tar.gz         the bundle (macOS / Linux)
 *   worldmonitor-local-<version>.zip            the same tree (Windows)
 *   worldmonitor-local-<version>.tar.gz.sha256  + per-archive checksums
 *   worldmonitor-local-<version>.zip.sha256
 *
 * Run from the repo root:
 *   node scripts/build-release-bundle.mjs [--skip-build]
 *
 * How to test the resulting bundle: scripts/release/TESTING.md
 *
 * WHY the layout is preserved verbatim: scripts/worldmonitor-local.mjs derives
 * REPO_ROOT as `../` from its own location and hard-codes the launchd plist's
 * WorkingDirectory / LOCAL_API_RESOURCE_DIR to it. So as long as the bundle
 * keeps `scripts/worldmonitor-local.mjs` and `vscode-extension/sidecar/*` at
 * the same relative depth, the CLI works unchanged once the operator extracts
 * it and runs `worldmonitor-local install`.
 *
 * WHY three build steps: `npm run build` only emits the frontend (dist/). The
 * sidecar's buildRouteTable() loads API routes as `.js` ONLY, and those are
 * produced by two separate esbuild passes (build:sidecar-sebuf,
 * build:sidecar-handlers) that inline each handler's server/_shared + shared +
 * npm imports. Ship the compiled `.js`, never the `.ts` sources.
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync, mkdirSync, rmSync, writeFileSync, readFileSync,
  existsSync, statSync, chmodSync, readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const NAME = `worldmonitor-local-${VERSION}`;
const OUT_DIR = path.join(ROOT, 'release');
const STAGE = path.join(OUT_DIR, NAME);
const skipBuild = process.argv.includes('--skip-build');

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
}

// ── 1. build ──────────────────────────────────────────────────────────────
// Model B: build dist/ with VITE_SUPABASE_* forced empty so no org's Supabase
// project is baked into the JS. supabase-client.ts's readEnv() then falls back
// to window.__WM_RUNTIME_CONFIG, which the standalone backend injects into the
// HTML it serves from its own .env. Vite gives an already-set process.env var
// (even "") priority over .env files, so this cleanly blanks them for the build
// without touching the repo's .env. APP_DOMAIN stays baked (non-secret; only
// cosmetic for a loopback-served dashboard) — see TASKS.md for the Phase 2
// domain-neutral follow-up.
const buildEnv = { ...process.env, VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '' };
if (skipBuild) {
  console.log('--skip-build: reusing the working tree\'s dist/ and api/**/*.js');
} else {
  run('npm', ['run', 'build'], { env: buildEnv });
  run('npm', ['run', 'build:sidecar-sebuf']);
  run('npm', ['run', 'build:sidecar-handlers']);
}

if (!existsSync(path.join(ROOT, 'dist', 'dashboard.html'))) {
  throw new Error('dist/dashboard.html is missing — run without --skip-build');
}
if (!existsSync(path.join(ROOT, 'api', 'latest-brief.js'))) {
  throw new Error('api/latest-brief.js is missing — build:sidecar-handlers did not run');
}

// ── 2. VS Code extension .vsix ────────────────────────────────────────────
const extPkg = JSON.parse(
  readFileSync(path.join(ROOT, 'vscode-extension', 'package.json'), 'utf8'),
);
const VSIX = `${extPkg.name}-${extPkg.version}.vsix`;
if (!skipBuild) {
  run('npm', ['ci'], { cwd: path.join(ROOT, 'vscode-extension') });
  run('npm', ['run', 'package'], { cwd: path.join(ROOT, 'vscode-extension') });
}
if (!existsSync(path.join(ROOT, 'vscode-extension', VSIX))) {
  throw new Error(`vscode-extension/${VSIX} not found — \`npm run package\` failed`);
}

// ── 3. stage the file tree ───────────────────────────────────────────────
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

const EXCLUDE_BASENAMES = new Set(['__tests__', 'node_modules', '.DS_Store', '.git']);
function excluded(src) {
  const b = path.basename(src);
  if (EXCLUDE_BASENAMES.has(b)) return true;
  if (/\.(test|spec)\.(m?[jt]s|cjs)$/.test(b)) return true;
  if (b.endsWith('.d.ts')) return true;
  const ext = path.extname(b);
  if (ext === '.ts' || ext === '.map' || ext === '.tsbuildinfo') return true;
  return false;
}

function copyDir(rel, extraReject) {
  cpSync(path.join(ROOT, rel), path.join(STAGE, rel), {
    recursive: true,
    filter: (src) => !excluded(src) && !(extraReject && extraReject(src)),
  });
}

// api/: compiled .js routes + hand-written .mjs/.cjs helpers + .json data.
copyDir('api');
// server/: _shared/* helpers imported on demand by api handlers. gateway.ts is
// the nitric entrypoint — never reached by the sidecar; .ts is excluded anyway.
copyDir('server');

// server/_shared/redis.ts is dynamically imported at runtime by
// local-api-server.mjs (the runRedisPipeline path), but the .ts is stripped
// from the bundle above and no other build step compiles that tree — so a
// shipped bundle would throw ERR_MODULE_NOT_FOUND on that path. Emit a
// self-contained ESM .js straight into the stage (it bundles sidecar-cache +
// node:sqlite inline; ~42 KB, zero node_modules). Sidecar-only — the cloud/edge
// path uses redis.ts directly and never loads this file.
await esbuild({
  entryPoints: [path.join(ROOT, 'server', '_shared', 'redis.ts')],
  outfile: path.join(STAGE, 'server', '_shared', 'redis.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  treeShaking: true,
});
// shared/: .js/.cjs/.json reference data. The .ts twins are dev-only and skipped.
copyDir('shared');
// built frontend the backend serves over real HTTP for the extension iframe.
copyDir('dist');
// NOTE: patches/ is deliberately NOT staged. The slim backend manifest
// (scripts/release/backend-package.json) has no postinstall, so patch-package
// never runs from the bundle, and the one patched package (@nitric/sdk) is not
// a backend dependency at all.

// sidecar runtime files ONLY (no local-api-server.test.mjs, no local-cache.db,
// no operator-identity.json — a fresh machine seeds its own cache + identity).
const SIDECAR_FILES = [
  'local-api-server.mjs',
  'local-sync.mjs',
  'sync-listener.mjs',
  'session-file.mjs',
  'config-store.mjs',
  'local-login.mjs',
  '_domain-config.mjs',
  'kv-cache-schema.mjs',
  'package.json',
];
mkdirSync(path.join(STAGE, 'vscode-extension', 'sidecar'), { recursive: true });
for (const f of SIDECAR_FILES) {
  cpSync(
    path.join(ROOT, 'vscode-extension', 'sidecar', f),
    path.join(STAGE, 'vscode-extension', 'sidecar', f),
  );
}

// the CLI (single file — its only repo import is the sidecar session-file.mjs
// copied above) plus scripts/shared/sync-domains.mjs, the ONLY scripts/ file
// the sidecar imports (local-sync.mjs + sync-listener.mjs, for SYNC_PREFIXES /
// isMirroredKey — it is self-contained, no further imports).
mkdirSync(path.join(STAGE, 'scripts', 'shared'), { recursive: true });
cpSync(
  path.join(ROOT, 'scripts', 'worldmonitor-local.mjs'),
  path.join(STAGE, 'scripts', 'worldmonitor-local.mjs'),
);
cpSync(
  path.join(ROOT, 'scripts', 'shared', 'sync-domains.mjs'),
  path.join(STAGE, 'scripts', 'shared', 'sync-domains.mjs'),
);

// the extension artifact + in-bundle setup scripts + docs at the bundle root.
// (The `curl | sh` bootstrap — scripts/release/install{,.ps1} — is a release-
// page asset, not staged here: it runs BEFORE the bundle exists. It's copied
// to release/ below for Phase 4's `gh release create`.)
cpSync(path.join(ROOT, 'vscode-extension', VSIX), path.join(STAGE, VSIX));
cpSync(path.join(ROOT, 'scripts', 'release', 'setup.sh'), path.join(STAGE, 'setup.sh'));
chmodSync(path.join(STAGE, 'setup.sh'), 0o755);
cpSync(path.join(ROOT, 'scripts', 'release', 'setup.ps1'), path.join(STAGE, 'setup.ps1'));
cpSync(path.join(ROOT, 'scripts', 'release', 'TESTING.md'), path.join(STAGE, 'TESTING.md'));
cpSync(path.join(ROOT, 'scripts', 'release', 'SECURITY.md'), path.join(STAGE, 'SECURITY.md'));
// Desktop-launcher icons (setup.sh / setup.ps1 build the launcher from these).
mkdirSync(path.join(STAGE, 'assets'), { recursive: true });
for (const f of ['icon.icns', 'icon.ico']) {
  cpSync(path.join(ROOT, 'scripts', 'release', 'assets', f), path.join(STAGE, 'assets', f));
}
// org.env.example — the per-org config template (Model B). NOTE: never stage a
// filled org.env / .env; the bundle must ship org-neutral.
cpSync(path.join(ROOT, 'scripts', 'release', 'org.env.example'), path.join(STAGE, 'org.env.example'));
for (const f of ['.env.example', 'LICENSE', 'CHANGELOG.md', 'INSTALL.md']) {
  cpSync(path.join(ROOT, f), path.join(STAGE, f));
}

// ── slim backend-only package.json + lockfile (Local App Initiative D4) ──
// The bundle ships the compiled frontend in dist/, so the ~80 frontend/build
// packages in the root manifest are dead weight at install time. The backend
// process loads only hand-maintained api/**/*.js (bare imports: @upstash/*,
// @vercel/functions, aws4fetch) and self-contained esbuild bundles, plus
// @supabase/supabase-js from the sidecar. `npm ci --omit=dev` against this pair
// drops from 736 pkgs / ~1.2 GB / ~5 min to 39 pkgs / ~19 MB / ~1 s.
// Regenerate the lock after editing the manifest: node scripts/build-backend-lockfile.mjs
// (CI runs `build-backend-lockfile.mjs --check` to catch a stale lock; kept out
// of this script so an offline bundle build doesn't need npm registry metadata.)
const backendManifest = JSON.parse(
  readFileSync(path.join(ROOT, 'scripts', 'release', 'backend-package.json'), 'utf8'),
);
if (backendManifest.version !== VERSION) {
  throw new Error(
    `scripts/release/backend-package.json version (${backendManifest.version}) != ${VERSION} — bump it and re-run build-backend-lockfile.mjs`,
  );
}
delete backendManifest['//'];
writeFileSync(path.join(STAGE, 'package.json'), `${JSON.stringify(backendManifest, null, 2)}\n`);
cpSync(
  path.join(ROOT, 'scripts', 'release', 'backend-package-lock.json'),
  path.join(STAGE, 'package-lock.json'),
);
// Guard: a real .env or org.env must never end up in the bundle.
for (const leaked of ['.env', 'org.env']) {
  if (existsSync(path.join(STAGE, leaked))) {
    throw new Error(`refusing to ship: ${leaked} is present in the staged bundle`);
  }
}

// ── 4. manifest ─────────────────────────────────────────────────────────
let fileCount = 0;
let totalBytes = 0;
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else { fileCount += 1; totalBytes += statSync(p).size; }
  }
})(STAGE);
writeFileSync(
  path.join(STAGE, 'BUNDLE_MANIFEST.txt'),
  [
    `worldmonitor-local ${VERSION}`,
    `extension          ${extPkg.name}@${extPkg.version}`,
    `built              ${new Date().toISOString()}`,
    `contents           ${fileCount} files, ${(totalBytes / 1e6).toFixed(1)} MB unpacked`,
    'node_modules       NOT included — setup runs `npm ci --omit=dev --ignore-scripts`',
    'package.json       slim backend-only manifest (5 deps → ~39 pkgs / ~19 MB); root frontend deps excluded',
    'one-command        curl -fsSL <release>/install | sh   ·   irm <release>/install.ps1 | iex',
    'manual setup       macOS/Linux: ./setup.sh   ·   Windows: .\\setup.ps1',
    '',
  ].join('\n'),
);

// The `curl | sh` bootstrap scripts are release-page assets (they run before a
// bundle exists). Copy them next to the archives so Phase 4's `gh release
// create` — and local testing — can pick them up.
for (const f of ['install', 'install.ps1']) {
  cpSync(path.join(ROOT, 'scripts', 'release', f), path.join(OUT_DIR, f));
}
chmodSync(path.join(OUT_DIR, 'install'), 0o755);

// ── 5. archives + checksums ───────────────────────────────────────────
const archives = [`${NAME}.tar.gz`, `${NAME}.zip`];
run('tar', ['-czf', path.join(OUT_DIR, archives[0]), '-C', OUT_DIR, NAME]);
// --norsrc/--noextattr/--noqtn: no __MACOSX or ._ sidecar entries in the zip.
run('ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noqtn', '--keepParent', STAGE, path.join(OUT_DIR, archives[1])]);

console.log('\n─────────────────────────────────────────────');
const shaLines = [];
for (const a of archives) {
  const sum = execFileSync('shasum', ['-a', '256', a], { cwd: OUT_DIR }).toString();
  writeFileSync(path.join(OUT_DIR, `${a}.sha256`), sum);
  const bytes = statSync(path.join(OUT_DIR, a)).size;
  console.log(`  release/${a}   (${(bytes / 1e6).toFixed(1)} MB)`);
  shaLines.push(sum.trim());
}
console.log('');
shaLines.forEach((l) => console.log(l));
console.log('\nnext:  gh release create v' + VERSION
  + `\n         ${archives.map((a) => `release/${a} release/${a}.sha256`).join(' \\\n         ')} \\`
  + `\n         release/install release/install.ps1 \\`
  + `\n         vscode-extension/${VSIX} --title "v${VERSION}" --notes-file <notes>`);
