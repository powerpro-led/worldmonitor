/**
 * Local operator real-time sync — fast-path push, RPC-handler WRITE side.
 *
 * TypeScript twin of scripts/_seed-utils.mjs's notifyChange(). After a real
 * write to a mirrored key lands (setCachedJson / runRedisPipeline in
 * ./redis.ts), best-effort PUBLISH the new value to every operator's sidecar
 * listener and XADD a small pointer to a changelog stream so a sidecar that
 * was offline/asleep can cheaply catch up on exactly what it missed instead
 * of re-scanning everything. See scripts/_seed-utils.mjs's own comment on
 * notifyChange() for the full design and the "never awaited, never thrown"
 * contract this mirrors exactly.
 *
 * This file is transitively reachable from api/*.ts Vercel Edge handlers
 * (same reasoning as server/_shared/sidecar-cache.ts's own header comment) —
 * no Node-only builtins (Buffer, node:*). Byte-length uses TextEncoder
 * (Web-standard, available on Edge) instead of Buffer.byteLength.
 *
 * isMirroredKey() is imported from scripts/shared/sync-domains.mjs rather
 * than duplicated — an earlier version of this file hand-copied the whole
 * allowlist here on the (incorrect) claim that this Edge-bundled file "has
 * no existing path into scripts/". That was wrong: server/_shared/llm.ts and
 * server/_shared/simulation-queue.ts already cross-import from scripts/ the
 * same way (simulation-queue.ts's own header: "esbuild bundles the shim's
 * contents inline at Vercel build time, so the cross-directory import is
 * fine on the server side") — same pattern used here. A hand-duplicated copy
 * had already drifted once in this file's short lifetime (the
 * forecast:simulation-task* exclusion had to be added to both files by
 * hand); importing the one real definition removes that whole risk class
 * instead of just detecting it after the fact.
 */

import { isMirroredKey } from '../../scripts/shared/sync-domains.mjs';

const SYNC_NOTIFY_CHANNEL = 'sync:notify';
const SYNC_CHANGELOG_STREAM = 'sync:changelog';
const SYNC_NOTIFY_MAX_INLINE_BYTES = 16 * 1024;
const SYNC_NOTIFY_TIMEOUT_MS = 3_000;
// Keep in sync with scripts/_seed-utils.mjs's SYNC_CHANGELOG_MAXLEN — see
// that constant's own comment for why an approximate cap is needed here at
// all (without it the stream grows forever, exactly the unbounded-cost
// shape this feature exists to avoid).
const SYNC_CHANGELOG_MAXLEN = 10_000;

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Redis type carried in the notify message, matching local-sync.mjs's kv_cache.type column. */
export type MirrorValueType = 'string' | 'zset' | 'hash' | 'set' | 'list';

/**
 * Fire-and-forget. Callers must NOT await this — see this file's header
 * comment. `serializedValue` is optional: writers that only know a key
 * changed (e.g. a ZADD inside runRedisPipeline) omit it and the listener
 * does one targeted read for that key instead of getting the value inline.
 *
 * Returns the settled-or-swallowed promise for the two in-flight requests
 * (or `null` when the key isn't mirrored and nothing was dispatched). The
 * caller does NOT await it, but MAY hand it to `ctx.waitUntil()` so a Vercel
 * Edge isolate doesn't tear down before the PUBLISH/XADD reach Upstash —
 * without that, the RPC-side push is dropped some fraction of the time in
 * production, degrading to the 6h reconciliation backstop (session 39's
 * 7-pass review, deferred finding #1). The promise never rejects.
 */
export function notifyKeyChanged(
  url: string,
  token: string,
  key: string,
  type: MirrorValueType,
  serializedValue?: string,
): Promise<void> | null {
  if (!isMirroredKey(key)) return null;
  const inline = serializedValue !== undefined && utf8ByteLength(serializedValue) <= SYNC_NOTIFY_MAX_INLINE_BYTES;
  const message = JSON.stringify(inline ? { key, type, value: serializedValue } : { key, type });

  const publish = fetch(`${url}/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['PUBLISH', SYNC_NOTIFY_CHANNEL, message]),
    signal: AbortSignal.timeout(SYNC_NOTIFY_TIMEOUT_MS),
  });
  // 'type' included so a reconnecting listener's catch-up pass (XRANGE from
  // its last cursor) knows which read command to issue for each key (GET vs
  // ZRANGE vs HGETALL vs ...) without an extra TYPE round-trip.
  const changelog = fetch(`${url}/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['XADD', SYNC_CHANGELOG_STREAM, 'MAXLEN', '~', String(SYNC_CHANGELOG_MAXLEN), '*', 'key', key, 'type', type]),
    signal: AbortSignal.timeout(SYNC_NOTIFY_TIMEOUT_MS),
  });

  return Promise.all([publish, changelog]).then(
    () => {},
    (err) => {
      console.warn(`[sync-notify] ${key}: best-effort push failed (non-fatal):`, err instanceof Error ? err.message : String(err));
    },
  );
}

/** Redis write-command verbs this notify path understands, mapped to their mirror type. */
const MIRRORABLE_WRITE_VERBS: Record<string, MirrorValueType> = {
  SET: 'string',
  ZADD: 'zset',
  HSET: 'hash',
  SADD: 'set',
  LPUSH: 'list',
  RPUSH: 'list',
};

/**
 * Scans a batch of raw Redis commands (as passed to runRedisPipeline) for
 * writes to mirrored keys and fires a best-effort notify for each. Pipeline
 * writes (ZADD/HSET/...) don't carry a convenient "new full value" the way a
 * plain SET does, so these always notify signal-only (no inline value) —
 * cheaper to compute correctly than reconstructing the post-write value from
 * a partial command (e.g. one ZADD member among many), and the listener's
 * targeted follow-up read is still far cheaper than a full rescan.
 *
 * Never throws (each notifyKeyChanged builds its own promise chain and the
 * loop does no work that can fail). Returns a single promise covering every
 * dispatched notify, or `null` when the batch had no mirrored write — the
 * caller may pass it to `ctx.waitUntil()` (see notifyKeyChanged's contract).
 */
export function notifyPipelineWrites(url: string, token: string, commands: unknown[][]): Promise<void> | null {
  const pending: Promise<void>[] = [];
  for (const command of commands) {
    const verb = typeof command[0] === 'string' ? command[0].toUpperCase() : '';
    const type = MIRRORABLE_WRITE_VERBS[verb];
    const key = command[1];
    if (type && typeof key === 'string') {
      const p = notifyKeyChanged(url, token, key, type);
      if (p) pending.push(p);
    }
  }
  return pending.length > 0 ? Promise.all(pending).then(() => {}) : null;
}
