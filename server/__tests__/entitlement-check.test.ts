// @vitest-environment node

/**
 * Unit tests for gateway entitlement check logic.
 *
 * Stage 1 (Supabase migration) rewrote getEntitlements() as a pure function
 * of "is there a userId" -- any non-empty userId gets a fixed synthesized
 * tier-1 "pro" entitlement. There is no Redis cache, no Convex HTTP
 * fallback, and no billing-verification retry state left to mock, so these
 * tests call the module directly with no vi.mock() setup at all.
 */

import { describe, test, expect } from "vitest";
import {
  getRequiredTier,
  checkEntitlement,
  checkEntitlementDetailed,
  getEntitlements,
  getBillingVerificationDenial,
  isEntitlementBackendConfigured,
} from "../_shared/entitlement-check";

const FIXED_ENTITLEMENT = {
  planKey: "pro",
  features: { tier: 1, apiAccess: true, mcpAccess: true },
  validUntil: Number.POSITIVE_INFINITY,
};

describe("gateway entitlement check", () => {
  test.each([
    "/api/intelligence/v1/classify-event",
    "/api/market/v1/analyze-stock",
    "/api/market/v1/get-stock-analysis-history",
    "/api/market/v1/backtest-stock",
    "/api/market/v1/list-stored-stock-backtests",
  ])("getRequiredTier returns 1 for %s (regression-lock against tier-2 revert)", (path) => {
    expect(getRequiredTier(path)).toBe(1);
  });

  test("getRequiredTier returns null for ungated endpoint", () => {
    expect(getRequiredTier("/api/seismology/v1/list-earthquakes")).toBeNull();
  });

  test("checkEntitlement returns null for ungated endpoint regardless of auth", async () => {
    expect(await checkEntitlement(null, "/api/seismology/v1/list-earthquakes", {})).toBeNull();
    expect(await checkEntitlement("some-user", "/api/seismology/v1/list-earthquakes", {})).toBeNull();
  });

  test("checkEntitlement returns 403 when no userId is provided (fail-closed)", async () => {
    const result = await checkEntitlement(null, "/api/market/v1/analyze-stock", {});
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);

    const body = await result!.json();
    expect(body.error).toBe("Authentication required");
    expect(body.code).toBe("unauthenticated");
    expect(body.requiredTier).toBe(1);
  });

  test("checkEntitlement returns 403 for empty-string userId (fail-closed)", async () => {
    const result = await checkEntitlement("", "/api/market/v1/analyze-stock", {});
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  test("checkEntitlement returns null (allowed) for any non-empty userId on a tier-1 endpoint", async () => {
    expect(await checkEntitlement("any-verified-user", "/api/market/v1/analyze-stock", {})).toBeNull();
    expect(await checkEntitlement("another-user", "/api/market/v1/analyze-stock", {})).toBeNull();
  });

  test("checkEntitlement accepts sessionRole=pro short-circuit for tier-1 gates", async () => {
    const result = await checkEntitlement(
      "test-user",
      "/api/market/v1/analyze-stock",
      {},
      { sessionRole: "pro" },
    );
    expect(result).toBeNull();
  });

  test("checkEntitlementDetailed surfaces the resolved entitlement alongside the allow decision", async () => {
    const result = await checkEntitlementDetailed("test-user", "/api/market/v1/analyze-stock", {});
    expect(result.response).toBeNull();
    expect(result.entitlements).toEqual(FIXED_ENTITLEMENT);
  });

  test("checkEntitlementDetailed returns null entitlements alongside the 403 when unauthenticated", async () => {
    const result = await checkEntitlementDetailed(null, "/api/market/v1/analyze-stock", {});
    expect(result.response).not.toBeNull();
    expect(result.response!.status).toBe(403);
    expect(result.entitlements).toBeNull();
  });

  test("isEntitlementBackendConfigured is unconditionally true (no external backend left to misconfigure)", () => {
    expect(isEntitlementBackendConfigured()).toBe(true);
  });

  test("getBillingVerificationDenial is a permanent no-op post-Stage-1", () => {
    // FIXME(stage1-supabase-migration): api/widget-agent.ts, server/gateway.ts,
    // and api/mcp/auth.ts still call getBillingVerificationDenial() and branch
    // on a truthy result to surface structured 503/403 billing-verification
    // denials (see server/__tests__/widget-agent-billing-denial.test.ts). Since
    // getEntitlements() here never sets billingStatus/verificationUnavailable
    // on the entitlements it synthesizes, that branch is now permanently dead
    // at every call site -- not a behavior regression (nothing upstream can
    // still produce those states), but the dead branches and their
    // "Renewal verification pending" / "Subscription lapsed" wire-contract
    // code paths in those files are left over from pre-Stage-1 Dodo billing
    // and could be pruned in a later cleanup pass.
    expect(getBillingVerificationDenial(null, {})).toBeNull();
    expect(
      getBillingVerificationDenial(
        { billingStatus: "subscription_lapsed", retryAfterSeconds: 5, verificationUnavailable: true },
        {},
        1,
      ),
    ).toBeNull();
  });
});

describe("getEntitlements (pure, no I/O)", () => {
  test("returns null for an empty userId", async () => {
    expect(await getEntitlements("")).toBeNull();
  });

  test("returns the fixed tier-1 pro entitlement for any non-empty userId", async () => {
    expect(await getEntitlements("user-a")).toEqual(FIXED_ENTITLEMENT);
    expect(await getEntitlements("user-b")).toEqual(FIXED_ENTITLEMENT);
  });

  test("does not vary by userId identity -- no per-account tiers left", async () => {
    const a = await getEntitlements("user-a");
    const b = await getEntitlements("wildly-different-user-id");
    expect(a).toEqual(b);
  });
});
