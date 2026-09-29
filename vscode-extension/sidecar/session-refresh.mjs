/**
 * Refreshes ~/.worldmonitor/session.json against Supabase's token endpoint so
 * that premium-gated dashboard panels (anything behind hasPremiumAccess() in
 * src/services/panel-gating.ts) keep working after the webview has been closed
 * for longer than the access token's ~1h TTL. Without this, `reconcileWith
 * OperatorSession()` on the next webview open can only recover if the *refresh*
 * token is also still alive — and a long-idle one ages past Supabase's
 * inactivity timeout, leaving the iframe with no session at all.
 *
 * Shared by local-api-server.mjs's own periodic loop and
 * local-config-broker.mjs's 401 handler (moved here 2026-09-29, wmtest
 * v2.13.18 retest finding N2). Neither caller awaits the OTHER's attempt, so
 * without a shared, callable "refresh now" both used to race at startup: the
 * periodic loop's own first attempt is deliberately fire-and-forget (so it
 * can't delay the server binding its port), and the broker's own first tick
 * fires on the same startup tick — so which one actually finished first was
 * a coin flip. A near-expiry-but-not-dead token losing that race meant the
 * broker 401'd and dropped a perfectly good cached Upstash credential before
 * the refresh that would have fixed it had even landed. The broker now
 * retries once through THIS function on its own 401 (see that file's 'revoked'
 * branch) instead of just reacting to whatever the periodic loop happened to
 * have already done.
 *
 * Fire-and-forget by contract: never throws into its caller, never blocks
 * startup. On any failure it leaves session.json untouched (a stale-but-
 * present file still lets `worldmonitor-local status` report the identity
 * and prompts a manual `login`) and logs one line, mirroring the warm-ping
 * discipline.
 */
import { readOperatorSession, writeOperatorSession } from './session-file.mjs';

// Refresh only once the token has less than this much runway left. The
// dashboard iframe's own supabase-js refreshes its in-memory copy ~90s before
// expiry while the webview is open; gating on near-expiry keeps churn (and,
// under Supabase refresh-token rotation, cross-invalidation) to a minimum
// while still leaving a wide margin. When the webview is closed — the case
// the periodic loop exists for — nothing else touches the file and this is
// the only thing keeping the session alive.
const SESSION_REFRESH_SKEW_MS = 25 * 60_000; // 25m

// The refresh_token this module has already confirmed permanently dead
// (Supabase's `refresh_token_already_used` — rotation means a token works
// exactly once, so this is a terminal rejection, not a transient one worth
// retrying). Compared by value, not just "did we fail before": a fresh
// `login` writes a NEW refresh_token to session.json, which naturally no
// longer matches and clears this on its own — no explicit reset needed.
// Module-level (not per-caller) so the broker's retry and the periodic loop
// agree on a token that's already confirmed dead, and neither hammers
// Supabase with it independently.
let deadRefreshToken = null;

/** Compact "~42m left" / "~5h left" for a Supabase `expires_at` (epoch seconds). */
export function describeSessionExpiry(expiresAt) {
  if (!expiresAt) return 'unknown expiry';
  const mins = Math.round((expiresAt * 1000 - Date.now()) / 60_000);
  if (mins <= 0) return 'already expired';
  return mins < 120 ? `~${mins}m left` : `~${Math.round(mins / 60)}h left`;
}

/**
 * @param {{ logger: { log: Function, warn: Function } }} context
 */
export async function refreshOperatorSessionOnce(context) {
  const session = readOperatorSession();
  if (!session?.refresh_token) return; // not logged in — nothing to refresh
  if (session.refresh_token === deadRefreshToken) return; // confirmed dead — see below, don't hammer Supabase every tick forever
  if (typeof session.expires_at === 'number'
      && session.expires_at * 1000 - Date.now() > SESSION_REFRESH_SKEW_MS) {
    return; // still has plenty of runway; don't race the iframe's own refresh
  }
  const supabaseUrl = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const anonKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
  if (!supabaseUrl || !anonKey) {
    context.logger.warn('[local-api] session refresh skipped — VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY not in env');
    return;
  }
  try {
    const resp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      // Body included (not just the status) — a real Windows field report's
      // own next occurrence confirmed the mechanism this comment used to
      // guess at: the immediately preceding attempt logged "The operation
      // was aborted due to timeout" (this fetch's own 15s AbortSignal
      // firing), and THIS attempt then got back `refresh_token_already_used`
      // — Supabase had already processed and rotated the timed-out request
      // server-side; the response (or this file's own write of it below)
      // just never made it back before the local timeout fired, so the
      // rotated token was never persisted. No forceful process kill needed
      // to trigger this — an ordinary network hiccup on the timed-out
      // request is sufficient.
      //
      // `refresh_token_already_used` (and Supabase's `invalid_grant` family
      // generally) is a TERMINAL rejection, not a transient one: retrying
      // with the same now-dead token can never succeed. A real field report
      // caught this loop doing exactly that — the identical failure
      // recurring on 3 consecutive 15-minute ticks — so stop hammering
      // Supabase with a token that's confirmed dead until a fresh `login`
      // writes a different one.
      const detail = await resp.text().catch(() => '');
      let parsedCode;
      try { parsedCode = JSON.parse(detail)?.error_code; } catch { /* not JSON, or no error_code */ }
      const terminal = resp.status === 400 && (parsedCode === 'refresh_token_already_used' || parsedCode === 'invalid_grant');
      if (terminal) deadRefreshToken = session.refresh_token;
      context.logger.warn(
        `[local-api] session refresh failed (HTTP ${resp.status}${detail ? `: ${detail.slice(0, 500)}` : ''}) — `
        + (terminal
          ? 'this token is permanently invalid; run `worldmonitor-local login` — will not retry until you do'
          : 'session.json left as-is; run `worldmonitor-local login` if premium panels stop loading'),
      );
      return;
    }
    const refreshed = await resp.json().catch(() => null);
    if (!refreshed?.access_token || !refreshed?.refresh_token) {
      context.logger.warn('[local-api] session refresh returned no tokens — session.json left as-is');
      return;
    }
    const expires_at = typeof refreshed.expires_at === 'number'
      ? refreshed.expires_at
      : Number.isFinite(refreshed.expires_in)
        ? Math.floor(Date.now() / 1000) + refreshed.expires_in
        : session.expires_at;
    writeOperatorSession({ ...refreshed, expires_at });
    context.logger.log(`[local-api] session.json refreshed (${describeSessionExpiry(expires_at)})`);
  } catch (err) {
    context.logger.warn(`[local-api] session refresh error (non-fatal): ${err.message}`);
  }
}

/** Test-only: forget a confirmed-dead refresh token so a fixture can reuse the same literal value across cases without tripping the "already confirmed dead" short-circuit. No production caller should ever invoke this. */
export function __resetDeadRefreshTokenForTests() {
  deadRefreshToken = null;
}
