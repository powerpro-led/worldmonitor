'use strict';

// One-shot fetch helper for the per-user followed-countries watchlist.
//
// Stage 2 of the Convex/Clerk -> Supabase migration: reads
// `worldmonitor.followed_countries` (Postgres, service-role client)
// directly instead of POSTing to the retired `/relay/followed-countries`
// Convex HTTP action. Same `string[]` contract as before (ISO-2 codes,
// ordered by `added_at` ascending) so the digest composer needs no changes
// at its call site.
//
// Returns `string[]` on every soft failure mode (missing env, malformed
// userId, Postgres error) so the composer never has to wrap the call site
// in a try/catch — the upstream-unavailable / no-rows distinction is
// intentionally collapsed (memory: `upstream-unavailable-vs-empty-filter`
// — graceful degradation IS the right call here because the bias is purely
// a soft uplift; the brief still ships unchanged when the fetch silently
// empties).

const { getSupabaseAdmin } = require('./supabase-admin.cjs');

/**
 * Fetch the userId's followed countries directly from Postgres.
 *
 * @param {string} userId
 * @returns {Promise<string[]>} ISO-2 country codes ordered by addedAt asc.
 *   Empty array on any failure path. Never throws.
 */
async function fetchFollowedCountries(userId) {
  if (typeof userId !== 'string' || userId.length === 0) {
    console.warn('[followed-countries-fetch] userId required');
    return [];
  }
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.warn('[followed-countries-fetch] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
    return [];
  }
  try {
    const { data, error } = await supabase
      .from('followed_countries')
      .select('country')
      .eq('user_id', userId)
      .order('added_at', { ascending: true });
    if (error) {
      console.warn(`[followed-countries-fetch] query failed: ${error.message}`);
      return [];
    }
    return (data ?? [])
      .map((row) => row.country)
      .filter((c) => typeof c === 'string' && c.length > 0);
  } catch (err) {
    const msg = err && typeof err === 'object' && 'message' in err ? err.message : String(err);
    console.warn(`[followed-countries-fetch] failed: ${msg}`);
    return [];
  }
}

module.exports = { fetchFollowedCountries };
