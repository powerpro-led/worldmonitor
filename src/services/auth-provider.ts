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
  const start = (): void => {
    void initAuthProvider();
    void checkForVsCodeGithubTokenHandoff();
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
  // checkForVsCodeGithubTokenHandoff() below for how that token comes back
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
 * checkForVsCodeGithubTokenHandoff() below for the full contract). Already
 * live and registered as the `custom:github-bridge` provider on this
 * fork's own Supabase project (VITE_SUPABASE_URL) — nothing new to deploy. */
const GITHUB_IDENTITY_BRIDGE_ISSUER = 'https://ixuezudybhjptisexgxx.supabase.co/functions/v1/github-identity-bridge';

/**
 * VS-Code-extension-only entry point for GitHub sign-in. Mirrors the
 * already-proven client contract from the sibling `platform` repo's
 * `/auth/vscode-bridge` route
 * (platform/docs/plans/2026-07-31-github-identity-bridge.md) — reusing a
 * pattern that's already been tested end-to-end elsewhere, not inventing a
 * new one.
 *
 * vscode-extension/src/panel.ts's handleGithubSignIn() gets a GitHub token
 * from VS Code's own native auth provider and re-navigates this SAME iframe
 * to `dashboard.html?embed=vscode#vscode_github_token=<token>` — fragment
 * only, never sent to any server as a query param. On the next boot (called
 * once from scheduleAuthProviderLoad()'s deferred start(), below), this
 * function reads that token straight off location.hash, exchanges it for a
 * short-lived ticket, then hands the ticket to signInWithOAuth() for a REAL
 * navigation through the OAuth redirect chain (Supabase -> bridge ->
 * Supabase -> back here). Safe to let it navigate: this document is an
 * ordinary nested <iframe>, not the VS Code webview's own top-level
 * document, so the [LegacyUnforgeable] restriction that blocks
 * window.location.assign() in a bare webview (confirmed the hard way in a
 * prior, superseded attempt) doesn't apply here — independently
 * corroborated by platform's own shipped, tested implementation of this
 * exact contract.
 *
 * No isDesktopRuntime() gate needed (unlike the code this replaces) — this
 * is self-gating by construction: the hash fragment it looks for only ever
 * exists because panel.ts put it there, so this is a silent no-op on every
 * other runtime (web, packaged Tauri, or a plain VS Code load before the
 * user has signed in).
 *
 * Supersedes and replaces applyExternalSession() /
 * installExternalSessionListener() / the wm-external-session postMessage
 * contract, which were dead code under this architecture — those were
 * gated on isDesktopRuntime(), which is false by design for the plain-web
 * build the sidecar serves (see the VS Code extension plan's architecture
 * notes).
 */
async function checkForVsCodeGithubTokenHandoff(): Promise<void> {
  if (typeof window === 'undefined') return;
  const match = /(?:^#|[&#])vscode_github_token=([^&]+)/.exec(window.location.hash);
  if (!match?.[1]) return;
  const token = decodeURIComponent(match[1]);

  // Strip it immediately — avoid reprocessing on reload, and don't leave a
  // live GitHub token sitting in browser history.
  const remainingHash = window.location.hash.replace(/(?:^#|[&#])vscode_github_token=[^&]+/, '');
  window.history.replaceState(
    null,
    '',
    window.location.pathname + window.location.search + (remainingHash && remainingHash !== '#' ? remainingHash : ''),
  );

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
