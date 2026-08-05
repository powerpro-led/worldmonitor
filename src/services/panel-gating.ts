import type { AuthSession } from './auth-state';
import { isProUser } from './widget-store';
import { getSecretState } from './runtime-config';

export enum PanelGateReason {
  NONE = 'none',           // show content (signed in, or desktop with API key, or non-premium panel)
  ANONYMOUS = 'anonymous', // "Sign In to Unlock"
}

/**
 * Single source of truth for premium access.
 *
 * Post-billing-cut (Stage 1 Supabase migration — see
 * docs/architecture/operator-space.md), there are no real tiers: every
 * signed-in user gets full access via isEntitled() (folded into isProUser()
 * — see widget-store.ts), so this is a thin union of the non-auth signals
 * that grant access without a session at all (desktop API key, browser
 * tester keys).
 */
export function hasPremiumAccess(authState?: AuthSession): boolean {
  if (getSecretState('WORLDMONITOR_API_KEY').present) return true;
  if (isProUser()) return true;
  if (authState?.user?.role === 'pro') return true;
  return false;
}

/**
 * Determine gating reason for a premium panel given current auth state.
 * Non-premium panels always return NONE. hasPremiumAccess() already covers
 * every signed-in user (via isEntitled()), so the only way a premium panel
 * stays gated is when nobody is signed in — ANONYMOUS is the sole locked
 * reason left.
 */
export function getPanelGateReason(
  authState: AuthSession,
  isPremium: boolean,
): PanelGateReason {
  if (!isPremium) return PanelGateReason.NONE;
  if (hasPremiumAccess(authState)) return PanelGateReason.NONE;
  return PanelGateReason.ANONYMOUS;
}
