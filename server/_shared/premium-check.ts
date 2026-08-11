// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from '../../api/_api-key.js';
// @ts-expect-error — JS module, no declaration file
import { timingSafeIncludes } from '../../api/_crypto.js';
import { validateBearerToken } from '../auth-session';
import { getEntitlements } from './entitlement-check';

export type PremiumCallerIdentity =
  | { isPremium: true; userId: string; kind: 'bearer'; quotaExempt: false }
  | { isPremium: true; userId: null; kind: 'enterprise'; quotaExempt: true }
  | { isPremium: false; userId: null; kind: null; quotaExempt: false };

/**
 * Resolves premium status and the user-bound identity for spend controls.
 */
export async function resolvePremiumCallerIdentity(request: Request): Promise<PremiumCallerIdentity> {
  // Browser tester keys — validateApiKey returns required:false for trusted origins
  // even when a valid key is present, so we check the header directly first.
  const wmKey =
    request.headers.get('X-WorldMonitor-Key') ??
    request.headers.get('X-Api-Key') ??
    '';
  if (wmKey) {
    const validKeys = (process.env.WORLDMONITOR_VALID_KEYS ?? '')
      .split(',').map((k) => k.trim()).filter(Boolean);
    if (await timingSafeIncludes(wmKey, validKeys)) {
      return { isPremium: true, userId: null, kind: 'enterprise', quotaExempt: true };
    }
  }

  const keyCheck = (await validateApiKey(request, {})) as { valid: boolean; required: boolean };
  // Only treat as premium when an explicit API key was validated (required: true).
  // Trusted-origin short-circuits (required: false) do NOT imply PRO entitlement.
  if (keyCheck.valid && keyCheck.required) {
    return { isPremium: true, userId: null, kind: 'enterprise', quotaExempt: true };
  }

  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const session = await validateBearerToken(authHeader.slice(7));
    if (!session.valid) return { isPremium: false, userId: null, kind: null, quotaExempt: false };
    if (session.role === 'pro' && session.userId) {
      return { isPremium: true, userId: session.userId, kind: 'bearer', quotaExempt: false };
    }
    // Fallback entitlement check — role is always 'pro' for a verified
    // session post-Stage-1 (server/auth-session.ts), so this is defensive
    // rather than a real second signal today.
    if (session.userId) {
      const ent = await getEntitlements(session.userId);
      if (ent && ent.features.tier >= 1) {
        return { isPremium: true, userId: session.userId, kind: 'bearer', quotaExempt: false };
      }
    }
  }
  return { isPremium: false, userId: null, kind: null, quotaExempt: false };
}

/**
 * Returns true when the caller has a valid API key OR a PRO bearer token.
 * Used by handlers where the RPC endpoint is public but certain fields
 * (e.g. framework/systemAppend) should only be honored for premium callers.
 */
export async function isCallerPremium(request: Request): Promise<boolean> {
  return (await resolvePremiumCallerIdentity(request)).isPremium;
}
