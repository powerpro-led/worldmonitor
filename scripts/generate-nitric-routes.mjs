#!/usr/bin/env node
/**
 * Generates gcp/api/routes.generated.ts by walking api/**\/*.ts and
 * mechanically registering every file that looks like a Vercel Edge route
 * (`export const config = { runtime: 'edge' }` + a default export) onto a
 * Nitric API gateway, via gcp/api/adapt-vercel-handler.ts.
 *
 * No business logic is touched — this only ports *routing*. Re-run this
 * script whenever api/ routes are added/removed/renamed; the output is
 * checked in so the diff is reviewable, same discipline as other generated
 * files in this repo (src/generated/**).
 *
 * Scope note: this generator only emits registrations for the `api` gateway.
 * api/mcp.ts is intentionally excluded (registered by hand in gcp/api/main.ts
 * on its own `mcp` gateway — see nitric.gcp.yaml's `apis:` block).
 *
 * Part of the scaffold-only Nitric/GCP port pass — see
 * docs/architecture/nitric-gcp-scaffold.md.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const API_DIR = path.join(REPO_ROOT, 'api');
const OUT_FILE = path.join(REPO_ROOT, 'gcp', 'api', 'routes.generated.ts');

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options'];

/** Files that are never routes, regardless of content. */
function isExcludedByName(basename) {
  return (
    basename.startsWith('_') ||
    basename.includes('.test.') ||
    basename.endsWith('.d.ts') ||
    basename === 'mcp.ts' || // registered by hand on its own gateway, see gcp/api/main.ts
    basename === 'api-route-exceptions.json'
  );
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith('.ts') || entry.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function toRoutePath(absFile) {
  const rel = path.relative(API_DIR, absFile).replace(/\\/g, '/');
  const noExt = rel.replace(/\.(ts|js)$/, '');
  const segments = noExt.split('/').filter((s) => s !== 'index');
  const converted = segments.map((seg) => {
    if (seg.startsWith('[...')) return null; // catch-all — unsupported, caller skips
    if (seg.startsWith('[') && seg.endsWith(']')) return `:${seg.slice(1, -1)}`;
    return seg;
  });
  if (converted.includes(null)) return null;
  return `/api/${converted.join('/')}`;
}

function toImportSpecifier(absFile) {
  const rel = path.relative(path.join(REPO_ROOT, 'gcp', 'api'), absFile).replace(/\\/g, '/');
  return rel.replace(/\.ts$/, '');
}

function toIdentifier(routePath, index) {
  const cleaned = routePath
    .replace(/^\/api\//, '')
    .replace(/[/:.\-[\]]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `route_${index}_${cleaned || 'root'}`;
}

const allFiles = walk(API_DIR).sort();

const candidates = [];
const skipped = [];

for (const absFile of allFiles) {
  const basename = path.basename(absFile);
  if (isExcludedByName(basename)) continue;

  // A generated .js sibling of a .ts source (esbuild bundle output, gitignored
  // build artifact — see docker/build-handlers.mjs) is never a route source.
  if (absFile.endsWith('.js')) {
    const tsSibling = absFile.replace(/\.js$/, '.ts');
    try {
      statSync(tsSibling);
      continue; // .ts sibling exists — this .js is build output, skip silently
    } catch {
      // no .ts sibling — this is a real hand-written .js handler, fall through
    }
  }

  const source = readFileSync(absFile, 'utf8');
  const isEdgeRuntime = /runtime\s*:\s*['"]edge['"]/.test(source);
  const hasDefaultExport = /export\s+default\b/.test(source) || /export\s*\{[^}]*\bdefault\b[^}]*\}/.test(source);

  if (!isEdgeRuntime || !hasDefaultExport) {
    skipped.push({ file: path.relative(REPO_ROOT, absFile), reason: !isEdgeRuntime ? 'no edge runtime config' : 'no default export' });
    continue;
  }

  const routePath = toRoutePath(absFile);
  if (routePath === null) {
    skipped.push({ file: path.relative(REPO_ROOT, absFile), reason: 'catch-all [...] segment unsupported by this generator' });
    continue;
  }

  candidates.push({ absFile, routePath });
}

const lines = [];
lines.push('/**');
lines.push(' * GENERATED FILE — do not hand-edit. Regenerate with:');
lines.push(' *   node scripts/generate-nitric-routes.mjs');
lines.push(' *');
lines.push(' * Mechanically registers every Vercel Edge handler under api/ (except');
lines.push(" * api/mcp.ts, handled separately) onto the Nitric `api` gateway declared");
lines.push(' * in gcp/api/main.ts. GET/POST/PUT/PATCH/DELETE/OPTIONS are all registered');
lines.push(' * for every route — each handler already enforces its own method');
lines.push(' * allowlist internally (same as it does today under Vercel, where one');
lines.push(' * edge function receives every verb), so this is not widening what a');
lines.push(' * route accepts.');
lines.push(' *');
if (skipped.length > 0) {
  lines.push(' * SKIPPED (visible gap, not silently dropped — see docs/architecture/');
  lines.push(' * nitric-gcp-scaffold.md for what each of these needs):');
  for (const s of skipped) {
    lines.push(` *   - ${s.file} (${s.reason})`);
  }
} else {
  lines.push(' * SKIPPED: none.');
}
lines.push(' */');
lines.push('');
lines.push("import type { Api } from '@nitric/sdk';");
lines.push("import { adaptVercelHandler } from './adapt-vercel-handler';");
for (const [i, c] of candidates.entries()) {
  const specifier = toImportSpecifier(c.absFile);
  // Matches the existing codebase convention (server/gateway.ts, api/user-prefs.ts)
  // for importing hand-written .js handlers with no declaration file.
  if (specifier.endsWith('.js')) {
    lines.push('// @ts-expect-error — JS module, no declaration file');
  }
  lines.push(`import ${toIdentifier(c.routePath, i)}Handler from '${specifier}';`);
}
lines.push('');
lines.push('export function registerGeneratedRoutes(api: Api): void {');
for (const [i, c] of candidates.entries()) {
  const id = toIdentifier(c.routePath, i);
  const route = c.routePath.replace(/'/g, "\\'");
  lines.push(`  const ${id} = api.route('${route}');`);
  for (const method of METHODS) {
    lines.push(`  ${id}.${method}(adaptVercelHandler(${id}Handler));`);
  }
}
lines.push('}');
lines.push('');

writeFileSync(OUT_FILE, lines.join('\n'));

console.log(`generate-nitric-routes: ${candidates.length} route(s) registered, ${skipped.length} skipped.`);
if (skipped.length > 0) {
  console.log('Skipped files:');
  for (const s of skipped) console.log(`  - ${s.file} (${s.reason})`);
}
