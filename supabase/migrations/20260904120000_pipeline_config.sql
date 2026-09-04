-- pipeline_config — the org's ~26 data-source keys (ACLED, FRED, Finnhub,
-- AISStream, FIRMS, Brave/Exa/SerpAPI, …).
--
-- PLATFORM_ARCHITECTURE.md P3 / P5 / Workstream 1. One row per key. Written by
-- an org admin through the cloud admin panel (Workstream 6); read by that org's
-- worker via the service role. Never read by an operator's local backend — the
-- local backend holds no data-source keys at all (P2).
--
-- One deployment per tenant org, in that org's own Supabase project, so there
-- is deliberately no org_id column: the project IS the tenant boundary.

create table if not exists public.pipeline_config (
  key        text primary key,
  value      text        not null,
  updated_at timestamptz not null default now()
);

comment on table public.pipeline_config is
  'Org data-source API keys. Admin-writable via RLS, worker-readable via service role. See PLATFORM_ARCHITECTURE.md P3.';

-- Admin test, per OQ-P3: `app_metadata.wm_admin`, set by the repo devs with
-- admin.updateUserById. app_metadata is chosen over user_metadata precisely
-- because a user cannot write it themselves.
--
-- Compared as text rather than cast to boolean: `->> 'wm_admin'` yields the
-- text 'true', and a `::boolean` cast would raise on any other value someone
-- happened to store there, turning a bad metadata value into a 500 on every
-- policy evaluation instead of a plain "not an admin".
create or replace function public.wm_is_admin()
  returns boolean
  language sql
  stable
  security invoker
  set search_path = ''
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'wm_admin', '') = 'true';
$$;

comment on function public.wm_is_admin() is
  'True when the calling JWT carries app_metadata.wm_admin = true. See PLATFORM_ARCHITECTURE.md OQ-P3.';

alter table public.pipeline_config enable row level security;

-- GRANTs are NOT redundant with RLS: Postgres checks table privileges BEFORE
-- row-level policies, so a policy alone leaves `authenticated` with permission
-- denied. (Learned the hard way on the worldmonitor schema — see the
-- supabase_worldmonitor_schema_access note.) The service role bypasses RLS but
-- still needs the grant.
grant select, insert, update, delete on public.pipeline_config to authenticated;
grant select, insert, update, delete on public.pipeline_config to service_role;

-- Idempotent: `supabase db push` re-runs are a normal part of the per-org
-- deploy (Workstream 5), and CREATE POLICY has no IF NOT EXISTS.
drop policy if exists pipeline_config_admin_select on public.pipeline_config;
drop policy if exists pipeline_config_admin_insert on public.pipeline_config;
drop policy if exists pipeline_config_admin_update on public.pipeline_config;
drop policy if exists pipeline_config_admin_delete on public.pipeline_config;
drop policy if exists pipeline_config_worker_read on public.pipeline_config;

-- Belt and braces for the worker's read path. Supabase creates `service_role`
-- WITH BYPASSRLS, so this policy is redundant there today — but if that ever
-- stopped being true the worker would read ZERO keys and the whole pipeline
-- would run unauthenticated against every data source, silently, with no error
-- anywhere. One explicit policy removes the dependency on a platform role
-- attribute for a failure that would otherwise be invisible.
create policy pipeline_config_worker_read
  on public.pipeline_config for select
  to service_role
  using (true);

create policy pipeline_config_admin_select
  on public.pipeline_config for select
  to authenticated
  using (public.wm_is_admin());

create policy pipeline_config_admin_insert
  on public.pipeline_config for insert
  to authenticated
  with check (public.wm_is_admin());

create policy pipeline_config_admin_update
  on public.pipeline_config for update
  to authenticated
  using (public.wm_is_admin())
  with check (public.wm_is_admin());

create policy pipeline_config_admin_delete
  on public.pipeline_config for delete
  to authenticated
  using (public.wm_is_admin());

-- Keep updated_at honest without trusting the writer to set it.
create or replace function public.pipeline_config_touch_updated_at()
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

drop trigger if exists pipeline_config_set_updated_at on public.pipeline_config;
create trigger pipeline_config_set_updated_at
  before update on public.pipeline_config
  for each row execute function public.pipeline_config_touch_updated_at();
