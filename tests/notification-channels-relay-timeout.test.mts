import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

/**
 * Stage 3 of the Convex/Clerk -> Supabase migration replaced the Convex
 * `/relay/notification-channels` HTTP hop (and its "durable welcome
 * scheduling" capability negotiation — a dance that existed only because
 * Convex and Vercel deploy independently) with direct calls into
 * `server/_shared/{notification-channels,alert-rules,telegram-pairing}.ts`.
 * There's no second platform's timeout/deploy-window/negotiation surface
 * left to test here — those scenarios are gone, not just relocated.
 *
 * What still matters at this layer: a NETWORK/CONFIG failure from the
 * shared module maps to a 503 that releases the idempotency marker, and a
 * subsequent retry with the same Idempotency-Key succeeds and replays
 * cleanly. The shared module's OWN error paths (kind: 'NETWORK' etc.) are
 * covered directly in server/__tests__/notification-channels.test.ts.
 */

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

async function importFreshNotificationChannels() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
  return import(`../api/notification-channels.ts?test=${Date.now()}-${Math.random()}`);
}

function makeSetChannelRequest(): Request {
  return new Request('https://example.test/api/notification-channels', {
    method: 'POST',
    headers: {
      Origin: 'https://example.test',
      Authorization: 'Bearer supabase-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'notification-channel-timeout-retry',
    },
    body: JSON.stringify({
      action: 'set-channel',
      channelType: 'email',
      email: 'retry@example.com',
    }),
  });
}

type RedisCommand = string[];

function installInMemoryUpstash() {
  const store = new Map<string, string>();
  const batches: RedisCommand[][] = [];

  globalThis.fetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://upstash.test/pipeline') {
      const commands = JSON.parse(String(init?.body)) as RedisCommand[];
      batches.push(commands);
      const results = commands.map((command) => {
        const [rawOperation, key, value, ...options] = command;
        const operation = rawOperation?.toUpperCase();
        if (operation === 'GET') return { result: store.get(key!) ?? null };
        if (operation === 'DEL') return { result: store.delete(key!) ? 1 : 0 };
        if (operation === 'SET') {
          const hasNx = options.some((option) => option.toUpperCase() === 'NX');
          if (hasNx && store.has(key!)) return { result: null };
          store.set(key!, value!);
          return { result: 'OK' };
        }
        throw new Error(`Unexpected Redis command: ${command.join(' ')}`);
      });
      return Response.json(results);
    }
    if (url.startsWith('https://upstash.test/lpush/')) {
      return Response.json({ result: 1 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  return { store, batches };
}

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  restoreEnv();
});

describe('/api/notification-channels backend-failure recovery', () => {
  it('returns 503, releases idempotency, and processes the same-key retry after a NETWORK error', async () => {
    const redis = installInMemoryUpstash();
    const mod = await importFreshNotificationChannels();
    const consoleWarn = mock.method(console, 'warn', () => {});

    let attempt = 0;
    const setChannel = mock.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        const err = new Error('setChannel upsert failed: connection reset') as Error & { kind?: string };
        err.name = 'NotificationChannelsError';
        (err as { kind: string }).kind = 'NETWORK';
        // instanceof checks in api/notification-channels.ts need the real
        // class — reach for it via a dynamic import of the shared module.
        const { NotificationChannelsError } = await import('../server/_shared/notification-channels.ts');
        throw new NotificationChannelsError('NETWORK', err.message);
      }
      return { isNew: false, id: 'row-1' };
    });

    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-timeout-retry' }),
      setChannel,
    });

    const ctx = { waitUntil: (_promise: Promise<unknown>) => {} };
    const first = await mod.default(makeSetChannelRequest(), ctx);

    assert.equal(first.status, 503);
    assert.deepEqual(await first.json(), { error: 'Service unavailable' });
    assert.equal(first.headers.get('Access-Control-Allow-Origin'), 'https://example.test');
    assert.equal(first.headers.get('Idempotency-Key'), 'notification-channel-timeout-retry');
    assert.equal(first.headers.get('Idempotent-Replayed'), 'false');
    assert.equal(first.headers.get('Retry-After'), '5');
    assert.equal(redis.store.size, 0, 'a 503 failure must release the processing marker');
    assert.equal(
      redis.batches.some((batch) => batch.some(([operation]) => operation === 'DEL')),
      true,
      'the failure path must issue the idempotency DEL cleanup',
    );

    const second = await mod.default(makeSetChannelRequest(), ctx);

    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { ok: true });
    assert.equal(second.headers.get('Idempotency-Key'), 'notification-channel-timeout-retry');
    assert.equal(second.headers.get('Idempotent-Replayed'), 'false');
    assert.equal(setChannel.mock.calls.length, 2);

    const replay = await mod.default(makeSetChannelRequest(), ctx);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { ok: true });
    assert.equal(replay.headers.get('Idempotent-Replayed'), 'true');
    assert.equal(setChannel.mock.calls.length, 2, 'completed retry should replay without calling setChannel again');
    assert.equal(consoleWarn.mock.calls.length >= 1, true);
  });

  it('returns 503 when Supabase is unconfigured (CONFIG error)', async () => {
    installInMemoryUpstash();
    const mod = await importFreshNotificationChannels();

    const setChannel = mock.fn(async () => {
      const { NotificationChannelsError } = await import('../server/_shared/notification-channels.ts');
      throw new NotificationChannelsError('CONFIG', 'Supabase service-role client unconfigured');
    });

    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-unconfigured' }),
      setChannel,
    });

    const response = await mod.default(makeSetChannelRequest(), { waitUntil: () => {} });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Service unavailable' });
  });

  it('publishes the welcome (with the row id as welcomeId) only when the channel is newly created', async () => {
    installInMemoryUpstash();
    const mod = await importFreshNotificationChannels();

    const fetchCalls: string[] = [];
    const wrappedFetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push(String(input));
      return globalThis.fetch(input, init);
    });

    const setChannel = mock.fn(async () => ({ isNew: true, id: 'new-row-id' }));

    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-new-channel' }),
      setChannel,
      fetch: wrappedFetch,
    });

    const waits: Promise<unknown>[] = [];
    const response = await mod.default(makeSetChannelRequest(), {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });

    assert.equal(response.status, 200);
    await Promise.all(waits);
    const welcomeCall = fetchCalls.find((url) => url.includes('/lpush/wm:events:queue/'));
    assert.ok(welcomeCall, 'a new channel must publish a welcome');
    const decoded = decodeURIComponent(welcomeCall!.split('/lpush/wm:events:queue/')[1]!);
    assert.deepEqual(JSON.parse(decoded), {
      eventType: 'channel_welcome', userId: 'user-new-channel', channelType: 'email', welcomeId: 'new-row-id',
    });
  });

  it('does not publish a welcome when the channel already existed', async () => {
    installInMemoryUpstash();
    const mod = await importFreshNotificationChannels();
    const wrappedFetch = mock.fn((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-existing-channel' }),
      setChannel: async () => ({ isNew: false, id: 'existing-row-id' }),
      fetch: wrappedFetch,
    });

    const waits: Promise<unknown>[] = [];
    const response = await mod.default(makeSetChannelRequest(), {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });

    assert.equal(response.status, 200);
    assert.equal(waits.length, 0, 're-saving an existing channel must not enqueue a welcome');
  });
});
