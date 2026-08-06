/**
 * Regression test: scripts/notification-relay.cjs must read enabled alert
 * rules through scripts/lib/alert-rules-fetch.cjs (Postgres, service-role
 * client), not a raw Convex `/relay/enabled-rules` fetch.
 *
 * Stage 3 of the Convex/Clerk -> Supabase migration replaced the old
 * `fetchEnabledRules()` — a hand-rolled fetch with its own
 * `AbortSignal.timeout(10000)` bound against a Convex HTTP action — with an
 * import from `./lib/alert-rules-fetch.cjs`, which never throws and has no
 * comparable per-call timeout to assert on (Postgres query timeouts are the
 * Supabase client's concern, not this file's). This test guards against
 * regressing back to a raw Convex relay fetch, rather than asserting a
 * timeout value that no longer applies to this call shape.
 *
 * Why source-grep: notification-relay.cjs is a runtime script with minimal
 * exports. Existing relay invariants use source-grep tests for this shape.
 *
 * Run: node --test tests/notification-relay-enabled-rules-timeout.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const relaySrc = readFileSync(
  resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'),
  'utf-8',
);

describe('notification-relay enabled-rules source', () => {
  it('imports fetchEnabledRules from lib/alert-rules-fetch.cjs', () => {
    assert.match(
      relaySrc,
      /const \{ fetchEnabledRules \} = require\('\.\/lib\/alert-rules-fetch\.cjs'\);/,
    );
  });

  it('does not reference the retired Convex relay host for rule fetches', () => {
    assert.doesNotMatch(relaySrc, /CONVEX_SITE_URL/);
    assert.doesNotMatch(relaySrc, /\/relay\/enabled-rules/);
  });
});
