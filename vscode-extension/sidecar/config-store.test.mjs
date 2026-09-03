import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CONFIG_KEYS,
  SECRET_CONFIG_KEYS,
  getConfigDbPath,
  readAllConfig,
  setConfig,
  deleteConfig,
  importFromEnvText,
  loadConfigIntoEnv,
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
