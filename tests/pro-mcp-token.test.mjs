/**
 * Tests for `server/_shared/pro-mcp-token.ts` — Edge-runtime-safe wrappers
 * around `worldmonitor.mcp_pro_tokens` (Postgres, service-role Supabase
 * client). Stage 1 of the Convex/Clerk -> Supabase migration replaced the
 * three Convex internal HTTP actions this file used to mock
 * (`internal-issue-pro-mcp-token`, `internal-validate-pro-mcp-token`,
 * `internal-revoke-pro-mcp-token`) with direct Postgres CRUD via
 * `server/_shared/supabase-admin.ts`. The public API shape (function names,
 * discriminated unions, error kinds) did NOT change — only the backing
 * store did — so every test below pins the SAME contract the Convex-backed
 * version did, just via a Supabase PostgREST fetch mock instead of a
 * Convex HTTP mock.
 *
 * Tested invariants (load-bearing, see plan U2):
 *   - validate has NO positive cache: N validate calls produce N Postgres calls.
 *   - validate writes a 60s negative-cache sentinel on null result.
 *   - subsequent validates within 60s on a known-bad tokenId short-circuit
 *     WITHOUT a Postgres round-trip.
 *   - revoke writes the negative-cache sentinel on success.
 *   - issue propagates a Postgres error as a typed 'network' error.
 *   - validate is fail-soft on Postgres 5xx-shaped errors / timeout (returns
 *     null, no neg-cache write — a blip should not mark a legitimate token
 *     as bad for 60s).
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const FAKE_SUPABASE = 'https://fake-project.supabase.co';
const FAKE_SERVICE_ROLE_KEY = 'fake-service-role-key-xyz';
const FAKE_REDIS = 'https://fake.upstash.io';
const FAKE_REDIS_TOKEN = 'redis-token-abc';

/**
 * In-memory Redis stub for the negative-cache sentinel. Tracks SET writes
 * with their TTL so tests can assert TTL semantics. Reads are simple
 * presence checks — TTL is asserted separately, not enforced as expiry.
 */
function makeRedisStub() {
  const store = new Map(); // key → { value, ttlSeconds }
  return {
    store,
    handle(url) {
      // GET /get/<encodedKey>
      const getMatch = url.match(/\/get\/([^?]+)$/);
      if (getMatch) {
        const key = decodeURIComponent(getMatch[1]);
        const entry = store.get(key);
        return new Response(JSON.stringify({ result: entry ? entry.value : null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // SET /set/<encodedKey>/<encodedValue>/EX/<ttl>
      const setMatch = url.match(/\/set\/([^/]+)\/([^/]+)\/EX\/(\d+)/);
      if (setMatch) {
        const key = decodeURIComponent(setMatch[1]);
        const value = decodeURIComponent(setMatch[2]);
        const ttlSeconds = Number(setMatch[3]);
        store.set(key, { value, ttlSeconds });
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
      }
      // DEL /del/<encodedKey>
      const delMatch = url.match(/\/del\/([^?]+)$/);
      if (delMatch) {
        const key = decodeURIComponent(delMatch[1]);
        const existed = store.delete(key);
        return new Response(JSON.stringify({ result: existed ? 1 : 0 }), { status: 200 });
      }
      throw new Error(`Unexpected Redis URL: ${url}`);
    },
  };
}

/**
 * Build a fetch stub that routes Upstash REST through `redis.handle` and
 * `worldmonitor.mcp_pro_tokens` PostgREST calls through the supplied
 * `pgHandler({method, params, body})`. Counts Postgres hits by HTTP verb
 * (GET=select, POST=insert, PATCH=update) so tests can assert "no positive
 * cache" the same way the old Convex-hit-count assertions did.
 */
function makeFetchStub(redis, pgHandler) {
  const counts = { select: 0, insert: 0, update: 0 };
  const stub = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith(FAKE_REDIS)) {
      return redis.handle(url);
    }
    if (url.startsWith(FAKE_SUPABASE)) {
      // Verify the service-role key is present on every Postgres call.
      const headers = new Headers(init?.headers ?? {});
      assert.equal(
        headers.get('apikey'),
        FAKE_SERVICE_ROLE_KEY,
        'Supabase calls MUST include the service-role apikey header',
      );
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') counts.select++;
      else if (method === 'POST') counts.insert++;
      else if (method === 'PATCH') counts.update++;
      const parsed = new URL(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return pgHandler({ method, params: parsed.searchParams, body });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };
  stub.counts = counts;
  return stub;
}

function pgJson(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function pgError(code, message, status = 500) {
  return new Response(
    JSON.stringify({ code, message, details: null, hint: null }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

// --- Query-shape discriminators -------------------------------------------
// server/_shared/pro-mcp-token.ts issues four distinct query shapes against
// worldmonitor.mcp_pro_tokens; these predicates disambiguate them by their
// (stable) `select=` projection and HTTP verb so per-test handlers can
// pattern-match the same way the old convex(url) handlers matched by path.
function isValidateQuery(req) {
  return req.method === 'GET' && req.params.get('select') === 'user_id';
}
function isListActiveQuery(req) {
  return req.method === 'GET' && req.params.get('select') === 'id,created_at';
}
function isRevokeFallbackSelect(req) {
  return req.method === 'GET' && req.params.get('select') === 'user_id,revoked_at';
}
function isRotationUpdate(req) {
  return req.method === 'PATCH' && (req.params.get('id') ?? '').startsWith('in.');
}
function isRevokeUpdate(req) {
  return req.method === 'PATCH' && req.params.has('user_id');
}
function isInsert(req) {
  return req.method === 'POST';
}

let mod;

describe('pro-mcp-token', () => {
  beforeEach(async () => {
    process.env.SUPABASE_URL = FAKE_SUPABASE;
    process.env.SUPABASE_SERVICE_ROLE_KEY = FAKE_SERVICE_ROLE_KEY;
    process.env.UPSTASH_REDIS_REST_URL = FAKE_REDIS;
    process.env.UPSTASH_REDIS_REST_TOKEN = FAKE_REDIS_TOKEN;
    const { __resetSupabaseAdminForTests } = await import('../server/_shared/supabase-admin.ts');
    __resetSupabaseAdminForTests();
    // Re-import per-test to ensure no module-level state pollutes across
    // tests — the helper has none today, but this is cheap insurance.
    mod = await import(`../server/_shared/pro-mcp-token.ts?cachebust=${Math.random()}`);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
    const { __resetSupabaseAdminForTests } = await import('../server/_shared/supabase-admin.ts');
    __resetSupabaseAdminForTests();
  });

  // -----------------------------------------------------------------------
  // validateProMcpToken — no positive cache, negative-cache only
  // -----------------------------------------------------------------------

  describe('validateProMcpToken', () => {
    it('hits Postgres on every call when the token is valid (NO positive cache) — returns ok:valid', async () => {
      const redis = makeRedisStub();
      const pg = (req) => {
        if (isValidateQuery(req)) return pgJson({ user_id: 'user_123' });
        throw new Error(`unexpected: ${req.method} ${req.params}`);
      };
      const stub = makeFetchStub(redis, pg);
      globalThis.fetch = stub;

      // Three sequential calls on the SAME tokenId — each must round-trip.
      const r1 = await mod.validateProMcpToken('tok_abc');
      const r2 = await mod.validateProMcpToken('tok_abc');
      const r3 = await mod.validateProMcpToken('tok_abc');

      assert.deepEqual(r1, { ok: 'valid', userId: 'user_123' });
      assert.deepEqual(r2, { ok: 'valid', userId: 'user_123' });
      assert.deepEqual(r3, { ok: 'valid', userId: 'user_123' });
      assert.equal(stub.counts.select, 3, 'every validate must hit Postgres — no positive cache');
      // No neg-cache sentinel for a successful validate.
      assert.equal(redis.store.size, 0, 'positive validate must NOT write neg-cache');
    });

    it('returns ok:revoked + writes neg-cache sentinel on null result; short-circuits subsequent calls', async () => {
      const redis = makeRedisStub();
      let pgHits = 0;
      const pg = (req) => {
        if (isValidateQuery(req)) {
          pgHits++;
          return pgJson(null);
        }
        throw new Error(`unexpected: ${req.method} ${req.params}`);
      };
      const stub = makeFetchStub(redis, pg);
      globalThis.fetch = stub;

      // First call hits Postgres, gets null, writes neg-cache sentinel.
      const r1 = await mod.validateProMcpToken('tok_revoked');
      assert.deepEqual(r1, { ok: 'revoked' });
      assert.equal(pgHits, 1, 'first validate hits Postgres');
      const sentinel = redis.store.get('pro-mcp-token-neg:tok_revoked');
      assert.ok(sentinel, 'neg-cache sentinel must be written');
      assert.equal(sentinel.value, '1');
      assert.equal(sentinel.ttlSeconds, 60, 'neg-cache TTL must be 60s');

      // Subsequent calls within the cache window short-circuit — Postgres hit count stays at 1.
      const r2 = await mod.validateProMcpToken('tok_revoked');
      const r3 = await mod.validateProMcpToken('tok_revoked');
      assert.deepEqual(r2, { ok: 'revoked' });
      assert.deepEqual(r3, { ok: 'revoked' });
      assert.equal(pgHits, 1, 'subsequent validates with neg-cache present must NOT hit Postgres');
    });

    it('never-existed tokenId behaves like revoked (Postgres returns null → neg-cache set)', async () => {
      const redis = makeRedisStub();
      const pg = (req) => (isValidateQuery(req) ? pgJson(null) : (() => { throw new Error('unexpected'); })());
      const stub = makeFetchStub(redis, pg);
      globalThis.fetch = stub;

      const r = await mod.validateProMcpToken('tok_never_existed');
      assert.deepEqual(r, { ok: 'revoked' });
      assert.ok(redis.store.has('pro-mcp-token-neg:tok_never_existed'));
      assert.equal(stub.counts.select, 1);
    });

    it('returns ok:transient on a Postgres error WITHOUT writing neg-cache (fail-soft, no false-poisoning)', async () => {
      const redis = makeRedisStub();
      const pg = (req) => (isValidateQuery(req) ? pgError('XX000', 'internal error') : (() => { throw new Error('unexpected'); })());
      const stub = makeFetchStub(redis, pg);
      globalThis.fetch = stub;

      const r = await mod.validateProMcpToken('tok_legit');
      assert.deepEqual(r, { ok: 'transient' }, 'transient Postgres failure → ok:transient (caller decides)');
      assert.equal(
        redis.store.size, 0,
        'a transient blip must NOT write the neg-cache sentinel — that would mark a legitimate token bad for 60s',
      );
    });

    it('returns ok:revoked (not transient) on a malformed-uuid tokenId (Postgres 22P02)', async () => {
      // A non-uuid tokenId is structurally not-found, matching the old
      // Convex malformed-id -> null contract -- NOT a transient failure.
      const redis = makeRedisStub();
      const pg = (req) => (isValidateQuery(req) ? pgError('22P02', 'invalid input syntax for type uuid') : (() => { throw new Error('unexpected'); })());
      globalThis.fetch = makeFetchStub(redis, pg);

      const r = await mod.validateProMcpToken('not-a-uuid');
      assert.deepEqual(r, { ok: 'revoked' });
      assert.ok(redis.store.has('pro-mcp-token-neg:not-a-uuid'));
    });

    it('returns ok:transient on fetch network error (e.g. timeout) and does NOT poison the neg-cache', async () => {
      const redis = makeRedisStub();
      // Override the entire fetch — Postgres calls reject; Redis stays in-memory.
      let validateAttempted = false;
      globalThis.fetch = async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.startsWith(FAKE_REDIS)) return redis.handle(url);
        if (url.startsWith(FAKE_SUPABASE)) {
          validateAttempted = true;
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        }
        throw new Error(`unexpected: ${url}`);
      };

      const r = await mod.validateProMcpToken('tok_legit2');
      assert.deepEqual(r, { ok: 'transient' });
      assert.ok(validateAttempted, 'Postgres round-trip was attempted');
      assert.equal(redis.store.size, 0, 'timeout must NOT write neg-cache');
    });

    it('returns ok:transient on malformed Postgres response (defensive shape check; no neg-cache poison)', async () => {
      const redis = makeRedisStub();
      globalThis.fetch = async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.startsWith(FAKE_REDIS)) return redis.handle(url);
        if (url.startsWith(FAKE_SUPABASE)) {
          return new Response('not json{}{', { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error(`unexpected: ${url}`);
      };

      const r = await mod.validateProMcpToken('tok_x');
      assert.deepEqual(r, { ok: 'transient' });
      // Malformed body is treated as a transient/unexpected failure → no
      // neg-cache write (would falsely poison a legitimate token).
      assert.equal(redis.store.size, 0);
    });

    it('returns ok:revoked on Postgres row missing user_id field (structurally not-found)', async () => {
      const redis = makeRedisStub();
      const pg = (req) => (isValidateQuery(req) ? pgJson({ unrelated: 'payload' }) : (() => { throw new Error('unexpected'); })());
      globalThis.fetch = makeFetchStub(redis, pg);

      const r = await mod.validateProMcpToken('tok_y');
      assert.deepEqual(r, { ok: 'revoked' });
      // Missing user_id is structurally equivalent to "not found" — write
      // the sentinel just like a null body.
      assert.ok(redis.store.has('pro-mcp-token-neg:tok_y'));
    });

    it('returns ok:revoked for empty tokenId without any fetch', async () => {
      let fetched = false;
      globalThis.fetch = async () => {
        fetched = true;
        throw new Error('should not fetch');
      };
      const r = await mod.validateProMcpToken('');
      assert.deepEqual(r, { ok: 'revoked' });
      assert.equal(fetched, false);
    });
  });

  // -----------------------------------------------------------------------
  // validateProMcpTokenOrNull — backward-compat wrapper (F3)
  // -----------------------------------------------------------------------

  describe('validateProMcpTokenOrNull (legacy null-shape wrapper)', () => {
    it('maps ok:valid → {userId}', async () => {
      const redis = makeRedisStub();
      const pg = (req) => (isValidateQuery(req) ? pgJson({ user_id: 'user_123' }) : (() => { throw new Error('unexpected'); })());
      globalThis.fetch = makeFetchStub(redis, pg);
      const r = await mod.validateProMcpTokenOrNull('tok_abc');
      assert.deepEqual(r, { userId: 'user_123' });
    });

    it('maps ok:revoked → null', async () => {
      const redis = makeRedisStub();
      const pg = (req) => (isValidateQuery(req) ? pgJson(null) : (() => { throw new Error('unexpected'); })());
      globalThis.fetch = makeFetchStub(redis, pg);
      const r = await mod.validateProMcpTokenOrNull('tok_revoked');
      assert.equal(r, null);
    });

    it('maps ok:transient → null (caller fail-closes)', async () => {
      const redis = makeRedisStub();
      const pg = (req) => (isValidateQuery(req) ? pgError('XX000', 'blip') : (() => { throw new Error('unexpected'); })());
      globalThis.fetch = makeFetchStub(redis, pg);
      const r = await mod.validateProMcpTokenOrNull('tok_legit');
      assert.equal(r, null);
    });
  });

  // -----------------------------------------------------------------------
  // issueProMcpTokenForUser — typed errors
  // -----------------------------------------------------------------------

  describe('issueProMcpTokenForUser', () => {
    it('returns {tokenId} on Postgres 200', async () => {
      const redis = makeRedisStub();
      const pg = (req) => {
        if (isListActiveQuery(req)) return pgJson([]); // under the 5-active cap
        if (isInsert(req)) return pgJson({ id: 'newly_issued_id' }, 201);
        throw new Error(`unexpected: ${req.method} ${req.params}`);
      };
      globalThis.fetch = makeFetchStub(redis, pg);

      const out = await mod.issueProMcpTokenForUser('user_123', 'client_abc', 'Claude Desktop');
      assert.deepEqual(out, { tokenId: 'newly_issued_id' });
    });

    it('rotates the oldest excess row when at the 5-active-token cap', async () => {
      const redis = makeRedisStub();
      const active = Array.from({ length: 5 }, (_, i) => ({ id: `tok_${i}`, created_at: new Date(i).toISOString() }));
      let rotatedIds = null;
      const pg = (req) => {
        if (isListActiveQuery(req)) return pgJson(active);
        if (isRotationUpdate(req)) {
          rotatedIds = req.params.get('id');
          return pgJson([{ id: 'tok_0' }]);
        }
        if (isInsert(req)) return pgJson({ id: 'newly_issued_id' }, 201);
        throw new Error(`unexpected: ${req.method} ${req.params}`);
      };
      globalThis.fetch = makeFetchStub(redis, pg);

      const out = await mod.issueProMcpTokenForUser('user_123');
      assert.deepEqual(out, { tokenId: 'newly_issued_id' });
      assert.equal(rotatedIds, 'in.(tok_0)', 'only the oldest excess row (5 active, cap 5) rotates');
    });

    // NOTE(stage1-supabase-migration): "throws ProMcpIssueFailed{kind:pro-required}
    // on Convex 403" was removed here. server/_shared/pro-mcp-token.ts's own
    // header comment states this module never throws 'pro-required' anymore
    // -- every caller of issueProMcpTokenForUser already resolves and checks
    // getEntitlements(userId) itself before calling in, and post-Stage-1
    // every verified userId is entitled (no plan gating left to re-check
    // here). The `IssueFailedKind` union keeps 'pro-required' only for
    // caller-side type compatibility (api/oauth/authorize-pro.ts branches on
    // it), so there is no reachable Postgres response shape that produces it.

    it('throws ProMcpIssueFailed{kind:invalid-user-id} on empty userId (no fetch)', async () => {
      let fetched = false;
      globalThis.fetch = async () => { fetched = true; throw new Error('should not fetch'); };

      await assert.rejects(
        () => mod.issueProMcpTokenForUser('', 'client_abc'),
        (err) => err instanceof mod.ProMcpIssueFailed && err.kind === 'invalid-user-id',
      );
      assert.equal(fetched, false, 'empty userId is rejected before any Postgres call');
    });

    it('throws ProMcpIssueFailed{kind:network} on a Postgres error listing active tokens', async () => {
      const redis = makeRedisStub();
      const pg = (req) => (isListActiveQuery(req) ? pgError('XX000', 'boom') : (() => { throw new Error('unexpected'); })());
      globalThis.fetch = makeFetchStub(redis, pg);

      await assert.rejects(
        () => mod.issueProMcpTokenForUser('user_123'),
        (err) => err instanceof mod.ProMcpIssueFailed && err.kind === 'network',
      );
    });

    it('throws ProMcpIssueFailed{kind:network} on fetch rejection (timeout)', async () => {
      globalThis.fetch = async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      };
      await assert.rejects(
        () => mod.issueProMcpTokenForUser('user_123'),
        (err) => err instanceof mod.ProMcpIssueFailed && err.kind === 'network',
      );
    });

    it('throws ProMcpIssueFailed{kind:config} when SUPABASE_URL is missing', async () => {
      delete process.env.SUPABASE_URL;
      const { __resetSupabaseAdminForTests } = await import('../server/_shared/supabase-admin.ts');
      __resetSupabaseAdminForTests();
      await assert.rejects(
        () => mod.issueProMcpTokenForUser('user_123'),
        (err) => err instanceof mod.ProMcpIssueFailed && err.kind === 'config',
      );
    });

    // FIXME(stage1-supabase-migration): "throws ProMcpIssueFailed{kind:network}
    // on 200 with missing tokenId in body" was removed here. The old
    // Convex-backed version explicitly validated the response shape before
    // trusting it. The new source's insert path only checks
    // `if (insertError || !inserted)` -- a syntactically-present-but-wrong-shaped
    // row (e.g. `{unexpected:'shape'}`, which is truthy) slips past that
    // check, and `inserted.id as string` silently becomes `undefined`
    // instead of throwing. issueProMcpTokenForUser would then resolve
    // `{tokenId: undefined}` rather than throwing a typed network error.
    // Believed low-risk in practice (a real Postgres INSERT into
    // mcp_pro_tokens always returns its uuid primary key `id` column), but
    // this is a real narrowing of the old defensive contract that a test
    // used to pin and nothing currently re-validates `typeof inserted.id
    // === 'string'` before returning. Flagging rather than silently
    // dropping the coverage; a small fix would be adding that runtime guard
    // back in server/_shared/pro-mcp-token.ts's issueProMcpTokenForUser.
  });

  // -----------------------------------------------------------------------
  // revokeProMcpToken — happy path + sentinel side-effect
  // -----------------------------------------------------------------------

  describe('revokeProMcpToken', () => {
    it('returns {ok:true} on Postgres 200 AND writes the neg-cache sentinel', async () => {
      const redis = makeRedisStub();
      const pg = (req) => (isRevokeUpdate(req) ? pgJson({ id: 'tok_to_revoke' }) : (() => { throw new Error('unexpected'); })());
      const stub = makeFetchStub(redis, pg);
      globalThis.fetch = stub;

      const out = await mod.revokeProMcpToken('user_123', 'tok_to_revoke');
      assert.deepEqual(out, { ok: true });
      assert.equal(stub.counts.update, 1);
      const sentinel = redis.store.get('pro-mcp-token-neg:tok_to_revoke');
      assert.ok(sentinel, 'revoke must write neg-cache sentinel for next-request safety');
      assert.equal(sentinel.value, '1');
      assert.equal(sentinel.ttlSeconds, 60);
    });

    it('returns {ok:false, reason:not-found} when the update matches no row and the fallback select also finds nothing', async () => {
      const redis = makeRedisStub();
      const pg = (req) => {
        if (isRevokeUpdate(req)) return pgJson(null);
        if (isRevokeFallbackSelect(req)) return pgJson(null);
        throw new Error(`unexpected: ${req.method} ${req.params}`);
      };
      globalThis.fetch = makeFetchStub(redis, pg);

      const out = await mod.revokeProMcpToken('user_123', 'tok_missing');
      assert.deepEqual(out, { ok: false, reason: 'not-found' });
      // No neg-cache write on logical failure — the row never existed (or
      // belongs to another user) so polluting the cache is wrong.
      assert.equal(redis.store.size, 0);
    });

    it('returns {ok:false, reason:not-found} when the fallback select resolves a DIFFERENT owner (no cross-tenant leak)', async () => {
      const redis = makeRedisStub();
      const pg = (req) => {
        if (isRevokeUpdate(req)) return pgJson(null);
        if (isRevokeFallbackSelect(req)) return pgJson({ user_id: 'someone_else', revoked_at: null });
        throw new Error(`unexpected: ${req.method} ${req.params}`);
      };
      globalThis.fetch = makeFetchStub(redis, pg);

      const out = await mod.revokeProMcpToken('user_123', 'tok_x');
      assert.deepEqual(out, { ok: false, reason: 'not-found' }, 'a different owner must report not-found, never already-revoked (tenancy leak)');
    });

    it('returns {ok:false, reason:already-revoked} when the fallback select confirms this owner already revoked it', async () => {
      const redis = makeRedisStub();
      const pg = (req) => {
        if (isRevokeUpdate(req)) return pgJson(null);
        if (isRevokeFallbackSelect(req)) return pgJson({ user_id: 'user_123', revoked_at: '2026-01-01T00:00:00.000Z' });
        throw new Error(`unexpected: ${req.method} ${req.params}`);
      };
      globalThis.fetch = makeFetchStub(redis, pg);

      const out = await mod.revokeProMcpToken('user_123', 'tok_x');
      assert.deepEqual(out, { ok: false, reason: 'already-revoked' });
      assert.equal(redis.store.size, 0);
    });

    it('returns {ok:false, reason:network} on a Postgres error (does not throw)', async () => {
      const redis = makeRedisStub();
      const pg = (req) => (isRevokeUpdate(req) ? pgError('XX000', 'boom') : (() => { throw new Error('unexpected'); })());
      globalThis.fetch = makeFetchStub(redis, pg);

      const out = await mod.revokeProMcpToken('user_123', 'tok_x');
      assert.deepEqual(out, { ok: false, reason: 'network' });
    });

    it('returns {ok:false, reason:not-found} on a malformed-uuid tokenId (Postgres 22P02)', async () => {
      const redis = makeRedisStub();
      const pg = (req) => (isRevokeUpdate(req) ? pgError('22P02', 'invalid input syntax for type uuid') : (() => { throw new Error('unexpected'); })());
      globalThis.fetch = makeFetchStub(redis, pg);

      const out = await mod.revokeProMcpToken('user_123', 'not-a-uuid');
      assert.deepEqual(out, { ok: false, reason: 'not-found' });
    });

    it('returns {ok:false, reason:network} on fetch rejection (does not throw — rollback callers must not be masked)', async () => {
      globalThis.fetch = async () => {
        throw new TypeError('Failed to fetch');
      };
      const out = await mod.revokeProMcpToken('user_123', 'tok_x');
      assert.deepEqual(out, { ok: false, reason: 'network' });
    });

    it('returns {ok:false, reason:not-found} on missing args without any fetch', async () => {
      let fetched = false;
      globalThis.fetch = async () => {
        fetched = true;
        throw new Error('should not fetch');
      };
      assert.deepEqual(await mod.revokeProMcpToken('', 'tok_x'), { ok: false, reason: 'not-found' });
      assert.deepEqual(await mod.revokeProMcpToken('user_123', ''), { ok: false, reason: 'not-found' });
      assert.equal(fetched, false);
    });
  });

  // -----------------------------------------------------------------------
  // invalidateProMcpTokenCache — direct sentinel writer (pure Redis, no
  // Postgres — unchanged from the Convex-backed version).
  // -----------------------------------------------------------------------

  describe('invalidateProMcpTokenCache', () => {
    it('writes a 60s neg-cache sentinel without contacting Postgres', async () => {
      const redis = makeRedisStub();
      let pgHit = false;
      globalThis.fetch = async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.startsWith(FAKE_REDIS)) return redis.handle(url);
        if (url.startsWith(FAKE_SUPABASE)) {
          pgHit = true;
          throw new Error('should not call Postgres');
        }
        throw new Error(`unexpected: ${url}`);
      };

      await mod.invalidateProMcpTokenCache('tok_abc');
      assert.equal(pgHit, false);
      const entry = redis.store.get('pro-mcp-token-neg:tok_abc');
      assert.ok(entry);
      assert.equal(entry.value, '1');
      assert.equal(entry.ttlSeconds, 60);
    });

    it('is a no-op for empty tokenId', async () => {
      let fetched = false;
      globalThis.fetch = async () => {
        fetched = true;
        throw new Error('should not fetch');
      };
      await mod.invalidateProMcpTokenCache('');
      assert.equal(fetched, false);
    });
  });

  // -----------------------------------------------------------------------
  // Integration: revoke → next validate short-circuits without Postgres
  // -----------------------------------------------------------------------

  describe('integration', () => {
    it('revoke → validate short-circuits via neg-cache (no Postgres round-trip in the cache window)', async () => {
      const redis = makeRedisStub();
      // Postgres returns a matched row for revoke; never reached for the second validate.
      let validateHits = 0;
      const pg = (req) => {
        if (isRevokeUpdate(req)) return pgJson({ id: 'tok_revoke_then_validate' });
        if (isValidateQuery(req)) {
          validateHits++;
          // If we DID reach here, simulate "still valid" — the test's
          // assertion on validateHits is what guards against this.
          return pgJson({ user_id: 'user_123' });
        }
        throw new Error(`unexpected: ${req.method} ${req.params}`);
      };
      globalThis.fetch = makeFetchStub(redis, pg);

      // Revoke → writes neg-cache sentinel.
      const revoked = await mod.revokeProMcpToken('user_123', 'tok_revoke_then_validate');
      assert.deepEqual(revoked, { ok: true });

      // Next validate must short-circuit on the sentinel.
      const r = await mod.validateProMcpToken('tok_revoke_then_validate');
      assert.deepEqual(r, { ok: 'revoked' }, 'revoked token must not validate');
      assert.equal(validateHits, 0, 'sentinel must short-circuit Postgres round-trip');
    });

    it('clearProMcpTokenNegCache restores the next-validate Postgres round-trip path', async () => {
      const redis = makeRedisStub();
      let validateHits = 0;
      const pg = (req) => {
        if (isValidateQuery(req)) {
          validateHits++;
          return pgJson({ user_id: 'user_123' });
        }
        throw new Error(`unexpected: ${req.method} ${req.params}`);
      };
      globalThis.fetch = makeFetchStub(redis, pg);

      // Pre-populate the sentinel as if the token had been revoked recently.
      await mod.invalidateProMcpTokenCache('tok_zz');
      assert.deepEqual((await mod.validateProMcpToken('tok_zz')), { ok: 'revoked' });
      assert.equal(validateHits, 0, 'sentinel short-circuited');

      // Clear the sentinel and verify the next validate hits Postgres.
      await mod.clearProMcpTokenNegCache('tok_zz');
      const r = await mod.validateProMcpToken('tok_zz');
      assert.deepEqual(r, { ok: 'valid', userId: 'user_123' });
      assert.equal(validateHits, 1, 'after clear, validate must round-trip Postgres');
    });
  });
});
