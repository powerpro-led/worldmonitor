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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYNC_PREFIXES } from '../../scripts/shared/sync-domains.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_READONLY_TOKEN = process.env.UPSTASH_REDIS_REST_READONLY_TOKEN;
const SQLITE_PATH = process.env.LOCAL_SQLITE_PATH || path.join(__dirname, 'local-cache.db');

/**
 * The rebuild is staged here and renamed over SQLITE_PATH only once the run
 * has fully succeeded — see openDatabase() for why that matters now that this
 * script runs unattended on a timer.
 */
const SQLITE_TMP_PATH = `${SQLITE_PATH}.tmp`;

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

// SYNC_PREFIXES moved to scripts/shared/sync-domains.mjs 2026-08-23 (imported
// above) so the fast-path write-side push nudge (notifyChange() in
// scripts/_seed-utils.mjs) and this full-rescan reader agree on exactly what
// "mirrored" means — see that file for the full per-prefix rationale
// (verified live against real Redis keys, not guessed) and why this list is
// duplicated, not shared, on the RPC-handler write side.

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
    const types = await withTimeoutRetry(() => {
      const pipeline = redis.pipeline();
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

/** Returns [{key, type}, ...] whether or not the server implements WITHTYPE. */
async function scanAllKeysWithType(redis, prefix) {
  const entries = [];
  const untyped = [];
  let cursor = '0';
  let page = 0;
  do {
    const [nextCursor, batch] = await withTimeoutRetry(
      () => (supportsWithType
        ? redis.scan(cursor, { match: `${prefix}*`, count: SCAN_COUNT, withType: true })
        : redis.scan(cursor, { match: `${prefix}*`, count: SCAN_COUNT })),
      `SCAN ${prefix}* page ${page}`,
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
 * The operator this machine belongs to, recorded by the sidecar
 * (local-api-server.mjs's recordOperatorIdentity) from the Supabase bearer the
 * dashboard obtains by exchanging the VS Code GitHub session token. Read from
 * beside the mirror, the one path both processes compute the same way.
 *
 * Null until the operator has made one authenticated request. That is a
 * deliberate fail-closed cold start: with no known identity, NO user-scoped
 * brief is mirrored at all rather than guessing or mirroring everyone's. The
 * agent re-runs on its interval, so it self-heals on the next sync.
 */
function readOperatorUserId() {
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
  // A leftover .tmp means a previous run died; it is scratch, so drop it.
  fs.rmSync(SQLITE_TMP_PATH, { force: true });
  const db = new DatabaseSync(SQLITE_TMP_PATH);
  // Always a fresh file, so a schema change here is non-breaking — no
  // migration is ever needed.
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
    // table is always exactly what Redis held as of this run. No DELETE
    // needed: openDatabase() started from an empty scratch file.

    for (const prefix of SYNC_PREFIXES) {
      const scanned = await scanAllKeysWithType(redis, prefix);
      const entries = scanned.filter((entry) => keepKey(entry.key));
      const skipped = scanned.length - entries.length;
      if (skipped > 0) {
        console.log(OPERATOR_USER_ID
            ? `[local-sync]   ${prefix}* -> skipped ${skipped} key(s) belonging to another user`
            : `[local-sync]   ${prefix}* -> skipped ${skipped} user-scoped key(s) (no operator identity yet)`);
      }
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

  // Close first, then swap. Closing cleanly removes SQLite's journal
  // sidecar files, so the single rename moves a self-contained database.
  fs.renameSync(SQLITE_TMP_PATH, SQLITE_PATH);

  console.log(`[local-sync] done: ${totalWritten}/${totalFound} keys synced to ${SQLITE_PATH}`);
}

main().catch((err) => {
  console.error('[local-sync] FATAL:', err.message);
  // Discard the half-built scratch file; the live mirror was never touched.
  fs.rmSync(SQLITE_TMP_PATH, { force: true });
  process.exit(1);
});
