/**
 * Supabase Auth wrapper — replaces src/services/clerk.ts.
 *
 * GitHub-only sign-in (no email/password, no other OAuth providers) per the
 * Stage 1 Supabase-migration decision: this is internal tooling for one
 * operator/org, not public SaaS. Sign-up itself is additionally gated
 * server-side by the `worldmonitor-org-gate` Supabase Auth Hook (a
 * before-user-created hook checking GitHub org membership) — a successful
 * `signInWithOAuth` call here does NOT guarantee the session actually gets
 * created; callers must handle the "GitHub auth succeeded but org gate
 * rejected it" case (see `subscribeAuthProvider` / auth-state.ts).
 *
 * Unlike Clerk, Supabase has no hosted sign-in modal or UserButton component
 * — `signInWithGithub()` is a single OAuth trigger (real browser redirect,
 * not a popup), and there is no `mountUserButton` equivalent; UI components
 * build their own avatar/sign-out affordance from `getCurrentAuthUser()`.
 *
 * No tiers post-billing-cut: `getCurrentAuthUser().plan` is always `'pro'`
 * once signed in (and thus already org-gated) — see src/services/entitlements.ts.
 */
import { getSupabaseClient } from './supabase-client';
import type { Session } from '@supabase/supabase-js';

export interface AuthProviderUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  plan: 'free' | 'pro';
}

let currentSession: Session | null = null;
let initPromise: Promise<void> | null = null;
let initialized = false;
const subscribers = new Set<() => void>();

function notifySubscribers(): void {
  for (const cb of subscribers) cb();
}

/**
 * Initialize the auth provider: fetch any existing session and start
 * listening for changes. Idempotent — safe to call from multiple boot paths.
 */
export async function initAuthProvider(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      initialized = true;
      return;
    }
    const { data } = await supabase.auth.getSession();
    currentSession = data.session;
    initialized = true;
    notifySubscribers();
    supabase.auth.onAuthStateChange((_event, session) => {
      currentSession = session;
      notifySubscribers();
    });
  })();
  return initPromise;
}

/**
 * Schedule auth-provider init off the critical path. Unlike clerk.ts's
 * scheduleClerkLoad(), there's no ~3 MB external bundle to defer —
 * `@supabase/supabase-js` ships in our own JS bundle — but boot-sequence
 * timing (App.ts calls this before other UI subscribes) is preserved so the
 * initial getSession() round-trip doesn't block first paint.
 */
export function scheduleAuthProviderLoad(): void {
  if (initPromise) return;
  const start = (): void => { void initAuthProvider(); };
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof ric === 'function') {
    ric(start, { timeout: 4000 });
  } else if (document.readyState === 'complete') {
    setTimeout(start, 0);
  } else {
    window.addEventListener('load', () => setTimeout(start, 0), { once: true });
  }
}

/** Trigger GitHub OAuth sign-in. Real browser redirect, not a modal. */
export async function signInWithGithub(): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.warn('[auth-provider] Supabase not configured, cannot sign in');
    return;
  }
  const { error } = await supabase.auth.signInWithOAuth({ provider: 'github' });
  if (error) console.error('[auth-provider] signInWithGithub failed:', error);
}

/** Sign out the current user. */
export async function signOut(): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;
  await supabase.auth.signOut();
  currentSession = null;
  notifySubscribers();
}

/**
 * Get a bearer token for API requests. Supabase's client auto-refreshes
 * internally (unlike Clerk's 50s manual cache in the old clerk.ts) — this
 * always re-reads getSession() rather than caching, since supabase-js's own
 * in-memory session is already the cache.
 */
export async function getAuthToken(): Promise<string | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  currentSession = data.session;
  return data.session?.access_token ?? null;
}

/**
 * No-op — kept so callers that previously called clearClerkTokenCache() on
 * a 401 (e.g. convex-client.ts, wm-session.ts) don't need a conditional.
 * supabase-js manages its own token cache/refresh; there's nothing separate
 * to invalidate here.
 */
export function clearAuthTokenCache(): void {
  /* intentionally empty */
}

/** Get current user metadata, projected into the shape prior Clerk consumers expect. */
export function getCurrentAuthUser(): AuthProviderUser | null {
  const user = currentSession?.user;
  if (!user) return null;
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const name =
    (meta.user_name as string) ||
    (meta.preferred_username as string) ||
    (meta.full_name as string) ||
    (meta.name as string) ||
    'User';
  return {
    id: user.id,
    name,
    email: user.email ?? '',
    image: (meta.avatar_url as string) ?? null,
    // No tiers post-billing-cut: reaching a real session at all already
    // implies the org gate passed, so every signed-in user is 'pro'.
    plan: 'pro',
  };
}

/** Epoch ms of account creation, or null when signed out. */
export function getAuthUserCreatedAt(): number | null {
  const createdAt = currentSession?.user?.created_at;
  if (!createdAt) return null;
  const ms = new Date(createdAt).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Subscribe to auth state changes. Returns an unsubscribe function.
 * Fires once immediately if already initialized, mirroring clerk.ts's
 * "cookie-backed session becomes visible without refresh" behavior for
 * subscribers that attach after init already completed.
 */
export function subscribeAuthProvider(callback: () => void): () => void {
  subscribers.add(callback);
  if (initialized) callback();
  return () => { subscribers.delete(callback); };
}
