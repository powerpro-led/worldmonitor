-- Stage 2 of the Clerk/Convex -> Supabase migration (originally applied
-- 2026-08-05 via the Supabase MCP `apply_migration` tool straight against
-- the cloud project, NEVER committed as a repo migration — see
-- PLATFORM_ARCHITECTURE.md's 2026-09-14 "CRITICAL CORRECTION" Status entry
-- and memory `supabase-migration-stage1`). Reconstructed 2026-09-14 from the
-- application code that reads/writes these tables — the only surviving
-- definition (biovita's `ixuezudybhjptisexgxx` cloud project) was wiped to
-- empty on 2026-09-13, so this is DDL derived from behavior, not a dump.
-- Reconstruction sources (read in full before writing this file):
--   server/_shared/user-preferences.ts, server/_shared/followed-countries.ts,
--   server/_shared/supabase-admin.ts, server/__tests__/user-preferences.test.ts,
--   memory `supabase-worldmonitor-schema-access` (the GRANT/RLS lesson below).
--
-- `worldmonitor.users`/`api_keys`/`mcp_pro_tokens` (the rest of Stage 1) are
-- DELIBERATELY NOT reconstructed here — a full-repo grep for
-- `getSupabaseAdmin()` call sites (the only entry point into this schema)
-- turned up zero current callers for those three tables; `auth-session.ts`
-- verifies Supabase JWTs locally with no DB round-trip, and
-- `entitlement-check.ts` synthesizes a fixed entitlement from any non-empty
-- userId. Reconstructing unread, credential-adjacent tables from prose
-- memory alone (no code to check column shape against) was judged not worth
-- the security surface for this pass — operator decision, 2026-09-14.
--
-- SCHEMA: `worldmonitor`, not `public` — same convention `pipeline_config`
-- documents (this migration predates it in application order but the schema
-- itself is idempotent either way).

create schema if not exists worldmonitor;

comment on schema worldmonitor is
  'WorldMonitor''s own objects in this tenant project — kept out of public so the project can host other schemas without collision. See PLATFORM_ARCHITECTURE.md P3.';

grant usage on schema worldmonitor to service_role;

-- ---------------------------------------------------------------------------
-- worldmonitor.user_preferences
-- ---------------------------------------------------------------------------
-- One row per (user_id, variant) — `variant` is the site variant (world/tech/
-- finance/commodity/happy/energy, see ARCHITECTURE.md's Variant System), so a
-- user's dashboard prefs are scoped per-variant, not shared globally.
-- `sync_version` is the CAS token `set_user_preferences()` below enforces —
-- optimistic-concurrency guard replacing Convex's document-level OCC
-- (server/_shared/user-preferences.ts's module doc).

create table if not exists worldmonitor.user_preferences (
  user_id        uuid        not null references auth.users (id) on delete cascade,
  variant        text        not null,
  data           jsonb       not null,
  schema_version integer     not null default 1,
  sync_version   integer     not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (user_id, variant)
);

comment on table worldmonitor.user_preferences is
  'Per-user, per-variant dashboard preferences blob. CAS-guarded via worldmonitor.set_user_preferences(). Reconstructed 2026-09-14, see file header.';

alter table worldmonitor.user_preferences enable row level security;

-- GRANTs are NOT redundant with RLS — Postgres checks table privileges
-- BEFORE row-level policies (memory `supabase-worldmonitor-schema-access`,
-- lesson #2). That same memory's lesson #1: a schema outside `public` gets
-- NONE of Supabase's default grants — every grant here is explicit.
--
-- Table privileges go to `service_role` ONLY, not `authenticated` —
-- deliberately, per the same memory: the browser never queries this table
-- directly (verified: no `.from('user_preferences')` anywhere in `src/**`),
-- it reaches it through `/api/user-prefs.ts`, which authenticates the caller
-- itself and then uses the service-role client. Granting `authenticated`
-- would expose the table to PostgREST for zero functional gain — the exact
-- mistake that memory documents fixing once already.
grant select, insert, update, delete on worldmonitor.user_preferences to service_role;

drop policy if exists user_preferences_service_role_all on worldmonitor.user_preferences;
drop policy if exists user_preferences_select_own on worldmonitor.user_preferences;
drop policy if exists user_preferences_insert_own on worldmonitor.user_preferences;
drop policy if exists user_preferences_update_own on worldmonitor.user_preferences;
drop policy if exists user_preferences_delete_own on worldmonitor.user_preferences;

-- Belt and braces (pipeline_config's own phrase for this pattern): Supabase
-- creates `service_role` WITH BYPASSRLS, so this is redundant today — but if
-- that attribute were ever lost, the app would otherwise fail silently
-- rather than loudly.
create policy user_preferences_service_role_all
  on worldmonitor.user_preferences for all
  to service_role
  using (true) with check (true);

-- "Own row" policies for `authenticated` — currently INERT (no table grant
-- above), by design: nothing calls this table as `authenticated` today, so
-- granting would only widen the attack surface. These exist so that IF a
-- future direct-from-browser read/write path is ever added, the RLS shape
-- is already correct and only a GRANT is needed, not a new migration. Uses
-- the initplan-optimized `(select auth.uid())` form from creation (Stage
-- 2/3's own later fix, applied here from the start — see memory
-- `supabase-migration-stage1`'s Stage 2 "Verified" section).
create policy user_preferences_select_own
  on worldmonitor.user_preferences for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy user_preferences_insert_own
  on worldmonitor.user_preferences for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy user_preferences_update_own
  on worldmonitor.user_preferences for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy user_preferences_delete_own
  on worldmonitor.user_preferences for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- CAS-guarded upsert. Mirrors `server/_shared/user-preferences.ts::setUserPreferences`'s
-- RPC contract exactly (args `p_user_id`/`p_variant`/`p_data`/
-- `p_expected_sync_version`/`p_schema_version`; return columns `ok`/
-- `conflict`/`sync_version`, read by that same function). Row-locked via
-- `SELECT ... FOR UPDATE` so concurrent writers serialize instead of racing —
-- this is what replaces Convex's document-level OCC (module doc).
--
-- First-write contract, confirmed against `server/__tests__/user-preferences.test.ts`:
-- a caller with no existing row passes `p_expected_sync_version = 0` and
-- gets back `sync_version = 1` on success (insert path). A mismatch — either
-- an existing row at a different version, or a caller expecting a row that
-- doesn't exist yet — returns `conflict = true` with the actual current
-- version (0 when no row exists) so the caller can resync and retry.
create or replace function worldmonitor.set_user_preferences(
  p_user_id uuid,
  p_variant text,
  p_data jsonb,
  p_expected_sync_version integer,
  p_schema_version integer
)
returns table (ok boolean, conflict boolean, sync_version integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_current_version integer;
begin
  select up.sync_version into v_current_version
  from worldmonitor.user_preferences up
  where up.user_id = p_user_id and up.variant = p_variant
  for update;

  if not found then
    if p_expected_sync_version <> 0 then
      return query select false, true, 0;
      return;
    end if;

    insert into worldmonitor.user_preferences (user_id, variant, data, schema_version, sync_version, updated_at)
    values (p_user_id, p_variant, p_data, p_schema_version, 1, now());

    return query select true, false, 1;
    return;
  end if;

  if v_current_version <> p_expected_sync_version then
    return query select false, true, v_current_version;
    return;
  end if;

  update worldmonitor.user_preferences
  set data = p_data,
      schema_version = p_schema_version,
      sync_version = v_current_version + 1,
      updated_at = now()
  where user_id = p_user_id and variant = p_variant;

  return query select true, false, v_current_version + 1;
end;
$$;

comment on function worldmonitor.set_user_preferences(uuid, text, jsonb, integer, integer) is
  'CAS-guarded upsert for worldmonitor.user_preferences, row-locked via SELECT ... FOR UPDATE. See server/_shared/user-preferences.ts.';

-- Only service_role calls this RPC (server/_shared/user-preferences.ts, via
-- the service-role client) — same "no direct browser caller" rationale as
-- the table grants above.
grant execute on function worldmonitor.set_user_preferences(uuid, text, jsonb, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- worldmonitor.followed_countries
-- ---------------------------------------------------------------------------
-- `primary key (user_id, country)` is the whole idempotency mechanism
-- (server/_shared/followed-countries.ts's module doc): a duplicate follow
-- hits 23505 (unique violation) and is reported back as idempotent rather
-- than an error; an unfollow of an absent row affects zero rows, same
-- treatment. No Convex-style sharded-lock scheme needed.

create table if not exists worldmonitor.followed_countries (
  user_id  uuid        not null references auth.users (id) on delete cascade,
  -- Matches server/_shared/iso2.ts::isValidIso2's own invariant (exactly two
  -- uppercase ASCII letters) as a DB-level backstop — the app already
  -- enforces this before every insert, this just fails the same way closer
  -- to the data if that ever changes.
  country  text        not null check (country ~ '^[A-Z]{2}$'),
  added_at timestamptz not null default now(),
  primary key (user_id, country)
);

comment on table worldmonitor.followed_countries is
  'Per-user country watchlist. Reconstructed 2026-09-14, see file header.';

alter table worldmonitor.followed_countries enable row level security;

-- Same rationale as user_preferences above: service_role only. Note
-- `countFollowers()` (a public, unauthenticated aggregate) also goes through
-- the service-role client server-side (server/_shared/followed-countries.ts)
-- rather than an RLS-gated anon read — so `anon` needs no grant either.
grant select, insert, update, delete on worldmonitor.followed_countries to service_role;

drop policy if exists followed_countries_service_role_all on worldmonitor.followed_countries;
drop policy if exists followed_countries_select_own on worldmonitor.followed_countries;
drop policy if exists followed_countries_insert_own on worldmonitor.followed_countries;
drop policy if exists followed_countries_delete_own on worldmonitor.followed_countries;

create policy followed_countries_service_role_all
  on worldmonitor.followed_countries for all
  to service_role
  using (true) with check (true);

-- Inert until a table grant is added for `authenticated` — see the
-- user_preferences policies above for the full rationale.
create policy followed_countries_select_own
  on worldmonitor.followed_countries for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy followed_countries_insert_own
  on worldmonitor.followed_countries for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy followed_countries_delete_own
  on worldmonitor.followed_countries for delete
  to authenticated
  using ((select auth.uid()) = user_id);
