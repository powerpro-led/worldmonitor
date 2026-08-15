/**
 * Tests for server/auth-session.ts (Supabase HS256 JWT verification with jose)
 *
 * Covers the full validation matrix:
 *  - Returns invalid when SUPABASE_JWT_SECRET is not set (fail-closed)
 *  - Valid Supabase session token → { valid: true, role: 'pro' } (no more
 *    plan/tier concept -- every verified user gets a fixed 'pro' role)
 *  - Expired token → { valid: false }
 *  - Wrong signing secret → { valid: false }
 *  - Wrong issuer → { valid: false }
 *  - Wrong audience → { valid: false }
 *  - Missing `sub` claim → { valid: false }
 *  - email/name extraction from `user_metadata` (GitHub identity fields)
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { SignJWT } from 'jose';

const SUPABASE_URL = 'https://ixuezudybhjptisexgxx.supabase.co';
const SUPABASE_JWT_SECRET = 'test-supabase-jwt-secret-must-be-long-enough-xxxxxxxx';
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const secretKey = new TextEncoder().encode(SUPABASE_JWT_SECRET);

// ---------------------------------------------------------------------------
// Suite 1: fail-closed when SUPABASE_JWT_SECRET is NOT set
// ---------------------------------------------------------------------------

// Clear env BEFORE dynamic import so the module captures an empty secret.
delete process.env.SUPABASE_JWT_SECRET;
delete process.env.SUPABASE_URL;

let validateBearerTokenNoEnv: (token: string) => Promise<{ valid: boolean; userId?: string; role?: string }>;

before(async () => {
  const mod = await import('../server/auth-session.ts');
  validateBearerTokenNoEnv = mod.validateBearerToken;
});

describe('validateBearerToken (no SUPABASE_JWT_SECRET)', () => {
  it('returns invalid when SUPABASE_JWT_SECRET is not set', async () => {
    const result = await validateBearerTokenNoEnv('some-random-token');
    assert.equal(result.valid, false);
    assert.equal(result.userId, undefined);
    assert.equal(result.role, undefined);
  });

  it('returns invalid for empty token', async () => {
    const result = await validateBearerTokenNoEnv('');
    assert.equal(result.valid, false);
  });

  it('returns SessionResult shape with expected fields', async () => {
    const result = await validateBearerTokenNoEnv('test');
    assert.equal(typeof result.valid, 'boolean');
    if (!result.valid) {
      assert.equal(result.userId, undefined);
      assert.equal(result.role, undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 2: full HS256 validation against the shared Supabase JWT secret
// ---------------------------------------------------------------------------

describe('validateBearerToken (Supabase HS256)', () => {
  let validateBearerToken: (token: string) => Promise<{
    valid: boolean;
    userId?: string;
    orgId?: string | null;
    role?: string;
    email?: string;
    name?: string;
  }>;

  before(async () => {
    process.env.SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_JWT_SECRET = SUPABASE_JWT_SECRET;

    // Dynamic import with cache-busting query param to get a fresh module
    // instance that captures the env vars set above at module scope.
    const mod = await import(`../server/auth-session.ts?t=${Date.now()}`);
    validateBearerToken = mod.validateBearerToken;
  });

  after(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_JWT_SECRET;
  });

  function signToken(claims: Record<string, unknown>, opts?: {
    expiresIn?: string;
    key?: Uint8Array;
    issuer?: string;
    audience?: string;
  }) {
    const builder = new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(opts?.issuer ?? ISSUER)
      .setAudience(opts?.audience ?? 'authenticated')
      .setSubject(claims.sub as string ?? 'user-test-uuid')
      .setIssuedAt()
      .setExpirationTime(opts?.expiresIn ?? '1h');

    return builder.sign(opts?.key ?? secretKey);
  }

  it('accepts a valid Supabase session token and always returns role pro', async () => {
    const token = await signToken({ sub: 'user-pro-uuid' });
    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.userId, 'user-pro-uuid');
    assert.equal(result.role, 'pro', 'no more plan/tier concept -- every verified user is pro');
    assert.equal(result.orgId, null, 'Supabase Auth has no built-in org concept');
  });

  it('returns role pro regardless of any legacy plan-shaped claim', async () => {
    const token = await signToken({ sub: 'user-legacy-claim', plan: 'free' });
    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.role, 'pro', 'entitlement is derived from a verified session, not a plan claim');
  });

  it('rejects an expired token', async () => {
    const token = await new SignJWT({ sub: 'user-expired' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setSubject('user-expired')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200) // 2h ago
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600) // expired 1h ago
      .sign(secretKey);

    const result = await validateBearerToken(token);
    assert.equal(result.valid, false);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const wrongKey = new TextEncoder().encode('a-completely-different-secret-value-xxxxxxxx');
    const token = await signToken({ sub: 'user-wrongkey' }, { key: wrongKey });
    const result = await validateBearerToken(token);
    assert.equal(result.valid, false);
  });

  it('rejects a token with the wrong issuer', async () => {
    const token = await signToken({ sub: 'user-wrongiss' }, { issuer: 'https://not-this-project.supabase.co/auth/v1' });
    const result = await validateBearerToken(token);
    assert.equal(result.valid, false);
  });

  it('rejects a token with an unexpected audience', async () => {
    const token = await signToken({ sub: 'user-wrongaud' }, { audience: 'anon' });
    const result = await validateBearerToken(token);
    assert.equal(result.valid, false);
  });

  it('rejects a token with no sub claim', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secretKey);

    const result = await validateBearerToken(token);
    assert.equal(result.valid, false);
  });

  it('extracts email and name from user_metadata (GitHub identity)', async () => {
    const token = await signToken({
      sub: 'user-prefill',
      email: 'operator@example.test',
      user_metadata: { full_name: 'Operator Name', user_name: 'operator-gh' },
    });

    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.email, 'operator@example.test');
    assert.equal(result.name, 'Operator Name', 'full_name takes priority over user_name');
  });

  it('falls back to user_name when full_name is absent', async () => {
    const token = await signToken({
      sub: 'user-username-only',
      user_metadata: { user_name: 'operator-gh' },
    });

    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.name, 'operator-gh');
  });

  it('handles missing email/name gracefully (no user_metadata)', async () => {
    const token = await signToken({ sub: 'user-noprofile' });
    const result = await validateBearerToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.email, undefined);
    assert.equal(result.name, undefined);
  });

  it('rejects a token signed with a mismatched algorithm', async () => {
    // HS256 verification with `algorithms: ['HS256']` must reject a token
    // whose header claims a different alg even if some other secret/key
    // could theoretically be persuaded to verify it (algorithm confusion).
    const token = await new SignJWT({ sub: 'user-alg-confusion' })
      .setProtectedHeader({ alg: 'HS384' })
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setSubject('user-alg-confusion')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SUPABASE_JWT_SECRET));

    const result = await validateBearerToken(token);
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: CORS origin matching -- pure logic (independent of auth provider)
// ---------------------------------------------------------------------------

describe('CORS origin matching (convex/http.ts)', () => {
  function matchOrigin(origin: string, pattern: string): boolean {
    if (pattern.startsWith('*.')) {
      return origin.endsWith(pattern.slice(1));
    }
    return origin === pattern;
  }

  function allowedOrigin(origin: string | null, trusted: string[]): string | null {
    if (!origin) return null;
    return trusted.some((p) => matchOrigin(origin, p)) ? origin : null;
  }

  const TRUSTED = [
    'https://example.test',
    '*.example.test',
    'http://localhost:3000',
  ];

  it('allows exact match', () => {
    assert.equal(allowedOrigin('https://example.test', TRUSTED), 'https://example.test');
  });

  it('allows wildcard subdomain', () => {
    const origin = 'https://preview-xyz.example.test';
    assert.equal(allowedOrigin(origin, TRUSTED), origin);
  });

  it('allows localhost', () => {
    assert.equal(allowedOrigin('http://localhost:3000', TRUSTED), 'http://localhost:3000');
  });

  it('blocks unknown origin', () => {
    assert.equal(allowedOrigin('https://evil.com', TRUSTED), null);
  });

  it('blocks partial domain match', () => {
    assert.equal(allowedOrigin('https://attackerexample.test', TRUSTED), null);
  });

  it('returns null for null origin -- no ACAO header emitted', () => {
    assert.equal(allowedOrigin(null, TRUSTED), null);
  });
});
