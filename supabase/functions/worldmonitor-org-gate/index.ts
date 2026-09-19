import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";

// Supabase "Before User Created" Auth Hook — restricts sign-up/sign-in on
// worldmonitor's web package (GitHub OAuth) and, later, the VS Code package
// (via platform's existing custom:github-bridge provider) to members of one
// GitHub org. This is internal tooling, not public SaaS — see
// docs/architecture/operator-space.md and the Stage 1 Supabase-migration plan.
//
// Org membership is checked with a SERVER-OWNED token (GITHUB_ORG_READ_TOKEN),
// not the signing-in user's own OAuth token — the hook payload only carries
// `identities[].identity_data`, never a usable provider access token, so
// there is no delegated token available inside this hook to check with.
//
// Contract: https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook
// Return 200/204 (empty body) to allow, or an `{error}` object to deny.
//
// ─────────────────────────────────────────────────────────────────────────
// VENDORED 2026-09-19. This file had no source in any repo. It was live on
// biovita (version 26) and mosiq, deployed by hand at some point and never
// committed, while INSTALL.md, vscode-extension/README.md,
// src/services/auth-provider.ts and local-config/index.ts all describe it as
// THE invite gate. The text above and below is the genuine source, recovered
// from the deployed function's own eszip bundle
// (`GET /v1/projects/<ref>/functions/worldmonitor-org-gate/body`, whose
// sourcemap carries `sourcesContent`) — not a reimplementation from the docs.
//
// It was also, at the time of vendoring, NOT ACTUALLY ENFORCING ANYTHING:
// `hook_before_user_created_enabled` was `false` on both biovita and mosiq,
// so the function was deployed but never called, and any GitHub account could
// sign up and be handed the org's Upstash read-only credential by the
// local-config broker. Enabling the hook is now part of
// .github/workflows/deploy-org.reusable.yml so a new org cannot miss it the
// same way.
//
// NOTE FOR WHOEVER TOUCHES THIS NEXT: this function fails CLOSED on a missing
// env var (`requiredEnv` throws → 500 → GoTrue denies). Enabling the hook
// without a usable configuration locks EVERY new account out of the project.
// The deploy workflow deliberately refuses to enable the hook unless the
// configuration it would write is actually complete.
//
// ALLOWLIST MODE ADDED 2026-09-19, and it is currently the only mode that
// works here. The org-membership design above assumes `GITHUB_ALLOWED_ORG`
// names a real GitHub organization. `powerpro-led` — the account that owns
// worldmonitor, org-provisioning and platform — is a personal **User**
// account, and the authenticated identity belongs to no orgs at all
// (verified: `GET /orgs/powerpro-led` → 404, `GET /user/orgs` → empty). The
// membership endpoint returns 404 for a non-org, which `isOrgMember()` reads
// as "not a member" — so switching the gate on in org mode today would deny
// every single sign-up, which is worse than leaving it off.
//
// So the gate now accepts EITHER:
//   GITHUB_ALLOWED_LOGINS — comma-separated GitHub logins, case-insensitive.
//                           No org, no PAT, no network call. Right answer for
//                           a handful of internal operators.
//   GITHUB_ALLOWED_ORG (+ GITHUB_ORG_READ_TOKEN) — the original design,
//                           unchanged, for when a real org exists.
// At least one must be configured. If both are, either one passing allows.
// ─────────────────────────────────────────────────────────────────────────

function requiredEnv(key: string): string {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

// A denial is a SUCCESSFUL hook call that happens to say no, so the response
// status is 200 and the verdict rides in the body. The `http_code` inside the
// error object is what GoTrue propagates to the client.
//
// The status here is NOT cosmetic, and the Supabase docs are actively
// misleading about it: their "Block by OAuth Provider" example returns
// `{ status: 403 }`, and doing exactly that got
//   {"code":500,"error_code":"unexpected_failure",
//    "msg":"Unexpected status code returned from hook: 403"}
// — verified against this project 2026-09-19. The sign-up was still blocked,
// but the caller saw an opaque 500 instead of the reason, which is
// indistinguishable from the hook being down. Returning 200 is what actually
// propagates the message.
function deny(message: string, httpCode = 403): Response {
  return new Response(
    JSON.stringify({ error: { message, http_code: httpCode } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function allow(): Response {
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
}

// GitHub's OAuth identity_data shape varies slightly by how the identity was
// established (Supabase's built-in `github` provider vs. the custom OIDC
// bridge) — check every field GitHub/the bridge might populate rather than
// assuming one canonical key.
function extractGithubLogin(identityData: Record<string, unknown> | undefined): string | null {
  if (!identityData) return null;
  const candidates = [
    identityData.user_name,
    identityData.preferred_username,
    identityData.login,
    identityData.name,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

/**
 * `GITHUB_ALLOWED_LOGINS` as a lower-cased list. Tolerates the shapes a
 * human actually pastes into a secret box — spaces around commas, a trailing
 * comma, a leading `@` — because getting this subtly wrong locks people out
 * and the failure looks like "you're not invited", not "the list is malformed".
 */
function parseAllowedLogins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().replace(/^@/, "").toLowerCase())
    .filter((s) => s.length > 0);
}

async function isOrgMember(login: string, org: string, token: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(login)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "worldmonitor-org-gate",
      Accept: "application/vnd.github+json",
    },
  });
  // 204 = member, 404 = not a member (both are "successful checks", not errors).
  if (res.status === 204) return true;
  if (res.status === 404) return false;
  // Any other status (401/403/5xx) is an operational failure, not a
  // membership answer — fail closed rather than silently treating it as
  // "not a member" or "is a member".
  throw new Error(`GitHub org membership check failed unexpectedly: HTTP ${res.status}`);
}

Deno.serve(async (req) => {
  const payload = await req.text();
  const secret = requiredEnv("BEFORE_USER_CREATED_HOOK_SECRET").replace("v1,whsec_", "");
  const headers = Object.fromEntries(req.headers);
  const wh = new Webhook(secret);

  let user: { identities?: Array<{ identity_data?: Record<string, unknown> }>; app_metadata?: Record<string, unknown> };
  try {
    ({ user } = wh.verify(payload, headers) as { user: typeof user });
  } catch {
    // Signature didn't verify — do not trust this request at all.
    return deny("Invalid hook signature", 400);
  }

  const identityData = user.identities?.[0]?.identity_data;
  const login = extractGithubLogin(identityData);
  if (!login) {
    return deny("No GitHub identity found on this sign-up attempt", 403);
  }

  const allowedLogins = parseAllowedLogins(Deno.env.get("GITHUB_ALLOWED_LOGINS"));
  const org = Deno.env.get("GITHUB_ALLOWED_ORG");
  const token = Deno.env.get("GITHUB_ORG_READ_TOKEN");
  const orgModeConfigured = Boolean(org && token);

  // Neither mode configured — misconfiguration, not a verdict about this
  // user. Still denies (fail closed), but says which it is, because
  // "everyone is locked out" and "this person isn't invited" look identical
  // from the browser and are fixed in completely different places.
  if (allowedLogins.length === 0 && !orgModeConfigured) {
    console.error(
      "[worldmonitor-org-gate] misconfigured: set GITHUB_ALLOWED_LOGINS, or both GITHUB_ALLOWED_ORG and GITHUB_ORG_READ_TOKEN",
    );
    return deny("Sign-up is not configured for this deployment", 503);
  }

  if (allowedLogins.includes(login.toLowerCase())) return allow();

  if (!orgModeConfigured) {
    return deny(`GitHub account "${login}" is not on this deployment's allow-list`, 403);
  }

  try {
    const member = await isOrgMember(login, org as string, token as string);
    if (!member) {
      return deny(`GitHub account "${login}" is not a member of the required org`, 403);
    }
    return allow();
  } catch (err) {
    console.error("[worldmonitor-org-gate] org membership check errored:", err);
    // Fail closed — an operational failure (GitHub API down, bad token) must
    // not silently let anyone in.
    return deny("Could not verify org membership right now — try again shortly", 503);
  }
});
