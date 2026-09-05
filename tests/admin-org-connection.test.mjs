/**
 * Tests for src/services/admin-org-connection.ts — the Workstream 6
 * (admin panel) org connection + pipeline_config write path
 * (PLATFORM_ARCHITECTURE.md P5, corrected S59).
 *
 * Two independent surfaces: (1) connection storage, pure localStorage
 * read/write with no network involved; (2) commitPipelineConfigValue()'s
 * upsert-vs-delete branching, exercised against a fake Supabase client
 * passed in directly (mirroring runtime-config.ts's existing split
 * between pure validateSecret() and effectful setSecretValue() — the
 * branching logic worth testing never needs a real createClient() or
 * localStorage at all).
 *
 * Test runner: node:test via `tsx --test tests/*.test.mjs`.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Browser-global stub (localStorage only — no window/document needed here)
// ---------------------------------------------------------------------------

class MemoryStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

let _localStorage;

before(() => {
  _localStorage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: _localStorage,
  });
});

after(() => {
  delete globalThis.localStorage;
});

beforeEach(() => {
  _localStorage.clear();
});

const mod = await import('../src/services/admin-org-connection.ts');
const {
  getStoredOrgConnection,
  setStoredOrgConnection,
  clearStoredOrgConnection,
  commitPipelineConfigValue,
} = mod;

// ---------------------------------------------------------------------------
// Connection storage round-trip
// ---------------------------------------------------------------------------

describe('connection storage round-trip', () => {
  it('returns null when nothing is stored', () => {
    assert.equal(getStoredOrgConnection(), null);
  });

  it('stores and retrieves url + key, trimmed', () => {
    setStoredOrgConnection('  https://foo.supabase.co  ', '  pub-key-123  ');
    assert.deepEqual(getStoredOrgConnection(), { url: 'https://foo.supabase.co', key: 'pub-key-123' });
  });

  it('clearStoredOrgConnection() removes both keys, back to null', () => {
    setStoredOrgConnection('https://foo.supabase.co', 'pub-key-123');
    assert.notEqual(getStoredOrgConnection(), null);
    clearStoredOrgConnection();
    assert.equal(getStoredOrgConnection(), null);
  });

  it('returns null when only one of the two localStorage keys is present (partial/corrupt state)', () => {
    _localStorage.setItem('wm-admin-org-url', 'https://foo.supabase.co');
    assert.equal(getStoredOrgConnection(), null, 'url alone is not a valid connection');

    _localStorage.clear();
    _localStorage.setItem('wm-admin-org-key', 'pub-key-123');
    assert.equal(getStoredOrgConnection(), null, 'key alone is not a valid connection');
  });

  it('a fresh connect overwrites a previously stored one', () => {
    setStoredOrgConnection('https://foo.supabase.co', 'pub-key-foo');
    setStoredOrgConnection('https://bar.supabase.co', 'pub-key-bar');
    assert.deepEqual(getStoredOrgConnection(), { url: 'https://bar.supabase.co', key: 'pub-key-bar' });
  });
});

// ---------------------------------------------------------------------------
// commitPipelineConfigValue — upsert vs delete branching
// ---------------------------------------------------------------------------

function makeFakeClient({ upsertError = null, deleteError = null } = {}) {
  const calls = { table: null, upsert: [], delete: [] };
  const client = {
    from(table) {
      calls.table = table;
      return {
        upsert: async (row) => {
          calls.upsert.push(row);
          return { error: upsertError };
        },
        delete: () => ({
          eq: async (col, val) => {
            calls.delete.push([col, val]);
            return { error: deleteError };
          },
        }),
      };
    },
  };
  return { client, calls };
}

describe('commitPipelineConfigValue — upsert vs delete branching', () => {
  it('a non-empty value upserts {key, value} on pipeline_config', async () => {
    const { client, calls } = makeFakeClient();
    await commitPipelineConfigValue(client, 'FRED_API_KEY', 'abc123');

    assert.equal(calls.table, 'pipeline_config');
    assert.deepEqual(calls.upsert, [{ key: 'FRED_API_KEY', value: 'abc123' }]);
    assert.equal(calls.delete.length, 0, 'delete must not be called on the upsert branch');
  });

  it('an empty value deletes the row via .eq("key", key), never upserts an empty value', async () => {
    const { client, calls } = makeFakeClient();
    await commitPipelineConfigValue(client, 'FRED_API_KEY', '');

    assert.equal(calls.table, 'pipeline_config');
    assert.deepEqual(calls.delete, [['key', 'FRED_API_KEY']]);
    assert.equal(calls.upsert.length, 0, 'upsert must not be called on the delete branch');
  });

  it('propagates a Supabase error from the upsert branch', async () => {
    const { client } = makeFakeClient({ upsertError: { message: 'RLS denied' } });
    await assert.rejects(() => commitPipelineConfigValue(client, 'FRED_API_KEY', 'x'));
  });

  it('propagates a Supabase error from the delete branch', async () => {
    const { client } = makeFakeClient({ deleteError: { message: 'RLS denied' } });
    await assert.rejects(() => commitPipelineConfigValue(client, 'FRED_API_KEY', ''));
  });
});
