import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { main } from '../scripts/sync-ais-results.mjs';

// scripts/sync-ais-results.mjs — the per-org shared→org bridge for the AIS
// ingest's pure output (P14 Phase 2 tail / decision P17). It copies bytes from
// the shared "AIS results" Upstash into THIS org's Upstash; it computes
// nothing. These tests mock globalThis.fetch: a GET on the SHARED host answers
// with the stored string, any POST on the ORG host is an accepted write.
const SHARED_URL = 'https://ais-results.example.com';
const ORG_URL = 'https://org-db.example.com';
const CANONICAL = 'supply_chain:chokepoint_transits:v1';
const META = 'seed-meta:supply_chain:chokepoint_transits';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function restoreEnv() {
  for (const k of Object.keys(process.env)) if (!(k in originalEnv)) delete process.env[k];
  Object.assign(process.env, originalEnv);
}

/**
 * @param {Record<string,string|null>} sharedStore  key → stored string (null = miss)
 */
function installFetch(sharedStore, orgWrites, opts = {}) {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(SHARED_URL)) {
      if (opts.sharedThrows) throw new Error('shared network down');
      const m = u.match(/\/get\/(.+)$/);
      const key = decodeURIComponent(m[1]);
      if (opts.sharedStatus && opts.sharedStatus[key]) {
        return new Response('err', { status: opts.sharedStatus[key] });
      }
      const value = key in sharedStore ? sharedStore[key] : null;
      return new Response(JSON.stringify({ result: value }), { status: 200 });
    }
    if (u.startsWith(ORG_URL)) {
      // org SET (['SET', key, value, 'EX', ttl]) or notifyChange's PUBLISH/XADD
      try {
        const body = JSON.parse(init?.body || '[]');
        if (body[0] === 'SET') orgWrites.push({ key: body[1], value: body[2], ttl: body[4] });
      } catch { /* pipeline / other shapes — ignore for this test */ }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
}

describe('sync-ais-results bridge', () => {
  beforeEach(() => {
    process.env.AIS_RESULTS_UPSTASH_REST_URL = SHARED_URL;
    process.env.AIS_RESULTS_UPSTASH_READONLY_TOKEN = 'ro-token';
    process.env.UPSTASH_REDIS_REST_URL = ORG_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = 'org-token';
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  it('copies the canonical + seed-meta from the shared store into the org DB with re-applied TTLs', async () => {
    const orgWrites = [];
    installFetch({
      [CANONICAL]: JSON.stringify({ _seed: { fetchedAt: 1 }, data: { transits: {} } }),
      [META]: JSON.stringify({ fetchedAt: 1, recordCount: 13 }),
    }, orgWrites);

    await main();

    const canon = orgWrites.find((w) => w.key === CANONICAL);
    const meta = orgWrites.find((w) => w.key === META);
    assert.ok(canon, 'canonical was written to the org DB');
    assert.equal(canon.ttl, 3600, 'canonical TTL matches ais-relay.cjs CHOKEPOINT_TRANSIT_TTL');
    assert.match(canon.value, /"data"/, 'the envelope is copied verbatim, not unwrapped');
    assert.ok(meta, 'seed-meta was written to the org DB');
    assert.equal(meta.ttl, 604800);
  });

  it('is a clean no-op when the shared credentials are absent', async () => {
    delete process.env.AIS_RESULTS_UPSTASH_REST_URL;
    const orgWrites = [];
    installFetch({}, orgWrites);
    await main(); // must not throw
    assert.equal(orgWrites.length, 0);
  });

  it('throws (→ exit 1) when the canonical key is absent in the shared store', async () => {
    const orgWrites = [];
    installFetch({ [META]: JSON.stringify({ fetchedAt: 1 }) }, orgWrites); // canonical missing
    await assert.rejects(main(), /chokepoint_transits:v1 was not bridged/);
  });

  it('throws when the shared read fails outright (ingest down)', async () => {
    installFetch({}, [], { sharedThrows: true });
    await assert.rejects(main(), /was not bridged/);
  });

  it('a non-2xx on the seed-meta key does not fail the run if the canonical bridged', async () => {
    const orgWrites = [];
    installFetch(
      { [CANONICAL]: JSON.stringify({ data: {} }), [META]: JSON.stringify({ fetchedAt: 1 }) },
      orgWrites,
      { sharedStatus: { [META]: 500 } },
    );
    await main(); // resolves — canonical is what matters
    assert.ok(orgWrites.some((w) => w.key === CANONICAL));
    assert.ok(!orgWrites.some((w) => w.key === META));
  });
});
