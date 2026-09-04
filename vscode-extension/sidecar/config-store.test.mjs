import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CONFIG_KEYS,
  SECRET_CONFIG_KEYS,
  BROKERED_CONFIG_KEYS,
  RESTART_REQUIRED_CONFIG_KEYS,
  BROKER_REFRESH_INTERVAL_MS,
  getConfigDbPath,
  readAllConfig,
  setConfig,
  deleteConfig,
  importFromEnvText,
  loadConfigIntoEnv,
  getBrokerFetchedAt,
  isBrokerCacheStale,
  writeBrokeredConfig,
  clearBrokeredConfig,
} from './config-store.mjs';

/** Run `fn` with LOCAL_CONFIG_DB_PATH pointed at a throwaway file. */
function withTmpDb(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wm-config-'));
  const prev = process.env.LOCAL_CONFIG_DB_PATH;
  process.env.LOCAL_CONFIG_DB_PATH = path.join(dir, 'config.db');
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.LOCAL_CONFIG_DB_PATH;
    else process.env.LOCAL_CONFIG_DB_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('getConfigDbPath honours LOCAL_CONFIG_DB_PATH', () => {
  withTmpDb(() => {
    assert.match(getConfigDbPath(), /wm-config-.*[/\\]config\.db$/);
  });
});

test('readAllConfig returns {} when the db does not exist yet', () => {
  withTmpDb(() => {
    assert.deepEqual(readAllConfig(), {});
  });
});

test('set / read / delete round-trips', () => {
  withTmpDb(() => {
    setConfig('VITE_SUPABASE_URL', 'https://example.supabase.co');
    setConfig('OPENROUTER_API_KEY', 'sk-or-test');
    assert.deepEqual(readAllConfig(), {
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      OPENROUTER_API_KEY: 'sk-or-test',
    });
    setConfig('VITE_SUPABASE_URL', 'https://changed.supabase.co'); // upsert
    assert.equal(readAllConfig().VITE_SUPABASE_URL, 'https://changed.supabase.co');
    deleteConfig('OPENROUTER_API_KEY');
    assert.deepEqual(readAllConfig(), { VITE_SUPABASE_URL: 'https://changed.supabase.co' });
  });
});

test('setConfig rejects an unknown key and an empty value', () => {
  withTmpDb(() => {
    assert.throws(() => setConfig('SUPABASE_SERVICE_ROLE_KEY', 'x'), /unknown config key/);
    assert.throws(() => setConfig('OPENROUTER_API_KEY', ''), /empty value/);
  });
});

test('loadConfigIntoEnv fills only unset keys; .env / real env wins', () => {
  withTmpDb(() => {
    setConfig('VITE_SUPABASE_URL', 'https://from-db.supabase.co');
    setConfig('UPSTASH_REDIS_REST_READONLY_TOKEN', 'ro-token');
    const env = { VITE_SUPABASE_URL: 'https://from-env.supabase.co' }; // already set
    const filled = loadConfigIntoEnv(env);
    assert.equal(env.VITE_SUPABASE_URL, 'https://from-env.supabase.co', 'existing value kept');
    assert.equal(env.UPSTASH_REDIS_REST_READONLY_TOKEN, 'ro-token', 'gap filled');
    assert.deepEqual(filled, ['UPSTASH_REDIS_REST_READONLY_TOKEN']);
    assert.equal(env.SUPABASE_URL, 'https://from-env.supabase.co', 'SUPABASE_URL mirrored');
  });
});

test('loadConfigIntoEnv treats an empty string as unset', () => {
  withTmpDb(() => {
    setConfig('OPENROUTER_API_KEY', 'sk-or-db');
    const env = { OPENROUTER_API_KEY: '' };
    loadConfigIntoEnv(env);
    assert.equal(env.OPENROUTER_API_KEY, 'sk-or-db');
  });
});

test('loadConfigIntoEnv is a no-op with no db', () => {
  withTmpDb(() => {
    const env = {};
    assert.deepEqual(loadConfigIntoEnv(env), []);
    assert.deepEqual(env, {});
  });
});

test('importFromEnvText stores allow-listed keys, skips the rest, strips quotes', () => {
  withTmpDb(() => {
    const set = importFromEnvText(
      [
        '# a comment',
        'VITE_SUPABASE_URL=https://x.supabase.co',
        'VITE_SUPABASE_PUBLISHABLE_KEY="quoted-key"',
        'UPSTASH_REDIS_REST_TOKEN=full-write-token-should-be-ignored',
        'SUPABASE_SERVICE_ROLE_KEY=nope',
        'OPENROUTER_API_KEY=',
        'LOCAL_API_MODE=tauri-sidecar',
      ].join('\n'),
    );
    assert.deepEqual(set.sort(), ['VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_URL']);
    assert.deepEqual(readAllConfig(), {
      VITE_SUPABASE_URL: 'https://x.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'quoted-key',
    });
  });
});

test('the allow-list never carries a shared write credential', () => {
  assert.ok(!CONFIG_KEYS.includes('UPSTASH_REDIS_REST_TOKEN'));
  assert.ok(!CONFIG_KEYS.includes('SUPABASE_SERVICE_ROLE_KEY'));
  assert.ok(!CONFIG_KEYS.includes('SUPABASE_SECRET_KEY'));
  for (const k of SECRET_CONFIG_KEYS) assert.ok(CONFIG_KEYS.includes(k));
});

// ── brokered config (PLATFORM_ARCHITECTURE.md P4 / Workstream 1) ──────────

test('brokered keys are a subset of the allow-list and exclude the bootstrap pair', () => {
  for (const k of BROKERED_CONFIG_KEYS) assert.ok(CONFIG_KEYS.includes(k), `${k} in CONFIG_KEYS`);
  for (const k of RESTART_REQUIRED_CONFIG_KEYS) {
    assert.ok(BROKERED_CONFIG_KEYS.includes(k), `${k} is brokered`);
  }
  // P11: the two public Supabase values are the irreducible bootstrap and can
  // never be brokered — the backend needs them to ask the broker anything.
  assert.ok(!BROKERED_CONFIG_KEYS.includes('VITE_SUPABASE_URL'));
  assert.ok(!BROKERED_CONFIG_KEYS.includes('VITE_SUPABASE_PUBLISHABLE_KEY'));
});

test('a brokered key in config.db OVERRIDES .env; an operator key does not', () => {
  withTmpDb(() => {
    writeBrokeredConfig({
      UPSTASH_REDIS_REST_URL: 'https://broker.upstash.io',
      UPSTASH_REDIS_REST_READONLY_TOKEN: 'ro-from-broker',
      APP_DOMAIN: 'broker.example',
    });
    setConfig('OPENROUTER_API_KEY', 'sk-or-db');

    const env = {
      // The exact hazard this rule exists for: a stale v2.12/v2.13-era .env
      // still carrying a credential the broker has since rotated or revoked.
      UPSTASH_REDIS_REST_READONLY_TOKEN: 'ro-stale-from-dotenv',
      APP_DOMAIN: 'stale.example',
      OPENROUTER_API_KEY: 'sk-or-from-env',
    };
    const filled = loadConfigIntoEnv(env);

    assert.equal(env.UPSTASH_REDIS_REST_READONLY_TOKEN, 'ro-from-broker', 'broker wins');
    assert.equal(env.APP_DOMAIN, 'broker.example', 'broker wins');
    assert.equal(env.OPENROUTER_API_KEY, 'sk-or-from-env', 'operator key: .env still wins');
    assert.ok(filled.includes('UPSTASH_REDIS_REST_READONLY_TOKEN'));
    assert.ok(!filled.includes('OPENROUTER_API_KEY'));
  });
});

test('loadConfigIntoEnv does not report a brokered key that already matches', () => {
  withTmpDb(() => {
    writeBrokeredConfig({
      UPSTASH_REDIS_REST_URL: 'https://u.upstash.io',
      UPSTASH_REDIS_REST_READONLY_TOKEN: 'ro',
      APP_DOMAIN: 'a.example',
    });
    const env = { UPSTASH_REDIS_REST_URL: 'https://u.upstash.io' };
    const filled = loadConfigIntoEnv(env);
    assert.ok(!filled.includes('UPSTASH_REDIS_REST_URL'), 'no-op is not reported as filled');
  });
});

test('writeBrokeredConfig reports only the keys whose value actually changed', () => {
  withTmpDb(() => {
    const values = {
      UPSTASH_REDIS_REST_URL: 'https://u.upstash.io',
      UPSTASH_REDIS_REST_READONLY_TOKEN: 'ro-1',
      APP_DOMAIN: 'a.example',
    };
    assert.deepEqual(writeBrokeredConfig(values).sort(), [...BROKERED_CONFIG_KEYS].sort());
    assert.deepEqual(writeBrokeredConfig(values), [], 'an unchanged refresh reports nothing');
    assert.deepEqual(
      writeBrokeredConfig({ ...values, UPSTASH_REDIS_REST_READONLY_TOKEN: 'ro-2' }),
      ['UPSTASH_REDIS_REST_READONLY_TOKEN'],
    );
  });
});

test('writeBrokeredConfig ignores unknown fields and refuses to store an empty one', () => {
  withTmpDb(() => {
    writeBrokeredConfig({
      UPSTASH_REDIS_REST_URL: 'https://u.upstash.io',
      UPSTASH_REDIS_REST_READONLY_TOKEN: '',
      somethingNew: 'from a future edge-function version',
      OPENROUTER_API_KEY: 'must-not-be-brokered',
    });
    const stored = readAllConfig();
    assert.equal(stored.UPSTASH_REDIS_REST_URL, 'https://u.upstash.io');
    assert.ok(!('UPSTASH_REDIS_REST_READONLY_TOKEN' in stored), 'empty value not stored');
    assert.ok(!('somethingNew' in stored), 'unknown field ignored, not thrown on');
    assert.ok(!('OPENROUTER_API_KEY' in stored), 'a non-brokered key is not brokerable');
  });
});

test('broker cache staleness: absent, fresh, expired, and a backwards clock', () => {
  withTmpDb(() => {
    assert.equal(getBrokerFetchedAt(), 0);
    assert.equal(isBrokerCacheStale(), true, 'never fetched -> stale');

    writeBrokeredConfig({
      UPSTASH_REDIS_REST_URL: 'https://u.upstash.io',
      UPSTASH_REDIS_REST_READONLY_TOKEN: 'ro',
      APP_DOMAIN: 'a.example',
    });
    const fetchedAt = getBrokerFetchedAt();
    assert.ok(fetchedAt > 0);

    assert.equal(isBrokerCacheStale(fetchedAt + 1000), false, 'just fetched -> fresh');
    assert.equal(
      isBrokerCacheStale(fetchedAt + BROKER_REFRESH_INTERVAL_MS),
      true,
      'exactly at the TTL -> stale',
    );
    // A clock that jumped backwards must not pin the cache as fresh forever.
    assert.equal(isBrokerCacheStale(fetchedAt - 60_000), true, 'future stamp -> stale');
  });
});

test('clearBrokeredConfig drops brokered keys + the stamp, and scrubs process.env', () => {
  withTmpDb(() => {
    setConfig('VITE_SUPABASE_URL', 'https://org.supabase.co');
    setConfig('OPENROUTER_API_KEY', 'sk-or-db');
    writeBrokeredConfig({
      UPSTASH_REDIS_REST_URL: 'https://u.upstash.io',
      UPSTASH_REDIS_REST_READONLY_TOKEN: 'ro',
      APP_DOMAIN: 'a.example',
    });

    const env = { UPSTASH_REDIS_REST_READONLY_TOKEN: 'ro', APP_DOMAIN: 'a.example' };
    clearBrokeredConfig(env);

    assert.deepEqual(readAllConfig(), {
      VITE_SUPABASE_URL: 'https://org.supabase.co',
      OPENROUTER_API_KEY: 'sk-or-db',
    }, 'operator-supplied keys survive a revocation');
    assert.equal(getBrokerFetchedAt(), 0, 'stamp cleared so the next tick re-fetches');
    // Leaving it in process.env would keep a revoked token live for the rest of
    // the process's life, since that is what every api/ handler reads.
    assert.ok(!('UPSTASH_REDIS_REST_READONLY_TOKEN' in env));
    assert.ok(!('APP_DOMAIN' in env));
  });
});

test('the broker stamp never leaks into process.env as a config key', () => {
  withTmpDb(() => {
    writeBrokeredConfig({
      UPSTASH_REDIS_REST_URL: 'https://u.upstash.io',
      UPSTASH_REDIS_REST_READONLY_TOKEN: 'ro',
      APP_DOMAIN: 'a.example',
    });
    const env = {};
    loadConfigIntoEnv(env);
    for (const k of Object.keys(env)) assert.ok(!k.startsWith('_'), `${k} is not a pseudo-key`);
    assert.ok(!('broker_fetched_at' in env));
  });
});
