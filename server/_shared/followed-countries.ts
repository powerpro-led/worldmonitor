/**
 * `worldmonitor.followed_countries` CRUD (Postgres, service-role Supabase
 * client) — Stage 2 of the Convex/Clerk -> Supabase migration replaced
 * `convex/followedCountries.ts` with direct Postgres queries through
 * `server/_shared/supabase-admin.ts`. `api/followed-countries.ts` (edge
 * runtime) is the sole caller, after resolving + verifying the Supabase
 * session via `validateBearerToken`.
 *
 * Convex needed an elaborate two-tier sharded-lock scheme
 * (`followedCountriesShards` + `followedCountriesUserMeta` +
 * `followedCountriesCountryLocks` + `followedCountriesCounts`) purely to
 * work around its document-level optimistic-concurrency granularity — none
 * of that is ported. Postgres gives real row locks and a
 * `primary key (user_id, country)` constraint for free: `followCountry` /
 * `unfollowCountry` are naturally idempotent (insert/delete + unique
 * violation or zero-rows-affected IS the idempotency check), and
 * `countFollowers` is a plain `count(*)` — fine at this project's scale;
 * revisit with a denormalized counter only if that's ever measured as a
 * bottleneck.
 *
 * Also dropped: the Convex `entitlements`-tier lookup and
 * `FREE_TIER_FOLLOW_LIMIT` cap. Stage 1 already collapsed entitlements to
 * "signed in = full access" (`src/services/entitlements.ts`) — a per-tier
 * follow cap had nothing left to differentiate. Any signed-in user can
 * follow any number of countries, naturally bounded by the ~195-entry ISO2
 * registry.
 */

import { getSupabaseAdmin } from './supabase-admin';
import { isValidIso2 } from './iso2';

/** Mirrors `convex/constants.ts::MAX_MERGE_INPUT` (ported as-is) — a
 * request-size sanity bound, unrelated to the (now-removed) follow cap. */
export const MAX_MERGE_INPUT = 100;

/** Mirrors `convex/constants.ts::COUNTRY_COUNT_PRIVACY_FLOOR` (ported as-is). */
export const COUNTRY_COUNT_PRIVACY_FLOOR = 5;

/** Postgres unique-violation error code (23505) — the natural idempotency
 * signal for a duplicate `(user_id, country)` insert. */
const POSTGRES_UNIQUE_VIOLATION = '23505';

export type FollowedCountriesErrorKind =
  | 'INVALID_COUNTRY'
  | 'EMPTY_INPUT'
  | 'INPUT_TOO_LARGE'
  | 'CONFIG'
  | 'NETWORK';

export class FollowedCountriesError extends Error {
  readonly kind: FollowedCountriesErrorKind;
  constructor(kind: FollowedCountriesErrorKind, message: string) {
    super(message);
    this.name = 'FollowedCountriesError';
    this.kind = kind;
  }
}

export interface FollowMutationResult {
  ok: true;
  idempotent: boolean;
}

export interface MergeAnonymousLocalResult {
  totalCount: number;
  accepted: string[];
  droppedInvalid: string[];
}

function requireSupabase() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    throw new FollowedCountriesError('CONFIG', 'Supabase service-role client unconfigured');
  }
  return supabase;
}

/**
 * `listFollowed(userId)` — reactive read replaced by refetch-on-demand
 * (see Stage 2 plan: Convex's `client.onUpdate` push isn't ported). Sorted
 * by `added_at` ascending — earliest-followed first, matching
 * `convex/followedCountries.ts::listFollowed`'s documented order.
 */
export async function listFollowed(userId: string): Promise<string[]> {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('followed_countries')
    .select('country')
    .eq('user_id', userId)
    .order('added_at', { ascending: true });
  if (error) {
    throw new FollowedCountriesError('NETWORK', `listFollowed failed: ${error.message}`);
  }
  return (data ?? []).map((row) => row.country as string);
}

/**
 * `followCountry(userId, country)` — idempotent on `(userId, country)`:
 * a duplicate insert hits the `primary key (user_id, country)` constraint
 * (23505) and is reported back as `idempotent: true` rather than an error.
 */
export async function followCountry(userId: string, country: string): Promise<FollowMutationResult> {
  if (!isValidIso2(country)) {
    throw new FollowedCountriesError('INVALID_COUNTRY', `Invalid ISO2 country code: ${country}`);
  }
  const supabase = requireSupabase();
  const { error } = await supabase
    .from('followed_countries')
    .insert({ user_id: userId, country });
  if (error) {
    if (error.code === POSTGRES_UNIQUE_VIOLATION) return { ok: true, idempotent: true };
    throw new FollowedCountriesError('NETWORK', `followCountry insert failed: ${error.message}`);
  }
  return { ok: true, idempotent: false };
}

/**
 * `unfollowCountry(userId, country)` — idempotent on absence: deleting a
 * row that doesn't exist affects zero rows, reported as `idempotent: true`.
 */
export async function unfollowCountry(userId: string, country: string): Promise<FollowMutationResult> {
  if (!isValidIso2(country)) {
    throw new FollowedCountriesError('INVALID_COUNTRY', `Invalid ISO2 country code: ${country}`);
  }
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('followed_countries')
    .delete()
    .eq('user_id', userId)
    .eq('country', country)
    .select('country');
  if (error) {
    throw new FollowedCountriesError('NETWORK', `unfollowCountry delete failed: ${error.message}`);
  }
  return { ok: true, idempotent: (data?.length ?? 0) === 0 };
}

/**
 * `mergeAnonymousLocal(userId, countries)` — sign-in merge of an anonymous
 * localStorage list into the authoritative table. No cap (see module doc);
 * `MAX_MERGE_INPUT` remains as a request-size sanity bound only.
 *
 * Algorithm: validate + filter through `isValidIso2` (collecting
 * `droppedInvalid`), canonicalize (dedupe in first-seen order), diff
 * against the user's existing rows, bulk-upsert the new ones
 * (`ignoreDuplicates` absorbs any concurrent-merge race harmlessly — a
 * second merge call for the same user is a no-op on already-inserted
 * rows, not an error).
 */
export async function mergeAnonymousLocal(
  userId: string,
  countries: string[],
): Promise<MergeAnonymousLocalResult> {
  if (countries.length === 0) {
    throw new FollowedCountriesError('EMPTY_INPUT', 'countries must be non-empty');
  }
  if (countries.length > MAX_MERGE_INPUT) {
    throw new FollowedCountriesError(
      'INPUT_TOO_LARGE',
      `countries exceeds MAX_MERGE_INPUT (${MAX_MERGE_INPUT})`,
    );
  }

  const droppedInvalid: string[] = [];
  const validInputs: string[] = [];
  for (const code of countries) {
    if (isValidIso2(code)) validInputs.push(code);
    else droppedInvalid.push(code);
  }

  const seen = new Set<string>();
  const canonicalized: string[] = [];
  for (const code of validInputs) {
    if (!seen.has(code)) {
      seen.add(code);
      canonicalized.push(code);
    }
  }

  const supabase = requireSupabase();
  const { data: existingRows, error: existingError } = await supabase
    .from('followed_countries')
    .select('country')
    .eq('user_id', userId);
  if (existingError) {
    throw new FollowedCountriesError('NETWORK', `mergeAnonymousLocal read failed: ${existingError.message}`);
  }
  const existingSet = new Set<string>((existingRows ?? []).map((r) => r.country as string));
  const accepted = canonicalized.filter((c) => !existingSet.has(c));

  if (accepted.length > 0) {
    const { error: insertError } = await supabase
      .from('followed_countries')
      .upsert(
        accepted.map((country) => ({ user_id: userId, country })),
        { onConflict: 'user_id,country', ignoreDuplicates: true },
      );
    if (insertError) {
      throw new FollowedCountriesError('NETWORK', `mergeAnonymousLocal insert failed: ${insertError.message}`);
    }
  }

  return {
    totalCount: existingSet.size + accepted.length,
    accepted,
    droppedInvalid,
  };
}

/**
 * `countFollowers(country)` — public, no auth. Applies the privacy floor
 * at read time (raw counts of 1-4 return 0), matching
 * `convex/followedCountries.ts::countFollowers`.
 */
export async function countFollowers(country: string): Promise<number> {
  if (!isValidIso2(country)) {
    throw new FollowedCountriesError('INVALID_COUNTRY', `Invalid ISO2 country code: ${country}`);
  }
  const supabase = requireSupabase();
  const { count, error } = await supabase
    .from('followed_countries')
    .select('*', { count: 'exact', head: true })
    .eq('country', country);
  if (error) {
    throw new FollowedCountriesError('NETWORK', `countFollowers failed: ${error.message}`);
  }
  const raw = count ?? 0;
  return raw < COUNTRY_COUNT_PRIVACY_FLOOR ? 0 : raw;
}
