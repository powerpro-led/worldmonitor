#!/usr/bin/env node
/**
 * Pre-compiles one Nitric service entrypoint (gcp/api/main.ts,
 * gcp/scheduler/main.ts) into a single ESM bundle, so the deployed container
 * runs `node <bundle>` instead of `npx tsx <entrypoint>`.
 *
 * WHY (2026-09-19, the cold-start-500 fix): Cloud Run's STARTUP TCP probe
 * passes as soon as Nitric's membrane binds PORT=9001 — which happens long
 * before the Node app has registered its workers. Cloud Run then throttles
 * the instance's CPU, because the probe passed and no request is being served
 * yet. Whatever the app still has left to do at that moment, it does at a
 * fraction of a vCPU. With `npx tsx` that remaining work is "compile the
 * TypeScript of ~105 route modules from source", and the app never finishes:
 * `error handling request: http server not registered`, HTTP 500, no app
 * stdout at all. The deploy-time start succeeds only because that phase gets
 * full CPU.
 *
 * Measured on the api entrypoint's module graph (warm FS cache, unthrottled
 * laptop): `npx tsx` 2.64s wall / 1336ms to import routes.generated, vs.
 * `node` on the bundle 0.41s wall / ~370ms. The throttled instance sees the
 * same ~6x, applied to a much slower baseline.
 *
 * WHERE THE OUTPUT GOES — next to its entrypoint, as `<name>.bundle.mjs`,
 * NOT into a dist/ tree. gcp/scheduler/main.ts derives REPO_ROOT from
 * `import.meta.url` (`path.resolve(__dirname, '..', '..')`) to find
 * scripts/railway-services.json and to `cwd` its spawned seed children.
 * esbuild leaves `import.meta.url` pointing at the OUTPUT file, so the bundle
 * has to sit at the same depth as the source it replaces or REPO_ROOT lands
 * on dist/ and every spawn breaks. Emitting in place keeps that — and every
 * other `import.meta.url` that may enter a bundle later — correct by
 * construction.
 *
 * Dependencies stay external (`--packages=external`): node_modules is already
 * in the image, and resolution from /app/gcp/<svc>/ walks up to /app/
 * node_modules normally. Bundling them in would buy little and would risk the
 * usual native-module / dynamic-require breakage.
 *
 * The bundles are build artifacts, produced inside the Docker build after
 * `COPY . .` — they are gitignored and are not expected to exist in a
 * checkout. Run this by hand only to reproduce a build locally.
 *
 * Usage:
 *   node scripts/build-gcp-service-bundle.mjs gcp/api/main.ts
 */

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const entry = process.argv[2];
if (!entry) {
  console.error('usage: node scripts/build-gcp-service-bundle.mjs <entrypoint.ts>');
  process.exit(1);
}

const entryAbs = path.resolve(REPO_ROOT, entry);
const outfile = entryAbs.replace(/\.ts$/, '.bundle.mjs');
if (outfile === entryAbs) {
  console.error(`entrypoint must be a .ts file, got: ${entry}`);
  process.exit(1);
}

const started = Date.now();
await build({
  entryPoints: [entryAbs],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Matches package.json's `engines.node: >=22.5.0` floor rather than the
  // image's node:24 — the bundle is also runnable locally for a boot-time
  // measurement, and nothing here needs a 24-only lowering.
  target: 'node22',
  packages: 'external',
  sourcemap: false,
  logLevel: 'warning',
});

console.log(
  `[build-gcp-service-bundle] ${path.relative(REPO_ROOT, entryAbs)} -> ` +
    `${path.relative(REPO_ROOT, outfile)} in ${Date.now() - started}ms`,
);
