/**
 * config-store — the operator's local backend configuration, kept in
 * `~/.worldmonitor/config.db` (node:sqlite) and read by both this sidecar and
 * the `worldmonitor-local` CLI.
 *
 * WHY a separate db from `local-cache.db`: local-sync.mjs rebuilds the mirror
 * on every run and `fs.renameSync`s a fresh file over it, so any table living
 * there is destroyed each sync. Config has to persist independently — it sits
 * beside `session.json` / `local-api-token` in `~/.worldmonitor/`, which
 * nothing rewrites.
 *
 * WHY `process.env` stays the interface: ~600 reads of `process.env.<KEY>`
 * across the compiled `api/` route bundles (build output, also shared with the
 * cloud path) and the sidecar can't be rewritten to call an accessor. Instead
 * `loadConfigIntoEnv()` copies rows into `process.env`.
 *
 * TWO PRECEDENCE RULES, not one (PLATFORM_ARCHITECTURE.md Workstream 1):
 *
 *   - OPERATOR-SUPPLIED keys (the two public Supabase values from `org.env`,
 *     the per-operator LLM key): `.env` / a real env var WINS, and config.db is
 *     the fallback. This is the original rule and it still holds.
 *
 *   - BROKERED keys (the Upstash read-only URL + token, APP_DOMAIN — see
 *     BROKERED_CONFIG_KEYS): config.db WINS over `.env`. These are handed out
 *     by the per-org `local-config` edge function (P4) and re-fetched hourly so
 *     access can be withdrawn. If a stale `.env` from a v2.12/v2.13-era install
 *     could shadow them, a revoked operator would keep working forever off the
 *     credential baked into their old file — which would defeat the entire
 *     point of brokering. So the broker's copy is authoritative.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The per-operator LLM credential set (PLATFORM_ARCHITECTURE.md Workstream 3 /
 * OQ-P4). The ONLY data-source-style keys an operator supplies locally — the
 * other ~26 are org-admin-tier and live in the org's cloud (P3). Set from the
 * dashboard's LLM-key modal (`/api/local-llm-config`) or the CLI (`config set`),
 * loaded into `process.env` at sidecar startup like every other row, and read
 * by `server/_shared/llm.ts`'s `getProviderCredentials()` (which returns null →
 * provider skipped when a key is absent — that IS the OQ-P5 hard-disable).
 * `OLLAMA_MODEL` / `OLLAMA_API_URL` are not secrets (see SECRET_CONFIG_KEYS).
 */
export const OPERATOR_LLM_CONFIG_KEYS = Object.freeze([
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'OLLAMA_API_URL',
  'OLLAMA_MODEL',
]);

/**
 * The only keys the store will accept or surface. Everything else is skipped
 * on import and rejected by setConfig(). Deliberately tight — see
 * scripts/release/SECURITY.md. Mirrors the installer's org.env allow-list.
 */
export const CONFIG_KEYS = Object.freeze([
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_READONLY_TOKEN',
  'APP_DOMAIN',
  ...OPERATOR_LLM_CONFIG_KEYS,
]);

/**
 * The subset of CONFIG_KEYS handed out by the per-org `local-config` edge
 * function rather than typed in by the operator (P4). These are the keys whose
 * cached copy OUTRANKS `.env` — see the precedence note in the file header —
 * and the ones `clearBrokeredConfig()` drops on sign-out or a 403.
 *
 * Deliberately NOT including the two `VITE_SUPABASE_*` values: those are the
 * irreducible bootstrap (P11) that the backend needs BEFORE it can authenticate
 * to ask for anything, so they can only ever come from `org.env` / the operator.
 */
export const BROKERED_CONFIG_KEYS = Object.freeze([
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_READONLY_TOKEN',
  'APP_DOMAIN',
]);

/**
 * Brokered keys that are captured at MODULE LOAD by the sidecar rather than
 * read per-call — `local-api-server.mjs` builds SIDECAR_ALLOWED_ORIGINS and the
 * Upstash SSRF/CSP allowance from them once, at import. A refresh that changes
 * one of these needs a restart to take full effect; a refresh that changes only
 * the token does not, because `redis.ts` reads that from `process.env` on every
 * call. Used to decide whether a refresh warrants telling the operator.
 */
export const RESTART_REQUIRED_CONFIG_KEYS = Object.freeze([
  'UPSTASH_REDIS_REST_URL',
  'APP_DOMAIN',
]);

/**
 * Keys whose value must never be echoed back (the CLI's `config list`) — only a
 * `set` / `unset` status. VITE_SUPABASE_URL and the publishable key are public
 * by design, so they can be shown verbatim. APP_DOMAIN is a hostname, not a
 * secret, so it is shown too.
 */
export const SECRET_CONFIG_KEYS = Object.freeze([
  'UPSTASH_REDIS_REST_READONLY_TOKEN',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  // OLLAMA_API_URL / OLLAMA_MODEL are a local endpoint + a model name, not
  // secrets — shown verbatim like APP_DOMAIN.
]);

const CONFIG_DDL = `
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

/**
 * Broker bookkeeping lives in its own `meta` table rather than as a reserved
 * `_broker_fetched_at` row in `config`, because `readAllConfig()` and
 * `loadConfigIntoEnv()` iterate `config` wholesale and treat every row as an
 * env var. A magic row there would have to be filtered out at each of those
 * sites (and at every future one), and a missed filter would quietly export
 * `_broker_fetched_at` into the process environment. A second table makes the
 * separation structural instead of conventional.
 */
const BROKER_FETCHED_AT_KEY = 'broker_fetched_at';

/** P4: re-fetch hourly, so withdrawing access propagates within the hour. */
export const BROKER_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/** `~/.worldmonitor/config.db`, or $LOCAL_CONFIG_DB_PATH (tests point this at a tmp file). */
export function getConfigDbPath() {
  return (
    process.env.LOCAL_CONFIG_DB_PATH
    || path.join(os.homedir(), '.worldmonitor', 'config.db')
  );
}

function openWritable() {
  const dbPath = getConfigDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec(CONFIG_DDL);
  return db;
}

/** Every stored row as a plain object. `{}` when the db or table is absent — a fresh install. */
export function readAllConfig() {
  let db;
  try {
    db = new DatabaseSync(getConfigDbPath(), { readOnly: true });
    const out = {};
    for (const { key, value } of db.prepare('SELECT key, value FROM config').all()) {
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  } finally {
    try { db?.close(); } catch { /* nothing opened */ }
  }
}

/**
 * Copy stored config into `env` for any allow-listed key it doesn't already
 * hold a non-empty value for. Returns the keys it filled (for a one-line
 * startup log). Never throws — a broken or absent db just means "nothing to
 * add". Also mirrors VITE_SUPABASE_URL → SUPABASE_URL, the same rule the
 * installer applies when writing `.env` (some `api/*.js` read the un-prefixed
 * name).
 */
export function loadConfigIntoEnv(env = process.env) {
  const stored = readAllConfig();
  const filled = [];
  for (const key of CONFIG_KEYS) {
    const v = stored[key];
    if (typeof v !== 'string' || v.length === 0) continue;
    // Brokered keys OVERWRITE whatever `.env` holds; operator-supplied keys
    // only fill a gap. See the two precedence rules in the file header — a
    // stale `.env` must never be able to shadow (and so outlive) a credential
    // the broker can withdraw.
    if (!BROKERED_CONFIG_KEYS.includes(key) && env[key]) continue;
    if (env[key] === v) continue; // already correct — don't report a no-op
    env[key] = v;
    filled.push(key);
  }
  if (!env.SUPABASE_URL && env.VITE_SUPABASE_URL) env.SUPABASE_URL = env.VITE_SUPABASE_URL;
  return filled;
}

/** Epoch ms of the last successful broker fetch, or 0 if it has never run. */
export function getBrokerFetchedAt() {
  let db;
  try {
    db = new DatabaseSync(getConfigDbPath(), { readOnly: true });
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(BROKER_FETCHED_AT_KEY);
    const n = Number(row?.value);
    return Number.isFinite(n) ? n : 0;
  } catch {
    // No db, or a config.db written before the meta table existed.
    return 0;
  } finally {
    try { db?.close(); } catch { /* nothing opened */ }
  }
}

/**
 * True when the cached broker response is missing or older than
 * `BROKER_REFRESH_INTERVAL_MS`. A clock that has jumped BACKWARDS (a fetch
 * stamped in the future) also counts as stale rather than pinning the cache as
 * fresh indefinitely.
 */
export function isBrokerCacheStale(now = Date.now(), ttlMs = BROKER_REFRESH_INTERVAL_MS) {
  const fetchedAt = getBrokerFetchedAt();
  if (!fetchedAt) return true;
  if (fetchedAt > now) return true;
  return now - fetchedAt >= ttlMs;
}

/**
 * Persist a broker response and stamp the fetch time. Only BROKERED_CONFIG_KEYS
 * are accepted; anything else in `values` is ignored rather than throwing, so a
 * future field added to the edge function's JSON can't break an older backend.
 *
 * Returns the brokered keys whose stored value actually CHANGED — the caller
 * uses that to decide whether a restart notice is warranted
 * (RESTART_REQUIRED_CONFIG_KEYS). An unchanged hourly refresh returns [].
 */
export function writeBrokeredConfig(values) {
  const before = readAllConfig();
  const changed = [];
  const db = openWritable();
  try {
    const upsert = db.prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    const now = Date.now();
    for (const key of BROKERED_CONFIG_KEYS) {
      const value = values?.[key];
      if (typeof value !== 'string' || value.length === 0) continue;
      if (before[key] !== value) changed.push(key);
      upsert.run(key, value, now);
    }
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(BROKER_FETCHED_AT_KEY, String(now));
  } finally {
    db.close();
  }
  return changed;
}

/**
 * Drop every brokered key and the fetch stamp — on sign-out, or when the broker
 * answers 401/403 (P4: "on SIGNED_OUT or a 401 from the broker, drop the
 * cache"). Operator-supplied keys are left alone: the operator must not have to
 * re-enter their org's Supabase URL just because their access lapsed.
 *
 * Also scrubs the values from `env`, since `process.env` is the interface every
 * api/ handler actually reads — leaving them there would keep a revoked token
 * live for the rest of the process's life.
 */
export function clearBrokeredConfig(env = process.env) {
  const db = openWritable();
  try {
    const del = db.prepare('DELETE FROM config WHERE key = ?');
    for (const key of BROKERED_CONFIG_KEYS) del.run(key);
    db.prepare('DELETE FROM meta WHERE key = ?').run(BROKER_FETCHED_AT_KEY);
  } finally {
    db.close();
  }
  for (const key of BROKERED_CONFIG_KEYS) delete env[key];
}

/** Upsert one allow-listed key. Throws on an unknown key or an empty value. */
export function setConfig(key, value) {
  if (!CONFIG_KEYS.includes(key)) throw new Error(`unknown config key: ${key}`);
  if (typeof value !== 'string' || value.length === 0) throw new Error(`empty value for ${key}`);
  const db = openWritable();
  try {
    db.prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, Date.now());
  } finally {
    db.close();
  }
}

/** Remove one key. A no-op if it wasn't set. */
export function deleteConfig(key) {
  const db = openWritable();
  try {
    db.prepare('DELETE FROM config WHERE key = ?').run(key);
  } finally {
    db.close();
  }
}

/**
 * Seed the store from dotenv-style text (`KEY=value` lines, `#` comments,
 * optional matching surrounding quotes). Only allow-listed keys with a
 * non-empty value are stored. Returns the keys it set. Used by the installer
 * to populate config.db from an `org.env` / `.env`.
 */
export function importFromEnvText(text) {
  const set = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2
      && (value[0] === '"' || value[0] === "'")
      && value[value.length - 1] === value[0]
    ) {
      value = value.slice(1, -1);
    }
    if (!CONFIG_KEYS.includes(key) || value.length === 0) continue;
    setConfig(key, value);
    set.push(key);
  }
  return set;
}
