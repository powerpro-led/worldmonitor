import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { main } from '../scripts/sync-shared-results.mjs';

// scripts/sync-shared-results.mjs — the per-org shared→org bridge for
// centralized seeders (CROSS_ORG_SHARED_DATA_PROPOSAL.md session 3). Unlike
// sync-ais-results.mjs's blind poll on 2 hardcoded keys, this walks the
// shared store's sync:changelog stream from a persisted cursor and mirrors
// only what changed. These tests mock globalThis.fetch as two hosts: SHARED
// (read-only — XRANGE/GET/TYPE/SCAN) and ORG (read-write — GET/SET/DEL/
// EXPIRE, plus notifyChange's PUBLISH/XADD).
const SHARED_URL = 'https://data-shared.example.com';
const ORG_URL = 'https://org-db.example.com';
const COMTRADE_KEY = 'comtrade:bilateral-hs4:US:v1';
const META_KEY = 'seed-meta:comtrade:bilateral-hs4';
const CURSOR_KEY = 'sync:shared-bridge:cursor';
const RECONCILE_KEY = 'sync:shared-bridge:last-full-reconcile';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function restoreEnv() {
  for (const k of Object.keys(process.env)) if (!(k in originalEnv)) delete process.env[k];
  Object.assign(process.env, originalEnv);
}

/**
 * @param {{changelog?: Array<[string, string[]]>, values?: Record<string,string>}} shared
 * @param {Record<string,string>} orgStore  mutated in place — the fake org DB
 * @param {{sharedThrows?: boolean}} opts
 */
function installFetch(shared, orgStore, opts = {}) {
  const changelog = shared.changelog || [];
  const values = shared.values || {};

  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const command = JSON.parse(init?.body || '[]');
    const [cmd, ...args] = command;

    if (u.startsWith(SHARED_URL)) {
      if (opts.sharedThrows) throw new Error('shared store unreachable');
      if (cmd === 'XRANGE') {
        const [, start] = args;
        // '-' = everything; '(<id>' = strictly after that id (Redis Streams
        // exclusive-lower-bound syntax) — good enough fidelity for these tests.
        const afterId = start === '-' ? null : start.slice(1);
        const filtered = afterId ? changelog.filter(([id]) => id > afterId) : changelog;
        return new Response(JSON.stringify({ result: filtered }), { status: 200 });
      }
      if (cmd === 'GET') return new Response(JSON.stringify({ result: values[args[0]] ?? null }), { status: 200 });
      if (cmd === 'TYPE') return new Response(JSON.stringify({ result: args[0] in values ? 'string' : 'none' }), { status: 200 });
      if (cmd === 'SCAN') {
        const [, , pattern] = args;
        const prefix = pattern.replace(/\*$/, '');
        const matched = Object.keys(values).filter((k) => k.startsWith(prefix));
        return new Response(JSON.stringify({ result: ['0', matched] }), { status: 200 });
      }
      throw new Error(`unexpected SHARED command: ${cmd}`);
    }

    if (u.startsWith(ORG_URL)) {
      if (cmd === 'GET') return new Response(JSON.stringify({ result: orgStore[args[0]] ?? null }), { status: 200 });
      if (cmd === 'SET') { orgStore[args[0]] = args[1]; return new Response(JSON.stringify({ result: 'OK' }), { status: 200 }); }
      if (cmd === 'DEL') { delete orgStore[args[0]]; return new Response(JSON.stringify({ result: 1 }), { status: 200 }); }
      if (cmd === 'EXPIRE') return new Response(JSON.stringify({ result: 1 }), { status: 200 });
      if (cmd === 'PUBLISH' || cmd === 'XADD') return new Response(JSON.stringify({ result: 'OK' }), { status: 200 }); // notifyChange's fire-and-forget push
      throw new Error(`unexpected ORG command: ${cmd}`);
    }

    throw new Error(`unexpected fetch: ${u}`);
  };
}

describe('sync-shared-results bridge', () => {
  let orgStore;

  beforeEach(() => {
    process.env.DATA_SHARED_UPSTASH_REST_URL = SHARED_URL;
    process.env.DATA_SHARED_UPSTASH_READONLY_TOKEN = 'ro-token';
    process.env.UPSTASH_REDIS_REST_URL = ORG_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = 'org-token';
    orgStore = {
      // Pre-seed the reconcile timestamp key far in the past so the (much
      // more expensive) full-reconcile backstop doesn't fire in tests that
      // only care about the incremental path — matches how a bridge that's
      // been running normally would look in production.
      [RECONCILE_KEY]: String(Date.now()),
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  it('is a clean no-op when the shared credentials are absent', async () => {
    delete process.env.DATA_SHARED_UPSTASH_REST_URL;
    installFetch({}, orgStore);
    await main(); // must not throw
    assert.equal(Object.keys(orgStore).length, 1, 'only the pre-seeded reconcile key remains untouched');
  });

  it('bridges a changed key on the first tick (no prior cursor) and persists the cursor', async () => {
    installFetch(
      {
        changelog: [['1-0', ['key', COMTRADE_KEY, 'type', 'string']]],
        values: { [COMTRADE_KEY]: '{"exports":123}' },
      },
      orgStore,
    );

    await main();

    assert.equal(orgStore[COMTRADE_KEY], '{"exports":123}');
    assert.equal(orgStore[CURSOR_KEY], '1-0', 'cursor advances to the last processed changelog id');
  });

  it('only reads changelog entries after the persisted cursor on the next tick', async () => {
    orgStore[CURSOR_KEY] = '1-0';
    installFetch(
      {
        changelog: [
          ['1-0', ['key', COMTRADE_KEY, 'type', 'string']], // already bridged last tick
          ['2-0', ['key', META_KEY, 'type', 'string']], // new this tick
        ],
        values: { [COMTRADE_KEY]: 'stale-should-not-rewrite', [META_KEY]: '{"recordCount":5}' },
      },
      orgStore,
    );

    await main();

    assert.equal(orgStore[COMTRADE_KEY], undefined, 'entry at/before the cursor is not re-read this tick');
    assert.equal(orgStore[META_KEY], '{"recordCount":5}');
    assert.equal(orgStore[CURSOR_KEY], '2-0');
  });

  it('skips a changelog entry whose key is not a recognized shared-data key (defense in depth)', async () => {
    installFetch(
      { changelog: [['1-0', ['key', 'wm:something-unrelated', 'type', 'string']]], values: { 'wm:something-unrelated': 'x' } },
      orgStore,
    );

    await main();

    assert.equal(orgStore['wm:something-unrelated'], undefined);
    assert.equal(orgStore[CURSOR_KEY], '1-0', 'cursor still advances so this entry is not re-read forever');
  });

  it('applies the comtrade seeder\'s own TTL, not a default, when writing into the org store', async () => {
    // Can't observe the EX argument directly through the simple orgStore map
    // above, so this test intercepts the raw SET command instead.
    const setCalls = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      const command = JSON.parse(init?.body || '[]');
      if (u.startsWith(SHARED_URL)) {
        if (command[0] === 'XRANGE') {
          return new Response(JSON.stringify({ result: [['1-0', ['key', COMTRADE_KEY, 'type', 'string']]] }), { status: 200 });
        }
        if (command[0] === 'GET') return new Response(JSON.stringify({ result: '{"exports":1}' }), { status: 200 });
        throw new Error(`unexpected SHARED command: ${command[0]}`);
      }
      // ORG side: GET on the reconcile-timestamp key reports "just ran" so
      // the full-reconcile backstop stays out of this test's way — it's
      // covered separately, this test only cares about the incremental TTL.
      if (command[0] === 'GET' && command[1] === RECONCILE_KEY) {
        return new Response(JSON.stringify({ result: String(Date.now()) }), { status: 200 });
      }
      if (command[0] === 'SET') setCalls.push(command);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    };

    await main();

    const dataWrite = setCalls.find((c) => c[1] === COMTRADE_KEY);
    assert.ok(dataWrite, 'the comtrade key was SET into the org store');
    assert.equal(dataWrite[3], 'EX');
    // scripts/seed-comtrade-bilateral-hs4.mjs's own TTL_SECONDS: 35 days.
    assert.equal(Number(dataWrite[4]), 35 * 86_400);
  });

  it('throws when the shared store is unreachable (surfaces a broken bridge rather than a silent empty success)', async () => {
    installFetch({}, orgStore, { sharedThrows: true });
    await assert.rejects(main(), /unreachable or misconfigured/);
  });

  it('full-reconcile backstop SCANs and mirrors a key the changelog path never saw, but only when overdue', async () => {
    // beforeEach pre-seeds RECONCILE_KEY as "just ran" so other tests don't
    // pay for a SCAN they don't care about — undo that here to simulate a
    // brand-new org (or one whose bookkeeping key expired) where the
    // backstop is actually due to run.
    delete orgStore[RECONCILE_KEY];
    installFetch(
      { changelog: [], values: { [COMTRADE_KEY]: '{"exports":9}', [META_KEY]: '{"recordCount":1}' } },
      orgStore,
    );

    await main();

    assert.equal(orgStore[COMTRADE_KEY], '{"exports":9}', 'found via SCAN, not the (empty) changelog');
    assert.equal(orgStore[META_KEY], '{"recordCount":1}');
    assert.ok(orgStore[RECONCILE_KEY], 'the reconcile timestamp is persisted after running');

    // A second run right after should NOT re-scan — flip the shared values to
    // prove nothing further gets copied while the gate is still fresh.
    installFetch({ changelog: [], values: { [COMTRADE_KEY]: 'should-not-appear' } }, orgStore);
    await main();
    assert.equal(orgStore[COMTRADE_KEY], '{"exports":9}', 'still the first reconcile\'s value — second run was gated out');
  });
});
