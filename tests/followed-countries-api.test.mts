import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import handler, {
  __setFollowedCountriesDepsForTests,
  FOLLOWED_COUNTRIES_WRITE_RATE_LIMIT,
  FOLLOWED_COUNTRIES_WRITE_RATE_SCOPE,
  FOLLOWED_COUNTRIES_WRITE_RATE_WINDOW,
} from '../api/followed-countries.ts';
import { FollowedCountriesError } from '../server/_shared/followed-countries.ts';

const TEST_USER_ID = 'user_followed_countries_test';

function makeReq(init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Request {
  return new Request('https://worldmonitor.app/api/followed-countries', {
    method: init.method ?? 'GET',
    headers: {
      Origin: 'https://worldmonitor.app',
      Authorization: 'Bearer test-token',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

function installDeps(overrides: Parameters<typeof __setFollowedCountriesDepsForTests>[0] = {}) {
  __setFollowedCountriesDepsForTests({
    validateBearerToken: async () => ({ valid: true, userId: TEST_USER_ID }),
    checkScopedRateLimit: async (scope, limit) => ({ allowed: true, limit, reset: 0, degraded: false }),
    ...overrides,
  });
}

afterEach(() => {
  __setFollowedCountriesDepsForTests(null);
  mock.restoreAll();
});

describe('GET /api/followed-countries', () => {
  it('401s without a bearer token', async () => {
    const res = await handler(makeReq({ headers: { Authorization: '' } }));
    assert.equal(res.status, 401);
  });

  it('401s when the session is invalid', async () => {
    installDeps({ validateBearerToken: async () => ({ valid: false }) });
    const res = await handler(makeReq());
    assert.equal(res.status, 401);
  });

  it('returns {countries} from listFollowed', async () => {
    installDeps({ listFollowed: async (userId) => {
      assert.equal(userId, TEST_USER_ID);
      return ['US', 'GB'];
    } });
    const res = await handler(makeReq());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { countries: ['US', 'GB'] });
  });

  it('maps a CONFIG/NETWORK error to 503', async () => {
    installDeps({ listFollowed: async () => { throw new FollowedCountriesError('NETWORK', 'db down'); } });
    const res = await handler(makeReq());
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'SERVICE_UNAVAILABLE' });
  });
});

describe('POST /api/followed-countries — follow/unfollow', () => {
  it('follows a country and returns the discriminated result', async () => {
    installDeps({ followCountry: async (userId, country) => {
      assert.equal(userId, TEST_USER_ID);
      assert.equal(country, 'US');
      return { ok: true, idempotent: false };
    } });
    const res = await handler(makeReq({ method: 'POST', body: { action: 'follow', country: 'US' } }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, idempotent: false });
  });

  it('unfollows a country', async () => {
    installDeps({ unfollowCountry: async () => ({ ok: true, idempotent: true }) });
    const res = await handler(makeReq({ method: 'POST', body: { action: 'unfollow', country: 'US' } }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, idempotent: true });
  });

  it('maps INVALID_COUNTRY to 400', async () => {
    installDeps({ followCountry: async () => { throw new FollowedCountriesError('INVALID_COUNTRY', 'bad code'); } });
    const res = await handler(makeReq({ method: 'POST', body: { action: 'follow', country: 'ZZ' } }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'INVALID_COUNTRY' });
  });

  it('400s when country is missing', async () => {
    installDeps();
    const res = await handler(makeReq({ method: 'POST', body: { action: 'follow' } }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'MISSING_FIELDS' });
  });

  it('400s on an unrecognized action', async () => {
    installDeps();
    const res = await handler(makeReq({ method: 'POST', body: { action: 'nope' } }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'INVALID_ACTION' });
  });
});

describe('POST /api/followed-countries — merge', () => {
  it('merges and returns totalCount/accepted/droppedInvalid', async () => {
    installDeps({ mergeAnonymousLocal: async (userId, countries) => {
      assert.equal(userId, TEST_USER_ID);
      assert.deepEqual(countries, ['US', 'ZZ']);
      return { totalCount: 1, accepted: ['US'], droppedInvalid: ['ZZ'] };
    } });
    const res = await handler(makeReq({ method: 'POST', body: { action: 'merge', countries: ['US', 'ZZ'] } }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { totalCount: 1, accepted: ['US'], droppedInvalid: ['ZZ'] });
  });

  it('400s when countries is not an array of strings', async () => {
    installDeps();
    const res = await handler(makeReq({ method: 'POST', body: { action: 'merge', countries: 'US' } }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'MISSING_FIELDS' });
  });

  it('maps EMPTY_INPUT to 400', async () => {
    installDeps({ mergeAnonymousLocal: async () => { throw new FollowedCountriesError('EMPTY_INPUT', 'empty'); } });
    const res = await handler(makeReq({ method: 'POST', body: { action: 'merge', countries: [] } }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'EMPTY_INPUT' });
  });

  it('maps INPUT_TOO_LARGE to 400', async () => {
    installDeps({ mergeAnonymousLocal: async () => { throw new FollowedCountriesError('INPUT_TOO_LARGE', 'too many'); } });
    const res = await handler(makeReq({ method: 'POST', body: { action: 'merge', countries: ['US'] } }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'INPUT_TOO_LARGE' });
  });
});

describe('POST /api/followed-countries — write rate limit', () => {
  it('returns 429 without reaching the backend when over budget', async () => {
    const warnMock = mock.method(console, 'warn', () => {});
    let calledBackend = false;
    installDeps({
      checkScopedRateLimit: async (scope, limit) => {
        assert.equal(scope, FOLLOWED_COUNTRIES_WRITE_RATE_SCOPE);
        assert.equal(limit, FOLLOWED_COUNTRIES_WRITE_RATE_LIMIT);
        return { allowed: false, limit, reset: Date.now() + 30_000, degraded: false };
      },
      followCountry: async () => { calledBackend = true; return { ok: true, idempotent: false }; },
    });
    const res = await handler(makeReq({ method: 'POST', body: { action: 'follow', country: 'US' } }));
    assert.equal(res.status, 429);
    assert.equal(calledBackend, false);
    assert.equal(warnMock.mock.calls.length, 1);
  });

  it('fails open when the scoped limiter is degraded', async () => {
    const warnMock = mock.method(console, 'warn', () => {});
    installDeps({
      checkScopedRateLimit: async (scope, limit, window) => {
        assert.equal(window, FOLLOWED_COUNTRIES_WRITE_RATE_WINDOW);
        return { allowed: true, limit, reset: 0, degraded: true };
      },
      followCountry: async () => ({ ok: true, idempotent: false }),
    });
    const res = await handler(makeReq({ method: 'POST', body: { action: 'follow', country: 'US' } }));
    assert.equal(res.status, 200);
    assert.equal(warnMock.mock.calls.length, 1);
  });
});
