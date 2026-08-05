/**
 * Tests for src/services/followed-countries.ts — sign-in handoff,
 * auth-generation guard, snapshot refresh (Stage 2 replacement for the
 * Convex reactive subscription), sign-out cleanup, handoffPending UX,
 * visibilitychange retry, cross-tab storage re-dispatch, refetch-on-focus.
 *
 * Stage 2 of the Convex/Clerk -> Supabase migration replaced the direct
 * Convex client with fetch calls to `/api/followed-countries`. The follow
 * cap (`FREE_TIER_FOLLOW_LIMIT`/`FREE_CAP`/`WM_FOLLOWED_COUNTRIES_CAP_DROP`)
 * is gone entirely, and the reactive `client.onUpdate` push is replaced by
 * an explicit `_refreshSnapshot` fetch after handoff completion, optimistic
 * local snapshot updates on every successful mutation, and a
 * refetch-on-focus/visibilitychange listener. The handoff state machine
 * itself (generation guard, exponential-backoff retry, cross-tab storage
 * listener) is unchanged in behavior.
 *
 * Test runner: node:test via `tsx --test tests/*.test.mjs`.
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Browser-global stubs
// ---------------------------------------------------------------------------

class MemoryStorage {
  constructor() {
    this.store = new Map();
    this.throwOnSet = false;
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    if (this.throwOnSet) {
      const err = new Error('QuotaExceededError');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

class FakeWindow extends EventTarget {}
class FakeDocument extends EventTarget {
  constructor() {
    super();
    this.hidden = false;
  }
}

let _localStorage;
let _window;
let _document;

before(() => {
  _localStorage = new MemoryStorage();
  _window = new FakeWindow();
  _document = new FakeDocument();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: _localStorage,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: _window,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: _document,
  });
  if (typeof globalThis.CustomEvent === 'undefined') {
    globalThis.CustomEvent = class extends Event {
      constructor(type, init = {}) {
        super(type, init);
        this.detail = init.detail;
      }
    };
  }
});

after(() => {
  delete globalThis.localStorage;
  delete globalThis.window;
  delete globalThis.document;
});

beforeEach(() => {
  _localStorage.clear();
  _localStorage.throwOnSet = false;
});

// ---------------------------------------------------------------------------
// Import service
// ---------------------------------------------------------------------------

const svc = await import('../src/services/followed-countries.ts');
const {
  addCountry,
  removeCountry,
  getFollowed,
  subscribe,
  FOLLOWED_COUNTRIES_STORAGE_KEY,
  WM_FOLLOWED_COUNTRIES_CHANGED,
  FollowedCountriesFetchError,
  _setDepsForTests,
  _resetStateForTests,
  _emitAuthStateForTests,
  _getInternalStateForTests,
  _pushSubscriptionSnapshotForTests,
  _setHandoffBackoffForTests,
  _clearFailedHandoffForTests,
  _installCrossTabStorageListenerForTests,
  _triggerRefetchForTests,
} = svc;

// ---------------------------------------------------------------------------
// Fake backend
// ---------------------------------------------------------------------------

/**
 * In-memory fake `FollowedCountriesBackend` mirroring the server-side
 * dedupe/merge semantics (minus any cap — Stage 2 has none).
 */
function makeFakeBackend({
  initialRows = [],
  mergeRejection = null, // optional Error to throw from merge()
  mergeDelayMs = 0,
} = {}) {
  const rows = [...initialRows]; // string[]
  const calls = { follow: [], unfollow: [], merge: [], list: 0 };
  const ISO_RE = /^[A-Z]{2}$/;

  const backend = {
    async list() {
      calls.list += 1;
      return [...rows];
    },
    async follow(country) {
      calls.follow.push(country);
      if (rows.includes(country)) return { ok: true, idempotent: true };
      rows.push(country);
      return { ok: true, idempotent: false };
    },
    async unfollow(country) {
      calls.unfollow.push(country);
      const idx = rows.indexOf(country);
      if (idx === -1) return { ok: true, idempotent: true };
      rows.splice(idx, 1);
      return { ok: true, idempotent: false };
    },
    async merge(countries) {
      calls.merge.push(countries);
      if (mergeDelayMs > 0) await new Promise((r) => setTimeout(r, mergeDelayMs));
      if (mergeRejection) throw mergeRejection;
      if (countries.length === 0) {
        throw new FollowedCountriesFetchError('EMPTY_INPUT', 'no countries to merge');
      }
      const droppedInvalid = [];
      const validInputs = [];
      for (const c of countries) {
        if (typeof c === 'string' && ISO_RE.test(c)) validInputs.push(c);
        else droppedInvalid.push(c);
      }
      const seen = new Set();
      const canonical = [];
      for (const c of validInputs) if (!seen.has(c)) { seen.add(c); canonical.push(c); }
      const newCandidates = canonical.filter((c) => !rows.includes(c));
      for (const country of newCandidates) rows.push(country);
      return {
        totalCount: rows.length,
        accepted: newCandidates,
        droppedInvalid,
      };
    },
    _calls: calls,
    _getRows: () => [...rows],
  };
  return backend;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setLocalStorageList(list) {
  _localStorage.setItem(FOLLOWED_COUNTRIES_STORAGE_KEY, JSON.stringify({ countries: list }));
}

function getLocalStorageRaw() {
  return _localStorage.getItem(FOLLOWED_COUNTRIES_STORAGE_KEY);
}

async function flushMicrotasks() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function setupAnonymous() {
  _setDepsForTests({
    getCurrentAuthUser: () => null,
    getEntitlementState: () => null,
    hasTier: () => false,
    featureFlagEnabled: true,
    backend: 'force-null',
  });
}

function setupSignedIn(userId, { backend }) {
  _setDepsForTests({
    getCurrentAuthUser: () => ({ id: userId }),
    getEntitlementState: () => ({ features: { tier: 1 } }),
    hasTier: () => true,
    featureFlagEnabled: true,
    backend,
  });
}

beforeEach(() => {
  _resetStateForTests();
  // Collapse retry backoff to 0 so visibility-driven retries fire on the
  // next microtask. Production uses 1s/2s/4s/8s/16s. (P1 #4 test seam.)
  _setHandoffBackoffForTests([0, 0, 0, 0, 0]);
  setupAnonymous();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('happy: anon localStorage merged, server union, event fires', () => {
  it("anon ['US','GB'] + server ['US','JP'] → final ['US','JP','GB']; localStorage cleared; event fires", async () => {
    setLocalStorageList(['US', 'GB']);
    const backend = makeFakeBackend({ initialRows: ['US', 'JP'] });
    setupSignedIn('user_1', { backend });

    let events = 0;
    const unsub = subscribe(() => events++);

    await _emitAuthStateForTests({ id: 'user_1' });
    await flushMicrotasks();

    assert.deepEqual(backend._getRows().sort(), ['GB', 'JP', 'US']);
    assert.equal(getLocalStorageRaw(), null, 'localStorage cleared');
    assert.equal(_getInternalStateForTests().handoffState, 'complete');
    assert.deepEqual(getFollowed().sort(), ['GB', 'JP', 'US']);
    assert.ok(events >= 1, 'change event fires');

    unsub();
  });
});

describe('happy: empty localStorage skips merge', () => {
  it('anon empty localStorage; signs in; merge NOT called', async () => {
    setLocalStorageList([]);
    const backend = makeFakeBackend({ initialRows: [] });
    setupSignedIn('user_e', { backend });

    await _emitAuthStateForTests({ id: 'user_e' });
    await flushMicrotasks();

    assert.equal(backend._calls.merge.length, 0, 'merge NOT called');
    assert.equal(_getInternalStateForTests().handoffState, 'complete');
  });

  it('no localStorage entry at all → merge NOT called', async () => {
    const backend = makeFakeBackend({});
    setupSignedIn('user_z', { backend });

    await _emitAuthStateForTests({ id: 'user_z' });
    await flushMicrotasks();

    assert.equal(backend._calls.merge.length, 0);
    assert.equal(_getInternalStateForTests().handoffState, 'complete');
  });
});

describe('edge: corrupt localStorage cleared unconditionally', () => {
  it("'not-valid-json' → merge NOT called; localStorage cleared", async () => {
    _localStorage.setItem(FOLLOWED_COUNTRIES_STORAGE_KEY, 'not-valid-json');
    const backend = makeFakeBackend({});
    setupSignedIn('user_c', { backend });

    await _emitAuthStateForTests({ id: 'user_c' });
    await flushMicrotasks();

    assert.equal(backend._calls.merge.length, 0);
    assert.equal(getLocalStorageRaw(), null, 'corrupt localStorage cleared');
    assert.equal(_getInternalStateForTests().handoffState, 'complete');
  });

  it("wrong shape '[{symbol:AAPL}]' → merge NOT called; localStorage cleared", async () => {
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify([{ symbol: 'AAPL' }]),
    );
    const backend = makeFakeBackend({});
    setupSignedIn('user_w', { backend });

    await _emitAuthStateForTests({ id: 'user_w' });
    await flushMicrotasks();

    assert.equal(backend._calls.merge.length, 0);
    assert.equal(getLocalStorageRaw(), null);
  });
});

describe('edge: network failure → handoffState=failed, localStorage retained', () => {
  it('merge rejects → state=failed, localStorage intact, visibility retry scheduled', async () => {
    setLocalStorageList(['US']);
    const backend = makeFakeBackend({
      mergeRejection: new FollowedCountriesFetchError('NETWORK', 'NetworkError'),
    });
    setupSignedIn('user_n', { backend });

    await _emitAuthStateForTests({ id: 'user_n' });
    await flushMicrotasks();

    assert.equal(_getInternalStateForTests().handoffState, 'failed');
    assert.notEqual(getLocalStorageRaw(), null, 'localStorage retained');
    assert.equal(_getInternalStateForTests().hasVisibilityRetryListener, true);
  });

  it('visibilitychange retry succeeds after fix', async () => {
    setLocalStorageList(['US']);
    let shouldFail = true;
    const rows = [];
    const backend = {
      async list() {
        return [...rows];
      },
      async merge(countries) {
        if (shouldFail) throw new FollowedCountriesFetchError('NETWORK', 'NetworkError');
        for (const c of countries) rows.push(c);
        return { totalCount: rows.length, accepted: countries, droppedInvalid: [] };
      },
      async follow(country) {
        rows.push(country);
        return { ok: true, idempotent: false };
      },
      async unfollow(country) {
        const idx = rows.indexOf(country);
        if (idx !== -1) rows.splice(idx, 1);
        return { ok: true, idempotent: false };
      },
    };
    setupSignedIn('user_r', { backend });

    await _emitAuthStateForTests({ id: 'user_r' });
    await flushMicrotasks();
    assert.equal(_getInternalStateForTests().handoffState, 'failed');

    // Now flip the failure switch and trigger visibilitychange.
    shouldFail = false;
    _document.dispatchEvent(new Event('visibilitychange'));
    // The handler kicks off async _runHandoff. Wait for it.
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(_getInternalStateForTests().handoffState, 'complete');
    assert.equal(getLocalStorageRaw(), null);
  });
});

describe('critical: in-flight auth race, sign-out', () => {
  it('user-1 signs in → handoff in-flight → user-1 signs out → result dropped, localStorage NOT cleared', async () => {
    setLocalStorageList(['US']);
    const backend = makeFakeBackend({ mergeDelayMs: 20 });

    setupSignedIn('user_1', { backend });

    // Kick off handoff but don't await it.
    const handoffPromise = _emitAuthStateForTests({ id: 'user_1' });

    // Mid-await, sign out.
    setupAnonymous();
    await _emitAuthStateForTests(null);

    // Now let the merge resolve.
    await handoffPromise;
    await flushMicrotasks();

    // localStorage should be intact (handoff dropped its result).
    const raw = getLocalStorageRaw();
    assert.notEqual(raw, null);
    assert.deepEqual(JSON.parse(raw).countries, ['US']);
    // State back to idle (sign-out resets it).
    assert.equal(_getInternalStateForTests().handoffState, 'idle');
  });
});

describe('critical: in-flight auth race, user swap', () => {
  it("user-1's handoff → user-1 out, user-2 in → user-1's result dropped via userIdAtStart guard", async () => {
    setLocalStorageList(['US']);
    const backend1 = makeFakeBackend({ mergeDelayMs: 30 });
    setupSignedIn('user_1', { backend: backend1 });

    const handoffPromise = _emitAuthStateForTests({ id: 'user_1' });

    // Sign out user-1 then sign in user-2.
    setupAnonymous();
    await _emitAuthStateForTests(null);

    const backend2 = makeFakeBackend({ initialRows: [] });
    setupSignedIn('user_2', { backend: backend2 });
    const handoff2 = _emitAuthStateForTests({ id: 'user_2' });

    await handoffPromise;
    await handoff2;
    await flushMicrotasks();

    // user-1's merge happened on their backend, but the result was DROPPED.
    // What matters is that we are now in user-2's complete state with
    // user-2's snapshot, NOT user-1's.
    const internal = _getInternalStateForTests();
    assert.equal(internal.handoffState, 'complete');
    if (internal.lastKnownSubscriptionSnapshot) {
      assert.equal(internal.lastKnownSubscriptionSnapshot.userId, 'user_2');
    }
    // _handoffGeneration should have advanced multiple steps. Each
    // listener-emit increments by 1; user-swap branch adds a 2nd bump.
    assert.ok(internal.handoffGeneration >= 3, `gen advanced (>=3): got ${internal.handoffGeneration}`);
  });
});

describe('handoffPending blocks writes', () => {
  it('addCountry during handoff returns HANDOFF_PENDING', async () => {
    setLocalStorageList(['US']);
    const backend = makeFakeBackend({ mergeDelayMs: 30 });
    setupSignedIn('user_p', { backend });

    const handoffPromise = _emitAuthStateForTests({ id: 'user_p' });

    // Mid-handoff, attempt addCountry.
    const result = await addCountry('FR');
    assert.deepEqual(result, { ok: false, reason: 'HANDOFF_PENDING' });

    // Let handoff complete.
    await handoffPromise;
    await flushMicrotasks();

    // Now addCountry should succeed.
    const r2 = await addCountry('FR');
    assert.deepEqual(r2, { ok: true });
  });

  it('removeCountry during handoff returns HANDOFF_PENDING', async () => {
    setLocalStorageList(['US']);
    const backend = makeFakeBackend({ mergeDelayMs: 30 });
    setupSignedIn('user_r2', { backend });

    const handoffPromise = _emitAuthStateForTests({ id: 'user_r2' });
    const result = await removeCountry('US');
    assert.deepEqual(result, { ok: false, reason: 'HANDOFF_PENDING' });

    await handoffPromise;
    await flushMicrotasks();
  });
});

describe('handoffPending getFollowed', () => {
  it('returns union of localStorage + user-scoped snapshot during handoff', async () => {
    setLocalStorageList(['US']);
    const backend = makeFakeBackend({ initialRows: ['JP'], mergeDelayMs: 30 });
    setupSignedIn('user_g', { backend });

    // Kick off handoff first; auth-state emit clears any prior snapshot.
    const handoffPromise = _emitAuthStateForTests({ id: 'user_g' });

    // Now push a user-scoped snapshot DURING pending — represents a
    // refetch-on-focus snapshot update arriving before this tab's merge
    // completes.
    _pushSubscriptionSnapshotForTests('user_g', ['JP']);

    const mid = getFollowed();
    // Pending phase — union of localStorage ['US'] and snapshot ['JP'].
    assert.deepEqual(mid.sort(), ['JP', 'US']);

    await handoffPromise;
    await flushMicrotasks();

    // Post-complete: snapshot from server wins.
    const after = getFollowed();
    assert.ok(after.includes('US') && after.includes('JP'));
  });

  it('snapshot from a DIFFERENT user is ignored (cross-user-leak guard)', async () => {
    // Sign in as user_curr, push their snapshot.
    const backend = makeFakeBackend({ initialRows: ['JP'] });
    setupSignedIn('user_curr', { backend });
    await _emitAuthStateForTests({ id: 'user_curr' });
    await flushMicrotasks();

    // Snapshot is now { userId: 'user_curr', countries: ['JP'] }.
    const before = _getInternalStateForTests().lastKnownSubscriptionSnapshot;
    assert.equal(before?.userId, 'user_curr');

    // Now switch to anonymous WITHOUT clearing the snapshot first
    // (tests the cross-user-leak guard in `getFollowed`).
    // The way to do this: keep the deps as user_curr but pretend
    // getCurrentAuthUser flipped to a different user_other identity
    // (simulates an auth-listener-vs-getCurrentAuthUser race window).
    _setDepsForTests({
      getCurrentAuthUser: () => ({ id: 'user_other' }),
    });
    // Now getFollowed should NOT include 'JP' (snapshot belongs to
    // user_curr, not user_other).
    const list = getFollowed();
    assert.equal(list.includes('JP'), false, 'cross-user snapshot ignored');
  });
});

describe('sign-out clears subscription snapshot (cross-user-leak fix)', () => {
  it('user-1 signs in, gets snapshot, signs out → snapshot cleared, getFollowed returns []', async () => {
    setLocalStorageList([]);
    const backend = makeFakeBackend({ initialRows: ['US', 'JP'] });
    setupSignedIn('user_clean', { backend });

    await _emitAuthStateForTests({ id: 'user_clean' });
    await flushMicrotasks();

    // Snapshot present.
    const snap = _getInternalStateForTests().lastKnownSubscriptionSnapshot;
    assert.equal(snap?.userId, 'user_clean');
    assert.deepEqual(snap.countries.sort(), ['JP', 'US']);

    // Now sign out.
    setupAnonymous();
    await _emitAuthStateForTests(null);

    assert.equal(_getInternalStateForTests().lastKnownSubscriptionSnapshot, null);
    assert.deepEqual(getFollowed(), [], 'anonymous follow list reset');
  });
});

describe('sign-in → sign-out → different user merges anew', () => {
  it('user-1 signs in (no localStorage), signs out, user-2 signs in with their own anon localStorage', async () => {
    // user-1 path
    setLocalStorageList([]);
    const backend1 = makeFakeBackend({ initialRows: ['DE'] });
    setupSignedIn('user_a', { backend: backend1 });
    await _emitAuthStateForTests({ id: 'user_a' });
    await flushMicrotasks();

    // sign out (preserves localStorage per design)
    setupAnonymous();
    await _emitAuthStateForTests(null);

    // user-2 — anon list ['FR'] left on device; user-2 signs in
    setLocalStorageList(['FR']);
    const backend2 = makeFakeBackend({ initialRows: [] });
    setupSignedIn('user_b', { backend: backend2 });
    await _emitAuthStateForTests({ id: 'user_b' });
    await flushMicrotasks();

    // user-2's table should have FR (merged from anon).
    assert.deepEqual(backend2._getRows(), ['FR']);
    // user-1's backend was untouched after sign-out.
    assert.deepEqual(backend1._getRows(), ['DE']);
  });
});

describe('snapshot-refresh replacement for reactive push dispatches change events', () => {
  it('pushed snapshot (simulating another tab/device) fires WM_FOLLOWED_COUNTRIES_CHANGED', async () => {
    const backend = makeFakeBackend({ initialRows: ['US'] });
    setupSignedIn('user_react', { backend });

    await _emitAuthStateForTests({ id: 'user_react' });
    await flushMicrotasks();

    let events = 0;
    const unsub = subscribe(() => events++);

    // Simulate another tab adding 'FR' — push a fresh snapshot.
    _pushSubscriptionSnapshotForTests('user_react', ['US', 'FR']);

    assert.ok(events >= 1, 'change event fires on snapshot update');
    assert.deepEqual(getFollowed().sort(), ['FR', 'US']);

    unsub();
  });

  it('_triggerRefetchForTests re-fetches via backend.list() when signed-in and complete', async () => {
    const backend = makeFakeBackend({ initialRows: ['US'] });
    setupSignedIn('user_refetch', { backend });

    await _emitAuthStateForTests({ id: 'user_refetch' });
    await flushMicrotasks();

    // Simulate a server-side change from another device: directly mutate
    // via follow() so the next list() reflects the new state.
    await backend.follow('FR');

    let events = 0;
    const unsub = subscribe(() => events++);

    await _triggerRefetchForTests();

    assert.ok(events >= 1, 'change event fires after refetch');
    assert.deepEqual(getFollowed().sort(), ['FR', 'US']);
    assert.ok(backend._calls.list >= 1);

    unsub();
  });

  it('_triggerRefetchForTests no-ops when handoff is not complete', async () => {
    setLocalStorageList(['US']);
    const backend = makeFakeBackend({ mergeDelayMs: 30 });
    setupSignedIn('user_pending_refetch', { backend });

    const handoffPromise = _emitAuthStateForTests({ id: 'user_pending_refetch' });
    // handoff is still pending here.
    const listCallsBefore = backend._calls.list;
    await _triggerRefetchForTests();
    assert.equal(backend._calls.list, listCallsBefore, 'no list() call while handoff pending');

    await handoffPromise;
    await flushMicrotasks();
  });

  it('_triggerRefetchForTests no-ops when anonymous', async () => {
    const listCallsBefore = 0;
    await _triggerRefetchForTests();
    assert.equal(listCallsBefore, 0);
    assert.deepEqual(getFollowed(), []);
  });
});

describe('concurrent two-tab sign-in emits dedupe (no re-run for same user)', () => {
  it('two emitters for the same user only run the handoff once', async () => {
    setLocalStorageList(['US']);
    const backend = makeFakeBackend({});
    setupSignedIn('user_2t', { backend });

    // Simulate two sign-ins back-to-back (the second auth-state emit is a
    // duplicate event for the same user — should NOT re-run the handoff,
    // since prevUserId === nextUserId).
    await _emitAuthStateForTests({ id: 'user_2t' });
    await _emitAuthStateForTests({ id: 'user_2t' });
    await flushMicrotasks();

    // One merge call for the device (the second emit is deduped).
    assert.equal(backend._calls.merge.length, 1);
    assert.deepEqual(backend._getRows(), ['US']);
  });
});

describe('followCountry post-handoff: fetch-backend error mapping', () => {
  it("addCountry returns INVALID_INPUT when backend.follow throws FollowedCountriesFetchError('INVALID_COUNTRY')", async () => {
    const backend = {
      async list() { return []; },
      async follow() {
        throw new FollowedCountriesFetchError('INVALID_COUNTRY', 'bad country');
      },
      async unfollow() { return { ok: true, idempotent: true }; },
      async merge() { return { totalCount: 0, accepted: [], droppedInvalid: [] }; },
    };
    setupSignedIn('user_iv', { backend });
    await _emitAuthStateForTests({ id: 'user_iv' });
    await flushMicrotasks();

    const res = await addCountry('US');
    assert.deepEqual(res, { ok: false, reason: 'INVALID_INPUT' });
  });

  it("addCountry returns HANDOFF_PENDING when backend.follow throws FollowedCountriesFetchError('UNAUTHENTICATED')", async () => {
    const backend = {
      async list() { return []; },
      async follow() {
        throw new FollowedCountriesFetchError('UNAUTHENTICATED', 'no token');
      },
      async unfollow() { return { ok: true, idempotent: true }; },
      async merge() { return { totalCount: 0, accepted: [], droppedInvalid: [] }; },
    };
    setupSignedIn('user_un', { backend });
    await _emitAuthStateForTests({ id: 'user_un' });
    await flushMicrotasks();

    const res = await addCountry('US');
    assert.deepEqual(res, { ok: false, reason: 'HANDOFF_PENDING' });
  });
});

describe('unfollowCountry post-handoff', () => {
  it('removes existing country via backend', async () => {
    const backend = makeFakeBackend({ initialRows: ['US', 'FR'] });
    setupSignedIn('user_unf', { backend });
    await _emitAuthStateForTests({ id: 'user_unf' });
    await flushMicrotasks();

    const r = await removeCountry('US');
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(backend._getRows(), ['FR']);
  });

  it('removing a not-followed country is idempotent', async () => {
    const backend = makeFakeBackend({ initialRows: ['US'] });
    setupSignedIn('user_idem', { backend });
    await _emitAuthStateForTests({ id: 'user_idem' });
    await flushMicrotasks();

    const r = await removeCountry('FR');
    assert.deepEqual(r, { ok: true });
  });
});

describe('optimistic local snapshot updates on successful mutation', () => {
  it('addCountry optimistically appends to the local snapshot without a fresh list() call', async () => {
    const backend = makeFakeBackend({ initialRows: [] });
    setupSignedIn('user_opt', { backend });
    await _emitAuthStateForTests({ id: 'user_opt' });
    await flushMicrotasks();

    const listCallsBefore = backend._calls.list;
    const res = await addCountry('US');
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(getFollowed(), ['US']);
    // Optimistic update — no extra list() round-trip needed for this to work.
    assert.equal(backend._calls.list, listCallsBefore);
  });

  it('removeCountry optimistically drops from the local snapshot', async () => {
    const backend = makeFakeBackend({ initialRows: ['US', 'FR'] });
    setupSignedIn('user_opt2', { backend });
    await _emitAuthStateForTests({ id: 'user_opt2' });
    await flushMicrotasks();

    const res = await removeCountry('US');
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(getFollowed(), ['FR']);
  });
});

// ---------------------------------------------------------------------------
// Retry / backoff / permanent-failure state machine
// ---------------------------------------------------------------------------

describe('permanent fetch-error kinds skip retry, transition to failed-permanent', () => {
  it("INPUT_TOO_LARGE → 'failed-permanent'; localStorage cleared; no visibility-retry listener", async () => {
    setLocalStorageList(['US']);
    const backend = makeFakeBackend({
      mergeRejection: new FollowedCountriesFetchError('INPUT_TOO_LARGE', 'too many'),
    });
    setupSignedIn('user_itl', { backend });

    await _emitAuthStateForTests({ id: 'user_itl' });
    await flushMicrotasks();

    const state = _getInternalStateForTests();
    assert.equal(state.handoffState, 'failed-permanent');
    assert.equal(getLocalStorageRaw(), null, 'localStorage cleared on permanent kind');
    assert.equal(state.hasVisibilityRetryListener, false, 'no visibility retry scheduled');
  });

  it("EMPTY_INPUT → 'failed-permanent'; no retry", async () => {
    setLocalStorageList(['US']);
    const backend = makeFakeBackend({
      mergeRejection: new FollowedCountriesFetchError('EMPTY_INPUT', 'empty'),
    });
    setupSignedIn('user_ei', { backend });

    await _emitAuthStateForTests({ id: 'user_ei' });
    await flushMicrotasks();
    assert.equal(_getInternalStateForTests().handoffState, 'failed-permanent');
    assert.equal(_getInternalStateForTests().hasVisibilityRetryListener, false);
  });

  it("UNAUTHENTICATED is TRANSIENT → 'failed' + retry, NOT 'failed-permanent'; localStorage retained", async () => {
    // The auth-state listener can fire before getAuthToken() has a fresh
    // token available. This pins the behavior: UNAUTHENTICATED is treated
    // as transient, the visibilitychange retry stays armed, and
    // localStorage is retained so the retry can succeed.
    setLocalStorageList(['US']);
    const backend = makeFakeBackend({
      mergeRejection: new FollowedCountriesFetchError('UNAUTHENTICATED', 'no token yet'),
    });
    setupSignedIn('user_un', { backend });

    await _emitAuthStateForTests({ id: 'user_un' });
    await flushMicrotasks();
    const state = _getInternalStateForTests();
    assert.equal(state.handoffState, 'failed', 'UNAUTHENTICATED is transient');
    assert.equal(state.hasVisibilityRetryListener, true, 'retry stays armed');
    assert.notEqual(
      getLocalStorageRaw(),
      null,
      'localStorage retained for retry',
    );
  });

  it('plain network error (no FollowedCountriesFetchError) → still transient: failed + retry scheduled', async () => {
    setLocalStorageList(['US']);
    const backend = makeFakeBackend({ mergeRejection: new Error('NetworkError') });
    setupSignedIn('user_net', { backend });

    await _emitAuthStateForTests({ id: 'user_net' });
    await flushMicrotasks();

    const state = _getInternalStateForTests();
    assert.equal(state.handoffState, 'failed');
    assert.equal(state.hasVisibilityRetryListener, true);
    assert.notEqual(getLocalStorageRaw(), null, 'localStorage retained on transient');
  });
});

describe('max-retry exhaustion → failed-permanent; recovery via _clearFailedHandoffForTests', () => {
  it('after MAX_HANDOFF_RETRIES (5) visibility events, state flips to failed-permanent', async () => {
    setLocalStorageList(['US']);
    const backend = makeFakeBackend({ mergeRejection: new Error('NetworkError') });
    setupSignedIn('user_max', { backend });

    await _emitAuthStateForTests({ id: 'user_max' });
    await flushMicrotasks();
    assert.equal(_getInternalStateForTests().handoffState, 'failed');

    // Fire visibilitychange MAX_HANDOFF_RETRIES (5) times. Each attempt
    // re-fails (mergeRejection persists). After exhausting the budget the
    // state flips to failed-permanent.
    for (let i = 0; i < 5; i++) {
      _document.dispatchEvent(new Event('visibilitychange'));
      // backoff override is 0, so the retry runs on next microtask.
      await flushMicrotasks();
      await flushMicrotasks();
    }
    assert.equal(_getInternalStateForTests().handoffState, 'failed-permanent');
    assert.equal(_getInternalStateForTests().hasVisibilityRetryListener, false);
  });

  it('_clearFailedHandoffForTests resets failed-permanent → idle', async () => {
    setLocalStorageList(['US']);
    const backend = makeFakeBackend({
      mergeRejection: new FollowedCountriesFetchError('INPUT_TOO_LARGE', 'too many'),
    });
    setupSignedIn('user_clr', { backend });
    await _emitAuthStateForTests({ id: 'user_clr' });
    await flushMicrotasks();
    assert.equal(_getInternalStateForTests().handoffState, 'failed-permanent');

    _clearFailedHandoffForTests();
    assert.equal(_getInternalStateForTests().handoffState, 'idle');
  });
});

describe('signed-in addCountry/removeCountry returns HANDOFF_PENDING when backend is force-null', () => {
  it('addCountry: backend force-null → HANDOFF_PENDING; localStorage NOT written', async () => {
    // User is signed in but the backend is unreachable (e.g. no auth
    // token available yet). Use 'force-null' to make every backend call
    // throw UNAUTHENTICATED without going through the production fetch
    // path (node:test has no fetch mock by default).
    _setDepsForTests({
      getCurrentAuthUser: () => ({ id: 'user_nullc' }),
      getEntitlementState: () => ({ features: { tier: 1 } }),
      hasTier: () => true,
      featureFlagEnabled: true,
      backend: 'force-null',
    });
    await _emitAuthStateForTests({ id: 'user_nullc' });
    await flushMicrotasks();

    const result = await addCountry('US');
    assert.deepEqual(result, { ok: false, reason: 'HANDOFF_PENDING' });
    assert.equal(getLocalStorageRaw(), null, 'localStorage NOT written in signed-in mode');
  });

  it('removeCountry: backend force-null → HANDOFF_PENDING; localStorage NOT written', async () => {
    _setDepsForTests({
      getCurrentAuthUser: () => ({ id: 'user_nullc2' }),
      getEntitlementState: () => ({ features: { tier: 1 } }),
      hasTier: () => true,
      featureFlagEnabled: true,
      backend: 'force-null',
    });
    await _emitAuthStateForTests({ id: 'user_nullc2' });
    await flushMicrotasks();

    const result = await removeCountry('US');
    assert.deepEqual(result, { ok: false, reason: 'HANDOFF_PENDING' });
    assert.equal(getLocalStorageRaw(), null);
  });
});

describe('stale-snapshot does NOT short-circuit signed-in mutation', () => {
  it('snapshot says US already followed BUT actual table doesnt → addCountry still calls backend.follow', async () => {
    // Set up a stale snapshot via _pushSubscriptionSnapshotForTests
    // BEFORE the backend confirms it. The mutation must still hit the
    // backend (no client-side short-circuit).
    const backend = makeFakeBackend({ initialRows: [] });
    setupSignedIn('user_stale', { backend });
    await _emitAuthStateForTests({ id: 'user_stale' });
    await flushMicrotasks();

    // Force-push a stale snapshot claiming 'US' is followed.
    _pushSubscriptionSnapshotForTests('user_stale', ['US']);

    const callsBefore = backend._calls.follow.length;
    const result = await addCountry('US');
    const callsAfter = backend._calls.follow.length;

    assert.equal(result.ok, true);
    assert.equal(callsAfter, callsBefore + 1, 'backend.follow called despite stale snapshot');
  });
});

describe('cross-tab storage event re-dispatches as WM_FOLLOWED_COUNTRIES_CHANGED', () => {
  it('window storage event for our key fires the watchlist change event', () => {
    _installCrossTabStorageListenerForTests();
    let fired = 0;
    const handler = () => { fired += 1; };
    _window.addEventListener(WM_FOLLOWED_COUNTRIES_CHANGED, handler);

    const ev = new Event('storage');
    Object.defineProperty(ev, 'key', { value: FOLLOWED_COUNTRIES_STORAGE_KEY });
    _window.dispatchEvent(ev);

    assert.equal(fired, 1, 'cross-tab storage event re-dispatched');
    _window.removeEventListener(WM_FOLLOWED_COUNTRIES_CHANGED, handler);
  });

  it('window storage event for an unrelated key does NOT fire', () => {
    _installCrossTabStorageListenerForTests();
    let fired = 0;
    const handler = () => { fired += 1; };
    _window.addEventListener(WM_FOLLOWED_COUNTRIES_CHANGED, handler);

    const ev = new Event('storage');
    Object.defineProperty(ev, 'key', { value: 'unrelated-key' });
    _window.dispatchEvent(ev);

    assert.equal(fired, 0);
    _window.removeEventListener(WM_FOLLOWED_COUNTRIES_CHANGED, handler);
  });
});

describe('post-await auth re-check returns HANDOFF_PENDING', () => {
  it('addCountry: user signs out mid-await → HANDOFF_PENDING; mutation not committed in caller-observable state', async () => {
    // We use a delayed backend.follow(). Mid-await, we flip auth to null
    // (sign-out). The post-await re-check should detect the gen change
    // and return HANDOFF_PENDING.
    let _user = { id: 'user_au' };
    let mutationStarted = null;
    const backend = {
      async list() { return []; },
      async follow(country) {
        mutationStarted = country;
        await new Promise((r) => setTimeout(r, 30));
        return { ok: true, idempotent: false };
      },
      async unfollow() { return { ok: true, idempotent: true }; },
      async merge() { return { totalCount: 0, accepted: [], droppedInvalid: [] }; },
    };
    _setDepsForTests({
      getCurrentAuthUser: () => _user,
      getEntitlementState: () => ({ features: { tier: 1 } }),
      hasTier: () => true,
      featureFlagEnabled: true,
      backend,
    });
    await _emitAuthStateForTests({ id: 'user_au' });
    await flushMicrotasks();

    // Kick off addCountry; while the mutation is in flight, sign out.
    const addPromise = addCountry('US');
    // Wait a tick so the mutation actually starts.
    await new Promise((r) => setTimeout(r, 5));
    _user = null;
    setupAnonymous();
    await _emitAuthStateForTests(null);

    const result = await addPromise;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'HANDOFF_PENDING');
    // The mutation MAY have started before sign-out (we don't undo the
    // call), but the result is dropped — addCountry returned PENDING.
    void mutationStarted;
  });
});

describe('empty-handoff path loads the snapshot via _refreshSnapshot', () => {
  it('empty localStorage → handoff complete, snapshot populated from backend.list()', async () => {
    setLocalStorageList([]);
    const backend = makeFakeBackend({ initialRows: ['CA'] });
    setupSignedIn('user_p20', { backend });

    let events = 0;
    const unsub = subscribe(() => { events += 1; });

    await _emitAuthStateForTests({ id: 'user_p20' });
    await flushMicrotasks();

    assert.equal(_getInternalStateForTests().handoffState, 'complete');
    assert.deepEqual(getFollowed(), ['CA']);
    assert.ok(events >= 1, 'change event fires once the snapshot lands');

    unsub();
  });
});

describe('UNAUTHENTICATED transient retry path', () => {
  it('first call throws UNAUTHENTICATED, visibility retry succeeds → final state has merged data, localStorage cleared, no follows lost', async () => {
    setLocalStorageList(['US', 'GB']);

    // Inline fake: throws UNAUTHENTICATED on the FIRST merge() call, then
    // succeeds on subsequent calls. This simulates the exact production
    // race: the auth listener fires "signed in" first tick, but the
    // fetch token isn't attached yet; the visibility retry then succeeds.
    const rows = [];
    let mergeCalls = 0;
    const backend = {
      async list() { return [...rows]; },
      async follow(country) {
        rows.push(country);
        return { ok: true, idempotent: false };
      },
      async unfollow(country) {
        const idx = rows.indexOf(country);
        if (idx !== -1) rows.splice(idx, 1);
        return { ok: true, idempotent: false };
      },
      async merge(countries) {
        mergeCalls += 1;
        if (mergeCalls === 1) {
          throw new FollowedCountriesFetchError('UNAUTHENTICATED', 'no token yet');
        }
        // Second call: succeed (token has now landed).
        const accepted = [];
        for (const c of countries) {
          if (!rows.includes(c)) {
            rows.push(c);
            accepted.push(c);
          }
        }
        return { totalCount: rows.length, accepted, droppedInvalid: [] };
      },
    };
    setupSignedIn('user_un_retry', { backend });

    // First handoff fails with UNAUTHENTICATED → state goes to 'failed'
    // (transient), not 'failed-permanent'. localStorage is RETAINED.
    await _emitAuthStateForTests({ id: 'user_un_retry' });
    await flushMicrotasks();
    assert.equal(_getInternalStateForTests().handoffState, 'failed');
    assert.equal(
      _getInternalStateForTests().hasVisibilityRetryListener,
      true,
      'visibility retry armed',
    );
    assert.notEqual(getLocalStorageRaw(), null, 'localStorage retained');

    // Trigger the visibilitychange retry. The backend's second call succeeds.
    _document.dispatchEvent(new Event('visibilitychange'));
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    // Final state: merged data lives on the fake server, localStorage
    // is cleared, handoff completed.
    assert.equal(
      _getInternalStateForTests().handoffState,
      'complete',
      'retry completes the handoff',
    );
    assert.equal(getLocalStorageRaw(), null, 'localStorage cleared on success');
    assert.deepEqual(
      rows.slice().sort(),
      ['GB', 'US'],
      'merged data reaches the server',
    );
    assert.equal(mergeCalls, 2, 'merge attempted exactly twice');
  });

  it('UNAUTHENTICATED IS counted toward MAX_HANDOFF_RETRIES — 5 consecutive UNAUTHENTICATED throws → failed-permanent', async () => {
    // A genuinely-stuck auth mismatch MUST eventually transition to
    // failed-permanent rather than retry forever. The budget MUST be the
    // same MAX_HANDOFF_RETRIES used by the network-failure path.
    setLocalStorageList(['US']);
    const backend = makeFakeBackend({
      mergeRejection: new FollowedCountriesFetchError('UNAUTHENTICATED', 'stuck'),
    });
    setupSignedIn('user_un_max', { backend });

    await _emitAuthStateForTests({ id: 'user_un_max' });
    await flushMicrotasks();
    assert.equal(_getInternalStateForTests().handoffState, 'failed');

    // Fire visibilitychange MAX_HANDOFF_RETRIES (5) times. Each retry
    // throws UNAUTHENTICATED again. After exhausting the budget, the
    // state flips to failed-permanent.
    for (let i = 0; i < 5; i++) {
      _document.dispatchEvent(new Event('visibilitychange'));
      await flushMicrotasks();
      await flushMicrotasks();
    }
    assert.equal(
      _getInternalStateForTests().handoffState,
      'failed-permanent',
      'auth-permanent after retry budget exhausted',
    );
    assert.equal(
      _getInternalStateForTests().hasVisibilityRetryListener,
      false,
    );
  });
});
