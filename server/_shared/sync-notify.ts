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
 * SYNC_PREFIXES below is a deliberate DUPLICATE of
 * scripts/shared/sync-domains.mjs's list, not a cross-import — that file
 * lives in a separate, unbundled Node-script module graph this Edge-bundled
 * file has no existing path into. Keep both in sync by hand; a prefix added
 * to one without the other silently breaks either the full rescan/seed-side
 * push (that file) or the RPC-handler push (this file) for that domain.
 */

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
  'theater-posture:',
  'theater_posture:',
  'summary:',
  'classify:',
  'trade:',
  'comtrade:',
  'conflict:',
  'unrest:',
  'displacement:',
  'military:',
  'usni-fleet:',
  'patents:',
  'cyber:',
  'natural:',
  'seismology:',
  'radiation:',
  'thermal:',
  'weather:',
  'aviation:',
  'infra:',
  'bls:',
  'insider:',
  'regulatory:',
  'correlation:',
  'research:',
  'news:',
  'intel:',
  'prediction:',
  'positive-events:',
  'positive_events:',
  'brief:',
];

// Narrow exclusion within the broader `forecast:` prefix — see
// scripts/shared/sync-domains.mjs's MIRROR_EXCLUDED_PREFIXES (this file's
// write-side twin) for the full story: forecast:simulation-task* is internal
// worker-queue bookkeeping, not display data. Keep both lists in sync.
const MIRROR_EXCLUDED_PREFIXES = ['forecast:simulation-task'];

function isMirroredKey(key: string): boolean {
  if (MIRROR_EXCLUDED_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;
  return SYNC_PREFIXES.some((prefix) => key.startsWith(prefix));
}

const SYNC_NOTIFY_CHANNEL = 'sync:notify';
const SYNC_CHANGELOG_STREAM = 'sync:changelog';
const SYNC_NOTIFY_MAX_INLINE_BYTES = 16 * 1024;
const SYNC_NOTIFY_TIMEOUT_MS = 3_000;

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
 */
export function notifyKeyChanged(
  url: string,
  token: string,
  key: string,
  type: MirrorValueType,
  serializedValue?: string,
): void {
  if (!isMirroredKey(key)) return;
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
    body: JSON.stringify(['XADD', SYNC_CHANGELOG_STREAM, '*', 'key', key, 'type', type]),
    signal: AbortSignal.timeout(SYNC_NOTIFY_TIMEOUT_MS),
  });

  Promise.all([publish, changelog]).catch((err) => {
    console.warn(`[sync-notify] ${key}: best-effort push failed (non-fatal):`, err instanceof Error ? err.message : String(err));
  });
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
 */
export function notifyPipelineWrites(url: string, token: string, commands: unknown[][]): void {
  for (const command of commands) {
    const verb = typeof command[0] === 'string' ? command[0].toUpperCase() : '';
    const type = MIRRORABLE_WRITE_VERBS[verb];
    const key = command[1];
    if (type && typeof key === 'string') notifyKeyChanged(url, token, key, type);
  }
}
