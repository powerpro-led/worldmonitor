/**
 * Cloud org-admin connection for the Workstream 6 admin panel
 * (PLATFORM_ARCHITECTURE.md P5, corrected S59: Vercel-hosted `settings.html`,
 * not colocated with the worker).
 *
 * `settings.html` serves two audiences from one shared build: the Tauri
 * desktop app (its own per-operator secrets, via runtime-config.ts's
 * setSecretValue()) and a plain-browser org admin managing one org's ~26
 * data-source keys in that org's Supabase `pipeline_config` table. Nothing
 * per-org is baked into this build (Model B — VITE_SUPABASE_* unset), so
 * which org's project the admin is managing has to be resolved here, in
 * the browser, from a connection the admin types in once and this module
 * remembers in `localStorage`.
 *
 * Deliberately a SEPARATE Supabase client instance from
 * supabase-client.ts's getSupabaseClient() singleton — that singleton is
 * wired to the build-time/runtime-injected project (the dashboard's own
 * org, or none for the cloud web build), which is the wrong source for a
 * panel that must connect to whichever org's project its admin belongs to.
 * `settings.html` already loads as an independent page (its own
 * settings-main.ts bundle, own JS execution context), so a second client
 * here shares no runtime state with the dashboard singleton — zero risk to
 * it either way.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { RuntimeSecretKey } from './runtime-config';

const CONNECTION_URL_KEY = 'wm-admin-org-url';
const CONNECTION_PUBLISHABLE_KEY_KEY = 'wm-admin-org-key';

// Distinct from supabase-client.ts's default (unset) storage key so a
// signed-in admin session here never collides with a signed-in dashboard
// session in the same browser — even when both happen to point at the
// same Supabase project (e.g. an org's own admin also using the dashboard
// on tech.worldmonitor.app in the same profile).
const ADMIN_AUTH_STORAGE_KEY = 'wm-admin-auth';

export interface OrgConnection {
  url: string;
  key: string;
}

export function getStoredOrgConnection(): OrgConnection | null {
  try {
    const url = localStorage.getItem(CONNECTION_URL_KEY);
    const key = localStorage.getItem(CONNECTION_PUBLISHABLE_KEY_KEY);
    if (!url || !key) return null;
    return { url, key };
  } catch {
    return null;
  }
}

export function setStoredOrgConnection(url: string, key: string): void {
  localStorage.setItem(CONNECTION_URL_KEY, url.trim());
  localStorage.setItem(CONNECTION_PUBLISHABLE_KEY_KEY, key.trim());
  client = null; // force a fresh client against the newly stored connection
}

export function clearStoredOrgConnection(): void {
  localStorage.removeItem(CONNECTION_URL_KEY);
  localStorage.removeItem(CONNECTION_PUBLISHABLE_KEY_KEY);
  client = null;
}

// Pinned to the 'worldmonitor' schema generic, mirroring supabase-client.ts's
// own WorldmonitorClient type alias — every tenant project keeps this app's
// tables out of `public` (P15).
type AdminClient = SupabaseClient<any, 'worldmonitor'>;

let client: AdminClient | null = null;

/** Lazily builds (and caches) a client for the currently stored connection,
 * or null when no connection is stored yet. */
export function getAdminSupabaseClient(): AdminClient | null {
  if (client) return client;
  const conn = getStoredOrgConnection();
  if (!conn) return null;
  client = createClient(conn.url, conn.key, {
    db: { schema: 'worldmonitor' },
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: ADMIN_AUTH_STORAGE_KEY,
    },
  });
  return client;
}

/**
 * Native Supabase GitHub OAuth (a real browser redirect) — NOT
 * `github-identity-bridge`, which relays a GitHub token a VS Code session
 * already holds rather than originating a fresh browser consent screen
 * (confirmed by that bridge's own module doc — see auth-provider.ts). Each
 * org's Supabase project must have the native GitHub provider configured
 * (deploy/orgs/README.md's new-org runbook).
 */
export async function adminSignInWithGithub(): Promise<void> {
  const supabase = getAdminSupabaseClient();
  if (!supabase) {
    console.warn('[admin-org-connection] no org connection stored, cannot sign in');
    return;
  }
  const { error } = await supabase.auth.signInWithOAuth({ provider: 'github' });
  if (error) console.error('[admin-org-connection] adminSignInWithGithub failed:', error);
}

export async function isAdminSignedIn(): Promise<boolean> {
  const supabase = getAdminSupabaseClient();
  if (!supabase) return false;
  const { data } = await supabase.auth.getSession();
  return !!data.session;
}

/**
 * Client-side UX gate only — checks `app_metadata.wm_admin === true` on the
 * signed-in user, so the panel can show "access denied" instead of a
 * confusing empty/broken form. The REAL enforcement is Postgres RLS
 * (`worldmonitor.wm_is_admin()`, `supabase/migrations/20260904120000_pipeline_config.sql`)
 * — a bypassed client-side check still can't read or write
 * `pipeline_config` as a non-admin.
 */
export async function isCurrentUserAdmin(): Promise<boolean> {
  const supabase = getAdminSupabaseClient();
  if (!supabase) return false;
  const { data } = await supabase.auth.getUser();
  return data.user?.app_metadata?.wm_admin === true;
}

export async function adminSignOut(): Promise<void> {
  const supabase = getAdminSupabaseClient();
  if (!supabase) return;
  await supabase.auth.signOut();
}

/**
 * Reads which `pipeline_config` keys are already set — presence only,
 * never the value — for seeding the admin form's initial masked state.
 * Mirrors the desktop vault's own "presence-only, never plaintext back"
 * contract (`MASKED_SENTINEL`, runtime-config.ts's `loadDesktopSecrets()`):
 * an admin with real read access via RLS still never needs the plaintext
 * round-tripped into the DOM just to render "this key is set".
 */
export async function fetchPipelineConfigPresence(): Promise<Set<string>> {
  const supabase = getAdminSupabaseClient();
  if (!supabase) return new Set();
  const { data, error } = await supabase.from('pipeline_config').select('key');
  if (error) {
    console.error('[admin-org-connection] fetchPipelineConfigPresence failed:', error);
    return new Set();
  }
  return new Set((data ?? []).map((row: { key: string }) => row.key));
}

/**
 * Upserts (non-empty value) or deletes (empty value) one `pipeline_config`
 * row. Takes the client explicitly so it's directly unit-testable against
 * a fake client — no stored connection or localStorage required.
 */
export async function commitPipelineConfigValue(
  supabase: Pick<AdminClient, 'from'>,
  key: RuntimeSecretKey,
  value: string,
): Promise<void> {
  if (value) {
    const { error } = await supabase.from('pipeline_config').upsert({ key, value });
    if (error) throw error;
  } else {
    const { error } = await supabase.from('pipeline_config').delete().eq('key', key);
    if (error) throw error;
  }
}

/**
 * Convenience wrapper resolving the live admin client — the one
 * `settings-manager.ts`'s `commitVerifiedSecrets()` actually calls.
 */
export async function commitToPipelineConfig(key: RuntimeSecretKey, value: string): Promise<void> {
  const supabase = getAdminSupabaseClient();
  if (!supabase) {
    console.warn('[admin-org-connection] no org connection stored, cannot write pipeline_config');
    return;
  }
  await commitPipelineConfigValue(supabase, key, value);
}
