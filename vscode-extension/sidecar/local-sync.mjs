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
 * Domain scope, verified live against the real store (SCAN + TYPE + value
 * sampling, 2026-08-07) rather than guessed: every prefix in SYNC_PREFIXES
 * below was hand-checked to hold real, structured, display-worthy JSON.
 * Deliberately excluded (confirmed internal bookkeeping, zero display
 * value): `story:*` (alias/peak/sources/track — pure news-dedup tracking,
 * no article content, ~69% of all keys),
 * `seed-meta:*`/`seed-routes:*`/`seed-activated:*` (sync-job bookkeeping),
 * `baseline:*` (internal statistical accumulator state), `digest:*`
 * (internal notification accumulator), `cache:*`/`health:*`/`temporal:*`/
 * `wm-smoke-test:*`/`wm:*` (tiny, internal/test), `news:*` (only
 * ingestion-ledger metadata — counts/drops — not article content).
 *
 * Every key is read with the one command that's actually correct for its
 * real Redis type (`ZRANGE ... WITHSCORES` for zsets, `HGETALL` for
 * hashes, etc.) — Redis has real structured types beyond strings
 * (`resilience:history:v20:<ISO2>` is a sorted set, confirmed live), and a
 * plain `GET` silently returns null for anything that isn't a string. No
 * fallback branching, no "try GET, fall back if null."
 *
 * Every run does a full rebuild — `DELETE FROM kv_cache` then a fresh
 * insert of everything just fetched — rather than incremental upsert. No
 * partial/stale-row state to reason about between runs; the table is always
 * exactly what Upstash held as of the last sync.
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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
// Absolute backstop for the whole run, well above worst-case
// (REQUEST_TIMEOUT_MS + backoff) * (RETRY_ATTEMPTS + 1) per chunk stacked
// across every chunk — catches a genuine infinite-loop bug, not ordinary
// jitter, which withTimeoutRetry already handles per-request.
const WATCHDOG_MS = 15 * 60_000;

const SCAN_COUNT = 1_000;

/** Domain scope — see header comment for how this list was chosen. */
const SYNC_PREFIXES = [
  'resilience:',
  'intelligence:',
  'energy:',
  'supply_chain:',
  'market:',
  'economic:',
  'climate:',
  'portwatch:',
  'risk:',
  'rss:',
  'forecast:',
  // Both spellings needed — get-theater-posture.ts's own live/backup keys
  // use a hyphen ('theater-posture:sebuf:v1'/':backup:v1') but its stale
  // key uses an underscore ('theater_posture:sebuf:stale:v1'). Missing
  // from this list entirely until found live: the Strategic Posture panel
  // read empty theaters forever in the VS Code sidecar, no error, because
  // the key it needs was never mirrored down from Upstash to begin with —
  // not a bug in the panel or the RPC handler, just an absent prefix here.
  'theater-posture:',
  'theater_posture:',
  // LLM OUTPUT — the most expensive rows in the store to regenerate, and the
  // whole point of a shared cache: both are keyed by a CONTENT hash (see
  // src/utils/summary-cache-key.ts, "the canonical cache-key builder shared by
  // both client and server"), so two operators reading the same article derive
  // the same key and ONE model call can serve everyone. Omitted until
  // 2026-08-20, which meant every operator silently re-paid for identical
  // summaries and classifications — same failure mode as the theater-posture:
  // note above, but costing money rather than showing a blank panel.
  'summary:',
  // Was listed as an exclusion above ("ML/log metadata"). That was wrong:
  // classify:sebuf:v6:<hash> holds the cached LLM verdict itself
  // ({level, category, timestamp}, CLASSIFY_CACHE_TTL = 86400), which drives
  // panel alert levels — and /api/intelligence/v1/classify-event is one of the
  // LLM-spend-quota'd paths, so a miss costs a real model call.
  'classify:',
];

/** Matches server/_shared/redis.ts's own pipeline batching discipline. */
const PIPELINE_CHUNK = 100;

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

function createClient() {
  // retry: false — this script's own withTimeoutRetry() replaces the SDK's
  // built-in retry entirely (see header comment for why: it doesn't fire
  // on a hung request at all, and its `signal` options are both broken for
  // this use case). No `signal` here either, same reason.
  return new Redis({
    url: UPSTASH_URL,
    token: UPSTASH_READONLY_TOKEN,
    retry: false,
  });
}

/**
 * Races `fn()` against REQUEST_TIMEOUT_MS and retries on either a timeout
 * or a thrown error, up to RETRY_ATTEMPTS times, with backoff between
 * attempts. `fn` must be safe to call again on timeout — it's re-invoked
 * as a fresh request, not resumed; the original call, if it does
 * eventually settle, is simply left to resolve unobserved (no real way to
 * cancel a fetch this SDK issued without its broken `signal` options).
 */
async function withTimeoutRetry(fn, label) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS);
      });
      try {
        return await Promise.race([fn(), timeout]);
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

/** SCAN with withType:true returns [{key, type}, ...] directly — no separate TYPE pass needed. */
async function scanAllKeysWithType(redis, prefix) {
  const entries = [];
  let cursor = '0';
  let page = 0;
  do {
    const [nextCursor, batch] = await withTimeoutRetry(
      () => redis.scan(cursor, { match: `${prefix}*`, count: SCAN_COUNT, withType: true }),
      `SCAN ${prefix}* page ${page}`,
    );
    cursor = nextCursor;
    entries.push(...batch);
    page++;
  } while (cursor !== '0');
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
async function readValues(redis, entries) {
  const result = new Map();
  for (let i = 0; i < entries.length; i += PIPELINE_CHUNK) {
    const chunk = entries.slice(i, i + PIPELINE_CHUNK).filter((entry) => READ_FOR_TYPE[entry.type]);
    if (chunk.length === 0) continue;

    // Pipeline built fresh inside the retried closure, not hoisted above
    // it — a Pipeline accumulates commands via chaining and .exec() isn't
    // meant to be called twice on the same instance, so a retry needs its
    // own new pipeline, not a re-exec of the one from a timed-out attempt.
    const results = await withTimeoutRetry(() => {
      const pipeline = redis.pipeline();
      for (const { key, type } of chunk) READ_FOR_TYPE[type](pipeline, key);
      return pipeline.exec({ keepErrors: true });
    }, `pipeline chunk ${i}-${i + chunk.length}`);

    for (let j = 0; j < chunk.length; j++) {
      const { key, type } = chunk[j];
      const { result: raw, error } = results[j] ?? {};
      if (error || raw == null) continue;
      result.set(key, { value: typeof raw === 'string' ? raw : JSON.stringify(raw), type });
    }
  }
  return result;
}

function openDatabase() {
  const db = new DatabaseSync(SQLITE_PATH);
  // Full rebuild every run (see main()), so a schema change here is
  // non-breaking — old DB files just get dropped and recreated fresh next
  // run, no migration needed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      type TEXT NOT NULL,
      synced_at INTEGER NOT NULL
    )
  `);
  return db;
}

async function main() {
  assertEnv();
  const redis = createClient();
  console.log(`[local-sync] pulling prefixes: ${SYNC_PREFIXES.join(', ')}`);

  const db = openDatabase();
  const insert = db.prepare('INSERT INTO kv_cache (key, value, type, synced_at) VALUES (?, ?, ?, ?)');
  const syncedAt = Date.now();

  let totalFound = 0;
  let totalWritten = 0;

  // See createClient()'s comment: no per-request abort signal, so this is
  // the only thing standing between a genuinely stuck request and an
  // indefinite hang. `.unref()` so it doesn't itself keep the process
  // alive once the real work finishes.
  const watchdog = setTimeout(() => {
    console.error(`[local-sync] FATAL: watchdog fired — sync exceeded ${WATCHDOG_MS / 1000}s.`);
    process.exit(1);
  }, WATCHDOG_MS);
  watchdog.unref();

  try {
    // Full rebuild — no incremental upsert, no stale-row bookkeeping. The
    // table is always exactly what Upstash held as of this run.
    db.exec('DELETE FROM kv_cache');

    for (const prefix of SYNC_PREFIXES) {
      const entries = await scanAllKeysWithType(redis, prefix);
      totalFound += entries.length;
      console.log(`[local-sync]   ${prefix}* -> ${entries.length} keys found`);

      const values = await readValues(redis, entries);

      db.exec('BEGIN');
      for (const [key, { value, type }] of values) {
        insert.run(key, value, type, syncedAt);
        totalWritten++;
      }
      db.exec('COMMIT');
    }
  } finally {
    clearTimeout(watchdog);
    db.close();
  }

  console.log(`[local-sync] done: ${totalWritten}/${totalFound} keys synced to ${SQLITE_PATH}`);
}

main().catch((err) => {
  console.error('[local-sync] FATAL:', err.message);
  process.exit(1);
});
