import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import handler, {
  __setUserPrefsDepsForTests,
  USER_PREFS_WRITE_RATE_LIMIT,
  USER_PREFS_WRITE_RATE_SCOPE,
  USER_PREFS_WRITE_RATE_WINDOW,
} from '../api/user-prefs.ts';

const originalFetch = globalThis.fetch;
const TEST_NOW = 1_700_000_000_000;
const TEST_USER_ID = 'user_rate_limit_test';
const IDEMPOTENCY_KEY = '4f8b9c2e-1a3d-4b6f-8e0a-2c5d7f9b1e34';

type RateLimitResult = {
  allowed: boolean;
  limit: number;
  reset: number;
  degraded: boolean;
};

type BackendCall =
  | { kind: 'auth'; token: string }
  | { kind: 'get'; userId: string; variant: string }
  | { kind: 'set'; userId: string; variant: string; data: unknown; expectedSyncVersion: number; schemaVersion: number };

function expectExposedRateLimitHeaders(headers: Headers): void {
  const exposed = headers.get('Access-Control-Expose-Headers') ?? '';
  assert.match(exposed, /Retry-After/);
  assert.match(exposed, /X-RateLimit-Limit/);
  assert.match(exposed, /X-RateLimit-Remaining/);
  assert.match(exposed, /X-RateLimit-Reset/);
}

function restoreEnv(): void {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  globalThis.fetch = originalFetch;
}

async function sha256Hex(str: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

afterEach(() => {
  __setUserPrefsDepsForTests(null);
  mock.restoreAll();
  restoreEnv();
});

function makePost(body: Record<string, unknown> = {
  variant: 'full',
  data: { theme: 'dark' },
  expectedSyncVersion: 1,
}, extraHeaders: Record<string, string> = {}): Request {
  return new Request('https://example.test/api/user-prefs', {
    method: 'POST',
    headers: {
      Origin: 'https://example.test',
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

function installRedisPipeline(handler: (commands: string[][]) => Array<{ result: unknown }>): string[][][] {
  process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
  const calls: string[][][] = [];
  globalThis.fetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const commands = JSON.parse(String(init?.body ?? '[]')) as string[][];
    calls.push(commands);
    return Response.json(handler(commands));
  }) as typeof fetch;
  return calls;
}

function installDeps(rateLimitResult: RateLimitResult): {
  calls: BackendCall[];
  rateLimitCalls: Array<{ scope: string; limit: number; window: string; identifier: string }>;
} {
  const calls: BackendCall[] = [];
  const rateLimitCalls: Array<{ scope: string; limit: number; window: string; identifier: string }> = [];

  __setUserPrefsDepsForTests({
    validateBearerToken: async (token: string) => {
      calls.push({ kind: 'auth', token });
      return { valid: true, userId: TEST_USER_ID };
    },
    checkScopedRateLimit: async (scope: string, limit: number, window: string, identifier: string) => {
      rateLimitCalls.push({ scope, limit, window, identifier });
      return rateLimitResult;
    },
    getUserPreferences: async (userId: string, variant: string) => {
      calls.push({ kind: 'get', userId, variant });
      return null;
    },
    setUserPreferences: async (userId: string, variant: string, data: unknown, expectedSyncVersion: number, schemaVersion: number) => {
      calls.push({ kind: 'set', userId, variant, data, expectedSyncVersion, schemaVersion });
      return { ok: true, syncVersion: 7 };
    },
  });

  return { calls, rateLimitCalls };
}

describe('user-prefs POST write rate limit', () => {
  it('rejects invalid sessions before checking the scoped limiter', async () => {
    const rateLimitCalls: Array<{ scope: string; limit: number; window: string; identifier: string }> = [];
    let calledBackend = false;

    __setUserPrefsDepsForTests({
      validateBearerToken: async () => ({ valid: false }),
      checkScopedRateLimit: async (scope: string, limit: number, window: string, identifier: string) => {
        rateLimitCalls.push({ scope, limit, window, identifier });
        return { allowed: true, limit, reset: 0, degraded: false };
      },
      setUserPreferences: async () => {
        calledBackend = true;
        throw new Error('setUserPreferences should not be called for invalid sessions');
      },
    });

    const res = await handler(makePost());

    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'UNAUTHENTICATED' });
    assert.deepEqual(rateLimitCalls, []);
    assert.equal(calledBackend, false);
  });

  it('returns 429 + Retry-After without calling the backend when the identity is over budget', async () => {
    mock.method(Date, 'now', () => TEST_NOW);
    const warnMock = mock.method(console, 'warn', () => {});
    const { calls, rateLimitCalls } = installDeps({
      allowed: false,
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      reset: TEST_NOW + 30_000,
      degraded: false,
    });

    const res = await handler(makePost());

    assert.equal(res.status, 429);
    assert.equal(res.headers.get('Retry-After'), '30');
    assert.equal(res.headers.get('X-RateLimit-Limit'), String(USER_PREFS_WRITE_RATE_LIMIT));
    assert.equal(res.headers.get('X-RateLimit-Remaining'), '0');
    assert.equal(res.headers.get('X-RateLimit-Reset'), String(TEST_NOW + 30_000));
    expectExposedRateLimitHeaders(res.headers);
    assert.deepEqual(await res.json(), { error: 'RATE_LIMITED' });
    assert.deepEqual(rateLimitCalls, [{
      scope: USER_PREFS_WRITE_RATE_SCOPE,
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      window: USER_PREFS_WRITE_RATE_WINDOW,
      identifier: TEST_USER_ID,
    }]);
    assert.equal(calls.some((call) => call.kind === 'set'), false, 'over-budget requests must not reach the backend');
    assert.equal(warnMock.mock.calls.length, 1);
  });

  it('passes an under-budget identity through to setUserPreferences', async () => {
    const { calls, rateLimitCalls } = installDeps({
      allowed: true,
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      reset: TEST_NOW + 60_000,
      degraded: false,
    });

    const res = await handler(makePost({
      variant: 'tech',
      data: { theme: 'light' },
      expectedSyncVersion: 2,
      schemaVersion: 3,
    }));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { syncVersion: 7 });
    assert.deepEqual(rateLimitCalls, [{
      scope: USER_PREFS_WRITE_RATE_SCOPE,
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      window: USER_PREFS_WRITE_RATE_WINDOW,
      identifier: TEST_USER_ID,
    }]);
    const set = calls.find((call): call is Extract<BackendCall, { kind: 'set' }> => call.kind === 'set');
    assert.ok(set, 'under-budget request should call setUserPreferences');
    assert.deepEqual(set, {
      kind: 'set',
      userId: TEST_USER_ID,
      variant: 'tech',
      data: { theme: 'light' },
      expectedSyncVersion: 2,
      schemaVersion: 3,
    });
  });

  it('fails open when the scoped limiter is degraded', async () => {
    const warnMock = mock.method(console, 'warn', () => {});
    const { calls } = installDeps({
      allowed: true,
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      reset: 0,
      degraded: true,
    });

    const res = await handler(makePost());

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { syncVersion: 7 });
    assert.ok(calls.some((call) => call.kind === 'set'), 'degraded limiter should fail open to the backend');
    assert.equal(warnMock.mock.calls.length, 1);
    assert.match(String(warnMock.mock.calls[0].arguments[0]), /rate limit unavailable; failing open/);
  });

  it('replays a completed Idempotency-Key response before charging the scoped limiter', async () => {
    const body = {
      variant: 'full',
      data: { theme: 'dark' },
      expectedSyncVersion: 1,
    };
    const reqHash = await sha256Hex(JSON.stringify(body));
    installRedisPipeline(() => [
      {
        result: JSON.stringify({
          state: 'completed',
          status: 200,
          contentType: 'application/json',
          reqHash,
          body: JSON.stringify({ syncVersion: 42 }),
        }),
      },
    ]);

    const { calls, rateLimitCalls } = installDeps({
      allowed: true,
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      reset: TEST_NOW + 60_000,
      degraded: false,
    });

    const res = await handler(makePost(body, { 'Idempotency-Key': IDEMPOTENCY_KEY }));

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Idempotent-Replayed'), 'true');
    assert.deepEqual(await res.json(), { syncVersion: 42 });
    assert.deepEqual(rateLimitCalls, []);
    assert.equal(calls.some((call) => call.kind === 'set'), false, 'replay should not reach the backend');
  });

  it('claims a fresh Idempotency-Key only after the scoped limiter allows the write', async () => {
    const redisCalls = installRedisPipeline((commands) => {
      if (commands[0][0] === 'GET') return [{ result: null }];
      if (commands[0][0] === 'SET' && commands[0].includes('NX')) {
        return [{ result: 'OK' }, { result: null }];
      }
      return [{ result: 'OK' }];
    });
    const { calls, rateLimitCalls } = installDeps({
      allowed: true,
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      reset: TEST_NOW + 60_000,
      degraded: false,
    });

    const res = await handler(makePost(undefined, { 'Idempotency-Key': IDEMPOTENCY_KEY }));

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Idempotency-Key'), IDEMPOTENCY_KEY);
    assert.equal(res.headers.get('Idempotent-Replayed'), 'false');
    assert.deepEqual(await res.json(), { syncVersion: 7 });
    assert.deepEqual(rateLimitCalls, [{
      scope: USER_PREFS_WRITE_RATE_SCOPE,
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      window: USER_PREFS_WRITE_RATE_WINDOW,
      identifier: TEST_USER_ID,
    }]);
    assert.ok(calls.some((call) => call.kind === 'set'), 'allowed keyed write should reach the backend');
    assert.equal(redisCalls[0][0][0], 'GET', 'completed replay lookup should happen before rate limiting');
    assert.deepEqual(redisCalls[1][0].slice(0, 4), ['SET', redisCalls[1][0][1], redisCalls[1][0][2], 'NX']);
    assert.equal(redisCalls[2][0][0], 'SET', 'successful response should be persisted for replay');
  });

  it('does not claim or cache a fresh Idempotency-Key when the scoped limiter rejects the write', async () => {
    mock.method(Date, 'now', () => TEST_NOW);
    const warnMock = mock.method(console, 'warn', () => {});
    const redisCalls = installRedisPipeline(() => [{ result: null }]);
    const { calls, rateLimitCalls } = installDeps({
      allowed: false,
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      reset: TEST_NOW + 30_000,
      degraded: false,
    });

    const res = await handler(makePost(undefined, { 'Idempotency-Key': IDEMPOTENCY_KEY }));

    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: 'RATE_LIMITED' });
    assert.equal(redisCalls.length, 1, 'rate-limited fresh keys should only perform the pre-limit replay lookup');
    assert.equal(redisCalls[0][0][0], 'GET');
    assert.deepEqual(rateLimitCalls, [{
      scope: USER_PREFS_WRITE_RATE_SCOPE,
      limit: USER_PREFS_WRITE_RATE_LIMIT,
      window: USER_PREFS_WRITE_RATE_WINDOW,
      identifier: TEST_USER_ID,
    }]);
    assert.equal(calls.some((call) => call.kind === 'set'), false, 'rate-limited requests must not reach the backend');
    assert.equal(warnMock.mock.calls.length, 1);
  });

  it('maps a returned RATE_LIMITED result to 429 with retry guidance', async () => {
    mock.method(Date, 'now', () => TEST_NOW);
    const warnMock = mock.method(console, 'warn', () => {});
    const reset = TEST_NOW + 12_000;

    __setUserPrefsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: TEST_USER_ID }),
      checkScopedRateLimit: async () => ({
        allowed: true,
        limit: USER_PREFS_WRITE_RATE_LIMIT,
        reset,
        degraded: false,
      }),
      setUserPreferences: async () => ({ ok: false, reason: 'SERVICE_UNAVAILABLE' }),
    });

    const res = await handler(makePost());

    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'SERVICE_UNAVAILABLE' });
    assert.equal(warnMock.mock.calls.length, 1);
  });

  it('maps a returned BLOB_TOO_LARGE result to 400', async () => {
    __setUserPrefsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: TEST_USER_ID }),
      checkScopedRateLimit: async () => ({
        allowed: true,
        limit: USER_PREFS_WRITE_RATE_LIMIT,
        reset: TEST_NOW + 60_000,
        degraded: false,
      }),
      setUserPreferences: async () => ({ ok: false, reason: 'BLOB_TOO_LARGE', size: 123, max: 100 }),
    });

    const res = await handler(makePost());

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'BLOB_TOO_LARGE' });
  });

  it('maps a returned CONFLICT result to 409 with actualSyncVersion', async () => {
    __setUserPrefsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: TEST_USER_ID }),
      checkScopedRateLimit: async () => ({
        allowed: true,
        limit: USER_PREFS_WRITE_RATE_LIMIT,
        reset: TEST_NOW + 60_000,
        degraded: false,
      }),
      setUserPreferences: async () => ({ ok: false, reason: 'CONFLICT', actualSyncVersion: 9 }),
    });

    const res = await handler(makePost());

    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'CONFLICT', actualSyncVersion: 9 });
  });
});
