// @vitest-environment node

/**
 * Stage 2 of the Convex/Clerk -> Supabase migration —
 * `server/_shared/followed-countries.ts` replaced `convex/followedCountries.ts`.
 * No sharded-lock / cap coverage here (both retired — see the module doc
 * comment): Postgres's `primary key (user_id, country)` constraint makes
 * follow/unfollow naturally idempotent, and the follow cap was removed
 * entirely alongside Stage 1's entitlements collapse.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

const getSupabaseAdmin = vi.fn();
vi.mock("../_shared/supabase-admin", () => ({
  getSupabaseAdmin: (...a: unknown[]) => getSupabaseAdmin(...a),
}));

import {
  FollowedCountriesError,
  countFollowers,
  followCountry,
  listFollowed,
  mergeAnonymousLocal,
  unfollowCountry,
  COUNTRY_COUNT_PRIVACY_FLOOR,
  MAX_MERGE_INPUT,
} from "../_shared/followed-countries";

beforeEach(() => {
  getSupabaseAdmin.mockReset();
});

describe("listFollowed", () => {
  test("throws CONFIG when Supabase is unconfigured", async () => {
    getSupabaseAdmin.mockReturnValue(null);
    await expect(listFollowed("u1")).rejects.toMatchObject({ kind: "CONFIG" });
  });

  test("returns country codes ordered as returned by the query (added_at asc)", async () => {
    const order = vi.fn(async () => ({ data: [{ country: "US" }, { country: "GB" }], error: null }));
    const eq = vi.fn(() => ({ order }));
    const select = vi.fn(() => ({ eq }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ select })) });

    await expect(listFollowed("u1")).resolves.toEqual(["US", "GB"]);
    expect(eq).toHaveBeenCalledWith("user_id", "u1");
    expect(order).toHaveBeenCalledWith("added_at", { ascending: true });
  });

  test("throws NETWORK on a Supabase error", async () => {
    const order = vi.fn(async () => ({ data: null, error: { message: "boom" } }));
    const eq = vi.fn(() => ({ order }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ select: vi.fn(() => ({ eq })) })) });
    await expect(listFollowed("u1")).rejects.toMatchObject({ kind: "NETWORK" });
  });
});

describe("followCountry", () => {
  test("throws INVALID_COUNTRY for a non-ISO2 code without touching Supabase", async () => {
    await expect(followCountry("u1", "ZZ")).rejects.toMatchObject({ kind: "INVALID_COUNTRY" });
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
  });

  test("inserts and returns idempotent:false on success", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ insert })) });
    await expect(followCountry("u1", "US")).resolves.toEqual({ ok: true, idempotent: false });
    expect(insert).toHaveBeenCalledWith({ user_id: "u1", country: "US" });
  });

  test("a duplicate insert (23505 unique violation) is idempotent, not an error", async () => {
    const insert = vi.fn(async () => ({ error: { code: "23505", message: "duplicate key" } }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ insert })) });
    await expect(followCountry("u1", "US")).resolves.toEqual({ ok: true, idempotent: true });
  });

  test("a non-conflict error throws NETWORK", async () => {
    const insert = vi.fn(async () => ({ error: { code: "08006", message: "connection lost" } }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ insert })) });
    await expect(followCountry("u1", "US")).rejects.toMatchObject({ kind: "NETWORK" });
  });
});

describe("unfollowCountry", () => {
  test("throws INVALID_COUNTRY for a non-ISO2 code", async () => {
    await expect(unfollowCountry("u1", "ZZ")).rejects.toMatchObject({ kind: "INVALID_COUNTRY" });
  });

  test("deleting an existing row returns idempotent:false", async () => {
    const select = vi.fn(async () => ({ data: [{ country: "US" }], error: null }));
    const eq2 = vi.fn(() => ({ select }));
    const eq1 = vi.fn(() => ({ eq: eq2 }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ delete: vi.fn(() => ({ eq: eq1 })) })) });
    await expect(unfollowCountry("u1", "US")).resolves.toEqual({ ok: true, idempotent: false });
  });

  test("deleting a non-existent row (0 rows affected) returns idempotent:true", async () => {
    const select = vi.fn(async () => ({ data: [], error: null }));
    const eq2 = vi.fn(() => ({ select }));
    const eq1 = vi.fn(() => ({ eq: eq2 }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ delete: vi.fn(() => ({ eq: eq1 })) })) });
    await expect(unfollowCountry("u1", "US")).resolves.toEqual({ ok: true, idempotent: true });
  });
});

describe("mergeAnonymousLocal", () => {
  test("throws EMPTY_INPUT for an empty array", async () => {
    await expect(mergeAnonymousLocal("u1", [])).rejects.toMatchObject({ kind: "EMPTY_INPUT" });
  });

  test("throws INPUT_TOO_LARGE past MAX_MERGE_INPUT", async () => {
    const big = Array.from({ length: MAX_MERGE_INPUT + 1 }, () => "US");
    await expect(mergeAnonymousLocal("u1", big)).rejects.toMatchObject({ kind: "INPUT_TOO_LARGE" });
  });

  test("filters invalid codes, dedupes, and only inserts genuinely-new countries", async () => {
    const existingSelect = vi.fn(async () => ({ data: [{ country: "FR" }], error: null }));
    const existingEq = vi.fn(() => existingSelect());
    const upsert = vi.fn(async () => ({ error: null }));
    getSupabaseAdmin.mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn(() => ({ eq: existingEq })),
        upsert,
      })),
    });

    const result = await mergeAnonymousLocal("u1", ["US", "us".toUpperCase(), "US", "FR", "ZZ"]);
    // FR already followed → excluded from accepted; ZZ invalid → droppedInvalid;
    // US deduped to a single accepted entry.
    expect(result).toEqual({ totalCount: 2, accepted: ["US"], droppedInvalid: ["ZZ"] });
    expect(upsert).toHaveBeenCalledWith(
      [{ user_id: "u1", country: "US" }],
      { onConflict: "user_id,country", ignoreDuplicates: true },
    );
  });

  test("skips the upsert call entirely when nothing new is accepted", async () => {
    const existingSelect = vi.fn(async () => ({ data: [{ country: "US" }], error: null }));
    const upsert = vi.fn();
    getSupabaseAdmin.mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn(() => ({ eq: vi.fn(() => existingSelect()) })),
        upsert,
      })),
    });
    const result = await mergeAnonymousLocal("u1", ["US"]);
    expect(result).toEqual({ totalCount: 1, accepted: [], droppedInvalid: [] });
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("countFollowers", () => {
  test("throws INVALID_COUNTRY for a non-ISO2 code", async () => {
    await expect(countFollowers("ZZ")).rejects.toMatchObject({ kind: "INVALID_COUNTRY" });
  });

  test("applies the privacy floor: counts below the floor return 0", async () => {
    const eq = vi.fn(async () => ({ count: COUNTRY_COUNT_PRIVACY_FLOOR - 1, error: null }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ select: vi.fn(() => ({ eq })) })) });
    await expect(countFollowers("US")).resolves.toBe(0);
  });

  test("returns the exact count at or above the privacy floor", async () => {
    const eq = vi.fn(async () => ({ count: COUNTRY_COUNT_PRIVACY_FLOOR, error: null }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ select: vi.fn(() => ({ eq })) })) });
    await expect(countFollowers("US")).resolves.toBe(COUNTRY_COUNT_PRIVACY_FLOOR);
  });
});

describe("FollowedCountriesError", () => {
  test("carries the discriminant kind for callers to branch on", () => {
    const err = new FollowedCountriesError("INVALID_COUNTRY", "bad code");
    expect(err.kind).toBe("INVALID_COUNTRY");
    expect(err.name).toBe("FollowedCountriesError");
    expect(err).toBeInstanceOf(Error);
  });
});
