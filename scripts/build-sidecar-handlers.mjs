/**
 * Compiles API handlers into bundled ESM .js files so the sidecar's
 * buildRouteTable() can load them. Two sets:
 *
 *   1. per-domain RPC handlers  api/{domain}/v1/[rpc].ts
 *   2. TOP-LEVEL routes         api/<name>.ts
 *
 * (2) was missing until 2026-08-21, and the failure mode is unforgiving:
 * buildRouteTable() only ever collects `.js`, so a top-level route with no
 * built sibling is not a degraded route, it is NO route — the sidecar 404s it.
 * `api/latest-brief.ts` was one of 18, which is why the dashboard's Latest
 * Brief panel reported "Brief service unavailable (404)" while working fine in
 * the browser, where nitric resolves the `.ts` directly.
 *
 * Run: node scripts/build-sidecar-handlers.mjs
 */

import { build } from 'esbuild';
import { readdir, stat, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const apiDir = path.join(ROOT, 'api');

// Skip the catch-all [domain] directory (handled by build-sidecar-sebuf.mjs)
const SKIP_DIRS = new Set(['[domain]', '[[...path]]']);

// Discover all api/{domain}/v1/[rpc].ts entry points
const entries = [];
const dirs = await readdir(apiDir, { withFileTypes: true });
for (const d of dirs) {
  if (!d.isDirectory() || SKIP_DIRS.has(d.name)) continue;
  const tsFile = path.join(apiDir, d.name, 'v1', '[rpc].ts');
  if (existsSync(tsFile)) {
    entries.push(tsFile);
  }
}

// api/mcp.ts: the production MCP server entry (re-exports mcpHandler from
// ./mcp/handler alongside the PRODUCTION_DEPS-wired default). Bundled here
// (not discovered by the {domain}/v1/[rpc].ts glob above) so the sidecar's
// local-only MCP route (local-api-server.mjs) can dynamic-import the raw
// `mcpHandler` export and call it with local-only deps, instead of the
// billing/OAuth-gated `PRODUCTION_DEPS` the default export carries.
const mcpEntry = path.join(apiDir, 'mcp.ts');
if (existsSync(mcpEntry)) {
  entries.push(mcpEntry);
}

// Top-level api/<name>.ts routes. Skipped deliberately:
//   _*        shared helpers — buildRouteTable() ignores them too
//   *.test.ts / *.d.ts       not routes
//   [...]     bracketed catch-alls, whose filenames are path patterns rather
//             than plain routes; the sidecar resolves concrete paths only, so
//             bundling them would emit files nothing can dispatch to.
// mcp.ts is already queued above — the Set guards against bundling it twice.
const topLevel = await readdir(apiDir, { withFileTypes: true });
const seen = new Set(entries);
for (const f of topLevel) {
  if (!f.isFile() || !f.name.endsWith('.ts')) continue;
  if (f.name.startsWith('_') || f.name.startsWith('[')) continue;
  if (f.name.endsWith('.test.ts') || f.name.endsWith('.d.ts')) continue;
  const abs = path.join(apiDir, f.name);
  if (seen.has(abs)) continue;
  seen.add(abs);
  entries.push(abs);
}

// Nested brief magazine routes. Neither glob above reaches them (they're
// neither {domain}/v1/[rpc].ts nor top-level), so until 2026-09-27 the local
// bundle shipped api/brief/[userId]/ and api/brief/carousel/… as EMPTY
// directories and every "Open brief" link 404'd on a local install (wmtest
// v2.13.17 Latest Brief report). buildRouteTable() matches their [param]
// segments fine — it just needs the built .js files.
const BRIEF_ROUTE_ENTRIES = [
  path.join(apiDir, 'brief', '[userId]', '[issueDate].ts'),
  path.join(apiDir, 'brief', 'carousel', '[userId]', '[issueDate]', '[page].ts'),
];
for (const abs of BRIEF_ROUTE_ENTRIES) {
  if (existsSync(abs) && !seen.has(abs)) {
    seen.add(abs);
    entries.push(abs);
  }
}

if (entries.length === 0) {
  console.log('build:sidecar-handlers  no domain handlers found, skipping');
  process.exit(0);
}

try {
  await build({
    entryPoints: entries,
    outdir: ROOT,
    outbase: ROOT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    treeShaking: true,
    // Resolve @/ alias to src/
    alias: { '@': path.join(ROOT, 'src') },
  });

  // @vercel/og's Node build reads TWO of its own package assets via
  // `new URL('./x', import.meta.url)` — the Geist fallback font (used to
  // build satori's `defaultFonts`, read unconditionally at module-import
  // time even though the carousel renderer supplies its own Noto Serif) and
  // resvg.wasm (the actual SVG→PNG rasterizer; this bundle doesn't ship
  // `sharp`, so the resvg.wasm path is always what runs). esbuild only
  // follows static imports, so bundling api/brief/carousel/…/[page].ts
  // inlines @vercel/og's CODE but can't know these runtime-`readFileSync`d
  // binaries need to travel too — after bundling, `import.meta.url` resolves
  // to the OUTPUT file's own directory, not @vercel/og's node_modules
  // location, so both reads ENOENT'd locally (found live 2026-09-27, wmtest
  // v2.13.18 retest — the carousel image route 502'd on every page). Copied
  // next to the bundled [page].js so the exact same relative resolution that
  // broke locally now succeeds locally; build-release-bundle.mjs's blanket
  // `copyDir('api')` then ships them with everything else under api/ — no
  // separate allowlist entry needed there, unlike SIDECAR_FILES.
  const CAROUSEL_OUT_DIR = path.join(apiDir, 'brief', 'carousel', '[userId]', '[issueDate]');
  const OG_NODE_ASSETS = ['Geist-Regular.ttf', 'resvg.wasm'];
  if (existsSync(path.join(CAROUSEL_OUT_DIR, '[page].js'))) {
    const ogDistDir = path.join(ROOT, 'node_modules', '@vercel', 'og', 'dist');
    for (const asset of OG_NODE_ASSETS) {
      const src = path.join(ogDistDir, asset);
      if (!existsSync(src)) {
        throw new Error(`@vercel/og asset missing at ${src} — the carousel route's font/rasterizer resolution has likely changed upstream; update OG_NODE_ASSETS`);
      }
      await copyFile(src, path.join(CAROUSEL_OUT_DIR, asset));
    }
    console.log(`build:sidecar-handlers  copied ${OG_NODE_ASSETS.length} @vercel/og asset(s) next to the carousel route`);
  }

  // Report results
  let totalKB = 0;
  for (const entry of entries) {
    const jsFile = entry.replace(/\.ts$/, '.js');
    if (existsSync(jsFile)) {
      const { size } = await stat(jsFile);
      totalKB += size / 1024;
    }
  }
  console.log(`build:sidecar-handlers  ${entries.length} entry points  ${totalKB.toFixed(0)} KB total`);
} catch (err) {
  console.error('build:sidecar-handlers failed:', err.message);
  process.exit(1);
}
