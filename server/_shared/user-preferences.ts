/**
 * `worldmonitor.user_preferences` CRUD (Postgres, service-role Supabase
 * client) — Stage 2 of the Convex/Clerk -> Supabase migration replaced
 * `convex/userPreferences.ts` with a direct Postgres round-trip through
 * `server/_shared/supabase-admin.ts`. `api/user-prefs.ts` is the sole
 * caller (edge runtime, already resolves + verifies the Supabase session
 * via `validateBearerToken` before calling in here).
 *
 * The CAS-guard (`expectedSyncVersion`) that Convex enforced inside a
 * mutation transaction is now the Postgres function
 * `worldmonitor.set_user_preferences` (row-locked via `SELECT ... FOR
 * UPDATE`), applied in the Stage 2 migration — atomicity comes from
 * Postgres row locking, not from Convex's document-level OCC. Wire shape
 * returned to the client (`SetPreferencesResult`, camelCase `data`/
 * `schemaVersion`/`syncVersion`) is kept identical to the Convex-backed
 * version so `src/utils/cloud-prefs-sync.ts` needs no changes.
 *
 * The Convex-side write-rate-limit table (`userPreferenceWriteRateLimits`)
 * is NOT ported — `api/user-prefs.ts`'s Redis-backed `checkScopedRateLimit`
 * is now the only write-rate limiter (there is no second public write path
 * into Postgres to guard against, unlike the old Convex-mutation-is-also-
 * directly-callable shape).
 */

import { getSupabaseAdmin } from './supabase-admin';

/** Mirrors `convex/constants.ts::CURRENT_PREFS_SCHEMA_VERSION` (ported as-is). */
export const CURRENT_PREFS_SCHEMA_VERSION = 1;

/** Mirrors `convex/constants.ts::MAX_PREFS_BLOB_SIZE` (ported as-is). */
export const MAX_PREFS_BLOB_SIZE = 65536;

export interface CloudPrefsRow {
  data: unknown;
  schemaVersion: number;
  syncVersion: number;
  updatedAt: number;
}

export type SetPreferencesResult =
  | { ok: true; syncVersion: number }
  | { ok: false; reason: 'CONFLICT'; actualSyncVersion: number }
  | { ok: false; reason: 'BLOB_TOO_LARGE'; size: number; max: number }
  | { ok: false; reason: 'SERVICE_UNAVAILABLE' };

/**
 * Read the current prefs row for `(userId, variant)`. Returns `null` when
 * no row exists (first-ever sync for this variant) or when Postgres is
 * unconfigured/unreachable — both map to a clean "nothing to sync yet" from
 * the caller's perspective, matching Convex's `getPreferences` query which
 * returned `null` on no-identity or no-row.
 */
export async function getUserPreferences(
  userId: string,
  variant: string,
): Promise<CloudPrefsRow | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('user_preferences')
    .select('data, schema_version, sync_version, updated_at')
    .eq('user_id', userId)
    .eq('variant', variant)
    .maybeSingle();

  if (error) {
    console.warn('[user-preferences] getUserPreferences failed:', error.message);
    return null;
  }
  if (!data) return null;

  return {
    data: data.data,
    schemaVersion: data.schema_version as number,
    syncVersion: data.sync_version as number,
    updatedAt: Date.parse(data.updated_at as string),
  };
}

/**
 * CAS-guarded upsert via the `worldmonitor.set_user_preferences` Postgres
 * function. Blob-size check runs BEFORE the RPC call (cheap, avoids a
 * round-trip for an oversized payload) — same ordering as
 * `convex/userPreferences.ts::setPreferences`.
 */
export async function setUserPreferences(
  userId: string,
  variant: string,
  data: unknown,
  expectedSyncVersion: number,
  schemaVersion: number = CURRENT_PREFS_SCHEMA_VERSION,
): Promise<SetPreferencesResult> {
  const blobSize = JSON.stringify(data).length;
  if (blobSize > MAX_PREFS_BLOB_SIZE) {
    return { ok: false, reason: 'BLOB_TOO_LARGE', size: blobSize, max: MAX_PREFS_BLOB_SIZE };
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) return { ok: false, reason: 'SERVICE_UNAVAILABLE' };

  const { data: rows, error } = await supabase.rpc('set_user_preferences', {
    p_user_id: userId,
    p_variant: variant,
    p_data: data,
    p_expected_sync_version: expectedSyncVersion,
    p_schema_version: schemaVersion,
  });

  if (error) {
    console.warn('[user-preferences] setUserPreferences RPC failed:', error.message);
    return { ok: false, reason: 'SERVICE_UNAVAILABLE' };
  }

  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) {
    console.warn('[user-preferences] setUserPreferences RPC returned no row');
    return { ok: false, reason: 'SERVICE_UNAVAILABLE' };
  }

  if (row.conflict) {
    return { ok: false, reason: 'CONFLICT', actualSyncVersion: row.sync_version as number };
  }
  return { ok: true, syncVersion: row.sync_version as number };
}
