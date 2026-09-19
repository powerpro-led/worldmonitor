-- Let a signed-in user reach their OWN account-features rows with their own
-- JWT — no service-role key involved.
--
-- Why now (2026-09-19): the first real Windows operator opened Settings →
-- Notifications in the local bundle and got "Failed to load notification
-- settings." Every account-features route (user-prefs, followed-countries,
-- notification-channels, alert-rules, telegram-pairing) went through
-- server/_shared/supabase-admin.ts's service-role client, and the local
-- bundle deliberately ships no service-role key (scripts/release/SECURITY.md:
-- an operator machine never holds a shared write credential). So those
-- routes 503'd on every operator install — recorded 2026-09-14 in
-- PLATFORM_ARCHITECTURE.md as "cloud-deployment-only by design".
--
-- They are not cross-user lookups, though: every one of these tables is keyed
-- by user_id and every query is `where user_id = <the caller>`. Stage 2/3
-- already wrote the own-row RLS policies for `authenticated`
-- (`(select auth.uid()) = user_id`) and left them inert on purpose, with the
-- note that a table grant would activate them. This is that grant.
--
-- What it does NOT do: `anon` still gets nothing; `service_role` policies are
-- untouched (the cloud deploy keeps using them); no policy is widened. A JWT
-- can only ever see/change rows whose user_id equals its own `sub`, enforced
-- by Postgres, not by application code.
--
-- Server side, server/_shared/supabase-admin.ts's getSupabaseForRequest()
-- picks the user-scoped client (publishable key + the request's bearer JWT)
-- only when no service-role key is configured — i.e. the local bundle.

grant usage on schema worldmonitor to authenticated;

grant select, insert, update, delete on worldmonitor.user_preferences      to authenticated;
grant select, insert, update, delete on worldmonitor.followed_countries    to authenticated;
grant select, insert, update, delete on worldmonitor.notification_channels to authenticated;
grant select, insert, update, delete on worldmonitor.alert_rules           to authenticated;
grant select, insert, update, delete on worldmonitor.telegram_pairing_tokens to authenticated;

-- `security invoker` + `set search_path = ''` (stage 2): the function runs
-- with the caller's role, so the own-row policies above apply inside it too.
-- A caller passing someone else's p_user_id gets 0 rows from the SELECT ...
-- FOR UPDATE and an RLS-rejected INSERT — same outcome as a direct table hit.
grant execute on function worldmonitor.set_user_preferences(uuid, text, jsonb, integer, integer) to authenticated;

-- createPairingToken() invalidates the caller's earlier unused tokens
-- (`update ... set used = true where user_id = ?`) before inserting a new one
-- — stage 3 gave `authenticated` select + insert but no update policy, so the
-- invalidation step would silently update 0 rows under RLS. The bot-side
-- consume path (by token, cross-user) stays service_role-only.
drop policy if exists telegram_pairing_tokens_update_own on worldmonitor.telegram_pairing_tokens;
create policy telegram_pairing_tokens_update_own
  on worldmonitor.telegram_pairing_tokens for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
