import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '..');

function readRepo(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('high-risk Redis documentation guardrails', () => {
  it('UCDP writer (scripts/seed-ucdp-events.mjs) has the non-empty discovery guard', () => {
    // ais-relay.cjs's writer-side UCDP_REDIS_KEY and discovery guard
    // (ucdpDiscoverVersion) moved out with the rest of the writer loop (P14
    // Phase 2, session 62 — see PLATFORM_ARCHITECTURE.md), leaving this the
    // sole UCDP Redis writer. The separate on-demand relay-reader's own
    // non-empty guard (a different pattern — still in ais-relay.cjs,
    // untouched by that move) is covered by
    // tests/ucdp-seed-resilience.test.mjs's "on-demand relay discovery"
    // test.
    const standalone = readRepo('scripts/seed-ucdp-events.mjs');

    assert.match(standalone, /const REDIS_KEY = 'conflict:ucdp-events:v1'/);
    assert.match(standalone, /page0\.Result\.length === 0/);
  });

  it('Fear & Greed history Redis key is not written by the seeder yet', () => {
    const seeder = readRepo('scripts/seed-fear-greed.mjs');

    assert.doesNotMatch(seeder, /market:fear-greed:history:v1/);
  });
});
