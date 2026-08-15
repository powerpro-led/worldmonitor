import assert from 'node:assert/strict';
import test from 'node:test';

const never = <T>(): Promise<T> => new Promise<T>(() => {});
const after = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return Array.from(values.keys())[index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

test('frontend session mint must not block API callers forever', async () => {
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { location: Location }).location = {
    href: 'https://example.test/',
    origin: 'https://example.test',
    hostname: 'example.test',
    protocol: 'https:',
    host: 'example.test',
  } as Location;
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = storage();
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage();
  (globalThis as unknown as { document: unknown }).document = {
    visibilityState: 'visible',
    addEventListener() {},
  };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((_input, init) => new Promise<Response>((_, reject) => {
    if (init?.signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  })) as typeof fetch;

  const mod = await import('../src/services/wm-session.ts');
  mod.__resetWmSessionForTests();
  mod.__setWmSessionFetchTimeoutForTests(50);

  const outcomes = await Promise.all(Array.from({ length: 100 }, async () => Promise.race([
    mod.ensureWmSession().then(() => 'settled'),
    after(500, 'still-pending'),
  ])));

  assert.equal(outcomes.filter((value) => value === 'still-pending').length, 0);
  mod.__resetWmSessionForTests();
});

test('wm-session request-body read must terminate for a body that never ends', async () => {
  process.env.WM_SESSION_SECRET = 'test-secret-must-be-at-least-32-chars-long-xxx';
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  process.env.WM_SESSION_BODY_TIMEOUT_MS = '50';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([{ result: [29, 30] }]), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  try {
    const { default: handler } = await import('../api/wm-session.js');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"widgetKey":"'));
      },
    });
    const req = new Request('https://api.example.test/api/wm-session', {
      method: 'POST',
      headers: {
        origin: 'https://example.test',
        'content-type': 'application/json',
      },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const outcome = await Promise.race([
      handler(req).then(() => 'settled'),
      after(500, 'still-pending'),
    ]);
    assert.equal(outcome, 'settled');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.WM_SESSION_BODY_TIMEOUT_MS;
  }
});

test('widget-agent request-body read must terminate for a body that never ends', async () => {
  process.env.WIDGET_AGENT_KEY = 'server-widget-key';
  process.env.PRO_WIDGET_KEY = 'server-pro-key';
  process.env.WORLDMONITOR_VALID_KEYS = 'browser-test-key';
  process.env.WIDGET_AGENT_BODY_TIMEOUT_MS = '50';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => never<Response>()) as typeof fetch;
  try {
    const { default: handler } = await import('../api/widget-agent.ts?resource-repro=1');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"prompt":"'));
      },
    });
    const req = new Request('https://www.example.test/api/widget-agent', {
      method: 'POST',
      headers: {
        Origin: 'https://www.example.test',
        'Content-Type': 'application/json',
        'X-WorldMonitor-Key': 'browser-test-key',
      },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const outcome = await Promise.race([
      handler(req).then(() => 'settled'),
      after(500, 'still-pending'),
    ]);
    assert.equal(outcome, 'settled');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.WIDGET_AGENT_BODY_TIMEOUT_MS;
  }
});

test('__resetWmSessionForTests restores the default mint timeout', async () => {
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { location: Location }).location = {
    href: 'https://example.test/',
    origin: 'https://example.test',
    hostname: 'example.test',
    protocol: 'https:',
    host: 'example.test',
  } as Location;
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = storage();
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage();
  (globalThis as unknown as { document: unknown }).document = {
    visibilityState: 'visible',
    addEventListener() {},
  };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((_input, init) => new Promise<Response>((resolve, reject) => {
    if (init?.signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    setTimeout(() => resolve(new Response(JSON.stringify({ exp: Date.now() + 3600000 }))), 100);
  })) as typeof fetch;

  const mod = await import('../src/services/wm-session.ts?reset-timeout-repro=1');
  mod.__setWmSessionFetchTimeoutForTests(50);
  mod.__resetWmSessionForTests();

  const outcome = await Promise.race([
    mod.ensureWmSession().then(() => 'settled'),
    after(500, 'still-pending'),
  ]);
  assert.equal(outcome, 'settled');
});

// NOTE(stage1-supabase-migration): the "clerk plan lookup must not pin the
// gateway when Clerk never responds" test was removed here. Its premise
// (an external Clerk Backend API round-trip inside validateBearerToken, with
// a timeout + 5-minute plan cache) no longer exists -- server/auth-session.ts
// now does a single local HS256 `jwtVerify` against SUPABASE_JWT_SECRET with
// no network call and nothing to time out or cache. Coverage of the new
// verification path lives in tests/auth-session.test.mts.
