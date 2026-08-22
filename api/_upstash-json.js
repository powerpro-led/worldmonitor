import { unwrapEnvelope } from './_seed-envelope.js';

export async function readJsonFromUpstash(key, timeoutMs = 3_000) {
  // Local sidecar (Tauri desktop / local MCP endpoint, LOCAL_API_MODE=
  // tauri-sidecar): this module is otherwise raw-Upstash-only with zero
  // sidecar awareness — the one gap server/_shared/redis.ts already closed
  // for the RPC/gateway path (readCachedJson) but this MCP-only cache-read
  // path (api/mcp/dispatch.ts's executeTool, api/mcp/resources/index.ts,
  // api/mcp/registry/rpc-tools.ts's hybrid cache reads — all three import
  // THIS function directly) never got. Without this branch every MCP
  // cache-tool silently returns null/empty in sidecar mode (no Upstash
  // creds reach this process) instead of serving the local SQLite mirror.
  // Mirrors readCachedJson's sidecar branch exactly, including the
  // envelope-unwrap-on-hit contract.
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') {
    // Reads the mirror directly rather than importing
    // server/_shared/sidecar-cache. That import was a TypeScript path, and
    // this module is hand-written plain JS that the sidecar loads with node —
    // so it threw ERR_MODULE_NOT_FOUND and this branch never once served a
    // value. It only looks correct because esbuild inlines the TS into the
    // bundled api/{domain}/v1/[rpc].js handlers, where the same code works.
    // /api/gpsjam answered 503 with 326 KB of gpsjam data sitting in the
    // mirror. See readMirrorValues() below for the full note.
    const rows = readMirrorValues([key]);
    const raw = rows === null ? null : rows[0];
    if (raw == null) return null;
    // Parse + unwrap here (unlike redisPipeline, which owes callers the raw
    // string) to keep this function's documented envelope-unwrap-on-hit
    // contract. A value that will not parse is treated as a miss, matching
    // how the Upstash path below handles malformed JSON.
    try {
      return unwrapEnvelope(JSON.parse(raw)).data;
    } catch {
      return null;
    }
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) return null;

  const data = await resp.json();
  if (!data.result) return null;

  try {
    // Envelope-aware: contract-mode canonical keys are stored as {_seed, data}.
    // MCP tool outputs and RPC consumers must see the bare payload only.
    // unwrapEnvelope is a no-op on legacy bare-shape values and on seed-meta
    // keys (which remain top-level {fetchedAt, recordCount, ...}).
    return unwrapEnvelope(JSON.parse(data.result)).data;
  } catch {
    return null;
  }
}

/**
 * Raw GET on a Redis key. Returns the parsed JSON value (or bare
 * string for non-JSON) without applying seed-envelope unwrap. Use
 * this for caches whose stored shape is NOT `{_seed, data}` — e.g.
 * the per-user brief envelope `{version, issuedAt, data}` whose
 * outer frame must reach the consumer.
 *
 * Semantics:
 *   - Returns the parsed value on a hit.
 *   - Returns `null` ONLY on a genuine miss (Upstash replied 200 with
 *     no result field).
 *   - Throws on every other failure mode (missing credentials, HTTP
 *     non-2xx, timeout/abort, JSON parse failure). Callers MUST
 *     distinguish infrastructure failure from empty-state to avoid
 *     showing users "composing" / "expired" UX during an outage.
 *
 * @param {string} key
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<unknown | null>}
 */
export async function readRawJsonFromUpstash(key, timeoutMs = 3_000) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('readRawJsonFromUpstash: UPSTASH_REDIS_REST_URL/TOKEN not configured');
  }

  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    throw new Error(`readRawJsonFromUpstash: Upstash GET ${key} returned HTTP ${resp.status}`);
  }
  const data = await resp.json();
  if (data.result == null) return null; // genuine miss
  try {
    return JSON.parse(data.result);
  } catch (err) {
    throw new Error(
      `readRawJsonFromUpstash: JSON.parse failed for ${key}: ${(err instanceof Error ? err.message : String(err))}`,
    );
  }
}

/** Returns Redis credentials or null if not configured. */
export function getRedisCredentials() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

/**
 * Execute a batch of Redis commands via the Upstash pipeline endpoint.
 * Returns null on missing credentials, HTTP error, or timeout.
 * @param {Array<string[]>} commands - e.g. [['GET', 'key'], ['EXPIRE', 'key', '60']]
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<Array<{ result: unknown }> | null>}
 */
/**
 * Reads raw values straight out of the sidecar's SQLite mirror.
 *
 * Deliberately does NOT import server/_shared/sidecar-cache: this module is
 * hand-written plain JS that the sidecar loads directly with node, and that
 * path is a TypeScript file — `await import('../server/_shared/sidecar-cache')`
 * throws ERR_MODULE_NOT_FOUND here. It only appears to work elsewhere because
 * esbuild INLINES the TS into the bundled api/{domain}/v1/[rpc].js handlers.
 * So every top-level hand-written route (bootstrap, gpsjam, wm-session) had no
 * mirror access at all, and /api/bootstrap answered 503 in the VS Code
 * extension while a browser tab, which reaches real Redis, was fine.
 *
 * Returning the stored column verbatim is exactly right rather than a
 * shortcut: local-sync.mjs writes `value` as the raw JSON string, and
 * redisPipeline's contract is to hand callers raw Redis strings they parse
 * themselves. No decoding belongs here.
 *
 * node:sqlite via getBuiltinModule (not a static import) for the same reason
 * sidecar-cache does it: this module is transitively reachable from Edge
 * handlers, where a static Node-builtin reference risks bundler resolution
 * failures even though this branch only ever runs inside the local sidecar.
 *
 * @param {string[]} keys
 * @returns {(string|null)[]|null} raw values, or null if the mirror is unusable
 */
let _mirrorDb;
let _mirrorDbFailed = false;

function readMirrorValues(keys) {
  if (_mirrorDbFailed) return null;
  try {
    if (!_mirrorDb) {
      const dbPath = process.env.LOCAL_SQLITE_PATH;
      if (!dbPath) { _mirrorDbFailed = true; return null; }
      const sqlite = process.getBuiltinModule?.('node:sqlite');
      if (!sqlite) { _mirrorDbFailed = true; return null; }
      _mirrorDb = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    }
    const stmt = _mirrorDb.prepare('SELECT value FROM kv_cache WHERE key = ?');
    return keys.map((key) => {
      const row = stmt.get(key);
      return row && typeof row.value === 'string' ? row.value : null;
    });
  } catch {
    // One failure is enough — the file is opened once per process, so a bad
    // path or a schema mismatch will not fix itself on retry.
    _mirrorDbFailed = true;
    _mirrorDb = undefined;
    return null;
  }
}

export async function redisPipeline(commands, timeoutMs = 5_000) {
  // Sidecar: serve reads from the local SQLite mirror, exactly as
  // readCachedJson's branch above already does. Without this, every batched
  // read fails closed in the VS Code extension — there are no Redis creds in
  // this process, so getRedisCredentials() returns null and callers see the
  // pipeline as unavailable. /api/bootstrap was the visible casualty: its own
  // getCachedJsonBatch throws "Bootstrap Redis pipeline unavailable" on a
  // non-array result and answers 503, so the dashboard lost its whole
  // bootstrap snapshot while a browser tab (which reaches real Redis) was
  // fine. This function was simply the one read path in this module that
  // never got the branch its siblings have.
  //
  // WRITES are deliberately left alone: the mirror is read-only, so a pipeline
  // containing anything other than GET keeps returning null (the existing
  // "unavailable" signal) rather than reporting a write that did not happen.
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') {
    const isAllReads = Array.isArray(commands)
      && commands.length > 0
      && commands.every((c) => Array.isArray(c) && String(c[0]).toUpperCase() === 'GET');
    if (!isAllReads) return null;
    const rows = readMirrorValues(commands.map(([, key]) => String(key)));
    return rows === null ? null : rows.map((value) => ({ result: value }));
  }

  const creds = getRedisCredentials();
  if (!creds) return null;
  try {
    const resp = await fetch(`${creds.url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Write a JSON value to Redis with a TTL (SET + EXPIRE as pipeline).
 * @param {string} key
 * @param {unknown} value - will be JSON.stringify'd
 * @param {number} ttlSeconds
 * @returns {Promise<boolean>} true on success
 */
export async function setCachedData(key, value, ttlSeconds) {
  const results = await redisPipeline([
    ['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)],
  ]);
  return results !== null;
}
