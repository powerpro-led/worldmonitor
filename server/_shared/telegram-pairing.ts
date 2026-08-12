/**
 * `worldmonitor.telegram_pairing_tokens` CRUD (Postgres, service-role
 * Supabase client) — Stage 3 of the Convex/Clerk -> Supabase migration
 * replaced `convex/telegramPairingTokens.ts` + the pairing-claim half of
 * `convex/notificationChannels.ts` with direct Postgres queries. Callers:
 * `api/notification-channels.ts` (`createPairingToken`, called from the
 * settings UI) and the new `api/telegram/pair-callback.ts` (`claimPairingToken`,
 * the Telegram webhook target).
 *
 * The entitlement gate Convex checked in `claimPairingToken`
 * (`hasProEntitlement`) is NOT ported — see `server/_shared/notification-channels.ts`'s
 * module doc for why. Dropped entirely; any signed-in user's token claims.
 *
 * Convex's hourly `cleanup-expired-pairing-tokens` cron has no Postgres cron
 * equivalent here — `cleanupExpired()` is instead called once per run from
 * `seed-digest-notifications.mjs`'s existing 30-minute Railway cadence.
 */

import { getSupabaseAdmin } from './supabase-admin';

export type TelegramPairingErrorKind = 'CONFIG' | 'NETWORK';

export class TelegramPairingError extends Error {
  readonly kind: TelegramPairingErrorKind;
  constructor(kind: TelegramPairingErrorKind, message: string) {
    super(message);
    this.name = 'TelegramPairingError';
    this.kind = kind;
  }
}

function requireSupabase() {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new TelegramPairingError('CONFIG', 'Supabase service-role client unconfigured');
  return supabase;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface CreatePairingTokenResult {
  token: string;
  expiresAt: number;
}

/**
 * `createPairingToken(userId, variant?)` — invalidates the user's other
 * unused tokens, then issues a fresh base64url token (43 chars from 32
 * random bytes), valid 15 minutes.
 */
export async function createPairingToken(userId: string, variant?: string): Promise<CreatePairingTokenResult> {
  const supabase = requireSupabase();

  const { error: invalidateError } = await supabase
    .from('telegram_pairing_tokens')
    .update({ used: true })
    .eq('user_id', userId)
    .eq('used', false);
  if (invalidateError) {
    throw new TelegramPairingError('NETWORK', `createPairingToken invalidate failed: ${invalidateError.message}`);
  }

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = base64url(bytes);
  const expiresAt = Date.now() + 15 * 60 * 1000;

  const { error } = await supabase.from('telegram_pairing_tokens').insert({
    user_id: userId,
    token,
    expires_at: new Date(expiresAt).toISOString(),
    used: false,
    variant: variant ?? null,
  });
  if (error) {
    throw new TelegramPairingError('NETWORK', `createPairingToken insert failed: ${error.message}`);
  }
  return { token, expiresAt };
}

export type ClaimPairingTokenResult =
  | { ok: true; reason: null }
  | { ok: false; reason: 'NOT_FOUND' | 'ALREADY_USED' | 'EXPIRED' };

/**
 * `claimPairingToken(token, chatId)` — called from the Telegram webhook
 * (`api/telegram/pair-callback.ts`) when a user sends `/start <token>` to the
 * bot. Marks the token used (conditional on `used=false`, so a concurrent
 * double-delivery from Telegram can't double-claim), upserts the telegram
 * channel, and — on first-time pairing only — adds `'telegram'` to the
 * matching alert rule(s) so alerts deliver immediately without a manual edit.
 * Re-pairs (existing channel) skip that step to preserve any intentional
 * per-rule customization (e.g. a user who removed Telegram from a variant).
 */
export async function claimPairingToken(token: string, chatId: string): Promise<ClaimPairingTokenResult> {
  const supabase = requireSupabase();

  const { data: record, error } = await supabase
    .from('telegram_pairing_tokens')
    .select('id, user_id, expires_at, used, variant')
    .eq('token', token)
    .maybeSingle();
  if (error) throw new TelegramPairingError('NETWORK', `claimPairingToken read failed: ${error.message}`);
  if (!record) return { ok: false, reason: 'NOT_FOUND' };
  if (record.used) return { ok: false, reason: 'ALREADY_USED' };
  if (Date.parse(record.expires_at) < Date.now()) return { ok: false, reason: 'EXPIRED' };

  const { data: claimedRows, error: claimError } = await supabase
    .from('telegram_pairing_tokens')
    .update({ used: true })
    .eq('id', record.id)
    .eq('used', false)
    .select('id');
  if (claimError) throw new TelegramPairingError('NETWORK', `claimPairingToken claim failed: ${claimError.message}`);
  if (!claimedRows || claimedRows.length === 0) return { ok: false, reason: 'ALREADY_USED' };

  const userId = record.user_id as string;

  const { data: existingChannel, error: existingChannelError } = await supabase
    .from('notification_channels')
    .select('id')
    .eq('user_id', userId)
    .eq('channel_type', 'telegram')
    .maybeSingle();
  if (existingChannelError) {
    throw new TelegramPairingError('NETWORK', `claimPairingToken channel read failed: ${existingChannelError.message}`);
  }

  const { error: upsertError } = await supabase
    .from('notification_channels')
    .upsert(
      { user_id: userId, channel_type: 'telegram', chat_id: chatId, verified: true, linked_at: new Date().toISOString() },
      { onConflict: 'user_id,channel_type' },
    );
  if (upsertError) {
    throw new TelegramPairingError('NETWORK', `claimPairingToken channel upsert failed: ${upsertError.message}`);
  }

  if (!existingChannel) {
    let rulesQuery = supabase.from('alert_rules').select('id, channels').eq('user_id', userId);
    if (record.variant) rulesQuery = rulesQuery.eq('variant', record.variant as string);
    const { data: rules, error: rulesError } = await rulesQuery;
    if (rulesError) {
      throw new TelegramPairingError('NETWORK', `claimPairingToken rule lookup failed: ${rulesError.message}`);
    }
    for (const rule of (rules ?? []) as Array<{ id: string; channels: string[] | null }>) {
      const channels = rule.channels ?? [];
      if (channels.includes('telegram')) continue;
      const { error: patchError } = await supabase
        .from('alert_rules')
        .update({ channels: [...channels, 'telegram'] })
        .eq('id', rule.id);
      if (patchError) {
        throw new TelegramPairingError('NETWORK', `claimPairingToken rule patch failed: ${patchError.message}`);
      }
    }
  }

  return { ok: true, reason: null };
}

/** `cleanupExpired()` — deletes every expired pairing token. See module doc for cadence. */
export async function cleanupExpired(): Promise<{ deleted: number }> {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('telegram_pairing_tokens')
    .delete()
    .lt('expires_at', new Date().toISOString())
    .select('id');
  if (error) throw new TelegramPairingError('NETWORK', `cleanupExpired failed: ${error.message}`);
  return { deleted: (data ?? []).length };
}
