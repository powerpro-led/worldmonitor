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
 * `loadConfigIntoEnv()` copies rows into `process.env` for any key not already
 * set by `node --env-file` or a real env var, so `.env` always wins and
 * `config.db` is the fallback the settings UI (Phase 2) writes.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  'OPENROUTER_API_KEY',
]);

/**
 * Keys whose value must never be echoed back (the settings UI's GET, the CLI's
 * `config list`) — only a `set` / `unset` status. VITE_SUPABASE_URL and the
 * publishable key are public by design, so they can be shown verbatim.
 */
export const SECRET_CONFIG_KEYS = Object.freeze([
  'UPSTASH_REDIS_REST_READONLY_TOKEN',
  'OPENROUTER_API_KEY',
]);

const CONFIG_DDL = `
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;

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
    if (env[key]) continue; // `node --env-file` / a real env var wins
    const v = stored[key];
    if (typeof v === 'string' && v.length > 0) {
      env[key] = v;
      filled.push(key);
    }
  }
  if (!env.SUPABASE_URL && env.VITE_SUPABASE_URL) env.SUPABASE_URL = env.VITE_SUPABASE_URL;
  return filled;
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
