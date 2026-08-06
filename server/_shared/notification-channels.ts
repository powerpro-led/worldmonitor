/**
 * `worldmonitor.notification_channels` CRUD (Postgres, service-role Supabase
 * client) — Stage 3 of the Convex/Clerk -> Supabase migration replaced
 * `convex/notificationChannels.ts` with direct Postgres queries through
 * `server/_shared/supabase-admin.ts`. Callers: `api/notification-channels.ts`
 * (all user-facing actions), `api/slack/oauth/callback.ts` /
 * `api/discord/oauth/callback.ts` (OAuth-issued channels), and
 * `scripts/lib/notification-channels-fetch.cjs` (the Railway delivery
 * scripts' read/deactivate path — separate CommonJS client, same table).
 *
 * The PRO-entitlement gate Convex enforced at the write boundary
 * (`assertProEntitlement`) is NOT ported — Convex's `entitlements` table has
 * had nothing writing to it since Stage 1 deleted Dodo billing, so that gate
 * had degenerated into "reject every write." Dropped entirely, consistent
 * with Stage 1's entitlements collapse and Stage 2's follow-cap removal: any
 * signed-in user gets full access.
 *
 * Also not ported: Convex's `queueChannelWelcome` internalAction and the
 * "durable welcome scheduling" negotiation handshake in
 * `api/notification-channels.ts`. That whole dance existed because Convex and
 * Vercel deploy independently — the welcome-queue publish now happens
 * synchronously in the same edge-function request that writes the channel
 * row, so there's nothing to negotiate.
 */

import { getSupabaseAdmin } from './supabase-admin';

export type ChannelType = 'telegram' | 'slack' | 'email' | 'discord' | 'webhook' | 'web_push';

export interface NotificationChannelRow {
  id: string;
  channelType: ChannelType;
  verified: boolean;
  linkedAt: number;
  chatId?: string;
  webhookEnvelope?: string;
  webhookLabel?: string;
  email?: string;
  slackChannelName?: string;
  slackTeamName?: string;
  slackConfigurationUrl?: string;
  discordGuildId?: string;
  discordChannelId?: string;
  endpoint?: string;
  p256dh?: string;
  auth?: string;
  userAgent?: string;
}

export type NotificationChannelsErrorKind = 'MISSING_FIELD' | 'CONFIG' | 'NETWORK';

export class NotificationChannelsError extends Error {
  readonly kind: NotificationChannelsErrorKind;
  constructor(kind: NotificationChannelsErrorKind, message: string) {
    super(message);
    this.name = 'NotificationChannelsError';
    this.kind = kind;
  }
}

function requireSupabase() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    throw new NotificationChannelsError('CONFIG', 'Supabase service-role client unconfigured');
  }
  return supabase;
}

interface ChannelRowRaw {
  id: string;
  channel_type: ChannelType;
  verified: boolean;
  linked_at: string;
  chat_id: string | null;
  webhook_envelope: string | null;
  webhook_label: string | null;
  email: string | null;
  slack_channel_name: string | null;
  slack_team_name: string | null;
  slack_configuration_url: string | null;
  discord_guild_id: string | null;
  discord_channel_id: string | null;
  endpoint: string | null;
  p256dh: string | null;
  auth: string | null;
  user_agent: string | null;
}

const CHANNEL_SELECT = 'id, channel_type, verified, linked_at, chat_id, webhook_envelope, webhook_label, ' +
  'email, slack_channel_name, slack_team_name, slack_configuration_url, discord_guild_id, ' +
  'discord_channel_id, endpoint, p256dh, auth, user_agent';

function rowToChannel(row: ChannelRowRaw): NotificationChannelRow {
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

/** `getChannels(userId)` — all of this user's linked channels. */
export async function getChannels(userId: string): Promise<NotificationChannelRow[]> {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('notification_channels')
    .select(CHANNEL_SELECT)
    .eq('user_id', userId);
  if (error) {
    throw new NotificationChannelsError('NETWORK', `getChannels failed: ${error.message}`);
  }
  return (data ?? []).map((row) => rowToChannel(row as unknown as ChannelRowRaw));
}

/**
 * `setChannel(userId, channelType, fields)` — upsert a telegram/slack/email/
 * webhook channel by `(user_id, channel_type)`. Discord and web_push have
 * their own setters (OAuth-issued shape / identity-triple shape respectively
 * — same split Convex made).
 */
export async function setChannel(
  userId: string,
  channelType: 'telegram' | 'slack' | 'email' | 'webhook',
  fields: { chatId?: string; webhookEnvelope?: string; email?: string; webhookLabel?: string },
): Promise<{ isNew: boolean; id: string }> {
  // Validate before touching Supabase — fail fast on bad input regardless of
  // backend availability/config, rather than surfacing a CONFIG error for
  // what's actually a caller mistake.
  const doc: Record<string, unknown> = { user_id: userId, channel_type: channelType, verified: true, linked_at: new Date().toISOString() };
  if (channelType === 'telegram') {
    if (!fields.chatId) throw new NotificationChannelsError('MISSING_FIELD', 'chatId required for telegram channel');
    doc.chat_id = fields.chatId;
  } else if (channelType === 'slack') {
    if (!fields.webhookEnvelope) throw new NotificationChannelsError('MISSING_FIELD', 'webhookEnvelope required for slack channel');
    doc.webhook_envelope = fields.webhookEnvelope;
  } else if (channelType === 'email') {
    if (!fields.email) throw new NotificationChannelsError('MISSING_FIELD', 'email required for email channel');
    doc.email = fields.email;
  } else if (channelType === 'webhook') {
    if (!fields.webhookEnvelope) throw new NotificationChannelsError('MISSING_FIELD', 'webhookEnvelope required for webhook channel');
    doc.webhook_envelope = fields.webhookEnvelope;
    if (fields.webhookLabel !== undefined) doc.webhook_label = fields.webhookLabel;
  }

  const supabase = requireSupabase();

  const { data: existing, error: existingError } = await supabase
    .from('notification_channels')
    .select('id')
    .eq('user_id', userId)
    .eq('channel_type', channelType)
    .maybeSingle();
  if (existingError) {
    throw new NotificationChannelsError('NETWORK', `setChannel read failed: ${existingError.message}`);
  }

  const { data: upserted, error } = await supabase
    .from('notification_channels')
    .upsert(doc, { onConflict: 'user_id,channel_type' })
    .select('id')
    .single();
  if (error) {
    throw new NotificationChannelsError('NETWORK', `setChannel upsert failed: ${error.message}`);
  }
  return { isNew: !existing, id: upserted.id as string };
}

/**
 * `setWebPushChannel` — Web Push identity triple. Replaces any prior
 * subscription for this user (one subscription per user).
 *
 * Cross-account dedupe: a browser's PushSubscription endpoint is bound to the
 * origin, not the signed-in user — if user A subscribes on device X, signs
 * out, and user B signs in on the same device X and subscribes, the browser
 * hands out the SAME endpoint. Without cleanup, both users' rows would carry
 * the same endpoint and every alert fanned out to A would also reach B.
 * `notification_channels_web_push_endpoint_idx` (unique, partial on
 * `channel_type='web_push'`) makes this an indexed delete instead of the
 * Convex version's full-table scan.
 */
export async function setWebPushChannel(
  userId: string,
  fields: { endpoint: string; p256dh: string; auth: string; userAgent?: string },
): Promise<{ isNew: boolean; id: string }> {
  const supabase = requireSupabase();

  const { data: existing, error: existingError } = await supabase
    .from('notification_channels')
    .select('id')
    .eq('user_id', userId)
    .eq('channel_type', 'web_push')
    .maybeSingle();
  if (existingError) {
    throw new NotificationChannelsError('NETWORK', `setWebPushChannel read failed: ${existingError.message}`);
  }

  const { error: deleteError } = await supabase
    .from('notification_channels')
    .delete()
    .eq('channel_type', 'web_push')
    .eq('endpoint', fields.endpoint)
    .neq('user_id', userId);
  if (deleteError) {
    throw new NotificationChannelsError('NETWORK', `setWebPushChannel cross-account cleanup failed: ${deleteError.message}`);
  }

  const doc: Record<string, unknown> = {
    user_id: userId,
    channel_type: 'web_push',
    endpoint: fields.endpoint,
    p256dh: fields.p256dh,
    auth: fields.auth,
    verified: true,
    linked_at: new Date().toISOString(),
    user_agent: fields.userAgent ?? null,
  };
  const { data: upserted, error } = await supabase
    .from('notification_channels')
    .upsert(doc, { onConflict: 'user_id,channel_type' })
    .select('id')
    .single();
  if (error) {
    throw new NotificationChannelsError('NETWORK', `setWebPushChannel upsert failed: ${error.message}`);
  }
  return { isNew: !existing, id: upserted.id as string };
}

export async function setSlackOAuthChannel(
  userId: string,
  fields: { webhookEnvelope: string; slackChannelName?: string; slackTeamName?: string; slackConfigurationUrl?: string },
): Promise<{ isNew: boolean }> {
  const supabase = requireSupabase();
  const { data: existing, error: existingError } = await supabase
    .from('notification_channels')
    .select('id')
    .eq('user_id', userId)
    .eq('channel_type', 'slack')
    .maybeSingle();
  if (existingError) {
    throw new NotificationChannelsError('NETWORK', `setSlackOAuthChannel read failed: ${existingError.message}`);
  }
  const doc = {
    user_id: userId,
    channel_type: 'slack',
    webhook_envelope: fields.webhookEnvelope,
    verified: true,
    linked_at: new Date().toISOString(),
    slack_channel_name: fields.slackChannelName ?? null,
    slack_team_name: fields.slackTeamName ?? null,
    slack_configuration_url: fields.slackConfigurationUrl ?? null,
  };
  const { error } = await supabase
    .from('notification_channels')
    .upsert(doc, { onConflict: 'user_id,channel_type' });
  if (error) {
    throw new NotificationChannelsError('NETWORK', `setSlackOAuthChannel upsert failed: ${error.message}`);
  }
  return { isNew: !existing };
}

export async function setDiscordOAuthChannel(
  userId: string,
  fields: { webhookEnvelope: string; discordGuildId?: string; discordChannelId?: string },
): Promise<{ isNew: boolean }> {
  const supabase = requireSupabase();
  const { data: existing, error: existingError } = await supabase
    .from('notification_channels')
    .select('id')
    .eq('user_id', userId)
    .eq('channel_type', 'discord')
    .maybeSingle();
  if (existingError) {
    throw new NotificationChannelsError('NETWORK', `setDiscordOAuthChannel read failed: ${existingError.message}`);
  }
  const doc = {
    user_id: userId,
    channel_type: 'discord',
    webhook_envelope: fields.webhookEnvelope,
    verified: true,
    linked_at: new Date().toISOString(),
    discord_guild_id: fields.discordGuildId ?? null,
    discord_channel_id: fields.discordChannelId ?? null,
  };
  const { error } = await supabase
    .from('notification_channels')
    .upsert(doc, { onConflict: 'user_id,channel_type' });
  if (error) {
    throw new NotificationChannelsError('NETWORK', `setDiscordOAuthChannel upsert failed: ${error.message}`);
  }
  return { isNew: !existing };
}

/**
 * `deleteChannel(userId, channelType)` — removes the channel row AND strips
 * that channel type out of every one of this user's `alert_rules.channels`
 * arrays (mirrors Convex's cross-table cleanup in `deleteChannelForUser`/
 * `deleteChannel`, so a deleted channel can't be left dangling in a rule).
 */
export async function deleteChannel(userId: string, channelType: ChannelType): Promise<void> {
  const supabase = requireSupabase();
  const { error } = await supabase
    .from('notification_channels')
    .delete()
    .eq('user_id', userId)
    .eq('channel_type', channelType);
  if (error) {
    throw new NotificationChannelsError('NETWORK', `deleteChannel failed: ${error.message}`);
  }

  const { data: rules, error: rulesError } = await supabase
    .from('alert_rules')
    .select('id, channels')
    .eq('user_id', userId);
  if (rulesError) {
    throw new NotificationChannelsError('NETWORK', `deleteChannel rule cleanup read failed: ${rulesError.message}`);
  }
  for (const rule of (rules ?? []) as Array<{ id: string; channels: string[] | null }>) {
    const channels = rule.channels ?? [];
    if (!channels.includes(channelType)) continue;
    const { error: patchError } = await supabase
      .from('alert_rules')
      .update({ channels: channels.filter((c) => c !== channelType) })
      .eq('id', rule.id);
    if (patchError) {
      throw new NotificationChannelsError('NETWORK', `deleteChannel rule cleanup write failed: ${patchError.message}`);
    }
  }
}

/**
 * `deactivateChannel(userId, channelType)` — marks `verified=false`. Called
 * by the Railway relay via `scripts/lib/notification-channels-fetch.cjs` when
 * Telegram returns 403 or Slack/Discord return 404/410 on delivery.
 */
export async function deactivateChannel(userId: string, channelType: ChannelType): Promise<void> {
  const supabase = requireSupabase();
  const { error } = await supabase
    .from('notification_channels')
    .update({ verified: false })
    .eq('user_id', userId)
    .eq('channel_type', channelType);
  if (error) {
    throw new NotificationChannelsError('NETWORK', `deactivateChannel failed: ${error.message}`);
  }
}
