// Guards the Nitric membrane worker-stream budget for the GCP api service.
//
// Every route registration (route.get()/.post()/.all()/…) opens its own gRPC
// bidi stream to the membrane, which caps concurrent streams at MAX_WORKERS
// (default 300 — nitrictech/nitric core/pkg/env/variables.go). Streams past
// the cap never open, so those routes never register and every request to
// them 500s with "Unable to get worker to handle request". `nitric start`
// locally does not enforce the cap, so only a static check catches this.
//
// Regression: per-method registration (6 streams × 86 routes ≈ 519) left
// routes #50+ (supply-chain, resilience, trade, sanctions, …) dead on GCP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NITRIC_MAX_WORKERS_DEFAULT = 300;

const REGISTRATION_RE = /\.(get|post|put|patch|delete|options|all)\(\s*adaptVercelHandler\(/g;

function countRegistrations(file) {
  return (readFileSync(path.join(ROOT, file), 'utf8').match(REGISTRATION_RE) ?? []).length;
}

test('generated routes register one worker per route via .all()', () => {
  const src = readFileSync(path.join(ROOT, 'gcp/api/routes.generated.ts'), 'utf8');
  const perMethod = src.match(/\.(get|post|put|patch|delete|options)\(\s*adaptVercelHandler\(/g) ?? [];
  assert.equal(perMethod.length, 0, 'per-method registration multiplies membrane streams — use route.all()');
  const routes = src.match(/api\.route\(/g) ?? [];
  const alls = src.match(/\.all\(\s*adaptVercelHandler\(/g) ?? [];
  assert.equal(alls.length, routes.length);
});

test('api service stays under the membrane MAX_WORKERS stream cap', () => {
  const total = countRegistrations('gcp/api/routes.generated.ts') + countRegistrations('gcp/api/main.ts');
  assert.ok(
    total < NITRIC_MAX_WORKERS_DEFAULT,
    `${total} worker streams >= MAX_WORKERS default ${NITRIC_MAX_WORKERS_DEFAULT}; routes past the cap never register on GCP`,
  );
});
