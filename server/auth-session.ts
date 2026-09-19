/**
 * Server-side session validation for the Vercel edge gateway.
 *
 * Validates Supabase-issued bearer tokens using local ES256 (asymmetric)
 * verification against the project's public JWT signing key
 * (`SUPABASE_JWT_PUBLIC_JWK`). No JWKS fetch, no Convex round-trip, no
 * external plan lookup.
 *
 * Deliberately hardcoded rather than fetched from
 * `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` (Supabase's own
 * recommended `createRemoteJWKSet` pattern) -- an explicit operator
 * trade-off (2026-08-19) favoring zero network dependency on the verify
 * path over automatic recovery from key rotation. Consequence: if this
 * project's signing key is ever rotated (Supabase dashboard: "rotate to a
 * standby key, then revoke"), verification silently starts failing --
 * every request looks anonymous, same symptom as an unset key -- until
 * `SUPABASE_JWT_PUBLIC_JWK` is manually updated to the new public key and
 * the service is redeployed. There is no automatic fallback by design.
 *
 * This module must NOT import anything from `src/` -- it runs in the
 * Vercel edge runtime, not the browser.
 */

import { importJWK, jwtVerify, type JWK } from 'jose';

// Supabase project URL -- set in Vercel env vars. The JWT issuer is always
// `${SUPABASE_URL}/auth/v1` for GoTrue-issued tokens.
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';

// Supabase project's public JWT signing key (JWKS `keys[0]`, JSON-encoded --
// Project Settings -> API Keys -> JWT Settings -> JWT Signing Keys in the
// Supabase dashboard). Public key material only (key_ops: ["verify"]) --
// safe to have in a server env var, but still not sent to the browser.
const SUPABASE_JWT_PUBLIC_JWK = process.env.SUPABASE_JWT_PUBLIC_JWK ?? '';

// Supabase's default audience claim for authenticated user sessions.
const SUPABASE_JWT_AUDIENCE = 'authenticated';

export interface SessionResult {
  valid: boolean;
  userId?: string;
  orgId?: string | null;
  role?: 'free' | 'pro';
  email?: string;
  name?: string;
}

// Imported once and memoized -- importJWK() is real async key-material work,
// not a string parse, so every verification must not repeat it. A rejected
// promise (bad JSON, wrong shape) is cached too: retrying per-request would
// just repeat the same parse failure, so validateBearerToken() fails closed
// on it rather than retrying import work that cannot succeed differently.
let cachedPublicKey: Promise<CryptoKey | Uint8Array> | null = null;

function getPublicKey(): Promise<CryptoKey | Uint8Array> | null {
  if (!SUPABASE_JWT_PUBLIC_JWK) return null;
  if (!cachedPublicKey) {
    // Wrapped in Promise.resolve().then() so a synchronous JSON.parse
    // failure (malformed env value) becomes a rejected promise like any
    // other import failure, instead of throwing before validateBearerToken's
    // try/catch is entered.
    cachedPublicKey = Promise.resolve().then(() => importJWK(JSON.parse(SUPABASE_JWT_PUBLIC_JWK) as JWK, 'ES256'));
  }
  return cachedPublicKey;
}

function getSupabaseJwtVerifyOptions() {
  return {
    issuer: `${SUPABASE_URL}/auth/v1`,
    audience: SUPABASE_JWT_AUDIENCE,
    algorithms: ['ES256'],
  };
}

/**
 * Extracts a display name from a Supabase JWT payload. GitHub-identity
 * fields (`user_name`, `preferred_username`, `full_name`, `name`) live
 * under `user_metadata` on Supabase-issued tokens, not at the top level.
 */
function extractName(userMetadata: Record<string, unknown> | undefined): string | undefined {
  if (!userMetadata) return undefined;
  const candidates = [
    userMetadata.full_name,
    userMetadata.name,
    userMetadata.user_name,
    userMetadata.preferred_username,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

// ---------- Local-bundle fallback: let GoTrue verify the token ----------
//
// The downloadable local bundle (LOCAL_API_MODE=tauri-sidecar) configures an
// operator machine with only the org's Supabase URL + publishable key —
// SUPABASE_JWT_PUBLIC_JWK is not among the values org.env carries, and the
// zero-network trade-off above was made for the cloud gateway, not for a
// backend running on the user's own laptop. Without a key every bearer looked
// anonymous, so the account-features routes 401'd/503'd there (first real
// Windows operator, 2026-09-19: "Failed to load notification settings").
//
// Here the token is verified by the issuer itself: `GET /auth/v1/user` with
// the publishable key as `apikey` and the token as bearer. GoTrue checks
// signature, expiry and audience server-side — correct for ES256 and legacy
// HS256 projects alike, and it survives key rotation. One network hop per
// distinct token, memoised briefly so a burst of panel requests from the same
// session costs one round-trip. Strictly gated on the local mode so the cloud
// verify path is byte-for-byte unchanged.

function isLocalSidecar(): boolean {
  return process.env.LOCAL_API_MODE === 'tauri-sidecar';
}

const GOTRUE_VERIFY_CACHE_TTL_MS = 60_000;
const GOTRUE_VERIFY_CACHE_MAX = 64;
const goTrueVerified = new Map<string, { result: SessionResult; expiresAt: number }>();

async function validateViaGoTrue(token: string): Promise<SessionResult> {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
  const apikey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
  if (!url || !apikey || !token) return { valid: false };

  const now = Date.now();
  const cached = goTrueVerified.get(token);
  if (cached && cached.expiresAt > now) return cached.result;

  let result: SessionResult = { valid: false };
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const user = await res.json() as {
        id?: unknown; email?: unknown; aud?: unknown; user_metadata?: Record<string, unknown>;
      };
      if (typeof user.id === 'string' && user.id && (user.aud === undefined || user.aud === SUPABASE_JWT_AUDIENCE)) {
        result = {
          valid: true,
          userId: user.id,
          orgId: null,
          role: 'pro',
          email: typeof user.email === 'string' ? user.email : undefined,
          name: extractName(user.user_metadata),
        };
      }
    }
  } catch {
    // Network/timeout — fail closed, same as an unverifiable signature.
  }

  // Only successes are memoised: a rejected token is cheap to re-check and a
  // freshly-minted replacement must not inherit a stale "invalid".
  if (result.valid) {
    if (goTrueVerified.size >= GOTRUE_VERIFY_CACHE_MAX) {
      const oldest = goTrueVerified.keys().next().value;
      if (oldest !== undefined) goTrueVerified.delete(oldest);
    }
    goTrueVerified.set(token, { result, expiresAt: now + GOTRUE_VERIFY_CACHE_TTL_MS });
  }
  return result;
}

/**
 * Validate a Supabase-issued bearer token using local ES256 verification
 * against the project's hardcoded public signing key.
 *
 * No plan/tier concept left: every verified token gets `role: 'pro'` (the
 * wire shape stays `{userId, orgId, role}` so the many frontend consumers
 * that check `role === 'pro'` keep working unchanged). `orgId` is always
 * `null` -- Supabase Auth has no built-in org concept, and GitHub-org
 * membership is enforced entirely at sign-up time via the Supabase
 * before-user-created hook, not per-request here.
 *
 * Fails closed: invalid/expired/unverifiable tokens, or an unconfigured/
 * unparseable SUPABASE_JWT_PUBLIC_JWK, return { valid: false } — except in
 * the local bundle, see validateViaGoTrue() below.
 */
export async function validateBearerToken(token: string): Promise<SessionResult> {
  const publicKey = getPublicKey();
  if (!publicKey) {
    return isLocalSidecar() ? validateViaGoTrue(token) : { valid: false };
  }

  try {
    const key = await publicKey;
    const { payload } = await jwtVerify(token, key, getSupabaseJwtVerifyOptions());

    const userId = payload.sub as string | undefined;
    if (!userId) return { valid: false };

    const email = typeof payload.email === 'string' ? payload.email : undefined;
    const userMetadata = payload.user_metadata as Record<string, unknown> | undefined;
    const name = extractName(userMetadata);

    return { valid: true, userId, orgId: null, role: 'pro', email, name };
  } catch {
    // Signature verification failed, expired, wrong issuer/audience, etc.
    return { valid: false };
  }
}
