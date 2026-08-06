// @vitest-environment node

/**
 * Stage 3 of the Convex/Clerk -> Supabase migration —
 * `server/_shared/alert-rules.ts` replaced `convex/alertRules.ts`. Collapses
 * Convex's public-mutation/internal-mutation split (setDigestSettings +
 * setDigestSettingsForUser, setQuietHours + setQuietHoursForUser) into one
 * function each, since there's only one caller (api/notification-channels.ts)
 * and no public/internal distinction in Postgres.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

const getSupabaseAdmin = vi.fn();
vi.mock("../_shared/supabase-admin", () => ({
  getSupabaseAdmin: (...a: unknown[]) => getSupabaseAdmin(...a),
}));

import {
  AlertRulesError,
  getAlertRules,
  setAlertRules,
  setDigestSettings,
  setQuietHours,
  setNotificationConfig,
  getDigestRules,
  getByEnabled,
} from "../_shared/alert-rules";

beforeEach(() => {
  getSupabaseAdmin.mockReset();
});

/** Mocks the loadExisting() read + upsertRule() write chain used by every setter. */
function mockRuleChain(existingRow: unknown) {
  const maybeSingle = vi.fn(async () => ({ data: existingRow, error: null }));
  const eqVariant = vi.fn(() => ({ maybeSingle }));
  const eqUser = vi.fn(() => ({ eq: eqVariant }));
  const select = vi.fn(() => ({ eq: eqUser }));
  const upsert = vi.fn(async () => ({ error: null }));
  const from = vi.fn(() => ({ select, upsert }));
  getSupabaseAdmin.mockReturnValue({ from });
  return { upsert };
}

describe("getAlertRules", () => {
  test("throws CONFIG when Supabase is unconfigured", async () => {
    getSupabaseAdmin.mockReturnValue(null);
    await expect(getAlertRules("u1")).rejects.toMatchObject({ kind: "CONFIG" });
  });

  test("strips userId from the returned rows", async () => {
    const eq = vi.fn(async () => ({
      data: [{
        id: "r1", user_id: "u1", variant: "full", enabled: true, event_types: ["rss_alert"],
        sensitivity: "critical", channels: ["email"], quiet_hours_enabled: null, quiet_hours_start: null,
        quiet_hours_end: null, quiet_hours_timezone: null, quiet_hours_override: null, digest_mode: null,
        digest_hour: null, digest_timezone: null, ai_digest_enabled: null, countries: null, tickers: null,
      }],
      error: null,
    }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ select: vi.fn(() => ({ eq })) })) });

    const rules = await getAlertRules("u1");
    expect(rules).toEqual([{
      variant: "full", enabled: true, eventTypes: ["rss_alert"], sensitivity: "critical", channels: ["email"],
    }]);
  });
});

describe("setAlertRules", () => {
  test("throws INCOMPATIBLE_DELIVERY for realtime+all", async () => {
    mockRuleChain(null);
    await expect(setAlertRules("u1", "full", {
      enabled: true, eventTypes: [], channels: [], sensitivity: "all",
    })).rejects.toMatchObject({ kind: "INCOMPATIBLE_DELIVERY" });
  });

  test("throws COUNTRIES_LIMIT_EXCEEDED past the 50-entry cap", async () => {
    mockRuleChain(null);
    // 51 distinct 2-uppercase-letter shapes (AA, AB, ... AY) — must be
    // shape-valid (^[A-Z]{2}$) or normalizeCountries drops them before the
    // cap check ever runs.
    const countries = Array.from({ length: 51 }, (_, i) =>
      String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)));
    await expect(setAlertRules("u1", "full", {
      enabled: true, eventTypes: [], channels: [], countries,
    })).rejects.toMatchObject({ kind: "COUNTRIES_LIMIT_EXCEEDED" });
  });

  test("throws TICKERS_LIMIT_EXCEEDED past the 50-entry cap", async () => {
    mockRuleChain(null);
    const tickers = Array.from({ length: 51 }, (_, i) => `T${i}`);
    await expect(setAlertRules("u1", "full", {
      enabled: true, eventTypes: [], channels: [], tickers,
    })).rejects.toMatchObject({ kind: "TICKERS_LIMIT_EXCEEDED" });
  });

  test("preserves existing sensitivity when the caller omits it (patch path)", async () => {
    const { upsert } = mockRuleChain({
      id: "r1", sensitivity: "high", digest_mode: "daily", channels: ["email"],
    });
    await setAlertRules("u1", "full", { enabled: true, eventTypes: ["rss_alert"], channels: ["email"] });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ sensitivity: "high" }),
      { onConflict: "user_id,variant" },
    );
  });

  test("defaults sensitivity to critical on a fresh insert", async () => {
    const { upsert } = mockRuleChain(null);
    await setAlertRules("u1", "full", { enabled: true, eventTypes: [], channels: [] });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ sensitivity: "critical" }),
      { onConflict: "user_id,variant" },
    );
  });

  test("normalizes countries (uppercase, dedupe, shape-filter)", async () => {
    const { upsert } = mockRuleChain(null);
    await setAlertRules("u1", "full", {
      enabled: true, eventTypes: [], channels: [], countries: ["us", "US", "xx1", "gb"],
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ countries: ["US", "GB"] }),
      { onConflict: "user_id,variant" },
    );
  });
});

describe("setDigestSettings", () => {
  test("throws INVALID_INPUT for an out-of-range digestHour", async () => {
    mockRuleChain(null);
    await expect(setDigestSettings("u1", "full", { digestMode: "daily", digestHour: 24 }))
      .rejects.toMatchObject({ kind: "INVALID_INPUT" });
  });

  test("throws INVALID_INPUT for a bogus IANA timezone", async () => {
    mockRuleChain(null);
    await expect(setDigestSettings("u1", "full", { digestMode: "daily", digestTimezone: "Not/AZone" }))
      .rejects.toMatchObject({ kind: "INVALID_INPUT" });
  });

  // Regression: the first migration pass dropped `countries` from this
  // function's args entirely (it mirrored Convex's near-unused PUBLIC
  // `setDigestSettings` mutation instead of the internal `ForUser` variant
  // actually reachable from api/notification-channels.ts, which DID accept
  // countries). Locked in here so it can't silently regress again.
  test("forwards and normalizes countries", async () => {
    const { upsert } = mockRuleChain(null);
    await setDigestSettings("u1", "full", { digestMode: "daily", countries: ["us", "gb"] });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ countries: ["US", "GB"] }),
      { onConflict: "user_id,variant" },
    );
  });

  test("preserves existing countries when the caller omits the field", async () => {
    const { upsert } = mockRuleChain({ id: "r1", countries: ["FR"], sensitivity: "critical" });
    await setDigestSettings("u1", "full", { digestMode: "weekly" });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ countries: ["FR"] }),
      { onConflict: "user_id,variant" },
    );
  });
});

describe("setQuietHours", () => {
  test("throws INVALID_INPUT when quietHoursStart === quietHoursEnd and enabled", async () => {
    mockRuleChain(null);
    await expect(setQuietHours("u1", "full", {
      quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 22,
    })).rejects.toMatchObject({ kind: "INVALID_INPUT" });
  });

  test("allows start === end when quiet hours are disabled", async () => {
    const { upsert } = mockRuleChain(null);
    await setQuietHours("u1", "full", { quietHoursEnabled: false, quietHoursStart: 22, quietHoursEnd: 22 });
    expect(upsert).toHaveBeenCalled();
  });

  test("does not gate on the (digestMode, sensitivity) invariant", async () => {
    // A pre-existing forbidden row (realtime+all) must not block an
    // unrelated quiet-hours update — see convex/alertRules.ts::setQuietHours
    // for the original rationale, ported verbatim.
    const { upsert } = mockRuleChain({ id: "r1", digest_mode: "realtime", sensitivity: "all" });
    await setQuietHours("u1", "full", { quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 6 });
    expect(upsert).toHaveBeenCalled();
  });
});

describe("setNotificationConfig", () => {
  test("atomically updates only the fields supplied, preserving the rest", async () => {
    const { upsert } = mockRuleChain({
      id: "r1", enabled: true, event_types: ["rss_alert"], sensitivity: "high", channels: ["email"],
      digest_mode: "daily",
    });
    await setNotificationConfig("u1", "full", { enabled: false });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, sensitivity: "high", channels: ["email"], digest_mode: "daily" }),
      { onConflict: "user_id,variant" },
    );
  });

  test("throws INCOMPATIBLE_DELIVERY when switching to realtime+all atomically", async () => {
    mockRuleChain(null);
    await expect(setNotificationConfig("u1", "full", { digestMode: "realtime", sensitivity: "all" }))
      .rejects.toMatchObject({ kind: "INCOMPATIBLE_DELIVERY" });
  });
});

describe("getDigestRules / getByEnabled — service-role, no user scoping", () => {
  test("getDigestRules filters enabled=true AND digest_mode not null/realtime", async () => {
    const neq = vi.fn(async () => ({ data: [], error: null }));
    const not = vi.fn(() => ({ neq }));
    const eq = vi.fn(() => ({ not }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ select: vi.fn(() => ({ eq })) })) });

    await getDigestRules();
    expect(eq).toHaveBeenCalledWith("enabled", true);
    expect(not).toHaveBeenCalledWith("digest_mode", "is", null);
    expect(neq).toHaveBeenCalledWith("digest_mode", "realtime");
  });

  test("getByEnabled(true) returns rows including userId (cross-tenant shape)", async () => {
    const eq = vi.fn(async () => ({
      data: [{
        id: "r1", user_id: "u1", variant: "full", enabled: true, event_types: [],
        sensitivity: "critical", channels: [], quiet_hours_enabled: null, quiet_hours_start: null,
        quiet_hours_end: null, quiet_hours_timezone: null, quiet_hours_override: null, digest_mode: null,
        digest_hour: null, digest_timezone: null, ai_digest_enabled: null, countries: null, tickers: null,
      }],
      error: null,
    }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ select: vi.fn(() => ({ eq })) })) });

    const rules = await getByEnabled(true);
    expect(rules).toEqual([{ userId: "u1", variant: "full", enabled: true, eventTypes: [], sensitivity: "critical", channels: [] }]);
  });
});

describe("AlertRulesError", () => {
  test("carries the discriminant kind for callers to branch on", () => {
    const err = new AlertRulesError("TICKERS_LIMIT_EXCEEDED", "too many");
    expect(err.kind).toBe("TICKERS_LIMIT_EXCEEDED");
    expect(err.name).toBe("AlertRulesError");
    expect(err).toBeInstanceOf(Error);
  });
});
