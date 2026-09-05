// Boot-seed freshness guard — behavioral + wiring regression tests.
//
// ais-relay is recycled frequently on proxy.example.test. Every seed loop
// fires an IMMEDIATE seed on boot and then schedules a setInterval at its real
// cadence — but the process is usually recycled long before that interval
// elapses, so the boot seed is the de-facto scheduler. During a reboot storm
// that re-fetches every upstream on every boot (~8 min apart) instead of on its
// interval: paid ScrapeCreators credits, plus rate-limit/ban risk for Reddit,
// Yahoo, CoinGecko, UCDP, OpenSky, etc.
//
// `bootSeedDelayMs(label, metaKey, intervalMs)` gates the boot seed on the
// existing seed-meta age, and `startBootSeedLoop` schedules the first skipped
// refresh for the remaining freshness window before starting the recurring
// interval.
//
// ais-relay.cjs calls server.listen() at top level and has no module.exports, so
// it cannot be imported. These tests (1) extract the real guard/scheduler bodies
// and exercise them against mocked Redis/timers, and (2) assert the source wires
// every fixed-schedule external seeder AND internal warm-ping through the
// scheduler while leaving real-time pollers (Telegram/OREF) untouched.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const relaySource = readFileSync(resolve(here, '../scripts/ais-relay.cjs'), 'utf8');

// -- Extract real function bodies via brace-matching ---------------------------
function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `missing function: ${signature}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${signature}`);
}

function extractNamedFunction(src, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)`).exec(src);
  assert.ok(match, `missing function: ${name}`);
  return extractFunction(src, match[0]);
}

const delayFnText = extractFunction(relaySource, 'async function bootSeedDelayMs(label, metaKey, intervalMs)');
const loopFnText = extractFunction(relaySource, 'function startBootSeedLoop(label, metaKey, intervalMs, seedFn, onInitialError, onSeedError = onInitialError)');

// Rebuild the function with its free variables injected as closure params.
// (It references UPSTASH_ENABLED, upstashGet, console, plus globals Date/Number/Math.)
function buildDelayResolver({ enabled = true, get = async () => null } = {}) {
  const logs = [];
  const fakeConsole = { log: (...a) => logs.push(['log', ...a]), warn: (...a) => logs.push(['warn', ...a]) };
  const factory = new Function('UPSTASH_ENABLED', 'upstashGet', 'console', `return (${delayFnText});`);
  return { resolveDelay: factory(enabled, get, fakeConsole), logs };
}

function buildLoop({ delay = 0 } = {}) {
  const timeouts = [];
  const intervals = [];
  const initialErrors = [];
  const seedErrors = [];
  let seedCalls = 0;
  const fakeSetTimeout = (fn, ms) => {
    const timer = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
    timeouts.push(timer);
    return timer;
  };
  const fakeSetInterval = (fn, ms) => {
    const timer = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
    intervals.push(timer);
    return timer;
  };
  const fakeDelayResolver = async () => delay;
  const factory = new Function('bootSeedDelayMs', 'setTimeout', 'setInterval', `return (${loopFnText});`);
  const loop = factory(fakeDelayResolver, fakeSetTimeout, fakeSetInterval);
  const seedFn = async () => { seedCalls++; };
  const onInitialError = (e) => { initialErrors.push(e); };
  const onSeedError = (e) => { seedErrors.push(e); };
  return {
    loop,
    seedFn,
    onInitialError,
    onSeedError,
    timeouts,
    intervals,
    initialErrors,
    seedErrors,
    get seedCalls() { return seedCalls; },
  };
}

const MIN = 60 * 1000;

async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test('returns the remaining freshness window when data is fresher than the interval', async () => {
  const { resolveDelay } = buildDelayResolver({ get: async () => ({ fetchedAt: Date.now() - 5 * MIN, recordCount: 10 }) });
  const delayMs = await resolveDelay('X', 'seed-meta:x', 180 * MIN);
  assert.ok(delayMs > 174 * MIN && delayMs <= 175 * MIN, `fresh data should delay roughly 175min, got ${delayMs}`);
});

test('returns 0 delay when data is older than the interval (refresh due)', async () => {
  const { resolveDelay } = buildDelayResolver({ get: async () => ({ fetchedAt: Date.now() - 200 * MIN, recordCount: 10 }) });
  assert.equal(await resolveDelay('X', 'seed-meta:x', 180 * MIN), 0);
});

test('returns 0 delay when there is no prior seed-meta', async () => {
  const { resolveDelay } = buildDelayResolver({ get: async () => null });
  assert.equal(await resolveDelay('X', 'seed-meta:x', 180 * MIN), 0);
});

test('fails OPEN — a Redis read error returns 0 delay (never starves a panel)', async () => {
  const { resolveDelay, logs } = buildDelayResolver({
    get: async (_key, onFailure) => {
      onFailure('redis down');
      return null;
    },
  });
  assert.equal(await resolveDelay('X', 'seed-meta:x', 180 * MIN), 0);
  assert.ok(logs.some(([lvl, msg]) => lvl === 'warn' && /freshness check failed/.test(String(msg))));
});

test('returns 0 delay when Upstash is disabled (no gate possible)', async () => {
  const { resolveDelay } = buildDelayResolver({ enabled: false, get: async () => ({ fetchedAt: Date.now() }) });
  assert.equal(await resolveDelay('X', 'seed-meta:x', 180 * MIN), 0);
});

test('a future-dated fetchedAt (negative age) is treated defensively — 0 delay', async () => {
  const { resolveDelay } = buildDelayResolver({ get: async () => ({ fetchedAt: Date.now() + 60 * MIN }) });
  assert.equal(await resolveDelay('X', 'seed-meta:x', 180 * MIN), 0);
});

test('intervalMs<=0 disables the gate (0 delay)', async () => {
  const { resolveDelay } = buildDelayResolver({ get: async () => ({ fetchedAt: Date.now() }) });
  assert.equal(await resolveDelay('X', 'seed-meta:x', 0), 0);
});

test('startBootSeedLoop seeds immediately and starts the recurring interval when delay is 0', async () => {
  const harness = buildLoop({ delay: 0 });
  harness.loop('X', 'seed-meta:x', 180 * MIN, harness.seedFn, harness.onInitialError, harness.onSeedError);
  await flushMicrotasks();
  assert.equal(harness.seedCalls, 1);
  assert.equal(harness.timeouts.length, 0);
  assert.equal(harness.intervals.length, 1);
  assert.equal(harness.intervals[0].ms, 180 * MIN);
  assert.equal(harness.intervals[0].unrefCalled, true);
});

test('startBootSeedLoop waits the remaining freshness window before first skipped refresh', async () => {
  const harness = buildLoop({ delay: 60 * MIN });
  harness.loop('X', 'seed-meta:x', 180 * MIN, harness.seedFn, harness.onInitialError, harness.onSeedError);
  await flushMicrotasks();
  assert.equal(harness.seedCalls, 0, 'fresh data must not seed at boot');
  assert.equal(harness.intervals.length, 0, 'recurring interval must not start before the due refresh');
  assert.equal(harness.timeouts.length, 1);
  assert.equal(harness.timeouts[0].ms, 60 * MIN);
  assert.equal(harness.timeouts[0].unrefCalled, true);

  harness.timeouts[0].fn();
  await flushMicrotasks();
  assert.equal(harness.seedCalls, 1, 'remaining-window timer should run the skipped boot seed');
  assert.equal(harness.intervals.length, 1, 'recurring interval starts after the due refresh');
  assert.equal(harness.intervals[0].ms, 180 * MIN);
});

// -- Wiring: every fixed-schedule external seeder routes through
// startBootSeedLoop with the exact (label, metaKey, intervalConst, seedFn). The
// exact-string match pins all four arguments so a future edit can't silently
// drift the meta key or interval and re-open the boot-abuse hole.
const SEEDERS = [
  ['Market', "'seed-meta:market:stocks'", 'MARKET_SEED_INTERVAL_MS', 'seedAllMarketData'],
  ['Classify', "'seed-meta:classify'", 'CLASSIFY_SEED_INTERVAL_MS', 'seedClassify'],
  // The four internal RPC warm-pings that used to be gated here (CII 8m,
  // Chokepoints 30m, CableHealth 30m, TemporalAnomalies 15m) were
  // consolidated into one standalone cron, scripts/seed-rpc-warmpings.mjs,
  // in P14 Phase 2 (session 62 — see PLATFORM_ARCHITECTURE.md). Each RPC
  // handler still owns its own seed-meta key; nothing in ais-relay.cjs
  // warm-pings them any more.
  ['CorridorRisk', "'seed-meta:supply_chain:corridorrisk'", 'CORRIDOR_RISK_SEED_INTERVAL_MS', 'seedCorridorRisk'],
  ['ShippingStress', "'seed-meta:supply_chain:shipping_stress'", 'SHIPPING_STRESS_INTERVAL_MS', 'seedShippingStress'],
  ['Transit', "'seed-meta:supply_chain:chokepoint_transits'", 'CHOKEPOINT_TRANSIT_INTERVAL_MS', 'seedChokepointTransits'],
  ['TransitSummary', "'seed-meta:supply_chain:transit-summaries'", 'TRANSIT_SUMMARY_INTERVAL_MS', 'seedTransitSummaries'],
  // TheaterPosture, ServiceStatuses, Spending, TechEvents, WB, ClimateNewsSeed,
  // ChokepointFlows, and Cyber were removed from ais-relay.cjs entirely in
  // session 61 (PLATFORM_ARCHITECTURE.md P14 Phase 2) — each was a pure
  // duplicate of an already-independently-scheduled scripts/seed-*.mjs (or,
  // for Cyber, fully dead code that was never invoked). UCDP and Weather were
  // deleted in the same pass and then restored (commits 629df49, 7febde9)
  // because their seed functions also published live notifications
  // (conflict_escalation / severe weather alerts) that no standalone script
  // replicated at the time. Session 62 ported that notification logic into
  // scripts/seed-ucdp-events.mjs and scripts/seed-weather-alerts.mjs (see
  // PLATFORM_ARCHITECTURE.md) and removed both loops from here for good —
  // their countryCode/coalesceKey contracts are now asserted against those
  // files directly in tests/notification-relay-country-filter.test.mjs and
  // tests/notification-relay-coalesce-key.test.mjs.
  //
  // GSCPI was removed the same session (S62), as the first of the 17
  // "genuinely unique, no sibling exists anywhere" loops the S61 audit
  // identified as real extraction candidates — unlike the deletions above,
  // it had no standalone script to be redundant WITH, so extraction meant
  // writing scripts/seed-gscpi.mjs new (registered in
  // scripts/railway-services.json + gcp/scheduler/main.ts's CADENCES) rather
  // than just deleting a duplicate. No notification logic to migrate — this
  // loop never called publishNotificationEvent.
  //
  // PositiveEvents was removed in session 63 — ported to
  // scripts/seed-positive-events.mjs (every 15min). Its per-query 5.5s GDELT
  // throttle moved to _gdelt-fetch.mjs's shared cross-process rate gate; the
  // failure semantics are now pinned against the new file in
  // tests/positive-events-seed-failure.test.mjs. No notification logic.
  //
  // SocialVelocity + WsbTickers were removed the same session — ported to
  // scripts/seed-social-velocity.mjs (hand-rolled, keeps the status:'ok'/'error'
  // seed-meta) and scripts/seed-wsb-tickers.mjs (every 3h each). The Reddit
  // fetch path (ScrapeCreators→OAuth→public) moved to scripts/_reddit-hot.cjs;
  // its source contract is now pinned there by tests/reddit-oauth-fetch.test.mjs,
  // and the error-seed-meta behaviour by tests/social-velocity-seed-health.test.mjs.
  // No notification logic.
  //
  // Satellites was removed in session 63 by the same mechanism as GSCPI:
  // straight port to a new scripts/seed-satellites.mjs (CelesTrak TLE fetch),
  // registered in scripts/railway-services.json + gcp/scheduler/main.ts's
  // CADENCES (every 2h). No standalone sibling existed; no notification logic
  // to migrate. USNI followed in the same session — scripts/seed-usni-fleet.mjs
  // (every 6h), HTML parsing still in scripts/lib/usni-fleet-parser.cjs. PizzINT
  // too — scripts/seed-pizzint.mjs (every 10min), pizzint.watch + GDELT tension
  // pairs; no standalone sibling existed, no notification logic.
];

for (const [label, metaKey, intervalConst, seedFn] of SEEDERS) {
  test(`${label} boot seed is scheduled through startBootSeedLoop(${intervalConst}, ${seedFn})`, () => {
    const call = `startBootSeedLoop('${label}', ${metaKey}, ${intervalConst}, ${seedFn},`;
    assert.ok(relaySource.includes(call), `expected boot-seed wiring: ${call}`);
  });
}

test('exactly the expected number of boot seeds are scheduled (no drift)', () => {
  const count = (relaySource.match(/startBootSeedLoop\('/g) || []).length;
  assert.equal(count, SEEDERS.length, `expected ${SEEDERS.length} gated boot seeds, found ${count}`);
});

test('every relay seed loop and warm-ping loop is routed through startBootSeedLoop instead of raw setInterval', () => {
  const seedLoopNames = [...relaySource.matchAll(/(?:async\s+)?function\s+(start[A-Za-z0-9]+(?:SeedLoop|WarmPingLoop))\s*\(/g)]
    .map(([, name]) => name)
    .filter((name) => name !== 'startBootSeedLoop');

  assert.ok(seedLoopNames.length > 0, 'expected to find relay seed/warm-ping loop functions');

  const rawIntervalSeedLoops = [];
  const ungatedSeedLoops = [];
  for (const name of seedLoopNames) {
    const fnText = extractNamedFunction(relaySource, name);
    if (/setInterval\s*\(/.test(fnText)) rawIntervalSeedLoops.push(name);
    if (!/startBootSeedLoop\(/.test(fnText)) ungatedSeedLoops.push(name);
  }

  assert.deepEqual(
    rawIntervalSeedLoops,
    [],
    `seed/warm-ping loops must not schedule raw setInterval; use startBootSeedLoop: ${rawIntervalSeedLoops.join(', ')}`,
  );
  assert.deepEqual(
    ungatedSeedLoops,
    [],
    `seed/warm-ping loops must call startBootSeedLoop: ${ungatedSeedLoops.join(', ')}`,
  );
});

// The dedicated "internal warm-pings no longer fire an unconditional immediate
// boot ping" test that lived here is gone: ServiceStatuses was removed from
// ais-relay.cjs in session 61, and the last four RPC warm-pings (CII,
// Chokepoints, CableHealth, TemporalAnomalies) moved to the standalone
// scripts/seed-rpc-warmpings.mjs in session 62 (P14 Phase 2). No warm-ping loop
// remains in ais-relay.cjs, and the general "every seed/warm-ping loop routes
// through startBootSeedLoop" test above still covers any that come back.

test('real-time pollers are NOT gated (must run continuously on every boot)', () => {
  for (const label of ['Telegram', 'Oref', 'OREF']) {
    assert.ok(!relaySource.includes(`startBootSeedLoop('${label}'`), `poller ${label} must not be gated`);
  }
});

test('bootSeedDelayMs fails open and keys on fetchedAt (source contract)', () => {
  // guard only engages when Upstash is on AND a key + positive interval are given
  assert.match(delayFnText, /if \(UPSTASH_ENABLED && metaKey && intervalMs > 0\)/);
  assert.match(delayFnText, /upstashGet\(metaKey, \(reason\) => \{/);
  // sane positive age strictly under the interval -> delay until the data is due
  assert.match(delayFnText, /if \(ageMs >= 0 && ageMs < intervalMs\)/);
  assert.match(delayFnText, /const delayMs = intervalMs - ageMs/);
  // terminal path always returns 0 delay (fail-open / not-fresh)
  assert.match(delayFnText, /return 0;\s*}$/);
  assert.doesNotMatch(delayFnText, /catch \(e\)/);
  assert.match(loopFnText, /setTimeout\(\(\) => \{/);
  assert.match(loopFnText, /\.finally\(startInterval\)/);
});
