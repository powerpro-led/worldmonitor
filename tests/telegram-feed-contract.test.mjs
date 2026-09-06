import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { listTelegramFeed } from '../server/worldmonitor/intelligence/v1/list-telegram-feed.ts';

// The Telegram MTProto poller moved out of ais-relay.cjs to the per-org
// scripts/seed-telegram.mjs `--once` job (P14 Phase 2 tail / decision P18). Both
// consumers — this RPC handler and api/telegram-feed.js — now read the mirrored
// `intelligence:telegram-feed:v1` rolling-window key instead of pulling live
// over `${WS_RELAY_URL}/telegram/feed`. These tests mock the Upstash GET wire
// shape (`{ result: "<json string>" }`) the same way the old ones mocked the
// relay fetch.
const FEED_KEY = 'intelligence:telegram-feed:v1';
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

/** Stub globalThis.fetch so a GET on FEED_KEY returns `payload` (or a miss when null). */
function mockFeedKey(payload) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    assert.match(u, new RegExp(`/get/${encodeURIComponent(FEED_KEY)}$`), `unexpected fetch: ${u}`);
    return new Response(JSON.stringify({ result: payload == null ? null : JSON.stringify(payload) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

/** No `origin` header → isDisallowedOrigin() passes (server-side / same-origin shape). */
function makeRequest(path = '/api/telegram-feed?limit=50') {
  return new Request(`https://example.test${path}`, { method: 'GET' });
}

describe('api/telegram-feed contract normalization', () => {
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.example.com';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    delete process.env.LOCAL_API_MODE;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  it('normalizes the rolling window into the browser UI contract and recomputes count', async () => {
    mockFeedKey({
      enabled: true,
      updatedAt: '2026-04-06T12:00:00Z',
      count: 999, // stale — must be recomputed from items.length
      items: [{
        id: 123,
        channel: 'warintel',
        channelTitle: 'War Intel',
        ts: 1_744_000_000_000,
        url: 'javascript:alert(1)',
        text: 'Missile launches reported',
        topic: 'conflict',
        tags: [42, 'urgent'],
        mediaUrls: ['https://cdn.example.com/image.jpg', 88, 'javascript:evil()'],
      }],
    });

    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(makeRequest());
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') || '', /s-maxage=120/);

    const data = await res.json();
    assert.equal(data.source, 'telegram');
    assert.equal(data.enabled, true);
    assert.equal(data.updatedAt, '2026-04-06T12:00:00Z');
    assert.equal(data.count, 1);
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].source, 'telegram');
    assert.equal(data.items[0].channel, 'warintel');
    assert.equal(data.items[0].channelTitle, 'War Intel');
    assert.equal(data.items[0].url, '', 'javascript: URL stripped');
    assert.equal(data.items[0].ts, new Date(1_744_000_000_000).toISOString());
    assert.deepEqual(data.items[0].tags, ['42', 'urgent']);
    assert.deepEqual(data.items[0].mediaUrls, ['https://cdn.example.com/image.jpg']);
  });

  it('returns a non-null timestamp string when items omit timestamps', async () => {
    mockFeedKey({
      enabled: true,
      items: [{ id: 'abc', channel: 'osint', url: 'https://t.me/osint/1', text: 'No timestamp' }],
    });
    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const data = await (await handler(makeRequest())).json();
    assert.equal(data.count, 1);
    assert.equal(data.items[0].ts, '1970-01-01T00:00:00.000Z');
  });

  it('treats an exact 1e12 timestamp value as milliseconds, not seconds', async () => {
    mockFeedKey({
      enabled: true,
      items: [{ id: 'boundary', channel: 'osint', ts: 1_000_000_000_000, url: 'https://t.me/osint/2', text: 'x' }],
    });
    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const data = await (await handler(makeRequest())).json();
    assert.equal(data.items[0].ts, new Date(1_000_000_000_000).toISOString());
  });

  it('filters by topic and channel and honours limit', async () => {
    mockFeedKey({
      enabled: true,
      items: [
        { id: 'a:1', channel: 'alpha', topic: 'conflict', ts: 3, text: 'a1' },
        { id: 'b:1', channel: 'beta', topic: 'conflict', ts: 2, text: 'b1' },
        { id: 'a:2', channel: 'alpha', topic: 'markets', ts: 1, text: 'a2' },
      ],
    });
    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;

    const byChannel = await (await handler(makeRequest('/api/telegram-feed?channel=Alpha'))).json();
    assert.deepEqual(byChannel.items.map((m) => m.id), ['a:1', 'a:2']);

    const byTopic = await (await handler(makeRequest('/api/telegram-feed?topic=CONFLICT'))).json();
    assert.deepEqual(byTopic.items.map((m) => m.id), ['a:1', 'b:1']);

    const limited = await (await handler(makeRequest('/api/telegram-feed?limit=1'))).json();
    assert.equal(limited.count, 1);
  });

  it('returns an empty synced=false feed (200) when the key is absent', async () => {
    mockFeedKey(null);
    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(makeRequest());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.enabled, false);
    assert.equal(data.count, 0);
    assert.deepEqual(data.items, []);
    assert.match(res.headers.get('cache-control') || '', /s-maxage=15/);
  });

  it('returns an empty synced=false feed when Upstash replies non-2xx (miss semantics)', async () => {
    // readJsonFromUpstash() maps a non-ok Upstash response to null (a miss),
    // not a throw — so a transient blip degrades to "not synced", not an error.
    globalThis.fetch = async () => new Response('nope', { status: 500 });
    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(makeRequest());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.enabled, false);
    assert.equal(data.count, 0);
  });

  it('returns 503 no-store only when the Redis read throws (timeout / network)', async () => {
    globalThis.fetch = async () => { throw new Error('network down'); };
    const handler = (await import(`../api/telegram-feed.js?t=${Date.now()}`)).default;
    const res = await handler(makeRequest());
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const data = await res.json();
    assert.equal(data.error, 'Telegram feed unavailable');
  });
});

describe('server listTelegramFeed normalization', () => {
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.example.com';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    delete process.env.LOCAL_API_MODE;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  it('maps alternate item field names into the public intelligence API contract', async () => {
    mockFeedKey({
      enabled: true,
      count: 0,
      items: [{
        id: 'msg-1',
        channelTitle: 'OSINT Watch',
        ts: '2026-04-06T12:30:00Z',
        url: 'https://t.me/osintwatch/1',
        text: 'Port disruption reported',
        topic: 'geopolitics',
        mediaUrls: [91, 'https://cdn.example.com/chart.png'],
      }],
    });

    const response = await listTelegramFeed(/** @type {any} */ ({}), { limit: 25 });
    assert.equal(response.enabled, true);
    assert.equal(response.count, 1);
    assert.equal(response.messages.length, 1);
    assert.equal(response.messages[0].channelName, 'OSINT Watch');
    assert.equal(response.messages[0].sourceUrl, 'https://t.me/osintwatch/1');
    assert.equal(response.messages[0].timestampMs, Date.parse('2026-04-06T12:30:00Z'));
    assert.deepEqual(response.messages[0].mediaUrls, ['https://cdn.example.com/chart.png']);
    assert.equal(response.error, '');
  });

  it('normalizes numeric Unix-second timestamps in the server RPC path', async () => {
    mockFeedKey({
      enabled: true,
      items: [{ id: 'msg-seconds', channel: 'osint', ts: 1_744_000_000, url: 'https://t.me/osint/seconds', text: 'x' }],
    });
    const response = await listTelegramFeed(/** @type {any} */ ({}), { limit: 25 });
    assert.equal(response.count, 1);
    assert.equal(response.messages[0].timestampMs, 1_744_000_000_000);
  });

  it('filters unsafe source and media URLs in the server RPC path', async () => {
    mockFeedKey({
      enabled: true,
      items: [{
        id: 'msg-unsafe-url',
        channel: 'osint',
        timestampMs: 1_744_000_000_000,
        sourceUrl: 'javascript:alert(1)',
        text: 'Unsafe URLs should not leave the server contract',
        mediaUrls: [
          'https://cdn.example.com/photo.jpg',
          'javascript:alert(2)',
          'ftp://cdn.example.com/file.jpg',
          'not a url',
          42,
        ],
      }],
    });
    const response = await listTelegramFeed(/** @type {any} */ ({}), { limit: 25 });
    assert.equal(response.count, 1);
    assert.equal(response.messages[0].sourceUrl, '');
    assert.deepEqual(response.messages[0].mediaUrls, ['https://cdn.example.com/photo.jpg']);
  });

  it('returns a distinct "not synced" state when the key is absent', async () => {
    mockFeedKey(null);
    const response = await listTelegramFeed(/** @type {any} */ ({}), { limit: 25 });
    assert.equal(response.enabled, false);
    assert.equal(response.count, 0);
    assert.deepEqual(response.messages, []);
    assert.equal(response.error, 'telegram feed not synced');
  });

  it('applies topic/channel filters and the limit cap', async () => {
    mockFeedKey({
      enabled: true,
      items: [
        { id: 'a:1', channel: 'alpha', topic: 'conflict', ts: 3, text: 'a1' },
        { id: 'b:1', channel: 'beta', topic: 'markets', ts: 2, text: 'b1' },
        { id: 'a:2', channel: 'alpha', topic: 'conflict', ts: 1, text: 'a2' },
      ],
    });
    const byChannel = await listTelegramFeed(/** @type {any} */ ({}), { channel: 'ALPHA' });
    assert.deepEqual(byChannel.messages.map((m) => m.id), ['a:1', 'a:2']);

    const capped = await listTelegramFeed(/** @type {any} */ ({}), { limit: 1 });
    assert.equal(capped.count, 1);
  });
});
