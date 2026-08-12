import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '..');

function readRepo(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('high-risk Redis documentation guardrails', () => {
  it('UCDP writers for conflict:ucdp-events:v1 share the non-empty discovery guard', () => {
    const relay = readRepo('scripts/ais-relay.cjs');
    const standalone = readRepo('scripts/seed-ucdp-events.mjs');

    assert.match(relay, /UCDP_REDIS_KEY = 'conflict:ucdp-events:v1'/);
    assert.match(standalone, /const REDIS_KEY = 'conflict:ucdp-events:v1'/);
    assert.match(relay, /Result\.length === 0\) throw/);
    assert.match(relay, /page0\.Result\.length > 0/);
    assert.match(standalone, /page0\.Result\.length === 0/);
  });

  it('Fear & Greed history Redis key is not written by the seeder yet', () => {
    const seeder = readRepo('scripts/seed-fear-greed.mjs');

    assert.doesNotMatch(seeder, /market:fear-greed:history:v1/);
  });
});
