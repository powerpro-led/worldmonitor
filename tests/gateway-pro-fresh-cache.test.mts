import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import { issueSessionToken } from '../api/_session.js';
import { PRO_FRESH_CACHE_RPC_PATHS } from '../src/shared/pro-fresh-rpc.ts';

const ORIGINAL_ENV = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_JWT_PUBLIC_JWK: process.env.SUPABASE_JWT_PUBLIC_JWK,
  WM_SESSION_SECRET: process.env.WM_SESSION_SECRET,
};

const SUPABASE_URL = 'https://ixuezudybhjptisexgxx.supabase.co';
const ISSUER = `${SUPABASE_URL}/auth/v1`;
// Real ES256 keypair -- see tests/auth-session.test.mts for why this must be
// generated, not a fixed HS256 string fixture, now that the module under
// test verifies against a hardcoded public key (server/auth-session.ts).
const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
const publicJwk = await exportJWK(publicKey);

let anonymousSessionToken = '';
// server/auth-session.ts reads SUPABASE_JWT_PUBLIC_JWK/SUPABASE_URL into
// module-scope consts at first import, so `../server/gateway.ts` (which
// transitively imports it) must be dynamically imported AFTER the env vars
// below are set -- a static top-of-file import would capture an empty
// key and every bearer-token verification would fail closed.
let handler: (req: Request) => Promise<Response>;

function request(path: string, headers: HeadersInit): Request {
  return new Request(`https://example.test${path}?_debug=1`, {
    headers: {
      Origin: 'https://example.test',
      ...headers,
    },
  });
}

function assertPrivateCache(res: Response): void {
  assert.equal(res.headers.get('CDN-Cache-Control'), null);
  assert.equal(res.headers.get('Vercel-CDN-Cache-Control'), null);
  assert.doesNotMatch(res.headers.get('Cache-Control') ?? '', /\bpublic\b|\bs-maxage=/i);
}

async function signSupabaseToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

before(async () => {
  process.env.SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_JWT_PUBLIC_JWK = JSON.stringify(publicJwk);
  process.env.WM_SESSION_SECRET = 'pro-fresh-session-secret-at-least-32-chars';
  anonymousSessionToken = (await issueSessionToken()).token;

  const { createDomainGateway } = await import(`../server/gateway.ts?pro-fresh-cache-repro=${Date.now()}`);
  handler = createDomainGateway(
    [...PRO_FRESH_CACHE_RPC_PATHS].map((path) => ({
      method: 'GET' as const,
      path,
      handler: async () => new Response('{"ok":true}', { status: 200 }),
    })),
  );
});

after(async () => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('Pro-only market freshness cache contract', () => {
  it('keeps the allowlist exact', () => {
    assert.deepEqual(
      [...PRO_FRESH_CACHE_RPC_PATHS].sort(),
      [
        '/api/market/v1/list-commodity-quotes',
        '/api/market/v1/list-crypto-quotes',
        '/api/market/v1/list-gulf-quotes',
        '/api/market/v1/list-market-quotes',
        '/api/market/v1/list-stablecoin-markets',
      ],
    );
  });

  // NOTE(stage1-supabase-migration): post-Stage-1, getEntitlements()
  // (server/_shared/entitlement-check.ts) synthesizes a fixed
  // {tier:1, validUntil:Infinity} entitlement for ANY verified Supabase
  // userId -- there is no more free/pro plan distinction, so any
  // authenticated caller now qualifies for the 30-second live-browser
  // tier on these five routes (this is what actually fixed the "Upgrade
  // to Pro" gating described in the migration plan).
  it('gives any signed-in Supabase user a 30-second private browser tier on all five routes', async () => {
    const token = await signSupabaseToken('user-pro-fresh-uuid');

    for (const path of PRO_FRESH_CACHE_RPC_PATHS) {
      const res = await handler(request(path, { Authorization: `Bearer ${token}` }));
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('X-Cache-Tier'), 'live-browser', path);
      assert.match(res.headers.get('Cache-Control') ?? '', /\bmax-age=30\b/, path);
      assert.match(res.headers.get('Cache-Control') ?? '', /\bprivate\b/, path);
      assertPrivateCache(res);
    }
  });

  it('keeps anonymous browser sessions on the existing five-minute private tier', async () => {
    const res = await handler(request(
      '/api/market/v1/list-market-quotes',
      { 'X-WorldMonitor-Key': anonymousSessionToken },
    ));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('X-Cache-Tier'), 'slow-browser');
    assert.match(res.headers.get('Cache-Control') ?? '', /\bmax-age=300\b/);
    assertPrivateCache(res);
  });

  it('an invalid/unverifiable bearer token does not upgrade an otherwise-anonymous request to the live-browser tier', async () => {
    // The route still needs SOME credential to pass the gateway's general
    // key requirement (unrelated to Pro-freshness, see api/_api-key.js) --
    // pair the anonymous session token with a garbage Authorization header
    // to isolate "bearer token fails to verify" from "no credential at all".
    const res = await handler(request(
      '/api/market/v1/list-market-quotes',
      { 'X-WorldMonitor-Key': anonymousSessionToken, Authorization: 'Bearer not-a-real-token' },
    ));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('X-Cache-Tier'), 'slow-browser', 'an unverifiable bearer token must not grant live-browser freshness');
    assert.match(res.headers.get('Cache-Control') ?? '', /\bmax-age=300\b/);
    assertPrivateCache(res);
  });

  // NOTE(stage1-supabase-migration): the old "keeps signed-in free and
  // expired paid plans on the five-minute tier" and "fails closed when
  // entitlement resolution is unavailable" tests were removed here. Both
  // depended on a mocked Convex `/api/internal-entitlements` response
  // returning a differentiated (free-plan / lapsed / null) entitlement row
  // for a *verified* Supabase session -- getEntitlements() no longer makes
  // a network call and cannot return null/lapsed for a non-empty, verified
  // userId, so neither scenario is reachable through this seam anymore.
  // The test above is the closest remaining equivalent: an Authorization
  // header that fails to verify must not grant the Pro-freshness tier.
});
