// Unit coverage for notifyMirroredWrites() — the shared helper that closes the
// systemic real-time-sync gap where a seeder building its own redisPipeline()
// SETs mirrored rows directly and never nudges sync-listener.mjs (so the
// domain only refreshes on the 6h full reconciliation). See the helper's own
// comment in scripts/_seed-utils.mjs and TASKS.md's data-pipeline review #4.

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const { notifyMirroredWrites } = await import('../scripts/_seed-utils.mjs');

const URL = 'https://redis.test';
const TOKEN = 'fake-token';
const originalFetch = globalThis.fetch;

/** Collects every Redis command array notifyMirroredWrites() issues. */
function captureFetch({ fail = false } = {}) {
  const commands = [];
  globalThis.fetch = async (_url, options) => {
    commands.push(JSON.parse(options.body));
    if (fail) throw new Error('simulated Upstash outage');
    return { ok: true, status: 200, json: async () => ({ result: 1 }), headers: new Map() };
  };
  return commands;
}

/** The `key` field of every PUBLISH sync:notify message that was sent. */
function publishedKeys(commands) {
  return commands
    .filter((c) => c[0] === 'PUBLISH' && c[1] === 'sync:notify')
    .map((c) => JSON.parse(c[2]).key);
}

beforeEach(() => { globalThis.fetch = originalFetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

test('notifies only the mirrored data SETs in a mixed pipeline', async () => {
  const commands = captureFetch();
  const pipeline = [
    ['SET', 'economic:worldbank-techreadiness:v1', '{"a":1}', 'EX', '3600'],
    ['SET', 'seed-meta:economic:worldbank-techreadiness:v1', '{"recordCount":1}', 'EX', '7200'],
    ['SET', 'economic:worldbank-renewable:v1', '{"b":2}', 'EX', '3600'],
    ['GET', 'seed-meta:economic:worldbank-techreadiness:v1'],
    ['EXPIRE', 'economic:worldbank-techreadiness:v1', '3600'],
  ];

  await notifyMirroredWrites(URL, TOKEN, pipeline);

  assert.deepEqual(
    publishedKeys(commands).sort(),
    ['economic:worldbank-renewable:v1', 'economic:worldbank-techreadiness:v1'],
    'seed-meta:*, GET and EXPIRE entries must not be notified',
  );
  // Each mirrored key fans out to PUBLISH sync:notify + XADD sync:changelog.
  assert.equal(commands.filter((c) => c[0] === 'XADD' && c[1] === 'sync:changelog').length, 2);
});

test('serializes a non-string SET value before inlining it', async () => {
  const commands = captureFetch();
  await notifyMirroredWrites(URL, TOKEN, [
    ['SET', 'resilience:scores:v1', { score: 42 }, 'EX', '3600'],
  ]);

  const publish = commands.find((c) => c[0] === 'PUBLISH');
  assert.ok(publish, 'a PUBLISH was issued');
  const msg = JSON.parse(publish[2]);
  assert.equal(msg.key, 'resilience:scores:v1');
  assert.equal(msg.value, '{"score":42}');
});

test('matches SET case-insensitively', async () => {
  const commands = captureFetch();
  await notifyMirroredWrites(URL, TOKEN, [['set', 'portwatch:port-activity:v1', '{"x":1}']]);
  assert.deepEqual(publishedKeys(commands), ['portwatch:port-activity:v1']);
});

test('is non-throwing when the underlying notify fails', async () => {
  captureFetch({ fail: true });
  await assert.doesNotReject(
    notifyMirroredWrites(URL, TOKEN, [['SET', 'energy:jodi-oil:v1', '{"x":1}', 'EX', '3600']]),
    'a failed nudge must never fail the seed run',
  );
});

test('no-ops on a missing/empty/invalid command list', async () => {
  let called = 0;
  globalThis.fetch = async () => { called += 1; return { ok: true, json: async () => ({}) }; };

  await notifyMirroredWrites(URL, TOKEN, undefined);
  await notifyMirroredWrites(URL, TOKEN, []);
  await notifyMirroredWrites(URL, TOKEN, [['GET', 'economic:x'], ['SET', 'economic:y']]); // SET too short
  await notifyMirroredWrites(URL, TOKEN, [['SET', 'not-a-mirrored-prefix:v1', '{}']]);

  assert.equal(called, 0, 'nothing mirrored → no Redis traffic');
});

test('no-ops without credentials', async () => {
  let called = 0;
  globalThis.fetch = async () => { called += 1; return { ok: true, json: async () => ({}) }; };
  await notifyMirroredWrites('', '', [['SET', 'economic:worldbank-renewable:v1', '{}']]);
  assert.equal(called, 0);
});
