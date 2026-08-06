'use strict';

// Stage 3 of the Convex/Clerk -> Supabase migration: reads
// `worldmonitor.alert_rules` (Postgres, service-role client) directly
// instead of POSTing to the retired `/relay/enabled-rules` /
// `/relay/digest-rules` Convex HTTP actions. Same field shape as the old
// relay response (camelCase, `userId` included) so `notification-relay.cjs`'s
// poll loop / quiet-hours drain and `seed-digest-notifications.mjs`'s digest
// scan needed no changes beyond swapping the fetch call.
//
// `getByEnabled`/`getDigestRules` were INTERNAL-ONLY in Convex
// (GHSA-r649-4cqj-w93h — a cross-tenant scan with no per-caller scope). Same
// posture here: this module is service-role-only, imported exclusively by
// Railway scripts, never by an edge function reachable from a browser.

const { getSupabaseAdmin } = require('./supabase-admin.cjs');

const RULE_SELECT = 'id, user_id, variant, enabled, event_types, sensitivity, channels, ' +
  'quiet_hours_enabled, quiet_hours_start, quiet_hours_end, quiet_hours_timezone, quiet_hours_override, ' +
  'digest_mode, digest_hour, digest_timezone, ai_digest_enabled, countries, tickers';

function rowToRule(row) {
  return {
    userId: row.user_id,
    variant: row.variant,
    enabled: row.enabled,
    eventTypes: row.event_types ?? [],
    sensitivity: row.sensitivity,
    channels: row.channels ?? [],
    ...(row.quiet_hours_enabled != null ? { quietHoursEnabled: row.quiet_hours_enabled } : {}),
    ...(row.quiet_hours_start != null ? { quietHoursStart: row.quiet_hours_start } : {}),
    ...(row.quiet_hours_end != null ? { quietHoursEnd: row.quiet_hours_end } : {}),
    ...(row.quiet_hours_timezone != null ? { quietHoursTimezone: row.quiet_hours_timezone } : {}),
    ...(row.quiet_hours_override != null ? { quietHoursOverride: row.quiet_hours_override } : {}),
    ...(row.digest_mode != null ? { digestMode: row.digest_mode } : {}),
    ...(row.digest_hour != null ? { digestHour: row.digest_hour } : {}),
    ...(row.digest_timezone != null ? { digestTimezone: row.digest_timezone } : {}),
    ...(row.ai_digest_enabled != null ? { aiDigestEnabled: row.ai_digest_enabled } : {}),
    ...(row.countries != null ? { countries: row.countries } : {}),
    ...(row.tickers != null ? { tickers: row.tickers } : {}),
  };
}

/**
 * All alert rules with the given `enabled` flag, across every user.
 *
 * @param {boolean} [enabled]
 * @returns {Promise<object[]>} empty array on any failure path — fail-closed
 *   for delivery (the real-time relay's poll loop and quiet-hours drain both
 *   treat "no rules" as "nothing to do this cycle" rather than throwing).
 */
async function fetchEnabledRules(enabled = true) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.warn('[alert-rules-fetch] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
    return [];
  }
  try {
    const { data, error } = await supabase.from('alert_rules').select(RULE_SELECT).eq('enabled', enabled);
    if (error) {
      console.warn(`[alert-rules-fetch] fetchEnabledRules query failed: ${error.message}`);
      return [];
    }
    return (data ?? []).map(rowToRule);
  } catch (err) {
    console.warn(`[alert-rules-fetch] fetchEnabledRules failed: ${err && err.message ? err.message : err}`);
    return [];
  }
}

/**
 * Enabled rules with a non-realtime digestMode — the digest cron's work list.
 *
 * @returns {Promise<object[]>} empty array on any failure path.
 */
async function fetchDigestRules() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.warn('[alert-rules-fetch] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
    return [];
  }
  try {
    const { data, error } = await supabase
      .from('alert_rules')
      .select(RULE_SELECT)
      .eq('enabled', true)
      .not('digest_mode', 'is', null)
      .neq('digest_mode', 'realtime');
    if (error) {
      console.warn(`[alert-rules-fetch] fetchDigestRules query failed: ${error.message}`);
      return [];
    }
    return (data ?? []).map(rowToRule);
  } catch (err) {
    console.warn(`[alert-rules-fetch] fetchDigestRules failed: ${err && err.message ? err.message : err}`);
    return [];
  }
}

module.exports = { fetchEnabledRules, fetchDigestRules };
