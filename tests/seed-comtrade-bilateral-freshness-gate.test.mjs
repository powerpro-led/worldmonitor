// Regression test for the seed-comtrade-bilateral-hs4 freshness gate.
// Backstop against the Comtrade Free APIs 500/month quota being burned by a
// stuck-on cron. Discovered 2026-05-11: Railway cron was set to daily but
// only fired once every ~2 weeks via Watch-Paths accident; if the filter
// ever starts firing reliably, daily × ~396 calls = ~24× over quota. The
// gate inside the seeder is the belt-and-suspenders defense regardless of
// cron cadence.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  checkSeedMetaFreshness,
  CRON_PERIOD_SECONDS,
  FRESHNESS_GATE_MS,
  SEED_META_TTL_SECONDS,
  TTL_SECONDS,
} from '../scripts/seed-comtrade-bilateral-hs4.mjs';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const ORIGINAL_REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function mockRedisGet(value) {
  // Upstash REST /pipeline returns an array of { result } objects.
  globalThis.fetch = async () =>
    new Response(JSON.stringify([{ result: value }]), { status: 200 });
}

function mockRedisError() {
  globalThis.fetch = async () =>
    new Response('boom', { status: 500 });
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_REDIS_URL === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_REDIS_URL;
  if (ORIGINAL_REDIS_TOKEN === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_REDIS_TOKEN;
});

test('checkSeedMetaFreshness: fresh seed (1 day old) reports fresh=true', async () => {
  const now = Date.now();
  mockRedisGet(JSON.stringify({ fetchedAt: now - 1 * 86_400_000, recordCount: 180, status: 'ok' }));
  const result = await checkSeedMetaFreshness(now);
  assert.equal(result.fresh, true);
  assert.equal(result.reason, 'within-gate');
});

test('checkSeedMetaFreshness: stale seed (25 days old) reports fresh=false', async () => {
  const now = Date.now();
  mockRedisGet(JSON.stringify({ fetchedAt: now - 25 * 86_400_000, recordCount: 180, status: 'ok' }));
  const result = await checkSeedMetaFreshness(now);
  assert.equal(result.fresh, false);
  assert.equal(result.reason, 'stale');
});

test('checkSeedMetaFreshness: exactly at the 24-day gate boundary is treated as stale', async () => {
  // The gate is `ageMs < FRESHNESS_GATE_MS` (strict <), so exactly-at-gate
  // falls through to a re-seed. Pins the boundary so a future refactor that
  // flips the comparison to `<=` has to update this assertion.
  const now = Date.now();
  mockRedisGet(JSON.stringify({ fetchedAt: now - 24 * 86_400_000, recordCount: 180, status: 'ok' }));
  const result = await checkSeedMetaFreshness(now);
  assert.equal(result.fresh, false, 'exactly-at-gate falls through to re-seed');
});

test('checkSeedMetaFreshness: missing seed-meta returns fresh=false (no-meta)', async () => {
  mockRedisGet(null);
  const result = await checkSeedMetaFreshness(Date.now());
  assert.equal(result.fresh, false);
  assert.equal(result.reason, 'no-meta');
});

test('checkSeedMetaFreshness: malformed seed-meta returns fresh=false (no-fetchedAt)', async () => {
  mockRedisGet(JSON.stringify({ recordCount: 5 })); // missing fetchedAt
  const result = await checkSeedMetaFreshness(Date.now());
  assert.equal(result.fresh, false);
  assert.equal(result.reason, 'no-fetchedAt');
});

test('checkSeedMetaFreshness: invalid JSON in seed-meta returns fresh=false (read-error)', async () => {
  mockRedisGet('not-valid-json');
  const result = await checkSeedMetaFreshness(Date.now());
  assert.equal(result.fresh, false);
  assert.equal(result.reason, 'read-error');
});

test('checkSeedMetaFreshness: Redis HTTP 500 fails open (fresh=false, reason=read-error)', async () => {
  mockRedisError();
  const result = await checkSeedMetaFreshness(Date.now());
  assert.equal(result.fresh, false);
  assert.equal(result.reason, 'read-error');
});

test('checkSeedMetaFreshness: fetchedAt:0 (legacy bad write) treated as no-fetchedAt', async () => {
  mockRedisGet(JSON.stringify({ fetchedAt: 0 }));
  const result = await checkSeedMetaFreshness(Date.now());
  assert.equal(result.fresh, false);
  assert.equal(result.reason, 'no-fetchedAt');
});

// ── Regression: a failed/empty run must not arm the gate ─────────────────────
// Discovered 2026-08-17 while live-testing category 5 of the 156-seed-source
// sweep. Production seed-meta read {fetchedAt: 21.2d ago, recordCount: 0,
// status: 'ok'} — a run where every reporter returned zero rows (no
// COMTRADE_API_KEYS, so the keyless public preview endpoint answers HTTP 200
// with {"count":0,"data":[]}). main()'s success path stamped fetchedAt=now with
// the default status='ok', and the gate keyed on fetchedAt alone, so the seeder
// suppressed its own retries for 24 days. Every pre-existing test above passes
// recordCount: 180 / status: 'ok', so none of them exercised this shape.

test('checkSeedMetaFreshness: recent run with recordCount 0 does NOT arm the gate', async () => {
  const now = Date.now();
  mockRedisGet(JSON.stringify({ fetchedAt: now - 1 * 86_400_000, recordCount: 0, status: 'ok' }));
  const result = await checkSeedMetaFreshness(now);
  assert.equal(result.fresh, false, 'an empty run must not block the next attempt');
  assert.equal(result.reason, 'last-run-empty');
});

test('checkSeedMetaFreshness: the exact stuck production record self-heals', async () => {
  // Byte-for-byte the shape observed in Redis on 2026-08-17: inside the 24d
  // gate, reporting ok, but holding zero records. Before the fix this returned
  // fresh=true and blocked the re-seed that would have seeded real data.
  const now = Date.now();
  mockRedisGet(JSON.stringify({ fetchedAt: now - 21.2 * 86_400_000, recordCount: 0, status: 'ok' }));
  const result = await checkSeedMetaFreshness(now);
  assert.equal(result.fresh, false, 'the stuck record must not keep gating once the fix ships');
});

test('checkSeedMetaFreshness: recent run with status error does NOT arm the gate', async () => {
  const now = Date.now();
  mockRedisGet(JSON.stringify({ fetchedAt: now - 1 * 86_400_000, recordCount: 0, status: 'error' }));
  const result = await checkSeedMetaFreshness(now);
  assert.equal(result.fresh, false);
  assert.equal(result.reason, 'last-run-error');
});

test('checkSeedMetaFreshness: a genuine successful run still arms the gate', async () => {
  // Guard the other direction — the fix must not defeat the quota protection
  // the gate exists for. A real run (records > 0, ok) inside the window skips.
  const now = Date.now();
  mockRedisGet(JSON.stringify({ fetchedAt: now - 1 * 86_400_000, recordCount: 180, status: 'ok' }));
  const result = await checkSeedMetaFreshness(now);
  assert.equal(result.fresh, true);
  assert.equal(result.reason, 'within-gate');
});

test('checkSeedMetaFreshness: legacy meta without a status field still gates on records', async () => {
  // Pre-status writes exist in the wild; absence of `status` must not be read
  // as failure, so a legacy record with real data keeps working.
  const now = Date.now();
  mockRedisGet(JSON.stringify({ fetchedAt: now - 1 * 86_400_000, recordCount: 180 }));
  const result = await checkSeedMetaFreshness(now);
  assert.equal(result.fresh, true);
  assert.equal(result.reason, 'within-gate');
});

// ── Regression: data TTL must outlive the cron period ────────────────────────
// Discovered 2026-08-18. TTL_SECONDS was 259200 (72h) while the Railway cron runs
// monthly, so every per-country key expired 3 days after a run and was absent for the
// remaining ~27 — about 10% availability. Confirmed live at the time:
// comtrade:bilateral-hs4:{CN,US,DE}:v1 all returned TTL -2 (key does not exist).
// It never looked broken because _bilateral-hs4-lazy.ts refetches missing keys
// per-request as a degraded fallback, masking the gap.

test('invariant: data TTL outlives the cron period, with slack', () => {
  assert.ok(
    TTL_SECONDS > CRON_PERIOD_SECONDS,
    `TTL_SECONDS (${TTL_SECONDS}s = ${TTL_SECONDS / 86400}d) must exceed the cron period ` +
    `(${CRON_PERIOD_SECONDS}s = ${CRON_PERIOD_SECONDS / 86400}d), or keys die between runs`,
  );
  const slackDays = (TTL_SECONDS - CRON_PERIOD_SECONDS) / 86400;
  assert.ok(
    slackDays >= 3,
    `need >=3d slack for a missed tick or a late cron; got ${slackDays}d`,
  );
});

test('invariant: data TTL is not shorter than the lazy fallback it supersedes', () => {
  // _bilateral-hs4-lazy.ts writes THE SAME comtrade:bilateral-hs4:* namespace on a
  // cache miss. If the seeder's TTL were shorter, the authoritative writer would be
  // undercutting its own fallback's lifetime — which is exactly what the 72h bug did.
  const lazySrc = readFileSync(
    join(import.meta.dirname, '..', 'server', 'worldmonitor', 'supply-chain', 'v1', '_bilateral-hs4-lazy.ts'),
    'utf-8',
  );
  const match = lazySrc.match(/const\s+SUCCESS_TTL\s*=\s*(\d+)/);
  assert.ok(match, 'could not read SUCCESS_TTL from _bilateral-hs4-lazy.ts');
  const lazyTtl = Number(match[1]);
  assert.ok(
    TTL_SECONDS >= lazyTtl,
    `seeder TTL (${TTL_SECONDS / 86400}d) must be >= lazy fallback SUCCESS_TTL (${lazyTtl / 86400}d)`,
  );
});

test('invariant: data TTL also covers the full freshness-gate window', () => {
  // The gate can suppress a re-seed for up to FRESHNESS_GATE_MS. Data must survive at
  // least that long, otherwise the gate blocks a refill while the keys are already gone.
  assert.ok(
    TTL_SECONDS > FRESHNESS_GATE_MS / 1000,
    `TTL_SECONDS (${TTL_SECONDS / 86400}d) must exceed the gate window ` +
    `(${FRESHNESS_GATE_MS / 86400000}d)`,
  );
});

test('invariant: SEED_META_TTL_SECONDS strictly outlives FRESHNESS_GATE_MS', () => {
  // Greptile review on PR #3661 caught the original: meta TTL was 9d while
  // gate was 24d, leaving a 15-day fail-open window between Redis eviction
  // and gate expiry. This invariant prevents the bug from regressing.
  const gateSeconds = FRESHNESS_GATE_MS / 1000;
  assert.ok(
    SEED_META_TTL_SECONDS > gateSeconds,
    `SEED_META_TTL_SECONDS (${SEED_META_TTL_SECONDS}s) must be > FRESHNESS_GATE_MS in seconds (${gateSeconds}s)`,
  );
  // Pin the buffer too — without it the relationship is brittle to clock skew.
  const bufferSeconds = SEED_META_TTL_SECONDS - gateSeconds;
  assert.ok(
    bufferSeconds >= 86_400,
    `seed-meta TTL must outlive the gate by ≥1 day for clock-skew + missed-tick slack (got ${bufferSeconds}s)`,
  );
});

test('invariant: seed-meta TTL chosen by writeMeta covers the full gate window (no fail-open hole)', () => {
  // Property statement: at any t ∈ [0, FRESHNESS_GATE_MS), if a successful run
  // wrote seed-meta at t=0, the meta key must still exist in Redis. Without
  // this property, the gate goes from "skip if fresh" to "fail-open and burn
  // the upstream quota" between TTL-eviction and gate-elapsed.
  for (const tMs of [0, FRESHNESS_GATE_MS / 4, FRESHNESS_GATE_MS / 2, FRESHNESS_GATE_MS - 1]) {
    const tSeconds = tMs / 1000;
    assert.ok(
      tSeconds < SEED_META_TTL_SECONDS,
      `at t=${tSeconds}s after write, meta TTL (${SEED_META_TTL_SECONDS}s) must still cover us`,
    );
  }
});
