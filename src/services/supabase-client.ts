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
  // Runtime config wins over build-time env. The downloadable local bundle
  // (Model B) ships a `dist/` built with VITE_SUPABASE_* UNSET so no org's
  // project is baked into the JS; the standalone backend injects
  // `window.__WM_RUNTIME_CONFIG = { supabaseUrl, supabaseKey }` into the HTML
  // it serves, from its own .env. The cloud web app has no such injection, so
  // import.meta.env stays the fallback and its behaviour is unchanged.
  try {
    const rc = (globalThis as { __WM_RUNTIME_CONFIG?: Record<string, string> }).__WM_RUNTIME_CONFIG;
    const runtimeVal = key === 'VITE_SUPABASE_URL' ? rc?.supabaseUrl : rc?.supabaseKey;
    if (typeof runtimeVal === 'string' && runtimeVal.length > 0) return runtimeVal;
  } catch {
    /* no runtime config — fall through to build-time env */
  }
  try {
    return import.meta.env[key];
  } catch {
    return undefined;
  }
}

/**
 * The configured Supabase project URL (runtime config → build-time env), or
 * undefined when unset. Exported so callers that must derive a project-scoped
 * URL — e.g. the github-identity-bridge Edge Function endpoint in
 * auth-provider.ts — never hardcode the project ref, which would defeat Model
 * B's org-neutral `dist/` (see readEnv()'s comment above).
 */
export function getSupabaseUrl(): string | undefined {
  return readEnv('VITE_SUPABASE_URL');
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
