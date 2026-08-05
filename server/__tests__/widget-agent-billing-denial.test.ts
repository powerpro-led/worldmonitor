// @vitest-environment node

/**
 * #4771 — the widget-agent Clerk-bearer path used to surface structured
 * billing-verification denials (403/503 + `code` + X-Billing-Verification +
 * Retry-After) BEFORE its legacy generic 403, via getBillingVerificationDenial
 * (shared with server/gateway.ts and api/mcp/auth.ts).
 *
 * Stage 1 (Supabase migration) rewrote getBillingVerificationDenial() into a
 * permanent no-op: getEntitlements() never sets billingStatus /
 * verificationUnavailable anymore (see server/_shared/entitlement-check.ts),
 * so api/widget-agent.ts's billing-verification branch can never fire. The
 * tests that pinned that branch's 503/403+code responses were deleted --
 * they asserted behavior that no longer exists, not a regression. What
 * remains is the legacy generic-403 fallback, which the widget-agent handler
 * still owns independently of that dead branch.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

const validateBearerToken = vi.fn();
vi.mock("../auth-session", () => ({
  validateBearerToken: (...a: unknown[]) => validateBearerToken(...a),
}));

const getEntitlements = vi.fn();
vi.mock("../_shared/entitlement-check", async (importActual) => {
  const actual = await importActual<typeof import("../_shared/entitlement-check")>();
  return {
    ...actual,
    getEntitlements: (...a: unknown[]) => getEntitlements(...a),
  };
});

// api/widget-agent.ts reads these at module load.
process.env.WIDGET_AGENT_KEY = "server-widget-key";
process.env.PRO_WIDGET_KEY = "server-pro-key";

const { default: handler } = await import("../../api/widget-agent");

const FREE_FEATURES = {
  tier: 0,
  apiAccess: false,
  apiRateLimit: 0,
  maxDashboards: 1,
  prioritySupport: false,
  exportFormats: [] as string[],
};

function bearerRequest(): Request {
  return new Request("https://www.worldmonitor.app/api/widget-agent", {
    method: "POST",
    headers: {
      Origin: "https://www.worldmonitor.app",
      "Content-Type": "application/json",
      Authorization: "Bearer test-session-token",
    },
    body: JSON.stringify({ prompt: "Build a widget", mode: "create", tier: "basic" }),
  });
}

beforeEach(() => {
  validateBearerToken.mockReset();
  getEntitlements.mockReset();
  validateBearerToken.mockResolvedValue({ valid: true, userId: "user_wa_billing", role: "free" });
});

describe("widget-agent billing-verification denial (#4771)", () => {
  // Deleted: "renewal_verification_pending: 503 + code + marker header +
  // Retry-After", "subscription_lapsed: confirmed denial stays a 403 with
  // the stable code", and "verificationUnavailable marker: retryable 503,
  // not a hard denial" -- all three fed getEntitlements() a billingStatus /
  // verificationUnavailable shape that the real getEntitlements() can never
  // produce post-Stage-1, so getBillingVerificationDenial() (now a permanent
  // no-op) never returns a denial for them. The handler now falls through to
  // the plain "Pro subscription required" 403 covered below instead of the
  // structured 503/403+code responses these tests asserted -- that's tested
  // removed functionality, not a regression, per the module-header FIXME in
  // server/_shared/entitlement-check.ts.

  test("plain free-tier row: legacy generic 403, no billing marker", async () => {
    getEntitlements.mockResolvedValue({
      planKey: "free",
      features: FREE_FEATURES,
      validUntil: 0,
    });

    const res = await handler(bearerRequest());
    expect(res.status).toBe(403);
    expect(res.headers.get("X-Billing-Verification")).toBeNull();
    const body = await res.json();
    expect(body.error).toBe("Pro subscription required");
    expect(body.code).toBeUndefined();
  });

  test("null entitlement lookup: fail-closed generic 403, no billing marker", async () => {
    getEntitlements.mockResolvedValue(null);

    const res = await handler(bearerRequest());
    expect(res.status).toBe(403);
    expect(res.headers.get("X-Billing-Verification")).toBeNull();
    const body = await res.json();
    expect(body.error).toBe("Pro subscription required");
  });
});
