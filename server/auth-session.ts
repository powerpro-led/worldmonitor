/**
 * Server-side session validation for the Vercel edge gateway.
 *
 * Validates Supabase-issued bearer tokens using local HS256 verification
 * against the project's shared JWT secret (`SUPABASE_JWT_SECRET`). No JWKS
 * fetch, no Convex round-trip, no external plan lookup.
 *
 * This module must NOT import anything from `src/` -- it runs in the
 * Vercel edge runtime, not the browser.
 */

import { jwtVerify } from 'jose';

// Supabase project URL -- set in Vercel env vars. The JWT issuer is always
// `${SUPABASE_URL}/auth/v1` for GoTrue-issued tokens.
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';

// Supabase project's legacy HS256 JWT signing secret -- Project Settings ->
// API -> JWT Secret in the Supabase dashboard. Server-only, never exposed
// to the browser.
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? '';

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

function getSupabaseJwtVerifyOptions() {
  return {
    issuer: `${SUPABASE_URL}/auth/v1`,
    audience: SUPABASE_JWT_AUDIENCE,
    algorithms: ['HS256'],
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

/**
 * Validate a Supabase-issued bearer token using local HS256 verification
 * against the shared project JWT secret.
 *
 * No plan/tier concept left: every verified token gets `role: 'pro'` (the
 * wire shape stays `{userId, orgId, role}` so the many frontend consumers
 * that check `role === 'pro'` keep working unchanged). `orgId` is always
 * `null` -- Supabase Auth has no built-in org concept, and GitHub-org
 * membership is enforced entirely at sign-up time via the Supabase
 * before-user-created hook, not per-request here.
 *
 * Fails closed: invalid/expired/unverifiable tokens, or an unconfigured
 * SUPABASE_JWT_SECRET, return { valid: false }.
 */
export async function validateBearerToken(token: string): Promise<SessionResult> {
  if (!SUPABASE_JWT_SECRET) return { valid: false };

  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(SUPABASE_JWT_SECRET),
      getSupabaseJwtVerifyOptions(),
    );

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
