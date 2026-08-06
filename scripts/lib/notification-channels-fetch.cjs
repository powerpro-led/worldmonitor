'use strict';

// Stage 3 of the Convex/Clerk -> Supabase migration: reads
// `worldmonitor.notification_channels` (Postgres, service-role client)
// directly instead of POSTing to the retired `/relay/channels` /
// `/relay/deactivate` Convex HTTP actions. Same field shape as the old relay
// response (camelCase) so `notification-relay.cjs`'s delivery-loop code
// needed no changes beyond swapping the fetch call.

const { getSupabaseAdmin } = require('./supabase-admin.cjs');

const CHANNEL_SELECT = 'id, channel_type, verified, linked_at, chat_id, webhook_envelope, webhook_label, ' +
  'email, slack_channel_name, slack_team_name, slack_configuration_url, discord_guild_id, ' +
  'discord_channel_id, endpoint, p256dh, auth, user_agent';

function rowToChannel(row) {
  return {
    id: row.id,
    channelType: row.channel_type,
    verified: row.verified,
    linkedAt: Date.parse(row.linked_at),
    ...(row.chat_id != null ? { chatId: row.chat_id } : {}),
    ...(row.webhook_envelope != null ? { webhookEnvelope: row.webhook_envelope } : {}),
    ...(row.webhook_label != null ? { webhookLabel: row.webhook_label } : {}),
    ...(row.email != null ? { email: row.email } : {}),
    ...(row.slack_channel_name != null ? { slackChannelName: row.slack_channel_name } : {}),
    ...(row.slack_team_name != null ? { slackTeamName: row.slack_team_name } : {}),
    ...(row.slack_configuration_url != null ? { slackConfigurationUrl: row.slack_configuration_url } : {}),
    ...(row.discord_guild_id != null ? { discordGuildId: row.discord_guild_id } : {}),
    ...(row.discord_channel_id != null ? { discordChannelId: row.discord_channel_id } : {}),
    ...(row.endpoint != null ? { endpoint: row.endpoint } : {}),
    ...(row.p256dh != null ? { p256dh: row.p256dh } : {}),
    ...(row.auth != null ? { auth: row.auth } : {}),
    ...(row.user_agent != null ? { userAgent: row.user_agent } : {}),
  };
}

/**
 * Fetch every notification channel linked to a user.
 *
 * @param {string} userId
 * @returns {Promise<object[]>} channels for this user; empty array on any
 *   failure path — fail-closed for delivery (no channels fetched means
 *   nothing sent this cycle, safer than throwing mid poll-loop).
 */
async function fetchChannelsForUser(userId) {
  if (typeof userId !== 'string' || userId.length === 0) {
    console.warn('[notification-channels-fetch] userId required');
    return [];
  }
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.warn('[notification-channels-fetch] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
    return [];
  }
  try {
    const { data, error } = await supabase
      .from('notification_channels')
      .select(CHANNEL_SELECT)
      .eq('user_id', userId);
    if (error) {
      console.warn(`[notification-channels-fetch] query failed: ${error.message}`);
      return [];
    }
    return (data ?? []).map(rowToChannel);
  } catch (err) {
    console.warn(`[notification-channels-fetch] failed: ${err && err.message ? err.message : err}`);
    return [];
  }
}

/**
 * Mark a channel unverified. Called when Telegram returns 403 or
 * Slack/Discord return 404/410 on delivery.
 *
 * @param {string} userId
 * @param {string} channelType
 * @returns {Promise<boolean>} true on success, false on any failure —
 *   callers already log/warn on a false return, so this stays best-effort.
 */
async function deactivateChannel(userId, channelType) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.warn('[notification-channels-fetch] deactivateChannel: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
    return false;
  }
  try {
    const { error } = await supabase
      .from('notification_channels')
      .update({ verified: false })
      .eq('user_id', userId)
      .eq('channel_type', channelType);
    if (error) {
      console.warn(`[notification-channels-fetch] deactivateChannel failed: ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[notification-channels-fetch] deactivateChannel failed: ${err && err.message ? err.message : err}`);
    return false;
  }
}

module.exports = { fetchChannelsForUser, deactivateChannel };
