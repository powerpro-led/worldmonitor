import * as vscode from 'vscode';
import { createClient, type SupportedStorage } from '@supabase/supabase-js';
import { readDotenvValue } from './dotenv';

/**
 * Signs in using the GitHub session VS Code already holds
 * (`vscode.authentication.getSession`) via the `custom:github-bridge`
 * Supabase Auth provider — infrastructure already built, deployed, and
 * verified end-to-end for exactly this purpose (see
 * platform/docs/plans/2026-07-31-github-identity-bridge.md; that repo's
 * own `operator-space` client, retired, used the same contract this file
 * reimplements for worldmonitor). Confirmed worldmonitor and platform share
 * the same Supabase project (ixuezudybhjptisexgxx), so this needs no new
 * Supabase-side deployment or config — the provider is already registered.
 *
 * The redirect chain (Supabase -> bridge -> Supabase -> app) is a REAL
 * OAuth/OIDC redirect, not a single API call - normally the browser
 * navigates through it. A VS Code webview can't navigate to external URLs
 * at all (confirmed: this is exactly why the app's own signInWithGithub()
 * blanks the page there), so this runs the whole chain here in the
 * extension host instead, using supabase-js's own OAuth client with
 * `skipBrowserRedirect: true` (so it never touches `window`, which doesn't
 * meaningfully exist in Node anyway) plus manual `fetch(...,
 * {redirect:'manual'})` hop-following to complete what a browser would
 * normally do automatically. The result is a real Supabase session handed
 * back to the webview - see auth-provider.ts's applyExternalSession().
 */

const SUPABASE_URL = 'https://ixuezudybhjptisexgxx.supabase.co';
const BRIDGE_ISSUER = `${SUPABASE_URL}/functions/v1/github-identity-bridge`;
/**
 * Used only as a marker for "the redirect chain has reached the final
 * app-facing hop" — never actually fetched or navigated to. Matches the
 * app's own real Site URL (auth-provider.ts's signInWithGithub() passes no
 * explicit redirectTo, so it relies on this same Auth-config default),
 * which means it's already valid on this project's Redirect URLs
 * allow-list without any new config — GoTrue accepts an explicit
 * redirectTo that exactly matches the configured Site URL.
 */
const REDIRECT_MARKER = 'https://worldmonitor.app';
const MAX_REDIRECT_HOPS = 8;

/** Minimal in-memory storage adapter — supabase-js needs *some* storage to
 * stash its own PKCE code_verifier between signInWithOAuth() and
 * exchangeCodeForSession(), and there's no localStorage in Node. Nothing
 * here needs to survive past a single sign-in attempt. */
function createMemoryStorage(): SupportedStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  };
}

async function mintTicket(githubToken: string): Promise<string> {
  const resp = await fetch(`${BRIDGE_ISSUER}/tickets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${githubToken}` },
  });
  if (!resp.ok) throw new Error(`github-identity-bridge /tickets returned ${resp.status}`);
  const body = (await resp.json()) as { ticket?: string };
  if (!body.ticket) throw new Error('github-identity-bridge /tickets returned no ticket');
  return body.ticket;
}

/** Follows the real OAuth redirect chain by hand — there's no browser here
 * to do it automatically. Stops as soon as a Location header points at
 * REDIRECT_MARKER, returning the `code` query param from that URL (the
 * app-facing PKCE code from *this* client's own signInWithOAuth() call —
 * distinct from, and downstream of, the bridge's own internal code/ticket
 * exchange with Supabase, which happens server-to-server and is never seen
 * here). Anything else (missing Location, too many hops, an error param on
 * the final redirect) is a real failure, not a case to paper over. */
async function followRedirectChain(startUrl: string): Promise<string> {
  let url = startUrl;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const resp = await fetch(url, { redirect: 'manual' });
    if (resp.status < 300 || resp.status >= 400) {
      throw new Error(`Unexpected non-redirect response (${resp.status}) at hop ${hop} following the sign-in chain`);
    }
    const location = resp.headers.get('location');
    if (!location) throw new Error(`Redirect at hop ${hop} had no Location header`);
    const next = new URL(location, url);
    if (next.origin + next.pathname === new URL(REDIRECT_MARKER).origin + '/') {
      const error = next.searchParams.get('error');
      if (error) throw new Error(`Sign-in chain returned an error: ${error} — ${next.searchParams.get('error_description') ?? ''}`);
      const code = next.searchParams.get('code');
      if (!code) throw new Error('Sign-in chain reached the final redirect with no code param');
      return code;
    }
    url = next.toString();
  }
  throw new Error(`Sign-in chain did not resolve within ${MAX_REDIRECT_HOPS} redirect hops`);
}

export async function signInWithGithubViaVsCode(repoRoot: string): Promise<{ accessToken: string; refreshToken: string }> {
  const publishableKey = readDotenvValue(repoRoot, 'VITE_SUPABASE_PUBLISHABLE_KEY');
  if (!publishableKey) {
    throw new Error('VITE_SUPABASE_PUBLISHABLE_KEY not found in .env.local — needed to complete sign-in.');
  }

  const ghSession = await vscode.authentication.getSession('github', ['read:user'], { createIfNone: true });
  if (!ghSession) throw new Error('No GitHub session available from VS Code');

  const ticket = await mintTicket(ghSession.accessToken);

  const supabase = createClient(SUPABASE_URL, publishableKey, {
    auth: {
      flowType: 'pkce',
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: createMemoryStorage(),
    },
  });

  const { data, error } = await supabase.auth.signInWithOAuth({
    // supabase-js's exported Provider type doesn't include custom:* providers
    // even though the SDK itself supports them (same gap platform's own
    // vscode-bridge route hit and cast through) — see the plan doc.
    provider: 'custom:github-bridge' as never,
    options: {
      skipBrowserRedirect: true,
      redirectTo: REDIRECT_MARKER,
      queryParams: { ticket },
    },
  });
  if (error || !data?.url) throw new Error(`signInWithOAuth failed to produce a redirect URL: ${error?.message ?? 'no url'}`);

  const code = await followRedirectChain(data.url);

  const { data: exchanged, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError || !exchanged.session) {
    throw new Error(`exchangeCodeForSession failed: ${exchangeError?.message ?? 'no session'}`);
  }

  return {
    accessToken: exchanged.session.access_token,
    refreshToken: exchanged.session.refresh_token,
  };
}
