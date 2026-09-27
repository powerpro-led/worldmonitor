#!/usr/bin/env node
/**
 * One-way, periodic pull: shared Upstash Redis → local SQLite cache.
 *
 * Stage 3 of the local-data-layer roadmap in
 * docs/architecture/operator-space.md — "Sync, not replication": shaped
 * exactly like the seed scripts themselves (pull from a source, write to a
 * local store), just one hop further downstream. Pulls DIRECTLY from
 * Upstash — no dependency on the Nitric/GCP API layer or any deployment
 * (see that doc's "Full picture" section, corrected 2026-08-06).
 *
 * Uses the official `@upstash/redis` SDK (already a dependency here, used
 * elsewhere in this repo — e.g. server/_shared/rate-limit.ts — via
 * Redis.fromEnv()) rather than hand-rolled REST/fetch calls. Deliberate
 * choice made 2026-08-06 after the first hand-rolled version proved
 * unreliable from an operator workstation on a VPN — see "Retry &
 * timeout" below for why, and what switching bought (the SDK's own
 * `retry`/`signal` options are NOT among these — both turned out broken
 * for this use case, see that section):
 *   - `redis.scan(cursor, { withType: true })` returns key+type together,
 *     eliminating the separate TYPE-resolution pipeline pass the original
 *     version needed (SCAN, then a second round of TYPE calls) — roughly
 *     halves round-trips, which also halves exposure to link jitter.
 *   - `.pipeline().exec({ keepErrors: true })` isolates a single failed
 *     command instead of failing the whole chunk, matching the
 *     "skip keys that vanished mid-sync" behavior this script always had.
 *   - Pure JS/fetch under the hood, no native bindings — consistent with
 *     picking `node:sqlite` over `better-sqlite3` below for the same
 *     reason.
 *
 * Domain scope is a DENYLIST now, not the old SYNC_PREFIXES allowlist
 * (platform pivot, Workstream 4 / PLATFORM_ARCHITECTURE.md P6). This scan
 * walks the WHOLE keyspace (`SCAN MATCH *`) and mirrors every key that
 * scripts/shared/sync-domains.mjs's classifyKey() does not mark 'deny' —
 * so a freshly-seeded domain lands in the mirror with zero change here.
 * Denied (confirmed internal bookkeeping / credentials / live queues, zero
 * display value): `story:*` (~69% of all keys, pure news-dedup tracking),
 * `seed-routes:*`/`seed-activated:*`/`seed-lock:*` (sync-job bookkeeping —
 * `seed-meta:*` IS mirrored, it's local /api/health's freshness signal),
 * `baseline:*`, `digest:*`, `cache:*`, health.js's own `health:` incident
 * keys (not the health-variant datasets), `sync:*`,
 * `rl:*`, `llm:*`, `wm:*`, `*smoke-test:*`, `*:token`/`*:oauth:*`
 * (credentials), and `forecast:simulation-task*` (a live worker queue under
 * an otherwise-mirrored prefix). See that module for the full rationale.
 *
 * Every key is read with the one command that's actually correct for its
 * real Redis type (`ZRANGE ... WITHSCORES` for zsets, `HGETALL` for
 * hashes, etc.) — Redis has real structured types beyond strings
 * (`resilience:history:v20:<ISO2>` is a sorted set, confirmed live), and a
 * plain `GET` silently returns null for anything that isn't a string. No
 * fallback branching, no "try GET, fall back if null."
 *
 * Every run does a full rescan and upserts directly into the LIVE
 * local-cache.db — not a scratch-file-plus-atomic-rename swap, which is what
 * this used to do. Changed 2026-09-24 after two consecutive real Windows
 * field reports proved the rename was unfixable in place: Windows refuses to
 * rename or delete a file that any process still has open, and a controlled
 * test isolated the constant condition to exactly that — stopping the
 * long-lived backend process, and nothing else, made an otherwise-identical
 * rename succeed instantly (the backend is the only long-lived reader of
 * this file; server/_shared/sidecar-cache.ts's loadMirror() is the prime
 * suspect for the actual held handle, though the test didn't isolate it
 * that precisely). Two prior fix attempts (a retry ladder, then forcing
 * rollback-journal instead of WAL mode) each looked plausible and each
 * failed identically on real hardware — writing directly into the live file
 * sidesteps the whole question of why Windows holds the handle, rather than
 * trying to outguess it a third time.
 *
 * A key's row is only overwritten if this run's value isn't older than
 * what's already there (`WHERE excluded.synced_at >= kv_cache.synced_at` on
 * the upsert) — the same protection the old design needed a separate
 * "merge back fresher live-push rows before renaming" pass for, now just a
 * per-row condition instead of a whole extra step. A key that no longer
 * belongs (removed upstream, or newly filtered out) is pruned right after
 * the SCAN, from the key list alone — see PRUNE_SQL — so it happens even
 * when some value reads fail. A chunk whose reads exhaust their retries is
 * skipped (its rows keep their previous value) rather than aborting the run;
 * see readValues() and the byte-aware chunking notes by CHUNK_BYTE_BUDGET.
 *
 * Schema: a single generic key-value mirror table, not per-domain typed
 * tables — matches how vscode-extension/sidecar/local-api-server.mjs already reads
 * Redis today (plain key lookup, not relational queries), so the eventual
 * repoint (roadmap stage 4) is a near-trivial swap rather than a rewrite.
 * Non-string values (zset/hash/list/set) are JSON-encoded into the same
 * TEXT `value` column; string values are stored as-is (most are themselves
 * already-JSON application payloads — don't double-encode them). A `type`
 * column carries each key's real Redis type through so a reader can decode
 * it correctly (a JSON-encoded zset's flat member/score array is otherwise
 * indistinguishable from a string-typed key whose own payload happens to be
 * a JSON array) — without it, round-tripping is ambiguous, not just messy.
 *
 * Uses `node:sqlite` (built into Node 22.5+, this repo's baseline already —
 * see e.g. Dockerfile.* `FROM node:24-alpine`) instead of a native driver
 * like `better-sqlite3`, specifically to avoid a compiled binding that would
 * complicate cross-platform Tauri sidecar packaging. It's still an
 * EXPERIMENTAL Node API as of this writing (emits an ExperimentalWarning) —
 * accepted tradeoff, flagged here rather than hidden.
 *
 * Credentials: reads UPSTASH_REDIS_REST_READONLY_TOKEN, NOT
 * UPSTASH_REDIS_REST_TOKEN (the seed scripts' full read/write credential).
 * Deliberately does not fall back to the write-capable token — see
 * operator-space.md's "Open items" for why (limits blast radius if an
 * operator's laptop is compromised). Issue the read-only token in the
 * Upstash dashboard before running this (done 2026-08-06 — see
 * operator-space.md).
 *
 * Retry & timeout: a same-size 100-key pipeline chunk was measured (2026-08-06,
 * from a real operator workstation, first run with the actual read-only
 * token) swinging from ~3s to over 300s run to run — even for
 * `resilience:*`'s tiny ~77-byte rows, which a payload-size explanation
 * doesn't cover. `route get` confirmed the traffic went through a VPN
 * tunnel (a utunN interface), and an unrelated control host (Cloudflare's
 * speed-test endpoint) was independently slow and unstable on the same
 * link at the same time — general VPN-link jitter, not an
 * Upstash-specific throttle.
 *
 * The obvious fix — this SDK's own `retry`/`signal` client options — turned
 * out to be broken for this use case both ways (both discovered live,
 * 2026-08-06, reading node_modules/@upstash/redis's actual request-loop
 * source, not just its .d.ts): a function `signal` (so every retry gets a
 * fresh deadline) makes the SDK rethrow immediately on abort instead of
 * retrying at all; a plain `signal` fakes a 200 response with the abort
 * reason as the "result" instead of erroring, so a timeout would have
 * silently corrupted data rather than failing loudly. And with no signal
 * at all, a stuck connection just hangs `await fetch()` forever — no error
 * ever gets thrown, so the SDK's retry loop (which only fires from a
 * `catch` block) never engages either; confirmed live via a run that sat
 * past 300s with no output. So `withTimeoutRetry` below bypasses the SDK's
 * retry/signal machinery entirely: races each call against a plain
 * `setTimeout` rejection and just re-issues a fresh request on timeout,
 * externally, tracking the original client's `retry` config disabled
 * (`retry: false`) since the SDK's own attempt loop is not in the loop
 * anymore.
 */

import { DatabaseSync } from 'node:sqlite';
import { Redis } from '@upstash/redis';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyKey } from '../../scripts/shared/sync-domains.mjs';
import { KV_CACHE_DDL, SYNC_META_DDL, UPSERT_SQL } from './kv-cache-schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Exported (not just inlined in main()) so a test can exercise the exact
// freshness-guard and prune SQL against a real node:sqlite database without
// running the whole scan-Redis-then-write pipeline — this is the one part of
// the 2026-09-24 rewrite (writing directly into the live file instead of a
// scratch-file-plus-rename) that genuinely needed to be right the first
// time, after two previous fix attempts each looked right and weren't.
// UPSERT_SQL itself now lives in kv-cache-schema.mjs (shared with
// sync-listener.mjs's upsertRow()); re-exported here for existing importers.
export { UPSERT_SQL };

// Prune is driven by the SCAN key list alone, not by which values this run
// managed to read: a row goes if its key was NOT in this run's admitted scan
// set (the caller loads that set into the temp table `scan_keep` first) AND
// it wasn't written since the scan started (so a key sync-listener pushed
// mid-run survives). Until 2026-09-26 prune was a synced_at watermark that
// only ran after a fully successful run, so one unreadable chunk on a slow
// link meant deleted-upstream keys (e.g. a 2.1 MB sanctions:entities:v1)
// were served forever (wmtest v2.13.16 review, finding E).
export const SCAN_KEEP_DDL = 'CREATE TEMP TABLE IF NOT EXISTS scan_keep (key TEXT PRIMARY KEY)';
export const PRUNE_SQL = 'DELETE FROM kv_cache WHERE synced_at < ? AND key NOT IN (SELECT key FROM scan_keep)';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_READONLY_TOKEN = process.env.UPSTASH_REDIS_REST_READONLY_TOKEN;
const SQLITE_PATH = process.env.LOCAL_SQLITE_PATH || path.join(__dirname, 'local-cache.db');

// Own retry/timeout layer — see header comment for why the SDK's built-in
// `retry`/`signal` options don't work for this. RETRY_ATTEMPTS absorbs VPN
// jitter on top of REQUEST_TIMEOUT_MS.
//
// REQUEST_TIMEOUT_MS raised 45s -> 90s 2026-08-06: a 100-key
// `intelligence:*` pipeline chunk (mostly ~3KB narrative-cache strings,
// ~305KB combined response) measured at 55s via a direct curl call — no
// SDK involved, so not a code bug, genuinely that slow to transfer over
// the VPN link under that day's conditions — and was timing out 100% of
// attempts (4/4, both this run and the previous one) at the old 45s
// ceiling. 90s leaves real headroom above the measured worst case, same
// reasoning as the original 30s->45s bump this constant has already been
// through once before.
const REQUEST_TIMEOUT_MS = 90_000;
const RETRY_ATTEMPTS = 3;
const retryBackoffMs = (retryCount) => Math.min(1_000 * 2 ** retryCount, 8_000);

// Byte-aware read chunking (2026-09-26, wmtest v2.13.16 review, finding D).
// Upstash REST does not compress responses, and a single key can be over a
// megabyte (climate:air-quality:v1 ≈ 1.3 MB measured 100–112s on a ~12–20
// KB/s link) — so a fixed 100-key chunk under a fixed 90s timeout could
// NEVER succeed on a slow link, and because SCAN order is stable it failed
// at the same chunk on every run. Chunks are now packed up to
// CHUNK_BYTE_BUDGET using each key's size in the existing mirror (unknown
// keys assume UNKNOWN_KEY_BYTES), a key bigger than the budget gets a chunk
// of its own, and each chunk's timeout grows with its expected size at an
// assumed floor of MIN_THROUGHPUT_BYTES_PER_S (never below REQUEST_TIMEOUT_MS).
const CHUNK_BYTE_BUDGET = 256 * 1024;
const UNKNOWN_KEY_BYTES = 4 * 1024;
const MIN_THROUGHPUT_BYTES_PER_S = 8 * 1024;
const timeoutForBytes = (bytes) => Math.max(REQUEST_TIMEOUT_MS, Math.ceil((bytes / MIN_THROUGHPUT_BYTES_PER_S) * 1000));

// Stall watchdog, not a wall-clock cap: reset on every request attempt and
// every committed batch, so a slow-but-advancing run on a slow link isn't
// killed (the old flat 15-min cap needed ≥ ~23 KB/s sustained for a ~20 MB
// mirror). Every request is itself bounded by withTimeoutRetry, so this only
// catches a genuine hang outside a request. RUN_HARD_CAP_MS stays below
// local-api-server.mjs's 6h FULL_RECONCILIATION_INTERVAL_MS so two runs can
// never overlap.
const STALL_WATCHDOG_MS = 20 * 60_000;
const RUN_HARD_CAP_MS = 5 * 60 * 60_000;

const SCAN_COUNT = 1_000;

// classifyKey() lives in scripts/shared/sync-domains.mjs so this full-rescan
// reader and the fast-path write-side push nudge (notifyChange() in
// scripts/_seed-utils.mjs, notifyKeyChanged() in server/_shared/sync-notify.ts)
// agree on exactly what "mirrored" means. See that file for the denylist
// rationale (verified live against real Redis keys) and the three-state model.

/** Matches server/_shared/redis.ts's own pipeline batching discipline. */
const PIPELINE_CHUNK = 100;

// Read+write the admitted keys in bounded batches rather than one pass over
// the whole keyspace: keeps each SQLite write transaction short (a
// multi-second one blocks the sidecar's read-only opener — see
// openDatabase()) and bounds how many values are buffered in memory at once.
const SYNC_WRITE_BATCH = 1_000;

/**
 * The one pipeline method that correctly reads each type — no fallback chain.
 *
 * `get` disables the SDK's automatic JSON-deserialization (default: on)
 * for this one command only — client-wide off broke `scan(..., {withType:
 * true})`'s key/type pairing (it degrades to a flat [key, type, key,
 * type, ...] array without deserialization, discovered live 2026-08-06),
 * so deserialization stays on (the default) everywhere. Tried disabling it
 * per-command on just `get` instead (to keep `string`-typed JSON payloads
 * as raw text) — broke worse: passing `{ automaticDeserialization: false }`
 * as a pipelined `.get()`'s second arg gets serialized onto the wire as a
 * literal Redis command argument in this SDK version, not stripped as
 * client config, so every `get` in the pipeline errored with "wrong
 * number of arguments" (discovered live 2026-08-06 — 104/112
 * `intelligence:*` keys silently missing from the synced DB was the
 * symptom). No per-command opts at all, for any type — see the storage
 * rule in readValues() below instead, which sidesteps the whole issue.
 */
const READ_FOR_TYPE = {
  string: (p, key) => p.get(key),
  zset: (p, key) => p.zrange(key, 0, -1, { withScores: true }),
  hash: (p, key) => p.hgetall(key),
  set: (p, key) => p.smembers(key),
  list: (p, key) => p.lrange(key, 0, -1),
};

function assertEnv() {
  if (!UPSTASH_URL) {
    throw new Error('UPSTASH_REDIS_REST_URL not set.');
  }
  if (!UPSTASH_READONLY_TOKEN) {
    throw new Error(
      'UPSTASH_REDIS_REST_READONLY_TOKEN not set. This script deliberately does not fall ' +
        "back to UPSTASH_REDIS_REST_TOKEN (the seed scripts' full read/write credential) — " +
        'issue a read-only token in the Upstash dashboard first. See ' +
        'docs/architecture/operator-space.md, "Open items".',
    );
  }
}

/**
 * `signal`, when given, must be a FUNCTION returning an AbortSignal. In
 * @upstash/redis's request loop (read in node_modules, 2026-09-26) a
 * function signal that aborts makes the SDK rethrow the fetch's real abort
 * error immediately, and skip its own retries — which is exactly right
 * here, since withTimeoutRetry() owns retrying (retry: false below). That
 * "no SDK retry" behavior is the only reason the header comment ruled
 * function signals out, back when the SDK's retry was still in the loop. A
 * PLAIN AbortSignal is still never passed: on abort the SDK fabricates a 200
 * whose "result" is the abort reason, which would read as data.
 */
function createClient(signal) {
  return new Redis({
    url: UPSTASH_URL,
    token: UPSTASH_READONLY_TOKEN,
    retry: false,
    ...(signal ? { signal } : {}),
  });
}

// Stall-watchdog heartbeat (see STALL_WATCHDOG_MS).
let lastActivityAt = Date.now();
function noteActivity() {
  lastActivityAt = Date.now();
}

/**
 * Races `fn(client)` against `timeoutMs` and retries on either a timeout or
 * a thrown error, up to RETRY_ATTEMPTS times, with backoff between attempts.
 * Each attempt gets its OWN client bound to its own AbortController, and a
 * timed-out attempt is aborted — so its download stops competing for
 * bandwidth with the retry (it used to be left running unobserved, which on
 * a slow link meant every retry shared the pipe with its own orphans).
 * `fn` must build its request from the client it is handed, fresh each time.
 */
async function withTimeoutRetry(fn, label, timeoutMs = REQUEST_TIMEOUT_MS) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    noteActivity();
    const controller = new AbortController();
    try {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          // Reject first so the race settles on the timeout, then cancel
          // the in-flight fetch; its own abort rejection lands on an
          // already-settled race and is ignored.
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
          controller.abort(new Error('superseded by timeout'));
        }, timeoutMs);
      });
      try {
        return await Promise.race([fn(createClient(() => controller.signal)), timeout]);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_ATTEMPTS) {
        const wait = retryBackoffMs(attempt);
        console.warn(`[local-sync] ${label} failed (attempt ${attempt + 1}/${RETRY_ATTEMPTS + 1}): ${err.message}; retrying in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw new Error(`${label}: exhausted ${RETRY_ATTEMPTS + 1} attempts: ${lastErr.message}`);
}

/**
 * `WITHTYPE` is an Upstash EXTENSION to SCAN, not part of the Redis command
 * set — a real redis-server answers `ERR syntax error` and this script dies
 * on its very first prefix. That is exactly what happens against the local
 * dev stack (docker-compose.dev.yml: redis:7 behind an Upstash-REST shim),
 * so the backend this script talks to may or may not implement it.
 *
 * Probed once per run rather than branched on an env var. The operator
 * principle is that Upstash-vs-local-Redis is selected by
 * UPSTASH_REDIS_REST_URL alone and no code may read that URL to decide how
 * to behave — and this genuinely is a server capability question, not a
 * deployment question: a self-hosted Upstash-compatible endpoint would
 * support it while a plain redis-server does not, regardless of which one
 * the URL happens to name.
 *
 * The probe uses a pattern that cannot match anything, so it costs one O(1)
 * round trip and can never return keys. Deliberately NOT wrapped in
 * withTimeoutRetry(): a syntax error is permanent, so retrying it would add
 * ~7s of pure backoff to each of the 15 prefixes while changing nothing.
 */
let supportsWithType = null;

async function probeWithTypeSupport(redis) {
  try {
    await redis.scan('0', { match: '__local_sync_withtype_probe__:*', count: 1, withType: true });
    return true;
  } catch (err) {
    // Only a syntax error means "command not supported". Auth failures,
    // connection resets and timeouts must surface as the real errors they
    // are rather than being silently downgraded to a slower code path.
    if (/syntax error/i.test(err?.message ?? '')) return false;
    throw err;
  }
}

/**
 * The portable equivalent of WITHTYPE: a pipelined TYPE pass over keys a
 * plain SCAN returned. Same chunk size as readValues(), so the two passes
 * cost a comparable number of round trips.
 */
async function attachTypes(redis, keys) {
  const entries = [];
  for (let i = 0; i < keys.length; i += PIPELINE_CHUNK) {
    const chunk = keys.slice(i, i + PIPELINE_CHUNK);
    // Fresh pipeline inside the retried closure, for the same reason
    // readValues() builds its own — a Pipeline is not re-execable.
    const types = await withTimeoutRetry((client) => {
      const pipeline = client.pipeline();
      for (const key of chunk) pipeline.type(key);
      return pipeline.exec({ keepErrors: true });
    }, `TYPE chunk ${i}-${i + chunk.length}`);

    for (let j = 0; j < chunk.length; j++) {
      const { result: type, error } = types[j] ?? {};
      // 'none' is what TYPE returns for a key that expired between the SCAN
      // and this call — the same vanished-key case readValues() drops.
      if (error || !type || type === 'none') continue;
      entries.push({ key: chunk[j], type });
    }
  }
  return entries;
}

/**
 * Returns [{key, type}, ...] whether or not the server implements WITHTYPE.
 * `match` defaults to '*' — the denylist model scans the whole keyspace once
 * and classifies each key, rather than one scoped scan per allowlisted prefix.
 */
async function scanAllKeysWithType(redis, match = '*') {
  const entries = [];
  const untyped = [];
  let cursor = '0';
  let page = 0;
  do {
    const [nextCursor, batch] = await withTimeoutRetry(
      (client) => (supportsWithType
        ? client.scan(cursor, { match, count: SCAN_COUNT, withType: true })
        : client.scan(cursor, { match, count: SCAN_COUNT })),
      `SCAN ${match} page ${page}`,
    );
    cursor = nextCursor;
    if (supportsWithType) entries.push(...batch);
    else untyped.push(...batch);
    page++;
  } while (cursor !== '0');

  if (!supportsWithType) entries.push(...(await attachTypes(redis, untyped)));
  return entries;
}

/**
 * Reads every entry with the pipeline method matching its real type. Skips
 * unhandled types and keys that vanished between SCAN and read (null
 * result) or errored individually (keepErrors).
 *
 * Storage rule is `typeof raw`, not the Redis type from SCAN: with
 * deserialization on (see READ_FOR_TYPE comment), a JSON-payload string
 * comes back already parsed into an object/array/number/etc, so `typeof
 * raw === 'string'` is only true for values still in their original
 * string form (JSON.parse either wasn't attempted — non-`get` commands
 * return native structures already — or it failed, in which case the SDK
 * falls back to the raw string). Re-stringifying anything that isn't
 * already a string reproduces the original JSON payload; storing an
 * already-string value as-is avoids double-encoding it.
 */
/**
 * Packs entries into read chunks of at most PIPELINE_CHUNK keys and (where
 * possible) at most CHUNK_BYTE_BUDGET estimated bytes; a key whose own
 * estimate exceeds the budget is always a chunk of its own. Order-preserving.
 * Pure — exported for tests.
 *
 * @param {{key: string, type: string}[]} entries
 * @param {(key: string) => number | undefined} sizeOf - known size, or undefined
 * @returns {{entries: {key: string, type: string}[], bytes: number}[]}
 */
export function planReadChunks(entries, sizeOf) {
  const chunks = [];
  let current = { entries: [], bytes: 0 };
  for (const entry of entries) {
    const bytes = sizeOf(entry.key) ?? UNKNOWN_KEY_BYTES;
    const wouldOverflow = current.entries.length > 0
      && (current.bytes + bytes > CHUNK_BYTE_BUDGET || current.entries.length >= PIPELINE_CHUNK);
    if (wouldOverflow) {
      chunks.push(current);
      current = { entries: [], bytes: 0 };
    }
    current.entries.push(entry);
    current.bytes += bytes;
  }
  if (current.entries.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Reads the given entries in byte-aware chunks (see planReadChunks). A chunk
 * that exhausts its retries is SKIPPED, not fatal: its keys are returned in
 * `failedKeys`, their existing mirror rows are left untouched, and the next
 * run retries them. Before 2026-09-26 one bad chunk threw out of here and
 * aborted the whole run — no later batches, no prune — every run, at the
 * same chunk (finding D).
 *
 * @returns {Promise<{values: Map<string, {value: string, type: string}>, failedKeys: string[]}>}
 */
async function readValues(entries, sizeOf) {
  const values = new Map();
  const failedKeys = [];
  const readable = entries.filter((entry) => READ_FOR_TYPE[entry.type]);
  for (const { entries: chunk, bytes } of planReadChunks(readable, sizeOf)) {
    const label = chunk.length === 1
      ? `read ${chunk[0].key} (~${Math.round(bytes / 1024)} KB)`
      : `pipeline chunk of ${chunk.length} keys (~${Math.round(bytes / 1024)} KB)`;
    let results;
    try {
      // Pipeline built fresh inside the retried closure, not hoisted above
      // it — a Pipeline accumulates commands via chaining and .exec() isn't
      // meant to be called twice on the same instance, so a retry needs its
      // own new pipeline, not a re-exec of the one from a timed-out attempt.
      results = await withTimeoutRetry((client) => {
        const pipeline = client.pipeline();
        for (const { key, type } of chunk) READ_FOR_TYPE[type](pipeline, key);
        return pipeline.exec({ keepErrors: true });
      }, label, timeoutForBytes(bytes));
    } catch (err) {
      console.warn(`[local-sync] skipping ${label} for this run (keeping existing rows; next run retries): ${err.message}`);
      for (const { key } of chunk) failedKeys.push(key);
      continue;
    }

    for (let j = 0; j < chunk.length; j++) {
      const { key, type } = chunk[j];
      const { result: raw, error } = results[j] ?? {};
      if (error || raw == null) continue;
      values.set(key, { value: typeof raw === 'string' ? raw : JSON.stringify(raw), type });
    }
  }
  return { values, failedKeys };
}

/**
 * Opens a SCRATCH database that is renamed over the live one only after a
 * fully successful run.
 *
 * This used to open SQLITE_PATH directly and begin with `DELETE FROM
 * kv_cache`, which was survivable while a human ran it and watched the
 * output. Under a launchd timer it is not: the DELETE auto-commits
 * immediately, so any failure afterwards — a network blip during the first
 * prefix's SCAN, the watchdog firing, the machine sleeping — leaves the
 * operator with an EMPTY or half-populated mirror and no one watching. Worse,
 * a truncated rebuild writes a FRESH synced_at, so the staleness warning in
 * server/_shared/sidecar-cache.ts would report it as healthy.
 *
 * Staging into a temp file and renaming makes the swap atomic: a crashed run
 * leaves the previous good mirror completely untouched. Chosen over wrapping
 * the whole rebuild in one transaction because a multi-second write
 * transaction blocks the sidecar's read-only opener, and loadMirror()
 * swallows that failure into an EMPTY mirror — trading a partial mirror for
 * an empty one. A rename has no such interaction: a reader holds its old
 * inode open and sees the new file on its next start.
 */
/**
 * The operator this machine belongs to. Two sources, in priority order:
 *
 *   1. ~/.worldmonitor/session.json — written by `worldmonitor-local login`.
 *      Authoritative and available from a cold start: the operator ran an
 *      explicit login, so identity doesn't have to be inferred from traffic.
 *   2. operator-identity.json beside the mirror — the older path, written by
 *      the sidecar's recordOperatorIdentity() the first time the dashboard
 *      makes an authenticated request. Still the fallback for a machine that
 *      opened the dashboard but never ran the CLI login.
 *
 * Null until one of those exists. That is a deliberate fail-closed cold
 * start: with no known identity, NO user-scoped brief is mirrored at all
 * rather than guessing or mirroring everyone's. The agent re-runs on its
 * interval, so it self-heals once login (or a first authed request) happens.
 */
function readOperatorUserId() {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  try {
    const session = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.worldmonitor', 'session.json'), 'utf-8'),
    );
    const id = session?.user?.id;
    if (typeof id === 'string' && UUID_RE.test(id)) return id;
  } catch { /* not logged in via the CLI — fall through to the traffic-recorded file */ }
  try {
    const raw = fs.readFileSync(path.join(path.dirname(SQLITE_PATH), 'operator-identity.json'), 'utf-8');
    const id = JSON.parse(raw).userId;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

const OPERATOR_USER_ID = readOperatorUserId();

/**
 * Per-key admission filter, applied to everything SCAN returns.
 *
 * Only `brief:` needs one. Its keys come in three shapes, and exactly one of
 * them is user-scoped:
 *   brief:llm:description:<hash>  — shared LLM output, not user data
 *   brief:latest:<userId>         — pointer, user-scoped
 *   brief:<userId>:<slot>         — brief content, user-scoped
 * Note the second and third are distinguished only by position, so this
 * matches on the UUID wherever it appears rather than on segment count.
 */
function keepKey(key) {
  if (!key.startsWith('brief:')) return true;
  if (key.startsWith('brief:llm:')) return true;
  if (!OPERATOR_USER_ID) return false;
  return key.includes(OPERATOR_USER_ID);
}

function openDatabase() {
  fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });
  const db = new DatabaseSync(SQLITE_PATH);
  // Forced (not assumed) for the same reason sync-listener.mjs's upsertRow()
  // forces it — journal_mode is a property of the file, not the connection,
  // so this also self-heals a file some prior version left in WAL mode.
  db.exec('PRAGMA journal_mode = DELETE');
  // This connection now writes directly into the live file (see this file's
  // own header comment for why), so it genuinely can contend with
  // sync-listener.mjs's concurrent per-row writes — unlike the old scratch-
  // file design, which had this file to itself. Wait rather than fail
  // immediately on a transient lock.
  db.exec('PRAGMA busy_timeout = 5000');
  // DDL shared with sync-listener.mjs via kv-cache-schema.mjs so the two
  // writers can't drift; IF NOT EXISTS makes this safe against an
  // already-populated live file, not just a fresh one.
  db.exec(KV_CACHE_DDL);
  db.exec(SYNC_META_DDL);
  return db;
}

const SET_SYNC_META_SQL = 'INSERT INTO sync_meta (name, value) VALUES (?, ?) '
  + 'ON CONFLICT(name) DO UPDATE SET value = excluded.value';

/**
 * Prunes rows whose key is not in `keepKeys` (this run's admitted SCAN set)
 * and weren't written since `scanStartedAt`. Exported for tests.
 * @returns {number} rows deleted
 */
export function pruneToScannedKeys(db, keepKeys, scanStartedAt) {
  db.exec('BEGIN');
  try {
    db.exec(SCAN_KEEP_DDL);
    db.exec('DELETE FROM scan_keep');
    const insert = db.prepare('INSERT OR IGNORE INTO scan_keep (key) VALUES (?)');
    for (const key of keepKeys) insert.run(key);
    const deleted = db.prepare(PRUNE_SQL).run(scanStartedAt).changes;
    db.exec('DELETE FROM scan_keep');
    db.exec('COMMIT');
    return Number(deleted);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

async function main() {
  assertEnv();
  const redis = createClient();

  supportsWithType = await probeWithTypeSupport(redis);
  if (!supportsWithType) {
    console.log('[local-sync] server does not implement SCAN ... WITHTYPE — using a pipelined TYPE pass.');
  }

  console.log(
    OPERATOR_USER_ID
      ? `[local-sync] operator identity ${OPERATOR_USER_ID} — brief: scoped to this user`
      : '[local-sync] no operator identity recorded yet — mirroring brief:llm:* only, no user-scoped briefs. '
        + 'Open the dashboard once (any authenticated request) and the next sync will pick it up.',
  );
  console.log('[local-sync] denylist model — scanning the full keyspace (see scripts/shared/sync-domains.mjs)');

  const db = openDatabase();
  // Conditional upsert, not a plain INSERT: this writes into the LIVE file
  // (see this file's own header comment), which sync-listener.mjs's
  // upsertRow() can be writing to concurrently. The WHERE guard means a
  // key sync-listener already pushed a fresher value for during this run
  // keeps that fresher value instead of being reverted to what this scan
  // (which started earlier) read — the in-place equivalent of the old
  // design's separate "merge back fresher live-push rows" pass.
  const upsert = db.prepare(UPSERT_SQL);
  const syncedAt = Date.now();

  let totalFound = 0;
  let totalWritten = 0;
  let failedKeys = [];

  // Stall watchdog + hard cap (see STALL_WATCHDOG_MS). `.unref()` so it
  // doesn't itself keep the process alive once the real work finishes.
  noteActivity();
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - lastActivityAt > STALL_WATCHDOG_MS) {
      console.error(`[local-sync] FATAL: watchdog fired — no progress for ${STALL_WATCHDOG_MS / 1000}s.`);
      process.exit(1);
    }
    if (now - syncedAt > RUN_HARD_CAP_MS) {
      console.error(`[local-sync] FATAL: run exceeded the ${RUN_HARD_CAP_MS / 3_600_000}h hard cap.`);
      process.exit(1);
    }
  }, 30_000);
  watchdog.unref();

  try {
    const scanned = await scanAllKeysWithType(redis);

    // Denylist admission: keep everything classifyKey() does not mark 'deny',
    // then let keepKey() scope the one user-filtered prefix (brief:) to this
    // operator. 'mirror' and 'mirror-filtered' both flow through here — the
    // difference between them only matters on the fast-path push, which this
    // rescan is not.
    let deniedCount = 0;
    const admitted = scanned.filter((entry) => {
      if (classifyKey(entry.key) === 'deny') { deniedCount++; return false; }
      return true;
    });
    const entries = admitted.filter((entry) => keepKey(entry.key));
    const userSkipped = admitted.length - entries.length;
    totalFound = entries.length;

    console.log(
      `[local-sync]   ${scanned.length} keys scanned -> ${deniedCount} denied, `
      + (userSkipped > 0
        ? (OPERATOR_USER_ID
            ? `${userSkipped} another user's, `
            : `${userSkipped} user-scoped (no operator identity yet), `)
        : '')
      + `${entries.length} to mirror`,
    );

    // Prune FIRST, from the key list alone (finding E): anything not in this
    // scan's admitted set — removed upstream, or newly filtered out by
    // classifyKey()/keepKey() — goes now, independent of whether the value
    // reads below all succeed. Skipped on an empty scan: a wrong URL or an
    // emptied DB must not wipe a working offline mirror.
    if (scanned.length === 0) {
      console.warn('[local-sync]   SCAN returned 0 keys — skipping prune rather than emptying the mirror');
    } else {
      const deleted = pruneToScannedKeys(db, entries.map((e) => e.key), syncedAt);
      if (deleted > 0) console.log(`[local-sync]   pruned ${deleted} stale key(s) no longer in Redis or no longer admitted`);
    }

    // Size estimates for byte-aware chunking come from the current mirror
    // (key names + lengths only — no values loaded).
    const knownSizes = new Map(
      db.prepare('SELECT key, length(value) AS bytes FROM kv_cache').all().map((r) => [r.key, Number(r.bytes)]),
    );
    const sizeOf = (key) => knownSizes.get(key);

    // Read + write in bounded batches (see SYNC_WRITE_BATCH) rather than one
    // pass over every admitted key.
    for (let i = 0; i < entries.length; i += SYNC_WRITE_BATCH) {
      const batch = entries.slice(i, i + SYNC_WRITE_BATCH);
      const { values, failedKeys: batchFailed } = await readValues(batch, sizeOf);
      failedKeys = failedKeys.concat(batchFailed);

      db.exec('BEGIN');
      for (const [key, { value, type }] of values) {
        upsert.run(key, value, type, syncedAt);
        totalWritten++;
      }
      db.exec('COMMIT');
      noteActivity();
    }

    // Finding F: record reconciliation completion so the sidecar reports
    // mirror age from THIS, not from the newest (possibly live-pushed) row.
    const setMeta = db.prepare(SET_SYNC_META_SQL);
    db.exec('BEGIN');
    setMeta.run('last_reconcile_at', String(syncedAt));
    setMeta.run('last_reconcile_failed_keys', String(failedKeys.length));
    if (failedKeys.length === 0) setMeta.run('full_reconcile_at', String(syncedAt));
    db.exec('COMMIT');
  } finally {
    clearInterval(watchdog);
    db.close();
  }

  if (failedKeys.length > 0) {
    const sample = failedKeys.slice(0, 5).join(', ');
    console.warn(
      `[local-sync] done with gaps: ${totalWritten}/${totalFound} keys synced to ${SQLITE_PATH}; `
      + `${failedKeys.length} key(s) unreadable this run and kept at their previous value (${sample}${failedKeys.length > 5 ? ', …' : ''})`,
    );
  } else {
    console.log(`[local-sync] done: ${totalWritten}/${totalFound} keys synced to ${SQLITE_PATH}`);
  }
}

// Guards `main()` so importing this module (e.g. from a test, or a future
// in-process caller) doesn't trigger a real sync as a side effect of the
// import itself — this codebase's own dominant idiom for a script's entry
// point (100+ scripts/*.mjs files use the equivalent pattern; matches
// local-api-server.mjs's own isMainModule()). Missing until a multi-agent
// code review of the sync feature found it: local-api-server.mjs's
// startFullReconciliationLoop() spawns this file as a CHILD PROCESS rather
// than importing+calling it in-process specifically because this guard was
// absent — spawning is still the right call regardless (a hung run must not
// be able to wedge the sidecar's own HTTP server, only the child), but this
// guard removes the "importing this would trigger main() as an unwanted
// side effect" half of that reasoning, and lets a test import this module
// safely without a real sync running.
function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMainModule()) {
  main().catch((err) => {
    console.error('[local-sync] FATAL:', err.message);
    // No scratch file to discard any more — this writes directly into the
    // live file, in batches each committed on its own (see this file's own
    // header comment), so whatever completed before the failure is already
    // durable and whatever didn't just waits for the next run. Nothing left
    // to clean up here.
    process.exit(1);
  });
}
