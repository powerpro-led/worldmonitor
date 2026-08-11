import assert from 'node:assert/strict';
import { afterEach, describe, it, before, after, mock } from 'node:test';
import { SignJWT } from 'jose';

import { issueSessionToken } from '../api/_session.js';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';

// server/auth-session.ts reads SUPABASE_JWT_SECRET/SUPABASE_URL into
// module-scope consts at first import, so `../server/gateway.ts` (which
// transitively imports it) must be dynamically imported AFTER the env vars
// below are set -- a static top-of-file import would capture an empty
// secret and every bearer-token verification in this file would fail
// closed regardless of what the test signs.
const SUPABASE_URL = 'https://ixuezudybhjptisexgxx.supabase.co';
const SUPABASE_JWT_SECRET = 'test-supabase-jwt-secret-must-be-long-enough-xxxxxxxx';
const SUPABASE_JWT_ISSUER = `${SUPABASE_URL}/auth/v1`;
const supabaseSecretKey = new TextEncoder().encode(SUPABASE_JWT_SECRET);
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_JWT_SECRET = SUPABASE_JWT_SECRET;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { createDomainGateway } = await import('../server/gateway.ts');

/** Signs a Supabase-shaped HS256 bearer token. Every verified token gets
 * role 'pro' post-Stage-1 (server/auth-session.ts) -- there is no more
 * plan/tier claim to vary, so callers only need to supply `sub`. */
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

/** SHA-256 hex digest -- mirrors server/_shared/user-api-key.ts's hashing so
 * the Supabase REST mock below can match `key_hash=eq.<hash>` query params
 * against a raw wm_ key fixture. */
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Installs a global fetch stub answering `worldmonitor.api_keys` PostgREST
 * lookups (server/_shared/user-api-key.ts -> server/_shared/supabase-admin.ts)
 * for a fixed key -> userId map, replacing Stage 1's removed Convex
 * `/api/internal-validate-api-key` mock. Any other Supabase REST path 404s so
 * an unmocked query surfaces as a clean failure rather than a silent allow.
 * Non-Supabase URLs fall through to the previously-installed fetch (so this
 * composes with installRateLimitRedisFake()).
 */
async function installSupabaseApiKeyFetch(keyToUserId: Record<string, string>): Promise<() => void> {
  const previousFetch = globalThis.fetch;
  const hashToUserId = new Map<string, string>();
  for (const [key, userId] of Object.entries(keyToUserId)) {
    hashToUserId.set(await sha256Hex(key), userId);
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/api_keys`)) {
      const parsed = new URL(url);
      if ((init?.method ?? 'GET') !== 'GET') {
        // Fire-and-forget last_used_at touch (PATCH) -- accept silently.
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const keyHashParam = parsed.searchParams.get('key_hash') ?? '';
      const hash = keyHashParam.startsWith('eq.') ? keyHashParam.slice(3) : '';
      const userId = hashToUserId.get(hash);
      if (!userId) {
        return new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(
        JSON.stringify({ id: `key-${hash.slice(0, 8)}`, user_id: userId, name: 'test key', last_used_at: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return previousFetch(input, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = previousFetch; };
}

// User API keys must be canonical `wm_` + 40 lowercase hex — that is the only
// shape generateKey() (src/services/api-keys.ts) ever mints, and since #5379
// validateUserApiKey rejects anything else BEFORE hashing so a malformed key
// cannot burn a SHA-256 + Redis + Convex round-trip. These fixtures previously
// used readable placeholders ('wm_free_test_key') that production could never
// produce, so they exercised the gateway with an impossible input. The Convex
// mocks below match on URL, not on the key or its hash, so the values here are
// arbitrary as long as they are well-shaped.
const FREE_USER_KEY = `wm_${'a'.repeat(40)}`;
const PRO_USER_KEY = `wm_${'b'.repeat(40)}`;
const OWNER_PRO_USER_KEY = `wm_${'c'.repeat(40)}`;

const originalKeys = process.env.WORLDMONITOR_VALID_KEYS;
const originalSessionSecret = process.env.WM_SESSION_SECRET;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalFetch = globalThis.fetch;

function installRateLimitRedisFake(): void {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  const { fetchImpl } = createRedisFetch({});
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (url.startsWith(process.env.UPSTASH_REDIS_REST_URL || '')) {
      return fetchImpl(input, init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

const ISSUE_4609_GATED_ROUTES = [
  { method: 'POST', path: '/api/forecast/v1/trigger-simulation' },
  { method: 'GET', path: '/api/sanctions/v1/list-sanctions-pressure' },
  { method: 'POST', path: '/api/scenario/v1/run-scenario' },
  { method: 'GET', path: '/api/scenario/v1/get-scenario-status' },
  { method: 'GET', path: '/api/supply-chain/v1/get-country-chokepoint-index' },
  { method: 'GET', path: '/api/supply-chain/v1/get-bypass-options' },
  { method: 'GET', path: '/api/supply-chain/v1/get-country-cost-shock' },
  { method: 'GET', path: '/api/supply-chain/v1/get-route-explorer-lane' },
  { method: 'GET', path: '/api/supply-chain/v1/get-route-impact' },
  { method: 'GET', path: '/api/supply-chain/v1/get-country-products' },
  { method: 'GET', path: '/api/supply-chain/v1/get-multi-sector-cost-shock' },
  { method: 'GET', path: '/api/supply-chain/v1/get-sector-dependency' },
  { method: 'GET', path: '/api/trade/v1/list-comtrade-flows' },
  { method: 'GET', path: '/api/trade/v1/get-tariff-trends' },
  { method: 'GET', path: '/api/market/v1/analyze-stock' },
  { method: 'GET', path: '/api/market/v1/get-stock-analysis-history' },
  { method: 'GET', path: '/api/market/v1/backtest-stock' },
  { method: 'GET', path: '/api/market/v1/list-stored-stock-backtests' },
] as const;

// Public routes now require a wms_ session token (issue #3541) — header-only
// origin trust is gone. Mint one for tests that previously relied on
// "trusted browser origin = anonymous public read."
process.env.WM_SESSION_SECRET = originalSessionSecret
  ?? 'test-secret-must-be-at-least-32-chars-long-xxx';
let SESSION_TOKEN: string;
before(async () => {
  installRateLimitRedisFake();
  SESSION_TOKEN = (await issueSessionToken()).token;
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalRedisUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
});

afterEach(() => {
  if (originalKeys == null) delete process.env.WORLDMONITOR_VALID_KEYS;
  else process.env.WORLDMONITOR_VALID_KEYS = originalKeys;
  installRateLimitRedisFake();
  // Keep the session secret stable across tests so SESSION_TOKEN stays valid.
  process.env.WM_SESSION_SECRET = originalSessionSecret
    ?? 'test-secret-must-be-at-least-32-chars-long-xxx';
});

describe('premium gateway API key enforcement', () => {
  it('enforces premium credentials while allowing public market session auth', async () => {
    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/analyze-stock',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        method: 'GET',
        path: '/api/resilience/v1/get-resilience-score',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        method: 'GET',
        path: '/api/resilience/v1/get-resilience-ranking',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        method: 'GET',
        path: '/api/market/v1/get-insider-transactions',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
    ]);

    process.env.WORLDMONITOR_VALID_KEYS = 'real-key-123';

    // Trusted browser origin without credentials — 401 (no API key, no bearer token)
    const browserNoKey = await handler(new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: { Origin: 'https://worldmonitor.app' },
    }));
    assert.equal(browserNoKey.status, 401);
    assert.deepEqual(await browserNoKey.json(), { error: 'API key required' });

    const resilienceScoreNoKey = await handler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=US', {
      headers: { Origin: 'https://worldmonitor.app' },
    }));
    assert.equal(resilienceScoreNoKey.status, 401);

    const resilienceRankingNoKey = await handler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-ranking', {
      headers: { Origin: 'https://worldmonitor.app' },
    }));
    assert.equal(resilienceRankingNoKey.status, 401);

    // Trusted browser origin with valid API key — 200 (API-key holders bypass entitlement check)
    const browserWithKey = await handler(new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: {
        Origin: 'https://worldmonitor.app',
        'X-WorldMonitor-Key': 'real-key-123',
      },
    }));
    assert.equal(browserWithKey.status, 200);

    const resilienceScoreWithKey = await handler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=US', {
      headers: {
        Origin: 'https://worldmonitor.app',
        'X-WorldMonitor-Key': 'real-key-123',
      },
    }));
    assert.equal(resilienceScoreWithKey.status, 200);

    const resilienceRankingWithKey = await handler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-ranking', {
      headers: {
        Origin: 'https://worldmonitor.app',
        'X-WorldMonitor-Key': 'real-key-123',
      },
    }));
    assert.equal(resilienceRankingWithKey.status, 200);

    // Unknown origin — blocked (403 from isDisallowedOrigin before key check)
    const unknownNoKey = await handler(new Request('https://external.example.com/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: { Origin: 'https://external.example.com' },
    }));
    assert.equal(unknownNoKey.status, 403);

    // Public endpoints — anonymous browsers authenticate via the wms_ session token
    // (issue #3541; previously this was a trusted-origin bypass).
    const publicAllowed = await handler(new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
      headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
    }));
    assert.equal(publicAllowed.status, 200);

    const insiderTransactionsAllowed = await handler(new Request('https://worldmonitor.app/api/market/v1/get-insider-transactions?symbol=AAPL', {
      headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
    }));
    assert.equal(insiderTransactionsAllowed.status, 200);
  });

  // NOTE(stage1-supabase-migration): "standardizes issue #4609 Pro RPCs
  // behind the entitlement 403 gate" was removed here. It asserted a wm_ key
  // owner with a "free" (tier 0) entitlement gets 403'd off Pro-tier RPCs.
  // Post-Stage-1, getEntitlements() (server/_shared/entitlement-check.ts) is
  // a pure function of "is there a non-empty, validated userId" -- ANY valid
  // wm_ key now resolves to the fixed {tier:1, apiAccess:true} entitlement,
  // so there is no more "free API key" to construct this scenario with (this
  // is the intended effect of the migration's "no SaaS billing, one
  // operator/org" simplification). "allows issue #4609 Pro RPCs for tier-1
  // entitlements" below now covers the only reachable outcome: any valid key
  // unlocks these routes.

  it('PR #3557 review: anonymous wms_ session token does NOT unlock premium endpoints', async () => {
    // Regression: an earlier revision returned valid:true for wms_ tokens and
    // the gateway treated any non-wm_ valid key as enterprise → entitlement
    // check skipped → premium content served to any anonymous caller. Lock the
    // contract: wms_ on a premium route must 401 (no Pro auth) — never 200.
    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/analyze-stock',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        method: 'GET',
        path: '/api/resilience/v1/get-resilience-score',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
    ]);

    for (const path of ['/api/market/v1/analyze-stock?symbol=AAPL', '/api/resilience/v1/get-resilience-score?countryCode=US']) {
      const res = await handler(new Request(`https://worldmonitor.app${path}`, {
        headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
      }));
      assert.notEqual(res.status, 200, `wms_ MUST NOT unlock ${path} (got ${res.status})`);
    }
  });

  it('strips client-supplied x-user-id before an anonymous session reaches handlers', async () => {
    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async (request) => new Response(JSON.stringify({
          userId: request.headers.get('x-user-id'),
        }), { status: 200 }),
      },
    ]);

    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
      headers: {
        Origin: 'https://worldmonitor.app',
        'X-WorldMonitor-Key': SESSION_TOKEN,
        'x-user-id': 'attacker-controlled-user',
      },
    }));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { userId: null });
  });

});

describe('POST-to-GET compatibility hardening', () => {
  function makePublicMarketHandler() {
    let seenUrl: URL | null = null;
    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async (req) => {
          seenUrl = new URL(req.url);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    ]);
    return {
      handler,
      seenUrl: () => seenUrl,
    };
  }

  function compatPost(body: string, headers: Record<string, string> = {}) {
    return new Request('https://worldmonitor.app/api/market/v1/list-market-quotes', {
      method: 'POST',
      headers: {
        Origin: 'https://worldmonitor.app',
        'X-WorldMonitor-Key': SESSION_TOKEN,
        'Content-Type': 'application/json',
        ...headers,
      },
      body,
    });
  }

  it('converts bounded scalar and array JSON bodies to GET query params', async () => {
    const { handler, seenUrl } = makePublicMarketHandler();
    const body = JSON.stringify({ symbols: ['AAPL', 'MSFT'], includeExtended: true });

    const res = await handler(compatPost(body, { 'Content-Length': String(Buffer.byteLength(body)) }));

    assert.equal(res.status, 200);
    assert.deepEqual(seenUrl()?.searchParams.getAll('symbols'), ['AAPL', 'MSFT']);
    assert.equal(seenUrl()?.searchParams.get('includeExtended'), 'true');
  });

  it('rejects POST-to-GET array expansion over 200 values', async () => {
    const { handler } = makePublicMarketHandler();
    const body = JSON.stringify({
      symbols: Array.from({ length: 201 }, (_, i) => `SYM${i}`),
    });

    const res = await handler(compatPost(body, { 'Content-Length': String(Buffer.byteLength(body)) }));

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: 'Too many values for POST compatibility parameter',
      parameter: 'symbols',
      maxValues: 200,
    });
  });

  it('skips POST-to-GET compatibility before reading bodies with missing, invalid, or oversized Content-Length', async () => {
    const { handler } = makePublicMarketHandler();
    const body = JSON.stringify({ symbols: ['AAPL'] });

    const missingReq = compatPost(body);
    missingReq.clone = () => { throw new Error('POST compatibility must not parse missing-length bodies'); };
    const missing = await handler(missingReq);
    assert.equal(missing.status, 405);

    const invalidReq = compatPost(body, { 'Content-Length': 'abc' });
    invalidReq.clone = () => { throw new Error('POST compatibility must not parse invalid-length bodies'); };
    const invalid = await handler(invalidReq);
    assert.equal(invalid.status, 405);

    const oversizedReq = compatPost(body, { 'Content-Length': '1048576' });
    oversizedReq.clone = () => { throw new Error('POST compatibility must not parse oversized bodies'); };
    const oversized = await handler(oversizedReq);
    assert.equal(oversized.status, 405);
  });

  it('preserves malformed JSON compatibility by falling back to matching GET without query params', async () => {
    const { handler, seenUrl } = makePublicMarketHandler();
    const body = '{not json';

    const res = await handler(compatPost(body, { 'Content-Length': String(Buffer.byteLength(body)) }));

    assert.equal(res.status, 200);
    assert.equal(seenUrl()?.search, '');
  });
});

// ---------------------------------------------------------------------------
// Bearer token auth path for premium endpoints
// ---------------------------------------------------------------------------

describe('premium gateway bearer token auth', () => {
  let handler: (req: Request) => Promise<Response>;

  before(() => {
    process.env.WORLDMONITOR_VALID_KEYS = 'real-key-123';

    handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/analyze-stock',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        method: 'GET',
        path: '/api/resilience/v1/get-resilience-score',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        method: 'GET',
        path: '/api/resilience/v1/get-resilience-ranking',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
    ]);
  });

  // A garbage/mismatched-signature string is a stand-in for "invalid or
  // expired bearer token" post-Stage-1: server/auth-session.ts does local
  // HS256 verification against a fixed secret, so there is no longer a
  // second signing key whose signature would still parse-but-mismatch the
  // way the old Clerk RS256 "wrong key" fixture did -- any string that
  // doesn't verify against SUPABASE_JWT_SECRET fails identically.
  const INVALID_TOKEN = 'not-a-real-supabase-token';

  it('valid Pro bearer token unlocks tier-1 entitlement-gated endpoints without a Postgres row', async () => {
    // role='pro' is now fixed for every verified Supabase session (no more
    // plan/tier claim) -- this is the direct replacement for the old
    // "Clerk role='pro' complimentary/tester grant" signal.
    const token = await signSupabaseToken('user_pro');
    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
      },
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it('rejects invalid/expired bearer token on premium endpoint → 401', async () => {
    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${INVALID_TOKEN}`,
      },
    }));
    // Invalid bearer → no session → forceKey true → 401 (missing API key)
    assert.equal(res.status, 401);
  });

  it('public routes accept the anonymous browser session token', async () => {
    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
      headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
    }));
    assert.equal(res.status, 200);
  });

  it('public routes WITHOUT a session token are rejected (#3541 — header-only trust is gone)', async () => {
    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
      headers: { Origin: 'https://worldmonitor.app' },
    }));
    assert.equal(res.status, 401);
  });

  it('rejects invalid bearer token on resilience premium endpoints → 401', async () => {
    const scoreRes = await handler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=US', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${INVALID_TOKEN}`,
      },
    }));
    assert.equal(scoreRes.status, 401);

    const rankingRes = await handler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-ranking', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${INVALID_TOKEN}`,
      },
    }));
    assert.equal(rankingRes.status, 401);
  });

  it('accepts valid Pro bearer token on resilience premium endpoints → 200', async () => {
    const token = await signSupabaseToken('user_pro');

    const scoreRes = await handler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=US', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
      },
    }));
    assert.equal(scoreRes.status, 200);

    const rankingRes = await handler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-ranking', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
      },
    }));
    assert.equal(rankingRes.status, 200);
  });

  it('rewrites spoofed x-user-id from a verified legacy bearer before reaching handlers', async () => {
    const token = await signSupabaseToken('user_pro');
    const headerEchoHandler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/resilience/v1/get-resilience-score',
        handler: async (request) => new Response(JSON.stringify({
          userId: request.headers.get('x-user-id'),
        }), { status: 200 }),
      },
    ]);

    const res = await headerEchoHandler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=US', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
        'x-user-id': 'attacker-controlled-user',
      },
    }));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { userId: 'user_pro' });
  });

  it('forwards POST body alongside trusted x-user-id on the legacy bearer path', async () => {
    // The gateway rebuilds the Request to inject the trusted x-user-id
    // header on the bearer path (`withAuthenticatedUserId`). The rebuild
    // must use `new Request(originalRequest, { headers })` (WHATWG input-
    // clone semantics) rather than `new Request(url, { body: req.body })`
    // — the latter would either require `duplex: 'half'` under undici or
    // hand the handler a stream already locked by the auth path.
    // This test pins both the body integrity AND the trusted userId
    // override on the same request, so a regression to the broken pattern
    // surfaces immediately on POST bearer auth.
    const token = await signSupabaseToken('user_pro');
    const echoHandler = createDomainGateway([
      {
        method: 'POST',
        path: '/api/intelligence/v1/deduct-situation',
        handler: async (request) => {
          const body = await request.json();
          return new Response(JSON.stringify({
            userId: request.headers.get('x-user-id'),
            body,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        },
      },
    ]);

    const payload = { situation: 'test', evidence: ['a', 'b', 'c'], count: 42 };
    const res = await echoHandler(new Request('https://worldmonitor.app/api/intelligence/v1/deduct-situation', {
      method: 'POST',
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-user-id': 'attacker-controlled-user',
      },
      body: JSON.stringify(payload),
    }));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { userId: 'user_pro', body: payload });
  });
});
