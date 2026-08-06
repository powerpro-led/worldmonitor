// @vitest-environment node

/**
 * Stage 3 of the Convex/Clerk -> Supabase migration —
 * `server/_shared/notification-channels.ts` replaced `convex/notificationChannels.ts`.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

const getSupabaseAdmin = vi.fn();
vi.mock("../_shared/supabase-admin", () => ({
  getSupabaseAdmin: (...a: unknown[]) => getSupabaseAdmin(...a),
}));

import {
  NotificationChannelsError,
  getChannels,
  setChannel,
  setWebPushChannel,
  setSlackOAuthChannel,
  setDiscordOAuthChannel,
  deleteChannel,
  deactivateChannel,
} from "../_shared/notification-channels";

beforeEach(() => {
  getSupabaseAdmin.mockReset();
});

describe("getChannels", () => {
  test("throws CONFIG when Supabase is unconfigured", async () => {
    getSupabaseAdmin.mockReturnValue(null);
    await expect(getChannels("u1")).rejects.toMatchObject({ kind: "CONFIG" });
  });

  test("maps rows to camelCase, omitting null fields", async () => {
    const eq = vi.fn(async () => ({
      data: [{
        id: "row-1",
        channel_type: "email",
        verified: true,
        linked_at: "2026-01-01T00:00:00.000Z",
        chat_id: null,
        webhook_envelope: null,
        webhook_label: null,
        email: "a@example.com",
        slack_channel_name: null,
        slack_team_name: null,
        slack_configuration_url: null,
        discord_guild_id: null,
        discord_channel_id: null,
        endpoint: null,
        p256dh: null,
        auth: null,
        user_agent: null,
      }],
      error: null,
    }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ select: vi.fn(() => ({ eq })) })) });

    await expect(getChannels("u1")).resolves.toEqual([{
      id: "row-1",
      channelType: "email",
      verified: true,
      linkedAt: Date.parse("2026-01-01T00:00:00.000Z"),
      email: "a@example.com",
    }]);
  });

  test("throws NETWORK on a Supabase error", async () => {
    const eq = vi.fn(async () => ({ data: null, error: { message: "boom" } }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ select: vi.fn(() => ({ eq })) })) });
    await expect(getChannels("u1")).rejects.toMatchObject({ kind: "NETWORK" });
  });
});

describe("setChannel", () => {
  function mockUpsertChain(existing: unknown, upsertedId = "row-1") {
    const maybeSingleExisting = vi.fn(async () => ({ data: existing, error: null }));
    const single = vi.fn(async () => ({ data: { id: upsertedId }, error: null }));
    const select = vi.fn(() => ({ single }));
    const upsert = vi.fn(() => ({ select }));
    const from = vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: maybeSingleExisting })) })) })),
      upsert,
    }));
    getSupabaseAdmin.mockReturnValue({ from });
    return { upsert };
  }

  test("throws MISSING_FIELD for telegram without chatId, without touching Supabase", async () => {
    await expect(setChannel("u1", "telegram", {})).rejects.toMatchObject({ kind: "MISSING_FIELD" });
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
  });

  test("throws MISSING_FIELD for slack without webhookEnvelope", async () => {
    await expect(setChannel("u1", "slack", {})).rejects.toMatchObject({ kind: "MISSING_FIELD" });
  });

  test("throws MISSING_FIELD for email without email", async () => {
    await expect(setChannel("u1", "email", {})).rejects.toMatchObject({ kind: "MISSING_FIELD" });
  });

  test("throws MISSING_FIELD for webhook without webhookEnvelope", async () => {
    await expect(setChannel("u1", "webhook", {})).rejects.toMatchObject({ kind: "MISSING_FIELD" });
  });

  test("upserts a new telegram channel and reports isNew:true with the row id", async () => {
    mockUpsertChain(null, "new-row-id");
    await expect(setChannel("u1", "telegram", { chatId: "123" }))
      .resolves.toEqual({ isNew: true, id: "new-row-id" });
  });

  test("reports isNew:false when a row already existed", async () => {
    mockUpsertChain({ id: "existing-row" }, "existing-row");
    await expect(setChannel("u1", "email", { email: "a@example.com" }))
      .resolves.toEqual({ isNew: false, id: "existing-row" });
  });
});

describe("setWebPushChannel", () => {
  test("deletes cross-account rows sharing the endpoint before upserting", async () => {
    const maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    const neq = vi.fn(async () => ({ error: null }));
    const deleteEq2 = vi.fn(() => ({ neq }));
    const deleteEq1 = vi.fn(() => ({ eq: deleteEq2 }));
    const single = vi.fn(async () => ({ data: { id: "push-row" }, error: null }));
    const upsertSelect = vi.fn(() => ({ single }));
    const upsert = vi.fn(() => ({ select: upsertSelect }));
    const from = vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })) })),
      delete: vi.fn(() => ({ eq: deleteEq1 })),
      upsert,
    }));
    getSupabaseAdmin.mockReturnValue({ from });

    const result = await setWebPushChannel("u1", { endpoint: "https://fcm.googleapis.com/x", p256dh: "p", auth: "a" });
    expect(result).toEqual({ isNew: true, id: "push-row" });
    expect(deleteEq1).toHaveBeenCalledWith("channel_type", "web_push");
    expect(deleteEq2).toHaveBeenCalledWith("endpoint", "https://fcm.googleapis.com/x");
    expect(neq).toHaveBeenCalledWith("user_id", "u1");
  });
});

describe("setSlackOAuthChannel / setDiscordOAuthChannel", () => {
  function mockChain() {
    const maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    const upsert = vi.fn(async () => ({ error: null }));
    const from = vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })) })),
      upsert,
    }));
    getSupabaseAdmin.mockReturnValue({ from });
    return { upsert };
  }

  test("setSlackOAuthChannel upserts the encrypted webhook envelope", async () => {
    const { upsert } = mockChain();
    await expect(setSlackOAuthChannel("u1", { webhookEnvelope: "v1:xyz", slackChannelName: "#alerts" }))
      .resolves.toEqual({ isNew: true });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ channel_type: "slack", webhook_envelope: "v1:xyz", slack_channel_name: "#alerts" }),
      { onConflict: "user_id,channel_type" },
    );
  });

  test("setDiscordOAuthChannel upserts the encrypted webhook envelope", async () => {
    const { upsert } = mockChain();
    await expect(setDiscordOAuthChannel("u1", { webhookEnvelope: "v1:abc" }))
      .resolves.toEqual({ isNew: true });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ channel_type: "discord", webhook_envelope: "v1:abc" }),
      { onConflict: "user_id,channel_type" },
    );
  });
});

describe("deleteChannel", () => {
  test("deletes the channel row and strips it from every matching alert_rules.channels array", async () => {
    const deleteEq2 = vi.fn(async () => ({ error: null }));
    const deleteEq1 = vi.fn(() => ({ eq: deleteEq2 }));
    const rulesSelectEq = vi.fn(async () => ({
      data: [
        { id: "rule-1", channels: ["telegram", "email"] },
        { id: "rule-2", channels: ["email"] },
      ],
      error: null,
    }));
    const updateEq = vi.fn(async () => ({ error: null }));
    const update = vi.fn(() => ({ eq: updateEq }));

    let fromCallCount = 0;
    const from = vi.fn((table: string) => {
      fromCallCount++;
      if (table === "notification_channels") {
        return { delete: vi.fn(() => ({ eq: deleteEq1 })) };
      }
      return {
        select: vi.fn(() => ({ eq: rulesSelectEq })),
        update,
      };
    });
    getSupabaseAdmin.mockReturnValue({ from });

    await deleteChannel("u1", "telegram");

    // 1 (delete channel) + 1 (select rules) + 1 (update rule-1, the only
    // rule that actually contains 'telegram') = 3.
    expect(fromCallCount).toBe(3);
    // Only rule-1 contains 'telegram' — only it gets patched.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ channels: ["email"] });
    expect(updateEq).toHaveBeenCalledWith("id", "rule-1");
  });
});

describe("deactivateChannel", () => {
  test("sets verified:false for the given user + channelType", async () => {
    const eq2 = vi.fn(async () => ({ error: null }));
    const eq1 = vi.fn(() => ({ eq: eq2 }));
    const update = vi.fn(() => ({ eq: eq1 }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ update })) });

    await deactivateChannel("u1", "slack");
    expect(update).toHaveBeenCalledWith({ verified: false });
    expect(eq1).toHaveBeenCalledWith("user_id", "u1");
    expect(eq2).toHaveBeenCalledWith("channel_type", "slack");
  });
});

describe("NotificationChannelsError", () => {
  test("carries the discriminant kind for callers to branch on", () => {
    const err = new NotificationChannelsError("MISSING_FIELD", "chatId required");
    expect(err.kind).toBe("MISSING_FIELD");
    expect(err.name).toBe("NotificationChannelsError");
    expect(err).toBeInstanceOf(Error);
  });
});
