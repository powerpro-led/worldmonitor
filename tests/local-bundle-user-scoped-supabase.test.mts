/**
 * The local bundle's account-features path (2026-09-19): no service-role key
 * on an operator machine, so
 *   - server/auth-session.ts verifies the bearer through GoTrue's /auth/v1/user
 *     when SUPABASE_JWT_PUBLIC_JWK is unset AND LOCAL_API_MODE=tauri-sidecar
 *     (and ONLY then — the cloud path stays fail-closed with no network);
 *   - server/_shared/supabase-admin.ts's getSupabaseForRequest() hands the
 *     data modules an RLS-scoped client built from the publishable key + the
 *     request's own JWT, put in scope by runAsUser(); without a token in scope
 *     it still reports "unconfigured" (null), exactly as before.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

const SUPABASE_URL = 'https://ixuezudybhjptisexgxx.supabase.co';
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function freshImport<T>(spec: string): Promise<T> {
  return import(`${spec}?t=${Date.now()}-${Math.random()}`) as Promise<T>;
}

type AuthSessionModule = typeof import('../server/auth-session.ts');
type SupabaseAdminModule = typeof import('../server/_shared/supabase-admin.ts');

describe('auth-session — local-bundle GoTrue fallback', () => {
  beforeEach(() => {
    delete process.env.SUPABASE_JWT_PUBLIC_JWK;
    process.env.SUPABASE_URL = SUPABASE_URL;
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  it('cloud (LOCAL_API_MODE unset): no public key → invalid, and NO network call', async () => {
    delete process.env.LOCAL_API_MODE;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('{}'); }) as typeof fetch;
    const mod = await freshImport<AuthSessionModule>('../server/auth-session.ts');
    assert.deepEqual(await mod.validateBearerToken('some.jwt.here'), { valid: false });
    assert.equal(calls, 0);
  });

  it('local: verifies via GET /auth/v1/user with apikey + bearer and maps the user', async () => {
    process.env.LOCAL_API_MODE = 'tauri-sidecar';
    const seen: { url: string; headers: Record<string, string> }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } });
      return new Response(JSON.stringify({
        id: 'user-1', aud: 'authenticated', email: 'op@example.test',
        user_metadata: { user_name: 'op-login' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const mod = await freshImport<AuthSessionModule>('../server/auth-session.ts');

    const result = await mod.validateBearerToken('user.jwt.1');
    assert.deepEqual(result, {
      valid: true, userId: 'user-1', orgId: null, role: 'pro', email: 'op@example.test', name: 'op-login',
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, `${SUPABASE_URL}/auth/v1/user`);
    assert.equal(seen[0].headers.apikey, 'sb_publishable_test');
    assert.equal(seen[0].headers.Authorization, 'Bearer user.jwt.1');

    // Memoised: the same token within the TTL costs no second round-trip.
    await mod.validateBearerToken('user.jwt.1');
    assert.equal(seen.length, 1);
  });

  it('local: GoTrue rejecting the token (401) → invalid, and the rejection is not memoised', async () => {
    process.env.LOCAL_API_MODE = 'tauri-sidecar';
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('{"msg":"bad"}', { status: 401 }); }) as typeof fetch;
    const mod = await freshImport<AuthSessionModule>('../server/auth-session.ts');
    assert.deepEqual(await mod.validateBearerToken('user.jwt.bad'), { valid: false });
    assert.deepEqual(await mod.validateBearerToken('user.jwt.bad'), { valid: false });
    assert.equal(calls, 2);
  });

  it('local: network failure → invalid (fail closed)', async () => {
    process.env.LOCAL_API_MODE = 'tauri-sidecar';
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    const mod = await freshImport<AuthSessionModule>('../server/auth-session.ts');
    assert.deepEqual(await mod.validateBearerToken('user.jwt.x'), { valid: false });
  });
});

describe('premium-check — a signed-in operator is premium in the local bundle', () => {
  // The WM Analyst panel (api/chat-analyst.ts) gates on
  // resolvePremiumCallerIdentity(). On an operator install the bearer used to
  // be unverifiable (no SUPABASE_JWT_PUBLIC_JWK in org.env) → 403 "Sign-in or
  // API key required" even though the operator was signed in AND had saved
  // their own OpenRouter key (2026-09-19 report). The GoTrue fallback above is
  // what this exercises end to end through the premium gate.
  beforeEach(() => {
    delete process.env.SUPABASE_JWT_PUBLIC_JWK;
    delete process.env.WORLDMONITOR_VALID_KEYS;
    process.env.LOCAL_API_MODE = 'tauri-sidecar';
    process.env.SUPABASE_URL = SUPABASE_URL;
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/auth/v1/user')) {
        return new Response(JSON.stringify({ id: 'user-9', aud: 'authenticated' }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${String(input)}`);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  it('bearer JWT → isPremium with the user id; no bearer → not premium', async () => {
    const mod = await freshImport<typeof import('../server/_shared/premium-check.ts')>('../server/_shared/premium-check.ts');
    const withBearer = await mod.resolvePremiumCallerIdentity(
      new Request('http://127.0.0.1:46123/api/chat-analyst', { headers: { Authorization: 'Bearer user.jwt.9' } }),
    );
    assert.deepEqual(withBearer, { isPremium: true, userId: 'user-9', kind: 'bearer', quotaExempt: false });

    const anonymous = await mod.resolvePremiumCallerIdentity(new Request('http://127.0.0.1:46123/api/chat-analyst'));
    assert.equal(anonymous.isPremium, false);
  });
});

describe('supabase-admin — getSupabaseForRequest / runAsUser', () => {
  beforeEach(() => {
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_URL = SUPABASE_URL;
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
  });
  afterEach(() => restoreEnv());

  it('no service-role key and no JWT in scope → null (unchanged "unconfigured" contract)', async () => {
    const mod = await freshImport<SupabaseAdminModule>('../server/_shared/supabase-admin.ts');
    assert.equal(mod.getSupabaseForRequest(), null);
    // An empty bearer (anonymous request) must not manufacture a client either.
    const inside = await mod.runAsUser('', () => mod.getSupabaseForRequest());
    assert.equal(inside, null);
  });

  it('no service-role key + JWT in scope → a client carrying that JWT, scoped to the request', async () => {
    const mod = await freshImport<SupabaseAdminModule>('../server/_shared/supabase-admin.ts');
    const client = await mod.runAsUser('user.jwt.1', () => mod.getSupabaseForRequest());
    assert.ok(client, 'expected a user-scoped client');
    // supabase-js keeps the global headers it was constructed with; the
    // bearer must be the caller's JWT, never the publishable key.
    const headers = (client as unknown as { headers: Record<string, string> }).headers;
    assert.equal(headers.Authorization, 'Bearer user.jwt.1');
    // Out of scope again → null: the token does not leak past the request.
    assert.equal(mod.getSupabaseForRequest(), null);
    // Same token → same cached client; different token → a different one.
    const again = await mod.runAsUser('user.jwt.1', () => mod.getSupabaseForRequest());
    assert.equal(again, client);
    const other = await mod.runAsUser('user.jwt.2', () => mod.getSupabaseForRequest());
    assert.notEqual(other, client);
  });

  it('service-role key configured → the admin client wins even with a JWT in scope', async () => {
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
    const mod = await freshImport<SupabaseAdminModule>('../server/_shared/supabase-admin.ts');
    const admin = mod.getSupabaseAdmin();
    const inScope = await mod.runAsUser('user.jwt.1', () => mod.getSupabaseForRequest());
    assert.equal(inScope, admin);
  });
});
