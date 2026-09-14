-- Stage 3 of the Clerk/Convex -> Supabase migration (originally applied
-- 2026-08-06 via the Supabase MCP `apply_migration` tool, never committed —
-- see this repo's Stage 2 migration file header for the full story of why
-- this is being reconstructed from application code on 2026-09-14, not
-- dumped from the original project).
--
-- Reconstruction sources (read in full before writing this file):
--   server/_shared/notification-channels.ts, server/_shared/alert-rules.ts,
--   server/_shared/telegram-pairing.ts, and their callers
--   (api/notification-channels.ts, api/telegram/pair-callback.ts,
--   scripts/lib/{alert-rules-fetch,notification-channels-fetch}.cjs — column
--   list cross-checked against every `.select()`/`.insert()`/`.upsert()`/
--   `.update()` call site in the three _shared modules, not guessed).

create schema if not exists worldmonitor;
grant usage on schema worldmonitor to service_role;

-- ---------------------------------------------------------------------------
-- worldmonitor.notification_channels
-- ---------------------------------------------------------------------------
-- One row per (user_id, channel_type) — `unique (user_id, channel_type)` is
-- the `onConflict` target every upsert in notification-channels.ts uses.
-- Column set is the union of every channel type's fields (telegram: chat_id;
-- slack: webhook_envelope + 3 OAuth display fields; email: email; discord:
-- webhook_envelope + 2 OAuth ids; webhook: webhook_envelope + webhook_label;
-- web_push: endpoint/p256dh/auth/user_agent) — sparse by design, matching
-- Convex's original document shape (each row only populates the columns its
-- channel_type actually uses).

create table if not exists worldmonitor.notification_channels (
  id                      uuid        primary key default gen_random_uuid(),
  user_id                 uuid        not null references auth.users (id) on delete cascade,
  channel_type            text        not null check (channel_type in ('telegram', 'slack', 'email', 'discord', 'webhook', 'web_push')),
  verified                boolean     not null default true,
  linked_at               timestamptz not null default now(),
  chat_id                 text,
  webhook_envelope        text,
  webhook_label           text,
  email                   text,
  slack_channel_name      text,
  slack_team_name         text,
  slack_configuration_url text,
  discord_guild_id        text,
  discord_channel_id      text,
  endpoint                text,
  p256dh                  text,
  auth                    text,
  user_agent              text,
  unique (user_id, channel_type)
);

comment on table worldmonitor.notification_channels is
  'Per-user notification delivery channels (telegram/slack/email/discord/webhook/web_push). Reconstructed 2026-09-14, see stage2 migration header.';

-- setWebPushChannel()'s cross-account cleanup ("a browser PushSubscription
-- endpoint is bound to the origin, not the signed-in user" — module doc)
-- relies on this being an indexed lookup, not a full-table scan. Partial:
-- only web_push rows carry a real `endpoint`, every other channel_type
-- leaves it null, and a plain unique index would reject multiple NULLs
-- from... nothing, actually — NULLs are never considered equal by a unique
-- index either way, but scoping it to web_push rows keeps the index small
-- and its intent explicit.
create unique index if not exists notification_channels_web_push_endpoint_idx
  on worldmonitor.notification_channels (endpoint)
  where channel_type = 'web_push';

alter table worldmonitor.notification_channels enable row level security;

-- service_role only — same rationale as the stage2 tables (memory
-- `supabase-worldmonitor-schema-access`): no browser call site queries this
-- table directly, every access is through /api/* or the Railway relay
-- scripts, both service-role.
grant select, insert, update, delete on worldmonitor.notification_channels to service_role;

drop policy if exists notification_channels_service_role_all on worldmonitor.notification_channels;
drop policy if exists notification_channels_select_own on worldmonitor.notification_channels;
drop policy if exists notification_channels_insert_own on worldmonitor.notification_channels;
drop policy if exists notification_channels_update_own on worldmonitor.notification_channels;
drop policy if exists notification_channels_delete_own on worldmonitor.notification_channels;

create policy notification_channels_service_role_all
  on worldmonitor.notification_channels for all
  to service_role
  using (true) with check (true);

-- Inert until a table grant is added for `authenticated` — see the stage2
-- migration's user_preferences policies for the full rationale.
create policy notification_channels_select_own
  on worldmonitor.notification_channels for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy notification_channels_insert_own
  on worldmonitor.notification_channels for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy notification_channels_update_own
  on worldmonitor.notification_channels for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy notification_channels_delete_own
  on worldmonitor.notification_channels for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- worldmonitor.alert_rules
-- ---------------------------------------------------------------------------
-- One row per (user_id, variant) — `unique (user_id, variant)` is the
-- `onConflict` target every upsert in alert-rules.ts uses. `channels` and
-- `event_types`/`countries`/`tickers` are plain text[] (no FK to
-- notification_channels — a rule can name a channel type the user hasn't
-- linked yet, and deleteChannel()'s cross-table cleanup removes the entry
-- from these arrays in application code, not via a DB constraint).

create table if not exists worldmonitor.alert_rules (
  id                    uuid        primary key default gen_random_uuid(),
  user_id               uuid        not null references auth.users (id) on delete cascade,
  variant               text        not null,
  enabled               boolean     not null default true,
  event_types           text[]      not null default '{}',
  -- Default 'critical' matches resolveEffectivePair()'s insert-only default
  -- (alert-rules.ts) — real-time delivery (the default digest_mode) is
  -- reserved for critical-tier events only (assertCompatibleDeliveryMode()).
  sensitivity           text        not null default 'critical' check (sensitivity in ('all', 'high', 'critical')),
  channels               text[]     not null default '{}' check (channels <@ array['telegram', 'slack', 'email', 'discord', 'webhook', 'web_push']::text[]),
  quiet_hours_enabled   boolean,
  quiet_hours_start     integer     check (quiet_hours_start is null or quiet_hours_start between 0 and 23),
  quiet_hours_end       integer     check (quiet_hours_end is null or quiet_hours_end between 0 and 23),
  quiet_hours_timezone  text,
  quiet_hours_override  text        check (quiet_hours_override is null or quiet_hours_override in ('critical_only', 'silence_all', 'batch_on_wake')),
  digest_mode           text        check (digest_mode is null or digest_mode in ('realtime', 'daily', 'twice_daily', 'weekly')),
  digest_hour           integer     check (digest_hour is null or digest_hour between 0 and 23),
  digest_timezone       text,
  ai_digest_enabled     boolean,
  countries             text[],
  tickers               text[],
  updated_at            timestamptz not null default now(),
  unique (user_id, variant)
);

comment on table worldmonitor.alert_rules is
  'Per-user, per-variant alert delivery rules (event types, channels, sensitivity, digest/quiet-hours schedule). Reconstructed 2026-09-14, see stage2 migration header.';

-- getDigestRules() (scripts/lib/alert-rules-fetch.cjs, the digest cron) reads
-- `enabled = true AND digest_mode IS NOT NULL AND digest_mode <> 'realtime'`
-- on every run with no user scoping; getByEnabled() (the real-time relay's
-- poll loop) reads plain `enabled = <bool>` the same way. Both are full
-- cross-user scans by design (GHSA-r649-4cqj-w93h, cited in alert-rules.ts) —
-- this index just keeps them from being full-table scans as the row count
-- grows.
create index if not exists alert_rules_enabled_digest_mode_idx
  on worldmonitor.alert_rules (enabled, digest_mode);

-- Keep updated_at honest even if a future write path forgets to set it —
-- every current writer (mergedRow() in alert-rules.ts) already sets it
-- explicitly on every upsert, so this is a backstop, not the primary
-- mechanism. Same pattern as pipeline_config's touch trigger.
create or replace function worldmonitor.alert_rules_touch_updated_at()
  returns trigger
  language plpgsql
  security invoker
  set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists alert_rules_set_updated_at on worldmonitor.alert_rules;
create trigger alert_rules_set_updated_at
  before update on worldmonitor.alert_rules
  for each row execute function worldmonitor.alert_rules_touch_updated_at();

alter table worldmonitor.alert_rules enable row level security;

-- service_role only — deleteChannel()/claimPairingToken() also read+write
-- this table server-side (cross-table cleanup / auto-enrolling a newly
-- paired channel), same service-role-only rationale as every table in this
-- file.
grant select, insert, update, delete on worldmonitor.alert_rules to service_role;

drop policy if exists alert_rules_service_role_all on worldmonitor.alert_rules;
drop policy if exists alert_rules_select_own on worldmonitor.alert_rules;
drop policy if exists alert_rules_insert_own on worldmonitor.alert_rules;
drop policy if exists alert_rules_update_own on worldmonitor.alert_rules;
drop policy if exists alert_rules_delete_own on worldmonitor.alert_rules;

create policy alert_rules_service_role_all
  on worldmonitor.alert_rules for all
  to service_role
  using (true) with check (true);

create policy alert_rules_select_own
  on worldmonitor.alert_rules for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy alert_rules_insert_own
  on worldmonitor.alert_rules for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy alert_rules_update_own
  on worldmonitor.alert_rules for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy alert_rules_delete_own
  on worldmonitor.alert_rules for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- worldmonitor.telegram_pairing_tokens
-- ---------------------------------------------------------------------------
-- Short-lived (15-minute) single-use tokens for the "/start <token>" Telegram
-- pairing flow (telegram-pairing.ts). `token` is globally unique (looked up
-- with no user scoping in claimPairingToken() — the webhook only has the
-- token, not the caller's identity). `used` is flipped true either when a
-- fresh token is issued (invalidating the user's prior unused tokens) or
-- when claimed — the claim's `.eq('used', false)` on the UPDATE is the whole
-- double-claim guard (a concurrent double-delivery from Telegram can't both
-- win the same conditional update).

create table if not exists worldmonitor.telegram_pairing_tokens (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users (id) on delete cascade,
  token      text        not null unique,
  -- Nullable: createPairingToken()'s `variant` parameter is optional
  -- (`variant ?? null`) — an unscoped token pairs telegram for every one of
  -- the user's alert rules, a variant-scoped one only for that variant.
  variant    text,
  used       boolean     not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

comment on table worldmonitor.telegram_pairing_tokens is
  'Short-lived single-use tokens for the Telegram "/start <token>" pairing flow. Reconstructed 2026-09-14, see stage2 migration header.';

-- createPairingToken()'s invalidation step reads `user_id = ? AND used =
-- false` on every call; cleanupExpired() (run from
-- seed-digest-notifications.mjs's 30-minute cadence, per the module doc —
-- there's no Postgres cron equivalent to Convex's hourly job here) deletes
-- `expires_at < now()` on every run.
create index if not exists telegram_pairing_tokens_user_unused_idx
  on worldmonitor.telegram_pairing_tokens (user_id)
  where used = false;

create index if not exists telegram_pairing_tokens_expires_at_idx
  on worldmonitor.telegram_pairing_tokens (expires_at);

alter table worldmonitor.telegram_pairing_tokens enable row level security;

-- service_role only. Note claimPairingToken() is reached from the Telegram
-- webhook (api/telegram/pair-callback.ts) with no Supabase-session caller at
-- all — it authenticates via Telegram's own webhook secret, not a bearer
-- token — so there is no "own row" caller identity to scope an
-- `authenticated` policy against for the claim path specifically. The own-row
-- policies below still cover createPairingToken()'s issuing path (a real
-- signed-in user), for the same future-proofing reason as every other table.
grant select, insert, update, delete on worldmonitor.telegram_pairing_tokens to service_role;

drop policy if exists telegram_pairing_tokens_service_role_all on worldmonitor.telegram_pairing_tokens;
drop policy if exists telegram_pairing_tokens_select_own on worldmonitor.telegram_pairing_tokens;
drop policy if exists telegram_pairing_tokens_insert_own on worldmonitor.telegram_pairing_tokens;

create policy telegram_pairing_tokens_service_role_all
  on worldmonitor.telegram_pairing_tokens for all
  to service_role
  using (true) with check (true);

create policy telegram_pairing_tokens_select_own
  on worldmonitor.telegram_pairing_tokens for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy telegram_pairing_tokens_insert_own
  on worldmonitor.telegram_pairing_tokens for insert
  to authenticated
  with check ((select auth.uid()) = user_id);
