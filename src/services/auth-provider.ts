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
import { isDesktopRuntime } from './runtime';
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
  const start = (): void => {
    void initAuthProvider();
    installExternalSessionListener();
  };
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
  // A VS Code webview cannot navigate to an external URL at all —
  // confirmed the hard way: Location.prototype.assign/replace are
  // [LegacyUnforgeable] in Chromium (a spec-level restriction, not an
  // implementation gap), so intercepting the navigation AFTER calling
  // signInWithOAuth() below silently fails and the app still blanks the
  // page. The only reliable fix is to never attempt the real
  // browser-redirect flow at all when that global is present — hand off
  // to the VS Code extension host instead, which runs the actual
  // github-identity-bridge redirect chain itself and posts the resulting
  // session back in (see installExternalSessionListener() above and
  // vscode-extension/src/githubAuthBridge.ts). window.__wmVsCodeApi is
  // set by the extension's injected shim before the app bundle runs, and
  // only exists there — every other runtime (web, packaged Tauri) falls
  // through to the normal flow below unchanged.
  const vsCodeApi = (window as unknown as { __wmVsCodeApi?: { postMessage: (msg: unknown) => void } }).__wmVsCodeApi;
  if (vsCodeApi) {
    vsCodeApi.postMessage({ type: 'wm-github-signin' });
    return;
  }
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.warn('[auth-provider] Supabase not configured, cannot sign in');
    return;
  }
  const { error } = await supabase.auth.signInWithOAuth({ provider: 'github' });
  if (error) console.error('[auth-provider] signInWithGithub failed:', error);
}

/**
 * Applies a session obtained OUTSIDE this client's own OAuth flow — the VS
 * Code extension host runs the actual github-identity-bridge redirect chain
 * itself (a webview can't navigate to external URLs at all, which is
 * exactly why the normal signInWithGithub() above blanks the page there —
 * see vscode-extension/src/githubAuthBridge.ts) and posts the resulting
 * tokens back in. supabase-js's own setSession() handles establishing the
 * session/refresh cycle from a raw token pair — this is not a bespoke
 * session mechanism, just a different entry point into the same client.
 */
export async function applyExternalSession(accessToken: string, refreshToken: string): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.warn('[auth-provider] Supabase not configured, cannot apply external session');
    return;
  }
  const { error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
  if (error) console.error('[auth-provider] applyExternalSession failed:', error);
}

let externalSessionListenerInstalled = false;

/**
 * Desktop-runtime-only: listens for the VS Code extension host handing back
 * a session from the github-identity-bridge flow. A no-op everywhere else
 * (web, packaged Tauri without this message ever being sent) — nothing
 * posts this message type outside the VS Code webview's own injected shim.
 * Called from scheduleAuthProviderLoad()'s deferred start(), NOT at module
 * top-level — a real bug hit doing it eagerly: isDesktopRuntime() (imported
 * from ./runtime) got referenced before that module's own top-level
 * evaluation had finished in some load orders, a circular-import TDZ
 * ReferenceError ("Cannot access 'X' before initialization") that broke
 * the whole bundle's boot, not just this feature. Deferring past initial
 * module evaluation (same reasoning scheduleAuthProviderLoad already
 * applies to initAuthProvider itself) avoids it entirely.
 */
function installExternalSessionListener(): void {
  if (externalSessionListenerInstalled) return;
  externalSessionListenerInstalled = true;
  if (typeof window === 'undefined' || !isDesktopRuntime()) return;
  window.addEventListener('message', (event) => {
    const data = event.data as { type?: string; accessToken?: string; refreshToken?: string } | undefined;
    if (data?.type !== 'wm-external-session' || !data.accessToken || !data.refreshToken) return;
    void applyExternalSession(data.accessToken, data.refreshToken);
  });
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
