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
}
