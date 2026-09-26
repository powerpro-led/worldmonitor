#!/usr/bin/env node
/**
 * Local operator real-time sync — fast-path push, LISTENER side.
 *
 * Companion to local-sync.mjs (the periodic full-rescan reader) and
 * scripts/_seed-utils.mjs / server/_shared/sync-notify.ts (the write-side
 * notify). This process:
 *   1. Opens ONE persistent connection to Upstash's REST-based Server-Sent
 *      Events endpoint (`POST {UPSTASH_URL}/subscribe/sync:notify`) — plain
 *      HTTPS, not a raw RESP/TCP connection. That distinction matters: an
 *      earlier hand-rolled raw-protocol sync attempt was rejected as
 *      "unreliable from an operator workstation on a VPN" (see local-sync.mjs's
 *      own header comment) — this uses the same transport class as every
 *      other REST call this repo already makes, so it does not reopen that
 *      failure mode.
 *   2. On each message, applies exactly one row to local-cache.db — either
 *      directly (small values ride inline in the message) or via one
 *      targeted read for that single key (oversized values / non-string
 *      types only send a signal). Either way this is orders of magnitude
 *      cheaper than local-sync.mjs's full rescan, because cost now scales
 *      with what actually changed, not with wall-clock ticks.
 *   3. On (re)connect — including the very first connect after the process
 *      starts, which covers "the operator's laptop just woke from sleep":
 *      no explicit sleep/wake detection is needed. A suspended process's
 *      timers/connections don't fire while the machine is asleep, but
 *      wall-clock time (Date.now(), the stream's own TCP state) still
 *      advances via the RTC; the OS resumes the process on wake and the
 *      dropped SSE connection surfaces as an ordinary stream error, which
 *      this file's normal reconnect path already handles — first backfills
 *      via a changelog catch-up (XRANGE sync:changelog from the last
 *      persisted cursor), so anything published while disconnected/asleep
 *      still lands, cheaply (only the gap, not a full rescan).
 *   4. local-sync.mjs's own full rescan stays in place as the correctness
 *      backstop for whatever this file's best-effort design can still miss
 *      (a write whose own notify silently failed, a message this process
 *      was down for AND whose changelog entry has since been trimmed) — see
 *      that file for its own (now much less frequent) schedule.
 *
 * Credentials: UPSTASH_REDIS_REST_READONLY_TOKEN only, matching local-sync.mjs's
 * own blast-radius rationale — SUBSCRIBE, XRANGE, and every targeted
 * follow-up read (GET/ZRANGE/HGETALL/...) are all read verbs.
 */

import { DatabaseSync } from 'node:sqlite';
import { Redis } from '@upstash/redis';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMirroredKey } from '../../scripts/shared/sync-domains.mjs';
import { KV_CACHE_DDL } from './kv-cache-schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_READONLY_TOKEN = process.env.UPSTASH_REDIS_REST_READONLY_TOKEN;
const SQLITE_PATH = process.env.LOCAL_SQLITE_PATH || path.join(__dirname, 'local-cache.db');
// Stored beside the mirror, not inside it — the mirror itself gets replaced
// wholesale by local-sync.mjs's atomic rename swap, and a cursor tracks THIS
// process's progress through the changelog, not a property of the file.
const CURSOR_PATH = `${SQLITE_PATH}.sync-cursor.json`;

const SYNC_NOTIFY_CHANNEL = 'sync:notify';
const SYNC_CHANGELOG_STREAM = 'sync:changelog';

const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
// No confirmed keep-alive comment from Upstash's SSE implementation (not
// documented either way) — this is a self-imposed idle watchdog rather than
// trusting the stream to error out on its own. Mirrors local-sync.mjs's own
// documented finding that a stuck connection can "just hang await fetch()
// forever — no error ever gets thrown" when nothing upstream tears it down
// cleanly; reconnecting proactively on silence sidesteps that class of hang
// entirely instead of trying to detect it after the fact.
const IDLE_TIMEOUT_MS = 90_000;
// Stall watchdog for catchUp() specifically — its Redis reads (via the
// @upstash/redis SDK's default client, no custom retry/signal handling) have
// no per-request timeout of their own, unlike local-sync.mjs's own
// withTimeoutRetry() wrapper, which exists precisely because this SDK can
// hang a request forever with no error ever thrown (see that file's own
// header comment).
//
// This used to be a flat total-duration cap (5 minutes) instead of a stall
// detector, and a real 2026-09-26 Windows field report found that design
// actively hostile to a slow-but-working connection: that machine processed
// ~901 entries per 300s batch window (~3/s, dominated by the per-entry
// targeted-read round trip) against a 10,072-entry backlog, so EVERY batch
// window ended just short of finishing and got cut off by the total-duration
// cap — costing 10 full reconnect-and-resume cycles and 45 minutes to catch
// up on a backlog a single sustained connection could have drained in one
// pass. A stall detector fixes exactly that: it only gives up when progress
// actually stops (no batch completes within this window), so a connection
// that's merely slow but still advancing keeps running instead of being
// punished for its own throughput.
const CATCHUP_STALL_MS = 60_000;

/** Matches local-sync.mjs's READ_FOR_TYPE exactly — same one-command-per-real-type discipline. */
const READ_FOR_TYPE = {
  string: (redis, key) => redis.get(key),
  zset: (redis, key) => redis.zrange(key, 0, -1, { withScores: true }),
  hash: (redis, key) => redis.hgetall(key),
  set: (redis, key) => redis.smembers(key),
  list: (redis, key) => redis.lrange(key, 0, -1),
};

function assertEnv() {
  if (!UPSTASH_URL) throw new Error('UPSTASH_REDIS_REST_URL not set.');
  if (!UPSTASH_READONLY_TOKEN) {
    throw new Error(
      'UPSTASH_REDIS_REST_READONLY_TOKEN not set — see local-sync.mjs\'s own assertEnv() for why this ' +
        'never falls back to the write-capable token.',
    );
  }
}

// Reads env fresh (module-const fallback) so a caller reached AFTER the P4
// credential broker populated the env — e.g. the on-demand /api/local-sync-refresh
// endpoint — still gets a working client even when this module was imported
// before the broker ran.
export function createReadClient() {
  const url = process.env.UPSTASH_REDIS_REST_URL || UPSTASH_URL;
  const token = process.env.UPSTASH_REDIS_REST_READONLY_TOKEN || UPSTASH_READONLY_TOKEN;
  if (!url || !token) {
    throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_READONLY_TOKEN not set');
  }
  return new Redis({ url, token });
}

function readCursor() {
  try {
    const raw = JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf-8'));
    return typeof raw.lastStreamId === 'string' ? raw.lastStreamId : '0';
  } catch {
    return '0'; // never caught up before, or file missing/corrupt — re-read from stream start
  }
}

/**
 * Redis Stream IDs are `<ms>-<seq>`, each half an unbounded-width decimal —
 * NOT safe to compare as plain strings once the two sides' digit counts
 * differ (e.g. seq rolling from 9 to 10). BigInt comparison per half instead.
 */
function isStreamIdNewer(candidate, current) {
  if (!current || current === '0') return true;
  try {
    const [candMs, candSeq = '0'] = candidate.split('-');
    const [curMs, curSeq = '0'] = current.split('-');
    const candMsB = BigInt(candMs);
    const curMsB = BigInt(curMs);
    if (candMsB !== curMsB) return candMsB > curMsB;
    return BigInt(candSeq) > BigInt(curSeq);
  } catch {
    return false; // malformed id from an unexpected publisher — never advance on it
  }
}

function writeCursor(id) {
  try {
    fs.writeFileSync(CURSOR_PATH, JSON.stringify({ lastStreamId: id, updatedAt: Date.now() }));
  } catch (err) {
    console.warn(`[sync-listener] failed to persist cursor (non-fatal — next catch-up re-reads from the last saved point): ${err.message}`);
  }
}

/**
 * Opens local-cache.db fresh for exactly one write, then closes it —
 * deliberately not a persistent handle, simply to keep this process's write
 * exposure to the shared file as small as possible (it is a fast, tiny,
 * single-row write; there is no benefit to holding the connection open
 * between messages, only a cost if it turns out to interact badly with
 * whatever else touches this file — see below for exactly that).
 *
 * journal_mode is forced to DELETE (SQLite's own default, but forced rather
 * than assumed) on every open. A now-removed earlier version of this
 * function set WAL instead, meaning to stop this write from blocking a
 * concurrent reader (sidecar-cache.ts's loadMirror()) behind the
 * rollback-journal's exclusive lock. That turned out to be a real Windows
 * hazard for an unrelated reason — journal_mode is a property of the file,
 * not the connection, so it stuck across every future opener, and a WAL
 * database's `-shm` companion is memory-mapped, which Windows won't let a
 * rename or delete proceed past — but reverting it did NOT fix the actual
 * failure a real Windows field report kept reproducing (confirmed by
 * inspecting the file header directly: never WAL, no `-wal`/`-shm` files,
 * still failing). The real cause was simpler and unrelated to journal mode
 * at all: something else holding open a live handle to local-cache.db is
 * exactly what Windows won't rename or delete over, at all, for as long as
 * that handle exists — not a brief race, a standing condition. Confirmed by
 * a controlled test: stopping the backend process (and nothing else) made
 * an otherwise-identical rename succeed instantly. local-sync.mjs's full
 * rebuild no longer renames anything at all as of the same fix (writes
 * directly into this live file instead — see its own header comment) so
 * this specific failure mode cannot recur there either way. DELETE mode
 * stays forced here regardless, since it's still the safer default for a
 * file multiple processes touch concurrently.
 */
function upsertRow(key, value, type) {
  fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });
  const db = new DatabaseSync(SQLITE_PATH);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec(KV_CACHE_DDL);
    db.prepare(
      'INSERT INTO kv_cache (key, value, type, synced_at) VALUES (?, ?, ?, ?) '
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, type = excluded.type, synced_at = excluded.synced_at',
    ).run(key, value, type, Date.now());
  } finally {
    db.close();
  }
}

/**
 * Applies one change. Uses the inline value when the publisher sent one
 * (the common case — most rows are a few KB); otherwise does one targeted
 * read for just this key via the read-only token. Either path ends with
 * the exact same storage rule local-sync.mjs's readValues() uses (`typeof
 * raw === 'string' ? raw : JSON.stringify(raw)`) so kv_cache stays
 * byte-for-byte compatible with what a full rescan would have written —
 * sidecar-cache.ts's decodeMirrorEntry() can't tell which path produced a
 * given row.
 */
async function applyChange(redis, { key, type, value }) {
  if (!isMirroredKey(key)) return; // defense in depth — the write side already gates on this
  if (value !== undefined) {
    upsertRow(key, value, type);
    return;
  }
  const reader = READ_FOR_TYPE[type];
  if (!reader) {
    console.warn(`[sync-listener] unknown type "${type}" for ${key} — skipping targeted read`);
    return;
  }
  let raw;
  try {
    raw = await reader(redis, key);
  } catch (err) {
    console.warn(`[sync-listener] targeted read failed for ${key} (non-fatal — the periodic full reconciliation will cover it): ${err.message}`);
    return;
  }
  if (raw == null) return; // vanished between notify and this read
  upsertRow(key, typeof raw === 'string' ? raw : JSON.stringify(raw), type);
}

// Every changelog entry is signal-only (see notifyChange()'s own comment for
// why), so catch-up's targeted reads are 100% of entries, never a subset —
// unlike applyChange()'s live-frame path, which skips the read entirely
// when a small value rode inline. Batched via Upstash's pipeline endpoint,
// grouped by read type so READ_FOR_TYPE[type] (already generic over its
// first arg — a plain client or a pipeline builder, same method names in
// both) can be reused unchanged. Sized well under Upstash's documented
// 1000-command pipeline cap, matching this codebase's existing convention
// for that headroom (see list-feed-digest.ts's STORY_BATCH_SIZE).
const CATCHUP_READ_BATCH_SIZE = 100;

/**
 * Backfills anything missed while offline/asleep/disconnected: reads
 * sync:changelog from the last persisted cursor forward (exclusive lower
 * bound — Redis Streams' '(' prefix), applies each entry, and advances the
 * cursor as it goes so a crash mid-catch-up resumes from where it left off
 * rather than re-reading the whole thing. Runs on every (re)connect,
 * including the process's very first connect — see this file's header
 * comment for why that alone covers "caught up after the laptop woke up."
 *
 * Reads are pipelined in batches of CATCHUP_READ_BATCH_SIZE, not one
 * sequential round trip per entry. Confirmed live 2026-09-25: a real
 * ~10,000-entry backlog (the kind a stale/never-connecting SSE subscription
 * accumulates — see this file's own connect-phase idle-timer fix from the
 * same session) took the old one-at-a-time loop well past
 * CATCHUP_WATCHDOG_MS, which aborted it before a single cursor advance —
 * and because the underlying stream keeps growing while catch-up runs, a
 * consumer slower than the sustained write rate can NEVER finish: every
 * reconnect just repeats the same abandon-and-retry cycle against an
 * ever-larger gap. Local writes (upsertRow, one open/close SQLite handle
 * per row — see that function's own comment for why that stays as-is) are
 * still applied one at a time in order after each batch's reads resolve,
 * and the cursor still advances per-entry, not per-batch — a crash mid-way
 * still resumes from the exact last row actually written, same guarantee
 * as before.
 *
 * @param {() => void} [onBatchDone] - called after each batch's cursor
 *   writes land, purely so the caller's stall watchdog (CATCHUP_STALL_MS)
 *   can reset its own timer on real progress. Optional so this stays
 *   callable exactly as before wherever nothing needs the signal (tests,
 *   any future direct caller).
 */
async function catchUp(redis, onBatchDone) {
  const cursor = readCursor();
  const startExclusive = cursor === '0' ? '-' : `(${cursor}`;
  let entries;
  try {
    entries = await redis.xrange(SYNC_CHANGELOG_STREAM, startExclusive, '+');
  } catch (err) {
    console.warn(`[sync-listener] changelog catch-up failed (non-fatal — the periodic full reconciliation will cover the gap): ${err.message}`);
    return;
  }
  const ids = Object.keys(entries || {}).sort();
  if (ids.length === 0) return;
  console.log(`[sync-listener] catch-up: ${ids.length} changelog entr${ids.length === 1 ? 'y' : 'ies'} since last cursor`);

  for (let i = 0; i < ids.length; i += CATCHUP_READ_BATCH_SIZE) {
    const batchIds = ids.slice(i, i + CATCHUP_READ_BATCH_SIZE);
    const items = batchIds.map((id) => {
      const fields = entries[id];
      const key = fields?.key;
      const type = typeof fields?.type === 'string' ? fields.type : 'string';
      return { id, key, type };
    });

    // Filtered BEFORE queuing pipeline commands, not after: a pipeline's
    // results array is positional, so a skipped item here (no key, unknown
    // type, or a key that's not admitted for mirroring — same denylist
    // check applyChange() itself does) must never leave a queued command
    // with nothing to line up against on the way back.
    const readable = items.filter((item) => typeof item.key === 'string'
      && isMirroredKey(item.key)
      && READ_FOR_TYPE[item.type]);
    for (const item of items) {
      if (typeof item.key === 'string' && isMirroredKey(item.key) && !READ_FOR_TYPE[item.type]) {
        console.warn(`[sync-listener] unknown type "${item.type}" for ${item.key} — skipping targeted read`);
      }
    }

    if (readable.length > 0) {
      const pipeline = redis.pipeline();
      for (const item of readable) READ_FOR_TYPE[item.type](pipeline, item.key);
      // keepErrors: true, not the default — @upstash/redis's own docs are
      // explicit that a plain exec() fails the WHOLE pipeline the moment any
      // single command errors (e.g. a WRONGTYPE if a key's type changed
      // between the changelog write and this read), which would otherwise
      // discard every other key in this batch of up to
      // CATCHUP_READ_BATCH_SIZE along with it. The old one-at-a-time loop
      // isolated each key's read failure to that key alone (applyChange()'s
      // own try/catch); this keeps that same isolation per command instead
      // of per batch.
      let results;
      try {
        results = await pipeline.exec({ keepErrors: true });
      } catch (err) {
        console.warn(`[sync-listener] catch-up pipeline read failed for a batch of ${readable.length} (non-fatal — the periodic full reconciliation will cover it): ${err.message}`);
        results = null;
      }
      if (results) {
        for (let j = 0; j < readable.length; j++) {
          const entry = results[j];
          if (entry?.error) {
            console.warn(`[sync-listener] targeted read failed for ${readable[j].key} (non-fatal — the periodic full reconciliation will cover it): ${entry.error}`);
            continue;
          }
          const raw = entry?.result;
          if (raw != null) upsertRow(readable[j].key, typeof raw === 'string' ? raw : JSON.stringify(raw), readable[j].type);
        }
      }
    }
    // Cursor still advances per-entry (not per-batch) and for every id in
    // this batch, including ones filtered out above — a key that's
    // unmirrored or unreadable this time isn't retried forever on every
    // future catch-up just because it never got a chance to advance past.
    for (const id of batchIds) writeCursor(id);
    onBatchDone?.();
  }
}

/**
 * Parses one buffered chunk of an SSE stream into complete frames (each
 * frame ends at a blank line per the SSE spec), extracting every `data:`
 * line. Returns [frames, remainder] — remainder is the incomplete tail to
 * prepend to the next chunk.
 */
function extractFrames(buffer) {
  const frames = [];
  // Normalize CRLF/CR to LF first — the SSE spec permits any of \r\n, \r, or
  // \n as a line terminator, and the live wire format this was verified
  // against (real Upstash, via curl) happened to use bare \n, but a proxy or
  // future Upstash change emitting \r\n would otherwise never match the
  // literal '\n\n' blank-line boundary below (the two \n's would be
  // separated by \r) — frames would silently never be extracted, looking
  // connected in the logs while applying nothing.
  const normalized = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const parts = normalized.split('\n\n');
  const remainder = parts.pop() ?? '';
  for (const part of parts) {
    const dataLines = part
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length > 0) frames.push(dataLines.join('\n'));
  }
  return [frames, remainder];
}

/**
 * Decodes one SSE `data:` payload into {key, type, value?, id?}. `id` is the
 * sync:changelog stream ID the writer's XADD produced for this same change
 * (see sync-notify.ts / _seed-utils.mjs's notifyChange — XADD now runs
 * BEFORE PUBLISH specifically so its ID can ride along here), letting the
 * live read loop advance the cursor without ever re-deriving an ID by
 * guessing at the stream's current tail. Older writers simply omit it.
 *
 * VERIFIED LIVE against a real Upstash endpoint (2026-08-23, via curl +
 * a real PUBLISH — see TASKS.md for the transcript), not guessed: the wire
 * format is a plain comma-separated string, NOT JSON —
 * VERIFIED LIVE against a real Upstash endpoint (2026-08-23, via curl +
 * a real PUBLISH — see TASKS.md for the transcript), not guessed: the wire
 * format is a plain comma-separated string, NOT JSON —
 *   `subscribe,<channel>,<subscriber count>`   (sent once, on subscribe)
 *   `message,<channel>,<the raw PUBLISH message, verbatim>`
 * Split on the first two commas only — the message itself is our own JSON
 * payload and legitimately contains commas, so a naive full split would
 * truncate it. Non-`message` frames (the initial `subscribe` ack) are
 * intentionally ignored.
 */
function decodeFrame(raw) {
  const firstComma = raw.indexOf(',');
  const secondComma = raw.indexOf(',', firstComma + 1);
  if (firstComma === -1 || secondComma === -1) return null;
  const eventType = raw.slice(0, firstComma);
  if (eventType !== 'message') return null; // e.g. the one-time 'subscribe' ack
  const rawMessage = raw.slice(secondComma + 1);
  let payload;
  try {
    payload = JSON.parse(rawMessage);
  } catch {
    return null; // not our JSON shape — some other publisher on this channel
  }
  if (!payload || typeof payload.key !== 'string' || typeof payload.type !== 'string') return null;
  return payload;
}

// Tags an idle-timeout self-abort so runForever() can log it as the routine,
// by-design reconnect it is, not a real connection failure. Passed as the
// AbortController's abort `reason` — verified live that both an in-flight
// fetch() and a reader.read() mid-stream reject with this exact object
// (undici propagates the reason as-is, not a generic AbortError), so a
// single check in runForever() covers every phase this timer can fire during.
class IdleReconnect extends Error {
  constructor() { super('idle timeout — proactive reconnect'); this.name = 'IdleReconnect'; }
}

/**
 * Holds one SSE connection open until it errors, closes, or goes idle past
 * IDLE_TIMEOUT_MS. Resolves normally on any of those — the caller
 * (runForever) treats every return as "reconnect", there's no persistent
 * "healthy" exit.
 */
async function runOneConnection(redis, externalSignal) {
  const controller = new AbortController();
  // An external stop (sidecar close()) aborts the in-flight fetch + read loop
  // immediately instead of waiting out IDLE_TIMEOUT_MS.
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  let idleTimer;
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new IdleReconnect()), IDLE_TIMEOUT_MS);
  };
  const clearIdleTimer = () => clearTimeout(idleTimer);
  resetIdleTimer(); // guards the connect handshake below only

  let response;
  try {
    response = await fetch(`${UPSTASH_URL}/subscribe/${encodeURIComponent(SYNC_NOTIFY_CHANNEL)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_READONLY_TOKEN}`, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
  } catch (err) {
    clearIdleTimer();
    throw err;
  }
  if (!response.ok || !response.body) {
    clearIdleTimer();
    throw new Error(`subscribe failed: HTTP ${response.status}`);
  }

  console.log('[sync-listener] connected — listening for changes');
  // Timer cleared before catch-up, not left running through it — catchUp()
  // does its own Redis reads, not SSE stream reads, and can legitimately
  // take longer than IDLE_TIMEOUT_MS under a large backlog (observed live
  // during this feature's own verification: a large catch-up abandoned the
  // freshly-opened connection mid-replay because the connect-phase timer was
  // still armed, forcing an immediate, avoidable reconnect that just
  // restarted the same slow catch-up). The timer's job is detecting a
  // silently-dead STREAM, which doesn't apply until we're actually reading
  // one below.
  clearIdleTimer();
  // Catch up AFTER the subscribe connection is open, not before, so a
  // notify published in between can't fall in the gap between the catch-up
  // read and the subscription taking effect. Guarded by a stall watchdog
  // (see CATCHUP_STALL_MS's own comment for why this is stall-based, not a
  // flat total-duration cap) rather than left unbounded. catchUp() itself is
  // NOT cancelled when the watchdog fires — there's no cheap way to abort a
  // pipeline mid-flight via this SDK, and letting it keep writing rows in the
  // background is harmless (upsertRow already tolerates concurrent writers,
  // same as the live loop below racing it) — only this connection cycle's
  // wait for it gives up.
  await new Promise((resolveWait) => {
    let lastProgressAt = Date.now();
    const stallTimer = setInterval(() => {
      if (Date.now() - lastProgressAt >= CATCHUP_STALL_MS) {
        clearInterval(stallTimer);
        console.warn(`[sync-listener] catch-up stalled — no progress for ${CATCHUP_STALL_MS / 1000}s, abandoning for this connection, will retry next reconnect`);
        resolveWait();
      }
    }, 5_000);
    catchUp(redis, () => { lastProgressAt = Date.now(); })
      .catch((err) => console.warn(`[sync-listener] catch-up failed unexpectedly (non-fatal): ${err.message}`))
      .finally(() => {
        clearInterval(stallTimer);
        resolveWait();
      });
  });
  resetIdleTimer(); // now guards the live read loop, reset on every frame received

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // Tracks progress through sync:changelog for the live-frame path, seeded
  // from whatever catchUp() above just persisted. Kept in memory (rather
  // than re-reading CURSOR_PATH per frame) purely to avoid a disk read per
  // message; writeCursor() below still persists on every advance, same cost
  // shape catchUp() already pays per entry.
  //
  // Fixes a real 2026-09-26 Windows field report: the cursor previously only
  // advanced inside catchUp()'s own loop, never here — so once a connection
  // caught up and settled into steady-state live pushes, the cursor froze at
  // the catch-up moment while data kept arriving. A restart minutes later
  // then replayed everything the live loop had already applied live (observed
  // live: 844s of "lag" that was actually a frozen cursor, not stale data).
  // decodeFrame() only carries an `id` when the writer is new enough to send
  // one (see sync-notify.ts / _seed-utils.mjs's notifyChange) — older
  // writers' frames simply don't advance the cursor here, same as before
  // this fix, so this is purely additive.
  let cursorId = readCursor();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      resetIdleTimer();
      buffer += decoder.decode(value, { stream: true });
      const [frames, remainder] = extractFrames(buffer);
      buffer = remainder;
      for (const frame of frames) {
        const payload = decodeFrame(frame);
        if (!payload) continue;
        await applyChange(redis, payload);
        // Only ever advances — concurrent writers can XADD out of the order
        // their PUBLISH frames arrive in (two independent HTTP round trips
        // per writer, no cross-writer ordering guarantee), so a numeric
        // newer-than check guards against a late-arriving frame for an
        // OLDER entry regressing the cursor past newer entries already
        // recorded.
        if (typeof payload.id === 'string' && isStreamIdNewer(payload.id, cursorId)) {
          cursorId = payload.id;
          writeCursor(cursorId);
        }
      }
    }
  } finally {
    clearTimeout(idleTimer);
    reader.releaseLock?.();
  }
}

/**
 * @param {{ signal?: AbortSignal }} [options] - pass an AbortSignal to stop
 *   the reconnect loop cleanly (sidecar teardown). Without one it runs for
 *   the process's whole life, as before.
 */
async function runForever(options = {}) {
  const { signal } = options;
  assertEnv();
  const redis = createReadClient();
  let attempt = 0;
  while (!signal?.aborted) {
    try {
      await runOneConnection(redis, signal);
      attempt = 0; // a clean connection that later dropped isn't a repeated-failure signal
    } catch (err) {
      if (signal?.aborted) break;
      if (err instanceof IdleReconnect) {
        // By design (see IDLE_TIMEOUT_MS's own comment), not a failure — a
        // real Windows field report found this accounted for 99.3% of
        // "connection lost" log lines across an 11-boot sample (~40/hour at
        // the 90s idle interval), making a genuinely rare real disconnect
        // (0.7%: a few ECONNRESET/DNS-failure occurrences) indistinguishable
        // noise. console.log, not warn — this is normal operation.
        console.log(`[sync-listener] idle ${IDLE_TIMEOUT_MS / 1000}s — proactive reconnect`);
        // Also reset the backoff, same reasoning as the success-path reset
        // above: an idle timeout is this loop's normal steady state, not a
        // repeated-failure signal, so it must not ratchet the reconnect delay
        // up to RECONNECT_MAX_DELAY_MS the way a real repeated failure
        // should. Without this, every idle cycle before this fix was already
        // (silently) doing exactly that — during purely quiet periods with
        // no actual problem, this loop would settle into reconnecting every
        // ~IDLE_TIMEOUT_MS + RECONNECT_MAX_DELAY_MS instead of right away,
        // widening the gap a live push arriving in that window has to wait
        // out (the changelog catch-up still backfills it, but later than
        // necessary).
        attempt = 0;
      } else {
        console.warn(`[sync-listener] connection lost (${err.message}) — reconnecting`);
      }
    }
    if (signal?.aborted) break;
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
    attempt++;
    await new Promise((resolve) => {
      const t = setTimeout(resolve, delay);
      signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}

// Only run when invoked directly (e.g. `node sync-listener.mjs`), not when
// imported — matches how local-api-server.mjs is expected to start this
// (see its own wiring), and keeps this file importable for tests without
// opening a real connection as a side effect. pathToFileURL (not a raw
// `file://${...}` template) so a path needing URL-encoding (spaces,
// non-ASCII) still compares correctly — same isMainModule() pattern
// local-api-server.mjs and local-sync.mjs both use.
function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMainModule()) {
  runForever();
}

export { applyChange, catchUp, decodeFrame, extractFrames, isStreamIdNewer, upsertRow, runForever };
