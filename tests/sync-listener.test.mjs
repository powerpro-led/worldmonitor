import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let dbPath;
let listener;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-listener-test-'));
  dbPath = path.join(tmpDir, 'local-cache.db');
  process.env.LOCAL_SQLITE_PATH = dbPath;
  // Fresh import per test — the module reads LOCAL_SQLITE_PATH at import
  // time into a module-level const, so it must be re-imported (with a
  // cache-busting query string) after the env var changes.
  listener = await import(`../vscode-extension/sidecar/sync-listener.mjs?t=${Date.now()}-${Math.random()}`);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LOCAL_SQLITE_PATH;
});

function readRow(key) {
  if (!fs.existsSync(dbPath)) return undefined; // nothing has ever written a row in this test
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM kv_cache WHERE key = ?').get(key);
  } finally {
    db.close();
  }
}

describe('extractFrames', () => {
  it('splits SSE frames on blank lines and pulls out data: payloads', () => {
    const [frames, remainder] = listener.extractFrames('data: {"a":1}\n\ndata: {"b":2}\n\ndata: incompl');
    assert.deepEqual(frames, ['{"a":1}', '{"b":2}']);
    assert.equal(remainder, 'data: incompl');
  });

  it('joins multi-line data fields per the SSE spec', () => {
    const [frames] = listener.extractFrames('data: line1\ndata: line2\n\n');
    assert.deepEqual(frames, ['line1\nline2']);
  });

  it('ignores non-data lines (event:, id:, comments)', () => {
    const [frames] = listener.extractFrames('event: message\nid: 5\ndata: {"x":1}\n\n');
    assert.deepEqual(frames, ['{"x":1}']);
  });
});

describe('decodeFrame', () => {
  // Wire format VERIFIED LIVE against a real Upstash endpoint (2026-08-23,
  // via curl + a real PUBLISH) — plain comma-separated `type,channel,data`,
  // not JSON. See this function's own comment in sync-listener.mjs.
  it('decodes a real "message,channel,payload" frame', () => {
    const message = JSON.stringify({ key: 'resilience:x', type: 'string', value: '{"a":1}' });
    const payload = listener.decodeFrame(`message,sync:notify,${message}`);
    assert.deepEqual(payload, { key: 'resilience:x', type: 'string', value: '{"a":1}' });
  });

  it('does not truncate a message payload that itself contains commas', () => {
    const message = JSON.stringify({ key: 'resilience:x', type: 'zset', value: 'a,b,c' });
    const payload = listener.decodeFrame(`message,sync:notify,${message}`);
    assert.equal(payload.value, 'a,b,c');
  });

  it('ignores the one-time "subscribe,channel,count" ack frame', () => {
    assert.equal(listener.decodeFrame('subscribe,sync:notify,1'), null);
  });

  it('returns null for a message whose payload is not our JSON shape', () => {
    assert.equal(listener.decodeFrame('message,sync:notify,plain text from a different publisher'), null);
  });

  it('returns null when key/type are missing from an otherwise-valid JSON payload', () => {
    assert.equal(listener.decodeFrame('message,sync:notify,{"foo":"bar"}'), null);
  });

  it('returns null for a frame with no comma at all', () => {
    assert.equal(listener.decodeFrame('malformed'), null);
  });
});

describe('upsertRow + applyChange', () => {
  it('writes a new row and creates the table on first write', () => {
    listener.upsertRow('resilience:x', '{"a":1}', 'string');
    const row = readRow('resilience:x');
    assert.equal(row.value, '{"a":1}');
    assert.equal(row.type, 'string');
    assert.ok(row.synced_at > 0);
  });

  it('upserts — a second write for the same key replaces it, not duplicates it', () => {
    listener.upsertRow('resilience:x', 'old', 'string');
    listener.upsertRow('resilience:x', 'new', 'string');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const count = db.prepare('SELECT COUNT(*) as n FROM kv_cache WHERE key = ?').get('resilience:x').n;
      assert.equal(count, 1);
    } finally {
      db.close();
    }
    assert.equal(readRow('resilience:x').value, 'new');
  });

  it('applyChange with an inline value writes directly, no Redis read', async () => {
    let reads = 0;
    const fakeRedis = { get: async () => { reads++; return 'unused'; } };
    await listener.applyChange(fakeRedis, { key: 'resilience:x', type: 'string', value: '{"inline":true}' });
    assert.equal(reads, 0);
    assert.equal(readRow('resilience:x').value, '{"inline":true}');
  });

  it('applyChange with no value does one targeted read matching the type', async () => {
    const calls = [];
    const fakeRedis = {
      zrange: async (key) => { calls.push(['zrange', key]); return ['2026-01-01', 50]; },
    };
    await listener.applyChange(fakeRedis, { key: 'resilience:history:v20:US', type: 'zset', value: undefined });
    assert.deepEqual(calls, [['zrange', 'resilience:history:v20:US']]);
    const row = readRow('resilience:history:v20:US');
    assert.equal(row.type, 'zset');
    assert.deepEqual(JSON.parse(row.value), ['2026-01-01', 50]);
  });

  it('applyChange skips keys outside the mirrored allowlist (defense in depth)', async () => {
    const fakeRedis = { get: async () => 'x' };
    await listener.applyChange(fakeRedis, { key: 'acled:oauth:token', type: 'string', value: 'secret' });
    assert.equal(readRow('acled:oauth:token'), undefined);
  });

  it('applyChange on a Redis read failure does not throw and writes nothing', async () => {
    const fakeRedis = { get: async () => { throw new Error('timeout'); } };
    await assert.doesNotReject(() =>
      listener.applyChange(fakeRedis, { key: 'resilience:x', type: 'string', value: undefined }));
    assert.equal(readRow('resilience:x'), undefined);
  });
});

describe('catchUp', () => {
  it('applies every changelog entry since the (absent) cursor and persists the new cursor', async () => {
    const fakeRedis = {
      xrange: async () => ({
        '1-1': { key: 'resilience:a', type: 'string' },
        '2-1': { key: 'resilience:b', type: 'string' },
      }),
      get: async (key) => `value-for-${key}`,
    };
    await listener.catchUp(fakeRedis);
    assert.equal(readRow('resilience:a').value, 'value-for-resilience:a');
    assert.equal(readRow('resilience:b').value, 'value-for-resilience:b');
    const cursor = JSON.parse(fs.readFileSync(`${dbPath}.sync-cursor.json`, 'utf-8'));
    assert.equal(cursor.lastStreamId, '2-1');
  });

  it('requests an exclusive range starting from a previously persisted cursor', async () => {
    fs.writeFileSync(`${dbPath}.sync-cursor.json`, JSON.stringify({ lastStreamId: '5-0' }));
    let requestedStart;
    const fakeRedis = {
      xrange: async (_key, start) => { requestedStart = start; return {}; },
    };
    await listener.catchUp(fakeRedis);
    assert.equal(requestedStart, '(5-0');
  });

  it('does nothing (no throw) when the changelog read fails', async () => {
    const fakeRedis = { xrange: async () => { throw new Error('network'); } };
    await assert.doesNotReject(() => listener.catchUp(fakeRedis));
  });
});
