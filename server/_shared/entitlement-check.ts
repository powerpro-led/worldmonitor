/**
 * Entitlement enforcement middleware for the Vercel API gateway.
 *
 * Stage 1 (Supabase migration) collapsed entitlements from a tiered
 * Dodo-billing system to a binary one: this is internal tooling for one
 * operator/org, not public SaaS, so there is no plan/tier concept left.
 * `getEntitlements()` is now a pure function of "is there a userId" — any
 * non-empty userId (which only exists once `resolveSupabaseSession` has
 * verified a Supabase-issued JWT) gets a fixed synthesized "pro" entitlement.
 * No Redis cache, no Convex HTTP fallback, no billing-verification retry
 * machinery.
 *
 * `ENDPOINT_ENTITLEMENTS` / `getRequiredTier()` are KEPT AS-IS — they still
 * answer "does this endpoint require auth at all" (gated vs. public),
 * independent of the billing-tier concept that used to sit behind the gate.
 *
 * `BillingVerificationStatus` / `getBillingVerificationDenial()` /
 * `CachedEntitlements`'s billing-marker fields are KEPT for type/wire
 * compatibility with `api/mcp/*` modules (out of Stage 1's scope) that still
 * reference them — but no code path in this file ever produces a
 * `billingStatus` or `verificationUnavailable` value anymore, so
 * `getBillingVerificationDenial()` is now permanently a no-op (always
 * returns null) for every entitlement this module synthesizes. Those
 * Dodo-billing-specific states (`subscription_lapsed`,
 * `renewal_verification_pending`, `renewal_verification_failed`, the
 * matching 503-retry posture) have no meaning anymore and are never
 * produced.
 *
 * Fail-closed behavior of checkEntitlement():
 *   - No userId on a gated endpoint -> 403 (authentication required)
 *   - Non-null userId on a gated endpoint -> allow (every authed user is
 *     synthesized as tier 1 / pro)
 *   - Endpoint not in ENDPOINT_ENTITLEMENTS -> allow (unrestricted)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Retained for downstream type compatibility (api/mcp/types.ts,
// api/mcp/auth.ts, api/mcp/billing-denial.ts import this union) even though
// nothing in this module produces these values anymore — they were
// Dodo-billing-specific and have no meaning post-Stage-1.
export type BillingVerificationStatus =
  | 'subscription_lapsed'
  | 'renewal_verification_pending'
  | 'renewal_verification_failed';

export interface CachedEntitlements {
  planKey: string;
  features: {
    tier: number;
    apiAccess: boolean;
    /**
     * Per-account REST rate-limit fields. No longer populated by this
     * module (the synthesized entitlement has no plan-based rate tiers) —
     * kept optional so gateway.ts's existing per-account rate-limit branch
     * (falls back to the per-IP path when absent) keeps compiling and
     * behaving sanely without restructuring.
     */
    apiRateLimit?: number;
    maxDashboards?: number;
    prioritySupport?: boolean;
    exportFormats?: string[];
    /**
     * Pro MCP access. Always `true` on the synthesized entitlement — every
     * verified user has MCP access post-Stage-1 (no plan gating left).
     */
    mcpAccess?: boolean;
    /** No daily REST allowance concept left; always undefined (fail-open,
     *  per the original contract: undefined = no daily limit). */
    apiDailyAllowance?: number;
  };
  validUntil: number;
  // Never set by this module anymore (see module header) — retained only
  // for the api/mcp/* consumers' type shape.
  billingStatus?: BillingVerificationStatus;
  retryAfterSeconds?: number;
  renewalVerificationFreshness?: {
    status: 'not_applicable';
    checkedAt: number;
  };
  // Never set by this module anymore — see module header.
  verificationUnavailable?: true;
}

export interface EntitlementCheckResult {
  response: Response | null;
  entitlements: CachedEntitlements | null;
}

export interface EntitlementCheckOptions {
  sessionRole?: 'free' | 'pro' | null;
}

// ---------------------------------------------------------------------------
// Endpoint-to-tier map (replaces PREMIUM_RPC_PATHS)
// ---------------------------------------------------------------------------

/**
 * Maps API endpoints to the minimum tier required for access.
 * Tier hierarchy: 0=free, 1=pro, 2=api, 3=enterprise.
 *
 * Adding a new gated endpoint = adding one line to this map.
 * Endpoints NOT in this map are unrestricted.
 *
 * Stock-analysis endpoints sit at tier 1 (Pro) — the productCatalog markets
 * "AI stock analysis & backtesting" as a Pro feature, and these paths are
 * also in PREMIUM_RPC_PATHS where the legacy bearer gate accepts tier >= 1.
 * Tier-2 here would have made the new gate stricter than the legacy one and
 * 403'd real Pro subscribers calling via Clerk session (no tester key).
 */
const ENDPOINT_ENTITLEMENTS: Record<string, number> = {
  '/api/forecast/v1/trigger-simulation': 1,
  '/api/intelligence/v1/classify-event': 1,
  '/api/intelligence/v1/get-country-intel-brief': 1,
  '/api/market/v1/analyze-stock': 1,
  '/api/market/v1/get-stock-analysis-history': 1,
  '/api/market/v1/backtest-stock': 1,
  '/api/market/v1/list-stored-stock-backtests': 1,
  '/api/economic/v1/list-global-tenders': 1,
  '/api/sanctions/v1/list-sanctions-pressure': 1,
  '/api/scenario/v1/run-scenario': 1,
  '/api/scenario/v1/get-scenario-status': 1,
  '/api/supply-chain/v1/get-country-chokepoint-index': 1,
  '/api/supply-chain/v1/get-bypass-options': 1,
  '/api/supply-chain/v1/get-country-cost-shock': 1,
  '/api/supply-chain/v1/get-route-explorer-lane': 1,
  '/api/supply-chain/v1/get-route-impact': 1,
  '/api/supply-chain/v1/get-country-products': 1,
  '/api/supply-chain/v1/get-multi-sector-cost-shock': 1,
  '/api/supply-chain/v1/get-sector-dependency': 1,
  '/api/trade/v1/list-comtrade-flows': 1,
  '/api/trade/v1/get-tariff-trends': 1,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the minimum tier required for a given endpoint pathname.
 * Returns null if the endpoint is unrestricted (not in the map).
 */
export function getRequiredTier(pathname: string): number | null {
  return ENDPOINT_ENTITLEMENTS[pathname] ?? null;
}

/**
 * True when the entitlement source is usable in principle. Post-Stage-1
 * this is a pure in-process function with no external backend to
 * misconfigure, so it is unconditionally true — kept only so gateway.ts's
 * existing (now-unreachable) misconfiguration branch keeps compiling.
 */
export function isEntitlementBackendConfigured(): boolean {
  return true;
}

/**
 * Returns the fixed synthesized entitlement for any non-empty userId, or
 * null when there is no userId to attribute an entitlement to.
 *
 * No Redis, no Convex, no network call: every verified Supabase user
 * (userId only exists once `resolveSupabaseSession`/`validateBearerToken`
 * has verified a Supabase-issued JWT, or a valid `worldmonitor.api_keys`
 * row was looked up) is granted the same fixed tier-1 "pro" entitlement.
 */
export async function getEntitlements(userId: string): Promise<CachedEntitlements | null> {
  if (!userId) return null;
  return {
    planKey: 'pro',
    features: {
      tier: 1,
      apiAccess: true,
      mcpAccess: true,
    },
    validUntil: Number.POSITIVE_INFINITY,
  };
}

/**
 * Turns Convex's billing-verification metadata into the shared gateway denial
 * contract. Post-Stage-1 this is permanently a no-op: nothing in this module
 * ever sets `billingStatus`/`verificationUnavailable` on an entitlement, so
 * this always returns null. Kept (signature-compatible) because
 * server/gateway.ts and api/mcp/auth.ts / api/widget-agent.ts still call it —
 * removing it would force restructuring out of Stage 1's scope.
 */
export function getBillingVerificationDenial(
  _entitlements: Pick<CachedEntitlements, 'billingStatus' | 'retryAfterSeconds' | 'verificationUnavailable'> | null | undefined,
  _corsHeaders: Record<string, string>,
  _requiredTier?: number,
): Response | null {
  return null;
}

/**
 * Checks whether the current request is allowed based on tier entitlements.
 *
 * Returns:
 *   - null if the request is allowed (unrestricted endpoint, or a verified
 *     userId on a tier-gated endpoint — every verified user is tier 1)
 *   - a 403 Response if the user is unauthenticated (fail-closed)
 */
export async function checkEntitlement(
  userId: string | null,
  pathname: string,
  corsHeaders: Record<string, string>,
  options: EntitlementCheckOptions = {},
): Promise<Response | null> {
  const result = await checkEntitlementDetailed(userId, pathname, corsHeaders, options);
  return result.response;
}

/**
 * Same authorization decision as checkEntitlement(), plus the resolved
 * entitlement row when one was available. Gateway telemetry uses this so
 * allow/deny events reflect the exact plan/tier that drove the decision.
 */
export async function checkEntitlementDetailed(
  userId: string | null,
  pathname: string,
  corsHeaders: Record<string, string>,
  options: EntitlementCheckOptions = {},
): Promise<EntitlementCheckResult> {
  const requiredTier = getRequiredTier(pathname);
  if (requiredTier === null) {
    // Unrestricted endpoint -- no check needed
    return { response: null, entitlements: null };
  }

  if (!userId) {
    return {
      response: new Response(
        JSON.stringify({ error: 'Authentication required', code: 'unauthenticated', requiredTier }),
        { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
      ),
      entitlements: null,
    };
  }

  // options.sessionRole is always 'pro' for a verified session post-Stage-1
  // (server/auth-session.ts), same conclusion getEntitlements() below
  // reaches independently. Short-circuit kept for gateway.ts call-site
  // compatibility (avoids one redundant getEntitlements call on the hot
  // path it was already skipping).
  if (options.sessionRole === 'pro' && requiredTier <= 1) {
    return { response: null, entitlements: null };
  }

  // Every non-empty userId resolves to the fixed tier-1 entitlement (see
  // getEntitlements above) — this branch is unreachable in practice but
  // kept for defensive fail-closed behavior if that ever changes.
  const ent = await getEntitlements(userId);
  if (!ent || ent.features.tier < requiredTier) {
    return {
      response: new Response(
        JSON.stringify({ error: 'Unable to verify entitlements', requiredTier }),
        { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
      ),
      entitlements: ent,
    };
  }

  return { response: null, entitlements: ent };
}
