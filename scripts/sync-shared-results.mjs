#!/usr/bin/env node

/**
 * Shared-data bridge — per-org `--once` job (CROSS_ORG_SHARED_DATA_PROPOSAL.md,
 * session 3 design + pilot).
 *
 * Generalizes scripts/sync-ais-results.mjs's role (copy a shared deploy's
 * output into THIS org's Upstash) to the `data-shared` deploy — the shared
 * Nitric/GCP stack that runs whichever scripts/railway-services.json entries
 * are flagged `centralized: true` (currently: seed-comtrade-bilateral-hs4
 * only — see scripts/shared/sync-domains.mjs's SHARED_DATA_KEY_PREFIXES for
 * the up-to-date list). Deliberately NOT a copy of sync-ais-results.mjs's
 * mechanism, though: that script does a blind `GET` on 2 hardcoded keys every
 * 2 minutes, which is fine for AIS's 2-key case but doesn't scale — this
 * script's cost is proportional to what actually changed, not to how many
 * sources are centralized, by design (see CROSS_ORG_SHARED_DATA_PROPOSAL.md's
 * "Session 3 addendum", point 1).
 *
 * Mechanism: promotes vscode-extension/sidecar/sync-listener.mjs's
 * catchUp() — there, only a reconnect-recovery path underneath a live SSE
 * subscription — to be this bridge's ONLY path. This job is a stateless
 * `--once` cron with no persistent process to hold a subscription open
 * between ticks, so there is no "steady state" for it to fall back from in
 * the first place:
 *   1. Read this org's own persisted cursor (a plain key in THIS org's own
 *      Upstash — not a local file, since nothing on disk survives between
 *      invocations of a `--once` cron the way it does for a long-lived
 *      sidecar process).
 *   2. XRANGE the SHARED store's `sync:changelog` stream from that cursor.
 *      Each entry names a key + type that changed; isSharedDataKey() filters
 *      to keys this bridge actually recognizes (defense in depth — the
 *      shared store should only ever hold centralized-seeder output, but the
 *      check costs nothing and matches how isMirroredKey()/isAisResultsKey()
 *      already gate their own domains).
 *   3. For each matched key, one targeted read from the shared store (GET /
 *      ZRANGE / HGETALL / ... depending on type), then write it into this
 *      org's own Upstash with the appropriate TTL and notifyChange() so this
 *      org's OWN downstream sync-listener.mjs fan-out picks it up immediately
 *      — same as any other seeded key, the operator's mirror can't tell the
 *      difference.
 *   4. Advance and persist the cursor.
 * Cost per tick scales with entries in the changelog window, not with the
 * number of centralized sources — the property session 2 flagged
 * sync-ais-results.mjs's mechanism as lacking.
 *
 * Backstop: the shared store's sync:changelog is capped (~10k entries,
 * approximate MAXLEN trim — see scripts/_seed-utils.mjs's notifyChange()) and
 * a bridge that's been down long enough can walk off the front of it even
 * with a saved cursor. Mirrors local-sync.mjs's relationship to
 * sync-listener.mjs one hop downstream: a low-frequency full reconciliation
 * (SCAN the shared store for every SHARED_DATA_KEY_PREFIXES entry, mirror
 * everything found) runs as a correctness backstop, gated to at most once per
 * FULL_RECONCILE_MIN_INTERVAL_MS so it doesn't turn every tick back into the
 * O(all centralized keys) cost this design exists to avoid.
 *
 * Env:
 *   DATA_SHARED_UPSTASH_REST_URL / _READONLY_TOKEN — the shared `data-shared`
 *                                    store (read-only; see deploy-data-shared.yml
 *                                    + .github/workflows/deploy-org.reusable.yml)
 *   UPSTASH_REDIS_REST_URL / _TOKEN — THIS org's DB (write) — already present
 *                                    for every per-org deploy
 *
 * Not runSeed / not a seeder — same discipline sync-ais-results.mjs documents
 * for itself: this computes nothing, it copies bytes. Exit 0 when the tick
 * completed (even a tick with nothing to bridge); exit 1 only when the
 * shared store could not be read at all — surface a genuinely broken bridge,
 * don't mask it as an empty success.
 */

import { getRedisCredentials, loadEnvFile, notifyChange } from './_seed-utils.mjs';
import { isSharedDataKey, SHARED_DATA_KEY_PREFIXES } from './shared/sync-domains.mjs';
import { SEED_META_TTL_SECONDS, TTL_SECONDS as COMTRADE_TTL_SECONDS } from './seed-comtrade-bilateral-hs4.mjs';

loadEnvFile(import.meta.url);

const SYNC_CHANGELOG_STREAM = 'sync:changelog';
// Bridge-internal bookkeeping, stored in THIS org's own Upstash (not the
// shared one — this org's progress through the shared changelog is specific
// to this org's bridge, every org reads the same stream from its own
// position). Both names are denied from the operator mirror already:
// `sync:` is a DENY_PREFIXES entry and `:cursor` is a DENY_SUFFIXES entry in
// scripts/shared/sync-domains.mjs, so no special-casing is needed here for
// that — same reasoning sync-listener.mjs's own cursor file relies on being
// off to the side of anything mirrored.
const CURSOR_KEY = 'sync:shared-bridge:cursor';
const LAST_FULL_RECONCILE_KEY = 'sync:shared-bridge:last-full-reconcile';
// Bookkeeping keys don't need to survive forever — a generous TTL just means
// a long-dormant org's bridge falls back to "no cursor, no full reconcile
// timestamp" (i.e. behaves like a first-ever run) instead of carrying state
// indefinitely. Not load-bearing for correctness either way.
const BOOKKEEPING_TTL_SECONDS = 90 * 86_400;
// 6h backstop cadence — matches local-sync.mjs's own (much less frequent
// than sync-listener.mjs's fast path) full-reconciliation role one hop
// downstream of this bridge.
const FULL_RECONCILE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Per-key-prefix TTL for whatever this bridge mirrors into the org's store.
// Mirrors sync-ais-results.mjs's own TTL_BY_KEY table: re-apply the TTL the
// ORIGINAL seeder uses (imported from seed-comtrade-bilateral-hs4.mjs's own
// exported consts, not duplicated as a magic number) so a value bridged here
// expires on the same schedule it would have if this org still ran the
// seeder itself. Add one entry per SHARED_DATA_KEY_PREFIXES group as more
// seeders get centralized.
const TTL_BY_PREFIX = [
  { prefix: 'seed-meta:comtrade:bilateral-hs4', ttlSeconds: SEED_META_TTL_SECONDS },
  { prefix: 'comtrade:bilateral-hs4:', ttlSeconds: COMTRADE_TTL_SECONDS },
];
const DEFAULT_TTL_SECONDS = 3600;

function ttlForKey(key) {
  const match = TTL_BY_PREFIX.find(({ prefix }) => key === prefix || (prefix.endsWith(':') && key.startsWith(prefix)));
  return match ? match.ttlSeconds : DEFAULT_TTL_SECONDS;
}

function sharedCreds() {
  const url = process.env.DATA_SHARED_UPSTASH_REST_URL;
  const token = process.env.DATA_SHARED_UPSTASH_READONLY_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

/** One raw Upstash REST command against arbitrary creds — same shape as every other rawFetch in this file's sibling scripts. */
async function rawCommand(creds, command) {
  const resp = await fetch(creds.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`${command[0]} ${command[1] ?? ''}: HTTP ${resp.status}`);
  const data = await resp.json();
  return data.result;
}

/** Matches vscode-extension/sidecar/sync-listener.mjs's READ_FOR_TYPE — one command per real Redis type, dispatched off the changelog entry's own `type` field. */
const READ_FOR_TYPE = {
  string: (creds, key) => rawCommand(creds, ['GET', key]),
  zset: (creds, key) => rawCommand(creds, ['ZRANGE', key, '0', '-1', 'WITHSCORES']),
  hash: (creds, key) => rawCommand(creds, ['HGETALL', key]),
  set: (creds, key) => rawCommand(creds, ['SMEMBERS', key]),
  list: (creds, key) => rawCommand(creds, ['LRANGE', key, '0', '-1']),
};

/**
 * Writes one value into the org's own store as the SAME Redis type it has in
 * the shared store, then fires the same fast-path notify a normal seeder
 * write would — never flattens a hash/zset/set/list into a JSON-stringified
 * plain-string key. That would round-trip fine through the operator's own
 * mirror (sync-listener.mjs's own upsertRow() stores everything as a string
 * regardless of source type, same as local-sync.mjs's readValues()) but would
 * silently corrupt any org-side RPC handler that reads this key directly off
 * the org's own Upstash with a type-specific command (HGETALL/ZRANGE/...) —
 * not exercised by the comtrade pilot (string-only), but worth getting right
 * now rather than shipping a branch that only LOOKS like it supports the
 * other types.
 *
 * Non-string types can't set a TTL inline the way SET ... EX can, so those
 * get a separate EXPIRE call after the write. DEL first for non-string types:
 * Redis errors (WRONGTYPE) if e.g. HSET targets a key that currently holds a
 * different type, and a bridged key could in principle have changed shape
 * between runs (not for comtrade today, but this function does not assume
 * that of every future centralized seeder).
 *
 * The non-string branches are reasoned from Upstash's documented raw REST
 * reply shapes (flat field/value or member/score arrays, matching plain RESP2
 * multi-bulk replies) and cross-checked against docker/redis-rest-proxy.mjs's
 * passthrough (`node-redis`'s raw sendCommand()), NOT exercised against a
 * live Upstash instance — the comtrade pilot never reaches them (its keys are
 * all plain strings). Worth a live smoke test with a real non-string
 * centralized seeder before trusting this path in production.
 */
async function mirrorIntoOrg(org, key, type, rawValue) {
  if (rawValue == null) return false; // vanished between the changelog entry and this read
  const ttl = ttlForKey(key);

  if (type === 'string') {
    await rawCommand(org, ['SET', key, rawValue, 'EX', String(ttl)]);
    notifyChange(org.url, org.token, key, rawValue).catch((err) => {
      console.warn(`  [sync-shared-results] ${key}: best-effort org-side notify failed (non-fatal): ${err.message}`);
    });
    return true;
  }

  if (!Array.isArray(rawValue) || rawValue.length === 0) {
    // An empty structure reads the same as an absent key for every consumer
    // that matters here — DEL rather than issue a zero-argument write command
    // (HSET/ZADD/SADD/RPUSH with no members are Redis errors, not no-ops).
    await rawCommand(org, ['DEL', key]);
    return false;
  }

  await rawCommand(org, ['DEL', key]);
  if (type === 'hash') {
    await rawCommand(org, ['HSET', key, ...rawValue]); // already flat [field, value, field, value, ...]
  } else if (type === 'zset') {
    // ZRANGE ... WITHSCORES returns flat [member, score, member, score, ...];
    // ZADD wants [score, member, ...] — swap each pair.
    const zaddArgs = [];
    for (let i = 0; i + 1 < rawValue.length; i += 2) zaddArgs.push(rawValue[i + 1], rawValue[i]);
    await rawCommand(org, ['ZADD', key, ...zaddArgs]);
  } else if (type === 'set') {
    await rawCommand(org, ['SADD', key, ...rawValue]);
  } else if (type === 'list') {
    await rawCommand(org, ['RPUSH', key, ...rawValue]); // preserves LRANGE 0 -1 order
  } else {
    console.warn(`[sync-shared-results] ${key}: unknown type "${type}" — deleted stale value, wrote nothing`);
    return false;
  }
  await rawCommand(org, ['EXPIRE', key, String(ttl)]);
  // Non-string writes go signal-only (no inline value) — same rule
  // server/_shared/sync-notify.ts's notifyPipelineWrites() uses for
  // ZADD/HSET/... pipeline writes: reconstructing a "new full value" from a
  // partial command isn't worth it when the listener's targeted follow-up
  // read is already cheap.
  notifyChange(org.url, org.token, key, undefined, type).catch((err) => {
    console.warn(`  [sync-shared-results] ${key}: best-effort org-side notify failed (non-fatal): ${err.message}`);
  });
  return true;
}

/**
 * The fast path: XRANGE the shared changelog from the persisted cursor,
 * mirror only what changed. Returns the number of keys bridged.
 */
async function incrementalBridge(shared, org) {
  let cursor = await rawCommand(org, ['GET', CURSOR_KEY]).catch(() => null);
  if (typeof cursor !== 'string' || cursor.length === 0) cursor = '0';
  const startExclusive = cursor === '0' ? '-' : `(${cursor}`;

  const entries = await rawCommand(shared, ['XRANGE', SYNC_CHANGELOG_STREAM, startExclusive, '+']);
  if (!Array.isArray(entries) || entries.length === 0) return 0;

  let bridged = 0;
  let lastId = cursor;
  for (const entry of entries) {
    // Upstash's REST JSON shape for XRANGE: [ [id, [field, value, field, value, ...]], ... ]
    const [id, fields] = Array.isArray(entry) ? entry : [undefined, undefined];
    if (typeof id !== 'string' || !Array.isArray(fields)) continue;
    lastId = id;
    const fieldMap = {};
    for (let i = 0; i + 1 < fields.length; i += 2) fieldMap[fields[i]] = fields[i + 1];
    const key = fieldMap.key;
    const type = fieldMap.type || 'string';
    if (typeof key !== 'string' || !isSharedDataKey(key)) continue;
    const reader = READ_FOR_TYPE[type];
    if (!reader) {
      console.warn(`[sync-shared-results] unknown type "${type}" for ${key} — skipping`);
      continue;
    }
    let value;
    try {
      value = await reader(shared, key);
    } catch (err) {
      console.warn(`[sync-shared-results] read failed for ${key}: ${err.message || err}`);
      continue;
    }
    try {
      if (await mirrorIntoOrg(org, key, type, value)) bridged++;
    } catch (err) {
      console.warn(`[sync-shared-results] write failed for ${key}: ${err.message || err}`);
    }
  }

  await rawCommand(org, ['SET', CURSOR_KEY, lastId, 'EX', String(BOOKKEEPING_TTL_SECONDS)]).catch((err) => {
    console.warn(`[sync-shared-results] failed to persist cursor (non-fatal — next tick re-reads from the last saved point, or re-scans everything if this key expires): ${err.message}`);
  });
  return bridged;
}

/**
 * The backstop: SCAN the shared store for every known SHARED_DATA_KEY_PREFIXES
 * entry and mirror everything found, regardless of changelog state. Gated to
 * run at most once per FULL_RECONCILE_MIN_INTERVAL_MS — see this file's
 * header for why an unconditional full scan every tick would undo the whole
 * point of the changelog+cursor design.
 */
async function maybeFullReconcile(shared, org) {
  const lastRun = Number(await rawCommand(org, ['GET', LAST_FULL_RECONCILE_KEY]).catch(() => null));
  if (Number.isFinite(lastRun) && Date.now() - lastRun < FULL_RECONCILE_MIN_INTERVAL_MS) return 0;

  let bridged = 0;
  for (const prefix of SHARED_DATA_KEY_PREFIXES) {
    const keys = prefix.endsWith(':') ? await scanKeys(shared, `${prefix}*`) : [prefix];
    for (const key of keys) {
      try {
        // Unlike the changelog path, a SCAN result carries no type — TYPE it
        // first so this backstop stays correct for a future non-string
        // centralized seeder too, not just comtrade's plain strings.
        const redisType = await rawCommand(shared, ['TYPE', key]);
        const type = redisType === 'none' ? null : redisType;
        const reader = type && READ_FOR_TYPE[type];
        if (!reader) {
          if (type) console.warn(`[sync-shared-results] full-reconcile: unknown type "${type}" for ${key} — skipping`);
          continue;
        }
        const value = await reader(shared, key);
        if (await mirrorIntoOrg(org, key, type, value)) bridged++;
      } catch (err) {
        console.warn(`[sync-shared-results] full-reconcile: failed for ${key}: ${err.message || err}`);
      }
    }
  }

  await rawCommand(org, ['SET', LAST_FULL_RECONCILE_KEY, String(Date.now()), 'EX', String(BOOKKEEPING_TTL_SECONDS)]).catch((err) => {
    console.warn(`[sync-shared-results] failed to persist full-reconcile timestamp (non-fatal): ${err.message}`);
  });
  return bridged;
}

/** SCAN a match pattern to completion. Upstash's cursor-based SCAN, not KEYS — safe against a large keyspace. */
async function scanKeys(creds, pattern) {
  const found = [];
  let cursor = '0';
  do {
    // eslint-disable-next-line no-await-in-loop -- SCAN is inherently sequential (each call needs the previous cursor)
    const [nextCursor, batch] = await rawCommand(creds, ['SCAN', cursor, 'MATCH', pattern, 'COUNT', '1000']);
    cursor = nextCursor;
    if (Array.isArray(batch)) found.push(...batch);
  } while (cursor !== '0');
  return found;
}

export async function main() {
  const shared = sharedCreds();
  if (!shared) {
    console.log('[sync-shared-results] DATA_SHARED_UPSTASH_REST_URL/READONLY_TOKEN not set — nothing to bridge (no-op)');
    return;
  }
  const org = getRedisCredentials(); // throws if this org's own creds are missing

  let incremental;
  try {
    incremental = await incrementalBridge(shared, org);
  } catch (err) {
    throw new Error(`incremental bridge failed — shared data-shared store unreachable or misconfigured: ${err.message || err}`);
  }

  const reconciled = await maybeFullReconcile(shared, org).catch((err) => {
    console.warn(`[sync-shared-results] full-reconcile pass failed (non-fatal — the incremental path already ran this tick): ${err.message}`);
    return 0;
  });

  console.log(`[sync-shared-results] bridged ${incremental} key(s) via changelog${reconciled > 0 ? `, ${reconciled} via full-reconcile backstop` : ''}`);
}

if (process.argv[1]?.endsWith('sync-shared-results.mjs')) {
  main().catch((err) => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}
