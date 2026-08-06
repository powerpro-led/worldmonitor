#!/usr/bin/env node
/**
 * One-way, periodic pull: shared Upstash Redis → local SQLite cache.
 *
 * Stage 3 of the local-data-layer roadmap in
 * docs/architecture/operator-space.md — "Sync, not replication": shaped
 * exactly like the seed scripts themselves (pull from a source, write to a
 * local store), just one hop further downstream. Pulls DIRECTLY from
 * Upstash's REST API — no dependency on the Nitric/GCP API layer or any
 * deployment (see that doc's "Full picture" section, corrected 2026-08-06).
 *
 * First-slice domain scope, deliberately narrow (expand once this proves out
 * end to end, not before): `resilience:*` (Country Resilience Index) and
 * `intelligence:*` (regional briefs / narrative cache) — the two highest
 * "dashboard-ready" domains. Everything else (76% of all keys is
 * `story:alias:v1:*`, an internal news-dedup hashmap with no display value —
 * confirmed via a live scan 2026-08-06) is out of scope for now.
 *
 * Every key gets `TYPE`-checked before being read — Redis has real
 * structured types beyond strings (`resilience:history:v20:<ISO2>` is a
 * sorted set, confirmed live), and a plain `GET` silently returns null for
 * anything that isn't a string. No fallback branching: each key's type is
 * resolved up front and read with the one command that's actually correct
 * for it (`ZRANGE ... WITHSCORES` for zsets, `HGETALL` for hashes, etc.),
 * not "try GET, fall back if null."
 *
 * Every run does a full rebuild — `DELETE FROM kv_cache` then a fresh
 * insert of everything just fetched — rather than incremental upsert. No
 * partial/stale-row state to reason about between runs; the table is always
 * exactly what Upstash held as of the last sync.
 *
 * Schema: a single generic key-value mirror table, not per-domain typed
 * tables — matches how src-tauri/sidecar/local-api-server.mjs already reads
 * Redis today (plain key lookup, not relational queries), so the eventual
 * repoint (roadmap stage 4) is a near-trivial swap rather than a rewrite.
 * Non-string values (zset/hash/list/set) are JSON-encoded into the same
 * TEXT `value` column; string values are stored as-is (most are themselves
 * already-JSON application payloads — don't double-encode them).
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
 * Upstash dashboard before running this.
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_READONLY_TOKEN = process.env.UPSTASH_REDIS_REST_READONLY_TOKEN;
const SQLITE_PATH = process.env.LOCAL_SQLITE_PATH || path.join(__dirname, 'local-cache.db');

// SCAN and TYPE calls are light (key names / one-word type strings);
// value-read pipelines fetch up to PIPELINE_CHUNK full values in one
// round-trip and need real headroom when run from a workstation rather than
// a same-datacenter caller — matches server/_shared/redis.ts's own
// documented guidance (its header comment recommends
// REDIS_PIPELINE_TIMEOUT_MS=30000 for local runs). Confirmed necessary here,
// empirically, not guessed: a 100-key `intelligence:*` value pipeline
// measured at ~29s via a direct curl call (2026-08-06, average ~3KB/key —
// narrative-cache entries run larger than `resilience:*`'s ~77-byte history
// rows) — right at the edge of an initial 30s timeout, which aborted
// deterministically in testing. 45s leaves real headroom above the measured
// worst case rather than a razor's-edge margin.
const SCAN_TIMEOUT_MS = 10_000;
const PIPELINE_TIMEOUT_MS = 45_000;

/** First-slice domain scope — see header comment. */
const SYNC_PREFIXES = ['resilience:', 'intelligence:'];

/** Matches server/_shared/redis.ts's own pipeline batching discipline. */
const PIPELINE_CHUNK = 100;

/** The one Redis command that correctly reads each type — no fallback chain. */
const READ_COMMAND_FOR_TYPE = {
  string: (key) => ['GET', key],
  zset: (key) => ['ZRANGE', key, '0', '-1', 'WITHSCORES'],
  hash: (key) => ['HGETALL', key],
  set: (key) => ['SMEMBERS', key],
  list: (key) => ['LRANGE', key, '0', '-1'],
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

async function runPipeline(commands, timeoutMs) {
  const resp = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_READONLY_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`pipeline failed: HTTP ${resp.status}`);
  return resp.json();
}

async function scanAllKeys(prefix) {
  const keys = [];
  let cursor = '0';
  do {
    const resp = await fetch(`${UPSTASH_URL}/scan/${cursor}/match/${encodeURIComponent(`${prefix}*`)}/count/1000`, {
      headers: { Authorization: `Bearer ${UPSTASH_READONLY_TOKEN}` },
      signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`SCAN ${prefix}* failed: HTTP ${resp.status}`);
    const data = await resp.json();
    [cursor] = data.result;
    keys.push(...data.result[1]);
  } while (cursor !== '0');
  return keys;
}

/** Resolves the real Redis type of every key up front, chunked. */
async function resolveTypes(keys) {
  const types = new Map();
  for (let i = 0; i < keys.length; i += PIPELINE_CHUNK) {
    const chunk = keys.slice(i, i + PIPELINE_CHUNK);
    const results = await runPipeline(
      chunk.map((k) => ['TYPE', k]),
      PIPELINE_TIMEOUT_MS,
    );
    for (let j = 0; j < chunk.length; j++) {
      types.set(chunk[j], results[j]?.result);
    }
  }
  return types;
}

/** Reads every key with the command matching its real type. Skips keys that vanished between SCAN and TYPE ('none') or an unhandled type. */
async function readValues(keys, types) {
  const result = new Map();
  for (let i = 0; i < keys.length; i += PIPELINE_CHUNK) {
    const chunk = keys.slice(i, i + PIPELINE_CHUNK);
    const commandsWithKeys = chunk
      .map((key) => {
        const type = types.get(key);
        const buildCommand = READ_COMMAND_FOR_TYPE[type];
        return buildCommand ? { key, type, command: buildCommand(key) } : null;
      })
      .filter((entry) => entry !== null);
    if (commandsWithKeys.length === 0) continue;

    const results = await runPipeline(
      commandsWithKeys.map((entry) => entry.command),
      PIPELINE_TIMEOUT_MS,
    );
    for (let j = 0; j < commandsWithKeys.length; j++) {
      const { key, type } = commandsWithKeys[j];
      const raw = results[j]?.result;
      if (raw == null) continue;
      result.set(key, type === 'string' ? raw : JSON.stringify(raw));
    }
  }
  return result;
}

function openDatabase() {
  const db = new DatabaseSync(SQLITE_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      synced_at INTEGER NOT NULL
    )
  `);
  return db;
}

async function main() {
  assertEnv();
  console.log(`[local-sync] pulling prefixes: ${SYNC_PREFIXES.join(', ')}`);

  const db = openDatabase();
  const insert = db.prepare('INSERT INTO kv_cache (key, value, synced_at) VALUES (?, ?, ?)');
  const syncedAt = Date.now();

  let totalFound = 0;
  let totalWritten = 0;

  try {
    // Full rebuild — no incremental upsert, no stale-row bookkeeping. The
    // table is always exactly what Upstash held as of this run.
    db.exec('DELETE FROM kv_cache');

    for (const prefix of SYNC_PREFIXES) {
      const keys = await scanAllKeys(prefix);
      totalFound += keys.length;
      console.log(`[local-sync]   ${prefix}* -> ${keys.length} keys found`);

      const types = await resolveTypes(keys);
      const values = await readValues(keys, types);

      db.exec('BEGIN');
      for (const [key, value] of values) {
        insert.run(key, value, syncedAt);
        totalWritten++;
      }
      db.exec('COMMIT');
    }
  } finally {
    db.close();
  }

  console.log(`[local-sync] done: ${totalWritten}/${totalFound} keys synced to ${SQLITE_PATH}`);
}

main().catch((err) => {
  console.error('[local-sync] FATAL:', err.message);
  process.exit(1);
});
