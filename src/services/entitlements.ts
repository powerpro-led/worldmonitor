/**
 * Frontend entitlement service — Stage 1 Supabase migration.
 *
 * Formerly a reactive ConvexClient subscription driven by Clerk auth +
 * Dodo-billing tiers. Since this fork carries no SaaS billing (decided
 * earlier in the Stage 1 plan — see docs/architecture/operator-space.md),
 * entitlements collapse to a binary check: signed in via Supabase (and thus
 * already GitHub-org-gated server-side by the `worldmonitor-org-gate` Auth
 * Hook) = full access, forever. No Convex round-trip, no tier math, no
 * expiry.
 *
 * The exported surface (EntitlementState shape, hasFeature/hasTier/isEntitled)
 * is kept stable so the ~10 UI call sites that reference it (ProBanner,
 * UnifiedSettings, notifications-settings, watchlist-modal, widget-store,
 * panel-gating) don't need individual rewrites — only this file's internals
 * changed.
 */

import { getAuthState, subscribeAuthState } from './auth-state';

export interface EntitlementState {
  planKey: string;
  features: {
    tier: number;
    apiAccess: boolean;
    apiRateLimit: number;
    planLimits?: {
      apiRequestsPerDay: number | null;
      apiBurstRequestsPerMinute: number | null;
      mcpCallsPerDay: number | null;
      mcpBurstRequestsPerMinute: number | null;
    };
    maxDashboards: number;
    prioritySupport: boolean;
    exportFormats: string[];
    mcpAccess?: boolean;
  };
  validUntil: number;
}

/** Every signed-in user gets this, unconditionally — no tiers post-billing-cut. */
const FULL_ACCESS_STATE: EntitlementState = {
  planKey: 'pro',
  features: {
    tier: 1,
    apiAccess: true,
    apiRateLimit: Number.POSITIVE_INFINITY,
    maxDashboards: Number.POSITIVE_INFINITY,
    prioritySupport: true,
    exportFormats: ['csv', 'json', 'pdf'],
    mcpAccess: true,
  },
  validUntil: Number.POSITIVE_INFINITY,
};

let currentState: EntitlementState | null = null;
const listeners = new Set<(state: EntitlementState | null) => void>();
let unsubscribeFn: (() => void) | null = null;

function deriveStateFromAuth(): EntitlementState | null {
  return getAuthState().user ? FULL_ACCESS_STATE : null;
}

/**
 * Initialize the entitlement subscription. Idempotent. The `_userId`
 * parameter is unused — kept for call-site compatibility (App.ts passes it
 * on user-change; it was already unused in the Convex-backed implementation
 * too, since identity flowed through the auth transport, not this arg).
 */
export async function initEntitlementSubscription(_userId?: string): Promise<void> {
  if (unsubscribeFn) return;
  currentState = deriveStateFromAuth();
  unsubscribeFn = subscribeAuthState(() => {
    const next = deriveStateFromAuth();
    currentState = next;
    for (const cb of listeners) cb(next);
  });
}

/**
 * Tears down the entitlement subscription and clears all listeners.
 * Resets so a new subscription can be started. Does NOT null currentState —
 * preserves the last known state across destroy/reinit cycles.
 */
export function destroyEntitlementSubscription(): void {
  if (unsubscribeFn) {
    unsubscribeFn();
    unsubscribeFn = null;
  }
}

/**
 * Explicitly nulls currentState. Call on sign-out to prevent the previous
 * user's entitlements from leaking into a subsequent session.
 */
export function resetEntitlementState(): void {
  currentState = null;
}

/**
 * Register a callback for entitlement changes.
 * If entitlement state is already available, the callback fires immediately.
 * Returns an unsubscribe function.
 */
export function onEntitlementChange(
  cb: (state: EntitlementState | null) => void,
): () => void {
  listeners.add(cb);
  if (currentState !== null) cb(currentState);
  return () => {
    listeners.delete(cb);
  };
}

/** Returns the current entitlement state, or null if signed out. */
export function getEntitlementState(): EntitlementState | null {
  return currentState;
}

/**
 * Check whether a specific feature flag is truthy in the current entitlement
 * state. Since FULL_ACCESS_STATE sets every feature flag once signed in,
 * this is equivalent to "is the user signed in" — kept as a named function
 * per-flag so call sites don't need rewriting.
 */
export function hasFeature(flag: keyof EntitlementState['features']): boolean {
  if (currentState === null) return false;
  return Boolean(currentState.features[flag]);
}

/**
 * Check whether the user's tier meets or exceeds the given minimum.
 * No real tiers exist post-billing-cut — any signed-in user passes any
 * `hasTier(n)` check (mirrors FULL_ACCESS_STATE.features.tier = Infinity in
 * spirit; kept literal `tier: 1` in the state object for shape stability,
 * this function is the actual comparison every call site uses).
 */
export function hasTier(_minTier: number): boolean {
  return currentState !== null;
}

/**
 * Simple "is this an authenticated user" check. No expiry, no plan check —
 * signed in (and thus org-gated) is the only bar.
 */
export function isEntitled(): boolean {
  return currentState !== null;
}

/**
 * Decides whether to reload the page when an entitlement snapshot arrives.
 *
 * Rules:
 *   - First snapshot ever (last === null): never reload.
 *   - Signed-out → signed-in transition (last === false, next === true):
 *     reload — panels rendered against signed-out gating need to re-render.
 *   - Everything else: no reload.
 */
export function shouldReloadOnEntitlementChange(
  last: boolean | null,
  next: boolean,
): boolean {
  return last === false && next === true;
}
