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
    currentSession = data.session ?? (await adoptOperatorSessionIfPresent(supabase));
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
 * VS-Code-embed-only: when the operator has already signed in via
 * `worldmonitor-local login`, the standalone backend holds their Supabase
 * session at ~/.worldmonitor/session.json and serves it from the
 * loopback-token-gated /api/operator-session. Adopt it here so the dashboard
 * doesn't ask them to sign in a second time in-page. Any failure (not
 * embedded, not logged in → 204, dead refresh token, network) falls through
 * to null and the normal in-page GitHub button still works.
 *
 * setSession() refreshes the tokens itself if the stored access_token has
 * expired, and supabase-js then persists the fresh session to this iframe's
 * own localStorage — so this only needs to run once per iframe lifetime, and
 * session.json going stale later doesn't matter to an already-booted tab.
 */
async function adoptOperatorSessionIfPresent(
  supabase: NonNullable<ReturnType<typeof getSupabaseClient>>,
): Promise<Session | null> {
  if (typeof window === 'undefined') return null;
  if (!(window as unknown as { __wmVsCodeApi?: unknown }).__wmVsCodeApi) return null;
  try {
    const resp = await fetch('/api/operator-session');
    if (resp.status === 204 || !resp.ok) return null;
    const body = (await resp.json()) as { access_token?: string; refresh_token?: string };
    if (!body.access_token || !body.refresh_token) return null;
    const { data, error } = await supabase.auth.setSession({
      access_token: body.access_token,
      refresh_token: body.refresh_token,
    });
    if (error) {
      console.warn('[auth-provider] operator session adoption failed:', error.message);
      return null;
    }
    return data.session;
  } catch (err) {
    console.warn('[auth-provider] operator session adoption errored:', err);
    return null;
  }
}

/**
 * True when the current URL looks like a return leg from an OAuth provider.
 *
 * Covers BOTH Supabase flows on purpose. This app currently runs implicit
 * flow (supabase-client.ts leaves @supabase/auth-js's `flowType` at its
 * 'implicit' default), which returns `#access_token=...` in the fragment;
 * PKCE returns `?code=...` in the query string. Checking both means
 * switching flowType later can't silently reintroduce the race this guards.
 */
function hasPendingOAuthResponse(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (hash.has('access_token') || hash.has('error') || hash.has('error_description')) return true;
    const query = new URLSearchParams(window.location.search);
    return query.has('code') || query.has('error') || query.has('error_description');
  } catch {
    return false;
  }
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
    installVsCodeGithubTokenListener();
  };
  // An in-flight OAuth response lives in the URL and nowhere else until
  // detectSessionInUrl consumes it, so deferring init by up to 4s leaves a
  // 4s window in which anything touching history.replaceState() destroys the
  // sign-in. That is not hypothetical: event-handlers.ts's debounced URL
  // auto-sync (250ms, fires on plain page load) silently killed every GitHub
  // sign-in until 2026-08-19 — twice, once for the query string and again
  // for the fragment. Init immediately on the OAuth return leg so the
  // session no longer depends on every current and future URL writer
  // remembering to preserve parts of the URL it doesn't own. Costs nothing
  // on a normal boot: this branch is only taken coming back from the
  // provider.
  if (hasPendingOAuthResponse()) {
    start();
    return;
  }
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
  // window.__wmVsCodeApi only exists when this document is loaded inside
  // the VS Code extension's dashboard iframe (?embed=vscode — set by
  // local-api-server.mjs's embed shim). This document IS an ordinary
  // nested <iframe> there, not the webview's own top-level document, so a
  // plain signInWithOAuth() below would likely navigate just fine even in
  // that context (the [LegacyUnforgeable] restriction on
  // window.location.assign() that broke a prior, superseded architecture
  // only applies to a webview's own top-level document). This branch
  // exists for better UX, not to work around a technical block: it hands
  // off to vscode-extension/src/panel.ts, which reuses the GitHub session
  // VS Code already holds (vscode.authentication.getSession) instead of
  // making the user click through a manual GitHub consent screen — see
  // installVsCodeGithubTokenListener() below for how that token comes back
  // and completes a real Supabase session. Every other runtime (web,
  // packaged Tauri, a plain non-embedded load) falls through to the normal
  // flow below unchanged.
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

/** Issuer for this fork's own already-deployed github-identity-bridge
 * Supabase Edge Function — a minimal custom OIDC provider that bridges a
 * GitHub access token into a real Supabase session (see
 * installVsCodeGithubTokenListener() below for the full contract). Already
 * live and registered as the `custom:github-bridge` provider on this
 * fork's own Supabase project (VITE_SUPABASE_URL) — nothing new to deploy. */
const GITHUB_IDENTITY_BRIDGE_ISSUER = 'https://ixuezudybhjptisexgxx.supabase.co/functions/v1/github-identity-bridge';

let vsCodeGithubTokenListenerInstalled = false;

/**
 * VS-Code-extension-only entry point for GitHub sign-in. Mirrors the
 * already-proven client contract from the sibling `platform` repo's
 * `/auth/vscode-bridge` route
 * (platform/docs/plans/2026-07-31-github-identity-bridge.md) — reusing a
 * pattern that's already been tested end-to-end elsewhere, not inventing a
 * new one. One deliberate difference from that route: platform's version
 * reads the token off `location.hash` on a fresh top-level page load: a
 * genuine first navigation. This document is instead an already-loaded
 * iframe that the VS Code extension hands a token to WITHOUT reloading it
 * (see panel.ts's render()) — a URL differing only by its fragment from
 * the one already loaded is a same-document, no-reload navigation, so a
 * hash-scanning approach here would silently never fire (found the hard
 * way during live testing: VS Code's own GitHub consent completed fine,
 * but no Supabase session ever followed). A postMessage listener sidesteps
 * that entirely — no navigation/reload semantics involved.
 *
 * Installed once from scheduleAuthProviderLoad()'s deferred start(),
 * below. No isDesktopRuntime() gate needed (unlike the code this
 * replaces) — self-gating by construction: nothing ever posts this
 * message type except panel.ts's own relay script, which only exists
 * inside the VS Code webview's wrapper document.
 *
 * Supersedes and replaces applyExternalSession() /
 * installExternalSessionListener() / the wm-external-session postMessage
 * contract, which were dead code under this architecture — those were
 * gated on isDesktopRuntime(), which is false by design for the plain-web
 * build the sidecar serves (see the VS Code extension plan's architecture
 * notes).
 */
function installVsCodeGithubTokenListener(): void {
  if (vsCodeGithubTokenListenerInstalled) return;
  vsCodeGithubTokenListenerInstalled = true;
  if (typeof window === 'undefined') return;
  window.addEventListener('message', (event) => {
    const data = event.data as { type?: string; token?: string } | undefined;
    if (data?.type !== 'wm-vscode-github-token' || !data.token) return;
    void completeVsCodeGithubSignIn(data.token);
  });
}

/**
 * Mints a short-lived ticket against the already-deployed
 * github-identity-bridge Supabase Edge Function, then hands it to
 * signInWithOAuth() for a REAL navigation through the OAuth redirect chain
 * (Supabase -> bridge -> Supabase -> back here). Safe to let it navigate:
 * this document is an ordinary nested <iframe>, not the VS Code webview's
 * own top-level document, so the [LegacyUnforgeable] restriction that
 * blocks window.location.assign() in a bare webview (confirmed the hard
 * way in a prior, superseded attempt) doesn't apply here — independently
 * corroborated by platform's own shipped, tested implementation of this
 * exact contract.
 */
async function completeVsCodeGithubSignIn(token: string): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.warn('[auth-provider] Supabase not configured, cannot complete VS Code GitHub sign-in');
    return;
  }

  try {
    const ticketResp = await fetch(`${GITHUB_IDENTITY_BRIDGE_ISSUER}/tickets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!ticketResp.ok) throw new Error(`github-identity-bridge /tickets returned ${ticketResp.status}`);
    const { ticket } = (await ticketResp.json()) as { ticket?: string };
    if (!ticket) throw new Error('github-identity-bridge /tickets returned no ticket');

    const { error } = await supabase.auth.signInWithOAuth({
      // supabase-js's exported Provider type doesn't include custom:*
      // providers even though the SDK itself supports them — same gap
      // platform's own vscode-bridge route hit (see its plan doc).
      provider: 'custom:github-bridge' as never,
      options: {
        queryParams: { ticket },
        redirectTo: `${window.location.origin}${window.location.pathname}?embed=vscode`,
      },
    });
    if (error) throw error;
    // signInWithOAuth() above already triggered a real window.location
    // navigation (no skipBrowserRedirect) — nothing left to do here; the
    // page is already on its way to Supabase's /auth/v1/authorize.
  } catch (err) {
    console.error('[auth-provider] VS Code GitHub sign-in handoff failed:', err);
  }
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
