import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadTelegramChannels,
  mergeFeed,
  normalizeTelegramMessage,
} from '../scripts/seed-telegram.mjs';

// The Telegram MTProto poll loop moved out of scripts/ais-relay.cjs into the
// hand-rolled scripts/seed-telegram.mjs — P14 Phase 2 tail / decision P18 (see
// PLATFORM_ARCHITECTURE.md). It stays hand-rolled (not runSeed) because its
// real output is a rolling window of the last N message objects merged into
// intelligence:telegram-feed:v1 plus per-channel read cursors persisted to
// Redis so a one-shot `--once` job dedupes across ticks. A concurrency-1 Redis
// lock replaces the singleton-relay guarantee that kept a second live MTProto
// session (→ AUTH_KEY_DUPLICATED) from ever being opened.
const here = dirname(fileURLToPath(import.meta.url));
const seedSource = readFileSync(resolve(here, '../scripts/seed-telegram.mjs'), 'utf8');

// ── Behavioural: the pure helpers ────────────────────────────────────────────

test('normalizeTelegramMessage builds the /telegram/feed item shape verbatim', () => {
  const item = normalizeTelegramMessage(
    { id: 42, message: 'hello world', date: 1_700_000_000 },
    { handle: 'testchan', label: 'Test Chan', topic: 'geopolitics', region: 'iran' },
  );
  assert.equal(item.id, 'testchan:42');
  assert.equal(item.source, 'telegram');
  assert.equal(item.channel, 'testchan');
  assert.equal(item.channelTitle, 'Test Chan');
  assert.equal(item.url, 'https://t.me/testchan/42');
  assert.equal(item.ts, new Date(1_700_000_000 * 1000).toISOString());
  assert.equal(item.text, 'hello world');
  assert.equal(item.topic, 'geopolitics');
  assert.deepEqual(item.tags, ['iran']);
  assert.equal(item.earlySignal, true);
});

test('normalizeTelegramMessage truncates text and tolerates missing fields', () => {
  const long = 'x'.repeat(5000);
  const item = normalizeTelegramMessage({ id: 1, message: long }, { handle: 'c' });
  assert.ok(item.text.length <= 800, 'text capped at TELEGRAM_MAX_TEXT_CHARS default');
  assert.equal(item.channelTitle, 'c', 'falls back to handle when label absent');
  assert.equal(item.topic, 'other', "defaults topic to 'other'");
  assert.deepEqual(item.tags, [], 'no region → empty tags');
  assert.match(item.ts, /^\d{4}-\d{2}-\d{2}T/, 'synthesizes a timestamp when date absent');
});

test('mergeFeed dedupes by id, keeps the newest by ts, and prefers incoming', () => {
  const existing = [
    { id: 'a:1', ts: '2024-01-01T00:00:00Z' },
    { id: 'a:2', ts: '2024-01-03T00:00:00Z' },
  ];
  const incoming = [
    { id: 'a:2', ts: '2024-01-03T00:00:00Z' }, // dupe of existing — dropped
    { id: 'a:3', ts: '2024-01-02T00:00:00Z' },
  ];
  const merged = mergeFeed(existing, incoming);
  assert.deepEqual(merged.map((m) => m.id), ['a:2', 'a:3', 'a:1']);
});

test('mergeFeed tolerates a non-array existing window (first run / wrong shape)', () => {
  assert.deepEqual(mergeFeed(undefined, [{ id: 'x:1', ts: 't' }]).map((m) => m.id), ['x:1']);
  assert.deepEqual(mergeFeed(null, [{ id: 'x:1', ts: 't' }]).map((m) => m.id), ['x:1']);
  assert.deepEqual(mergeFeed('garbage', [{ id: 'x:1', ts: 't' }]).map((m) => m.id), ['x:1']);
});

test('mergeFeed drops entries without an id', () => {
  const merged = mergeFeed([], [{ ts: 't' }, { id: '', ts: 't' }, { id: 'ok:1', ts: 't' }]);
  assert.deepEqual(merged.map((m) => m.id), ['ok:1']);
});

test('loadTelegramChannels reads the curated data/telegram-channels.json full set', () => {
  const channels = loadTelegramChannels();
  assert.ok(channels.length > 0, 'full set is non-empty');
  for (const c of channels) {
    assert.equal(typeof c.handle, 'string');
    assert.ok(!c.handle.startsWith('@'), 'leading @ stripped');
    assert.notEqual(c.enabled, false, 'disabled channels filtered out');
  }
});

// ── Source invariants: the parts that need external deps to exercise ─────────

test('the canonical feed key + schema match the pre-extraction relay contract', () => {
  assert.match(seedSource, /const FEED_KEY = 'intelligence:telegram-feed:v1'/);
  assert.match(seedSource, /const SEED_META_KEY = 'seed-meta:intelligence:telegram-feed:v1'/);
  // rolling window is published bare (no envelopeMeta) so the shape stays
  // {enabled, updatedAt, count, items} — what list-telegram-feed.ts / api reads
  assert.match(seedSource, /await atomicPublish\(FEED_KEY, payload, null, FEED_TTL\)/);
  assert.match(seedSource, /enabled: true,[\s\S]*updatedAt:[\s\S]*count: items\.length,[\s\S]*items,/);
  // TTLs verbatim from the relay loop: 1800s data / 900s meta
  assert.match(seedSource, /const FEED_TTL = 1800/);
  assert.match(seedSource, /const META_TTL = 900/);
});

test('a concurrency-1 Redis lock guards against a second live MTProto session', () => {
  assert.match(seedSource, /const LOCK_DOMAIN = 'intelligence:telegram-poll'/);
  assert.match(seedSource, /acquireLockSafely\(LOCK_DOMAIN, runId, LOCK_TTL_MS/);
  assert.match(seedSource, /if \(lock\.skipped\) return;/);
  assert.match(seedSource, /if \(!lock\.locked\) \{[\s\S]*Lock held, skipping/);
  assert.match(seedSource, /await releaseLock\(LOCK_DOMAIN, runId\)/);
  // lock TTL must outlast a full poll cycle (180s) + connect
  assert.match(seedSource, /LOCK_TTL_MS = 5 \* 60 \* 1000/);
});

test('per-channel read cursors round-trip through Redis, not process memory', () => {
  assert.match(seedSource, /const CURSOR_KEY = 'intelligence:telegram-feed:cursor:v1'/);
  assert.match(seedSource, /const cursors = await readCursors\(\)/);
  assert.match(seedSource, /await pollTelegramOnce\(cursors\)/);
  assert.match(seedSource, /const minId = cursors\[handle\] \|\| 0;/);
  assert.match(seedSource, /if \(!cursors\[handle\] \|\| msg\.id > cursors\[handle\]\) cursors\[handle\] = msg\.id;/);
  assert.match(seedSource, /await writeCursors\(cursors\)/);
  assert.match(seedSource, /'EX', CURSOR_TTL/);
});

test('AUTH_KEY_DUPLICATED and FLOOD_WAIT are handled the way the relay handled them', () => {
  // AUTH_KEY_DUPLICATED → stop, tell the operator to rotate TELEGRAM_SESSION
  assert.match(seedSource, /AUTH_KEY_DUPLICATED/);
  assert.match(seedSource, /session-auth\.mjs/);
  assert.match(seedSource, /fatal: true/);
  // FLOOD_WAIT → break the cycle early (do not keep hammering)
  assert.match(seedSource, /FLOOD_WAIT/);
  assert.match(seedSource, /stopping poll cycle early/);
});

test('a run that never connected leaves the feed key untouched and exits non-zero', () => {
  const mainRegion = seedSource.slice(
    seedSource.indexOf('export async function main()'),
    seedSource.indexOf("if (process.argv[1]"),
  );
  // no connection → throw (→ process.exit(1)), do NOT publish an empty feed
  assert.match(mainRegion, /if \(!connected\) \{[\s\S]*throw new Error/);
  // 0 channels polled but session healthy → return 0 (next tick retries),
  // unless the tick also hit a fatal session error
  assert.match(mainRegion, /if \(channelsPolled === 0\) \{[\s\S]*if \(fatal\) throw[\s\S]*return;/);
  // disabled env is a clean no-op, not a failure
  assert.match(mainRegion, /if \(!TELEGRAM_ENABLED\) \{[\s\S]*return;/);
});

test('no notification machinery rode along (Telegram never published events)', () => {
  // no actual publish call (the header comment mentions the name in prose)
  assert.doesNotMatch(seedSource, /publishNotificationEvent\s*\(/);
  assert.doesNotMatch(seedSource, /wm:events:queue/);
  // not registered as a notification producer (no `@notification-source: <kind>`
  // tag the way scripts/seed-classify.mjs / seed-weather-alerts.mjs carry one)
  assert.doesNotMatch(seedSource, /@notification-source:\s*(domain|rss)/);
});
