'use strict';

// Lazily-initialized service-role Supabase client singleton for Node cron
// scripts (CommonJS — `scripts/` runs under plain `node`, not the Vercel
// edge runtime, so this is a separate construction from
// `server/_shared/supabase-admin.ts`, which is edge-oriented ESM/TS and not
// directly `require()`-able from a `.cjs` file without a build step).
//
// Stage 2 of the Convex/Clerk -> Supabase migration: `worldmonitor.
// user_preferences` and `worldmonitor.followed_countries` moved off Convex.
// `scripts/lib/user-context.cjs` and `scripts/lib/followed-countries-fetch.cjs`
// used to reach them via the `/relay/*` Convex HTTP actions (RELAY_SHARED_SECRET);
// they now read Postgres directly through this client.

const { createClient } = require('@supabase/supabase-js');

let client = null;

/**
 * @returns {import('@supabase/supabase-js').SupabaseClient | null} the
 *   shared service-role client scoped to the `worldmonitor` schema, or null
 *   when SUPABASE_URL / the secret key are not configured.
 *
 *   Mirrors server/_shared/supabase-admin.ts: prefers the modern
 *   SUPABASE_SECRET_KEY (`sb_secret_...`) and falls back to the legacy
 *   SUPABASE_SERVICE_ROLE_KEY. Both authorize through the same `service_role`
 *   Postgres role, so BYPASSRLS behaviour is identical.
 */
function getSupabaseAdmin() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;
  client = createClient(url, serviceRoleKey, {
    db: { schema: 'worldmonitor' },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

module.exports = { getSupabaseAdmin };
