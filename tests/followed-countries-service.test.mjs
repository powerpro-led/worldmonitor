/**
 * Tests for src/services/followed-countries.ts — anonymous-mode behavior,
 * constants, subscribe, idempotency, invalid input, storage-full, feature
 * flag, global picker contract, and corrupt-localStorage handling.
 *
 * Stage 2 of the Convex/Clerk -> Supabase migration replaced the Convex
 * client with fetch calls to `/api/followed-countries` (see
 * `src/services/followed-countries.ts` header comment). The follow cap
 * (`FREE_TIER_FOLLOW_LIMIT`/`FREE_CAP`) is gone entirely — Stage 1 already
 * collapsed entitlements to "signed in = full access," so there's nothing
 * left for a per-tier cap to differentiate.
 *
 * A sibling test file (followed-countries-sign-in-handoff.test.mjs) covers
 * the auth-state orchestration; signed-in mutations and the fetch-backend
 * bridge are intentionally NOT tested here beyond the entitlement-loading
 * gate.
 *
 * Test runner: node:test via `tsx --test tests/*.test.mjs`.
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Browser-global stubs (localStorage + window with addEventListener / dispatchEvent)
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

let _localStorage;
let _window;

before(() => {
  _localStorage = new MemoryStorage();
  _window = new FakeWindow();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: _localStorage,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: _window,
  });
  // CustomEvent is available in Node 19+; ensure presence.
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
});

beforeEach(() => {
  _localStorage.clear();
  _localStorage.throwOnSet = false;
});

// ---------------------------------------------------------------------------
// Import service (after globals are stubbed)
// ---------------------------------------------------------------------------

const svc = await import('../src/services/followed-countries.ts');
const {
  addCountry,
  removeCountry,
  getFollowed,
  isFollowed,
  subscribe,
  serviceEntitlementState,
  FOLLOWED_COUNTRIES_STORAGE_KEY,
  WM_FOLLOWED_COUNTRIES_CHANGED,
  installFollowedCountriesAuthListener,
  FollowedCountriesFetchError,
  _setDepsForTests,
  _resetStateForTests,
} = svc;

// ---------------------------------------------------------------------------
// Deps helpers
// ---------------------------------------------------------------------------

// Default deps for tests: anonymous user, entitlement null, real fetch
// backend disabled (anonymous mode never touches it).
function setAnonymous() {
  _setDepsForTests({
    getCurrentAuthUser: () => null,
    getEntitlementState: () => null,
    hasTier: () => false,
    featureFlagEnabled: true,
    backend: 'force-null',
  });
}

function setSignedInLoading() {
  _setDepsForTests({
    getCurrentAuthUser: () => ({ id: 'user_loading' }),
    getEntitlementState: () => null,
    hasTier: () => false,
    featureFlagEnabled: true,
    backend: 'force-null',
  });
}

beforeEach(() => {
  _resetStateForTests();
  setAnonymous();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('followed-countries service — constants & key', () => {
  it('uses storage key wm-followed-countries-v1', () => {
    assert.equal(FOLLOWED_COUNTRIES_STORAGE_KEY, 'wm-followed-countries-v1');
  });

  it('exports event name wm-followed-countries-changed', () => {
    assert.equal(WM_FOLLOWED_COUNTRIES_CHANGED, 'wm-followed-countries-changed');
  });

  it('exports FollowedCountriesFetchError with a .kind field', () => {
    const err = new FollowedCountriesFetchError('NETWORK', 'boom');
    assert.equal(err.kind, 'NETWORK');
    assert.equal(err.name, 'FollowedCountriesFetchError');
    assert.ok(err instanceof Error);
  });
});

describe('followed-countries service — happy path (anonymous)', () => {
  it("addCountry('US') → {ok:true}; getFollowed() → ['US']", async () => {
    const res = await addCountry('US');
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(getFollowed(), ['US']);
  });

  it("addCountry('USA') normalizes alpha-3 to 'US'", async () => {
    const res = await addCountry('USA');
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(getFollowed(), ['US']);
  });

  it("removeCountry('US') empties the list", async () => {
    await addCountry('US');
    const res = await removeCountry('US');
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(getFollowed(), []);
  });

  it('isFollowed reflects state and case-folds', async () => {
    assert.equal(isFollowed('US'), false);
    await addCountry('US');
    assert.equal(isFollowed('US'), true);
    assert.equal(isFollowed('us'), true);
    assert.equal(isFollowed('USA'), true);
  });
});

describe('followed-countries service — subscribe', () => {
  it('handler fires after add and after remove; unsubscribe stops further fires', async () => {
    let count = 0;
    const unsub = subscribe(() => {
      count += 1;
    });

    await addCountry('US');
    assert.equal(count, 1);

    await removeCountry('US');
    assert.equal(count, 2);

    unsub();
    await addCountry('FR');
    assert.equal(count, 2, 'no further fires after unsubscribe');
  });

  it('does not fire on no-op idempotent add', async () => {
    await addCountry('US');
    let count = 0;
    const unsub = subscribe(() => {
      count += 1;
    });
    await addCountry('US'); // idempotent
    assert.equal(count, 0);
    unsub();
  });

  it('does not fire on no-op idempotent remove', async () => {
    let count = 0;
    const unsub = subscribe(() => {
      count += 1;
    });
    await removeCountry('FR'); // not present
    assert.equal(count, 0);
    unsub();
  });
});

describe('followed-countries service — idempotency & invalid input', () => {
  it('addCountry twice → second {ok:true}, single entry', async () => {
    const r1 = await addCountry('US');
    const r2 = await addCountry('US');
    assert.deepEqual(r1, { ok: true });
    assert.deepEqual(r2, { ok: true });
    assert.deepEqual(getFollowed(), ['US']);
  });

  it("addCountry('Atlantis') → INVALID_INPUT", async () => {
    const res = await addCountry('Atlantis');
    assert.deepEqual(res, { ok: false, reason: 'INVALID_INPUT' });
    assert.deepEqual(getFollowed(), []);
  });

  it("removeCountry('Atlantis') → INVALID_INPUT", async () => {
    const res = await removeCountry('Atlantis');
    assert.deepEqual(res, { ok: false, reason: 'INVALID_INPUT' });
  });
});

describe('followed-countries service — STORAGE_FULL', () => {
  it('localStorage quota throw on save → returns STORAGE_FULL, no event fires', async () => {
    let eventFires = 0;
    const unsub = subscribe(() => {
      eventFires += 1;
    });

    _localStorage.throwOnSet = true;
    const res = await addCountry('US');
    assert.deepEqual(res, { ok: false, reason: 'STORAGE_FULL' });
    assert.equal(eventFires, 0);
    unsub();
  });
});

describe('followed-countries service — no follow cap (Stage 2)', () => {
  it('anonymous user can add many countries with no cap', async () => {
    const codes = [
      'US', 'GB', 'FR', 'DE', 'IT', 'ES', 'PT', 'NL', 'BE', 'CH',
      'AT', 'SE', 'NO', 'DK', 'FI', 'IS', 'IE', 'PL', 'CZ', 'HU',
    ];
    for (const c of codes) {
      assert.deepEqual(await addCountry(c), { ok: true }, `add ${c}`);
    }
    assert.equal(getFollowed().length, codes.length);
  });
});

describe('followed-countries service — entitlement loading', () => {
  it('signed-in user, entitlement state null → ENTITLEMENT_LOADING', async () => {
    setSignedInLoading();
    const res = await addCountry('US');
    assert.deepEqual(res, { ok: false, reason: 'ENTITLEMENT_LOADING' });
    assert.deepEqual(getFollowed(), []);
  });

  it('serviceEntitlementState() reports loading when signed-in + null entitlement', () => {
    setSignedInLoading();
    assert.equal(serviceEntitlementState(), 'loading');
  });
});

describe('followed-countries service — anonymous never blocks on entitlement loading', () => {
  it("anon user with entitlement null treated as 'free' immediately, can add freely", async () => {
    // Default `setAnonymous()` already gives null entitlement.
    assert.equal(serviceEntitlementState(), 'free');
    assert.deepEqual(await addCountry('US'), { ok: true });
    assert.deepEqual(await addCountry('FR'), { ok: true });
    assert.deepEqual(await addCountry('DE'), { ok: true });
    assert.deepEqual(await addCountry('JP'), { ok: true });
    assert.deepEqual(getFollowed().sort(), ['DE', 'FR', 'JP', 'US']);
  });
});

describe('followed-countries service — feature flag', () => {
  it('flag off: addCountry/removeCountry return DISABLED, storage unchanged, no event', async () => {
    let eventFires = 0;
    const unsub = subscribe(() => {
      eventFires += 1;
    });

    _setDepsForTests({ featureFlagEnabled: false });

    const a = await addCountry('US');
    assert.deepEqual(a, { ok: false, reason: 'DISABLED' });
    const r = await removeCountry('US');
    assert.deepEqual(r, { ok: false, reason: 'DISABLED' });

    assert.equal(_localStorage.getItem(FOLLOWED_COUNTRIES_STORAGE_KEY), null);
    assert.equal(eventFires, 0);
    unsub();
  });

  it('flag off: installFollowedCountriesAuthListener does not register the picker global', () => {
    _setDepsForTests({ featureFlagEnabled: false });
    installFollowedCountriesAuthListener();
    assert.equal(_window.__wmFollowedCountries, undefined);
  });
});

describe('followed-countries service — global picker contract', () => {
  it('installFollowedCountriesAuthListener registers window.__wmFollowedCountries.getFollowed', async () => {
    await addCountry('US');
    installFollowedCountriesAuthListener();

    assert.equal(typeof _window.__wmFollowedCountries?.getFollowed, 'function');
    assert.deepEqual(_window.__wmFollowedCountries.getFollowed(), ['US']);
  });

  it('_resetStateForTests removes the picker global', () => {
    installFollowedCountriesAuthListener();
    assert.equal(typeof _window.__wmFollowedCountries?.getFollowed, 'function');

    _resetStateForTests();
    assert.equal(_window.__wmFollowedCountries, undefined);
  });
});

describe('followed-countries service — corrupt / wrong-shape localStorage', () => {
  it('non-JSON value → getFollowed() returns []', () => {
    _localStorage.setItem(FOLLOWED_COUNTRIES_STORAGE_KEY, 'not-json{');
    assert.deepEqual(getFollowed(), []);
  });

  it('JSON missing countries field → []', () => {
    _localStorage.setItem(FOLLOWED_COUNTRIES_STORAGE_KEY, JSON.stringify({ foo: 'bar' }));
    assert.deepEqual(getFollowed(), []);
  });

  it("wrong-shape value (e.g. '[{\"symbol\":\"AAPL\"}]') → []", () => {
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify([{ symbol: 'AAPL' }]),
    );
    assert.deepEqual(getFollowed(), []);
  });

  it('countries field is not an array → []', () => {
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: 'US,FR' }),
    );
    assert.deepEqual(getFollowed(), []);
  });

  it('countries field has invalid entries — they are dropped, valid ones returned', () => {
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US', 'Atlantis', 42, 'FR'] }),
    );
    assert.deepEqual(getFollowed(), ['US', 'FR']);
  });
});
