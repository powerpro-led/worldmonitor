'use strict';

// Stage 3 of the Convex/Clerk -> Supabase migration: Convex's hourly
// `cleanup-expired-pairing-tokens` cron has no direct Postgres-cron
// equivalent in this deployment — `cleanupExpiredPairingTokens()` is instead
// called once per run from `seed-digest-notifications.mjs`'s existing
// 30-minute Railway cadence, which is close enough (expired tokens are inert
// — a 15-minute TTL row sitting around for up to 30 extra minutes has no
// behavioral effect, just table bloat).

const { getSupabaseAdmin } = require('./supabase-admin.cjs');

/**
 * Delete every expired row from `worldmonitor.telegram_pairing_tokens`.
 *
 * @returns {Promise<number>} rows deleted; 0 on any failure path (best-effort
 *   housekeeping — never blocks the digest run it's piggybacking on).
 */
async function cleanupExpiredPairingTokens() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.warn('[telegram-pairing-cleanup] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
    return 0;
  }
  try {
    const { data, error } = await supabase
      .from('telegram_pairing_tokens')
      .delete()
      .lt('expires_at', new Date().toISOString())
      .select('id');
    if (error) {
      console.warn(`[telegram-pairing-cleanup] delete failed: ${error.message}`);
      return 0;
    }
    const deleted = (data ?? []).length;
    if (deleted > 0) console.log(`[telegram-pairing-cleanup] deleted ${deleted} expired pairing token(s)`);
    return deleted;
  } catch (err) {
    console.warn(`[telegram-pairing-cleanup] failed: ${err && err.message ? err.message : err}`);
    return 0;
  }
}

module.exports = { cleanupExpiredPairingTokens };
