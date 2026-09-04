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

/** Escape a literal string for embedding in a RegExp source. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every `assets/…` reference in one built HTML entry point. */
function distHtmlAssetRefs(file) {
  const html = readFileSync(file, 'utf-8');
  return new Set(html.match(/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g) || []);
}

/**
 * The built assets reachable ONLY from settings.html — its own entry chunk and
 * stylesheet, and nothing the dashboard can still reach.
 *
 * Deliberately NOT a `settings-*` filename match: the names are content-hashed,
 * and several genuinely shared chunks are also named `settings-something`
 * (`settings-persistence-*.js`, `globe-render-settings-*.js`).
 *
 * Nor is an HTML-level set subtraction enough, which is the subtle part. A
 * built HTML file lists only its STATIC imports (script + modulepreload tags);
 * a chunk pulled in by a dynamic `import()` appears solely inside the importing
 * JS chunk. Measured on this repo's dist/, a plain HTML subtraction wrongly
 * classified `ollama-models-*.js` (dynamically imported by the dashboard entry
 * `main-*.js` AND by `panels-risk-*.js`) and `settings-persistence-*.js`
 * (imported by `main-*.js` and `UnifiedSettings-*.js`) as settings-exclusive.
 * Pruning either would have shipped a dashboard that 404s on a dynamic import
 * at runtime, in an operator's webview, with nothing failing at build time.
 *
 * So: start from settings.html's own refs minus every other HTML entry's, then
 * iterate to a fixpoint, dropping any candidate that some RETAINED file still
 * references. What survives is referenced by settings.html and by other pruned
 * chunks only.
 */
function resolveSettingsOnlyDistAssets() {
  const distDir = path.join(ROOT, 'dist');
  const settingsHtml = path.join(distDir, 'settings.html');
  if (!existsSync(settingsHtml)) {
    // Already pruned (a --skip-build re-run over a pruned dist/) — nothing to do.
    return { assets: new Set() };
  }

  const candidates = distHtmlAssetRefs(settingsHtml);
  for (const entry of readdirSync(distDir)) {
    if (!entry.endsWith('.html') || entry === 'settings.html') continue;
    for (const ref of distHtmlAssetRefs(path.join(distDir, entry))) candidates.delete(ref);
  }

  // Every dist file whose content could reference a chunk, with its text. sw.js
  // is excluded because its precache manifest lists everything by definition —
  // it is rewritten to match the prune by pruneSettingsFromServiceWorker().
  const scannable = [];
  for (const entry of readdirSync(path.join(distDir, 'assets'))) {
    if (!/\.(js|css)$/.test(entry)) continue; // skip .br/.gz twins
    scannable.push([`assets/${entry}`, readFileSync(path.join(distDir, 'assets', entry), 'utf-8')]);
  }
  for (const entry of readdirSync(distDir)) {
    if (!entry.endsWith('.html') || entry === 'settings.html') continue;
    scannable.push([entry, readFileSync(path.join(distDir, entry), 'utf-8')]);
  }

  for (let changed = true; changed;) {
    changed = false;
    for (const [name, text] of scannable) {
      if (candidates.has(name)) continue; // itself pruned — its refs don't retain anything
      for (const candidate of candidates) {
        if (candidate === name) continue;
        if (text.includes(path.basename(candidate))) {
          candidates.delete(candidate);
          changed = true;
        }
      }
    }
  }
  return { assets: candidates };
}

/**
 * Drop the pruned assets from dist/sw.js's Workbox precache manifest.
 *
 * REQUIRED, not tidiness: `precacheAndRoute()` fails the whole service-worker
 * install if any manifest URL 404s, so shipping a manifest that still lists a
 * pruned file would break the SW for every operator — and it would break it
 * silently, since a failed install just leaves the previous SW (or none) in
 * place. settings.html itself is not in the manifest; its assets are.
 *
 * Throws if an entry it expected to remove isn't found, so a future Workbox or
 * Vite change to the manifest's shape surfaces as a loud build failure rather
 * than a bundle that half-works.
 */
function pruneSettingsFromServiceWorker(assets) {
  if (assets.size === 0) return;
  const swPath = path.join(STAGE, 'dist', 'sw.js');
  if (!existsSync(swPath)) return; // no service worker in this build
  let sw = readFileSync(swPath, 'utf-8');
  for (const asset of assets) {
    const pattern = new RegExp(
      `\\{url:"${escapeRegExp(asset)}",revision:[^}]*\\},?`,
    );
    if (!pattern.test(sw)) {
      throw new Error(
        `build-release-bundle: pruned ${asset} from dist/ but found no matching entry in `
        + `sw.js's precache manifest. The manifest's shape has changed — update `
        + `pruneSettingsFromServiceWorker() before shipping, or the service worker will `
        + `fail to install on a 404.`,
      );
    }
    sw = sw.replace(pattern, '');
  }
  writeFileSync(swPath, sw);
  console.log(`  pruned ${assets.size} settings-only asset(s) from dist/ and sw.js`);
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
//
// settings.html is pruned here. It is the ORG-ADMIN panel (see
// PLATFORM_ARCHITECTURE.md Workstream 6) and must not ship to operators
// (OQ-P4) — the per-operator LLM-key modal lives inside dashboard.html
// instead (Workstream 3). A post-copy prune rather than a build variant
// because there is no operator-specific Vite build to remove it from:
// vite.config.ts has ONE unconditional `input: { main, settings }`, and the
// cloud admin deploy of Workstream 6 needs settings.html out of that same
// dist/. Forking the Vite build for one file would be the wrong trade.
//
// Nothing links to settings.html from dashboard.html — it was only ever
// reachable via the Phase 2 first-run redirect shim, itself reverted in
// Workstream R — so pruning it leaves no dead link.
const settingsPrune = resolveSettingsOnlyDistAssets();
copyDir('dist', (src) => {
  const rel = path.relative(path.join(ROOT, 'dist'), src).split(path.sep).join('/');
  if (rel === 'settings.html') return true;
  // Compressed twins are emitted alongside each asset; drop them together.
  return settingsPrune.assets.has(rel.replace(/\.(br|gz)$/, ''));
});
pruneSettingsFromServiceWorker(settingsPrune.assets);
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
// bundle exists). Copy them next to the archives — stamping this build's
// version so the published `install` fetches the matching bundle — so Phase 4's
// `gh release create` (and local testing) can pick them up.
{
  const sh = readFileSync(path.join(ROOT, 'scripts', 'release', 'install'), 'utf8')
    .replace(/^APP_VERSION="[^"]*"/m, `APP_VERSION="${VERSION}"`);
  writeFileSync(path.join(OUT_DIR, 'install'), sh);
  chmodSync(path.join(OUT_DIR, 'install'), 0o755);
  const ps = readFileSync(path.join(ROOT, 'scripts', 'release', 'install.ps1'), 'utf8')
    .replace(/(\[string\]\$AppVersion\s*=\s*)'[^']*'/, `$1'${VERSION}'`);
  writeFileSync(path.join(OUT_DIR, 'install.ps1'), ps);
}

// ── 5. archives + checksums ───────────────────────────────────────────
// Cross-platform: the local dev path is macOS, Phase 4 CI runs on ubuntu.
const archives = [`${NAME}.tar.gz`, `${NAME}.zip`];
run('tar', ['-czf', path.join(OUT_DIR, archives[0]), '-C', OUT_DIR, NAME]);
if (process.platform === 'darwin') {
  // --norsrc/--noextattr/--noqtn: no __MACOSX or ._ sidecar entries.
  run('ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noqtn', '--keepParent', STAGE, path.join(OUT_DIR, archives[1])]);
} else {
  // -X: no extra file attributes / uid-gid. Run from OUT_DIR so the archive
  // carries the `${NAME}/` prefix (ditto --keepParent equivalent).
  run('zip', ['-r', '-q', '-X', archives[1], NAME], { cwd: OUT_DIR });
}

const shaCmd = process.platform === 'darwin' ? ['shasum', '-a', '256'] : ['sha256sum'];
console.log('\n─────────────────────────────────────────────');
const shaLines = [];
for (const a of archives) {
  const sum = execFileSync(shaCmd[0], [...shaCmd.slice(1), a], { cwd: OUT_DIR }).toString();
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
