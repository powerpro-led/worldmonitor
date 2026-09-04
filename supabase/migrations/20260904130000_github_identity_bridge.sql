-- github-identity-bridge — companion SQL for the vendored Edge Function.
--
-- VENDORED COPY — platform is the source of truth (PLATFORM_ARCHITECTURE.md P9).
-- Synced from platform @ bafbfb15916c1db973f96a60564f99196c4e4428
--   tools/supabase/schemas/public/fn_link_bridge_identity_if_needed.sql
--   (2026-09-04, WorldMonitor session 57 / Workstream 2).
--
-- Upstream keeps this as a DECLARATIVE-SCHEMA file (edit there, `supabase db
-- diff` to a migration). WorldMonitor has no declarative-schema setup — W1
-- established plain forward-only migrations — so it is vendored directly AS a
-- migration here. The function body below is byte-for-byte from upstream;
-- `CREATE OR REPLACE` + the REVOKE/GRANT make re-application idempotent. To
-- update: re-copy the upstream file's body and bump the SHA above.
--
-- The multi-org deploy workflow (Workstream 5) applies this to each tenant's
-- Supabase project with `supabase db push`, alongside deploying the function.
--
-- ───────────────────────────── upstream comment ─────────────────────────────
--
-- Function: public.link_bridge_identity_if_needed(text, text, text, text, text)
--
-- Called by the github-identity-bridge Edge Function's POST /tickets handler,
-- before minting a ticket, so GoTrue's normal custom-provider OIDC sign-in
-- resolves to an operator's existing Supabase user instead of minting a
-- duplicate one. GoTrue links identities purely by exact (provider,
-- provider_id) -- it has no notion of "this GitHub account is the same
-- real person as that other provider's identity" -- so a GitHub account
-- that's already linked under a different provider (typically native
-- `github` OAuth used from a browser) would otherwise get a second,
-- permanently separate auth.users row the first time its operator uses the
-- bridge. See docs/plans/2026-07-31-github-identity-bridge.md, "Bug"
-- section (2026-08-22), for the confirmed real-world instance this closes.
--
-- Deliberately does NOT handle the reverse ordering (a custom:github-bridge
-- identity already exists, pointing at a DIFFERENT user than a
-- newer/other-provider identity for the same provider_id -- i.e. bridge
-- sign-in happened before the operator's real account was ever linked).
-- That's a live-data merge across two already-diverged auth.users rows and
-- needs a human, same as the one-time manual backfill this function's
-- insert shape mirrors -- it is not something to do silently mid-sign-in.
--
-- SECURITY DEFINER is required only to read/write auth.identities, which
-- PostgREST's anon/authenticated roles have no access to by design --
-- EXECUTE is restricted to service_role below, matching the Edge
-- Function's own (service-role-key) caller.
--

CREATE OR REPLACE FUNCTION "public"."link_bridge_identity_if_needed"(
    "p_github_id" "text",
    "p_login" "text",
    "p_email" "text",
    "p_name" "text",
    "p_avatar_url" "text"
) RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  v_other_user_id uuid;
begin
  -- Already resolvable today by GoTrue's own lookup -- either this is a
  -- repeat bridge sign-in, or a prior call to this function (or the manual
  -- backfill) already linked it. Nothing to do.
  if exists (
    select 1 from auth.identities
    where provider = 'custom:github-bridge' and provider_id = p_github_id
  ) then
    return 'already_linked';
  end if;

  select user_id into v_other_user_id
  from auth.identities
  where provider_id = p_github_id and provider <> 'custom:github-bridge'
  order by created_at asc
  limit 1;

  if v_other_user_id is null then
    return 'no_other_identity';
  end if;

  -- `email` is a generated column (lower(identity_data->>'email')) -- it
  -- can't be assigned directly, only derived by putting 'email' in
  -- identity_data. Confirmed live via information_schema before writing
  -- this: an explicit email column in the INSERT list errors.
  insert into auth.identities (
    provider, provider_id, user_id, identity_data, last_sign_in_at, created_at, updated_at
  ) values (
    'custom:github-bridge',
    p_github_id,
    v_other_user_id,
    jsonb_build_object(
      'sub', p_github_id,
      'provider_id', p_github_id,
      'email', p_email,
      'email_verified', (p_email is not null),
      'name', p_name,
      'full_name', p_name,
      'user_name', p_login,
      'preferred_username', p_login,
      'avatar_url', p_avatar_url
    ),
    now(), now(), now()
  )
  -- Race guard: two concurrent bridge sign-ins for the same never-before-seen
  -- GitHub account could both pass the existence check above before either
  -- inserts. Harmless either way -- one insert wins, the other is a no-op.
  on conflict on constraint identities_provider_id_provider_unique do nothing;

  return 'linked';
end;
$_$;

ALTER FUNCTION "public"."link_bridge_identity_if_needed"("p_github_id" "text", "p_login" "text", "p_email" "text", "p_name" "text", "p_avatar_url" "text") OWNER TO "postgres";

-- This project's default privileges auto-grant EXECUTE on new `public`-schema
-- functions to anon/authenticated directly (not merely via PUBLIC) --
-- confirmed live via the security advisor after the first deploy of this
-- function flagged exactly that. REVOKE ALL FROM PUBLIC alone does not undo
-- those direct grants; anon/authenticated must be named explicitly. Verify
-- with `select grantee, privilege_type from information_schema.routine_privileges
-- where routine_schema='public' and routine_name='link_bridge_identity_if_needed'`
-- -- should list only service_role (+ postgres as owner) after this.
REVOKE ALL ON FUNCTION "public"."link_bridge_identity_if_needed"("p_github_id" "text", "p_login" "text", "p_email" "text", "p_name" "text", "p_avatar_url" "text") FROM PUBLIC, "anon", "authenticated";

GRANT ALL ON FUNCTION "public"."link_bridge_identity_if_needed"("p_github_id" "text", "p_login" "text", "p_email" "text", "p_name" "text", "p_avatar_url" "text") TO "service_role";
