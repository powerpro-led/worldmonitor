// Unit tests for scripts/lib/followed-countries-fetch.cjs.
//
// Stage 2 of the Convex/Clerk -> Supabase migration: this helper now reads
// `worldmonitor.followed_countries` directly via
// scripts/lib/supabase-admin.cjs instead of POSTing to the retired
// `/relay/followed-countries` Convex HTTP action.
//
// Locks in the contract that `fetchFollowedCountries(userId)` returns
// `string[]` on EVERY soft failure path (missing env, malformed userId,
// Postgres error) so the brief composer can call it without wrapping in
// try/catch. The bias is purely a soft uplift; a transient fetch failure
// must degrade to today's behavior, not block the brief.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const originalConsoleWarn = console.warn;

const supabaseAdminPath = require.resolve('../scripts/lib/supabase-admin.cjs');
const fetchHelperPath = require.resolve('../scripts/lib/followed-countries-fetch.cjs');

// Mute console.warn output during tests — every soft-failure path emits a
// [followed-countries-fetch] line by design.
function withMutedWarn(fn) {
  return async (...args) => {
    console.warn = () => {};
    try {
      return await fn(...args);
    } finally {
      console.warn = originalConsoleWarn;
    }
  };
}

// Inject a fake `getSupabaseAdmin` into require.cache before re-requiring
// the fetch helper (which imports it via a relative `require`), then clear
// both cache entries afterward so other test files get the real modules.
function loadHelperWithFakeSupabase(fakeAdmin) {
  require.cache[supabaseAdminPath] = {
    id: supabaseAdminPath,
    filename: supabaseAdminPath,
    loaded: true,
    exports: { getSupabaseAdmin: () => fakeAdmin },
  };
  delete require.cache[fetchHelperPath];
  return require(fetchHelperPath);
}

describe('fetchFollowedCountries', () => {
  afterEach(() => {
    console.warn = originalConsoleWarn;
    delete require.cache[supabaseAdminPath];
    delete require.cache[fetchHelperPath];
  });

  it('happy path: rows → country codes in query order', async () => {
    let captured = null;
    const order = async () => {
      captured = true;
      return { data: [{ country: 'US' }, { country: 'GB' }], error: null };
    };
    const eq = (col, val) => {
      captured = { col, val };
      return { order };
    };
    const { fetchFollowedCountries } = loadHelperWithFakeSupabase({
      from: (table) => {
        assert.equal(table, 'followed_countries');
        return { select: () => ({ eq }) };
      },
    });
    const result = await fetchFollowedCountries('user_abc');
    assert.deepEqual(result, ['US', 'GB']);
  });

  it('happy empty: no rows → []', async () => {
    const { fetchFollowedCountries } = loadHelperWithFakeSupabase({
      from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) }),
    });
    const result = await fetchFollowedCountries('user_abc');
    assert.deepEqual(result, []);
  });

  it('Postgres error → [] (warns)', withMutedWarn(async () => {
    let warned = false;
    console.warn = (msg) => {
      if (typeof msg === 'string' && msg.includes('query failed')) warned = true;
    };
    const { fetchFollowedCountries } = loadHelperWithFakeSupabase({
      from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: null, error: { message: 'boom' } }) }) }) }),
    });
    const result = await fetchFollowedCountries('user_abc');
    assert.deepEqual(result, []);
    assert.equal(warned, true);
  }));

  it('thrown error / transport failure → [] (does NOT throw)', withMutedWarn(async () => {
    const { fetchFollowedCountries } = loadHelperWithFakeSupabase({
      from: () => { throw new Error('ECONNREFUSED'); },
    });
    const result = await fetchFollowedCountries('user_abc');
    assert.deepEqual(result, []);
  }));

  it('non-string entries in rows filtered out', async () => {
    const { fetchFollowedCountries } = loadHelperWithFakeSupabase({
      from: () => ({
        select: () => ({
          eq: () => ({
            order: async () => ({
              data: [{ country: 'US' }, { country: 42 }, { country: null }, { country: '' }, { country: 'GB' }],
              error: null,
            }),
          }),
        }),
      }),
    });
    const result = await fetchFollowedCountries('user_abc');
    assert.deepEqual(result, ['US', 'GB']);
  });

  it('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY → [] (no query attempted)', withMutedWarn(async () => {
    const { fetchFollowedCountries } = loadHelperWithFakeSupabase(null);
    const result = await fetchFollowedCountries('user_abc');
    assert.deepEqual(result, []);
  }));

  it('empty userId → [] (no query attempted)', withMutedWarn(async () => {
    let attempted = false;
    const { fetchFollowedCountries } = loadHelperWithFakeSupabase({
      from: () => { attempted = true; return { select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) }; },
    });
    const result = await fetchFollowedCountries('');
    assert.deepEqual(result, []);
    assert.equal(attempted, false);
  }));

  it('non-string userId → [] (no query attempted)', withMutedWarn(async () => {
    let attempted = false;
    const { fetchFollowedCountries } = loadHelperWithFakeSupabase({
      from: () => { attempted = true; return { select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) }; },
    });
    const result = await fetchFollowedCountries(12345);
    assert.deepEqual(result, []);
    assert.equal(attempted, false);
  }));
});
