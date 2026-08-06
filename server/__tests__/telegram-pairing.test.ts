// @vitest-environment node

/**
 * Stage 3 of the Convex/Clerk -> Supabase migration —
 * `server/_shared/telegram-pairing.ts` replaced `convex/telegramPairingTokens.ts`
 * + the pairing-claim half of `convex/notificationChannels.ts`.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

const getSupabaseAdmin = vi.fn();
vi.mock("../_shared/supabase-admin", () => ({
  getSupabaseAdmin: (...a: unknown[]) => getSupabaseAdmin(...a),
}));

import {
  TelegramPairingError,
  createPairingToken,
  claimPairingToken,
  cleanupExpired,
} from "../_shared/telegram-pairing";

beforeEach(() => {
  getSupabaseAdmin.mockReset();
});

describe("createPairingToken", () => {
  test("throws CONFIG when Supabase is unconfigured", async () => {
    getSupabaseAdmin.mockReturnValue(null);
    await expect(createPairingToken("u1")).rejects.toMatchObject({ kind: "CONFIG" });
  });

  test("invalidates the user's other unused tokens, then inserts a fresh 43-char base64url token", async () => {
    const invalidateEq2 = vi.fn(async () => ({ error: null }));
    const invalidateEq1 = vi.fn(() => ({ eq: invalidateEq2 }));
    const update = vi.fn(() => ({ eq: invalidateEq1 }));
    const insert = vi.fn(async () => ({ error: null }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ update, insert })) });

    const result = await createPairingToken("u1", "full");

    expect(update).toHaveBeenCalledWith({ used: true });
    expect(invalidateEq1).toHaveBeenCalledWith("user_id", "u1");
    expect(invalidateEq2).toHaveBeenCalledWith("used", false);
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "u1", token: result.token, used: false, variant: "full",
    }));
  });
});

describe("claimPairingToken", () => {
  function mockTokenLookup(record: unknown) {
    const maybeSingle = vi.fn(async () => ({ data: record, error: null }));
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    return { select };
  }

  test("returns NOT_FOUND for an unknown token", async () => {
    const { select } = mockTokenLookup(null);
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ select })) });
    await expect(claimPairingToken("bogus", "chat1")).resolves.toEqual({ ok: false, reason: "NOT_FOUND" });
  });

  test("returns ALREADY_USED for a used token", async () => {
    const { select } = mockTokenLookup({ id: "t1", user_id: "u1", expires_at: new Date(Date.now() + 1000).toISOString(), used: true, variant: null });
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ select })) });
    await expect(claimPairingToken("tok", "chat1")).resolves.toEqual({ ok: false, reason: "ALREADY_USED" });
  });

  test("returns EXPIRED for a token past expiresAt", async () => {
    const { select } = mockTokenLookup({ id: "t1", user_id: "u1", expires_at: new Date(Date.now() - 1000).toISOString(), used: false, variant: null });
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ select })) });
    await expect(claimPairingToken("tok", "chat1")).resolves.toEqual({ ok: false, reason: "EXPIRED" });
  });

  test("claims successfully, upserts the telegram channel, and adds telegram to matching first-pair rules only", async () => {
    const record = { id: "t1", user_id: "u1", expires_at: new Date(Date.now() + 1000).toISOString(), used: false, variant: "full" };
    const { select: tokenSelect } = mockTokenLookup(record);

    const claimSelect = vi.fn(async () => ({ data: [{ id: "t1" }], error: null }));
    const claimEq2 = vi.fn(() => ({ select: claimSelect }));
    const claimEq1 = vi.fn(() => ({ eq: claimEq2 }));
    const claimUpdate = vi.fn(() => ({ eq: claimEq1 }));

    const channelMaybeSingle = vi.fn(async () => ({ data: null, error: null })); // no existing channel -> first pairing
    const channelSelectEq2 = vi.fn(() => ({ maybeSingle: channelMaybeSingle }));
    const channelSelectEq1 = vi.fn(() => ({ eq: channelSelectEq2 }));
    const channelUpsert = vi.fn(async () => ({ error: null }));

    const ruleUpdateEq = vi.fn(async () => ({ error: null }));
    const ruleUpdate = vi.fn(() => ({ eq: ruleUpdateEq }));
    const rulesEqVariant = vi.fn(async () => ({
      data: [{ id: "rule-1", channels: ["email"] }, { id: "rule-2", channels: ["telegram"] }],
      error: null,
    }));
    const rulesEqUser = vi.fn(() => ({ eq: rulesEqVariant }));
    const rulesSelect = vi.fn(() => ({ eq: rulesEqUser }));

    const from = vi.fn((table: string) => {
      if (table === "telegram_pairing_tokens") {
        return { select: tokenSelect, update: claimUpdate };
      }
      if (table === "notification_channels") {
        return { select: vi.fn(() => ({ eq: channelSelectEq1 })), upsert: channelUpsert };
      }
      return { select: rulesSelect, update: ruleUpdate };
    });
    getSupabaseAdmin.mockReturnValue({ from });

    const result = await claimPairingToken("tok", "chat-42");
    expect(result).toEqual({ ok: true, reason: null });

    expect(channelUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "u1", channel_type: "telegram", chat_id: "chat-42", verified: true }),
      { onConflict: "user_id,channel_type" },
    );
    // Scoped to the token's variant.
    expect(rulesEqUser).toHaveBeenCalledWith("user_id", "u1");
    expect(rulesEqVariant).toHaveBeenCalledWith("variant", "full");
    // Only rule-1 (missing 'telegram') gets patched; rule-2 already has it.
    expect(ruleUpdate).toHaveBeenCalledTimes(1);
    expect(ruleUpdate).toHaveBeenCalledWith({ channels: ["email", "telegram"] });
    expect(ruleUpdateEq).toHaveBeenCalledWith("id", "rule-1");
  });

  test("re-pairing (existing channel) skips the alert-rule backfill", async () => {
    const record = { id: "t1", user_id: "u1", expires_at: new Date(Date.now() + 1000).toISOString(), used: false, variant: null };
    const { select: tokenSelect } = mockTokenLookup(record);

    const claimSelect = vi.fn(async () => ({ data: [{ id: "t1" }], error: null }));
    const claimUpdate = vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ select: claimSelect })) })) }));

    const channelMaybeSingle = vi.fn(async () => ({ data: { id: "existing-channel" }, error: null })); // already paired
    const channelUpsert = vi.fn(async () => ({ error: null }));

    const rulesSelect = vi.fn();

    const from = vi.fn((table: string) => {
      if (table === "telegram_pairing_tokens") return { select: tokenSelect, update: claimUpdate };
      if (table === "notification_channels") {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: channelMaybeSingle })) })) })), upsert: channelUpsert };
      }
      return { select: rulesSelect };
    });
    getSupabaseAdmin.mockReturnValue({ from });

    const result = await claimPairingToken("tok", "chat-1");
    expect(result).toEqual({ ok: true, reason: null });
    expect(rulesSelect).not.toHaveBeenCalled();
  });
});

describe("cleanupExpired", () => {
  test("deletes every expired row and reports the count", async () => {
    const select = vi.fn(async () => ({ data: [{ id: "a" }, { id: "b" }], error: null }));
    const lt = vi.fn(() => ({ select }));
    const del = vi.fn(() => ({ lt }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ delete: del })) });

    await expect(cleanupExpired()).resolves.toEqual({ deleted: 2 });
  });
});

describe("TelegramPairingError", () => {
  test("carries the discriminant kind for callers to branch on", () => {
    const err = new TelegramPairingError("NETWORK", "boom");
    expect(err.kind).toBe("NETWORK");
    expect(err.name).toBe("TelegramPairingError");
    expect(err).toBeInstanceOf(Error);
  });
});
