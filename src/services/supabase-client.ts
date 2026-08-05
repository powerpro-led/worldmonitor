/**
 * Supabase client singleton — replaces the Convex+Clerk stack for auth and
 * the Stage 1 tables (users/api_keys/mcp_pro_tokens).
 *
 * Scoped to the `worldmonitor` schema by default so callers never need to
 * repeat `.schema('worldmonitor')` — this project (`ixuezudybhjptisexgxx`)
 * is shared with the `platform` sibling repo, whose own tables live in
 * `public`; `worldmonitor` keeps this app's data isolated from that.
 *
 * Unlike clerk.ts, there's no heavy external UMD bundle to lazily inject —
 * `@supabase/supabase-js` ships as a normal (tree-shaken) dependency in our
 * own JS bundle, so this is a plain singleton, not a deferred-script-load
 * state machine.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function readEnv(key: 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_PUBLISHABLE_KEY'): string | undefined {
  try {
    return import.meta.env[key];
  } catch {
    return undefined;
  }
}

// Pinned to the 'worldmonitor' schema generic so the return type matches
// what `createClient(..., { db: { schema: 'worldmonitor' } } )` actually
// infers — defaulting to SupabaseClient's implicit 'public' schema generic
// here would make every `.from(...)` call site fight the type checker.
type WorldmonitorClient = SupabaseClient<any, 'worldmonitor'>;

let client: WorldmonitorClient | null = null;

/**
 * Returns the shared Supabase client, or null when the env vars aren't
 * configured (e.g. local dev without Supabase set up yet — mirrors clerk.ts's
 * `PUBLISHABLE_KEY` guard so the rest of the app degrades gracefully instead
 * of throwing).
 */
export function getSupabaseClient(): WorldmonitorClient | null {
  if (client) return client;
  const url = readEnv('VITE_SUPABASE_URL');
  const key = readEnv('VITE_SUPABASE_PUBLISHABLE_KEY');
  if (!url || !key) {
    console.warn('[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY not set, auth disabled');
    return null;
  }
  client = createClient(url, key, {
    db: { schema: 'worldmonitor' },
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}
