/**
 * local-login — the loopback GitHub OAuth (PKCE) flow that turns a browser
 * consent into a Supabase session on disk (~/.worldmonitor/session.json).
 *
 * ONE caller today: `worldmonitor-local login` (scripts/worldmonitor-local.mjs).
 *
 * It lives in its own module rather than inline in the CLI because a second
 * caller is expected back: the Local App Initiative's Phase 2 added POST
 * /api/local-login (the settings.html "Sign in with GitHub" button) and the
 * platform pivot then reverted it — see PLATFORM_ARCHITECTURE.md Workstream R,
 * which deletes the control plane but deliberately KEEPS this module, and
 * Workstream 1, where the post-login step seeds the `local-config` broker
 * cache. Keeping the flow factored out means that re-entry is a new caller,
 * not a re-extraction.
 *
 * The caller owns:
 *   - Supabase config resolution (`.env` / config.db → passed in here), and
 *   - how the browser is opened. The CLI shells `open`/`xdg-open`. A non-CLI
 *     caller running as a launchd/schtasks service may have NO GUI session, so
 *     the contract is to hand `authUrl` back rather than assume it can open it.
 *
 * The callback server binds 127.0.0.1:46124 — the ONE redirect URL the operator
 * allowlists in the Supabase project (see the CLI's SETUP note). It is a
 * separate ephemeral server, not part of the API listener, so it never touches
 * SIDECAR_ALLOWED_ORIGINS / CSP.
 */
import http from 'node:http';
import { writeOperatorSession } from './session-file.mjs';

/** Pinned so exactly one redirect URL is allowlisted in Supabase. */
export const DEFAULT_CALLBACK_PORT = 46124;

/**
 * Start the flow. Resolves as soon as the callback server is bound and the
 * GitHub consent URL is known — the exchange happens later, on the redirect.
 *
 * @returns {Promise<{ authUrl: string, completed: Promise<object>, cancel: () => void }>}
 *   - `authUrl`   GitHub consent URL to navigate to (open it now).
 *   - `completed` resolves with the trimmed session (writeOperatorSession's
 *                 return) once the code exchange succeeds and session.json is
 *                 written; rejects on OAuth error, org-gate rejection, or the
 *                 3-minute timeout.
 *   - `cancel()`  tears the callback server down early and rejects `completed`.
 *
 * @throws if Supabase config is missing, signInWithOAuth fails, or the callback
 *   port can't be bound (surfaced before `authUrl` is handed back).
 */
export async function beginGithubLogin({
  supabaseUrl,
  supabaseKey,
  callbackPort = DEFAULT_CALLBACK_PORT,
  timeoutMs = 180_000,
  sessionFile,
} = {}) {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase URL / publishable key required for the login flow');
  }
  const redirectTo = `http://127.0.0.1:${callbackPort}/callback`;

  const { createClient } = await import('@supabase/supabase-js');
  const memStore = new Map();
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      flowType: 'pkce',
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: {
        getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
        setItem: (k, v) => memStore.set(k, v),
        removeItem: (k) => memStore.delete(k),
      },
    },
  });

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: { redirectTo, skipBrowserRedirect: true, scopes: 'read:user user:email' },
  });
  if (error || !data?.url) {
    throw new Error(`could not start GitHub OAuth: ${error?.message || 'no URL returned'}`);
  }

  let settle;
  const completed = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  let done = false;
  let timer;

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, redirectTo);
    if (reqUrl.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const code = reqUrl.searchParams.get('code');
    const errParam = reqUrl.searchParams.get('error_description') || reqUrl.searchParams.get('error');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><meta charset=utf-8><body style="font:14px system-ui;padding:3rem">
      <h2>World Monitor</h2><p>${code
        ? 'Sign-in complete — close this tab and return to the settings page.'
        : 'Sign-in failed — return to the settings page and try again.'}</p>`);
    finish();
    if (errParam || !code) {
      settle.reject(new Error(errParam || 'no authorization code returned'));
      return;
    }
    try {
      const { data: exchanged, error: exErr } = await supabase.auth.exchangeCodeForSession(code);
      if (exErr || !exchanged?.session) throw new Error(exErr?.message || 'no session returned');
      settle.resolve(writeOperatorSession(exchanged.session, sessionFile));
    } catch (e) {
      settle.reject(e instanceof Error ? e : new Error(String(e)));
    }
  });

  function finish() {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { server.close(); } catch { /* already closed */ }
  }

  // Bind before returning authUrl so a port clash is a thrown error, not a
  // silent dead flow.
  await new Promise((resolve, reject) => {
    const onError = (e) => reject(new Error(
      e.code === 'EADDRINUSE'
        ? `callback port ${callbackPort} is busy — close whatever is using it and retry`
        : `callback server failed: ${e.message}`,
    ));
    server.once('error', onError);
    server.listen(callbackPort, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  // Post-listen errors (rare) fail the pending flow.
  server.on('error', (e) => { finish(); settle.reject(new Error(`callback server error: ${e.message}`)); });

  timer = setTimeout(() => {
    finish();
    settle.reject(new Error('timed out waiting for the browser callback (3 min)'));
  }, timeoutMs);

  return {
    authUrl: data.url,
    completed,
    cancel: () => { finish(); settle.reject(new Error('cancelled')); },
  };
}
