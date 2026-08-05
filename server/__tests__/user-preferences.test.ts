// @vitest-environment node

/**
 * Stage 2 of the Convex/Clerk -> Supabase migration —
 * `server/_shared/user-preferences.ts` replaced `convex/userPreferences.ts`.
 * These tests cover the Postgres-backed read/write path in isolation from
 * `api/user-prefs.ts` (which is covered by `tests/user-prefs-rate-limit.test.mts`
 * against an injected fake of this module).
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

const getSupabaseAdmin = vi.fn();
vi.mock("../_shared/supabase-admin", () => ({
  getSupabaseAdmin: (...a: unknown[]) => getSupabaseAdmin(...a),
}));

import {
  CURRENT_PREFS_SCHEMA_VERSION,
  MAX_PREFS_BLOB_SIZE,
  getUserPreferences,
  setUserPreferences,
} from "../_shared/user-preferences";

function makeSelectBuilder(result: { data: unknown; error: { message: string } | null }) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(async () => result);
  return builder;
}

beforeEach(() => {
  getSupabaseAdmin.mockReset();
});

describe("getUserPreferences", () => {
  test("returns null when Supabase is unconfigured", async () => {
    getSupabaseAdmin.mockReturnValue(null);
    await expect(getUserPreferences("u1", "full")).resolves.toBeNull();
  });

  test("returns null (not an error) when no row exists", async () => {
    const from = vi.fn(() => makeSelectBuilder({ data: null, error: null }));
    getSupabaseAdmin.mockReturnValue({ from });
    await expect(getUserPreferences("u1", "full")).resolves.toBeNull();
    expect(from).toHaveBeenCalledWith("user_preferences");
  });

  test("maps snake_case columns to the camelCase wire shape", async () => {
    const row = { data: { theme: "dark" }, schema_version: 2, sync_version: 5, updated_at: "2026-01-01T00:00:00.000Z" };
    const from = vi.fn(() => makeSelectBuilder({ data: row, error: null }));
    getSupabaseAdmin.mockReturnValue({ from });
    const result = await getUserPreferences("u1", "full");
    expect(result).toEqual({
      data: { theme: "dark" },
      schemaVersion: 2,
      syncVersion: 5,
      updatedAt: Date.parse("2026-01-01T00:00:00.000Z"),
    });
  });

  test("returns null on a Supabase error (fail-soft)", async () => {
    const from = vi.fn(() => makeSelectBuilder({ data: null, error: { message: "boom" } }));
    getSupabaseAdmin.mockReturnValue({ from });
    await expect(getUserPreferences("u1", "full")).resolves.toBeNull();
  });
});

describe("setUserPreferences", () => {
  test("rejects an oversized blob before calling the RPC", async () => {
    const rpc = vi.fn();
    getSupabaseAdmin.mockReturnValue({ rpc });
    const oversized = "x".repeat(MAX_PREFS_BLOB_SIZE + 1);
    const result = await setUserPreferences("u1", "full", oversized, 0);
    expect(result).toEqual({ ok: false, reason: "BLOB_TOO_LARGE", size: JSON.stringify(oversized).length, max: MAX_PREFS_BLOB_SIZE });
    expect(rpc).not.toHaveBeenCalled();
  });

  test("returns SERVICE_UNAVAILABLE when Supabase is unconfigured", async () => {
    getSupabaseAdmin.mockReturnValue(null);
    const result = await setUserPreferences("u1", "full", { a: 1 }, 0);
    expect(result).toEqual({ ok: false, reason: "SERVICE_UNAVAILABLE" });
  });

  test("calls the RPC with the expected args and defaults schemaVersion", async () => {
    const rpc = vi.fn(async () => ({ data: [{ ok: true, sync_version: 1, conflict: false }], error: null }));
    getSupabaseAdmin.mockReturnValue({ rpc });
    const result = await setUserPreferences("u1", "full", { a: 1 }, 0);
    expect(result).toEqual({ ok: true, syncVersion: 1 });
    expect(rpc).toHaveBeenCalledWith("set_user_preferences", {
      p_user_id: "u1",
      p_variant: "full",
      p_data: { a: 1 },
      p_expected_sync_version: 0,
      p_schema_version: CURRENT_PREFS_SCHEMA_VERSION,
    });
  });

  test("maps a conflict row to a CONFLICT result with actualSyncVersion", async () => {
    const rpc = vi.fn(async () => ({ data: [{ ok: false, sync_version: 3, conflict: true }], error: null }));
    getSupabaseAdmin.mockReturnValue({ rpc });
    const result = await setUserPreferences("u1", "full", { a: 1 }, 1);
    expect(result).toEqual({ ok: false, reason: "CONFLICT", actualSyncVersion: 3 });
  });

  test("returns SERVICE_UNAVAILABLE on an RPC error", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "db down" } }));
    getSupabaseAdmin.mockReturnValue({ rpc });
    const result = await setUserPreferences("u1", "full", { a: 1 }, 0);
    expect(result).toEqual({ ok: false, reason: "SERVICE_UNAVAILABLE" });
  });

  test("returns SERVICE_UNAVAILABLE when the RPC returns no row", async () => {
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    getSupabaseAdmin.mockReturnValue({ rpc });
    const result = await setUserPreferences("u1", "full", { a: 1 }, 0);
    expect(result).toEqual({ ok: false, reason: "SERVICE_UNAVAILABLE" });
  });
});
