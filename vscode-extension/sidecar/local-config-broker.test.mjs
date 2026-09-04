import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readAllConfig,
  writeBrokeredConfig,
  getBrokerFetchedAt,
} from './config-store.mjs';
import { fetchBrokerConfig, refreshBrokeredConfig } from './local-config-broker.mjs';

/**
 * Run `fn` against a throwaway config.db AND a throwaway session.json, since
 * refreshBrokeredConfig() reads both. `session` null means "not logged in".
 *
 * MUST await `fn()` inside the try, not `return fn()`: with an async body a
 * bare return hands the promise back and runs `finally` immediately, restoring
 * LOCAL_CONFIG_DB_PATH before the test has touched the store — so every test
 * would silently share one db and read each other's writes.
 */
async function withTmpState(fn, { session = { access_token: 'at-test' } } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wm-broker-'));
  const prevDb = process.env.LOCAL_CONFIG_DB_PATH;
  const prevSession = process.env.WM_LOCAL_SESSION_FILE;
  process.env.LOCAL_CONFIG_DB_PATH = path.join(dir, 'config.db');
  const sessionFile = path.join(dir, 'session.json');
  process.env.WM_LOCAL_SESSION_FILE = sessionFile;
  if (session) {
    writeFileSync(sessionFile, JSON.stringify({
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'u-1', email: 'op@example.test' },
      ...session,
    }), 'utf8');
  }
  try {
    return await fn();
  } finally {
    if (prevDb === undefined) delete process.env.LOCAL_CONFIG_DB_PATH;
    else process.env.LOCAL_CONFIG_DB_PATH = prevDb;
    if (prevSession === undefined) delete process.env.WM_LOCAL_SESSION_FILE;
    else process.env.WM_LOCAL_SESSION_FILE = prevSession;
    rmSync(dir, { recursive: true, force: true });
  }
}

const GOOD_BODY = {
  upstashUrl: 'https://org.upstash.io',
  upstashReadonlyToken: 'ro-token',
  appDomain: 'org.example',
};

/** A `fetch` stand-in returning one canned response, recording the calls. */
function stubFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => {
        if (response.json instanceof Error) throw response.json;
        return response.json;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

const SILENT = { log() {}, warn() {}, error() {} };

// ── fetchBrokerConfig ────────────────────────────────────────────────────

test('fetchBrokerConfig calls the function path with a bearer token', async () => {
  const fetchImpl = stubFetch({ status: 200, json: GOOD_BODY });
  const result = await fetchBrokerConfig({
    supabaseUrl: 'https://org.supabase.co/',
    accessToken: 'at-xyz',
    fetchImpl,
  });
  assert.equal(result.outcome, 'ok');
  assert.equal(fetchImpl.calls[0].url, 'https://org.supabase.co/functions/v1/local-config');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer at-xyz');
  assert.deepEqual(result.values, {
    UPSTASH_REDIS_REST_URL: 'https://org.upstash.io',
    UPSTASH_REDIS_REST_READONLY_TOKEN: 'ro-token',
    APP_DOMAIN: 'org.example',
  });
});

test('fetchBrokerConfig maps 401 and 403 to revoked', async () => {
  for (const status of [401, 403]) {
    const result = await fetchBrokerConfig({
      supabaseUrl: 'https://org.supabase.co',
      accessToken: 'at',
      fetchImpl: stubFetch({ status, json: { error: 'nope' } }),
    });
    assert.equal(result.outcome, 'revoked', `status ${status}`);
    assert.equal(result.status, status);
  }
});

test('fetchBrokerConfig maps 5xx, a network error and bad JSON to unavailable', async () => {
  const cases = [
    stubFetch({ status: 500, json: {} }),
    stubFetch(new Error('ECONNREFUSED')),
    stubFetch({ status: 200, json: new Error('Unexpected token <') }),
  ];
  for (const fetchImpl of cases) {
    const result = await fetchBrokerConfig({
      supabaseUrl: 'https://org.supabase.co',
      accessToken: 'at',
      fetchImpl,
    });
    assert.equal(result.outcome, 'unavailable');
  }
});

test('fetchBrokerConfig treats a 200 missing a field as unavailable, not ok', async () => {
  // A broken deployment must not be able to blank out a working cache.
  const result = await fetchBrokerConfig({
    supabaseUrl: 'https://org.supabase.co',
    accessToken: 'at',
    fetchImpl: stubFetch({ status: 200, json: { upstashUrl: 'https://u.io' } }),
  });
  assert.equal(result.outcome, 'unavailable');
  assert.match(result.reason, /UPSTASH_REDIS_REST_READONLY_TOKEN/);
});

// ── refreshBrokeredConfig ────────────────────────────────────────────────

test('a successful refresh caches the credential and populates env', async () => {
  await withTmpState(async () => {
    const env = { VITE_SUPABASE_URL: 'https://org.supabase.co' };
    const result = await refreshBrokeredConfig({
      env, logger: SILENT, fetchImpl: stubFetch({ status: 200, json: GOOD_BODY }),
    });
    assert.equal(result.status, 'ok');
    assert.equal(env.UPSTASH_REDIS_REST_READONLY_TOKEN, 'ro-token');
    assert.equal(env.APP_DOMAIN, 'org.example');
    assert.equal(readAllConfig().UPSTASH_REDIS_REST_URL, 'https://org.upstash.io');
    assert.ok(getBrokerFetchedAt() > 0);
  });
});

test('a revoked refresh CLEARS the cache and scrubs env', async () => {
  await withTmpState(async () => {
    writeBrokeredConfig({
      UPSTASH_REDIS_REST_URL: 'https://org.upstash.io',
      UPSTASH_REDIS_REST_READONLY_TOKEN: 'ro-token',
      APP_DOMAIN: 'org.example',
    });
    const env = {
      VITE_SUPABASE_URL: 'https://org.supabase.co',
      UPSTASH_REDIS_REST_READONLY_TOKEN: 'ro-token',
    };
    const result = await refreshBrokeredConfig({
      env, logger: SILENT, force: true, fetchImpl: stubFetch({ status: 403, json: {} }),
    });
    assert.equal(result.status, 'revoked');
    assert.ok(!('UPSTASH_REDIS_REST_READONLY_TOKEN' in env), 'scrubbed from env');
    assert.ok(!readAllConfig().UPSTASH_REDIS_REST_READONLY_TOKEN, 'dropped from config.db');
    assert.equal(getBrokerFetchedAt(), 0);
  });
});

test('an unavailable broker KEEPS the cached credential', async () => {
  // The load-bearing case: a Supabase or network outage must not wipe every
  // operator's mirror at once. Stale-but-authorised beats empty.
  await withTmpState(async () => {
    writeBrokeredConfig({
      UPSTASH_REDIS_REST_URL: 'https://org.upstash.io',
      UPSTASH_REDIS_REST_READONLY_TOKEN: 'ro-token',
      APP_DOMAIN: 'org.example',
    });
    const env = {
      VITE_SUPABASE_URL: 'https://org.supabase.co',
      UPSTASH_REDIS_REST_READONLY_TOKEN: 'ro-token',
    };
    const result = await refreshBrokeredConfig({
      env, logger: SILENT, force: true, fetchImpl: stubFetch(new Error('ETIMEDOUT')),
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(env.UPSTASH_REDIS_REST_READONLY_TOKEN, 'ro-token', 'env untouched');
    assert.equal(readAllConfig().UPSTASH_REDIS_REST_READONLY_TOKEN, 'ro-token', 'cache kept');
  });
});

test('a fresh cache short-circuits without an HTTP call; force overrides it', async () => {
  await withTmpState(async () => {
    writeBrokeredConfig({
      UPSTASH_REDIS_REST_URL: 'https://org.upstash.io',
      UPSTASH_REDIS_REST_READONLY_TOKEN: 'ro-token',
      APP_DOMAIN: 'org.example',
    });
    const env = { VITE_SUPABASE_URL: 'https://org.supabase.co' };

    const fetchImpl = stubFetch({ status: 200, json: GOOD_BODY });
    assert.equal((await refreshBrokeredConfig({ env, logger: SILENT, fetchImpl })).status, 'fresh');
    assert.equal(fetchImpl.calls.length, 0, 'no HTTP call while the cache is fresh');

    assert.equal(
      (await refreshBrokeredConfig({ env, logger: SILENT, force: true, fetchImpl })).status,
      'ok',
    );
    assert.equal(fetchImpl.calls.length, 1, 'force bypasses the TTL');
  });
});

test('no session and no Supabase URL are reported, not treated as failures', async () => {
  await withTmpState(async () => {
    const fetchImpl = stubFetch({ status: 200, json: GOOD_BODY });
    const result = await refreshBrokeredConfig({
      env: { VITE_SUPABASE_URL: 'https://org.supabase.co' },
      logger: SILENT, force: true, fetchImpl,
    });
    assert.equal(result.status, 'signed-out');
    assert.equal(fetchImpl.calls.length, 0);
  }, { session: null });

  await withTmpState(async () => {
    const result = await refreshBrokeredConfig({ env: {}, logger: SILENT, force: true });
    assert.equal(result.status, 'unconfigured');
  });
});

test('a refresh that changes an allowlist-affecting key warns about a restart', async () => {
  await withTmpState(async () => {
    writeBrokeredConfig({
      UPSTASH_REDIS_REST_URL: 'https://old.upstash.io',
      UPSTASH_REDIS_REST_READONLY_TOKEN: 'ro-token',
      APP_DOMAIN: 'org.example',
    });
    const warnings = [];
    const env = { VITE_SUPABASE_URL: 'https://org.supabase.co' };
    await refreshBrokeredConfig({
      env,
      logger: { log() {}, warn: (m) => warnings.push(m), error() {} },
      force: true,
      fetchImpl: stubFetch({ status: 200, json: { ...GOOD_BODY, upstashUrl: 'https://new.upstash.io' } }),
    });
    assert.ok(
      warnings.some((w) => w.includes('restart')),
      'UPSTASH_REDIS_REST_URL is captured at module load, so the operator is told',
    );
  });
});

test('a token-only rotation does NOT ask for a restart', async () => {
  // The token is read from process.env on every Redis call, so rotating it
  // takes effect immediately — nagging for a restart here would be noise.
  await withTmpState(async () => {
    writeBrokeredConfig({
      UPSTASH_REDIS_REST_URL: 'https://org.upstash.io',
      UPSTASH_REDIS_REST_READONLY_TOKEN: 'ro-old',
      APP_DOMAIN: 'org.example',
    });
    const warnings = [];
    await refreshBrokeredConfig({
      env: { VITE_SUPABASE_URL: 'https://org.supabase.co' },
      logger: { log() {}, warn: (m) => warnings.push(m), error() {} },
      force: true,
      fetchImpl: stubFetch({ status: 200, json: { ...GOOD_BODY, upstashReadonlyToken: 'ro-new' } }),
    });
    assert.deepEqual(warnings, []);
  });
});
