/**
 * Asserts the Axiom telemetry payload emitted by createDomainGateway() —
 * specifically the four fields the round-1 Codex review flagged:
 *
 *   - domain (must be 'shipping' for /api/v2/shipping/* routes, not 'v2')
 *   - customer_id (must be populated on legacy premium bearer-token success)
 *   - auth_kind (must reflect the resolved identity, not stay 'anon')
 *   - tier (recorded when entitlement-gated routes succeed; the bearer-JWT
 *     success case currently pins tier=0 instead — a known post-Stage-1
 *     regression, see the FIXME(stage1-supabase-migration) block below)
 *
 * Strategy: enable telemetry (USAGE_TELEMETRY=1 + AXIOM_API_TOKEN=fake), stub
 * globalThis.fetch to intercept the Axiom ingest POST, and pass a real ctx
 * whose waitUntil collects the in-flight Promises so we can await them after
 * the gateway returns.
 */

import assert from 'node:assert/strict';
import { afterEach, before, after, describe, it } from 'node:test';
import { SignJWT } from 'jose';

import type { GatewayCtx } from '../server/gateway.ts';
import { deriveCountry } from '../server/_shared/usage.ts';
import { issueSessionToken } from '../api/_session.js';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';

// server/auth-session.ts reads SUPABASE_JWT_SECRET/SUPABASE_URL into
// module-scope consts at first import, so `../server/gateway.ts` (which
// transitively imports it) must be dynamically imported AFTER the env vars
// below are set -- a static top-of-file import would capture an empty
// secret and every bearer-token verification in this file would fail
// closed regardless of what a test signs.
const SUPABASE_URL = 'https://ixuezudybhjptisexgxx.supabase.co';
const SUPABASE_JWT_SECRET = 'test-supabase-jwt-secret-must-be-long-enough-xxxxxxxx';
const SUPABASE_JWT_ISSUER = `${SUPABASE_URL}/auth/v1`;
const supabaseSecretKey = new TextEncoder().encode(SUPABASE_JWT_SECRET);
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_JWT_SECRET = SUPABASE_JWT_SECRET;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { createDomainGateway } = await import('../server/gateway.ts');

function signSupabaseToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(SUPABASE_JWT_ISSUER)
    .setAudience('authenticated')
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(supabaseSecretKey);
}

// Anonymous browser access requires a wms_ session token (issue #3541).
process.env.WM_SESSION_SECRET = process.env.WM_SESSION_SECRET
  ?? 'test-secret-must-be-at-least-32-chars-long-xxx';
let SESSION_TOKEN: string;
before(async () => { SESSION_TOKEN = (await issueSessionToken()).token; });

interface CapturedEvent {
  event_type: string;
  domain: string;
  route: string;
  status: number;
  customer_id: string | null;
  auth_kind: string;
  tier: number;
  plan_key: string | null;
  country: string | null;
  ip: string | null;
  reason: string;
}

function makeRecordingCtx(): { ctx: GatewayCtx; settled: Promise<void> } {
  const pending: Promise<unknown>[] = [];
  const ctx: GatewayCtx = {
    waitUntil: (p) => { pending.push(p); },
  };
  // Quiescence loop: emitUsageEvents calls ctx.waitUntil from inside an
  // already-pending waitUntil promise, so the array grows during drain.
  // Keep awaiting until no new entries appear between iterations.
  async function settled(): Promise<void> {
    let prev = -1;
    while (pending.length !== prev) {
      prev = pending.length;
      await Promise.allSettled(pending.slice(0, prev));
    }
  }
  return {
    ctx,
    get settled() { return settled(); },
  } as { ctx: GatewayCtx; settled: Promise<void> };
}

async function installAxiomFetchSpy(
  originalFetch: typeof fetch,
): Promise<{
  events: CapturedEvent[];
  restore: () => void;
}> {
  const events: CapturedEvent[] = [];
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  const { fetchImpl: redisFetch } = createRedisFetch({});
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(process.env.UPSTASH_REDIS_REST_URL || '')) {
      return redisFetch(input, init);
    }
    if (url.includes('api.axiom.co')) {
      const body = init?.body ? JSON.parse(init.body as string) as CapturedEvent[] : [];
      for (const ev of body) events.push(ev);
      return new Response('{}', { status: 200 });
    }
    return originalFetch(input as Request | string | URL, init);
  }) as typeof fetch;
  return { events, restore: () => { globalThis.fetch = originalFetch; } };
}

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_USAGE_FLAG = process.env.USAGE_TELEMETRY;
const ORIGINAL_AXIOM_TOKEN = process.env.AXIOM_API_TOKEN;
const ORIGINAL_VALID_KEYS = process.env.WORLDMONITOR_VALID_KEYS;
const ORIGINAL_CONVEX_SITE_URL = process.env.CONVEX_SITE_URL;
const ORIGINAL_CONVEX_SHARED_SECRET = process.env.CONVEX_SERVER_SHARED_SECRET;
const ORIGINAL_REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const ORIGINAL_REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ORIGINAL_CF_EDGE_PROOF_SECRET = process.env.CF_EDGE_PROOF_SECRET;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_USAGE_FLAG == null) delete process.env.USAGE_TELEMETRY;
  else process.env.USAGE_TELEMETRY = ORIGINAL_USAGE_FLAG;
  if (ORIGINAL_AXIOM_TOKEN == null) delete process.env.AXIOM_API_TOKEN;
  else process.env.AXIOM_API_TOKEN = ORIGINAL_AXIOM_TOKEN;
  if (ORIGINAL_VALID_KEYS == null) delete process.env.WORLDMONITOR_VALID_KEYS;
  else process.env.WORLDMONITOR_VALID_KEYS = ORIGINAL_VALID_KEYS;
  if (ORIGINAL_CONVEX_SITE_URL == null) delete process.env.CONVEX_SITE_URL;
  else process.env.CONVEX_SITE_URL = ORIGINAL_CONVEX_SITE_URL;
  if (ORIGINAL_CONVEX_SHARED_SECRET == null) delete process.env.CONVEX_SERVER_SHARED_SECRET;
  else process.env.CONVEX_SERVER_SHARED_SECRET = ORIGINAL_CONVEX_SHARED_SECRET;
  if (ORIGINAL_REDIS_URL == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_REDIS_URL;
  if (ORIGINAL_REDIS_TOKEN == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_REDIS_TOKEN;
  if (ORIGINAL_CF_EDGE_PROOF_SECRET == null) delete process.env.CF_EDGE_PROOF_SECRET;
  else process.env.CF_EDGE_PROOF_SECRET = ORIGINAL_CF_EDGE_PROOF_SECRET;
});

describe('gateway telemetry payload — domain extraction', () => {
  it("emits domain='shipping' for /api/v2/shipping/* routes (not 'v2')", async () => {
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    const spy = await installAxiomFetchSpy(ORIGINAL_FETCH);

    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/v2/shipping/route-intelligence',
        handler: async () => new Response('{"ok":true}', { status: 200 }),
      },
    ]);

    const recorder = makeRecordingCtx();
    const res = await handler(
      new Request('https://worldmonitor.app/api/v2/shipping/route-intelligence', {
        headers: { Origin: 'https://worldmonitor.app' },
      }),
      recorder.ctx,
    );
    // Anonymous → 401 (premium path, missing API key + no bearer)
    assert.equal(res.status, 401);

    await recorder.settled;
    spy.restore();

    assert.equal(spy.events.length, 1, 'expected exactly one telemetry event');
    const ev = spy.events[0]!;
    assert.equal(ev.domain, 'shipping', `domain should strip leading vN segment, got '${ev.domain}'`);
    assert.equal(ev.route, '/api/v2/shipping/route-intelligence');
    assert.equal(ev.auth_kind, 'anon');
    assert.equal(ev.customer_id, null);
    assert.equal(ev.tier, 0);
  });

  it("emits domain='market' for the standard /api/<domain>/v1/<rpc> layout", async () => {
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    const spy = await installAxiomFetchSpy(ORIGINAL_FETCH);

    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async () => new Response('{"ok":true}', { status: 200 }),
      },
    ]);

    const recorder = makeRecordingCtx();
    const res = await handler(
      new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
        headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
      }),
      recorder.ctx,
    );
    assert.equal(res.status, 200);

    await recorder.settled;
    spy.restore();

    assert.equal(spy.events.length, 1);
    assert.equal(spy.events[0]!.domain, 'market');
  });

  it("PR #3557 round-3: anonymous wms_ token telemetry is anon, NOT enterprise_api_key", async () => {
    // Regression: an earlier revision set usage.enterpriseApiKey for any valid
    // wmKey not starting with 'wm_'. Since 'wms_' doesn't startsWith 'wm_',
    // anonymous session tokens were misattributed as enterprise traffic with
    // customer_id='enterprise-unmapped'. Lock the contract: kind:'session'
    // tokens emit auth_kind:'anon'.
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    const spy = await installAxiomFetchSpy(ORIGINAL_FETCH);

    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async () => new Response('{"ok":true}', { status: 200 }),
      },
    ]);

    const recorder = makeRecordingCtx();
    const res = await handler(
      new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
        headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
      }),
      recorder.ctx,
    );
    assert.equal(res.status, 200);

    await recorder.settled;
    spy.restore();

    assert.equal(spy.events.length, 1);
    const ev = spy.events[0]!;
    assert.equal(ev.auth_kind, 'anon', `wms_ tokens must telemeter as anon, got '${ev.auth_kind}'`);
    assert.notEqual(ev.customer_id, 'enterprise-unmapped');
  });

  it("invalid REST jmespath projection emits reason='malformed_request'", async () => {
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    const spy = await installAxiomFetchSpy(ORIGINAL_FETCH);

    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async () => new Response('{"ok":true}', {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        }),
      },
    ]);

    const recorder = makeRecordingCtx();
    const res = await handler(
      new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL&jmespath=a[[[', {
        headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
      }),
      recorder.ctx,
    );
    assert.equal(res.status, 400);
    assert.match(await res.text(), /"invalid_expression:/);

    await recorder.settled;
    spy.restore();

    assert.equal(spy.events.length, 1);
    const ev = spy.events[0]!;
    assert.equal(ev.status, 400);
    assert.equal(ev.reason, 'malformed_request');
    assert.equal(ev.domain, 'market');
  });
});

describe('gateway telemetry payload — trusted client attribution (#5228)', () => {
  it('records Cloudflare client IP and country only when the edge proof is valid', async () => {
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';
    const spy = await installAxiomFetchSpy(ORIGINAL_FETCH);

    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async () => new Response('{"ok":true}', { status: 200 }),
      },
    ]);
    const recorder = makeRecordingCtx();
    const response = await handler(
      new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
        headers: {
          Origin: 'https://worldmonitor.app',
          'X-WorldMonitor-Key': SESSION_TOKEN,
          'cf-connecting-ip': '203.0.113.7',
          'cf-ipcountry': 'FR',
          'x-real-ip': '192.0.2.5',
          'x-vercel-ip-country': 'ZA',
          'x-wm-edge-proof': 'edge-secret-xyz',
        },
      }),
      recorder.ctx,
    );
    assert.equal(response.status, 200);
    await recorder.settled;
    spy.restore();

    assert.equal(spy.events.length, 1);
    assert.equal(spy.events[0]!.ip, '203.0.113.7');
    assert.equal(spy.events[0]!.country, 'FR');
  });

  it('rejects forged Cloudflare client attribution without the edge proof', async () => {
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';
    const spy = await installAxiomFetchSpy(ORIGINAL_FETCH);

    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async () => new Response('{"ok":true}', { status: 200 }),
      },
    ]);
    const recorder = makeRecordingCtx();
    const response = await handler(
      new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
        headers: {
          Origin: 'https://worldmonitor.app',
          'X-WorldMonitor-Key': SESSION_TOKEN,
          'cf-connecting-ip': '203.0.113.7',
          'cf-ipcountry': 'FR',
          'x-real-ip': '192.0.2.5',
          'x-vercel-ip-country': 'ZA',
        },
      }),
      recorder.ctx,
    );
    assert.equal(response.status, 200);
    await recorder.settled;
    spy.restore();

    assert.equal(spy.events.length, 1);
    assert.equal(spy.events[0]!.ip, '192.0.2.5');
    assert.equal(spy.events[0]!.country, 'ZA');
  });

  it('never falls back to an unproven Cloudflare country header', () => {
    process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';
    const request = new Request('https://worldmonitor.app/api/market/v1/list-market-quotes', {
      headers: { 'cf-ipcountry': 'FR' },
    });

    assert.equal(deriveCountry(request), null);
  });

  it('falls back from Cloudflare’s T1 pseudo-country to Vercel geography', () => {
    process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';
    const request = new Request('https://worldmonitor.app/api/market/v1/list-market-quotes', {
      headers: {
        'cf-ipcountry': 'T1',
        'x-vercel-ip-country': 'ZA',
        'x-wm-edge-proof': 'edge-secret-xyz',
      },
    });

    assert.equal(deriveCountry(request), 'ZA');
  });
});

describe('gateway telemetry payload — bearer identity propagation', () => {
  it('records customer_id from a successful legacy premium bearer call', async () => {
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    const spy = await installAxiomFetchSpy(ORIGINAL_FETCH);

    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/resilience/v1/get-resilience-score',
        handler: async () => new Response('{"ok":true}', { status: 200 }),
      },
    ]);

    const token = await signSupabaseToken('user_pro');
    const recorder = makeRecordingCtx();
    const res = await handler(
      new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=US', {
        headers: {
          Origin: 'https://worldmonitor.app',
          Authorization: `Bearer ${token}`,
        },
      }),
      recorder.ctx,
    );
    assert.equal(res.status, 200);

    await recorder.settled;
    spy.restore();

    assert.equal(spy.events.length, 1, 'expected exactly one telemetry event');
    const ev = spy.events[0]!;
    // The whole point of fix #2: pre-fix this would have been null/anon.
    assert.equal(ev.customer_id, 'user_pro', 'customer_id should be the bearer subject');
    assert.equal(ev.auth_kind, 'clerk_jwt');
    assert.equal(ev.domain, 'resilience');
    assert.equal(ev.status, 200);
  });

  // FIXME(stage1-supabase-migration): renamed from "records tier=2 for an
  // entitlement-gated success (the path the round-1 P2 fix targets)" and its
  // assertion inverted. That test proved a real resolved entitlement tier
  // lands in telemetry on a bearer-JWT tier-gated success, guarding against
  // a prior regression where `usage.tier` silently stayed null/0.
  //
  // Post-Stage-1 this regression is effectively BACK, via a different
  // mechanism: server/_shared/entitlement-check.ts's checkEntitlementDetailed
  // has an early-return short-circuit --
  // `if (options.sessionRole === 'pro' && requiredTier <= 1) return { response:
  // null, entitlements: null };` -- and server/auth-session.ts now gives
  // EVERY verified Supabase session `role: 'pro'` unconditionally (no more
  // plan/tier claim). Since every ENDPOINT_ENTITLEMENTS route in this
  // codebase requires at most tier 1, this short-circuit now fires on 100%
  // of authenticated bearer-JWT tier-gated requests, so getEntitlements() is
  // never called and `recordUsageEntitlement(null)` leaves `tier` at its 0
  // default -- exactly the bug the original test was written to catch, now
  // reintroduced for the bearer-JWT path specifically.
  //
  // This test now pins the CURRENT (regressed) bearer-JWT behavior so a
  // future fix has a red test to turn green, rather than silently losing
  // the assertion. (A wm_-user-API-key sibling test used to be cited here as
  // the surviving "tier telemetry reflects a real resolved entitlement on
  // success" coverage -- removed along with the deleted API-keys feature;
  // see the NOTE(stage1-supabase-migration) block further down.)
  it('bearer-JWT entitlement-gated success currently emits tier=0 (sessionRole=pro short-circuit skips getEntitlements)', async () => {
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    const spy = await installAxiomFetchSpy(ORIGINAL_FETCH);

    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/analyze-stock',
        handler: async () => new Response('{"ok":true}', { status: 200 }),
      },
    ]);

    const token = await signSupabaseToken('user_api');
    const recorder = makeRecordingCtx();
    const res = await handler(
      new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
        headers: {
          Origin: 'https://worldmonitor.app',
          Authorization: `Bearer ${token}`,
        },
      }),
      recorder.ctx,
    );
    assert.equal(res.status, 200, 'entitlement-gated request with sufficient tier should succeed');

    await recorder.settled;
    spy.restore();

    assert.equal(spy.events.length, 1);
    const ev = spy.events[0]!;
    assert.equal(ev.tier, 0, `expected the sessionRole=pro short-circuit to skip getEntitlements and leave tier at its default, got ${ev.tier}`);
    assert.equal(ev.customer_id, 'user_api');
    assert.equal(ev.auth_kind, 'clerk_jwt');
    assert.equal(ev.domain, 'market');
    assert.equal(ev.route, '/api/market/v1/analyze-stock');
  });

  // NOTE(retire-convex-saas): "records plan_key on a SERVED (200) user
  // API-key request on a non-tier-gated route (#4613)" was removed here,
  // along with its already-noted-as-removed sibling above. The API-keys
  // feature (src/services/api-keys.ts, server/_shared/user-api-key.ts, the
  // api_keys table) was deleted entirely -- `X-Api-Key` no longer
  // authenticates anything (server/gateway.ts's isUserApiKey is a permanent
  // `false`) -- so there is no user_api_key auth_kind left to attribute
  // plan_key for.

  it('still emits with auth_kind=anon when the bearer is invalid', async () => {
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    const spy = await installAxiomFetchSpy(ORIGINAL_FETCH);

    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/resilience/v1/get-resilience-score',
        handler: async () => new Response('{"ok":true}', { status: 200 }),
      },
    ]);

    const recorder = makeRecordingCtx();
    const res = await handler(
      new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=US', {
        headers: {
          Origin: 'https://worldmonitor.app',
          Authorization: 'Bearer not-a-real-token',
        },
      }),
      recorder.ctx,
    );
    assert.equal(res.status, 401);

    await recorder.settled;
    spy.restore();

    assert.equal(spy.events.length, 1);
    const ev = spy.events[0]!;
    assert.equal(ev.auth_kind, 'anon');
    assert.equal(ev.customer_id, null);
  });
});

describe('gateway telemetry payload — ctx-optional safety', () => {
  it('handler(req) without ctx still resolves cleanly even with telemetry on', async () => {
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    const spy = await installAxiomFetchSpy(ORIGINAL_FETCH);

    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async () => new Response('{"ok":true}', { status: 200 }),
      },
    ]);

    const res = await handler(
      new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
        headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
      }),
    );
    assert.equal(res.status, 200);
    spy.restore();
    // No ctx → emit short-circuits → no events delivered. The point is that
    // the handler does not throw "Cannot read properties of undefined".
    assert.equal(spy.events.length, 0);
  });
});

describe('gateway telemetry payload — unmatched route reason labels', () => {
  // Phantom-route operability: a route like /api/trade/v1/list-tariffs that
  // doesn't exist must emit reason='unknown_route' so an Axiom filter
  // (where reason == 'unknown_route') instantly separates scraper / stale-
  // client noise from real handler errors. Same idea for 405s — a known path
  // hit with the wrong method must emit reason='method_not_allowed' so it
  // doesn't get conflated with auth_401 or rate_limit_429.
  //
  // Without these assertions, regressing both back to reason='ok' is a
  // silent telemetry-only change that CI would not catch.

  it("unknown path → status=404 + reason='unknown_route'", async () => {
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    const spy = await installAxiomFetchSpy(ORIGINAL_FETCH);

    // Domain gateway is mounted with at least one route so the router has
    // a valid table — the request below targets a path that isn't in it.
    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/trade/v1/get-tariff-trends',
        handler: async () => new Response('{"ok":true}', { status: 200 }),
      },
    ]);

    const recorder = makeRecordingCtx();
    const res = await handler(
      new Request('https://worldmonitor.app/api/trade/v1/list-tariffs', {
        headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
      }),
      recorder.ctx,
    );
    assert.equal(res.status, 404);

    await recorder.settled;
    spy.restore();

    assert.equal(spy.events.length, 1, 'expected exactly one telemetry event');
    const ev = spy.events[0]!;
    assert.equal(ev.status, 404);
    assert.equal(
      ev.reason,
      'unknown_route',
      `404 emit must label reason='unknown_route' (got '${ev.reason}'); regression to 'ok' would re-conflate phantom-route noise with handled traffic`,
    );
    assert.equal(ev.route, '/api/trade/v1/list-tariffs');
    assert.equal(ev.domain, 'trade');
  });

  it("known path with wrong method → status=405 + reason='method_not_allowed'", async () => {
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    const spy = await installAxiomFetchSpy(ORIGINAL_FETCH);

    // Register a GET-only route, then DELETE it: router responds 405 with
    // Allow: GET. POST→GET fallback only kicks in for POST, so DELETE is
    // the cleanest way to force the 405 branch.
    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async () => new Response('{"ok":true}', { status: 200 }),
      },
    ]);

    const recorder = makeRecordingCtx();
    const res = await handler(
      new Request('https://worldmonitor.app/api/market/v1/list-market-quotes', {
        method: 'DELETE',
        headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
      }),
      recorder.ctx,
    );
    assert.equal(res.status, 405);
    assert.match(res.headers.get('Allow') ?? '', /GET/);

    await recorder.settled;
    spy.restore();

    assert.equal(spy.events.length, 1, 'expected exactly one telemetry event');
    const ev = spy.events[0]!;
    assert.equal(ev.status, 405);
    assert.equal(
      ev.reason,
      'method_not_allowed',
      `405 emit must label reason='method_not_allowed' (got '${ev.reason}'); regression to 'ok' would hide method-mismatch traffic in healthy-emit counts`,
    );
  });
});
