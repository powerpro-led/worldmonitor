import { httpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { webhookHandler } from "./payments/webhookHandlers";
import { resendWebhookHandler } from "./resendWebhookHandler";

// Browser-facing CORS helpers (TRUSTED/EXPOSED_HEADERS/matchOrigin/allowedOrigin/
// corsHeaders) retired in Stage 2 of the Convex/Clerk -> Supabase migration
// alongside the Convex-native `/api/user-prefs` route — every other route in
// this file is server-to-server (shared-secret authenticated), not
// browser-facing, so no CORS handling is needed. See memory
// `supabase-migration-stage1`.

async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign("HMAC", keyMaterial, enc.encode(a)),
    crypto.subtle.sign("HMAC", keyMaterial, enc.encode(b)),
  ]);
  const aArr = new Uint8Array(sigA);
  const bArr = new Uint8Array(sigB);
  let diff = 0;
  for (let i = 0; i < aArr.length; i++) diff |= aArr[i]! ^ bArr[i]!;
  return diff === 0;
}

/** Parse a request body only when JSON produced an object (never null or an array). */
async function parseJsonObjectBody<T extends object>(request: Request): Promise<T | null> {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? body as T
      : null;
  } catch {
    return null;
  }
}

/**
 * Extract a stable error `code` from a thrown ConvexError.
 *
 * Convex's runtime serializes `error.data` to a JSON string before re-throwing
 * across the function boundary (see registration_impl::serializeConvexErrorData),
 * so by the time an http action's catch block sees the error, `err.data` is a
 * JSON-encoded string. Both shapes are handled:
 *   - `throw new ConvexError("PRO_REQUIRED")`  → data = '"PRO_REQUIRED"' → "PRO_REQUIRED"
 *   - `throw new ConvexError({code: "X", ...})` → data = '{"code":"X",…}'  → "X"
 */
function parseConvexErrorData(err: unknown): unknown {
  const raw = (err as { data?: unknown } | undefined)?.data;
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function extractConvexErrorCode(err: unknown): string | null {
  const parsed = parseConvexErrorData(err);
  if (typeof parsed === "string") return parsed;
  if (parsed && typeof parsed === "object") {
    const data = parsed as Record<string, unknown>;
    const code = data.code ?? data.kind;
    if (typeof code === "string") return code;
  }
  return null;
}

export async function internalEntitlementsHttpHandler(
  ctx: ActionCtx,
  request: Request,
): Promise<Response> {
    const providedSecret = request.headers.get("x-convex-shared-secret") ?? "";
    const expectedSecret = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
    if (!expectedSecret || !(await timingSafeEqualStrings(providedSecret, expectedSecret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{ userId?: unknown }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (
      typeof body.userId !== "string" ||
      body.userId.length === 0 ||
      body.userId.length > 256
    ) {
      return new Response(JSON.stringify({ error: "MISSING_USER_ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    let result = await ctx.runQuery(
      internal.entitlements.getEntitlementsByUserId,
      { userId: body.userId },
    );
    let billingStatus:
      | "subscription_lapsed"
      | "renewal_verification_pending"
      | "renewal_verification_failed"
      | undefined;
    let retryAfterSeconds: number | undefined;
    let renewalVerificationFreshness:
      | { status: "not_applicable"; checkedAt: number }
      | undefined;

    // Expired stored entitlements are deliberately returned as free-tier
    // defaults by the query. Before the gateway turns that into a hard denial,
    // give a recently-stale active subscription one bounded provider re-check.
    if (result.features.tier === 0) {
      const verification = await ctx.runAction(
        internal.payments.billing.verifyRecentlyStaleSubscriptionOnDemand,
        { userId: body.userId },
      );
      if (verification.status === "not_applicable") {
        renewalVerificationFreshness = {
          status: "not_applicable",
          checkedAt: Date.now(),
        };
      } else {
        // The provider action and a webhook can interleave. Always re-read the
        // source of truth before attaching a denial marker so a concurrent
        // renewal wins over a stale action result.
        result = await ctx.runQuery(
          internal.entitlements.getEntitlementsByUserId,
          { userId: body.userId },
        );
        // A stale materialized entitlement can point at the stronger row under
        // verification even while another lower-plan subscription is still
        // current. Preserve that known-good coverage in this response; the
        // billing marker remains attached so callers deny only capabilities
        // the fallback plan does not authorize.
        const fallbackState = await ctx.runQuery(
          internal.payments.billing.getOnDemandRenewalFallbackState,
          { userId: body.userId, now: Date.now() },
        );
        if (
          result.features.tier === 0 &&
          fallbackState?.currentEntitlement
        ) {
          result = fallbackState.currentEntitlement;
        }
        const staleFeatures = fallbackState?.strongestRecentlyStaleFeatures;
        const verificationCouldExpandCoverage = !!staleFeatures && (
          staleFeatures.tier > result.features.tier ||
          (staleFeatures.apiAccess && !result.features.apiAccess) ||
          (staleFeatures.mcpAccess && !result.features.mcpAccess)
        );
        if (
          verification.status !== "active" &&
          (
            result.features.tier === 0 ||
            verificationCouldExpandCoverage
          )
        ) {
          billingStatus = verification.status;
          if ("retryAfterSeconds" in verification) {
            retryAfterSeconds = verification.retryAfterSeconds;
          }
        }
      }
    }

    return new Response(JSON.stringify({
      ...result,
      ...(billingStatus ? { billingStatus } : {}),
      ...(retryAfterSeconds != null ? { retryAfterSeconds } : {}),
      ...(renewalVerificationFreshness ? { renewalVerificationFreshness } : {}),
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

const http = httpRouter();

http.route({
  path: "/api/internal-entitlements",
  method: "POST",
  handler: httpAction(internalEntitlementsHttpHandler),
});

// Convex-native `/api/user-prefs` (OPTIONS + POST) retired in Stage 2 of the
// Convex/Clerk -> Supabase migration alongside `convex/userPreferences.ts` —
// `api/user-prefs.ts` (Vercel edge) is the sole surface now, backed by
// `worldmonitor.user_preferences` (Postgres). See memory
// `supabase-migration-stage1`.

// `/api/telegram-pair-callback`, `/relay/deactivate`, `/relay/channels`,
// `/relay/notification-channels`, `/relay/digest-rules`, `/relay/enabled-rules`,
// and `/relay/entitlement` retired in Stage 3 of the Convex/Clerk -> Supabase
// migration alongside `convex/{notificationChannels,alertRules,telegramPairingTokens}.ts`
// — `worldmonitor.{notification_channels,alert_rules,telegram_pairing_tokens}`
// (Postgres) are read/written directly by `server/_shared/{notification-channels,
// alert-rules,telegram-pairing}.ts` and `scripts/lib/{notification-channels-fetch,
// alert-rules-fetch,telegram-pairing-cleanup}.cjs` now. The Telegram webhook target
// moved to the new Vercel edge function `api/telegram/pair-callback.ts`. See memory
// `supabase-migration-stage1`.

// ---------------------------------------------------------------------------
// Referral code registration (Phase 9 / Todo #223)
// ---------------------------------------------------------------------------

// Edge-route companion for /api/referral/me. Binds a Clerk-derived
// 8-char share code to the signed-in user's Clerk userId so future
// /pro?ref=<code> signups can credit the sharer via the
// userReferralCredits path in registerInterest:register. Auth is
// server-to-server via RELAY_SHARED_SECRET — the edge route already
// validated the caller's Clerk bearer before hitting this.
http.route({
  path: "/relay/register-referral-code",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RELAY_SHARED_SECRET ?? "";
    const provided = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/, "");
    if (!secret || !(await timingSafeEqualStrings(provided, secret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const body = await parseJsonObjectBody<{ userId?: string; code?: string }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!userId || !code || code.length < 4 || code.length > 32) {
      return new Response(JSON.stringify({ error: "userId + code required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const result = await ctx.runMutation(
      (internal as any).registerInterest.registerUserReferralCode,
      { userId, code },
    );
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ---------------------------------------------------------------------------
// User API key validation (service-to-service only)
// ---------------------------------------------------------------------------

// Service-to-service: validate a user API key by its SHA-256 hash.
// Called by the Vercel edge gateway to look up user-owned keys.
http.route({
  path: "/api/internal-validate-api-key",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const providedSecret = request.headers.get("x-convex-shared-secret") ?? "";
    const expectedSecret = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
    if (!expectedSecret || !(await timingSafeEqualStrings(providedSecret, expectedSecret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{ keyHash?: unknown }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof body.keyHash !== "string" || body.keyHash.length === 0) {
      return new Response(JSON.stringify({ error: "MISSING_KEY_HASH" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await ctx.runQuery(
      (internal as any).apiKeys.validateKeyByHash,
      { keyHash: body.keyHash },
    );

    if (result) {
      try {
        await ctx.scheduler.runAfter(0, (internal as any).apiKeys.touchKeyLastUsed, { keyId: result.id });
      } catch (err) {
        // sentry-coverage-ok: re-throwing here would 500 the gateway, which coerces to null
        // and stamps a 60s negative-cache sentinel for a valid key. lastUsedAt is best-effort telemetry.
        console.warn("[validate-api-key] touchKeyLastUsed schedule failed:", err instanceof Error ? err.message : String(err));
      }
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// Service-to-service: look up the owner of a key by hash (regardless of revoked status).
// Used by the cache-invalidation endpoint to verify tenancy boundaries.
http.route({
  path: "/api/internal-get-key-owner",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const providedSecret = request.headers.get("x-convex-shared-secret") ?? "";
    const expectedSecret = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
    if (!expectedSecret || !(await timingSafeEqualStrings(providedSecret, expectedSecret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{ keyHash?: unknown }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof body.keyHash !== "string" || !/^[a-f0-9]{64}$/.test(body.keyHash)) {
      return new Response(JSON.stringify({ error: "INVALID_KEY_HASH" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await ctx.runQuery(
      (internal as any).apiKeys.getKeyOwner,
      { keyHash: body.keyHash },
    );

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ---------------------------------------------------------------------------
// Pro MCP token routes (service-to-service, x-convex-shared-secret auth).
// Called by the Vercel edge (api/oauth/authorize-pro, api/mcp.ts, settings).
// See plan U1 / docs/plans/2026-05-10-001-feat-pro-mcp-clerk-auth-quota-plan.md
// ---------------------------------------------------------------------------

http.route({
  path: "/api/internal-issue-pro-mcp-token",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const providedSecret = request.headers.get("x-convex-shared-secret") ?? "";
    const expectedSecret = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
    if (!expectedSecret || !(await timingSafeEqualStrings(providedSecret, expectedSecret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{
      userId?: unknown;
      clientId?: unknown;
      name?: unknown;
    }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof body.userId !== "string" || body.userId.length === 0) {
      return new Response(JSON.stringify({ error: "MISSING_USER_ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const result = await ctx.runMutation(
        (internal as any).mcpProTokens.issueProMcpToken,
        {
          userId: body.userId,
          clientId: typeof body.clientId === "string" ? body.clientId : undefined,
          name: typeof body.name === "string" ? body.name : undefined,
        },
      );
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: unknown) {
      const code = extractConvexErrorCode(err);
      if (code === "PRO_REQUIRED") {
        return new Response(JSON.stringify({ error: "PRO_REQUIRED" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (code === "INVALID_USER_ID") {
        return new Response(JSON.stringify({ error: "INVALID_USER_ID" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw err;
    }
  }),
});

http.route({
  path: "/api/internal-validate-pro-mcp-token",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const providedSecret = request.headers.get("x-convex-shared-secret") ?? "";
    const expectedSecret = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
    if (!expectedSecret || !(await timingSafeEqualStrings(providedSecret, expectedSecret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{ tokenId?: unknown }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof body.tokenId !== "string" || body.tokenId.length === 0) {
      return new Response(JSON.stringify({ error: "MISSING_TOKEN_ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const result = await ctx.runQuery(
        (internal as any).mcpProTokens.validateProMcpToken,
        { tokenId: body.tokenId },
      );

      if (result) {
        try {
          await ctx.scheduler.runAfter(
            0,
            (internal as any).mcpProTokens.touchProMcpTokenLastUsed,
            { tokenId: body.tokenId },
          );
        } catch (err) {
          // sentry-coverage-ok: best-effort lastUsedAt bump; mirrors the
          // touchKeyLastUsed pattern in /api/internal-validate-api-key.
          console.warn(
            "[validate-pro-mcp-token] touch schedule failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: unknown) {
      // Convex `v.id("mcpProTokens")` validator rejects malformed ids with
      // a runtime error — surface as null (caller treats as "no such token")
      // instead of 500-ing the gateway.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ArgumentValidationError") || msg.includes("not a valid id")) {
        return new Response(JSON.stringify(null), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw err;
    }
  }),
});

http.route({
  path: "/api/internal-revoke-pro-mcp-token",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const providedSecret = request.headers.get("x-convex-shared-secret") ?? "";
    const expectedSecret = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
    if (!expectedSecret || !(await timingSafeEqualStrings(providedSecret, expectedSecret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{ userId?: unknown; tokenId?: unknown }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (typeof body.userId !== "string" || body.userId.length === 0) {
      return new Response(JSON.stringify({ error: "MISSING_USER_ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (typeof body.tokenId !== "string" || body.tokenId.length === 0) {
      return new Response(JSON.stringify({ error: "MISSING_TOKEN_ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Service-to-service revoke. The shared secret + supplied userId is the
    // tenancy gate (the user-facing /api/v1/mcp-pro-tokens revoke endpoint
    // re-validates ownership through requireUserId in the public mutation).
    // This route bypasses requireUserId because the edge caller is trusted
    // (e.g. authorize-pro rolling back an aborted issue).
    try {
      const result = await ctx.runMutation(
        (internal as any).mcpProTokens.internalRevokeProMcpToken,
        { userId: body.userId, tokenId: body.tokenId },
      );
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: unknown) {
      const code = extractConvexErrorCode(err);
      if (code === "NOT_FOUND") {
        return new Response(JSON.stringify({ error: "NOT_FOUND" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (code === "ALREADY_REVOKED") {
        return new Response(JSON.stringify({ error: "ALREADY_REVOKED" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ArgumentValidationError") || msg.includes("not a valid id")) {
        return new Response(JSON.stringify({ error: "NOT_FOUND" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw err;
    }
  }),
});

http.route({
  path: "/dodopayments-webhook",
  method: "POST",
  handler: webhookHandler,
});

// Service-to-service: Vercel edge gateway creates Dodo checkout sessions.
// Authenticated via RELAY_SHARED_SECRET; edge endpoint validates Clerk JWT
// and forwards the verified userId.
http.route({
  path: "/relay/create-checkout",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RELAY_SHARED_SECRET ?? "";
    const provided = (request.headers.get("Authorization") ?? "").replace(
      /^Bearer\s+/,
      "",
    );
    if (!secret || !(await timingSafeEqualStrings(provided, secret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{
      userId?: string;
      email?: string;
      name?: string;
      productId?: string;
      returnUrl?: string;
      discountCode?: string;
      referralCode?: string;
      bypassPendingGuard?: boolean;
    }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!body.userId || !body.productId) {
      return new Response(
        JSON.stringify({ error: "MISSING_FIELDS", required: ["userId", "productId"] }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      const result = await ctx.runAction(
        internal.payments.checkout.internalCreateCheckout,
        {
          userId: body.userId,
          email: body.email,
          name: body.name,
          productId: body.productId,
          returnUrl: body.returnUrl,
          discountCode: body.discountCode,
          referralCode: body.referralCode,
          bypassPendingGuard: body.bypassPendingGuard,
        },
      );
      if (
        result &&
        typeof result === "object" &&
        "blocked" in result &&
        result.blocked === true
      ) {
        // Both blocked shapes share { code, message }; the duplicate-subscription
        // block carries `subscription`, the pending-payment block (#4438) carries
        // `pendingPayment`. Forward whichever is present so the client dialog can
        // render. Both return 409 — the client discriminates on `error` (code).
        const blockedBody: Record<string, unknown> = {
          error: result.code,
          message: result.message,
        };
        if ("subscription" in result) blockedBody.subscription = result.subscription;
        if ("pendingPayment" in result) blockedBody.pendingPayment = result.pendingPayment;
        return new Response(JSON.stringify(blockedBody), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Checkout creation failed";
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

// Service-to-service: Vercel edge gateway creates Dodo customer portal sessions.
// Authenticated via RELAY_SHARED_SECRET; edge endpoint validates Clerk JWT
// and forwards the verified userId.
http.route({
  path: "/relay/customer-portal",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RELAY_SHARED_SECRET ?? "";
    const provided = (request.headers.get("Authorization") ?? "").replace(
      /^Bearer\s+/,
      "",
    );
    if (!secret || !(await timingSafeEqualStrings(provided, secret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{ userId?: string }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!body.userId) {
      return new Response(
        JSON.stringify({ error: "MISSING_FIELDS", required: ["userId"] }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      const result = await ctx.runAction(
        internal.payments.billing.internalGetCustomerPortalUrl,
        { userId: body.userId },
      );
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Customer portal creation failed";
      const status = msg === "No Dodo customer found for this user" ? 404 : 500;
      return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

// Resend webhook: captures bounce/complaint events and suppresses emails.
// Signature verification + internal mutation, same pattern as Dodo webhook.
http.route({
  path: "/resend-webhook",
  method: "POST",
  handler: resendWebhookHandler,
});

// Bulk email suppression: service-to-service, authenticated via RELAY_SHARED_SECRET.
// Used by the one-time import script (scripts/import-bounced-emails.mjs).
http.route({
  path: "/relay/bulk-suppress-emails",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RELAY_SHARED_SECRET ?? "";
    const provided = (request.headers.get("Authorization") ?? "").replace(
      /^Bearer\s+/,
      "",
    );
    if (!secret || !(await timingSafeEqualStrings(provided, secret))) {
      return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await parseJsonObjectBody<{
      emails: Array<{
        email: string;
        reason: "bounce" | "complaint" | "manual";
        source?: string;
      }>;
    }>(request);
    if (!body) {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!Array.isArray(body.emails) || body.emails.length === 0) {
      return new Response(
        JSON.stringify({ error: "MISSING_FIELDS", required: ["emails"] }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      const result = await ctx.runMutation(
        internal.emailSuppressions.bulkSuppress,
        { emails: body.emails },
      );
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Bulk suppress failed";
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

export default http;
