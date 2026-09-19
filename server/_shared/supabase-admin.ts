/**
 * Lazily-initialized service-role Supabase client singleton.
 *
 * Single place that constructs the service-role client used by every
 * already-migrated Postgres-backed domain (user preferences, followed
 * countries, notification channels, alert rules, telegram pairing) —
 * service_role bypasses RLS by default in Supabase, which is required here
 * since several of these are cross-user lookups, not requests scoped to the
 * querying user's own row.
 *
 * Edge-runtime safe: `@supabase/supabase-js` is fetch-based (no Node-only
 * APIs), so this is safe to import from Vercel edge functions the same way
 * the rest of server/_shared is.
 *
 * Requires SUPABASE_URL + a secret key. Both are server-only secrets --
 * never prefix with VITE_ / expose to the browser.
 *
 * Key naming: Supabase replaced the legacy JWT-based `anon`/`service_role`
 * keys with `sb_publishable_...` / `sb_secret_...`, which rotate independently
 * instead of being derived from the project JWT secret. A secret key
 * authorizes through the same built-in `service_role` Postgres role and keeps
 * its `BYPASSRLS` attribute, so the cross-user lookups described above still
 * work unchanged. It is a drop-in for createClient's second argument.
 * SUPABASE_SECRET_KEY is preferred; SUPABASE_SERVICE_ROLE_KEY is still read as
 * a fallback so an unmigrated environment keeps working (the legacy keys are
 * supported until the end of 2026).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Pinned to the 'worldmonitor' db schema (see `db: { schema: 'worldmonitor' }`
// below) -- the default `SupabaseClient` generic assumes 'public', which
// createClient's return type no longer structurally matches once a non-default
// schema is passed.
type WorldMonitorSupabaseClient = SupabaseClient<any, 'worldmonitor'>;

let _client: WorldMonitorSupabaseClient | null = null;
let _didWarnMissingConfig = false;

/**
 * Returns the shared service-role Supabase client scoped to the
 * `worldmonitor` schema, or null when SUPABASE_URL / the secret key are not
 * configured. Callers must treat null as "backend unconfigured" and
 * fail closed/soft per their own contract -- this module does not decide
 * that policy.
 */
export function getSupabaseAdmin(): WorldMonitorSupabaseClient | null {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  // Prefer the modern secret key; fall back to the legacy service_role key.
  const serviceRoleKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    if (!_didWarnMissingConfig) {
      _didWarnMissingConfig = true;
      console.warn(
        '[supabase-admin] SUPABASE_URL or SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) not set; Postgres-backed lookups disabled',
      );
    }
    return null;
  }

  _client = createClient(url, serviceRoleKey, {
    db: { schema: 'worldmonitor' },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

// ---------- Request-scoped user client (local bundle) ----------
//
// The downloadable local bundle deliberately ships NO service-role key
// (scripts/release/SECURITY.md), so getSupabaseAdmin() is null on every
// operator machine and every account-features route 503'd there (found by
// the first real Windows operator, 2026-09-19, as "Failed to load
// notification settings"). Those routes only ever touch the caller's own
// rows, and migration 20260919120000 activated the own-row RLS policies for
// `authenticated` — so a client built from the PUBLIC publishable key plus
// the request's own bearer JWT is enough: PostgREST verifies the JWT and RLS
// confines it to `user_id = auth.uid()`. Nothing shared, nothing secret.
//
// The JWT is made available ambiently (AsyncLocalStorage, same defensive
// pattern as server/_shared/usage.ts) so the five data modules keep their
// `(userId, ...)` signatures — the api/* handler that validated the bearer
// wraps its work in runAsUser(). Outside such a scope, or wherever a
// service-role key IS configured (the cloud deploy), behaviour is unchanged.

type ALSLike<T> = {
  run: <R>(store: T, fn: () => R) => R;
  getStore: () => T | undefined;
};

let userTokenStore: ALSLike<string> | null = null;
let userTokenStoreInit: Promise<ALSLike<string> | null> | null = null;

function getUserTokenStore(): Promise<ALSLike<string> | null> {
  if (userTokenStore) return Promise.resolve(userTokenStore);
  if (!userTokenStoreInit) {
    userTokenStoreInit = import('node:async_hooks')
      .then((mod) => { userTokenStore = new mod.AsyncLocalStorage<string>(); return userTokenStore; })
      .catch(() => null);
  }
  return userTokenStoreInit;
}

/** Run `fn` with `accessToken` as the ambient end-user JWT (see above). */
export async function runAsUser<R>(accessToken: string, fn: () => R | Promise<R>): Promise<R> {
  const store = await getUserTokenStore();
  if (!store) return fn();
  return store.run(accessToken, fn) as R | Promise<R>;
}

// One client per distinct JWT while it is in use; bounded so a long-lived
// local backend can't grow it without limit (a JWT lives ~1h anyway).
const USER_CLIENT_CACHE_MAX = 32;
const userClients = new Map<string, WorldMonitorSupabaseClient>();

function getSupabaseForUser(accessToken: string): WorldMonitorSupabaseClient | null {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) return null;
  const cached = userClients.get(accessToken);
  if (cached) return cached;
  const client: WorldMonitorSupabaseClient = createClient(url, publishableKey, {
    db: { schema: 'worldmonitor' },
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  if (userClients.size >= USER_CLIENT_CACHE_MAX) {
    const oldest = userClients.keys().next().value;
    if (oldest !== undefined) userClients.delete(oldest);
  }
  userClients.set(accessToken, client);
  return client;
}

/**
 * The client an account-features module should use for THIS request:
 * the service-role client when one is configured (cloud deploy — cross-user
 * paths like the Telegram bot's token consume need it), otherwise the
 * caller's own RLS-scoped client when a bearer JWT is in scope (local
 * bundle), otherwise null — "backend unconfigured", exactly as
 * getSupabaseAdmin() alone used to report.
 */
export function getSupabaseForRequest(): WorldMonitorSupabaseClient | null {
  const admin = getSupabaseAdmin();
  if (admin) return admin;
  const token = userTokenStore?.getStore();
  if (!token) return null;
  return getSupabaseForUser(token);
}

/**
 * Test-only reset of the memoized client singleton. Without this, a test
 * that successfully creates a client (valid SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY)
 * permanently poisons every later test in the same process against exercising
 * the "backend unconfigured" branch, since `_client` stays cached regardless
 * of later env changes. Mirrors the `__reset*ForTests` pattern already used
 * by server/_shared/redis.ts and server/_shared/rate-limit.ts.
 */
export function __resetSupabaseAdminForTests(): void {
  _client = null;
  _didWarnMissingConfig = false;
  userClients.clear();
}
