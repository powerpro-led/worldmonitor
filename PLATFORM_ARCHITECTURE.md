# WorldMonitor Platform Architecture — multi-tenant managed deployments

**Single source of truth** for the shift from "a downloadable local app" to "a
multi-tenant platform the repo devs operate for many orgs (nike, adidas,
walmart, …), each an isolated instance."

> This supersedes the framing of `LOCAL_APP_INITIATIVE.md`, which is now the
> **operator-client sub-track** (the thin local mirror each org's operators
> run). Read this file first; that one for the client bundle's mechanics.
> Update the **Status** line and the **Session log** every working session.

---

## Status

- **As of:** 2026-09-10 — **SCHEMA-COMPLETENESS GAP found (operator-requested review, via `org-provisioning-23`). The `worldmonitor` schema has TWO lineages; only ONE is in the repo.** (1) The **Clerk/Convex→Supabase migration, 2026-08-05/06** (memory `supabase-migration-stage1`): `users`, `api_keys`, `mcp_pro_tokens` (stage 1), `user_preferences`, `followed_countries` + `set_user_preferences()` SECDEF (stage 2), `notification_channels`, `alert_rules`, `telegram_pairing_tokens` (stage 3) — **applied via the Supabase MCP `apply_migration` tool straight against the cloud project `ixuezudybhjptisexgxx`; NEVER committed as `.sql` files** in `supabase/migrations/`. (2) The **config broker, 2026-09-04** (Workstream 1): `pipeline_config` + `wm_is_admin()` + touch trigger — the ONE committed migration. `ixuezudybhjptisexgxx` (now relabeled "biovita") was worldmonitor's own primary backend Aug→S68; `.env` L289-290 keep it as the commented switch-back `SUPABASE_URL`. **Consequences:** (a) the S69 local stack has ONLY `pipeline_config` — it's missing all 8 stage-1/2/3 tables + `set_user_preferences()`, which `server/_shared/{user-preferences,followed-countries,alert-rules,notification-channels,telegram-pairing}.ts` + `api/{user-prefs,followed-countries}.ts` actively use (would fail "relation does not exist" if the full backend ran against local; nothing's hit it because S69 validation only exercised `pipeline_config`). NOT a P9 casualty — P9 only touched `github-identity-bridge`. (b) biovita's `worldmonitor` schema is **live/in-use, not a dormant promotion artifact**. (c) **Second promotion hazard beyond the `pgrst.db_schemas` one:** `deploy-org.reusable.yml`'s `supabase db push` refuses when remote `schema_migrations` has versions absent locally (same `LegacyMigrationMissingLocalError` that blocked S69's local `migration up`). biovita has ~60 foreign entries (meta_*, okr_*, consumer_prices_*, worldmonitor_stage1/2/3, link_bridge ×3), none for `pipeline_config` — so the first promotion run against biovita **hard-fails** without a `migration repair --status applied <foreign versions>` / `db pull` baseline first; and a fresh-project promotion would get `pipeline_config` but NOT stages 1/2/3 (not in the repo to push). **Fix (assessed, NOT done — operator's call):** dump the stage-1/2/3 DDL from `ixuezudybhjptisexgxx` into `supabase/migrations/2026080*_worldmonitor_stage*.sql` ordered before `pipeline_config`; add a documented `migration repair` baseline step to the promotion runbook. Until then `deploy-org.reusable.yml` can only safely target a genuinely empty fresh project, provisioning `pipeline_config` alone.
- **As of:** 2026-09-10 — **Per-org provisioning contract §9 step 5 fully CLOSED — `provision-org.yml`'s worldmonitor job is live, pinned, and wired.** `org-provisioning` commit `38c2f60` (their `main`, unpushed — their operator's call) pins worldmonitor's fan-out job to `powerpro-led/worldmonitor/.github/workflows/deploy-org.reusable.yml@e2b694c49f0d136ea947d265a36d92d37739b5ae` — verified the full SHA against `git rev-parse e2b694c` locally before treating the report as confirmed, matches exactly. Platform's job pinned to `8c510c0…` alongside it. The `worldmonitor` job's `if:` uses `always()` + `needs.platform.result in (success, skipped)` so an `apps: [worldmonitor]`-only org (mosiq) still runs when platform's job is skipped for it. **This closes the entire contract arc this session ran end to end**: read the draft → verified its worldmonitor-facing claims against real files → caught a live schema-clobber risk and fixed it (`7170443`) → ratified with 3 concrete review points incorporated → resolved the mosiq `apps:` REVIEW flag via direct MCP verification (not a guess) → built `deploy-org.reusable.yml`, catching 2 gaps the contract itself never named → pushed to origin (operator-approved) → confirmed the pinned SHA both on the remote and against local git history. Nothing further owed from worldmonitor on this thread; `provision-org.yml` can now actually run a real promotion.
- **As of:** 2026-09-10 — **PUSHED. `main` == `origin/main` @ `da65e51`** (operator-approved, needed so `org-provisioning`'s `provision-org.yml` can pin `deploy-org.reusable.yml` by a fetchable SHA — a local-only commit isn't resolvable by another repo's CI). Confirmed on the remote, not just asserted: `git ls-remote` + `git merge-base --is-ancestor e2b694c da65e51` both checked before telling `org-provisioning-23` it was safe to pin. 52 commits went out — everything from S69 onward plus this session's contract-review and build work. **Every prior "NOT PUSHED (repo convention)" note in this doc below is now stale as of this push** — read commit hashes as absolute history, not as "still sitting local."
- **As of:** 2026-09-10 — **contract §9 step 5 BUILT: `.github/workflows/deploy-org.reusable.yml` lands, `deploy-org.yml`@`a0a00a6` superseded.** `org-provisioning` tagged `v0.2.0` (`0b10d64`) with the registry + `provision-org.yml` (fan-out committed but commented out pending each app's reusable SHA) + the ratified contract doc. Built worldmonitor's half: renamed `deploy-org.yml` → `deploy-org.reusable.yml`, `on: workflow_call` (the contract's 9 inputs) + a thin `workflow_dispatch` mirror for standalone runs, job declares `environment: ${{ inputs.org }}` explicitly (the contract's own build note — a called `workflow_call` job does NOT inherit the caller's environment context from `secrets: inherit` alone). Removed the `org-provisioning@v0.1.0` checkout + direct `./deploy.sh` call entirely (that's `provision-org.yml` step 5 now) and the now-unused `Setup Deno` step. **Real gap the contract never named, found and fixed:** `scripts/generate-nitric-org-stack.mjs` read its GCP project/region from `deploy/orgs/<org>.yml` — the exact file being deleted. Traced its actual data dependency (only `gcp.projectId`/`gcp.region` were ever read, despite the old file requiring `domain`/`supabase`/`variant` too) and rewrote it to take `--gcp-project=`/`--gcp-region=` as CLI flags fed from the `workflow_call` inputs, dropping the file-read path entirely; rewrote its test suite to match (5/5 green, no more "real mosiq fixture" dependency). **`domains` remap done**: `vars.APP_DOMAIN` + `secrets.WM_APP_DOMAIN` (two GH Environment values for one piece of data, previously) both retired — a `jq -Rr` step resolves `inputs.domains[0]` once, feeding both `local-config`'s `WM_APP_DOMAIN` function secret and the deploy's own `.env`'s `APP_DOMAIN`. Caught and fixed a real bug in that step before committing: `jq` auto-parses piped JSON, so calling `fromjson` on already-parsed input errored — fixed with `-R` (raw-string mode) so `fromjson` has an actual string to parse; verified all 4 cases (real domain, empty string, empty array, two-domain array) by hand before trusting it in CI. `deploy/orgs/mosiq.yml` deleted; `deploy/orgs/README.md` rewritten from a full schema doc into a short retirement pointer (the whole directory is obsolete — the registry lives in `org-provisioning/orgs/<org>.yml` now, contract §1). **mosiq's `apps:` REVIEW flag (contract §10) resolved, not blindly edited:** queried mosiq's live cloud project directly via the `supabase_mosiq` MCP tools rather than trusting either the transcribed `[platform, worldmonitor]` guess or old memory — `list_tables` returned ONLY `worldmonitor.pipeline_config` (no `public`/`okr` content), `list_migrations` showed only worldmonitor-flavored entries. Confirmed to `org-provisioning-23`: trim to `apps: [worldmonitor]` — they've applied it. Comment-only doc-accuracy fixes to `deploy/shared/{ais-ingest.yml,README.md}` + `deploy-ais-shared.yml` (filename references only; `CHANGELOG.md`/`ORG_PROVISIONING_BRIDGE_HANDOFF.md` left untouched as historical record / another repo's doc). **NEXT:** send the reusable's commit SHA to `org-provisioning-23` so `provision-org.yml`'s fan-out can be uncommented and pinned; nothing dispatches against a real org until then. `platform-48` building §5a in parallel.
- **As of:** 2026-09-10 — **per-org provisioning contract (`org-provisioning/docs/PER_ORG_PROVISIONING_CONTRACT.md`, v0.2.0 draft) read + confirmed from worldmonitor's side (`worldmonitor-f6`); NOT ratified yet (waiting on `platform-48`), NOTHING BUILT.** Verified its worldmonitor-facing claims (§5b/§5c/§3a) against the real files, not just the summary: `deploy-org.yml`'s current bridge-checkout+`deploy.sh` call (lines removed under the contract) and `deploy/orgs/mosiq.yml`'s ref (`lntyjouahofgewtkmpyi`) both match exactly. **Confirmed with two build-time notes carried forward, not contract blockers:** (1) `domains` (the new plural JSON-array `workflow_call` input) folds two separately-configured GH Environment values today — `vars.APP_DOMAIN` (deploy's own `.env`) and `secrets.WM_APP_DOMAIN` (local-config's function secret) — into one; real remap work when built, not zero-effort. (2) The reusable's own job will need `environment: ${{ inputs.org }}` declared explicitly — a called reusable workflow does NOT inherit the caller's `environment:` context just from `secrets: inherit`. **One thing flagged back, not resolved:** worth confirming platform's `tools/supabase/deploy-schema.sh` and org-provisioning's `deploy.sh` both apply schema via raw SQL rather than `supabase db push`/`migration up` — worldmonitor's own step DOES use `db push`, which writes to the shared `supabase_migrations.schema_migrations` table; if either of the other two ALSO used CLI-tracked migrations against a shared project like biovita, the exact "two repos' migrations collide on one shared-instance table" failure from S69's local stack would reproduce there. Names suggest they're raw-SQL (no collision), but unconfirmed. **§8 answered directly (it asked for worldmonitor's call):** recommended org-provisioning pin its reference to worldmonitor's reusable by commit SHA, not `@main` or a moving tag — matches every existing action reference in `deploy-org.yml` (all SHA-pinned already) and avoids a single worldmonitor push silently changing provisioning behavior for every org with no version negotiation. **RATIFIED 2026-09-10** (verified against the doc's own Status line, not just the peer report — all 3 of the above landed in the doc: `domains[0]` remap noted in §5b, the schema-apply table in §4 confirms org-provisioning's `deploy.sh` is raw `psql` with no `schema_migrations` write and leaves platform's mechanism as a `platform-48`-owed §10 confirm, SHA-pinning is now the stated rule in §8, and the `environment:`-must-be-declared build note landed near the top). **Build (§9) still gated — waits on 3 unrelated operator answers in §10 (project create-vs-verify, local GitHub OAuth App, PAT-vs-org-Actions-sharing) — do not start `deploy-org.reusable.yml` until that handoff actually arrives.**
- **As of:** 2026-09-09 — **stack-restart absorbed cleanly; a real ownership gap found on biovita, flagged to the operator.** Two days after S69 closed, the shared local Supabase stack had been restarted (container uptime ~20min at check time, not continuous since the 7th — likely a reboot, not anyone's action); the Postgres data volume survived (schema structure + the empty `pipeline_config` intact), but neither `supabase functions serve local-config` (worldmonitor's) nor the bridge's bare `deno run` (`org-provisioning`'s, on `:8000`) survive a restart — both were down, both were separately restarted by their respective owners (`org-provisioning-23`, a new peer session after a 2-day gap), no data lost. **Separately, `platform-48` (mid a cloud→local `public`+`okr` sync from a biovita dump) found a THIRD schema on biovita cloud neither repo's ownership doc claims: `consumer_prices` (12 tables, ~213 rows, its own `consumer_prices.schema_migrations`).** Verified against the actual codebase (not just name-matching): it's `consumer-prices-core/` — a self-contained worldmonitor package with its own raw-`pg.Pool` client and lightweight SQL-migration runner (hence the separate `schema_migrations`, unrelated to Supabase's), deliberately pinned to `search_path=consumer_prices` per a comment referencing a past incident where a stray migrate run polluted a shared project's `public` schema. Built 2026-07-25, last touched 2026-08-23 ("wire DATABASE_URL, verify live") — predates the platform pivot by weeks, explains why it's absent from every workstream doc. **Confirmed worldmonitor's; NOT added to local-stack sync** (the service has no `DATABASE_URL` in `.env`, isn't deployed by any `.github/workflows/*`, and `consumer_prices` isn't in `config.toml`'s `[api].schemas` — it was never PostgREST-exposed, only a direct Postgres connection). **Real open gap, flagged to the operator, not resolved here:** nothing in-repo deploys or migrates this against biovita — whatever's live there (12 tables, real data) was provisioned by some out-of-band means around Aug 23, outside any path this session could trace. Worth an operator decision on record-keeping (add to a schema-ownership doc) even though functionally nothing needs to change. **Also same day: the biovita `ALTER ROLE` clobber risk (flagged S69, below) went from "hypothetical, operator's call" to CONFIRMED LIVE** — platform's session MCP-verified biovita's `authenticator` role has no schema-GUC override today, meaning the very next `db push` of worldmonitor's `pipeline_config` migration would have triggered it for real. Fixed (`7170443`) — see the corrected note inline in the S69 bullet below; no live database touched, purely hardening ahead of a cutover that hasn't run yet. **Incoming, nothing to build yet:** the operator approved centralizing per-org provisioning in `org-provisioning` (a registry + `provision-org.yml` orchestrating both app repos) per `org-provisioning-23`'s closing handoff (`org-provisioning/HANDOFF_per-org-provisioning.md`). Eventual ask of worldmonitor: rework `deploy/orgs/` + `deploy-org.yml` into a `.github/workflows/deploy-org.reusable.yml` (`workflow_call`) — deploy logic stays worldmonitor's, org-provisioning owns trigger/registry/sequencing. A contract doc is still being drafted (blocked on an operator answer about cutover-vs-centralization sequencing) and will be circulated to a worldmonitor session before anything is built — do not start this unprompted. Also learned: **three worldmonitor sessions are running concurrently on this machine right now** (`worldmonitor-f6` = this one, plus `-ff`/`-4f`) — check for peer activity before assuming solo ownership of anything touching `deploy/orgs/`, `deploy-org.yml`, or this doc.
- **As of:** 2026-09-07 (session 69) — **unified-Supabase post-swap sequence (i–v) DONE, `13dd788`.** `org-provisioning-6e` finished swapping the local dev stack (containers now `supabase_*_org-provisioning`, `:54321` live, `worldmonitor` schema present but EMPTY — its `[db.seed]` was dropped). Ran, in order: **(i)** `supabase/config.toml` created (`project_id="org-provisioning"` + `[api] port=54321`) and committed. **(ii)** ⚠️ **CORRECTED — this was NOT an orphan.** Killed a `supabase functions serve github-identity-bridge` process, believing it a pre-swap leftover (it was pointed at a dir `d038ecc` had deleted from THIS repo, which looked like exactly the session-42 stale-child-process pattern) — but it was `org-provisioning-6e`'s **live, intentional** bridge server run from their own checkout. **Real finding, from `org-provisioning-6e`:** `supabase functions serve` from two different repo dirs against one shared local stack is **mutually exclusive** — it serves its whole `<repo>/supabase/functions/` dir and OWNS the single `supabase_edge_runtime_<project>` container's lifecycle; the last one to start wins, and killing either process **removes that container**, 503-ing the other's functions too. My kill took down their bridge; their restart-to-test-coexistence then took down `local-config` (a wrongly-orphaned PID `88462`, since its container was gone) — I killed the stale PID and restarted `local-config`, re-verified 200 end-to-end with a live bearer token. **Resolution (their side):** the bridge moved off `supabase functions serve` entirely, onto bare `deno run --allow-net --allow-env --env-file=.env supabase/functions/github-identity-bridge/index.ts` on `:8000` (bonus: this respects `.env`'s `SUPABASE_URL`, so the issuer is the correct external `http://127.0.0.1:54321/...` form instead of the internal `kong:8000` `functions serve` forced). **Division of the shared stack going forward: `:54321/functions/v1/` (the edge runtime) is worldmonitor's alone for `local-config`; the bridge lives on `:8000` via bare Deno. No more contention.** Lesson: on a stack another session also touches, verify a process's owner/purpose before killing it as an "orphan" — a directory a commit deleted from *your* repo doesn't mean the process isn't legitimately serving from *another* repo's copy of the same relative path. **(iii)** re-pulled the JWKS and found **`.env`'s `SUPABASE_JWT_PUBLIC_JWK` already matched** (kid `b81269f1...`) — **the S68 handoff's "rebuild rotates the ES256 key" claim did NOT hold this time**; no edit was needed. Flagged to `org-provisioning-6e`; cause unconfirmed (possibly a deterministic local-dev keypair rather than per-volume-random — don't assume either way next time, just re-pull and diff). **(iv)** `auth.users` was empty as expected; signed up `dev-operator@example.test` fresh (`enable_confirmations=false` returned a session immediately, no confirmation step), overwrote `~/.worldmonitor/session.json`, ran the broker chain live: `fetchBrokerConfig` → 200 `{upstashUrl:"http://127.0.0.1:8079", appDomain:"localhost:3000"}` → `refreshBrokeredConfig({force:true})` → `{status:"ok", changed:[]}` (config.db already held the same shim values — those are worldmonitor's own docker-compose creds, untouched by the Supabase-side swap). Test script was transient (`scratchpad/broker-local-test.mjs`), deleted after the run — recreate from this bullet's description if needed again, it is NOT preserved in the repo. **(v)** committed, reported back to `org-provisioning-6e`. **Also corrected:** the migration-drift note below (line was stale) — `d038ecc` already dropped the bridge migration, so repo `supabase/migrations/` now has **1** file (`pipeline_config`), not 2. **`worldmonitor` schema now POPULATED (same session, continued) — but NOT via `supabase migration up`.** That command refused: the shared instance's `supabase_migrations.schema_migrations` already had `org-provisioning`'s bootstrap migration (`20260907000000`) recorded, absent from worldmonitor's local `supabase/migrations/`, and its own suggested fixes (`db pull` / `migration repair --status reverted`) both mutate that ONE shared, cross-repo history table — checked with `org-provisioning-6e` before touching it. **Established pattern for this shared stack (`platform` already follows it): nobody runs `supabase migration up`/`db push`/`db pull`/`db diff` against `127.0.0.1:54322` — each repo applies its own schema via direct `psql`, scoped to its own schema; `schema_migrations` stays owned by `org-provisioning` for its one bootstrap row.** Second landmine caught before applying: `20260904120000_pipeline_config.sql`'s trailing `alter role authenticator set pgrst.db_schemas = 'public, worldmonitor'; notify pgrst, 'reload schema';` is a role-level GUC that OVERRIDES `config.toml`'s schema list for the whole shared instance — applying it verbatim would've silently dropped `graphql_public`/`storage` exposure for every repo on the stack. **Do NOT delete those lines from the migration file** — `deploy-org.yml` pushes this exact file to worldmonitor's real cloud org projects (mosiq, biovita) via `supabase db push`, where the ALTER ROLE is load-bearing (S57: without it, `worldmonitor.pipeline_config` 404s over REST on a dedicated project). Fix used instead — **exclude those two lines only at local-apply time**, migration file untouched:
  ```
  sed -E '/^[[:space:]]*alter role authenticator set pgrst\.db_schemas/d; /^[[:space:]]*notify pgrst/d' \
    supabase/migrations/20260904120000_pipeline_config.sql \
    | psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1
  ```
  then one manual `NOTIFY pgrst, 'reload schema';` (Supabase's `pgrst_ddl_watch` trigger would've picked up the new tables on its own regardless). Verified end-to-end: `anon` correctly 401s (`permission denied for schema worldmonitor` — no grant, by design), the `dev-operator` bearer token gets 200 `[]` on `GET /rest/v1/pipeline_config?Accept-Profile=worldmonitor`. **OPEN — flagged by `org-provisioning-6e`, not fixed, operator's call:** mosiq and biovita are themselves SHARED org projects (biovita is "platform-flavoured" per `CROSS_REPO_SUPABASE.md`) — if `deploy-org.yml` ever runs this same `ALTER ROLE ... = 'public, worldmonitor'` against biovita, it clobbers `platform`'s `graphql_public`/`storage` exposure there the same way this local landmine would have. Options: widen the cloud-deploy line to the full per-project union, or move cloud schema exposure to each project's own config the way the local stack does. Not urgent (biovita's current exposure untouched until the next `deploy-org.yml` run touches it) but real. **W5 + W6 local validation — DONE, same session.** **W5:** inserted a `worldmonitor.pipeline_config` row for a throwaway key, ran `hydratePipelineConfig()` (`server/_shared/pipeline-config-hydration.ts`) against a plain object seeded with a deliberately-stale value for that same key — confirmed the row unconditionally overwrote it (OQ-P7's contract: a revoked/rotated key must never be shadowed by a stale value) and left an unrelated key untouched. **W6:** set `app_metadata.wm_admin=true` on the local `dev-operator` user via the admin API, re-signed-in for a fresh JWT (claims bake in at sign-in, not live), then exercised `commitPipelineConfigValue()` (`src/services/admin-org-connection.ts` — the exact function `settings.html`'s admin panel calls) two ways: **(positive)** the admin session's upsert landed and read back correctly; **(negative)** a freshly signed-up NON-admin user's identical call was rejected with `new row violates row-level security policy for table "pipeline_config"` and nothing landed, read back via the admin session — confirming enforcement is genuinely Postgres RLS via `worldmonitor.wm_is_admin()`, not merely the client-side UX gate in `isCurrentUserAdmin()`. All test rows/users cleaned up after; the local `dev-operator` user is now LEFT with `wm_admin=true` (intentional — it's the standing local dev identity, useful for future admin-panel testing without repeating this setup). **Every queued local-validation item (Tier 1, Tier 2, W1, W3, W5, W6) is now done.** Remaining, unchanged: GCP `nitric up` never run; W2 `custom:github-bridge` on mosiq unvalidated; github-identity-bridge live steps remain `org-provisioning-6e`'s / operator-sequenced; `v2.13.0` tag + Desktop launcher surface are the two open operator calls (P12, unchanged).
- **As of:** 2026-09-07 (session 68) — **doc + local-validation session, NO application code changed.** `main` `16a48da`→`a01a033` (9 commits, still NOT pushed; markdownlint at its pre-existing 8-error floor; `bash -n` clean). Two threads:
  - **(A) `v2.13.0` release coherence.** `CHANGELOG.md [2.13.0]` was a fossil (documented the Workstream-R-reverted control panel); **rewritten** to the shipped model — config broker (P4/W1) + revocation · two-tier keys (`pipeline_config` W1/W6, dashboard **AI** tab W3) · cloud admin `settings.html` gated on `wm_admin` (W6) · vendored `github-identity-bridge` + runtime issuer (W2/P9) · denylist mirror (W4) · `ais-relay` decomposition + shared AIS ingest + deploy pipeline **flagged scaffold** (P14/P17/P18/W5) · Removed: cameras (P7), the loopback panel (`1095f08`+`ab0aee1`). A **live bug it surfaced, fixed** (`5adfe12`+`00040aa`): Workstream R pruned `settings.html` from the operator bundle but `scripts/release/setup.sh`+`setup.ps1` still built the Desktop launcher against `:46123/settings.html` (dead URL) — repointed at the dashboard root; `INSTALL.md`'s whole "First run" section rewritten around `worldmonitor-local login`→broker. **P12: every workstream landed (S67) AND the changelog is coherent (S68) — `v2.13.0` tagging is purely the operator's timing call. OPEN operator decision: what the Desktop launcher opens post-W-R (browser dashboard `:46123/` = current fix, vs. VS Code, vs. drop it — D5 pre-pivot, never re-decided).**
  - **(B) Local validation of the pivot (Ring 1 + Ring 2).** Ran against the already-up local Redis stack + a new `supabase start`. **Tier 1 (`9588329`):** 8 extracted P14 seeders run live — envelopes + seed-meta correct, corridor-risk's migrated `publishNotificationEvent` fires, `seed-telegram`/`sync-ais-results` graceful no-op without creds, `seed-transit-summaries` both branches (skip-when-portwatch-absent + 13/13 publish); 205 unit tests green. **Tier 2 (`39e28f8`):** standalone backend on `:46125` — `/api/health` 200 credential-free from the SQLite mirror, `GET /` serves the dashboard + `__WM_RUNTIME_CONFIG`, `/api/local-config` **404** (W-R route removal confirmed at runtime), `/api/local-llm-config` full GET/PUT/Clear round-trip (W3 backend), `get-chokepoint-status` RPC returns the exact `transitSummary` Tier-1 seeded (seeder→Redis→mirror→RPC intact). **W3 frontend (`630ce3e`):** `npm run build` clean at `APP_DOMAIN=localhost:3000` (the `1b3fdbe` hreflang fix holds); Playwright headless on `/?embed=vscode` → AI tab renders 4 fields + Clear×2 + SAVE. **W1 config broker (`a01a033`) — validated end to end:** *cloud* (mosiq) — operator enabled native GitHub OAuth + redirect allow-list + set `local-config` fn secrets; `worldmonitor-local login` → mosiq's first user → **before secrets: HTTP 500 `server_misconfigured`, client kept its cache (P4 fail-closed, observed live)**; *offline* — `.env` repointed to local Supabase (`http://127.0.0.1:54321`, BIOVITA kept as a commented `[switched-to-local-supabase]` block, JWK swapped to the local ES256 key — the app's server-side JWT verify works against local now), gitignored `supabase/functions/.env` with `WM_*`→`:8079` shim, `supabase functions serve` → a local user → `local-config` **200** with the shim creds → `refreshBrokeredConfig` caches them into `config.db` (also fixes the Tier-2 `sync-listener` DNS-fail). New `supabase/.gitignore`.
  - **Also:** the two project-scoped Supabase MCPs (`supabase_mosiq`, `supabase_biovita`) added at **user scope** (`~/.claude.json` — every repo sees them; need `claude /mcp` auth). A **handoff written to the sibling `platform` repo** (`../platform/LOCAL_SUPABASE_HANDOFF.md`) telling its agent to point `platform/.env` at this same running local Supabase stack (var-name map + the local ES256 JWK + shared-stack rationale).
- **CROSS-REPO CORRECTION landed 2026-09-07 (from a `platform` session — read `ORG_PROVISIONING_BRIDGE_HANDOFF.md` at repo root + `../platform/CROSS_REPO_SUPABASE.md`).** (a) **P9 superseded** — `github-identity-bridge` extracted to `../org-provisioning` (see the P9 row). W2 is being unwound; the drop is **sequenced** (org-provisioning must publish + `deploy.sh` run green on mosiq+biovita + worldmonitor's bridge redeploy *first* — then `DROP FUNCTION worldmonitor.link_bridge_identity_if_needed(...)` on mosiq only; biovita needs no drop). (b) **`platform` DECLINED the shared-local-Supabase request** (`LOCAL_SUPABASE_HANDOFF.md` superseded by `CROSS_REPO_SUPABASE.md`): its stated model is "no local Supabase stack for either repo — develop against the org's cloud project." **So worldmonitor's S68 local `supabase start` setup is now a unilateral choice, not the cross-repo model — OPEN operator decision: keep the local stack (it did validate W1 offline) or align with the cloud-per-org stance.** (c) Live bridge state (MCP-verified): biovita = fully wired (`public` schema, provider registered); mosiq = half-provisioned (`worldmonitor` schema fn from the pending-deletion migration, provider NOT registered).
- **DONE session 69 (see the bullet above) — NEXT SESSION pointer superseded, kept for history.** ~~NEXT SESSION — FIRST, the unified-local-Supabase-stack post-swap sequence (a peer `org-provisioning-6e` session is mid-swap as S68 closes — `supabase_db_worldmonitor` is already gone, `:54321` down, unified stack coming up from `../org-provisioning/supabase/config.toml`).** When `:54321` is back (`curl :54321/auth/v1/health`), run, in order: **(i)** create `worldmonitor/supabase/config.toml` = a 1-line `project_id = "org-provisioning"` (+ `[api]\nport = 54321` only if the CLI floor demands it — it does NOT reconfigure the stack, `functions serve` just reads `project_id` to find it). **(ii)** restart `supabase functions serve` from `worldmonitor/` (it now serves ONLY `local-config` — `github-identity-bridge` was deleted in `d038ecc`). **(iii)** re-pull `.env`'s `SUPABASE_JWT_PUBLIC_JWK` from `http://127.0.0.1:54321/auth/v1/.well-known/jwks.json` — the rebuild ROTATES the ES256 signing key (ports unchanged so every URL stays valid; `supabase/functions/.env`'s `WM_*` shim secrets are a repo file, survive). **(iv)** re-run the offline broker check (`scratchpad/broker-local-test.mjs` pattern: password-grant `dev-operator@example.test` / `devpass123456` — folded into org-provisioning's seed → `local-config` → expect 200 `{upstashUrl:":8079", appDomain:"localhost:3000"}` → `refreshBrokeredConfig({force:true})` → `config.db` picks it up). **(v)** commit `worldmonitor/supabase/config.toml` + report to `org-provisioning-6e`. **worldmonitor's dev backend (`nitric`/api/scheduler) is DOWN** — killed with the headless `worldmonitor-09` session; restart against the new stack only if a task needs it. `CROSS_REPO_SUPABASE.md` (platform, worldmonitor co-owns) is being rewritten by `org-provisioning-6e` — its "no local Supabase stack" section is reversed to the unified-shared-stack model.~~
- **github-identity-bridge extraction — codebase side DONE. DB side: the cutover this row described is DROPPED (operator decision, 2026-09-09, via `org-provisioning-23`) — kept below as history, do not act on it.** ~~`d038ecc` removed the vendored copy + migration + 3 `deploy-org.yml` steps; `a0a00a6` wired `deploy-org.yml` to `github.com/powerpro-led/org-provisioning` @ tag `v0.1.0` (2 steps: Check out + `./deploy.sh "$SUPABASE_PROJECT_REF"`). **NEW secrets the operator must create:** `ORG_PROVISIONING_TOKEN` (repo/org, read access to that private repo) + per-org `SUPABASE_DB_URL` (direct `:5432`, non-pooled). **Then, in order (operator, not automatable here):** run `org-provisioning/deploy.sh` green on **mosiq** then **biovita** (needs the 5 bridge secrets + 3 deploy creds; runner needs `supabase`+`psql`+`deno`+Docker; `BRIDGE_DB_SCHEMA` unset → `public`) → worldmonitor's bridge redeploys from `v0.1.0` on the next `deploy-org.yml` run → **only then** `DROP FUNCTION worldmonitor.link_bridge_identity_if_needed(text,text,text,text,text)` on **mosiq only** (biovita's `public` copy stays). Live state pre-`deploy.sh`: biovita already correct; mosiq has the fn in `worldmonitor` schema + NO provider row.~~ **Current reality (2026-09-09): the operator dropped the mosiq→biovita cloud bridge cutover entirely.** Local unified stack is the permanent dev SSOT; mosiq/biovita are now dormant promotion targets with no maintained bridge — nothing to cut over, no coordinated sequence, no `deploy.sh` run pending. The only residual is `DROP FUNCTION worldmonitor.link_bridge_identity_if_needed(...)` on mosiq — reclassified from "step 3 of a live cutover" to stale dead code, harmless where it sits, low-priority operator-gated cleanup whenever convenient (a future real promotion deploy would overwrite it anyway). Nobody is asking worldmonitor to run it. The `pgrst.db_schemas` hardening (`7170443`, above) stays valuable regardless — it's the correct end state for whenever an org is actually promoted local→cloud, cutover or not.
- **NEXT SESSION — then the still-pending local validation:** **W5** — insert a `worldmonitor.pipeline_config` row, run `server/_shared/pipeline-config-hydration.ts` (or `nitric start`), confirm it reaches `process.env` AND overwrites a stale `.env` value (OQ-P7). **W6** — `app_metadata.wm_admin=true` on the local `dev-operator` user, load `settings.html` from `dist/`, edit a category, confirm the RLS write lands in `pipeline_config`. **Migration drift:** repo `supabase/migrations/` has 2, mosiq has 5 — pull *only* the `_worldmonitor_schema`/`_final` `pipeline_config` corrections (S57), NOT the bridge fn (orphan-to-be). **Then** only GCP `nitric up` + the per-org-provisioning-orchestration open question (`deploy-org.yml` doing bridge provisioning re-introduces "worldmonitor required" for a `platform`-only org) remain. **Unchanged operator calls:** `v2.13.0` tag (P12 — no blocker); Desktop launcher surface post-W-R.
- **As of:** 2026-09-07 (session 67) — **WS-core + Telegram extraction DONE — Workstream 7 is COMPLETE, and every workstream (R, 1–7) with it.** `main` @ `<this doc commit>` (7 commits `e350c2d`→`bada2f3`, well ahead of `origin/main`, NOT pushed). `scripts/ais-relay.cjs` 6702 → 6182 lines. **Telegram (P18):** the MTProto poll loop → per-org `scripts/seed-telegram.mjs` `--once` job (`every 5min`, concurrency-1 Redis lock `intelligence:telegram-poll` — a 2nd live session = `AUTH_KEY_DUPLICATED`; per-channel cursors → `intelligence:telegram-feed:cursor:v1` 30d; the rolling last-`TELEGRAM_MAX_FEED_ITEMS` window merged into `intelligence:telegram-feed:v1` itself — **schema grew `{count,updatedAt,enabled}` → `+items[]`**). Both consumers (`server/.../intelligence/v1/list-telegram-feed.ts`, `api/telegram-feed.js`) repointed off `${WS_RELAY_URL}/telegram/feed` onto that Redis key (miss → `enabled:false`+`'not synced'`, not a 503); the relay's `GET /telegram` route + `telegram:` `/health` block + `gracefulShutdown` Telegram stanza deleted. **TransitSummary (supersedes P16 for the summary half — new P20):** P16 assumed a per-org relay; the relay is now ONE shared deploy and `seedTransitSummaries` merges the AIS Map (shared) with `supply_chain:portwatch:v1` + `supply_chain:corridorrisk:v1` (per-org). So it split: the shared service keeps publishing only the pure-AIS `supply_chain:chokepoint_transits:v1` (via `seedChokepointTransits`, still relay-local — the ONLY startBootSeedLoop left), and a NEW per-org `scripts/seed-transit-summaries.mjs` (`every 10min`) does the merge. **AIS-results bridge (P17):** new `scripts/sync-ais-results.mjs` (`every 2min`, per-org) copies `chokepoint_transits:v1` + its seed-meta VERBATIM from the shared "AIS results" Upstash into each org's Upstash + fires `notifyChange`; `sync-domains.mjs` gains `AIS_RESULTS_KEYS`/`isAisResultsKey()` (bridge-side, NOT `classifyKey` mirror classification). Oref stays in `ais-relay.cjs` (public alert data, one residential-proxy secret — rides the shared deploy), as do the ~13 public-data HTTP proxy routes (operator decision — fold into the shared service; per-org handlers keep calling `WS_RELAY_URL` at the shared deploy). **Deploy scaffold:** `generate-nitric-org-stack.mjs` `PINNED_SERVICES` → `{}` (**0 pinned per org**); new `deploy/shared/{README.md,ais-ingest.yml}` + `nitric.ais-shared.yaml` (pins `ais-relay` `min-instances:1` — the one pinned instance in the platform) + `.github/workflows/deploy-ais-shared.yml` (GH Environment `ais-shared`, its own creds only); `deploy-org.yml` env += `WS_RELAY_URL`/`AIS_RESULTS_UPSTASH_*`/`TELEGRAM_*`; `deploy/orgs/README.md` step 7 rewritten (Telegram-app registration) + step 8 added (point the org at the shared deploy). All scaffold parity — **`nitric up` still has never run** against the GCP target. Every commit: `node --check` + `biome` + `lint:boundaries` + `tsc(gcp)`/`typecheck:api` clean; per-commit `test:data` failing-group name-diffs — **0 new** (25-group noise floor; the lone mover is the documented `readBootstrapTierObject` `cancelledByParent` flake). ~18 test files retargeted (`transit-summaries` rewritten around an exported pure `buildSummaryRow`; `telegram-feed-contract` rewritten to mock the Upstash GET wire shape — went 3/8→12/12; `relay-boot-seed-freshness-guard` SEEDERS −1; `chokepoint-id-mapping`/`portwatch-upstream`/`layer-explanations` cadence sources moved from relay consts → `gcp/scheduler/main.ts` CADENCES). `v2.13.0` still on hold (P12).
- **As of:** 2026-09-06 (session 66) — **Mirror-refresh UI follow-up DONE (both parts).** `main` @ `<this doc commit>` (code `9e37fab` part 1 + `2973815`, well ahead of `origin/main`, NOT pushed). **Part 1 (`9e37fab`):** `Panel.showNotSynced(message?, onRetry?, autoRetrySeconds?, opts?)` — in a sidecar-backed runtime where a recent RPC carried `X-WM-Mirror-Keys`, renders a "not synced to this device yet" state + a **Refresh from cloud** button (`refreshMirrorKeys` → `POST /api/local-sync-refresh`, then re-runs `onRetry`); **everywhere else it is byte-for-byte `showError(message, onRetry, autoRetrySeconds)`**, a safe drop-in at any panel failure branch. Named `showNotSynced` **not `showUnavailable`** — 5 panels (DailyMarketBrief, GlobalProcurement, Giving, MarketImplications, Insights) already define a bespoke `showUnavailable()` for a "feature needs live data" state; the collision (a silent incompatible-signature override) is why the name changed mid-session. `src/services/mirror-key-hints.ts` gains `getRecentMirrorKeyHints({ pathPrefix?, maxAgeMs? })` (union of every live hint's keys, freshest RPC first, deduped, cap 16 — a panel calls a service fn not a URL, so exact-path `getMirrorKeyHint()` was unusable from a panel). 4 new `common.*` i18n keys synced across all locales + `en.shell.json`. `mirror-key-hints.test.mts` +7 (18/18). **Part 2 (`2973815`):** `this.showError(` → `this.showNotSynced(` across **48** `src/components/*Panel.ts` (mechanical `sed`; Panel.ts internal fall-through + NewsPanel's `showError` override untouched — NewsPanel got a parallel `showNotSynced` override that clears `lastRawClusters`/`lastRawItems`). 2 tests fixed (`frontend-cii-source-of-truth` harness mock method + regex; `giving-panel-expiry` stub `Panel.showNotSynced`). `tsc` + `typecheck:api` + `biome` (touched) + `lint:boundaries` clean; full `test:data` name-diff vs a clean `daec068` `git stash` baseline **identical** (same 25 pre-existing failing groups, 0 new). **Only WS-core + Telegram extraction (P14 Phase 2 tail) remains in Workstream 7** — its own session (new shared-ingest deploy target, GH Environment, Cloud Run + Cloud Scheduler).
- **As of:** 2026-09-06 (session 65) — **Workstream 7 direct-fetch audit done + first domain (infrastructure) fix landed.** `main` @ `<this doc commit>` (after `ad64e4c`; well ahead of `origin/main`, NOT pushed). Full audit of the 22 direct-fetch RPC handlers + 9 shared modules under the 6 `cloudPreferredPrefixes` (see the Workstream 7 checklist item + `scratchpad/ws7-direct-fetch-audit.md` for the per-handler table). **Headline:** `cloudPreferredPrefixes` predates both Workstream 4 (denylist mirror inversion) and the S57–S64 seeder buildout — **infrastructure / research / military / news** and most of **economic / market** are now already served from the Upstash→SQLite mirror via existing seeders + auto-mirror + cache-first handlers. Genuine remaining work was (1) a mirror-deny bug [FIXED, Fix #1], (2) a tail of on-demand RPCs — but a deep verification pass showed **every direct-fetch handler under the 6 prefixes either reads a seeded+mirrored key first or already returns a `cache-contract.ts`-recognised degraded marker** (`available:false` / `unavailable:true` / non-empty `error`). `economic/list-world-bank-indicators` is frontend-dead (0 callers; WB panels use seeded bootstrap keys). Only 2 real silent-empty gaps remain (`imagery/search-imagery`, `military/get-wingbits-live-flight`), **both off the 6-prefix critical path**. **Pass 3 conclusion: `cloudPreferredPrefixes` is INERT in the P2 default config** — `isCloudPreferred()` is only consulted behind `if (context.cloudFallback && …)` and `cloudFallback` defaults off, so the 6 domains already run their local handlers against the mirror. The direct-fetch checklist item is **retired for P2's real runtime config** (marked `[x]`); residuals are optional cleanup / a `cloudFallback=true`-only sidecar improvement / 2 off-path proto markers. **Fix #1 landed (`<this commit>`):** `scripts/shared/sync-domains.mjs` `DENY_PREFIXES` had a blanket `'cf:'` that denied `cf:radar:ddos:v1` + `cf:radar:traffic-anomalies:v1` — the ONLY `cf:` keys in the store, both Cloudflare **Radar** display data (sole source for the DDoS + traffic-anomaly infra panels, pure Redis readers with no fetch fallback). A Workstream 4 name-based misclassification; both panels were permanently blank on every operator mirror (masked only by `/api/infrastructure/v1/` being cloud-preferred). Narrowed `'cf:'` → `'cf:cache:'` (cache-purge bookkeeping); `writeExtraKeyWithMeta`'s fast-path `notifyChange` nudge for these keys now also fires. `tests/sync-domains.test.mjs` +1 regression block (`cf:radar:*` → `'mirror'`, `cf:cache:purge` still `'deny'`); `lint:boundaries` + `typecheck:api` + `biome` clean, related tests (`sync-domains` + `mcp-bootstrap-parity` + `seed-utils-notify-mirrored-writes`) 56/56 via `tsx`. **Fix #2 (NOT done — operator call):** dropping `/api/infrastructure/v1/`, `/api/research/v1/`, `/api/military/v1/`, `/api/news/v1/` from `cloudPreferredPrefixes` once each domain's path-(b) handlers have an explicit degraded state — changes offline behavior for every operator. **Also this session (`12522cf`+`64a7c9d`): per-key mirror-refresh backend + client hint layer** — `POST /api/local-sync-refresh {keys}` (targeted Upstash→SQLite pull via `sync-listener.mjs`'s `applyChange`) + an `X-WM-Mirror-Keys` response header (self-maintaining, captured in `redis.ts`'s `readCachedJson`/`getRawJson` via a `UsageScope.mirrorKeys` Set the sidecar opts into) so a panel knows which key(s) to refresh. `64a7c9d` adds the client `src/services/mirror-key-hints.ts` (`recordMirrorKeyHint` wired into `premiumFetch`, `getMirrorKeyHint`, `refreshMirrorKeys`). Only the shared "not synced yet + Refresh" panel affordance + its per-panel adoption remain — pure mechanical work now, data path done end to end. **Operator decisions taken this session: P17 (AIS ingest → shared results Upstash, not a per-tenant token registry), P18 (Telegram poller → per-org `--once` job), P19 (`cloudFallback` stays OFF — `cloudPreferredPrefixes` deleted).** WS-core + Telegram extraction now unblocked (own session — new shared-ingest deploy target).
- **As of:** 2026-09-06 (session 64) — **P14 Phase 2: the Classify seed loop is out (25 of 27 gone).** `main` @ `<this doc commit>` (code `f05f7f3`, after `65417f9`; well ahead of `origin/main`, NOT pushed). The largest single loop in `ais-relay.cjs` — a **notification migration**, not a straight port. New **`scripts/seed-classify.mjs`** (**hand-rolled**, `export async function main()` + `acquireLockSafely`, NOT `runSeed` — the loop writes N individual `classify:sebuf:v6:<hash>` cache keys, a *conditional* `news:threat:summary:v1` canonical, and emits `rss_alert` notifications mid-run per LLM batch; none of that fits `runSeed`'s one-canonical-key model and its ~12-min inter-variant stagger blows the ~4-min fetch-phase deadline). Ported verbatim: the `rss_alert` `publishNotificationEvent` (inline-Upstash LPUSH+SETNX copy from `seed-corridor-risk.mjs`, `surface: 'seed-classify'`, importanceScore recomputed from the post-LLM level), the whole `relay*` importance-score block (`relayComputeImportanceScore` + `RELAY_SOURCE_TIERS` + diplomacy/flashpoint keyword tables), the `THREAT_COUNTRY_*` attribution tables + `matchCountryNamesInText`, `classifyCacheKey` (`classify:sebuf:v6:`), and the `CLASSIFY_LLM_PROVIDERS` ollama→openrouter→groq chain. **Deviations:** `classifyInFlight` module flag → a 20-min Redis lock (`news:classify`) so a 15-min tick that overruns is skipped; `news:threat:summary:v1` write via `atomicPublish` (adds the sync-notify nudge) with TTL raised **1200s→7200s** to clear `api/health.js`'s `newsThreatSummary.maxStaleMin` (60min) strictly per `tests/seed-ttl-outlives-staleness-fleet.test.mjs`; **`seed-meta:classify` dropped** — grep found no reader outside the relay's own boot gate (`seed-meta:news:threat-summary` still written, unconditionally, every run). `-671` lines from `ais-relay.cjs` (also deleted: the now-orphan `upstashMGet`; **KEPT**: `publishNotificationEvent` + `upstashSetNx/Lpush/Del` + the `@notification-source: domain` header — still used by the OREF `oref_siren` producer). `RELAY_GATES_READY` now read by the cron. New `scripts/railway-services.json` + `gcp/scheduler/main.ts` `CADENCES` entry (`every 15 minutes`). Tests: `relay-importance-recompute.test.mjs` → renamed `classify-importance-recompute.test.mjs` + retargeted; `importance-score-parity` + `diplomacy-keywords-parity` + `news-classify-cache-prefix-audit` retargeted from `ais-relay.cjs` to `seed-classify.mjs`; `notification-relay-payload-audit` PRODUCER_FILES +1; `relay-boot-seed-freshness-guard` SEEDERS −1 (+ its "every seed loop routes through startBootSeedLoop" test relaxed — zero named wrapper functions is now the expected state, Transit/TransitSummary call `startBootSeedLoop` inline). `tsc --noEmit` + `typecheck:api` + `biome` + `lint:boundaries` clean; full `test:data` run **twice** on-branch + diffed name-for-name against a clean `65417f9` `git stash -u` baseline (run twice) — **0 new regressions** (`readBootstrapTierObject` is the ±1/run `cancelledByParent` flake — flipped in/out of the *baseline* itself across the two runs; `railway-registry` / `nixpacks-import-graph` / `no-escape-import` = the documented pre-existing `process-*-tasks`/`scenario-worker` Dockerfile set). Live-smoke-tested against prod Upstash (`APP_DOMAIN=worldmonitor.app`). **P14 Phase 2 loop extraction is now COMPLETE — 25 of 27 out; Transit + TransitSummary stay in `ais-relay.cjs` permanently by decision (new P16).** Both read the in-process AIS `chokepointCrossings` Map; a standalone cron would publish all-zero counts. The "relay flushes the Map to Redis" alternative was declined — bespoke indirection, 3 sites for byte-identical output, no correctness gain. Documented as a permanent exception (not a TODO) in the `seedChokepointTransits` block comment, the `relay-boot-seed-freshness-guard` `SEEDERS` comment, and P16. Oref = the 28th, a real-time poller, belongs with the WS-core/Telegram extraction (still blocked on cross-org-secrets).
- **As of:** 2026-09-06 (session 63, later-3) — **P14 Phase 2: the Market seed loop is out (24 of 27 gone).** `main` @ `<pending doc commit>` (after `a8f6c64`; well ahead of `origin/main`, NOT pushed). `seedAllMarketData` was a 9-way bundle — 8 sub-seeds already had standalone/bundle coverage, so extracting the 9th (`seedSectorSummary` → new **`scripts/seed-sector-summary.mjs`**, `runSeed`, `every 15min`, `e91333c`) unblocked deleting the whole loop: **`a8f6c64`, −1064 lines** from `ais-relay.cjs` (9 `seedXxx` fns + `seedAllMarketData`/`Once` + `startMarketDataSeedLoop` + the equity trading-day gate + the entire Yahoo crumb/chart/curl-proxy stack + `fetchYahooChartDirect` + `fetchFinnhubQuoteDirect` + `parseSectorValuation` + `CHINA_COUNTRY_STOCK_SYMBOL` + the `./shared/market-*.cjs` / `./_country-stock-index.mjs` require()s). **NOT a straight port — it published `market_alert` notifications** (equity/commodity/crypto moves; the S61 "Market: investigated, left alone" note never audited its `publishNotificationEvent` calls). Caught on the regression diff by `notification-relay-coalesce-key.test.mjs` — the exact trap the standing rules warn about. Ported to a new **`scripts/shared/market-alert-coalesce-key.cjs`** (`marketAlertCoalesceKey` verbatim) + new **`scripts/shared/market-alert-notify.mjs`** (one shared `dispatchMarketAlerts()` publisher — 3 call sites, so it lives once) invoked from each of the 3 market seeds' `afterPublish` with its own thresholds (equity/commodity ≥5%/crit ≥10%, crypto ≥10%/crit ≥20%; top 3 by |move|; `dedupTtl 3600`); all 3 tagged `@notification-source: domain`. Fallout: `Dockerfile.relay` −4 dead COPYs; `.env.example` −`DISABLE_RELAY_MARKET_SEED`/`MARKET_YAHOO_REFRESH_INTERVAL_MS`. 9 test files retargeted from source-grepping the deleted relay market code to the standalone seeds / new shared modules; `relay-boot-seed-freshness-guard` SEEDERS −1. `tsc --noEmit` + `typecheck:api` + `biome` + `lint-boundaries` clean; full `test:data` run **twice** on-branch + diffed name-for-name against a clean `ee013e3` `git stash -u` baseline — **0 new regressions** (`readBootstrapTierObject` is the ±1/run `cancelledByParent` flake; `railway-registry` / `nixpacks-import-graph` / `no-escape-import` are the documented pre-existing `process-*-tasks`/`scenario-worker` Dockerfile failures). **Remaining 3 loops:** Classify (notification tier + ~400-line dependency port, own session); Transit + TransitSummary (blocked on the in-process-AIS decision below — operator's call). Oref stays (real-time poller, WS-core/Telegram extraction, blocked on cross-org-secrets).
- **As of:** 2026-09-05 (session 63, later-2) — **P14 Phase 2: CorridorRisk + ShippingStress notification migration done (23 of 27 gone).** `main` @ `886d295` (after `ee013e3`; well ahead of `origin/main`, NOT pushed). Both loops published notifications → same UCDP/Weather treatment: the `>=50`-score `corridor_risk` and `>=75`-score `shipping_stress` publishers moved to the new standalone crons with the Redis data. No standalone sibling existed for either → each a new `scripts/seed-*.mjs` on the `runSeed` contract + an `afterPublish` hook carrying the publisher (inline-Upstash `publishNotificationEvent` copied from `seed-weather-alerts.mjs`) + `railway-services.json` + `CADENCES` entry. **`seed-corridor-risk.mjs`** — fetch/Cloudflare-guard/`CORRIDOR_RISK_NAME_MAP`/risk-level derivation verbatim; `every 1h`; TTL 14400 already clears the 120-min health gate (**no ratchet bump this time** — the `seed-ttl-outlives-staleness-fleet` trap that bit USNI/PizzINT/PositiveEvents was checked and both keys pass). **`seed-shipping-stress.mjs`** — carrier basket + `40 - avgChange*3` score verbatim; Yahoo fetch now via the shared `scripts/_yahoo-fetch.mjs` + `parseYahooChart` (not ais-relay's `fetchYahooChartDirect`, which stays for the Market loop); the relay's 20-min `setTimeout` retry dropped → `runSeed` RETRY-on-empty + next 15-min tick; TTL 3600 clears the 45-min gate. **KEPT in `ais-relay.cjs`:** `CORRIDOR_RISK_REDIS_KEY` + `latestCorridorRiskData` — the relay-local TransitSummary loop (consumes the live AIS `chokepointCrossings` Map) Redis-hydrates `supply_chain:corridorrisk:v1` on its own 10-min tick, so corridor data still reaches transit summaries — just not instantly (the relay used to kick `seedTransitSummaries()` straight from `seedCorridorRisk`). `-206` lines from `ais-relay.cjs`; every deleted identifier grepped repo-wide (only test files referenced them). Tests: `relay-boot-seed-freshness-guard` SEEDERS −2; `notification-relay-payload-audit` PRODUCER_FILES +2; `corridorrisk-upstream` + `transit-summaries` retargeted the `seedCorridorRisk` assertions to the new file. `tsc --noEmit` + `typecheck:api` + `biome` + `lint-boundaries` clean; full `test:data` diffed name-for-name against a clean `ee013e3` in-place checkout — **identical 25-name failure set, 0 new regressions** (`railway-registry`/`nixpacks-import-graph`/`no-escape-import` = the documented pre-existing set, all about `process-*-tasks`/`scenario-worker` Dockerfiles; `readBootstrapTierObject` = the known flake). **Remaining 4 loops:** Classify (notification tier + ~400-line dependency port, own session); Transit + TransitSummary (blocked on the in-process-AIS decision below — operator's call); Market (needs `seed-sector-summary.mjs` first). Oref stays (real-time poller, WS-core/Telegram extraction, blocked on cross-org-secrets).
- **As of:** 2026-09-05 (session 63, later) — **P14 Phase 2: 3 rate-limited ports out of `ais-relay.cjs` (21 of 27 gone).** `main` @ `<pending doc commit>` (after `aa8ef32`). **PositiveEvents** → `scripts/seed-positive-events.mjs` (`fe5de39`) — GDELT GKG GeoJSON; the loop's hand-rolled `setTimeout(5_500)` between the 6 theme queries replaced by `_gdelt-fetch.mjs`'s cross-process rate gate (`GDELT_RATE_WINDOW_MS = 5_500` — same floor, now coordinated with the 3 other GDELT seeders + adds the direct→proxy fallback the raw `https.get` lacked); TTL raised 2700→4500 (75min) to clear the 60-min staleness gate the relay's 45-min TTL was silently under; `every 15 minutes`. **WsbTickers** → `scripts/seed-wsb-tickers.mjs` (`aa8ef32`) — `runSeed` contract, ticker regexes/blacklist/aggregation verbatim, reads `market:stocks-bootstrap:v1`; `every 3h`. **SocialVelocity** → `scripts/seed-social-velocity.mjs` (`aa8ef32`) — **hand-rolled** (`export async function main()` + guard, like `seed-gas-storage-countries.mjs`), NOT `runSeed`, because it keeps the bespoke `status:'ok'/'error'` + `errorReason` seed-meta that `api/health.js` classifyKey reads to raise SEED_ERROR immediately on a Reddit fetch failure (no `runSeed` equivalent); canonical write via `atomicPublish`; `every 3h`. **New `scripts/_reddit-hot.cjs`** — the "Reddit data fetch" block (ScrapeCreators→OAuth→public, token single-flight+cooldown, `_normalizeVendorPost`) ported verbatim, `require`d by both. 3 test files retargeted from source-grepping `ais-relay.cjs` (`positive-events-seed-failure`, `social-velocity-seed-health`, `reddit-oauth-fetch`); `relay-boot-seed-freshness-guard` SEEDERS −3. `tsc --noEmit` clean repo-wide; full `test:data` diffed name-for-name against **two** `9bf6bf3` in-place baseline runs — **union of branch failures ⊆ union of baseline failures, 0 new** (the suite flakes ~1 name/run: `readBootstrapTierObject` — a `cancelledByParent` timing flake whose test + module are byte-identical across the diff — and `renewable energy last-known-good` flip in and out on both trees). **Remaining 6 loops:** CorridorRisk + ShippingStress (notification migration, full UCDP/Weather treatment — next); Classify (notification tier + ~400-line dependency port, own session); Transit + TransitSummary (blocked on the in-process-AIS decision below — operator's call); Market (needs `seed-sector-summary.mjs` first). Oref stays (real-time poller, WS-core/Telegram extraction, blocked on cross-org-secrets).
- **As of:** 2026-09-05 (session 63) — **P14 Phase 2 loop extraction: 3 more straight ports out of `ais-relay.cjs` (18 of 27 gone).** Continued the S62 batch. Extracted, each its own commit + live smoke-tested + `git stash -u` regression-diffed (0 new): **Satellites** → `scripts/seed-satellites.mjs` (CelesTrak TLE, every 2h, `cbb78e2`); **USNI-fleet** → `scripts/seed-usni-fleet.mjs` (every 6h, HTML parse stays in `scripts/lib/usni-fleet-parser.cjs`, 7-day stale key as a `runSeed` extraKey, `35b068d`); **PizzINT** → `scripts/seed-pizzint.mjs` (pizzint.watch + GDELT tensions, every 10min, `a4db79d`). One regression the verbatim ports introduced and `94ea434` fixed: `tests/seed-ttl-outlives-staleness-fleet.test.mjs` requires `ttlSeconds` STRICTLY `> maxStaleMin*60`, and USNI (43200==43200) + PizzINT (1800==1800) copied the relay's exactly-equal TTLs — the relay dodged the ratchet because it isn't a `seed-*.mjs` file. Bumped to 64800 / 3600. `tsc --noEmit` clean repo-wide; full `test:data` diffed name-for-name against a clean `9bf6bf3` in-place checkout — **identical 38-name failure set, 0 new regressions** (the 3 `railway-registry`/`nixpacks-import-graph`/`no-escape-import` failures are in that pre-existing set). **The S62 handoff's tier-1 list was wrong on 3 of 6** — verified against the actual loop bodies this session: **Classify** calls `publishNotificationEvent({eventType:'rss_alert'})` *and* depends on ~400 lines of relay-local scoring machinery (`RELAY_SOURCE_TIERS`, `relayComputeImportanceScore`, relay recency/tier gates, `classifyFetchLlm`+`CLASSIFY_LLM_PROVIDERS`, `matchCountryNamesInText`, `upstashMGet`) — it's a notification-migration + big-dependency job, the largest single loop in the file, not a straight port; **Transit** (`seedChokepointTransits`) reads `chokepointCrossings`, an **in-process Map fed by the relay's live AIS WebSocket vessel stream** — a fetch-based cron cannot reproduce it (would publish all-zero counts); **TransitSummary** merges portwatch (Redis, portable) + `latestCorridorRiskData` (in-process, Redis-hydratable) + `chokepointCrossings` (same AIS blocker). **Remaining 9 loops:** PositiveEvents/SocialVelocity/WsbTickers (rate-limited — GDELT 5.5s throttle / Reddit ban risk — port throttle verbatim); CorridorRisk + ShippingStress (notification migration, full UCDP/Weather treatment); **Classify → reclassify to notification tier, own session**; **Transit + TransitSummary → NOT extractable as crons** — either leave in `ais-relay.cjs` (they consume the relay's core AIS function) or design a new split (relay flushes `chokepointCrossings` to Redis, standalone reads it) — operator's call; Market stays (needs `seed-sector-summary.mjs` first); Oref stays (real-time poller, belongs with WS-core/Telegram, blocked on cross-org-secrets decision).
- **As of:** 2026-09-05 (session 62, later) — **P14 Phase 2 loop extraction underway: 5 more loops out of `ais-relay.cjs` (15 of 27 gone).** After the UCDP/Weather notification migration below, started on the 17 "genuinely unique, no standalone sibling exists" loops the S61 audit flagged. Cross-checked all 17 against `gcp/scheduler/main.ts`'s `CADENCES` (exhaustive — built from `railway-services.json`) to confirm none are quietly covered; they aren't, so each extraction is a **new** `scripts/seed-*.mjs` + registry + `CADENCES` entry, not a check-and-delete. Done so far, each its own commit: **GSCPI** → `scripts/seed-gscpi.mjs` (1:1, `5d03aed`); **CII / Chokepoints / CableHealth / TemporalAnomalies RPC warm-pings** → one consolidated `scripts/seed-rpc-warmpings.mjs` on an 8-min cadence (`fb64f12` — a deliberate deviation from the 1:1 template: they're four near-identical GET-only pings that write no Redis, and over-pinging the 30-min ones is harmless since each RPC handler serves from its own cache). Both waves also swept up **4 chronically-red tests** left broken by S61's Cyber/ServiceStatuses removals (same P14 work, earlier phase): `layer-explanations.test.mts` (added a `schedulerCadenceMinutes()` helper to read `CADENCES` instead of deleted `ais-relay.cjs` constants), `relay-warm-ping-auth.test.mts`, `seed-health-risk-scores.test.mjs`, `seed-warm-ping-origin.test.mjs`. `tsc --noEmit` clean; full `test:data` diffed clean-tree vs. branch — 0 new regressions, 3–4 pre-existing failures fixed per wave. **Remaining 10 loops** (Market stays — deferred, needs `seed-sector-summary.mjs` first): Satellites, PositiveEvents, Classify, USNI-fleet, SocialVelocity, WsbTickers, PizzINT, Transit, TransitSummary (no notifications — straight ports); **CorridorRisk + ShippingStress publish notifications** — need the same migration treatment UCDP/Weather got. Reddit-sourced (SocialVelocity/WsbTickers) and GDELT-sourced (PositiveEvents) ones carry rate-limit/ban risk — port their existing throttle logic faithfully.
- **As of:** 2026-09-05 (session 62) — **P14 Phase 2 continued: UCDP and Weather's notification logic ported to their standalone scripts, both loops now deleted from `ais-relay.cjs` for good (10 of 27 gone).** Completes the item session 61 flagged as its next candidate (see the S61 bullet below). `conflict_escalation` (UCDP) and `weather_alert` (NWS) publishing — including their Redis-backed dedup/coalesce-key machinery, ported from the same `wm:events:queue` LPUSH + SETNX pattern `scripts/seed-aviation.mjs` already used — now live in `scripts/seed-ucdp-events.mjs` and `scripts/seed-weather-alerts.mjs`. Two real bugs caught and fixed before this could ship: (1) the standalone weather script never captured the NWS VTEC field its own coalesce-key logic needed — the adjacent-zone dedup would have silently never fired; (2) deleting `ais-relay.cjs`'s writer block also deleted `UCDP_TRAILING_WINDOW_MS`/`UCDP_PAGE_SIZE`, which the *separate*, untouched on-demand `/ucdp-events` relay-reader still referenced — a `node --check` clean but `ReferenceError`-at-runtime landmine, caught only by grepping every identifier the deleted blocks declared for remaining references. 8 test files updated to source-grep the new files instead of the deleted `ais-relay.cjs` functions (`tests/ucdp-seed-resilience.test.mjs`, `tests/ucdp-retention-window.test.mjs`, `tests/documentation-alignment-guardrails.test.mjs`, `tests/notification-relay-{payload-audit,coalesce-key,country-filter}.test.mjs`, `tests/relay-boot-seed-freshness-guard.test.mjs`, `tests/layer-explanations.test.mts`); 3 dead ais-relay functions/constants that only the deleted loops used (`ucdpVersionRank`/`ucdpVersionNewer`, `deriveWeatherCoalesceKey`) removed along with them, since the standalone UCDP writer's discovery is sequential-by-construction and doesn't need version-ranking at all. Verified: `tsc --noEmit` clean repo-wide; full `npm run test:data` at its pre-existing noise floor (95 fail — identical set to the session-61 baseline, confirmed by diffing failing-test names across two runs — 0 new regressions). Committed `069ea81`.
- **As of:** 2026-09-05 (session 61) — **P14 Phase 2 started: 8 of 27 `startBootSeedLoop` loops removed from `ais-relay.cjs`.** Full loop-by-loop audit (redundant-duplicate vs. genuinely-unique) completed and recorded below; TheaterPosture, ServiceStatuses, Spending, WorldBank, ClimateNewsSeed, ChokepointFlows, TechEvents, and the already-dead Cyber loop deleted (each a confirmed pure duplicate of an already-independently-scheduled `scripts/seed-*.mjs`), `-1848` net lines. **UCDP and Weather were also deleted then restored same-session** — both turned out to also publish live notifications (`conflict_escalation`, severe weather alerts) that no standalone script replicates; deleting them was a real regression caught by the test suite, not by the initial audit (which only checked Redis-key duplication). See commits `629df49`/`7febde9`. Market's `seedAllMarketData` (a 9-way bundle) was investigated and left alone — 8/9 sub-seeds are covered elsewhere but `market:sectors` has no standalone replacement. Remaining Workstream 7 items: the rest of P14 Phase 2 (WS core + Telegram poller extraction, blocked on a cross-org secrets decision — see below), the 21 direct-fetch handlers, and `cloudFallback`.
- **As of:** 2026-09-05 (session 61, earlier) — **Workstream 7's cameras removal (P7) done and committed.** `PinnedWebcamsPanel`/`api/webcam` removed full-stack (backend RPCs/proto/generated code/seeder/routing, all three map renderers, config, locales, tests) — a deliberate, operator-confirmed reversal of an older "do not delete" correction that had protected a different (already-settled) removal. Verified clean: `tsc` zero errors, touched-file lint clean, full test suite at its documented pre-existing noise floor. Committed S61 as `8eaf658` on `main` (11 ahead of `origin/main`, not pushed — operator's call).
- **As of:** 2026-09-05 (session 59) — **Workstream 6 (admin panel) shipped.** `settings.html` gains a cloud-admin gate (connect org → sign in with GitHub → `app_metadata.wm_admin` check) ahead of its existing category-editing UI, wired to write straight into the connected org's `pipeline_config` (RLS-enforced, no new SQL). Zero new hosting: rides the existing Vercel `dist/` build — see P5's correction below for why the original GCP-colocated design was never buildable as written. Only Workstream 7 (worker: absorb the direct fetches, incl. P14 Phase 2's AIS-ingest extraction) remains on the recommended order; Workstreams R and 1–6 are all shipped.
- **Prior work state:** `main` @ `ea1f964` at S59 start (9 ahead of `origin/main`, not pushed — operator's call, unchanged this session). S58 shipped Workstream 5 (multi-org deploy pipeline: org config schema, `nitric.<org>.yaml` generator, `pipeline_config` hydration loop, `deploy-org.yml`) + P14 Phase 1 (service consolidation — 3 queue workers merged, `ais-relay.cjs` the sole remaining pinned instance). `v2.13.0` still not tagged, on hold (P12).
- **S56 review verdict: architecture holds.** Corrections folded into R, 1, 2, 4, 5, 7 and P6. **OQ-P6 and OQ-P7 both RESOLVED S57** — see P14 and the resolved-questions section; no open sub-questions remain.
- **OQ-P1–6 resolved** (OQ-P1 re-opened S56 as OQ-P6, re-closed S57): Cloud Run · Supabase-CLI-scripted provisioning · `app_metadata.wm_admin` · no `settings.html` in the operator bundle · no-LLM-key hard-disables chat · **one shared AIS ingest across all orgs, everything else scheduled at `min-instances: 0`, zero pinned instances per org (P14)**.
- **Recommended order (S56):** ~~R → 1 → 4 → 2 → (7-seeder) → 3 → 5 → 6 → rest of 7 (incl. P14 Phase 2)~~ — **ALL DONE (S67).** Every workstream complete. ~~+ the `CHANGELOG.md [2.13.0]` rewrite~~ done S68 (`1095f08`). Only `v2.13.0` tagging (P12) remains — the release is now coherent; tag on the operator's timing.

---

## The shape

```
Repo devs (us) — own the GCP org, the Supabase org, the Upstash account
 └── GitHub Actions: deploy workflow, workflow_dispatch(org)
      ├── org "nike"    → isolated: nike Supabase project + nike Upstash DB + nike GCP deploy
      │     ├── worker         — pipeline: fetch external APIs + LLM + compute → nike Upstash
      │     └── admin panel    — settings.html; a Nike admin logs in, edits Nike's data-source keys
      ├── org "adidas"  → same, adidas's isolated projects
      └── org "walmart" → …
Each org's operators:
   curl|sh install (ORG-NEUTRAL binary) → supply that org's Supabase URL + publishable key
     → GitHub login (once) → local-config edge fn returns that org's Upstash READ-ONLY token
     → local backend mirrors that org's Upstash → SQLite → serves the dashboard in VS Code
     → one per-operator LLM key, set in a dashboard modal
```

**Upstash is the single source of truth per org.** The local backend does no
data-source fetching and holds no data-source keys — it is a read replica.

---

## Decisions (locked) — continues D1–D16 in `LOCAL_APP_INITIATIVE.md`

| # | Decision | Rationale | Date |
|---|---|---|---|
| **P1** | **Cloud ownership = Model A.** Repo devs own the GCP org, the Supabase org, the Upstash account. Each tenant org is a set of **isolated projects** (own Supabase project, own Upstash DB, own GCP project/service) we provision. Tenants are logical; we carry the cost and the operations. | We control the whole stack; onboarding a new org is provisioning, not a credentials-delegation dance. | S55 |
| **P2** | **Local backend = pure read-only Upstash mirror.** Zero data-source keys, zero direct external fetch for pipeline data. One GitHub login for identity; everything else is brokered. | The "every operator fills in keys" journey was the core mistake. | S55 |
| **P3** | **Two-tier keys.** (a) **Org-admin tier** — the ~26 data-source keys (ACLED, FRED, Finnhub, AISStream, FIRMS, Brave/Exa/SerpAPI, …). Set once by an org admin in the cloud admin panel, stored in that org's Supabase, read only by that org's **worker**. (b) **Per-operator tier** — the LLM key (`OPENROUTER_API_KEY` / `GROQ_API_KEY` / `OLLAMA_*`) only, set in a dashboard settings modal, powers on-demand chat/summaries that can't be pre-seeded. | Operators go from ~27 keys to 1. The scary "Backend control panel" disappears. | S55 |
| **P4** | **Config broker.** A per-org `local-config` Supabase Edge Function (`verify_jwt: true`) returns that org's Upstash **read-only** URL+token + `APP_DOMAIN` to authenticated org members. The local backend caches it in `~/.worldmonitor/config.db` and **re-fetches hourly** (so removing someone from the org propagates within the hour). **One shared read-only token per org**, not per-user. | Upstash REST has no SSO / JWT federation and no API to mint scoped tokens. Per-user Upstash ACL users are possible (paid tier) but buy only revocation granularity on read-only access to non-sensitive shared data — not worth the lifecycle. | S55 |
| **P5** | **Admin panel rides the existing Vercel `dist/` build, not the GCP worker deploy** (corrected S59 — literal "colocated with the worker" was never built: `gcp/api/main.ts` has zero static-file-serving capability and the root `.dockerignore` excludes `dist/` from Docker build contexts, so that route needed new Docker/build infra with real unknowns). `settings.html` already builds into this repo's live Vercel `dist/` today (`vite.config.ts`'s rollup input); Vercel's filesystem-priority-over-rewrites behavior (the `rewrites` array, not the legacy `routes` format) serves it as-is, unprotected by `vercel.json`'s catch-all or `middleware.ts`'s matcher. Nothing per-org is baked into this one shared build, so the admin resolves *which* org's Supabase project they're managing at runtime, in the browser: they type their org's Supabase URL + Publishable Key once (the same two values as `org.env`, P11), stored in `localStorage`, gated to that org's admin GitHub logins (native OAuth, `app_metadata.wm_admin`). It writes the 26 keys to that org's Supabase (`pipeline_config` table, RLS = admins). NOT bundled with the operator local backend; NOT its own downloadable artifact; NOT per-org infrastructure — one shared build serves every org. | Zero new hosting/Docker/build-pipeline work — a frontend feature riding a build that's already deployed, plus the RLS enforcement Workstream 1 already shipped. | S55, corrected S59 |
| **P6** | **Mirror = denylist, not the `SYNC_PREFIXES` allowlist — with THREE states, not two** (corrected S56): `deny` / `mirror` / `mirror-filtered`. Deny = the shape patterns (`*:token`, `*:secret`, `*:oauth:*`, `ratelimit:*`, `lock:*`, `idempotency:*`, `session:*`, `*:cursor`) **plus the whole "DELIBERATELY EXCLUDED, verified by reading the keys" block already documented at the foot of `SYNC_PREFIXES`** — see Workstream 4 for the enumerated list, which the S55 shape patterns did **not** cover. `brief:` is **mirror-filtered**, NOT denied. | Kills "panel X broke because nobody added the prefix" without copying org secrets, live worker queues, or other operators' personal briefs onto laptops (the session-39 `brief:` leak class). **S56 correction:** a blanket `brief:*` deny is a functional regression — `local-sync.mjs`'s `keepKey()` deliberately mirrors the operator's *own* `brief:<uid>:*` (+ shared `brief:llm:*`), and `api/latest-brief.js` reads that key through the mirror. Deny it wholesale and Latest Brief is permanently empty locally. | S55, corrected S56 |
| **P7** | **Cameras removed entirely** — `PinnedWebcamsPanel`, `api/webcam`, `list-webcams`, webcam sync keys. Not wanted. | Operator's call. | S55 |
| **P8** | **Live streams → buffered upstream, republished to Upstash.** Telegram / AIS / gpsjam: a rolling window (last N messages / last known positions) is written to Upstash; `sync-listener` pushes it to local. ~30–60s staleness accepted. Metadata (channel list, AIS regions) mirrors like any other key. **S57: *where* the buffering runs is settled by P14** — AIS by the one shared ingest service, Telegram + gpsjam by scheduled `--once` jobs. The OQ-P1 scale-to-zero conflict is resolved: nothing in the per-org deploy holds a persistent socket. | "Upstash is the single source of truth" — consistency over sub-minute latency. | S55, resolved S57 |
| **P9** | ~~**`github-identity-bridge` = vendored copy per repo.**~~ **SUPERSEDED 2026-09-07 (post-S68) — the bridge is being EXTRACTED to a new sibling repo `../org-provisioning`, owned by neither app.** The corrected model: an org = one Supabase project + *whichever* of `platform` / `worldmonitor` it wants, independently — so anything both need (the bridge above all) can't live in either. `platform` already deleted its copy; `worldmonitor` is to drop `supabase/functions/github-identity-bridge/` + `supabase/migrations/20260904130000_github_identity_bridge.sql` + the bridge steps in `deploy-org.yml`, and provisioning runs `org-provisioning/deploy.sh <project-ref>` (idempotent: apply SQL → set the 5 bridge secrets → `functions deploy --no-verify-jwt` → `register-provider.ts`) once per project **before any app**. The one real divergence (worldmonitor's copy schema-scoped the RPC to `worldmonitor`) becomes `BRIDGE_DB_SCHEMA` (default `public`). ~~**Sequenced — do NOT drop anything yet:** `org-provisioning` is a local `git init`, no remote/commit/tag; nothing is safe to drop from a live DB until it's published, `deploy.sh` has run green on `mosiq`+`biovita`, and worldmonitor's bridge has redeployed from it.~~ **SUPERSEDED AGAIN 2026-09-09: the operator dropped the mosiq→biovita cutover entirely — see the Status bullet above.** `org-provisioning` DID publish (tag `v0.1.0`) and its repo now centralizes per-org provisioning generally, but the cloud cutover sequence this row describes is not happening; mosiq/biovita are dormant. See `ORG_PROVISIONING_BRIDGE_HANDOFF.md` (repo root) + `../platform/CROSS_REPO_SUPABASE.md` for history. ~~Original: copy `index.ts`… + a migration; revisit only if the bridge changes >~quarterly.~~ | The bridge is generic, env-parameterized, done ("live and verified", one bug fixed), and frozen. A shared repo + versioning + a Supabase-function consumption mechanism for a ~300-line stable file is speculative infra. Self-contained source keeps the deploy workflow a plain `supabase functions deploy` with no cross-repo checkout / submodule / PAT. It is inherently **per-tenant-project** anyway (issuer URL, per-project service-role key for identity pre-linking, registered in each project's auth config) — a single shared deployment is not an option. | S55 |
| **P10** | **Deploy = GitHub Actions `workflow_dispatch(org)` + per-org GH Environments.** One Environment per tenant holding our GCP creds scoped to that project, Pulumi token, that org's Supabase service key + ref, that org's Upstash write URL+token, domain. Non-secret per-org bits (region, variant, domain) in `deploy/orgs/<org>.yml`. | Environments give per-tenant secret isolation + required-reviewer gating for free. | S55 |
| **P11** | **`org.env` shrinks to two public values** — the org's `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY`. That's the irreducible bootstrap: a fresh operator backend must know *which* org's Supabase to authenticate against before it can call `local-config`. No Upstash creds, no data-source keys in it anymore. | Everything else is brokered post-login. | S55 |
| **P13** | **Revocation = ban or delete the operator's Supabase user.** The `local-config` broker verifies via service role, on every call, that the caller still exists and is not banned; the local backend drops its cached credential on a 401/403. **Decided during Workstream 1's implementation, reviewed and accepted S57.** | P4 promises that removing someone "propagates within the hour", but nothing in the design actually changed when access was withdrawn: `worldmonitor-org-gate` is a **before-user-created** hook, so it runs once at signup and dropping someone from the GitHub org never touches their Supabase user. A broker checking only "is this JWT valid?" would revoke nobody and the hourly re-fetch would be decorative. Alternatives rejected: re-checking live GitHub membership needs a stored GitHub token or a per-org PAT we don't have; an `org_members` table contradicts OQ-P3's explicit no-extra-tables stance for the admin flag. Membership itself needs no check — each org has its own project, so holding a live user in it *is* membership. **Review note (S57):** revocation is per-org-project — an operator moved between orgs must be banned in the OLD project explicitly, not just added to the new one, or their local mirror keeps refreshing against the org they left until the next hourly broker check. State this in the admin runbook. | S56, reviewed S57 |
| **P12** | **`v2.13.0` stays untagged, on hold.** The install mechanics (bundled Node, `curl\|sh`, service, CI) are done and tested, but the config UX the bundle currently ships (`settings.html` Backend section, `org.env` with Upstash creds, `/api/local-config`) is being replaced. Tag only after Workstreams 1–4 + R land. **S67: gate met — every workstream (R, 1–7) landed. S68: `CHANGELOG.md [2.13.0]` rewritten to the shipped model (`1095f08`) — the last non-tag blocker cleared. Tagging is now purely the operator's timing call.** | Don't ship a dead-on-arrival config flow. Supersedes D12's "all four phases cohere" gate. | S55 |
| **P14** | **No pinned instances in a per-org deploy. Resolves OQ-P6.** (a) **AIS WebSocket ingest** (`wss://stream.aisstream.io`, the ONE genuinely persistent connection in the stack) runs as **one shared service across all orgs** — public vessel data, identical for every tenant — fanning parsed output into each org's Upstash via that org's write token. New standalone deploy target (own GCP service, own GH Environment, own `AISSTREAM_API_KEY`). **[AMENDED by P17, S65: writes to a shared "AIS results" Upstash that each org's `sync-listener` pulls from — NOT the per-tenant `{org → upstash write url+token}` registry this row originally proposed.]** (b) **Everything else that was "long-running"** becomes scheduled at `min-instances: 0`, per org: `digest-notifications` → Cloud Scheduler job; `publish-bootstrap-tiers` → two Cloud Scheduler jobs (2m/10m); `process-simulation-tasks` + `process-deep-forecast-tasks` + `scenario-worker` → **one merged `queue-worker.mjs`**, scheduled `--once` (both flows are already async pending→poll, so queue latency ~1–2m is fine); `ais-relay.cjs`'s **28 `startBootSeedLoop` seed/warm-ping loops** → entries in `gcp/scheduler/main.ts`'s `CADENCES` map (many already there or shadowed as "ais-relay backup"); **Telegram MTProto poller** → scheduled `--once` + a Redis lock (concurrency 1, or `AUTH_KEY_DUPLICATED`). (c) **Phasing:** Phase 1 (ships with W5) does digest/bootstrap/queue-worker; `ais-relay.cjs` runs unchanged as a single pinned `min-instances:1` **per org** as a stopgap. Phase 2 (overlaps W7) decomposes `ais-relay.cjs` — 28 loops → `CADENCES`, extract the ~150-line WS core → the shared service, extract Telegram → scheduled. End state: **0 pinned per org.** | The "6 long-running services" were an artifact of Railway's "a container is a container" model — under inspection they are 1 WebSocket + ~30 timer loops + 3 async queue drains. Cloud Run + Cloud Scheduler (OQ-P1) is built to separate those. Sharing the AIS ingest is the one place cross-tenant coupling enters, and it is acceptable *because* the data is public and identical — the per-org-isolation argument that holds for tenant data is materially weaker here. | S57 |
| **P16** | **[AMENDED by P20, S67 — `seedTransitSummaries` DID split out; only `seedChokepointTransits` stays relay-local.]** ~~Transit + TransitSummary stay in `ais-relay.cjs` permanently — P14 Phase 2 loop extraction is COMPLETE at 25 of 27.~~ These two `startBootSeedLoop` loops (`seedChokepointTransits` every 10min → `supply_chain:chokepoint_transits:v1`; `seedTransitSummaries` every 10min → `supply_chain:transit-summaries:v1`) are the only ones NOT extracted to a standalone `scripts/seed-*.mjs`~~, and by decision never will be~~. **P20 correction:** the "never will be" held only while the relay was per-org. Once it went shared (P14a/P17), `seedTransitSummaries`'s per-org inputs (portwatch, corridor-risk) were no longer in the store it reads, so it moved to the per-org `scripts/seed-transit-summaries.mjs` (reading the bridged AIS counts). `seedChokepointTransits` — whose only input IS the in-process Map — stays, and is now the sole `startBootSeedLoop` in the file. Both read `chokepointCrossings`, an in-process `Map` filled only by the live AIS message handler as vessels cross chokepoint geofences on the `wss://stream.aisstream.io` stream. Rejected alternative (Option B): have the relay periodically flush the Map to a Redis key that two new standalone crons read — declined because it adds a bespoke in-process-buffer→Redis pattern that exists nowhere else in the pipeline, spreads transit logic across 3 sites (flush writer + intermediate key + consumer) for byte-identical output, and introduces a silent-staleness failure mode, all to satisfy a file-naming convention. Documented at three sites so a future dev doesn't read it as an unfinished TODO: the block comment on `seedChokepointTransits` in `ais-relay.cjs`, the `SEEDERS` comment in `tests/relay-boot-seed-freshness-guard.test.mjs`, and this row. | A consumer of an in-process producer belongs next to that producer. `ais-relay.cjs` IS the shared AIS-ingest service (P14a) — always pinned by design — so two 10-min timers riding it do not reopen what P14 closed (no pinned *per-org* instances). The other 25 loops were fetch-and-compute jobs whose only input was an external URL; a `--once` cron reproduces those exactly and reproduces these two as all-zero garbage. "One clean rule + one self-explaining exception" is more maintainable than "one absolute rule bought with indirection that buys no correctness." | S64 |
| **P15** | **Every WorldMonitor object in a tenant's Supabase project lives in a dedicated `worldmonitor` schema, never `public`.** Corrects W1/W2, which had put `pipeline_config` + `wm_is_admin()` + `link_bridge_identity_if_needed()` in `public` with no explicit schema decision ever recorded. Applies to every future table/function/trigger this repo adds to a tenant project. **Schema exposure IS scriptable, folded into the migration itself** — `alter role authenticator set pgrst.db_schemas = 'public, worldmonitor'; notify pgrst, 'reload schema';`, confirmed live against a real hosted Supabase project (S57): before it, a REST call against the new schema 404s `PGRST106 "Invalid schema"`; the schema-cache reload notify is separately required or a freshly-migrated table 404s `PGRST205` even once the schema itself is exposed. No dashboard/Management-API step needed, contrary to what W1/W2's provisioning notes originally assumed. | (1) Matches the convention the pre-pivot single-tenant fork already uses (see the `supabase-worldmonitor-schema-access` memory note) — one convention, not two. (2) Keeps `public` free for a tenant project to someday host a sibling product's schema (e.g. `platform`) without collision, if a project is ever shared rather than fully dedicated. (3) A schema outside `public` gets NONE of Supabase's default grants — forces every grant to be explicit rather than incidental, the same lesson that memory note already learned the hard way once. | S57 |
| **P17** | **AIS ingest — amends P14(a): shared service → a shared "AIS results" Upstash, NOT a per-tenant write-token registry.** The one shared AIS-ingest deploy holds only its OWN Upstash credentials and writes the parsed vessel/chokepoint keys into one shared namespace. Each org's per-org deploy already runs a `sync-listener` (P8) — it pulls the AIS-namespace keys from the shared results store alongside its own tenant keys. No deploy anywhere holds more than one tenant's worth of write credentials. Costs one extra hop + the ~30–60s staleness P8 already accepts for live streams. `sync-domains.mjs` / the operator mirror will need an AIS-results source (a read-only pull target distinct from the tenant's own Upstash). | P14(a)'s original "registry of `{org → upstash write url+token}`" put every tenant's write credential in one process — the single largest deviation from P10's per-GH-Environment secret isolation, accepted only because AIS data is public. Option C removes that deviation entirely for a modest latency cost the streaming path was already designed to tolerate. The public-data argument that made the registry "acceptable" instead makes a shared *results* store outright clean. | S65 |
| **P18** | **Telegram MTProto poller — confirms P14(b): per-org scheduled `--once` job, each org's own creds.** Each tenant's GH Environment carries its own Telegram `API_ID` / `API_HASH` + MTProto session string; the poller runs as a Cloud Scheduler `--once` job with a concurrency-1 Redis lock (the `AUTH_KEY_DUPLICATED` guard). No shared Telegram-credential service. New-org runbook gains a "register a Telegram app + capture a session string" step. | Keeps the WS-core extraction unblocked without opening a second cross-org-secret hole next to the one P17 just closed. Telegram is not public data — a shared poster is strictly worse here than for AIS. Per-org `--once` + lock is the pattern P14(b) already sketched; this just says "yes, per-org, don't share." | S65 |
| **P20** | **TransitSummary splits out of `ais-relay.cjs` to a per-org cron — amends P16 for the summary half.** `seedChokepointTransits` (pure-AIS crossing counts, reads the in-process `chokepointCrossings` Map) stays relay-local and is the ONLY `startBootSeedLoop` left in the file — it belongs next to its in-process producer, and `ais-relay.cjs` IS the shared AIS-ingest service (P14a), so a 10-min timer on it reopens nothing. But `seedTransitSummaries` merges those counts with `supply_chain:portwatch:v1` + `supply_chain:corridorrisk:v1`, both written by **per-org** seeders into the **org's** Upstash. P16 kept it relay-local on the assumption of a per-org relay; once the relay went shared (P14a/P17) that store no longer has the merge's per-org inputs. New per-org `scripts/seed-transit-summaries.mjs` (`every 10min`, hand-rolled — 1 compact key + 13 history keys + a `pwCovered` seed-meta, skips the publish when portwatch is absent) reads the bridged `supply_chain:chokepoint_transits:v1` (from `sync-ais-results.mjs`, P17) + the org's own portwatch + corridor-risk. `CHOKEPOINT_THREAT_LEVELS` / `RELAY_NAME_TO_ID` / `detectTrafficAnomalyRelay` / `PORTWATCH_REDIS_KEY` / `CORRIDOR_RISK_REDIS_KEY` / `latestCorridorRiskData` all left `ais-relay.cjs` with it. | The clean rule flipped when the relay went shared: a merge belongs where the **majority** of its inputs live. Two of three are per-org; only the AIS slice is shared, and that slice is bridged. P16's "consumer next to in-process producer" argument still holds for `seedChokepointTransits` — which is exactly why that one stays. | S67 |
| **P19** | **`cloudFallback` stays OFF for operator backends — formalized (decision CF-A). The static `cloudPreferredPrefixes` list is retired.** The operator backend is a pure Upstash→SQLite mirror read-replica; a mirror miss is "not synced yet", now with the per-panel Refresh-from-cloud button (S65) as the escape hatch. `LOCAL_API_CLOUD_FALLBACK=true` still works as an unsupported opt-in (per-route fallback on `!response.ok` + adaptive `cloudPreferred` learning), but is neither default nor blessed. `vscode-extension/sidecar/local-api-server.mjs`'s `cloudPreferredPrefixes` / `cloudPreferredExact` arrays + the prefix/exact checks in `isCloudPreferred()` deleted (`isCloudPreferred` now only reports adaptively-learned routes). | S65's 3-pass verification proved the list was inert in the default config and redundant in the opt-in one — every one of its 6 domains already serves from the mirror via Workstream 4 + the S57–S64 seeders. Keeping a dead always-proxy list around invites someone to "fix" it back on. The Refresh button is a better "not synced yet" answer than a silent cloud proxy that re-couples every request to origin uptime. | S65 |

---

## Component map

| Component | Runs where | Holds | Talks to |
|---|---|---|---|
| **Operator local backend** (`curl\|sh` bundle — `LOCAL_APP_INITIATIVE.md`) | each operator's machine (launchd / Scheduled Task) | Supabase session · brokered Upstash RO token (cached, hourly) · the operator's own LLM key | that org's Supabase (login + `local-config`) · that org's Upstash (RO, sync) · OpenRouter/Groq (LLM only, on-demand, operator's key) |
| **`local-config` edge fn** | each org's Supabase project | — (reads function secrets) | verifies caller's session; returns `{ upstashUrl, upstashReadonlyToken, appDomain }` |
| **`github-identity-bridge` edge fn** (vendored, P9) | each org's Supabase project | per-project OIDC signing keys | GitHub API · that project's GoTrue |
| **`pipeline_config` table** | each org's Supabase project | the 26 data-source keys (RLS: org admins write, worker reads via service role) | — |
| **Admin panel** (`settings.html`, P5) | the existing shared Vercel `dist/` deploy (org-agnostic — one build serves every org) | the admin's chosen org connection (Supabase URL + key, in `localStorage`) | that org's Supabase (`pipeline_config` R/W, admin-gated) |
| **Worker** (pipeline) | each org's GCP deploy | that org's 26 data-source keys · that org's Upstash **write** token | external APIs · LLM · that org's Upstash (write) |
| **Upstash DB** | Upstash cloud, one per org | the org's computed dashboard state — **single source of truth** | — |

---

## Workstreams

### Workstream R — revert the per-operator control panel (Phase 2)

> **S56 correction — the revert boundary is 3 commits, not 4.** `f1a90be` is the
> commit that *created* `beginGithubLogin()`: its diff moves the PKCE flow OUT of
> `worldmonitor-local.mjs`'s `cmdLogin` and INTO `vscode-extension/sidecar/local-login.mjs`.
> Reverting it deletes that file and re-inlines ~60 lines back into the CLI — so
> "revert `f1a90be`, keep `beginGithubLogin()`" cannot both happen. It doesn't need
> to: `local-login.mjs` imports only `node:http` + `session-file.mjs`, zero coupling
> to the control plane, and Workstream 1 step 4 actively wants it.

- [x] **DONE S56 (`d39344f`).** Revert / neutralize **`ed3c281`, `e30f1cd`, `6ba93d2`** only (keep `ad77eb8`'s doc structure). Specifically: remove `handleLocalControlPlane()` (`/api/local-config`, `/api/local-login|logout|restart`), `buildLocalControlPanelShim()`, `buildFirstRunRedirectShim()`, the `settings-main.ts` **Backend** section + its `window.__WM_LOCAL_CONTROL_PANEL` gate.
- [x] **DONE S56.** **Leave `f1a90be` entirely in place** — including its one-line `SIDECAR_FILES` addition in `build-release-bundle.mjs`, which must keep staging `local-login.mjs`. Operators still sign in; just not through a "control panel."
- [x] **DONE S56.** **Drop `settings.html` from the operator bundle entirely** (OQ-P4) — **as a post-copy prune**, not a build variant. S56: there is no operator build to remove it from. `vite.config.ts` (~line 1032) has ONE unconditional rollup `input: { main, settings }`, and `build-release-bundle.mjs` never names `settings` — it does `copyDir('dist')` wholesale (~line 139). Workstream 6 needs `settings.html` in the *cloud* build from that same `dist/`, so forking the Vite build for one file is the wrong trade. Delete `settings.html` + its entry chunk from the **staged** `dist/` in `build-release-bundle.mjs`. The LLM-key modal lives in `dashboard.html` (Workstream 3).
- [x] **DONE S56** — 219 tests, 218 pass; the one failure (EADDRINUSE fallback) is pre-existing, verified at HEAD. `test:sidecar` — drop the 7 Phase-2 tests (`local-api-server.test.mjs` ~2414–2588: four `/api/local-config`, one `/api/local-login`, plus the control-panel-shim and first-run-redirect tests), keep the rest green.

### Workstream 1 — config broker (`local-config` edge fn + `pipeline_config`)

- [x] **DONE S56 (`f09915f`).** `supabase/functions/local-config/index.ts` — `verify_jwt: true`; read user from JWT; confirm org membership; return `{ upstashUrl, upstashReadonlyToken, appDomain }` from function secrets.
- [x] **DONE S56.** `supabase/migrations/20260904120000_pipeline_config.sql` — `pipeline_config(key text primary key, value text, updated_at timestamptz)`; RLS: `select/insert/update` when `(auth.jwt() -> 'app_metadata' ->> 'wm_admin')::boolean` (OQ-P3); service-role bypass for the worker.
- [x] **DONE S56.** Local backend: `config.db` becomes a **cache** of the broker response, hourly refetch (repurposes Phase 1's `config-store.mjs` / `loadConfigIntoEnv()`); on `SIGNED_OUT` or a 401 from the broker, drop the cache.
- [x] **DONE S56.** `worldmonitor-local.mjs login` → after session, immediately call `local-config` and seed the cache.

> **S56 review — `config-store.mjs` repurposes cleanly; no Phase-2 entanglement.**
> It is Phase-1 code, imports nothing from the control plane, and
> `worldmonitor-local.mjs` already imports it independently. `loadConfigIntoEnv()`
> (~line 96) is the right seam. Two required changes, both easy to miss:

- [x] **DONE S56.** **Add a TTL notion.** The `config` table is `{key, value, updated_at}` with no concept of "brokered, expires hourly." Simplest is a reserved `_broker_fetched_at` row rather than a schema change.
- [x] **DONE S56.** **Invert precedence for brokered keys.** `loadConfigIntoEnv()` line ~100 is `if (env[key]) continue` — *`.env` always wins*. An operator upgrading from a v2.12/2.13 install still has `UPSTASH_REDIS_REST_READONLY_TOKEN` in their `.env`, which would **shadow the broker's token forever and silently defeat revocation** (the whole point of P4's hourly refetch). Brokered keys need an explicit override, plus an upgrade step that strips them from `.env`.

### Workstream 2 — vendor `github-identity-bridge` (P9)

> **UNWOUND 2026-09-07 (post-S68).** P9 is superseded — the bridge is not a
> vendored per-repo copy any more, it's a dedicated `../org-provisioning` repo
> owned by neither app (see the P9 row + `ORG_PROVISIONING_BRIDGE_HANDOFF.md`).
> This session **removed** `supabase/functions/github-identity-bridge/` + the
> `20260904130000_github_identity_bridge.sql` migration + the three bridge
> steps in `deploy-org.yml` (Deploy / Set 5 secrets / Register OIDC provider),
> repointed `deploy/orgs/README.md` + `CHANGELOG.md` at `org-provisioning`, and
> added runbook step 1a. Client side (`auth-provider.ts` etc.) untouched — it
> only uses the issuer URL and the `BRIDGE_CLIENT_ID` / `BRIDGE_CLIENT_SECRET`,
> which don't change. **`org-provisioning` is now PUBLISHED** —
> `github.com/powerpro-led/org-provisioning` (private), default branch `main`
> (root `0f3301b`), pinned annotated tag **`v0.1.0`**. Function moved to
> `supabase/functions/github-identity-bridge/` + a minimal `supabase/config.toml`
> (supabase CLI only resolves functions at `<workdir>/supabase/functions/`);
> `deploy.sh` passes `--workdir "$SCRIPT_DIR"`, invocation is `./deploy.sh <ref>`
> from repo root. `deploy-org.yml` **TODO now wired** (`d038ecc`→next commit): a
> `Check out org-provisioning` step (`@v0.1.0`, needs a repo/org secret
> `ORG_PROVISIONING_TOKEN`) + a `Provision github-identity-bridge` step running
> `./deploy.sh` with `SUPABASE_ACCESS_TOKEN` / `SUPABASE_DB_URL` (NEW — direct
> non-pooled) / `SUPABASE_SERVICE_ROLE_KEY` (`=SUPABASE_SECRET_KEY`) + the 5
> bridge secrets. ~~**Live DB drops STILL sequenced** (P9 row): nothing dropped
> until the operator runs `deploy.sh` green on mosiq then biovita + worldmonitor's
> bridge redeploys from `v0.1.0`.~~ **2026-09-09: moot — the operator dropped the
> cutover entirely (see the Status bullet + P9 row).** The S57 checklist below is
> kept for history.

- [x] **DONE S57.** Vendored from platform @ `bafbfb15916c1db973f96a60564f99196c4e4428`:
  - `supabase/functions/github-identity-bridge/{index.ts, register-provider.ts, deno.json}` — `index.ts` + `register-provider.ts` carry a vendor header; bodies verified **byte-for-byte** against upstream (only deviation: `index.ts`'s one comment path reference points at the migration instead of the platform schema file). `deno.json` = `{"imports":{}}` (identical to `local-config`'s).
  - `supabase/migrations/20260904130000_github_identity_bridge.sql` — upstream keeps `fn_link_bridge_identity_if_needed.sql` as a **declarative-schema** file; WorldMonitor has no declarative setup, so it is vendored directly as a plain migration (function body byte-for-byte; `CREATE OR REPLACE` + REVOKE/GRANT are idempotent).
  - `.npmrc` from the upstream function dir is **not** copied — it is an empty comment-only placeholder for private registries the bridge doesn't use.
- [x] **DONE S57.** `supabase/functions/github-identity-bridge/PROVISIONING.md` — the per-org runbook for Workstream 5 to script: the 5 function secrets (`OIDC_SIGNING_PRIVATE_KEY_JWK` + `OIDC_SIGNING_KID` via a `jose` keygen snippet; `TICKET_SIGNING_SECRET` / `BRIDGE_CLIENT_ID` / `BRIDGE_CLIENT_SECRET` via `openssl rand`), then `supabase db push` → `supabase secrets set` → `supabase functions deploy --no-verify-jwt` → `deno run register-provider.ts`, plus the post-deploy Redirect-URL allow-list step (still manual — needs Workstream 3's login wiring to pin the URL) and a discovery/JWKS smoke check.
- [ ] **Not gated here:** the function has no local typecheck/lint in this repo (`tsconfig` covers only `src/`; `lint` script doesn't include `supabase/`; no `deno`) — same "unrun until Workstream 5" caveat as `local-config`. First real execution is a W5 gate.

### Workstream 3 — per-operator LLM key modal (in `dashboard.html`, OQ-P4)

> **S57 — the `runtime-config` / `settingsManager` path is Tauri-desktop only.**
> `setSecretValue()` no-ops outside `isDesktopRuntime()` (it invokes Tauri
> keychain commands), so the VS Code operator backend needs its own write path.
> W1 already did half of it: `config-store.mjs`'s `CONFIG_KEYS` carried
> `OPENROUTER_API_KEY`, `loadConfigIntoEnv()` hydrates every row into
> `process.env` at startup, and `llm.ts`'s `getProviderCredentials()` reads
> `process.env` and returns `null` (→ provider skipped) when a key is absent —
> so the OQ-P5 hard-disable is already the server-side default.

- [x] **DONE S57 — backend (Part A).** `config-store.mjs`: new
  `OPERATOR_LLM_CONFIG_KEYS` group (`OPENROUTER_API_KEY`, `GROQ_API_KEY`,
  `OLLAMA_API_URL`, `OLLAMA_MODEL`), all folded into `CONFIG_KEYS`
  (`GROQ_API_KEY` also into `SECRET_CONFIG_KEYS`; `OLLAMA_*` are not secrets).
  New sidecar route **`GET/PUT /api/local-llm-config`** (transport-authed like
  the sibling `/api/local-*` routes): GET returns per-key `{set}` (secrets
  masked) / `{set, value}` (Ollama) + `anyProviderConfigured`; PUT **persists
  to `config.db` via `setConfig`** (unlike `/api/local-env-update`, which is
  `process.env`-only and lost on the launchd/scheduled-service restarts the
  operator backend runs under) AND mirrors into `process.env` immediately +
  busts the handler module cache (no restart — none are
  `RESTART_REQUIRED_CONFIG_KEYS`). `anyProviderConfigured` mirrors
  `getProviderCredentials()`: any of OpenRouter key / Groq key / Ollama URL.
  The CLI (`worldmonitor-local config set …`) covers these for free via
  `CONFIG_KEYS`. Tests: 5 new in `local-api-server.test.mjs` (empty store,
  persist+mask+live-env, clear-on-empty, reject-non-LLM-key, Ollama-URL-alone).
- [x] **DONE S57 — dashboard modal (Part B).** Not a separate modal — a new
  **`ai` tab inside `UnifiedSettings`** (`src/components/UnifiedSettings.ts`),
  the dashboard chrome's existing settings surface (gear icon / `view:settings`
  command → `unifiedSettings.open()`). `src/services/llm-key-settings.ts`
  (new, mirrors `renderNotificationsSettings`'s `{html, attach}` content-module
  shape): 4 fields (OpenRouter key, Groq key, Ollama URL, Ollama model), GET on
  open, dirty-tracked PUT on save. **Secrets are never round-tripped** — GET
  reports only `{set}`, so a field left untouched submits nothing; an explicit
  per-secret **Clear** button is the only way to unset one (a keystroke arms
  "set to new value", never "clear on empty blur" — a stray click can't drop a
  live key). Tab gated on `isVsCodeEmbedRuntime()`, added to
  `UnifiedSettingsTabId` (`settings-types.ts`) — NOT the broader
  `isSidecarBackedRuntime()`, since Tauri already has its own AI settings via
  `settings-main.ts`. A successful save dispatches `wm:llm-config-changed` so
  other UI can react without a reload.
- [x] **DONE S57 — hard-disable, made visible (Part C).** The *server* side of
  OQ-P5 was already correct (found, not built): `getProviderCredentials()`
  returns `null` per provider when unset, which the chat SSE path turns into a
  clean `emit({error:'llm_unavailable'})` (`server/_shared/llm.ts`) and
  summarize falls through to the browser-T5 fallback
  (`summarize-gate.ts`'s header). What was missing was **visibility**:
  `LlmStatusIndicator` (`/api/llm-health` poller, red/green dot) existed but
  `setupLlmStatusIndicator()` gated it to `isDesktopRuntime()` only — a
  pre-Workstream-3 relic that silently excluded the ONE runtime (the embed)
  that most needs the signal. Widened to mount in the embed too; the tooltip
  now distinguishes **"no provider configured"** (needs a key) from **"LLM
  offline"** (configured but unreachable) — different remediation, previously
  conflated. In the embed the indicator is also now **clickable → opens the
  new `ai` settings tab directly**; Tauri keeps its prior non-interactive
  behavior. Re-polls immediately on `wm:llm-config-changed` instead of sitting
  on a stale red dot for up to 60s after a save. A comprehensive sweep to
  hide/disable every individual chat/summarize button across the app was
  **not** attempted — there is no existing app-wide "AI available" gate to
  hook (confirmed by search), and building one is out of scope for this pass;
  the indicator + settings tab are the discoverable, honest surface for now.
- [x] **DONE S57 — tests.** `tests/llm-key-settings.test.mjs` (19 cases,
  source-grep style — matches this repo's own convention for inline-HTML
  settings content with no jsdom/vitest wiring into `node:test`): field
  contract, secret-never-echoed, Clear-only-clears, partial-PUT-on-save,
  cleanup-removes-every-listener, tab gating, indicator wiring. `tsc --noEmit`
  0 · `lint-boundaries` clean · `biome` clean on all touched files.
- [ ] Everything else in `settings-main.ts` is admin-panel-only (Workstream 6).

### Workstream 4 — denylist mirror

- [x] **DONE S57.** `SYNC_PREFIXES` removed from `scripts/shared/sync-domains.mjs`; replaced by a **three-state** `classifyKey(key) → 'deny' | 'mirror' | 'mirror-filtered'` (P6). `isMirroredKey()` kept as a thin `classifyKey(key) === 'mirror'` wrapper so every push-path consumer's contract is byte-for-byte unchanged.
- [x] **DONE S57.** `local-sync.mjs` full-rescan now does ONE `SCAN MATCH *` over the whole keyspace, drops `classifyKey === 'deny'`, then runs the existing `keepKey()` per-key (which is the `mirror-filtered` behaviour — it scopes `brief:` to this operator). Read+write batched (`SYNC_WRITE_BATCH = 1000`) so the full-keyspace scan doesn't hold one multi-second SQLite write txn. `sync-listener.mjs` fast-path unchanged — its `isMirroredKey()` gate already refuses `deny` + `mirror-filtered`.
- [x] **DONE S57.** Regression tests rewritten (`tests/sync-domains.test.mjs`): a brand-new prefix → `mirror` with no code change; `brief:<other-uid>` → `mirror-filtered` (never pushed); `*:token` / `*:oauth:*` / `forecast:simulation-task*` → `deny`; `brief:llm:*` still `mirror`. `tests/seed-utils-notify-mirrored-writes.test.mjs` fixture swapped (an unknown prefix is now mirrored-by-default — the "not mirrored" case must use a genuinely denied key).
- [x] **DONE S57 — denylist contents.** P6's shape patterns + the documented "DELIBERATELY EXCLUDED" block + **two prefixes the P6 table missed, found by auditing the live key surface:** `sync:` (`sync:changelog` is a real stream key SCAN returns) and `rl:` (the actual `@upstash/ratelimit` prefix — P6 guessed `ratelimit:`/`rate:`, kept both). `forecast:simulation-task` carried across verbatim from the old `MIRROR_EXCLUDED_PREFIXES`.
- [x] **DONE S57 — verification.** `sync-domains` + `sync-listener` + `seed-utils-notify` suites deterministic-green (62/62). `test:sidecar` at its exact pre-existing baseline (237/238 — the EADDRINUSE test). `tsc` / `typecheck:api` / `biome` clean. `test:data` fail-count is within its own run-to-run noise band (88↔94, 36 cancelled under `--test-concurrency=16`); no sync/mirror test among the failures, and the one name that diffed (`readBootstrapTierObject`, unrelated R2 domain) passes in isolation.

> **S56 — the S55 shape patterns are materially incomplete.** `sync-domains.mjs`
> ends its allowlist with a block headed *"DELIBERATELY EXCLUDED, verified by
> reading the keys."* Inverting to a denylist makes that block load-bearing, and
> P6's shape patterns do not cover it. The deny list must be the shapes **plus**:

| Deny | Why | Covered by an S55 shape pattern? |
|---|---|---|
| `story:` | ~18.4k news-dedup tracking keys, no article content | ✗ — **largest single bloat item** |
| `wm:` | notification dedup, events queue, locks | ✗ (`lock:*` does not match `wm:`) |
| `cache:` | upstream fetch scratch (abuseipdb, cyber first-seen) | ✗ |
| `digest:` | notification accumulator + last-run marker | ✗ |
| `baseline:` | internal statistical accumulator state | ✗ |
| `seed-meta:`, `seed-routes:`, `seed-activated:` | sync-job bookkeeping | ✗ |
| `health:`, `rate:`, `llm:`, `relay:`, `cf:`, `shared:`, `ci-sebuf:`, `*smoke-test:` | infrastructure and probes | partial (`ratelimit:*` ≠ `rate:`) |
| `forecast:simulation-task*` | **live worker task ZSET** the simulation worker ZRANGEs | ✗ — see below |
| `preview:<sha>:*` | preview-deploy-prefixed keys (`redis.ts` ~line 487) | ✗ (likely moot with per-org DBs — confirm) |
| `acled:oauth:token` | credential | ✓ (`*:oauth:*`) |

> **`forecast:simulation-task*` is the dangerous one.** It is a *running queue*
> living under a legitimately-mirrored prefix, and shape-based patterns will not
> catch it — `forecast:` reads as data. It currently survives only because it sits
> in a separate `MIRROR_EXCLUDED_PREFIXES` list, added after prefix reasoning
> failed on it once already (2026-08-23). Carry that list across verbatim.

### Workstream 5 — multi-org deploy pipeline

- [x] **DONE S58.** `deploy/orgs/<org>.yml` — non-secret per-org config (domain, GCP region, variant, Supabase project ref). Schema + `deploy/orgs/README.md` (field-by-field consumer table + the "new org" runbook). `deploy/orgs/mosiq.yml` is the worked example, using the one real live tenant's real Supabase ref — its `gcp.projectId`/`domain` are placeholders (no GCP project or GH Environment exists for it yet).
- [x] **DONE S58.** **Generate `nitric.<org>.yaml` from `deploy/orgs/<org>.yml` at deploy time** (S56 gap). `scripts/generate-nitric-org-stack.mjs --org=<org>` templates `gcp-project-id`/`region` from the org config, plus P14 Phase 1's one pinned override (`ais-relay: min-instances: 1`) — everything else inherits `config.default`'s `min-instances: 0`. Pure config generation, no live infra; unit tested (`tests/generate-nitric-org-stack.test.mjs`, 5 cases, runs for real against the `mosiq` fixture).
- [x] **DONE S58.** **OQ-P7 → hydration implemented.** `server/_shared/pipeline-config-hydration.ts`: mirrors `config-store.mjs`'s `loadConfigIntoEnv()`, reusing the already-`worldmonitor`-schema-scoped `getSupabaseAdmin()` (P15) rather than a new Supabase-client bootstrap. Every `pipeline_config` row is brokered by definition (always overwrites `process.env` — no `.env`-wins branch exists worker-side under P2). Awaited once at startup (blocks route/schedule registration so a cold start never serves before its first hydration) then re-runs every 5 minutes, wired into both `gcp/api/main.ts` and `gcp/scheduler/main.ts` (whose `spawn()`-launched child seeders inherit the hydrated env for free — no explicit `env` option was ever passed to `spawn()`). 7 tests (`server/__tests__/pipeline-config-hydration.test.ts`), including the core OQ-P7 contract: pipeline_config always overwrites a stale `.env`-sourced value, never the reverse.
- [x] **DONE S58 (doc only — inherently manual).** GH Actions Environment per org — the exact secret/var list is now the authoritative header comment in `.github/workflows/deploy-org.yml` (also summarized in `deploy/orgs/README.md`). Creating the Environment itself is a one-time manual step per org (no API access this repo can script safely for a GH Environment + its secrets from outside a workflow run).
- [x] **DONE S58 — with one correction.** `worldmonitor/supabase/` Supabase-CLI setup (OQ-P2): migrations + both functions already existed (W1/W2); **`supabase/config.toml` turned out to be unnecessary** — every CLI command in `deploy-org.yml` takes an explicit `--project-ref`/uses `supabase link` first, so there's nothing a config.toml would add that isn't already covered, and skipping it avoids a stray file with no secrets but also no clear ownership story.
- [x] **DONE S58.** `.github/workflows/deploy-org.yml` — `workflow_dispatch(org)`, `environment: ${{ inputs.org }}` for per-org secret scoping. Grows `nitric-deploy.yml`'s GCP-auth/Pulumi/Docker-cache steps rather than duplicating them. Sequence: generate stack file → `supabase link` → `db push` → deploy both functions (`local-config` default `verify_jwt`, `github-identity-bridge --no-verify-jwt`) → `secrets set` (both functions' secrets, sourced from Environment secrets, NOT regenerated per run) → `register-provider.ts` (via `denoland/setup-deno`) → GCP auth → assemble this deploy's own infra `.env` (explicit named list — Supabase/Upstash/session-secret credentials this worker itself needs, deliberately NOT the 26 data-source keys, which now live only in `pipeline_config`) → `nitric up --stack-name=<org>`. The org-gate auth hook config step and the Redirect-URL allow-list step are left manual, exactly as `PROVISIONING.md` already flagged (the latter needs Workstream 3's real redirect URL to pin against). Confirmed `PRODUCTION_ENV_FILE` has no other consumer in `nitric-deploy.yml` before this workflow stopped using that pattern.
- [x] **DONE S58.** Idempotent by construction (every step is individually idempotent, confirmed in `PROVISIONING.md` + this workstream's own migrations). "New org" runbook written into `deploy/orgs/README.md` (7 steps: provision the 3 cloud resources by hand → create the GH Environment → add the org config → run the workflow → set the first admin's `app_metadata.wm_admin` → allow-list the redirect URL → the AIS-ingest registry step, currently N/A — see below).
- [x] **DONE S58.** **P14 Phase 1 — no pinned instances per org.** `scripts/queue-worker.mjs` (new) merges the 3 forecast/scenario queue consumers into one scheduled `--once` tick — imports `runSimulationWorker`/`runDeepForecastWorker` directly from `seed-forecasts.mjs` (bypassing the `process-simulation-tasks.mjs`/`process-deep-forecast-tasks.mjs` wrapper scripts, which execute at import time and `process.exit(1)` on error — confirmed unsafe to import into a merged process) and `scenario-worker.mjs`'s `runWorker` (**which had zero `{ once }` support until this session** — added by extracting its loop body into `runOneIteration()`, every `continue` becoming a `return`, so `runWorker({ once: true })` now does exactly one dequeue attempt and returns, mirroring the other two workers' contract exactly). `Promise.allSettled` across all three (one failing must not block the others), exit 0 unless all three fail (same partial-failure tolerance as W7's `seed-news-digest.mjs`). `gcp/scheduler/main.ts` gets 4 new **hand-written** registrations (`queue-worker` every 1 min; `digest-notifications` `*/30 * * * *`; `publish-bootstrap-tiers-fast`/`-slow` at `*/2`/`*/10 * * * *`, reusing that script's already-existing one-shot `--tier=` flags) — deliberately NOT derived from `scripts/railway-services.json`'s nixpacks-driven loop, because that file is still Railway's live config source for the pre-pivot single-tenant fork and this pass leaves it completely untouched. `nitric.yaml`'s dev `services:`/`runtimes:` blocks lost the 5 now-redundant pinned entries (kept `ais-relay.cjs` as the sole P14 stopgap) — confirmed to only affect local `nitric start` dev and the not-yet-live GCP target. 11 new tests total (3 for `scenario-worker.mjs`'s `{once}` behavior mocking Upstash REST via `fetch`, 4 for `queue-worker.mjs`'s exit-code contract via an injectable worker list). **Left alone, deliberately:** 3 Dockerfiles (`Dockerfile.process-simulation-tasks`/`.process-deep-forecast-tasks`/`.scenario-worker`) are now unreferenced by `nitric.yaml` and have no `railway-services.json` entry either — safe to delete, but this session could not confirm from here whether Railway's dashboard points at them independently of the JSON registry, so they're left on disk pending operator confirmation. **Pre-existing, unrelated:** `tests/railway-services-registry-coverage.test.mts` already fails on exactly this gap (those 3 Dockerfiles vs. no registry entry) on a clean tree with none of this session's changes applied — confirmed via `git stash`, not caused here.
- [ ] **P14 Phase 2 (overlaps Workstream 7) — the shared AIS ingest as its own deploy target.** Deliberately NOT built this session: the architecture doc's own phasing puts the actual WebSocket-core extraction from `scripts/ais-relay.cjs` in Phase 2, so there is no standalone AIS-ingest artifact yet for a `deploy-ais-shared.yml`/`nitric.ais-shared.yaml` to deploy — writing that workflow now would be scaffolding with nothing real behind it. Each org's own `ais-relay.cjs` instance (P14 Phase 1's pinned stopgap) already ingests AIS data for that org independently in the meantime; nothing is operationally broken by the delay, just N redundant connections to the same public feed until Phase 2 consolidates them. `deploy/orgs/README.md`'s new-org runbook step 7 documents this explicitly rather than pointing at a workflow file that doesn't exist.

### Workstream 6 — admin panel

> **S59 correction to this checklist's own wording**: "served by the Cloud
> Run deploy" (below) and "the full 5-category form" were both wrong as
> literally written — see P5's corrected text. Served by the existing
> Vercel `dist/` build instead (zero new hosting); the admin-visible form
> is 4 categories (`economy`/`markets`/`security`/`tracking`), excluding
> `ai` — that category is per-operator tier (P3) and already Workstream 3's
> dashboard tab's job, not a `pipeline_config` key at all.

- [x] **DONE S59.** `settings.html` served by the existing shared Vercel `dist/` build, behind a GitHub-login gate that checks `app_metadata.wm_admin` (OQ-P3) — plus a prerequisite step neither this checklist nor P5 originally accounted for: the admin first types their org's Supabase URL + Publishable Key once (stored in `localStorage`), since nothing per-org is baked into this one shared build. New `src/services/admin-org-connection.ts` — connection storage, a Supabase client instance kept fully separate from `supabase-client.ts`'s dashboard singleton (own `auth.storageKey`, `'wm-admin-auth'`, so a signed-in admin session never collides with a signed-in dashboard session in the same browser), native GitHub OAuth sign-in (`signInWithOAuth({ provider: 'github' })` — deliberately NOT `github-identity-bridge`, which relays a token a VS Code session already holds rather than originating a fresh browser consent screen, per that bridge's own module doc), the `app_metadata.wm_admin` client-side gate. `settings-main.ts`'s `initSettingsWindow()` runs this gate sequence (connect → sign in → admin check) for every non-desktop load, hiding the sidebar/Save button until it resolves; the Tauri desktop path is completely untouched (`isDesktopRuntime()` skips the gate entirely).
- [x] **DONE S59.** Write route: `pipeline_config` upsert (or delete, for a cleared field) via the admin Supabase client with the caller's own session — RLS enforces admin-only, no new SQL needed (Workstream 1's 4 policies already cover it). Wired through the ONE existing choke point, `settings-manager.ts`'s `commitVerifiedSecrets()`: `isDesktopRuntime() ? setSecretValue(...) : commitToPipelineConfig(...)`.
- [x] **DONE S59 — with one correction to this line's own wording.** `settings-main.ts`: the admin view renders 4 of the 5 categories (`ai` excluded — see the correction note above), reusing the existing `MASKED_SENTINEL` masking machinery unchanged — a `pipeline_config` row's presence (never its plaintext value) is read once via `fetchPipelineConfigPresence()` and seeded into the same `runtimeConfig.secrets` state `loadDesktopSecrets()` populates for the vault (`seedSecretsFromCloudAdmin()`, `runtime-config.ts`), so the shared render pipeline treats a cloud-admin-set key identically to a desktop vault entry with zero changes to `renderSecretInput()`. This is the ONLY place it renders now (removed from the operator bundle — Workstream R). **Known nuance, not fixed this session:** `isFeatureAvailable()` already returns `true` unconditionally for `!isDesktopRuntime()` (a pre-existing assumption from when this render path had no real audience) — so a category's sidebar dot / overview progress ring reads "Ready" regardless of whether its keys are actually saved yet, even though the individual secret-row status (Missing/Staged/masked-present) is accurate. Left alone deliberately: `isFeatureAvailable()` is called from many places across the live public dashboard, not just this panel, and making it admin-panel-aware risks a much broader behavior change than this workstream's scope.

### Workstream 7 — worker: absorb the direct fetches

> **S56 — better bounded than S55 implied, and the S55 pointer was wrong.**
> `local-api-server.mjs` ~line 2718 is an **SSRF allowlist for `RELAY_URL`**, not a
> route relay list. The real "does not work locally" list is `cloudPreferredPrefixes`
> at ~line 769, whose own comment says why: *"The sidecar lacks WS_RELAY_URL and
> seeded Redis data. These routes return 200-with-empty-data locally."* Under P2
> (`cloudFallback` off) that set is exactly what breaks, so **it is this
> workstream's actual worklist**:
>
> ```
> /api/market/v1/  /api/economic/v1/  /api/infrastructure/v1/
> /api/news/v1/    /api/research/v1/  /api/military/v1/   + /api/bootstrap
> ```
>
> The direct-fetch surface itself is small and enumerable: **22 RPC handlers + 9
> shared modules make outbound `https://` calls, out of 276 handler files under
> `server/worldmonitor/`** (~8%). Also worth knowing before touching this: in
> `tauri-sidecar` mode `setCachedJson()` already does NOT write to Upstash —
> `redis.ts` ~line 212 redirects it to an in-process memory cache. The local
> backend is already a read replica *for writes*; only the compute is still local,
> so P2's delta is smaller than it reads.

- [x] **DONE S60 — Cameras removed entirely (P7).** Full-stack removal of `PinnedWebcamsPanel`/`api/webcam`, confirmed with the operator as a deliberate reversal of the session-18-19-era "do not delete `api/webcam/*`" correction (that correction protected a *different* feature, `PinnedWebcamsPanel`, from being conflated with the already-approved `LiveWebcamsPanel` removal — P7 now removes `PinnedWebcamsPanel` too, on purpose). Backend: `proto/worldmonitor/webcam/v1/*`, `server/worldmonitor/webcam/v1/*`, `api/webcam/`, the 2 `server/gateway.ts` cache-tier lines, `scripts/seed-webcams.mjs`, its `gcp/scheduler/main.ts` orphan-list entry, `sync-domains.mjs`'s now-dead deny line, `api/health.js`'s `STANDALONE_KEYS.webcams`, `WINDY_API_KEY` docs, and the CSP `frame-src` entry all deleted; `make generate` + `scripts/generate-nitric-routes.mjs` re-run to regenerate everything else byte-identical while cleanly dropping webcam. Frontend: the panel + `src/services/webcams/`, all three map renderers' (`Map.ts`/`GlobeMap.ts`/`DeckGLMap.ts`) marker/tooltip/popup layers, config across every variant, the `MapLayers.webcams` type (tsc catches any straggler), app wiring, and all 26 locale files (scripted removal, verified valid JSON) — bundled in the same pass, per operator's call: dead leftovers from the already-settled `LiveWebcamsPanel` removal (orphaned locale keys, a stale e2e spec, unused `localStorage` keys). 9 test files updated to match. Verification: `tsc --noEmit` zero errors repo-wide; touched-file `biome lint` clean; full `npm run test:data` at its documented pre-existing noise band (94 fail / 36 cancelled, none webcam-related — spot-checked via `git stash`); final repo-wide grep clean except docs/history and 3 harmless pre-existing comment mentions. **Committed S61 as `8eaf658`** (84 files, +121/-2990).
- [x] **Decompose `ais-relay.cjs` (P14 Phase 2) — DONE S67.** All 28 loops accounted for: 26 extracted to standalone crons (S61–S64), `seedChokepointTransits` stays relay-local (P16, the sole `startBootSeedLoop` left — reads the in-process AIS Map), `seedTransitSummaries` split to the per-org `scripts/seed-transit-summaries.mjs` (P20 — its portwatch/corridor-risk inputs are per-org). **Telegram (P18):** `scripts/seed-telegram.mjs` per-org `--once` (`every 5min` + concurrency-1 lock + Redis cursors + rolling window in `intelligence:telegram-feed:v1`); `list-telegram-feed.ts` + `api/telegram-feed.js` repointed to that key; the relay's `/telegram` route + `/health` sub-block + `gracefulShutdown` stanza deleted. **AIS ingest (P17):** the WS core + Oref + the ~13 public-data HTTP proxy routes stay in `ais-relay.cjs`, now deployed ONCE (shared) via `nitric.ais-shared.yaml` + `deploy/shared/` + `.github/workflows/deploy-ais-shared.yml`; `scripts/sync-ais-results.mjs` (per-org, `every 2min`) bridges `supply_chain:chokepoint_transits:v1` from the shared "AIS results" Upstash into each org's Upstash; `sync-domains.mjs` gains `isAisResultsKey()`. **Deploy:** `generate-nitric-org-stack.mjs` `PINNED_SERVICES` → `{}` — **0 pinned instances per org**; `deploy-org.yml` env += `WS_RELAY_URL` / `AIS_RESULTS_UPSTASH_*` / `TELEGRAM_*`; `deploy/orgs/README.md` step 7 (Telegram app registration) + step 8 (point the org at the shared deploy). **`tauri-sidecar` `telegram-feed`** is now a plain mirror read (the key is `classifyKey`→`mirror`); **`gpsjam`** was already fetched by `scripts/fetch-gpsjam.mjs` (a standalone cron, `every 1 day`) into `intelligence:gpsjam:v2` — never a relay concern, no change needed. All scaffold parity — `nitric up` has never run.
  - [x] **S61 — full loop audit + 8 confirmed-redundant/dead loops deleted.** Method: pull each loop's `metaKey`/canonical Redis key out of `ais-relay.cjs`, grep it against every `scripts/seed-*.mjs`/bundle file, confirm the sibling is reachable from `CADENCES`, **then check the original function for `publishNotificationEvent(...)` calls before deleting** (the UCDP/Weather near-miss below is why that last step is now mandatory, not optional).
    - **Deleted** (pure duplicates or dead code, verified no notification side-effects): Cyber (dead — never invoked; standalone `seed-cyber-threats.mjs` already owns it), TheaterPosture (`seed-military-flights.mjs` writes identical LIVE/STALE/BACKUP keys), ServiceStatuses (`seed-service-statuses.mjs` does the identical RPC warm-ping), Spending (`seed-usa-spending.mjs`, via `seed-bundle-relay-backup.mjs`), WorldBank (`seed-wb-indicators.mjs` writes all 3 identical keys, via the same bundle), ClimateNewsSeed (ais-relay's own copy already just execFile'd the same `seed-climate-news.mjs` the bundle also runs — literally two unsynchronized invocations of one script), ChokepointFlows (ditto, but with NO existing schedule at all — flipped from `ORPHANS_NOT_SCHEDULED` to a real `CADENCES` entry), TechEvents (`seed-research.mjs` writes the identical literal key `research:tech-events:v1`, hourly vs. ais-relay's 6h).
    - **S61: deleted then restored same-session** (commits `629df49`, `7febde9`): UCDP and Weather. Both seed functions *also* called `publishNotificationEvent()` (UCDP: `conflict_escalation` for high-casualty events; Weather: severe-alert push via `deriveWeatherCoalesceKey(vtec)`) — logic that exists nowhere else in the codebase. The standalone siblings (`seed-ucdp-events.mjs`, `seed-weather-alerts.mjs`) only mirrored the Redis data; neither notified.
    - **S62: notification logic ported, both deleted for good.** `scripts/seed-ucdp-events.mjs` and `scripts/seed-weather-alerts.mjs` now carry their own `publishNotificationEvent`/SETNX-dedup/`wm:events:queue` LPUSH machinery — the same inline-Upstash-helpers pattern `scripts/seed-aviation.mjs` already established (that script was itself the precedent for moving a notifying loop out of `ais-relay.cjs` safely). UCDP additionally persists its own prev-alerted-IDs to Redis (`conflict:ucdp-events:prev-alerted:v1`, 500-entry cap, 30-day TTL) since a one-shot cron script has no in-process memory across ticks the way `ais-relay.cjs`'s long-lived process did — mirrors `seed-aviation.mjs`'s own prev-alerted-state pattern. Weather's coalesce-by-VTEC-family dedup needed no such extra state (the Redis-backed SETNX dedup already inside `publishNotificationEvent` is enough), but the standalone script's `fetchAlerts()` was never actually capturing the VTEC field its own coalesce key would have needed — fixed. `ais-relay.cjs`'s writer blocks, `ucdpPrevAlertedIds`, `normalizeNotificationCountryCode`'s only caller, and `deriveWeatherCoalesceKey` (now unused anywhere in that file) are gone; the separate on-demand `/ucdp-events` relay-reader (a different feature — user-triggered lookups, not a Redis writer) is untouched, though 2 of its constants (`UCDP_TRAILING_WINDOW_MS`, `UCDP_PAGE_SIZE`) had to move out of the deleted writer block into the reader's own section since it depended on them. `cyberPrevAlertedIds` was noticed to already be orphaned (an S61 Cyber-removal leftover, unrelated to this task) — flagged, not touched.
    - **Investigated, deliberately left alone:** Market (`seedAllMarketData`) is not one loop but a 9-way bundle (stocks/commodities/sectors/gulf/etf/crypto/stablecoins/crypto-sectors/token-panels). 8 of 9 sub-seeds already have standalone/bundle coverage (`seed-market-quotes.mjs`, `seed-commodity-quotes.mjs`, `seed-crypto-sectors.mjs` independently; gulf/etf/crypto/stablecoins/token-panels via `seed-bundle-market-backup.mjs`) — but `seedSectorSummary`/`market:sectors` has **no replacement anywhere**. Deleting the loop wholesale would have silently dropped the sector-summary panel's data. Needs a new `seed-sector-summary.mjs` before Market's loop can go.
    - **Confirmed genuinely unique, no sibling exists anywhere (untouched, real extraction candidates for a future stage):** GSCPI, Classify, Oref (the 28th "loop" — a custom poll loop, not `startBootSeedLoop`-based), Satellites, PositiveEvents, CII/Chokepoints/CableHealth/TemporalAnomalies (warm-pings), CorridorRisk, USNI-fleet, ShippingStress, SocialVelocity, WsbTickers, PizzINT, Transit, TransitSummary.
    - **S61:** also updated to match: `tests/relay-boot-seed-freshness-guard.test.mjs`'s `SEEDERS` inventory (removed the 8 deleted entries, kept UCDP/Weather) and `tests/notification-relay-country-filter.test.mjs` (removed the now-stale `cyber_threat` assertion).
    - **S62:** UCDP/Weather now removed from `SEEDERS` too. 8 test files retargeted from source-grepping the deleted `ais-relay.cjs` functions to the standalone scripts: `tests/ucdp-seed-resilience.test.mjs` (rewritten around `seed-ucdp-events.mjs`'s `main()` body; dropped 3 assertions for a parallel-race-then-rank discovery algorithm — `Promise.allSettled` + `ucdpVersionNewer` — that only ever existed in the deleted `ais-relay.cjs` writer, since the standalone's sequential newest-first discovery is immune to that failure mode by construction, not by a guard worth asserting on), `tests/ucdp-retention-window.test.mjs`, `tests/documentation-alignment-guardrails.test.mjs`, `tests/notification-relay-payload-audit.test.mjs`, `tests/notification-relay-coalesce-key.test.mjs`, `tests/notification-relay-country-filter.test.mjs`, `tests/relay-boot-seed-freshness-guard.test.mjs`, `tests/layer-explanations.test.mts` (UCDP's freshness-copy cadence check now reads `scripts/seed-bundle-relay-backup.mjs`'s bundle `intervalMs` instead of a deleted `ais-relay.cjs` constant). Also fixed in passing: `seed-ucdp-events.mjs` silently dropped ais-relay's per-page failure logging — restored (`ucdp-seed-resilience.test.mjs` had been guarding it in the wrong file). Noticed but out of scope: `tests/layer-explanations.test.mts`'s `CYBER_SEED_INTERVAL_MS` assertion has been broken since S61's Cyber removal (predates this session, confirmed via `git stash`) — **fixed in the S62-later warm-ping wave, see below.**
    - **S62, later — loop extraction started (the 17 "genuinely unique" loops).** Method confirmed first: cross-check each against `gcp/scheduler/main.ts` `CADENCES` (exhaustive, built from `railway-services.json`) — none are quietly covered, so each is a **new** `scripts/seed-*.mjs` + `railway-services.json` entry + `CADENCES` entry, then delete the loop + boot call site + sweep for dangling refs (the UCDP `UCDP_PAGE_SIZE`/`UCDP_TRAILING_WINDOW_MS` near-miss is why the sweep is mandatory).
      - **GSCPI** (`5d03aed`) → `scripts/seed-gscpi.mjs`, 1:1. CSV fetch/parse ported verbatim incl. the direct→proxy fallback (`_proxy-utils.cjs`); dropped the in-process 20-min retry timer (next daily cron tick is the retry). Live-verified against the real newyorkfed.org CSV (348 obs). `CADENCES` `1 days`, matching the deleted `GSCPI_SEED_INTERVAL_MS` and `api/health.js`'s existing `SEED_META.gscpi.maxStaleMin`.
      - **CII / Chokepoints / CableHealth / TemporalAnomalies RPC warm-pings** (`fb64f12`) → ONE consolidated `scripts/seed-rpc-warmpings.mjs` (deviation from 1:1). All four were GET-only, wrote no Redis (the RPC handlers own their `seed-meta` keys), and differed only in URL + interval (8/30/30/15 min). Runs all four every 8 min — over-pinging the slower ones is harmless (handler-side caching absorbs it). `warmPingHeaders()`/`RELAY_API_KEY` deleted from `ais-relay.cjs` (no other caller). `map-layer-definitions.ts` waterways/tradeRoutes freshness copy updated "every 30 minutes" → "every 8 minutes".
      - **Test debt swept in these two waves:** `layer-explanations.test.mts` (new `schedulerCadenceMinutes()` helper — reads `CADENCES` rate/simple-cron; re-pointed CII + chokepoint + the long-broken CYBER assertions), `relay-warm-ping-auth.test.mts` (stale 5-path endpoint list → 6; ais-relay source-grep → the standalone crons), `seed-health-risk-scores.test.mjs` + `seed-warm-ping-origin.test.mjs` (retargeted to `seed-rpc-warmpings.mjs`; added it to the exit(0)-invariant enforcement list). Net: 3–4 pre-existing red tests fixed per wave, 0 new regressions (diffed clean-tree-vs-branch each time; the lone "new" name `renewable-energy-last-known-good` fails identically on the clean tree — a timing flake).
      - **Remaining 10** (Market excluded — still needs `seed-sector-summary.mjs` first): Satellites, PositiveEvents, Classify, USNI-fleet, SocialVelocity, WsbTickers, PizzINT, Transit, TransitSummary (no notifications, straight ports); **CorridorRisk + ShippingStress call `publishNotificationEvent`** → same migration treatment as UCDP/Weather. GDELT- (PositiveEvents) and Reddit-sourced (SocialVelocity/WsbTickers) ones carry rate-limit/ban risk — port their existing throttle logic faithfully.
      - **S63 — 3 straight ports done, 3 of the S62 "straight port" list re-tiered after reading the loop bodies.**
        - **Satellites** (`cbb78e2`) → `scripts/seed-satellites.mjs`. `SAT_NAME_FILTERS` / `satClassify` / TLE parse verbatim; `https.request` → `fetch` + post-hoc 2MB guard; dropped the 20-min in-loop retry (next 2h cron tick is the retry — `seed-gscpi.mjs` precedent). `CADENCES` `every 2 hours`, `maxStaleMin: 240`. Live: 191 catalog → 98 recon TLEs.
        - **USNI-fleet** (`35b068d`) → `scripts/seed-usni-fleet.mjs`. HTML parse delegated verbatim to `scripts/lib/usni-fleet-parser.cjs` (unchanged). `ytFetchViaProxy` → `_proxy-utils.cjs` `resolveProxyConfig`/`proxyFetch`. 7-day `usni-fleet:sebuf:stale:v1` = a `runSeed` `extraKey`. `every 6 hours`, `maxStaleMin: 720`. Live: 42 vessels / 3 CSGs / 10 regions.
        - **PizzINT** (`a4db79d`) → `scripts/seed-pizzint.mjs`. Location mapping / DEFCON thresholds / GDELT tension-pair shaping verbatim; GDELT batch stays non-fatal (pizzint.watch `/api/gdelt/batch` currently 400s — same as the relay); `zeroIsValid: true` keeps the unconditional publish. `every 10 minutes`, `maxStaleMin: 30`. Live: 6 locations, `success:true`.
        - **Classify — NOT a straight port.** Calls `publishNotificationEvent({eventType:'rss_alert'})` (→ notification tier) *and* depends on ~400 lines of relay-local scoring machinery (`RELAY_SOURCE_TIERS`, `relayComputeImportanceScore`, the `RELAY_DIPLOMACY_*` / tier-4 / recency gates, `classifyFetchLlm` + `CLASSIFY_LLM_PROVIDERS`, `classifyCacheKey`, `matchCountryNamesInText`, `upstashMGet`) + a 5-variant staggered ~12-min loop with a per-title Redis LLM cache. Largest single loop in the file. Needs its own session.
        - **Transit** (`seedChokepointTransits`) — **not extractable as a cron.** Reads `chokepointCrossings`, an in-process `Map` populated by the relay's live AIS WebSocket vessel stream (geofence-crossing detection, `ais-relay.cjs:~4960`). A fetch-based standalone would publish all-zero counts.
        - **TransitSummary** — merges `PORTWATCH_REDIS_KEY` (portable) + `latestCorridorRiskData` (in-process, Redis-hydratable) + `chokepointCrossings` (the AIS blocker). Same problem for the transit-count half.
        - **Decision needed (operator):** Classify → own session. Transit + TransitSummary → leave in `ais-relay.cjs` (they consume the relay's core AIS function), or design a split where the relay periodically flushes `chokepointCrossings` to a Redis key a standalone reads.
      - **S63-later — the 3 rate-limited ports done.**
        - **PositiveEvents** (`fe5de39`) → `scripts/seed-positive-events.mjs`, `runSeed`. Feature parse (tone gate, (article×location) dedup, count≥3 hotspot, keyword classifier) verbatim. The hand-rolled `setTimeout(5_500)` between 6 theme queries → `_gdelt-fetch.mjs`'s `fetchGdeltJson` (claims the `GDELT_RATE_WINDOW_MS = 5_500` cross-process gate per attempt + adds the direct→proxy fallback the raw `https.get` never had — same path `seed-conflict-intel`/`seed-unrest-events` already use). `zeroIsValid: true`. `positive_events:geo-bootstrap:v1` is a `runSeed` extraKey. **TTL 2700→4500 (75min):** the relay wrote `positive-events:geo:v1` at 45min == *below* `api/health.js`'s 60-min gate — invisible in the relay (not a `seed-*.mjs` file), would fail `seed-ttl-outlives-staleness-fleet.test.mjs` as a new seeder. `every 15 minutes`.
        - **WsbTickers** (`aa8ef32`) → `scripts/seed-wsb-tickers.mjs`, `runSeed`. `DOLLAR_TICKER_REGEX`/`BARE_TICKER_REGEX`/`TICKER_BLACKLIST`/`extractTickers` + mention/score aggregation verbatim. Reads `market:stocks-bootstrap:v1` via `readCanonicalValue`. 500ms inter-subreddit spacing kept. `CACHE_TTL` 43200 (720min) already > the 540-min gate. `every 3h`.
        - **SocialVelocity** (`aa8ef32`) → `scripts/seed-social-velocity.mjs`, **HAND-ROLLED** (`export async function main()` + `process.argv[1]` guard, model = `seed-gas-storage-countries.mjs`). NOT `runSeed`: it keeps the bespoke `status:'ok'/'error'` + `errorReason` seed-meta shape that `api/health.js` classifyKey reads to raise SEED_ERROR *immediately* on a Reddit fetch failure — `runSeed` has no hook for that, and there's a dedicated test (`social-velocity-seed-health.test.mjs`) + `writeFailureMeta`/`writeHealthyMeta` pair built for it on purpose. Canonical write via `atomicPublish` (envelope + mirror notify). Velocity math (`log1p(score) × upvote_ratio × exp(-ageSec/6h) × 100`) verbatim. `every 3h`.
        - **New `scripts/_reddit-hot.cjs`** — the whole "Reddit data fetch (shared across social-velocity + WSB tickers)" block ported verbatim (ScrapeCreators cursor-pagination bounded by `SC_MAX_PAGES` → OAuth `client_credentials` with single-flight + 5-min cooldown → public; `_redditEpochSeconds`/`_decodeRedditEntities`/`_normalizeVendorPost`). `require`d by both seed scripts; `ais-relay.cjs`'s copy deleted (its only 2 callers were these loops).
        - **Tests:** `relay-boot-seed-freshness-guard` SEEDERS −3. `positive-events-seed-failure.test.mjs` retargeted to `seed-positive-events.mjs` (same invariant: a failed GDELT call is never a successful-empty; total failure throws → `runSeed` extends last-good). `reddit-oauth-fetch.test.mjs` + `social-velocity-seed-health.test.mjs` retargeted from `ais-relay.cjs` to `_reddit-hot.cjs` + the 2 seed scripts + `gcp/scheduler/main.ts` (path precedence, token flow, vendor normalization, the `status:'ok'/'error'` ordering, cadence == 3h, TTL 720min > gate 540min).
        - **Verification:** `tsc --noEmit` clean; `test:data` run **twice** on the branch and **twice** on a `git checkout 9bf6bf3` in-place baseline — union(branch failures) ⊆ union(baseline failures), **0 new**. The suite flakes ±1 name/run (`readBootstrapTierObject` — a `cancelledByParent` "event loop already resolved" timing flake whose test file *and* `api/_bootstrap-r2.js` are byte-identical across the diff — and `renewable energy last-known-good recovery` flip in/out on **both** trees).
      - **S63-later-2 — CorridorRisk + ShippingStress notification migration done** (`886d295`). Both loops published notifications, so the same UCDP/Weather treatment: the `>=50`-score `corridor_risk` and `>=75`-score `shipping_stress` publishers moved to the new standalone crons with the Redis data. No standalone sibling existed for either → each a new `scripts/seed-*.mjs` (both on the `runSeed` contract + an `afterPublish` hook carrying the publisher, inline-Upstash `publishNotificationEvent` copied from `seed-weather-alerts.mjs`) + `railway-services.json` + `CADENCES` entry.
        - **`seed-corridor-risk.mjs`** — fetch / Cloudflare-challenge guard / `CORRIDOR_RISK_NAME_MAP` / risk-level derivation / output-field shaping verbatim. `every 1h`; TTL 14400 already clears the 120-min health gate (no ratchet bump — unlike USNI/PizzINT/PositiveEvents earlier this pass). `dispatchCorridorRiskNotifications`: one notification per corridor with `riskScore >= 50` (`high`, or `critical` at `>= 70`; `dedupTtl 3600`).
        - **`seed-shipping-stress.mjs`** — carrier basket, `40 - avgChange*3` score, level thresholds verbatim. Yahoo fetch now via the shared `scripts/_yahoo-fetch.mjs` + `parseYahooChart` (same path `seed-market-quotes.mjs` uses), NOT ais-relay's `fetchYahooChartDirect` (which stays for the Market loop). The relay's 20-min `setTimeout` retry dropped → `runSeed` RETRY-on-empty + next 15-min tick. `every 15min`; TTL 3600 already clears the 45-min gate. `dispatchShippingStressNotifications`: one notification when `stressScore >= 75` (`critical` at `>= 90`; `dedupTtl 7200`).
        - **KEPT in `ais-relay.cjs`:** `CORRIDOR_RISK_REDIS_KEY` + `latestCorridorRiskData`. The relay-local TransitSummary loop (consumes the live AIS `chokepointCrossings` Map — can't be extracted) Redis-hydrates `supply_chain:corridorrisk:v1` into `latestCorridorRiskData` on its own 10-min tick when its copy is null, so corridor data still reaches transit summaries — just on the next TransitSummary tick, not instantly (the relay used to kick `seedTransitSummaries()` straight from `seedCorridorRisk`). `-206` lines from `ais-relay.cjs`; every deleted identifier grepped repo-wide (only test files referenced them).
        - **Tests:** `relay-boot-seed-freshness-guard` SEEDERS −2; `notification-relay-payload-audit` PRODUCER_FILES +2 (both `@notification-source: domain`); `corridorrisk-upstream.test.mjs` + `transit-summaries.test.mjs` retargeted the `seedCorridorRisk` fetch/shape/name-map assertions from `ais-relay.cjs` to `scripts/seed-corridor-risk.mjs` (the `seedTransitSummaries` assertions stay on `ais-relay.cjs` — that loop is relay-local).
        - **Verification:** `tsc --noEmit` + `typecheck:api` + `biome` + `lint-boundaries` clean; full `test:data` diffed name-for-name against a clean `ee013e3` in-place checkout — **identical 25-name failure set, 0 new regressions** (`railway-registry` / `nixpacks-import-graph` / `no-escape-import` are the documented pre-existing set — all about `process-*-tasks`/`scenario-worker` Dockerfiles, unrelated; `readBootstrapTierObject` is the known flake).
      - **S63-later-3 — Market loop deleted** (`e91333c` sector-summary extract + `a8f6c64` the delete). `seedAllMarketData` was a 9-way bundle; 8 sub-seeds were already covered (`seed-market-quotes.mjs` / `seed-commodity-quotes.mjs` / `seed-crypto-sectors.mjs` + `seed-bundle-market-backup.mjs`). The last, `seedSectorSummary` (`market:sectors:v2` + valuations), had no standalone → new `scripts/seed-sector-summary.mjs` (`runSeed`, `every 15min`; SECTOR_SYMBOLS / Finnhub-then-Yahoo-chart cascade / the `/v10/finance/quoteSummary` crumb-session valuation fetch / `parseSectorValuation` verbatim; Yahoo *chart* fetches via shared `_yahoo-fetch.mjs`; the quoteSummary curl-proxy fallback + 5-failure cooldown dropped — best-effort valuations, 15-min cron). Then the whole loop deleted: **−1064 lines** — 9 `seedXxx` fns, `seedAllMarketData`/`Once`, `startMarketDataSeedLoop`, the equity trading-day gate, the Yahoo crumb/chart/curl-proxy stack, `fetchYahooChartDirect`, `fetchFinnhubQuoteDirect`, `parseSectorValuation`, `CHINA_COUNTRY_STOCK_SYMBOL`, and the `./shared/market-*.cjs` + `./_country-stock-index.mjs` require()s. **NOT a straight port — the loop published `market_alert` notifications** from `seedMarketQuotes`/`seedCommodityQuotes`/`seedCryptoQuotes` (equity/commodity ≥5% crit ≥10%, crypto ≥10% crit ≥20%; top 3 by |move|; hidden asset-family coalesce key). Caught on the regression diff by `notification-relay-coalesce-key.test.mjs` (the exact "grep for `publishNotificationEvent` before deleting" trap — the S61 breadcrumb "Market: investigated, left alone" never audited it). Ported: new `scripts/shared/market-alert-coalesce-key.cjs` (`marketAlertCoalesceKey`, verbatim) + new `scripts/shared/market-alert-notify.mjs` (**one** `dispatchMarketAlerts()` publisher — market_alert had 3 call sites so it lives once, not inlined per script — inline LPUSH+SETNX like `seed-weather-alerts.mjs`), called from each of the 3 market seeds' `afterPublish` with its own thresholds; all 3 tagged `@notification-source: domain`. Fallout: `Dockerfile.relay` dropped 4 now-dead COPYs; `.env.example` dropped `DISABLE_RELAY_MARKET_SEED` + `MARKET_YAHOO_REFRESH_INTERVAL_MS` (`planYahooRefresh` was relay-loop-only — the standalone's 30-min cron cadence is its own Yahoo-refresh bound). 9 test files retargeted; `relay-boot-seed-freshness-guard` SEEDERS −1. `tsc` + `typecheck:api` + `biome` + `lint-boundaries` clean; `test:data` run **twice** on-branch + diffed name-for-name against a clean `ee013e3` `git stash -u` baseline — **0 new regressions** (25-name set, ±1 = the `readBootstrapTierObject` flake).
      - **Remaining after S63 (3):** Classify (notification tier + ~400-line dependency port, own session); Transit + TransitSummary (blocked on the in-process-AIS decision above — operator's call). **24 of 27 loops out.**
- [x] **DONE S57 — `list-feed-digest` seeder.** `scripts/seed-news-digest.mjs`: a nixpacks-root-scripts warm-ping job (NOT a re-implementation — `scripts/` can't import `server/` and `buildDigest` isn't exported). It HTTP-pings `/api/news/v1/list-feed-digest?variant=&lang=` per `(variant, lang)` pair (env `NEWS_DIGEST_SEED_VARIANTS`=`full`, `NEWS_DIGEST_SEED_LANGS`=`en,zh`; `en` first so `zh` reuses the warmed `rss:feed:v8:*` per-feed caches) — the RPC runs `buildDigest`, `setCachedJson`s `news:digest:v1:<variant>:<lang>` (which also fires the mirror notify) and stamps a fresh `generatedAt` (what the panels read for freshness, so no `seed-meta:` write here). Registered in `railway-services.json` + `gcp/scheduler/main.ts` `CADENCES` at **`*/10 * * * *`** — a hard constraint, not an inference: must stay under `list-feed-digest.ts`'s 900s `news:digest:v1` TTL or the cold-hole bug returns. `classifyKey('news:digest:v1:*')` was already `'mirror'` — no W4 change. Exit-code policy: 0 on any success (partial failure self-heals next tick), 1 only if every ping fails. Unit test: `tests/seed-news-digest.test.mjs` (10 cases). **The sidecar startup warm-ping (`local-api-server.mjs` ~2546) is removed** — it was already inert whenever `WS_RELAY_URL` was unset (`/api/news/v1/` is `cloudPreferred` then), i.e. in exactly the config the pivot backend runs; the digest now arrives over the mirror.
- [x] **Work the remaining direct-fetch handlers + shared modules → DONE S65 (audit + Fix #1 + 3-pass verification).** Conclusion: the concern is effectively retired for P2's real runtime config — `cloudPreferredPrefixes` is inert with `cloudFallback` off (the default), so the 6 domains already run their local handlers against the mirror; every direct-fetch handler under them either reads a seeded+mirrored key first or returns a `cache-contract.ts` degraded marker. One real bug found + fixed (Fix #1, `cf:` mirror-deny). Residual (all optional / off-critical-path): delete the inert `cloudPreferredPrefixes` list as cleanup; a sidecar body-inspection improvement IF `cloudFallback=true` becomes a supported operator mode; proto+`make generate` markers for `imagery/search-imagery` + `military/get-wingbits-live-flight`. Original enumeration kept below for reference. By domain: aviation (3), market (4), military (2), infrastructure (3), intelligence (3), economic, displacement, maritime, sanctions, imagery, research (1 each); shared: `aviation/_shared`, `cyber/_shared`, `market/_shared`, `trade/_shared`, `unrest/_shared`, `news/_feeds`, `economic/_bis-shared`, `military/_wingbits-aircraft-details`, `supply-chain/_bilateral-hs4-lazy`.
  - [x] **S65 — full audit + infrastructure domain (fix #1).** Per-handler table in `scratchpad/ws7-direct-fetch-audit.md` (paste into this file if the scratchpad is lost). Mental model: for each RPC under a `cloudPreferredPrefixes` entry, the fix is **(a)** a `seed-*.mjs` keeps a canonical key fresh on cloud → the denylist mirror (`sync-domains.mjs`) auto-mirrors it → the handler's existing `cachedFetchJson`/`getCachedJson` read serves it locally and never runs the outbound fetch; or **(b)** the call is an on-demand deep query (arbitrary symbol/entity/lat-lon/free-text) that can't be pre-seeded → keep the fetch, make the empty state explicit. `redis.ts` sidecar read (`readCachedJson` → `sidecarCacheGet`) hits the SQLite mirror; `cachedFetchJson` serves a hit and only runs the fetcher on a **miss** — it does NOT short-circuit the outbound call in sidecar mode, which is why the empty-blank happens today.
    - **Finding:** `cloudPreferredPrefixes` predates Workstream 4 + the S57–S64 seeder buildout. **infrastructure / research / military / news** + most of **economic / market** are already served from the mirror (seeders: `seed-rpc-warmpings` cable-health + temporal-anomalies, `seed-service-statuses`, `seed-bundle-derived-signals` outages, `seed-research`, `seed-military-flights`, `seed-news-digest`, the S63 market fleet, `seed-economy` + BIS/FRED). Path-(b) tail (~8): `market/{analyze-stock,get-insider-transactions,stock-news-search,backtest-stock}`, `news/summarize-article`, `imagery/search-imagery`, `supply-chain/_bilateral-hs4-lazy`, `military/_wingbits-aircraft-details` — user-triggered, must degrade to an explicit "requires connection" state. `infrastructure/reverse-geocode` + `intelligence/get-country-facts` — per-request but cacheable (self-warm the mirror), acceptable degraded.
    - **Fix #1 (landed):** `sync-domains.mjs` `DENY_PREFIXES` `'cf:'` → `'cf:cache:'`. The blanket `'cf:'` denied `cf:radar:ddos:v1` + `cf:radar:traffic-anomalies:v1` (the ONLY `cf:` keys anywhere — Cloudflare **Radar** display data, written by `seed-internet-outages.mjs`, sole source for `list-ddos-attacks` + `list-traffic-anomalies` which are pure Redis readers with no fetch fallback). Both infra panels were permanently blank on every operator mirror, masked only by `/api/infrastructure/v1/` being cloud-preferred. `tests/sync-domains.test.mjs` +1 regression block. `lint:boundaries` + `typecheck:api` + `biome` clean; `sync-domains` + `mcp-bootstrap-parity` + `seed-utils-notify-mirrored-writes` 56/56 via `tsx` (bare `node --test` can't load the `.ts` import in `mcp-bootstrap-parity` — use `tsx`).
    - **S65 verification pass (after Fix #1) — the on-demand tail mostly already degrades correctly.** `server/_shared/cache-contract.ts` recognises `unavailable:true` / `upstreamUnavailable:true` / `dataAvailable:false` / `degraded:true` / `available:false` / non-empty `error` as a no-store/degraded marker (gateway won't cache it; client can tell it apart from a real empty). Traced every 6-prefix handler:
      - **Seeded (a), all confirmed read-mirror-first:** `get-cable-health` / `list-service-statuses` / `list-tech-events` read their **bare** seeded key. `list-internet-outages` / `list-ddos-attacks` / `list-traffic-anomalies` are pure Redis readers — Fix #1 makes all three mirror-served. **`list-military-flights` — per-request cache key** (`military:flights:v1:<bbox>:<op>:<type>`) so the primary `cachedFetchJson` always misses the bare seeded key on the sidecar; degrades via a *secondary* `fetchStaleFallback()` reading the mirrored `military:flights:stale:v1` (whole stale set, not bbox-scoped, filtered client-side after). Works — document this caveat when dropping `/api/military/v1/`.
      - **On-demand (b) under the 6 prefixes — marker already present:** `analyze-stock` → `available:false`+`fallback:true`; `get-insider-transactions` → `unavailable:true`; `stock-news-search` → internal helper feeding `analyze-stock` (its empty is absorbed by `available:false`); `news/summarize-article` → non-empty `error`; `reverse-geocode` → non-empty `error` (no change needed). The audit's "must add explicit degraded state" was overcautious — most already carry one.
      - **`economic/list-world-bank-indicators` — frontend-dead.** `getIndicatorData` (its only wrapper) has **0 callers** in `src/`; `getCountryComparison` is "unused but kept for API compat"; the WB panels all read the seeded `economic:worldbank-{techreadiness,progress,renewable}:v1` bootstrap keys (`getTechReadinessRankings` comment: "never call the WB API from the frontend"). Its silent `{data:[]}` blanks no panel → drops off the `/api/economic/v1/` blocker list.
      - **`market` direct-fetch handlers — all marked.** `analyze-stock` → `available:false`+`fallback:true`; `get-insider-transactions` → `unavailable:true`; `get-country-stock-index` → reads seeded `market:stock-index:v1:CN` first, every failure path returns `available:false`; `stock-news-search` internal; `_shared` coinpaprika → per-id `allSettledWithConcurrency`, logs+skips failures (supplementary price source, no blank).
      - **Off-critical-path silent-empty (deferred, need proto + `make generate`):** `imagery/search-imagery` (`/api/imagery/v1/`), `military/get-wingbits-live-flight` (per-aircraft live lookup — "no flight" is honest).
      - **Net:** no critical-path code bug beyond Fix #1.
    - **S65 pass 3 — `cloudPreferredPrefixes` is INERT in the P2 default config.** Traced the call graph: the 6-prefix array is populated (`WS_RELAY_URL` unset on the operator backend), but `isCloudPreferred()` is consulted at **exactly one** point in the request flow (`local-api-server.mjs:~2184`), behind `if (context.cloudFallback && …)`, and **`cloudFallback` defaults off** (`local-api-server.test.mjs:240`; P2 keeps it off — "probably still off"). So in the shipping P2 config **the 6 domains already run their local handlers against the SQLite mirror** — the list is dead scaffolding there. The S56 note's *"under P2 (cloudFallback off) that set is exactly what breaks"* was backwards: cloudFallback off ⇒ the set is never consulted.
    - **Fix #2 (operator call — revised).** Removing the prefixes is a **no-op for the default `cloudFallback=false` operator config**. For opt-in `cloudFallback=true` operators it swaps "always proxy these 6 to cloud" for "run local, per-route fallback on `!response.ok`" — with one caveat for *that group only*: a local `200 {available:false}` / `{data:[]}` doesn't trip the `!response.ok` check (`local-api-server.mjs:2236`), so on a cold mirror they'd see the degraded marker instead of cloud data. Closing that = a small sidecar change (buffer the local body, run `getRpcNoStoreReasonFromJson` on it — the same check `server/gateway.ts:1499` already does — then fall back on a marker). Hot-path change → its own focused session + full `test:data`, not a drive-by. **Net: the "direct-fetch handlers" concern is effectively retired for P2's real runtime config;** `cloudPreferredPrefixes` can be deleted as cleanup whenever, or left (inert). Only follow-up with teeth: the sidecar body-inspection improvement, and only if `cloudFallback=true` becomes a supported operator mode.
- [x] **`cloudFallback` — RESOLVED S65 (decision CF-A / P19): stays OFF for operator backends, static `cloudPreferredPrefixes` list retired.** Operator backend is a pure mirror read-replica; a miss is "not synced yet" + the per-panel Refresh-from-cloud button. `LOCAL_API_CLOUD_FALLBACK=true` remains an unsupported opt-in. `cloudPreferredPrefixes` / `cloudPreferredExact` deleted from `local-api-server.mjs`.

---

## Resolved sub-questions

- **OQ-P1 → RESOLVED for the request-driven half; the scale-to-zero half re-opened S56 as OQ-P6, re-closed S57.** Per-org worker on Cloud Run (scheduled pipeline runs via Cloud Scheduler → HTTP trigger). Not GKE, not an always-on VM. Verified S56: `nitric.gcp.yaml` does already target Cloud Run (`provider: nitric/gcp@1.27.6`, `config.default.cloudrun`, `min-instances: 0`) — so the scaffold and the decision agree.
- **OQ-P2 → RESOLVED: fully scripted in `deploy-org.yml`.** Review of current practice: the repo has **no Supabase-CLI migration setup**. The one migration precedent is `consumer-prices-core/` — plain numbered `migrations/NNN_name.sql` + a ~60-line forward-only runner (`src/db/migrate.ts`: `schema_migrations` tracking table, each file in a `BEGIN/COMMIT`, `pg` Pool via `DATABASE_URL`), run as `npm run migrate`. **Decision:** the deploy workflow needs the `supabase` CLI anyway for `functions deploy` + auth config, so use it for SQL too — `supabase/migrations/*.sql` (CLI convention) applied with `supabase db push`, `supabase/functions/*` with `supabase functions deploy --no-verify-jwt`, then `deno run register-provider.ts`. Per-org GH Environment holds `SUPABASE_ACCESS_TOKEN` + project ref + DB password. (The `consumer-prices-core` plain-`pg` runner is the CLI-free fallback if the CLI dependency proves painful.)
- **OQ-P3 → RESOLVED: `app_metadata`.** Admin = `app_metadata.wm_admin === true` (or `app_metadata.role === 'admin'`), set by repo devs — manual per org for now (small `admin.updateUserById` step; a management UI later if it grows). `pipeline_config` RLS checks it; the admin-panel gate checks it. No GitHub-team lookup, no `org_admins` table.
- **OQ-P4 → RESOLVED: operator bundle does NOT ship `settings.html`.** The per-operator LLM-key modal becomes a component **inside `dashboard.html`**. `settings.html` (+ the full `settings-main.ts` form) is admin-panel-only. Workstreams R + 3 updated below.
- **OQ-P5 → RESOLVED: hard-disable.** No LLM key configured → chat/summarize are disabled locally with a clean "AI features need an API key (Dashboard → Settings)" state. No cloud LLM proxy — that would re-create an org-tier key and outbound cost we're removing.
- **OQ-P6 → RESOLVED S57: option (c), zero pinned per org — see P14.** Investigation collapsed "6 long-running services" to their real shape: **1 genuinely persistent connection** (the AIS WebSocket — `ais-relay.cjs:11561`, the only `new WebSocket()` in an 11.6k-line file that also carries **28 `startBootSeedLoop` timer loops**), 2 cron-shaped loops (`digest-notifications` is *already* one-shot; `publish-bootstrap-tiers` is a 2m/10m timer), and 3 async queue drains (`run-scenario.ts` already returns `status:'pending'` + a poller — latency-tolerant by design). Decision: the AIS ingest runs **once, shared across all orgs** (public data, identical per tenant); everything else is scheduled at `min-instances: 0` per org. Phased — Phase 1 (with W5) schedules digest/bootstrap/queue-worker and keeps `ais-relay.cjs` as a single per-org pinned stopgap; Phase 2 (overlaps W7) decomposes it and moves the WS core to the shared service. P14 has the full breakdown.
- **OQ-P7 → RESOLVED S57: `pipeline_config` wins, 5-minute hydration.** P3/P5 say Supabase `pipeline_config`, edited live by an org admin; `nitric-deploy.yml` said a single deploy-time `PRODUCTION_ENV_FILE` secret — both can't be true, and `pipeline_config` has to win or the admin panel (Workstream 6) is decorative. Consequence, per `config-store.mjs`'s own header: **~600 `process.env.<KEY>` reads across the compiled `api/` route bundles**, none rewriteable to an accessor, so the worker needs a startup + periodic `pipeline_config → process.env` hydration — the exact mirror of `loadConfigIntoEnv()`, just on the worker side. **Interval: 5 minutes** — short enough that a testing admin doesn't perceive it as broken, long enough not to hammer Supabase from every worker instance, and it matches the pipeline's own fastest existing cadence (`seed-bundle-derived-signals`, `*/5 * * * *`). **User-visible contract, must ship in the Workstream 6 panel copy:** "changes apply within 5 minutes." `PRODUCTION_ENV_FILE` stops being how the 26 keys reach the worker — Workstream 5 must confirm nothing else in `nitric-deploy.yml` still depends on it before removing it.

---

## Session log

### Session 69 — 2026-09-07

**Unified-Supabase post-swap sequence (i–v), all done.** Commit `13dd788`
(`chore(platform):`, on `main`, NOT pushed). Coordinated live over
cross-session messaging with `org-provisioning-6e`, which had finished
swapping the local dev Supabase stack (worldmonitor's own containers/volume
gone; new stack is `supabase_*_org-provisioning`, `worldmonitor` schema
present but empty). Ran the 5-step sequence the S68 handoff queued:
`supabase/config.toml` created + committed; the JWKS re-pull found `.env`
already correct — the ES256 key did **not** rotate this swap, contradicting
the S68 handoff's assumption (flagged back, cause unconfirmed); the offline
broker check went green end-to-end against a freshly signed-up
`dev-operator` user (the old one's `auth.users` row didn't survive the
swap). **Mid-sequence mistake, corrected within the session:** killed a
`supabase functions serve github-identity-bridge` process believing it a
pre-swap orphan — it was actually `org-provisioning-6e`'s live bridge
server. Real finding (theirs): `supabase functions serve` from two repo
dirs against one shared stack is mutually exclusive and the process owns
the shared edge-runtime container's lifecycle, so killing either side 503s
the other. Their bridge moved to bare `deno run` on `:8000`; `:54321` is
now worldmonitor's alone. Re-verified `local-config` 200 end-to-end after
restarting it.

**Continued same session — `worldmonitor` schema populated, NOT via `migration
up`.** That command hit shared cross-repo migration-history state
(`org-provisioning`'s bootstrap row, absent locally) and both its suggested
fixes mutate a table `org-provisioning-6e` was actively relying on — checked
first rather than guessing. Established pattern: every repo on this shared
stack applies its own schema via direct `psql`, never the CLI's global
migration commands. Second catch before applying: the migration's trailing
`ALTER ROLE authenticator SET pgrst.db_schemas` is a role-level GUC that
would have silently dropped `graphql_public`/`storage` exposure for the
whole shared instance — but it's ALSO load-bearing for `deploy-org.yml`'s
real `supabase db push` to mosiq/biovita, so the fix excludes those two
lines at local-apply time only, migration file untouched. Verified
end-to-end (anon 401s correctly, an authenticated bearer gets 200 `[]`).
Flagged, not fixed: the same GUC clobber risk exists for `deploy-org.yml`
against biovita (a shared org project too) — operator's call.

**FIXED 2026-09-09 (`7170443`) — was confirmed live, not hypothetical.**
Platform's session MCP-verified biovita's `authenticator` role has NO
`pgrst.db_schemas` override today, so the very next `db push` of this
migration would have triggered the clobber for real, dropping
`graphql_public`/`storage` project-wide for platform (which also runs on
biovita) the instant it ran. Hardened the migration file itself this time
(the local-apply exclusion above still stands for the shared LOCAL stack;
this is the separate CLOUD-facing fix): hardcoded the full schema list —
`'public, graphql_public, storage, worldmonitor'` — mirroring the local
`config.toml`'s `[api].schemas` exactly (`okr` deliberately excluded,
matching platform's own cloud exposure). Safe for mosiq too (exposing
unused-but-standard schemas is a no-op there). No live database touched —
neither mosiq nor biovita has had `deploy.sh`/`db push` run yet.

**Then W5 + W6, closing out the local-validation queue entirely.** W5:
`hydratePipelineConfig()` exercised against a real inserted row — confirmed
OQ-P7 (unconditional overwrite of a stale value, unrelated keys untouched).
W6: `dev-operator` promoted to `wm_admin` via the admin API + a fresh
sign-in (claims bake into the JWT at sign-in, not live), then
`commitPipelineConfigValue()` (the real `settings.html` write path) proven
both ways — an admin's write lands and reads back, a freshly-signed-up
non-admin's identical write is rejected by Postgres RLS itself
(`new row violates row-level security policy`), not just the client-side
`isCurrentUserAdmin()` check. Every item in the local-validation queue
(Tier 1/2, W1, W3, W5, W6) is now done. See the Status bullet for full
detail. Remaining: GCP `nitric up`, W2's `custom:github-bridge` on mosiq,
and the two open operator calls (`v2.13.0` tag, Desktop launcher surface).

### Session 68 — 2026-09-07

**`CHANGELOG.md [2.13.0]` rewritten to the shipped model — the last non-tag
item on the whole initiative.** Commit `1095f08` (`docs(platform):`, on `main`,
NOT pushed). markdownlint-cli2 clean; no code touched.

The entry was written for the sessions-49–54 Model B + loopback control panel
and never revised after the S55 pivot reverted the control-panel half. It
still documented `settings.html`'s Backend section, `GET/POST/DELETE
/api/local-config`, the in-panel "Sign in with GitHub", and the first-run
redirect — none of which exist. Verified against the tree before rewriting:
no `__WM_LOCAL_CONTROL_PANEL` / `handleLocalControlPlane` refs remain; the
sidecar's `local-config` is now the *broker client* (`local-config-broker.mjs`
→ the Supabase edge fn), not a route; `settings.html` is pruned from the
staged bundle (`resolveSettingsOnlyDistAssets()` in `build-release-bundle.mjs`)
and repurposed as the cloud admin panel; `config-store.mjs`'s
`loadConfigIntoEnv()` inverts precedence for `BROKERED_CONFIG_KEYS` (cached
copy outranks `.env`) and `clearBrokeredConfig()` deletes them on 401/403;
`auth-provider.ts` derives the bridge issuer from `getSupabaseUrl()`; the
dashboard `ai` tab (`isVsCodeEmbedRuntime()` gate) + `llm-key-settings.ts` +
`admin-org-connection.ts` all present.

New entry sections: config broker · two-tier keys · cloud admin panel ·
`github-identity-bridge` vendored · denylist mirror · org-neutral bundle ·
one-command install + bundled runtime · **cloud pipeline (explicitly marked
scaffold — never run against the cloud)** · Removed (cameras P7; the loopback
control panel) · the credential-free `/api/health` security section (kept, was
already accurate). Header date `2026-09-03` → `2026-09-07`; operator resets at
tag time.

**Then a live-path bug the changelog work surfaced (`5adfe12`,
`fix(release):`).** Workstream R pruned `settings.html` from the operator
bundle but `scripts/release/setup.sh` + `setup.ps1` still built the **Desktop
launcher** against `http://127.0.0.1:46123/settings.html` — a dead URL in
every bundle a `nitric`-less release would ship. Both repointed at the
dashboard root (`http://127.0.0.1:46123/` → the sidecar serves `dashboard.html`
there), post-install banners reworded off "control panel". `INSTALL.md`
de-fossilised the same way (its whole "First run — configure & sign in"
section described the reverted control panel, Backend section, "Sign in with
GitHub" button, first-run redirect) → rewritten around `worldmonitor-local
login` seeding the `local-config` broker (`cmdLogin` →
`refreshBrokeredConfig({force:true})`, verified; `cmdStatus` has no broker
line, so the troubleshooting hint points at `config list` / the login output).
`bash -n` + markdownlint clean. **Open for the operator (flagged, not
decided):** is the browser dashboard at `:46123/` the intended launcher
surface, or should the launcher open VS Code / be dropped? — the only reason
it pointed at `settings.html` was D5 (pre-pivot), never re-decided.

**P12 status:** gate met at S67, changelog coherent + release path fixed at
S68 — `v2.13.0` tagging is now purely a timing call for the operator (no code
or doc blocker left).

**Tier-1 local validation of the P14 extraction (no code changed).** Local
Redis stack was already up (`worldmonitor-redis` + the `:8079` Upstash-REST
shim + `.env` already on local Redis). Ran 8 extracted seeders live against it:

- `seed-gscpi` / `seed-satellites` / `seed-corridor-risk` / `seed-shipping-stress`
  — all exit 0, fetched live upstream data, wrote a valid contract-mode
  `{_seed,data}` envelope, advanced seed-meta with the right `sourceVersion`,
  TTLs clear their staleness gates. **`seed-corridor-risk`'s migrated
  `publishNotificationEvent` fired** (`[Notify] Dedup hit — corridor_risk …` ×5
  — the SETNX dedup working, not an error).
- `seed-telegram --once` (no `TELEGRAM_*`) and `sync-ais-results` (no
  `AIS_RESULTS_UPSTASH_*`) — both **graceful no-op, exit 0**, neither touches an
  existing key. The P17/P18 "not configured" paths are benign; `sync-ais-results`
  only *throws* when configured-but-empty.
- `seed-transit-summaries` (P20) — both branches: with the canonical
  `supply_chain:portwatch:v1` absent it **skips the publish and preserves
  seed-meta**; after seeding `seed-portwatch.mjs` it publishes **13/13** rows +
  13 `…:history:v1:<id>` keys. Output `data.summaries` is an object keyed by
  chokepoint id — exact match for the `summaries[cp.id]` read in
  `get-chokepoint-status.ts:317`. (Note: `seed-bundle-portwatch-port-activity.mjs`
  is the *port-activity* bundle and never writes the canonical; `seed-portwatch.mjs`
  / `seed-bundle-portwatch.mjs` does — worth knowing for a cold local mirror.)
- 205 targeted unit tests green (`corridorrisk-upstream`, `transit-summaries`,
  `telegram-feed-contract`, `sync-domains`, `relay-boot-seed-freshness-guard`,
  `seed-telegram`, `sync-ais-results`, `gscpi-shape-extraction`,
  `telegram-intel-format`).
- **Not done:** a runtime A/B against `ais-relay.cjs` — those loops are deleted
  from the current file, so it needs a historical checkout. The S61–S67 parity
  tests were retargeted from `ais-relay.cjs` source-greps to the standalone
  scripts and still assert the same behaviour; that is the source-level diff.

**Tier-2 local validation — the standalone backend end to end (no code changed).**
`:46123` was occupied by a stale `wmtest`-user backend (the abandoned S48
fresh-user test, ~6 days up, old bundle) so ran `john`'s backend from the repo
tree on `:46125` (`worldmonitor-local run --port 46125`). Results:

- `/api/health` (with the loopback token — every `/api/*` needs it; "credential-free"
  in the changelog means *no Upstash creds*, not *no auth*) → **200, real verdict
  computed from the local SQLite mirror**, zero Redis creds. `UNHEALTHY` only
  because this box's mirror is cold.
- `GET /` → dashboard HTML (46 KB), `__WM_RUNTIME_CONFIG` injected (Model B). The
  S68 launcher-fix target serves.
- `/api/local-config` GET+POST (with token) → **404 `No local handler`** —
  Workstream R's route removal confirmed at runtime.
- `/api/local-llm-config` (W3 backend) → full GET→PUT→GET→Clear→GET round-trip:
  Ollama URL set flips `anyProviderConfigured` true, persists to `config.db` +
  live env, Clear on empty string unsets it; secrets never return a `value`;
  401 without token.
- `get-chokepoint-status` RPC → returns the **exact `transitSummary`**
  (`incidentCount7d:18`, `wowChangePct:2.4`, `riskLevel:critical`) that Tier-1's
  `seed-transit-summaries.mjs` wrote — seeder → local Redis → SQLite mirror → RPC
  handler chain intact end to end.
- **W3 frontend AI tab — VERIFIED (S68, `npm run build` + Playwright headless).**
  Clean `npm run build` (`APP_DOMAIN=localhost:3000`, 31 s, no errors — the
  `1b3fdbe` hreflang fix holds for a non-`worldmonitor.app` domain). W3 code is
  in the fresh bundle (`dist/assets/UnifiedSettings-*.js`: `/api/local-llm-config`
  GET+PUT, `renderLlmKeySettings`, `us-tab-ai`). Loaded `/?embed=vscode` (→
  `__wmVsCodeApi` shim → `isVsCodeEmbedRuntime()` true), opened settings: tab bar
  is `SETTINGS · PANELS · SOURCES · NOTIFICATIONS · AI`; the AI panel renders 4
  fields (OpenRouter key + Clear, Groq key + Clear, Ollama URL, Ollama model) +
  SAVE, with the "stored only on this machine" privacy copy. Screenshot clean.
- **Still not verified:** the `settings.html` bundle prune (a
  `build-release-bundle.mjs` step, not active in a repo/dev run).
- **Incidental, pre-existing (not S68 changes):** this box's `config.db` holds
  placeholder brokered values (`https://org.upstash.io`, `APP_DOMAIN=org.example`)
  from an old test; since `UPSTASH_REDIS_REST_URL` is a `BROKERED_CONFIG_KEY`,
  `config.db` overrides `.env`'s local-shim URL (P4 precedence — working as
  designed) so the backend's `sync-listener` DNS-fails against `org.upstash.io`.
  Fix: `worldmonitor-local config unset` those three, or re-login. Also: the
  `config list` CLI's "`.env` … override anything stored here" line is wrong for
  the 3 brokered keys. Also: a stale `wmtest` backend + two generations of
  orphaned `nitric` `gcp/api`+`gcp/scheduler` tsx processes are still running.

**W1 config broker (P4) — validated end to end, first against mosiq cloud then
fully offline (no code changed; config/infra only).**

- **Cloud path (mosiq, `lntyjouahofgewtkmpyi`):** the operator paired both
  project-scoped Supabase MCPs at user scope, enabled native GitHub OAuth on
  mosiq + allow-listed `http://127.0.0.1:46124/callback`, and set the
  `local-config` function secrets (`WM_UPSTASH_*` / `WM_APP_DOMAIN` pointed at
  the shared "worldmonitor" Upstash `up-dragon-42947` — reused for the test,
  NOT per-tenant-isolated). `worldmonitor-local login` (ambient
  `VITE_SUPABASE_*` override, no `.env` edit) → mosiq's first `auth.users` row
  → `refreshBrokeredConfig` fired. **Before the secrets were set it returned
  HTTP 500 `server_misconfigured`** and the client correctly kept its cached
  config + logged "retry hourly" — the P4 fail-closed contract, observed live.
- **Offline path (local Supabase, `supabase start`):** `.env` repointed at
  `http://127.0.0.1:54321` (BIOVITA values kept as a commented
  `[switched-to-local-supabase]` block — this is the "no cloud project in dev"
  setup); new gitignored `supabase/functions/.env` with `WM_*` pointed at the
  `:8079` Redis shim; `supabase functions serve` (both functions). A local
  email-signup user → `local-config` → **HTTP 200
  `{upstashUrl:"http://127.0.0.1:8079", upstashReadonlyToken:…, appDomain:"localhost:3000",
  refreshAfterSeconds:3600}`**. Then `refreshBrokeredConfig({force:true})` →
  `{status:"ok", changed:["UPSTASH_REDIS_REST_URL","UPSTASH_REDIS_REST_READONLY_TOKEN","APP_DOMAIN"]}`
  → `config.db` placeholders (`org.upstash.io`/`org.example`) **replaced with
  the working shim values** (also resolves the Tier-2 `sync-listener`
  DNS-fail incidental above). New `supabase/.gitignore` (`.branches` etc.).
- **Follow-ups this surfaced:** (1) repo `supabase/migrations/` has **2**
  migrations, mosiq cloud has **5** — the `_worldmonitor_schema` + `_final`
  corrections were hand-applied to mosiq in S57 and never committed back.
  (2) `.env`'s `SUPABASE_JWT_PUBLIC_JWK` is still BIOVITA's ES256 key; local is
  HS256 — the broker path verifies via a GoTrue network call so it was
  unaffected, but the main app's offline server-side JWT verify will 401
  against local until that's addressed (left alone deliberately — out of scope
  for the broker test). (3) mosiq still lacks the `custom:github-bridge` OIDC
  provider (the VS Code embed login path) and a `supabase/config.toml` (needed
  for local GitHub OAuth; `supabase start` ran without one).

### Session 67 — 2026-09-07

**WS-core + Telegram extraction — the P14 Phase 2 tail, and the last of
Workstream 7. Every workstream (R, 1–7) is now done.** 7 commits,
`e350c2d`→`bada2f3`. `scripts/ais-relay.cjs` 6702 → 6182 lines.

- **Commit 1 (`e350c2d`) — `scripts/seed-telegram.mjs`.** Per-org `--once`
  job (P18). Hand-rolled (not `runSeed`): the real output is a *rolling
  window* merged into `intelligence:telegram-feed:v1` + per-channel read
  cursors persisted to Redis (`intelligence:telegram-feed:cursor:v1`, 30d).
  Concurrency-1 Redis lock `intelligence:telegram-poll` (a 2nd live MTProto
  session = `AUTH_KEY_DUPLICATED`). `every 5min`, NOT the relay loop's 60s —
  each `--once` reconnects a fresh session (overhead + FLOOD_WAIT risk); 5min
  still clears `api/health.js`'s `SEED_META.telegramFeed.maxStaleMin` (10).
  Ported `loadTelegramChannels` / `normalizeTelegramMessage` / the poll body /
  `AUTH_KEY_DUPLICATED`+`FLOOD_WAIT` handling verbatim; exports the pure fns
  for unit tests. `gcp/scheduler/main.ts` CADENCES + `railway-services.json`.
  `relay still runs its own loop until commit 3`.
- **Commit 2 (`b2c25a0`) — repoint the two consumers.**
  `list-telegram-feed.ts` (→ `getCachedJson(FEED_KEY, true)`) +
  `api/telegram-feed.js` (→ `readJsonFromUpstash`) read the Redis key + do the
  relay's `GET /telegram` topic/channel/limit filtering in-handler. Miss →
  `200` `{enabled:false, error:'not synced'}` (was `503` "WS_RELAY_URL not
  configured"). `_relay.js` / `intelligence/v1/_relay.ts` kept (opensky /
  polymarket / rss / oref still use them). `telegram-feed-contract.test.mjs`
  rewritten to mock the Upstash GET wire shape — **3/8 → 12/12** (the 5
  `api/telegram-feed` cases were failing on baseline on an unrelated
  missing-CORS-origin setup, fixed by dropping the bogus `Origin` header).
- **Commit 3 (`52f518d`) — delete Telegram from `ais-relay.cjs`.** −347 lines:
  all §3 fns (incl. `withTimeout`, Telegram-only), `telegramState`, the
  `GET /telegram` route, the `telegram:` `/health` sub-object, the boot call,
  the `gracefulShutdown` Telegram-disconnect stanza (whose entire reason to
  exist was the deploy-time `AUTH_KEY_DUPLICATED` race — now the lock's job).
  Deleted-identifier grep sweep clean. `Dockerfile.relay` header updated (the
  `telegram` npm dep stays — `npm ci --prefix scripts` still pulls it — the
  relay just no longer imports it). `ais-relay-health-no-secret-recon`
  retargeted (`/health` MUST NOT carry telegram diagnostics now).
- **Commit 4 (`18388a9`) — `scripts/seed-transit-summaries.mjs` (P20).**
  `seedTransitSummaries` split to a per-org `every 10min` cron — P16 assumed a
  per-org relay; with the relay shared, its `portwatch` + `corridorrisk`
  inputs aren't in the shared store. Hand-rolled (1 compact key + 13 history
  keys via `writeExtraKey` + a `pwCovered` seed-meta; skips the publish when
  portwatch is absent). Reads the bridged `supply_chain:chokepoint_transits:v1`
  instead of the in-process Map. Exports a pure `buildSummaryRow(cpId,
  pwEntry, transitCounts, risk)` — the merge logic — for direct unit tests;
  the old sandbox-`eval`-the-extracted-body harness couldn't port (the new
  file imports `_seed-utils.mjs`). `−195` from `ais-relay.cjs`
  (`CHOKEPOINT_THREAT_LEVELS` / `RELAY_NAME_TO_ID` / `detectTrafficAnomalyRelay`
  / `PORTWATCH_REDIS_KEY` / `CORRIDOR_RISK_REDIS_KEY` / `latestCorridorRiskData`
  all left with it). `seedChokepointTransits` + its Map deps untouched — the
  sole `startBootSeedLoop` left. `transit-summaries` / `chokepoint-id-mapping`
  / `portwatch-upstream` / `relay-boot-seed-freshness-guard` (SEEDERS −1) /
  `layer-explanations` (cadence source relayConst → `schedulerCadenceMinutes`)
  retargeted.
- **Commit 5 (`312f353`) — `scripts/sync-ais-results.mjs` (P17).** Per-org
  `every 2min` bridge: reads `AIS_RESULTS_UPSTASH_*` (shared, read-only),
  copies `chokepoint_transits:v1` + its seed-meta VERBATIM (envelope not
  unwrapped) into the org's Upstash with re-applied TTLs (3600 / 604800), and
  fires `notifyChange`. Computes nothing. Exit 1 when the canonical is absent
  in the shared store (ingest down — surfaced, not masked). `sync-domains.mjs`
  gains `AIS_RESULTS_KEYS` + `isAisResultsKey()` (bridge-side, a SEPARATE
  concern from `classifyKey` mirror classification).
- **Commit 6 (`bada2f3`) — deploy scaffold.** `generate-nitric-org-stack.mjs`
  `PINNED_SERVICES` → `{}` (**0 pinned per org**; test rewritten). New
  `deploy/shared/{README.md,ais-ingest.yml}` + `nitric.ais-shared.yaml`
  (`ais-relay` `memory:1024`/`timeout:300`/`min-instances:1`/`max-instances:1`
  — the one pinned instance in the platform) + `.github/workflows/
  deploy-ais-shared.yml` (GH Environment `ais-shared`, its own creds only —
  no tenant secrets). `deploy-org.yml` env += `WS_RELAY_URL` (var) /
  `AIS_RESULTS_UPSTASH_*` (shared RO) / `TELEGRAM_*` (per-org).
  `deploy/orgs/README.md` step 7 (Telegram app registration + session
  capture) + step 8 (point the org at the shared deploy — both wiring
  paths). `nitric.yaml` / `nitric.gcp.yaml` P14 comment blocks updated. All
  scaffold parity — `nitric up` has never run.
- **Commit 7 (this doc).** Status + this log + P20 + P16 amendment +
  Workstream 7 `[x]` + Recommended-order "ALL DONE".

**Operator decisions taken this session** (via AskUserQuestion): (a) the ~13
public-data HTTP proxy routes fold into the shared service (not per-org
workers); (b) Oref rides the shared service (one residential-proxy secret,
public alert data); (c) code split + deploy scaffold in one pass; (d)
`seedTransitSummaries` splits to a per-org seeder (→ P20); (e) the bridge
copies only `chokepoint_transits:v1` + its seed-meta.

**Verification.** Every commit: `node --check` (relay) + `biome` (touched) +
`lint:boundaries` + `tsc(gcp)` / `typecheck:api` clean. Per-commit `test:data`
failing-group **name-diffs** against the prior commit's tree — **0 new** every
time (25-group noise floor; the only mover across runs is the documented
`readBootstrapTierObject` `cancelledByParent` flake, which
`bootstrap-r2-reader.test.mjs` runs `# fail 0` for in isolation). ~18 test
files retargeted. No live smoke — the shared deploy has never run; the seeders
were `node --check`'d + unit-tested only (no prod-Upstash creds this session).

**Left for a future session:** `v2.13.0` tag (P12) + the `CHANGELOG.md
[2.13.0]` rewrite — it still documents the Workstream-R-reverted control-panel
config model (settings.html Backend, `/api/local-config`, in-panel GitHub
sign-in, first-run redirect); must be rewritten to the shipped model (config
broker + per-operator LLM keys W3 + cloud admin `pipeline_config` W6) before
tagging. The gate itself (Workstreams 1–7 + R landed) is now met.

### Session 66 — 2026-09-06

**Mirror-refresh UI follow-up — DONE, both parts.** The S65 backend
(`POST /api/local-sync-refresh`) + client hint layer
(`src/services/mirror-key-hints.ts`) were done end to end; all that remained was
a panel-facing "not synced yet + Refresh" state and its per-panel adoption.

- **`Panel.showNotSynced(message?, onRetry?, autoRetrySeconds?, opts?)`**
  (`src/components/Panel.ts`, commit `9e37fab`). In a sidecar-backed runtime
  where a recent RPC advertised `X-WM-Mirror-Keys`, renders the error radar +
  `common.notSyncedYet` + a **Refresh from cloud** button (`data-panel-retry`,
  so `setFetching()` disables it too). Click → `btn` disabled, text →
  `common.refreshing`, `await refreshMirrorKeys(keys)`; on `refreshed.length > 0`
  → `resetRetryBackoff()` + `retryCallback()`, else re-enable +
  `common.stillUnavailable`. **No sidecar, or no hint recorded →
  `this.showError(message, onRetry, autoRetrySeconds)` verbatim** — that
  fall-through is what makes it a safe unconditional drop-in. Reuses the
  existing `.panel-error-*` CSS; no stylesheet change.
- **Named `showNotSynced`, not `showUnavailable`** — 5 panels
  (DailyMarketBrief, GlobalProcurement, Giving, MarketImplications, Insights)
  already define a bespoke `showUnavailable()` for a "feature needs live data"
  state, and `data-loader.ts` calls it by name via `callPanel(...)`. A base
  method of that name is a silent incompatible-signature override — caught
  mid-session when the `sed` swap turned `GlobalProcurementPanel`'s internal
  `this.showError('…', cb, 60)` into a 3-arg call on its own 0-arg
  `showUnavailable()`. Renamed the base method; the 5 bespoke ones are untouched.
- **`getRecentMirrorKeyHints({ pathPrefix?, maxAgeMs? })`** added to
  `mirror-key-hints.ts`. `getMirrorKeyHint(pathname)` needs the exact RPC path,
  which a panel doesn't have (it calls a service fn like
  `fetchConsumerPriceOverview()`, not a URL). This unions every non-expired
  hint's keys, walks the hint map newest→oldest so the freshest RPC's keys sort
  first, dedupes, caps at 16 (the sidecar's own `/api/local-sync-refresh`
  limit). For a panel that has *just* failed to render, the freshest hints are
  its own RPCs — so "all live hints" is correct in practice; `pathPrefix`
  (`/api/<domain>/v1/`) narrows it for the few panels that want to be surgical.
- **i18n.** 4 new `common.*` keys (`notSyncedYet`, `refreshFromCloud`,
  `refreshing`, `stillUnavailable`) in `en.json`, propagated to all 24 other
  locales via `scripts/sync-locale-keys.mjs`, and mirrored into `en.shell.json`
  (the `i18n-english-shell` test requires `common` parity with `en.json`).
- **Part 2 adoption (`2973815`).** `this.showError(` →
  `this.showNotSynced(` across **48** `src/components/*Panel.ts` via `sed`.
  Untouched: `Panel.ts`'s internal fall-through call; `NewsPanel`'s `showError`
  override (given a parallel `showNotSynced` override that clears
  `lastRawClusters`/`lastRawItems` before delegating). `autoRetrySeconds`
  3-arg call sites (e.g. `TechReadinessPanel`, `OilInventoriesPanel`,
  `WsbTickerScannerPanel`) work as-is — `showNotSynced`'s 3rd param mirrors
  `showError`'s. Genuine config-error branches (`showConfigError`) not in scope.
  2 tests fixed: `frontend-cii-source-of-truth` (harness mock method
  `showError`→`showNotSynced` + the `refreshBody` regex);
  `giving-panel-expiry` (stub `Panel` gains `showNotSynced`).
- **Tests.** `tests/mirror-key-hints.test.mts` +7 cases for
  `getRecentMirrorKeyHints` (union, dedupe, `pathPrefix`, TTL, 16-cap,
  copy-safety, non-sidecar) — 18/18. `tsc` + `typecheck:api` + `biome`
  (touched files) + `lint:boundaries` clean. Full `test:data` failing-group
  names diffed against a clean `daec068` `git stash` baseline — **identical**
  (25 pre-existing groups incl. `premiumFetch`, `English i18n shell split`,
  `readBootstrapTierObject`; 0 new), after both parts.

### Session 65 — 2026-09-06

**Workstream 7 — direct-fetch handler audit + infrastructure domain (fix #1).**
P14 Phase 2 loop extraction is done (S64 / P16); picked up the next Workstream 7
item. WS-core/Telegram stays blocked on the cross-org-secrets decision.

- **Audit.** Enumerated the 22 direct-fetch RPC handlers + 9 shared modules and
  cross-referenced each against seeder coverage, the `sync-domains.mjs` denylist,
  and the handler's own cache-read seam. Full per-handler table lives in
  `scratchpad/ws7-direct-fetch-audit.md` (working file — fold into this doc's
  Workstream 7 section if it's lost). Model: **(a)** seeded canonical key +
  auto-mirror + cache-first handler = already works from the mirror; **(b)**
  on-demand deep query = keep the fetch, degrade explicitly.
- **Headline.** `cloudPreferredPrefixes` (`local-api-server.mjs:766`) predates
  Workstream 4's denylist-mirror inversion and the S57–S64 seeder buildout.
  infrastructure / research / military / news + most of economic / market are
  now already served from the Upstash→SQLite mirror. The real remaining tail is
  ~8 user-triggered RPCs (`analyze-stock`, `get-insider-transactions`,
  `stock-news-search`, `summarize-article`, `imagery/search-imagery`,
  `backtest-stock`, `_bilateral-hs4-lazy`, wingbits-per-aircraft) that need an
  explicit "requires connection" state, plus `reverse-geocode` /
  `get-country-facts` (per-request, cacheable, self-warming — accept degraded).
- **Fix #1 — `cf:` mirror-deny misclassification (`<this commit>`).**
  `scripts/shared/sync-domains.mjs` `DENY_PREFIXES` carried a blanket `'cf:'`
  (added in Workstream 4's `5acbb57`, grouped under "infra / health / probes").
  The only `cf:` keys that exist anywhere in the store are `cf:radar:ddos:v1`
  and `cf:radar:traffic-anomalies:v1` — Cloudflare **Radar** display data
  written by `scripts/seed-internet-outages.mjs`, and the sole source for
  `list-ddos-attacks` / `list-traffic-anomalies`, which are pure Redis readers
  with **no fetch fallback**. Under the `cf:` deny they never reached the
  operator mirror → both infra panels permanently blank on the VS Code sidecar
  (masked today only by `/api/infrastructure/v1/` being cloud-preferred). A
  name-based miss the Workstream 4 "read the real keys" audit didn't catch.
  Narrowed `'cf:'` → `'cf:cache:'` (Cloudflare cache-purge bookkeeping, the
  only thing that deny was plausibly protecting). `writeExtraKeyWithMeta`'s
  fast-path `notifyChange` nudge now also fires for these keys (it self-gates
  on `isMirroredKey`). `tests/sync-domains.test.mjs` gains a regression block
  (`cf:radar:*` → `'mirror'`; `cf:cache:purge` still `'deny'`).
- **Verification.** `npm run lint:boundaries` + `npx tsc --noEmit -p
  tsconfig.api.json` + `biome lint` on the touched files all clean.
  `sync-domains.test.mjs` + `mcp-bootstrap-parity.test.mjs` +
  `seed-utils-notify-mirrored-writes.test.mjs` = 56/56 via `tsx --test`
  (`mcp-bootstrap-parity` fails under bare `node --test` — it imports
  `api/mcp.ts`; needs the `tsx` loader, unrelated to this change). Change is a
  one-token deny-list edit + a test block — no full `test:data` twice-vs-baseline
  run (the S64 handoff's own bar for a change this size).
- **Verification pass (after Fix #1).** Traced every 6-prefix handler's failure
  return + read ordering. Seeded (a) handlers all confirmed read-mirror-first —
  except `list-military-flights`, whose **per-request cache key**
  (`military:flights:v1:<bbox>:<op>:<type>`) always misses the bare seeded key on
  the sidecar and degrades via a secondary `fetchStaleFallback()` on the mirrored
  `military:flights:stale:v1` (coarser). On-demand (b) handlers under the 6
  prefixes mostly already carry a `cache-contract.ts`-recognised marker
  (`available:false` / `unavailable:true` / non-empty `error`) — the audit's
  "must add explicit degraded state" was overcautious.
  `economic/list-world-bank-indicators` turned out **frontend-dead** —
  `getIndicatorData` (its only wrapper) has 0 callers in `src/`,
  `getCountryComparison` is "unused, API-compat", and the WB panels read the
  seeded `economic:worldbank-*` bootstrap keys ("never call the WB API from the
  frontend") — so its silent `{data:[]}` blanks nothing and `/api/economic/v1/`
  comes off the blocker list. Every `market` direct-fetch handler carries a
  marker (`analyze-stock` → `available:false`, `get-insider-transactions` →
  `unavailable:true`, `get-country-stock-index` → `available:false` after reading
  seeded `market:stock-index:v1:CN`). Only two real silent-empty gaps left,
  **both off the 6-prefix critical path** and needing a proto field +
  `make generate`: `imagery/search-imagery`, `military/get-wingbits-live-flight`.
  **No critical-path code bug beyond Fix #1; all 6 `cloudPreferredPrefixes` are
  technically safe to drop.**
- **Pass 3 — `cloudPreferredPrefixes` is inert in the P2 default config.** Traced
  the call graph: `isCloudPreferred()` is consulted at exactly one point in the
  request flow (`local-api-server.mjs:~2184`), behind `if (context.cloudFallback
  && …)`, and `cloudFallback` defaults **off** (`local-api-server.test.mjs:240`).
  With `WS_RELAY_URL` unset (the operator backend) the 6-prefix array is
  populated but never read. So the 6 domains **already run their local handlers
  against the SQLite mirror** in the shipping P2 config — the S56 note's "under
  P2 that set breaks" was backwards.
- **Fix #2 (operator call — revised).** Removing the prefixes is a **no-op for
  the default `cloudFallback=false` config**. For opt-in `cloudFallback=true`
  operators it swaps "always proxy these 6" for "run local, per-route fallback on
  `!response.ok`" — caveat for that group only: a local `200 {available:false}`
  doesn't trip `!response.ok` (`local-api-server.mjs:2236`), so on a cold mirror
  they'd get the marker not cloud data. Closing that = a small sidecar change
  (buffer the local body, run `getRpcNoStoreReasonFromJson` — the same check
  `server/gateway.ts:1499` does — fall back on a marker). Hot-path → its own
  session + full `test:data`. **The direct-fetch checklist item is otherwise
  retired for P2's real config.**

**Per-key mirror refresh — backend foundation (`12522cf`).** New affordance
(operator's product idea): a per-panel "not synced yet → Refresh from cloud"
button that pulls *specific* keys from Upstash into the local mirror, not a
full rescan. Backend landed:
- **`X-WM-Mirror-Keys` response header** — the choke point. `server/_shared/usage.ts`
  gains `UsageScope.mirrorKeys?: Set<string>` + `recordMirrorKeyRead(key, filter)`;
  `redis.ts`'s `readCachedJson()` / `getRawJson()` call it (filtered by
  `isMirroredKey`), so it self-maintains — the key a handler actually reads is
  the key advertised, templated/multi-key handlers included, no manifest to
  drift. The sidecar wraps each handler call in a usage scope carrying the Set
  (`runWithUsageScope` re-exported from `redis.ts` so the sidecar's existing
  `redis.js` import reaches it; degrades to a pass-through if that import fails)
  and stamps the collected keys on the response; `Access-Control-Expose-Headers`
  added so the cross-origin webview can read it. Cloud gateway path untouched
  (no `mirrorKeys` Set there → `recordMirrorKeyRead` is a one-ALS-lookup no-op).
- **`POST /api/local-sync-refresh` `{ keys: string[] }`** — targeted pull reusing
  `sync-listener.mjs`'s `applyChange()` (same single-key fetch+upsert the live
  push path runs → byte-identical row). Denylist-filtered, max 16 keys, 10s
  per-key cooldown, 503 when mirror sync isn't configured.
- Also hardened: `startFullReconciliationLoop` / `startSyncListener` now require
  `UPSTASH_REDIS_REST_URL` too (token-without-URL otherwise spawns a doomed
  `local-sync.mjs` child every interval); `createReadClient()` reads env fresh +
  is exported.
- **Client foundation (`64a7c9d`).** New `src/services/mirror-key-hints.ts`:
  `recordMirrorKeyHint(input, res)` skims `X-WM-Mirror-Keys` off an RPC
  `Response` into a per-pathname map (10-min TTL, 200-cap) — wired at
  `premiumFetch`'s 4 return points because the generated RPC clients throw the
  `Response` away. `getMirrorKeyHint(pathname)` → the key(s) that path last
  read; `refreshMirrorKeys(keys)` → `POST /api/local-sync-refresh` (dedup, cap
  16) → `{refreshed, skipped}` | null. All no-ops outside
  `isSidecarBackedRuntime()`. `tests/mirror-key-hints.test.mts` (12 cases).
- **Still not built:** the shared "not synced yet + Refresh" panel affordance
  (a `SafeHtml` builder + click delegation) that calls `getMirrorKeyHint(rpcPath)`
  then `refreshMirrorKeys()`, adopted panel-by-panel (~80 panels) alongside the
  degraded-marker rendering. Pure mechanical adoption now — the data path is done
  end to end.

**Operator decisions taken (P17 / P18 / P19).** The two long-standing "needs the
operator" items resolved:
- **P17 — AIS ingest = shared service → shared "AIS results" Upstash** (option C),
  NOT P14(a)'s per-tenant write-token registry. The shared deploy holds only its
  own creds; each org's `sync-listener` pulls the AIS namespace from the shared
  store. Removes the largest P10 secret-isolation deviation for a ~30–60s
  staleness cost the streaming path already accepts.
- **P18 — Telegram poller = per-org `--once` job** with each tenant's own
  `API_ID`/`API_HASH`/session + a concurrency-1 Redis lock. No shared
  Telegram-credential service.
- **P19 — `cloudFallback` stays OFF, formalized (CF-A).** Executed this session:
  `cloudPreferredPrefixes` / `cloudPreferredExact` + their checks deleted from
  `local-api-server.mjs` (`isCloudPreferred` now only reports adaptively-learned
  routes; `LOCAL_API_CLOUD_FALLBACK=true` still works as an unsupported opt-in).
  The S65 Refresh-from-cloud button is the "not synced yet" escape hatch.
  Sidecar suite green bar the pre-existing env-only `EADDRINUSE :46123`.
- **Unblocked next:** the WS-core + Telegram extraction (P14 Phase 2 tail) — a
  new shared-ingest deploy target + a per-org scheduled Telegram job. Its own
  session; substantial new infra (GH Environment, deploy workflow,
  `sync-domains` AIS-results source, runbook steps).

### Session 64 — 2026-09-06

**P14 Phase 2 — Classify loop extracted (25 of 27 gone).** The item S63 kept
flagging as "own session — largest loop, notification + ~400-line dependency
port." Executed as a notification migration, same family as UCDP / Weather /
CorridorRisk / ShippingStress / Market.

- **New `scripts/seed-classify.mjs` — hand-rolled, not `runSeed`.** The loop's
  real output is (a) N per-title `classify:sebuf:v6:<hash>` cache keys, (b) a
  *conditional* `news:threat:summary:v1` canonical (skipped when a run produces
  zero country matches), (c) `seed-meta:news:threat-summary` (unconditional),
  and (d) `rss_alert` notifications emitted mid-run, per LLM batch, for every
  `critical`/`high` classification. None of that maps onto `runSeed`'s
  one-canonical-key + `afterPublish` model, and the 5-variant loop's 4×3-min
  inter-variant stagger (~12-min wall time) far exceeds `runSeed`'s ~4-min
  fetch-phase deadline. Modeled on `scripts/seed-social-velocity.mjs`
  (`export async function main()` + `acquireLockSafely` + direct-run guard).
- **Ported verbatim:** `publishNotificationEvent` (inline-Upstash LPUSH+SETNX,
  the same copy `seed-corridor-risk.mjs` carries — `surface: 'seed-classify'`,
  `buildDedupMaterial`/`recordDedupOutcome` from
  `scripts/shared/notification-dedup.cjs`), the whole `relay*` importance-score
  block (`relayComputeImportanceScore` + `RELAY_SOURCE_TIERS` +
  `RELAY_DIPLOMACY_*`/`RELAY_FLASHPOINT_*` tables +
  `relayHasDiplomacyFlashpointSignal` etc.), `RELAY_GATES_READY` +
  `RELAY_RECENCY_MS` tier-4/recency publish gates, `THREAT_COUNTRY_NAME_TO_ISO2`
  + `THREAT_COUNTRY_NAME_ENTRIES` + `AFFECTED_PREFIX_RE` +
  `matchCountryNamesInText`, `classifyCacheKey` (`classify:sebuf:v6:`, kept
  byte-identical so `news-classify-cache-prefix-audit` still passes),
  `CLASSIFY_LLM_PROVIDERS` (ollama→openrouter→groq) + `classifyFetchLlm[Single]`,
  and the `seedClassifyForVariant` / `seedClassify` loop bodies. Identifier
  names kept as-is (`relay*`) so `importance-score-parity` can still eval the
  scorer out of the source by name.
- **Deviations:** (1) `classifyInFlight` module flag → a 20-min Redis lock on
  `news:classify` so a 15-min tick that overruns skips instead of doubling.
  (2) `news:threat:summary:v1` write via `atomicPublish` (bare `envelopeWrite`
  in the relay) — adds the fast-path `sync-notify` nudge. (3) Canonical TTL
  raised **1200s → 7200s**: `1200` was a relay-cadence artifact and the relay
  is exempt from `tests/seed-ttl-outlives-staleness-fleet.test.mjs`, which
  requires `ttlSeconds` STRICTLY `> maxStaleMin*60` — `newsThreatSummary.maxStaleMin`
  is 60 → 3600, so 7200 clears it. Checked up front, did not recur. (4)
  **`seed-meta:classify` dropped** — repo-wide grep found no reader outside the
  relay's own `startBootSeedLoop` freshness gate; not in `api/health.js`'s
  `SEED_META`. `seed-meta:news:threat-summary` is still written every run
  (health treats `newsThreatSummary` as EMPTY-tolerant but STALE-sensitive).
- **`scripts/ais-relay.cjs` — `-671` lines.** Deleted the whole Classify block
  (~1610–2223) + the `startClassifySeedLoop()` boot call + the now-orphan
  `upstashMGet` (grep-confirmed: Classify was its only caller; `envelopeWrite`
  stays — OREF + Transit + TransitSummary still use it). **KEPT:**
  `publishNotificationEvent` + `upstashSetNx`/`upstashLpush`/`upstashDel` +
  `notifySimpleHash` + the `notification-dedup.cjs` require + the
  `@notification-source: domain` file header — all still live for the OREF
  `oref_siren` producer at ~1250.
- **Registration:** `scripts/railway-services.json` + `gcp/scheduler/main.ts`
  `CADENCES` — `seed-classify` `every 15 minutes`.
- **Tests:** `tests/relay-importance-recompute.test.mjs` →
  `git mv` `tests/classify-importance-recompute.test.mjs` + retargeted to
  `seed-classify.mjs`; `importance-score-parity` + `diplomacy-keywords-parity`
  (`RELAY_*` literal drift guard) + `news-classify-cache-prefix-audit`
  retargeted from `ais-relay.cjs` to `seed-classify.mjs`;
  `notification-relay-payload-audit` PRODUCER_FILES `+1` (`seed-classify.mjs`,
  `domain`); `relay-boot-seed-freshness-guard` SEEDERS `-1` and its "every
  seed/warm-ping loop routes through `startBootSeedLoop`" test relaxed — with
  Classify gone there are **zero** named `start*SeedLoop` wrapper functions
  left in the relay (Transit/TransitSummary call `startBootSeedLoop` inline),
  so an empty match list is now the expected state, not a regex-matched-nothing
  bug. The two `deepEqual([])` checks below still catch any wrapper that comes
  back ungated.
- **Two real retargets the baseline diff caught that the plan under-scoped:**
  `diplomacy-keywords-parity.test.mjs`'s `scripts/ais-relay.cjs RELAY_* literals
  match canonical JSON` case (the `RELAY_DIPLOMACY_KEYWORDS` /
  `RELAY_FLASHPOINT_SCORING_KEYWORDS` / `RELAY_DIPLOMACY_FLASHPOINT_PAIRS`
  literals moved to `seed-classify.mjs`) and the `relay-boot-seed-freshness-guard`
  wrapper-function assertion above. Neither was in the targeted-test list;
  only the full `test:data` name-diff surfaced them.
- **Verification:** `tsc --noEmit` (repo-wide) + `typecheck:api` + `biome check`
  (10 touched files) + `lint:boundaries` — all clean. Full `test:data` run
  **twice on-branch** + **twice on a clean `65417f9` `git stash -u` baseline**,
  failing-test names diffed — **0 new regressions**. `readBootstrapTierObject`
  is the known `cancelledByParent` ±1/run flake (absent in baseline run 1,
  present in baseline run 2 — the flake is in the baseline, not the branch).
  `railway-registry` / `nixpacks-import-graph` / `no-escape-import` are the
  documented pre-existing `process-*-tasks`/`scenario-worker` Dockerfile
  failures. Live-smoke-tested: `APP_DOMAIN=worldmonitor.app node --env-file=.env
  scripts/seed-classify.mjs` against prod Upstash.
- **Loop extraction COMPLETE — 25 of 27 out; Transit + TransitSummary stay
  relay-local permanently (new decision P16).** Both consume `chokepointCrossings`,
  the in-process Map fed by the relay's live AIS WebSocket — a `--once` cron
  would publish all-zero counts. The "relay flushes the Map to Redis, standalone
  crons read it" alternative was weighed and **declined on maintainability
  grounds**: it introduces an in-process-buffer→Redis pattern used nowhere else
  in the pipeline, spreads transit logic across three sites (flush writer +
  intermediate key + consumer) to produce byte-identical output, and adds a
  silent-staleness failure mode — all to conform to a file-naming convention.
  Co-locating a consumer with its in-process producer is correct architecture;
  `ais-relay.cjs` is the shared AIS-ingest service (P14a), always pinned by
  design, so two 10-min timers on it don't reopen P14's "no pinned *per-org*
  instances" goal. Recorded as a permanent exception (explicitly "not a TODO")
  in three places: the block comment on `seedChokepointTransits` in
  `ais-relay.cjs`, the `SEEDERS` comment in
  `tests/relay-boot-seed-freshness-guard.test.mjs`, and decision P16.
- **Next in Workstream 7:** WS-core + Telegram-poller extraction (blocked on
  cross-org-secrets), the 21 direct-fetch handlers + 9 shared modules, then
  `cloudFallback`. `v2.13.0` still on hold (P12).

### Session 63 — 2026-09-05

Continued the S62 P14 Phase 2 loop-extraction batch. Started from the S62
handoff's "tier 1 = 6 straight ports" (Satellites, Classify, USNI-fleet,
PizzINT, Transit, TransitSummary) but **read every loop body first** — and
three of the six were mis-tiered:

- **Classify** — calls `publishNotificationEvent({eventType:'rss_alert'})`, so
  it's a notification-migration job, not a straight port. It also drags in
  ~400 lines of relay-local scoring machinery (`RELAY_SOURCE_TIERS`,
  `relayComputeImportanceScore`, the `RELAY_DIPLOMACY_*`/tier-4/recency gates,
  `classifyFetchLlm` + `CLASSIFY_LLM_PROVIDERS`, `classifyCacheKey`,
  `matchCountryNamesInText`, `upstashMGet`) plus a 5-variant staggered
  ~12-min loop with a per-title Redis LLM cache. It's the single largest loop
  in the file. Reclassified to the notification tier; needs its own session.
- **Transit** (`seedChokepointTransits`) — reads `chokepointCrossings`, an
  **in-process `Map` populated by the relay's live AIS WebSocket vessel
  stream** (geofence-crossing detection at `ais-relay.cjs:~4960`). A
  fetch-based standalone cron has no AIS feed and would publish all-zero
  transit counts. Not extractable as-is.
- **TransitSummary** — merges three inputs: `PORTWATCH_REDIS_KEY` (Redis,
  portable), `latestCorridorRiskData` (in-process, but Redis-hydratable from
  `CORRIDOR_RISK_REDIS_KEY`), and `chokepointCrossings` again (the AIS
  blocker). Same problem for the transit-count half.

Recommendation recorded in the Status block: Classify → own session; Transit
+ TransitSummary → either leave in `ais-relay.cjs` (they consume the relay's
reason for existing) or design a different split where the relay periodically
flushes `chokepointCrossings` to a Redis key a standalone script reads.
Operator's call.

**The 3 genuine straight ports, each its own commit:**

- **Satellites** (`cbb78e2`) → `scripts/seed-satellites.mjs`. `SAT_NAME_FILTERS`,
  `satClassify`, TLE triple-line parse ported verbatim; `https.request` →
  `fetch` + post-hoc 2MB guard. `runSeed('intelligence','satellites',
  'intelligence:satellites:tle:v1', …)`, `every 2 hours`, `maxStaleMin: 240`.
  The relay's 20-min in-loop retry is dropped (runSeed extends last-good TTL
  on failure; next tick is the retry — same as `seed-gscpi.mjs`). Live-fetched
  both CelesTrak GP catalogs: 191 entries → 98 matched recon TLEs.
- **USNI-fleet** (`35b068d`) → `scripts/seed-usni-fleet.mjs`. HTML parsing
  delegated verbatim to `scripts/lib/usni-fleet-parser.cjs` (already
  standalone CJS, test-covered). `ytFetchViaProxy` fallback → the
  `_proxy-utils.cjs` `resolveProxyConfig`/`proxyFetch` idiom the other
  extracted loops use. 7-day `usni-fleet:sebuf:stale:v1` fallback is a
  `runSeed` `extraKey` (same payload, longer TTL, no separate meta).
  `every 6 hours`, `maxStaleMin: 720`. Live-fetched the real Fleet Tracker
  post: 42 vessels, 3 CSGs, 10 regions.
- **PizzINT** (`a4db79d`) → `scripts/seed-pizzint.mjs`. Location mapping,
  DEFCON thresholds, GDELT tension-pair shaping ported verbatim. GDELT batch
  fetch stays non-fatal (pizzint.watch's `/api/gdelt/batch` currently 400s —
  the relay loop tolerates this identically, `tensionPairs` just stays `[]`).
  `zeroIsValid: true` preserves the loop's unconditional publish. `every 10
  minutes`, `maxStaleMin: 30`. Live-fetched `/api/dashboard-data`: 6 locations,
  `success:true`.

Each: new `scripts/seed-*.mjs` + `railway-services.json` (`nixpacks-root-repo`)
entry + `gcp/scheduler/main.ts` `CADENCES` entry; loop + all local identifiers
+ boot call site deleted from `ais-relay.cjs`; every deleted identifier
grepped repo-wide for stray refs (none — all were loop-local; PizzINT's
generically-named `GDELT_BATCH_API`/`DEFAULT_GDELT_PAIRS` had no other
readers); removed from `tests/relay-boot-seed-freshness-guard.test.mjs`'s
`SEEDERS`. `tsc --noEmit` clean repo-wide after each. `relay-boot-seed-
freshness-guard` green (24→23→22 as `SEEDERS` shrank). The 3 pre-existing
`railway-services-registry-coverage` / `nixpacks-seeder-import-graph` /
`scripts-railway-nixpacks-no-escape-import` failures diffed byte-identical
against a `git stash -u` clean-tree baseline — 0 new regressions.

**Regression caught by the full-suite baseline diff:** the verbatim TTL ports
tripped `tests/seed-ttl-outlives-staleness-fleet.test.mjs` — a ratchet that
demands `ttlSeconds` STRICTLY `> maxStaleMin*60` so a late seeder is
`STALE_SEED` (warn), not `EMPTY` (crit). `USNI_TTL=43200s` vs a 720-min gate
and `PIZZINT_SEED_TTL=1800s` vs a 30-min gate were exactly equal. The relay
loop never tripped it (not a `seed-*.mjs` file). Fixed in `94ea434` by
raising the two TTLs (USNI 12h→18h, PizzINT 30m→60m) per the test's own
"raise it, don't allowlist" guidance; Satellites was already clear
(21600 > 14400). Lesson: a "verbatim port" can carry latent debt that only
becomes enforced once the code lands in a file the guards actually scan —
the full `git`-checkout-in-place baseline diff (not a worktree; worktrees
lack `node_modules` and silently no-op'd twice) is what surfaced it.

`main` @ `94ea434` (well ahead of `origin/main`, not pushed). **18 of 27
loops out of `ais-relay.cjs`.**

**S63-later — the 3 rate-limited ports (PositiveEvents, WsbTickers,
SocialVelocity), 21 of 27.** Not the quick batch the S62 handoff implied:
- **PositiveEvents** (`fe5de39`) → `scripts/seed-positive-events.mjs`. The
  loop's inter-query `setTimeout(5_500)` became `_gdelt-fetch.mjs`'s
  cross-process rate gate (`GDELT_RATE_WINDOW_MS = 5_500` — the same 5s+
  floor, now coordinated with the 3 other GDELT seeders, with a direct→proxy
  fallback the raw `https.get` never had). TTL 2700→4500 to clear the
  `seed-ttl-outlives-staleness-fleet` ratchet the relay's 45-min TTL was
  silently under (same class as the USNI/PizzINT fix above).
- **_reddit-hot.cjs** (new) — the shared "Reddit data fetch" block
  (ScrapeCreators→OAuth→public, token single-flight+cooldown, vendor
  normalization) ported verbatim; `require`d by both Reddit consumers.
- **WsbTickers** (`aa8ef32`) → `scripts/seed-wsb-tickers.mjs` (`runSeed`;
  ticker extraction verbatim; reads `market:stocks-bootstrap:v1`).
- **SocialVelocity** (`aa8ef32`) → `scripts/seed-social-velocity.mjs`
  **hand-rolled** (not `runSeed`) to preserve its `status:'ok'/'error'` +
  `errorReason` seed-meta that `api/health.js` reads for immediate
  SEED_ERROR — `runSeed` has no equivalent; same call
  `seed-gas-storage-countries.mjs` made.
- 3 test files retargeted from `ais-relay.cjs` to the new files
  (`positive-events-seed-failure`, `reddit-oauth-fetch`,
  `social-velocity-seed-health`); `relay-boot-seed-freshness-guard` SEEDERS
  −3.
- Regression check: `test:data` twice on branch + twice on a `9bf6bf3`
  in-place baseline — **union(branch fails) ⊆ union(baseline fails), 0 new.**
  `readBootstrapTierObject` (a `cancelledByParent` timing flake, test +
  module byte-identical across the diff) and `renewable energy last-known-good
  recovery` are the ±1-per-run flake names, on **both** trees.

`main` @ `<pending>` after `aa8ef32`. **21 of 27 loops out of `ais-relay.cjs`.**

**S63-later-2 — CorridorRisk + ShippingStress notification migration
(`886d295`), 23 of 27.** The batch the S63-later handoff recommended next.
Both loops called `publishNotificationEvent`, so — like UCDP/Weather in S62 —
the publisher moved to the new standalone script, not just the Redis write.
Neither had a standalone sibling, so each is a fresh `scripts/seed-*.mjs` +
`railway-services.json` + `CADENCES` entry, both on the `runSeed` contract
with an `afterPublish` hook and the inline-Upstash `publishNotificationEvent`
copied verbatim from `seed-weather-alerts.mjs`.
- **`seed-corridor-risk.mjs`** (`every 1h`) — corridorrisk.io fetch,
  Cloudflare-challenge guard, `CORRIDOR_RISK_NAME_MAP`, risk-level derivation,
  output-field shaping all verbatim. `afterPublish` publishes one
  `corridor_risk` notification per corridor scoring `>= 50` (`high`, or
  `critical` at `>= 70`; `dedupTtl 3600`). **TTL 14400 needed no ratchet
  bump** — checked `seed-ttl-outlives-staleness-fleet` up front this time
  (14400 > the 120-min gate's 7200); the trap that bit USNI/PizzINT/
  PositiveEvents didn't recur.
- **`seed-shipping-stress.mjs`** (`every 15min`) — carrier basket, the
  `40 - avgChange*3` score, level thresholds all verbatim. Yahoo fetch
  switched from ais-relay's `fetchYahooChartDirect` (kept — the Market loop
  still uses it) to the shared `scripts/_yahoo-fetch.mjs` + `parseYahooChart`,
  exactly as `seed-market-quotes.mjs` does. The relay's 20-min `setTimeout`
  retry on an empty fetch is gone → `runSeed`'s RETRY-on-empty (preserve
  last-good + extend TTL) + the next 15-min tick. `afterPublish` publishes a
  `shipping_stress` notification when `stressScore >= 75` (`critical` at
  `>= 90`; `dedupTtl 7200`). TTL 3600 > the 45-min gate's 2700 — safe.
- **Kept in `ais-relay.cjs`:** `CORRIDOR_RISK_REDIS_KEY` and
  `latestCorridorRiskData`. The relay's TransitSummary loop (not extractable —
  it consumes the live-AIS `chokepointCrossings` Map) already Redis-hydrates
  `supply_chain:corridorrisk:v1` into `latestCorridorRiskData` on its own
  10-min tick when its copy is null, so it keeps getting corridor data. The
  only lost behavior is the direct `seedCorridorRisk → seedTransitSummaries()`
  kick — corridor data now lands in transit summaries on the next
  TransitSummary tick instead of instantly. `-206` lines from `ais-relay.cjs`;
  every deleted identifier grepped repo-wide → only test files referenced them.
- **Tests:** `relay-boot-seed-freshness-guard` SEEDERS −2;
  `notification-relay-payload-audit` PRODUCER_FILES +2 (both
  `@notification-source: domain`, both verified to carry no `description:` in a
  payload); `corridorrisk-upstream.test.mjs` + `transit-summaries.test.mjs`
  retargeted the `seedCorridorRisk` fetch/shape/name-map/risk-level assertions
  from `ais-relay.cjs` to `scripts/seed-corridor-risk.mjs` — the
  `seedTransitSummaries` assertions in `transit-summaries.test.mjs` stay on
  `ais-relay.cjs` (that loop didn't move), and the one "kicked after
  CorridorRisk seed" assertion flipped to asserting the kick is *gone* + the
  Redis-hydration path is present.
- **Verification:** `tsc --noEmit` + `typecheck:api` + `biome lint` +
  `lint-boundaries` all clean. Full `test:data` diffed name-for-name against a
  clean `ee013e3` `git stash -u` baseline — **identical 25-name failure set,
  0 new regressions.** The pre-existing failures are the documented
  `railway-services-registry-coverage` / `nixpacks-seeder-import-graph` /
  `scripts-railway-nixpacks-no-escape-import` trio (all about the
  `process-simulation-tasks` / `process-deep-forecast-tasks` / `scenario-worker`
  Dockerfiles missing registry entries — a P14 Phase 1 queue-worker-merge
  leftover, nothing to do with this change) plus `readBootstrapTierObject`
  (the known `cancelledByParent` flake).

`main` @ `886d295` (this commit) + a `<pending>` doc commit. **23 of 27 loops
out of `ais-relay.cjs`.** Remaining 4: Classify (own session), Transit +
TransitSummary (operator decision — leave in the relay or design a
`chokepointCrossings`→Redis flush), Market (needs `seed-sector-summary.mjs`).

**S63-later-3 — Market seed loop deleted (`e91333c` + `a8f6c64`), 24 of 27.**
The item the last handoff parked as "needs `seed-sector-summary.mjs` first".
Two commits:
- **`e91333c`** — `scripts/seed-sector-summary.mjs`, the one sub-seed of the
  9-way `seedAllMarketData` bundle with no standalone anywhere. `runSeed`
  contract, `every 15min`. `SECTOR_SYMBOLS`, the Finnhub→Yahoo-chart change%
  cascade, the `/v10/finance/quoteSummary` crumb-session valuation fetch, and
  `parseSectorValuation` ported verbatim. Two deviations, same as every earlier
  port this pass: Yahoo *chart* fetches go through the shared `_yahoo-fetch.mjs`;
  the quoteSummary curl-proxy fallback + 5-failure cooldown are dropped
  (valuations are best-effort — the relay wrote the key with `valCount:0` — and
  a 15-min cron doesn't need per-tick backoff). `afterPublish` writes the
  `market:quotes:v1:<sorted sector symbols>` GetMarketQuotes companion.
- **`a8f6c64`** — the whole loop deleted, **−1064 lines**. Verified all 8 other
  sub-seed keys covered at a cadence within their health `maxStaleMin`, the
  equity trading-day gate + China country-stock index both already replicated
  in `seed-market-quotes.mjs`. Deleted: 9 `seedXxx` fns, `seedAllMarketData`/
  `Once`, `startMarketDataSeedLoop`, boot call, the equity gate
  (`maintainClosedMarketEquityKeys` + `_equityGate*` + `_lastEquity*`), the
  Yahoo crumb/chart/curl-proxy stack (`fetchYahooChartDirect`,
  `_fetchYahooChartNoProxy`, `_parseYahooChartJson`, `fetchYahooQuoteSummary`,
  `_yahooQuoteSummaryProxyFallback`, `_getYahooCrumbSession`,
  `_loadYahooCrumbSession`, the `_yahoo*` cooldown vars),
  `fetchFinnhubQuoteDirect`, `parseSectorValuation`, `sleep` (relay-market-only),
  `SECTOR_SYMBOLS`, `MARKET_*` consts, `CHINA_COUNTRY_STOCK_SYMBOL`, and the
  `require('./shared/{market-hours,market-quote-refresh,closed-market-equity-maintenance}.cjs')`
  + `import('./_country-stock-index.mjs')` lines. `node --check` clean; every
  deleted identifier grepped repo-wide (all remaining hits are breadcrumb
  comments).
- **The trap it hit:** the loop published `market_alert` notifications from 3
  sub-seeds (equity/commodity ≥5% / crit ≥10%, crypto ≥10% / crit ≥20%; top 3
  by |move|; hidden `market:<class>:<id>:<dir>:<sev>` coalesce key). The S61
  audit's "Market: investigated, left alone" note checked Redis-key duplication
  but **not `publishNotificationEvent` calls** — exactly what the standing rule
  says to grep for. Caught only because the twice-baseline regression diff
  surfaced one new failure (`notification-relay-coalesce-key` "market alert
  producer"). Migrated: new `scripts/shared/market-alert-coalesce-key.cjs`
  (`marketAlertCoalesceKey`, verbatim) + new `scripts/shared/market-alert-notify.mjs`
  (**one** `dispatchMarketAlerts()` — the 3 sub-seeds did the identical thing
  bar thresholds/label, so one publisher with an inline LPUSH+SETNX like
  `seed-weather-alerts.mjs`, not 3 inline copies), invoked from each of
  `seed-market-quotes.mjs` / `seed-commodity-quotes.mjs` / `seed-crypto-quotes.mjs`
  `afterPublish`. All 3 + the shared module tagged `@notification-source: domain`.
- **Fallout cleanup:** `Dockerfile.relay` −4 dead COPYs (`market-hours.cjs`,
  `market-quote-refresh.cjs`, `closed-market-equity-maintenance.cjs`,
  `_country-stock-index.mjs`); `.env.example` −`DISABLE_RELAY_MARKET_SEED` /
  `MARKET_YAHOO_REFRESH_INTERVAL_MS` (`planYahooRefresh` was relay-loop-only;
  the standalone's 30-min cron cadence is its own Yahoo bound — noted as a
  now-dead but harmless export of `scripts/shared/market-quote-refresh.cjs`,
  left in place because `mergeLastGoodQuotes` beside it is live and the module
  has its own tests). 9 test files retargeted (`sector-valuations`,
  `china-country-stock-index-seed`, `china-market-news-coverage`,
  `coinpaprika-targeted-fetch`, `market-hours`, `market-quote-refresh`,
  `notification-relay-coalesce-key`, `notification-relay-payload-audit`,
  `dockerfile-relay-imports`) + `relay-boot-seed-freshness-guard` SEEDERS −1.
- **Verification:** `tsc --noEmit` + `typecheck:api` + `biome` + `lint-boundaries`
  clean. `test:data` run twice on the branch, diffed name-for-name against a
  clean `ee013e3` `git stash -u` baseline — **0 new regressions.** The two
  branch runs differ only by `readBootstrapTierObject` (the known ±1/run
  `cancelledByParent` flake); union(branch) ⊆ union(baseline). Pre-existing
  failures unchanged: the `railway-services-registry-coverage` /
  `nixpacks-seeder-import-graph` / `scripts-railway-nixpacks-no-escape-import`
  trio (the `process-*-tasks` / `scenario-worker` Dockerfiles).

`main` @ `a8f6c64` + a `<pending>` doc commit. **24 of 27 loops out.** Remaining
3: Classify (own session), Transit + TransitSummary (operator decision).

### Session 62 — 2026-09-05

Picked up S61's flagged next candidate directly: port UCDP's and Weather's
notification-publishing logic into their standalone `scripts/seed-*.mjs`
siblings so the two loops S61 had to restore into `ais-relay.cjs` could
finally be deleted for real.

**The port.** Used `scripts/seed-aviation.mjs` as the reference implementation
— it had already solved exactly this problem when its own notifying loop
moved out of `ais-relay.cjs` in an earlier pass: inline Upstash SETNX/LPUSH
helpers + the shared `scripts/shared/notification-dedup.cjs` module, no
dependency on anything `ais-relay.cjs`-specific. Copied that pattern into
`seed-ucdp-events.mjs` and `seed-weather-alerts.mjs`, wiring the notification
dispatch as `runSeed()`'s `afterPublish` hook for weather (fires only after a
successful canonical publish) and as a best-effort call after the seed-meta
write for UCDP (which predates `runSeed()` and still hand-rolls its Redis
calls).

**Two bugs caught before shipping, neither from source-reading alone:**
1. `seed-weather-alerts.mjs`'s `fetchAlerts()` never captured the NWS VTEC
   field (`properties.parameters.VTEC[0]`) in its returned alert objects —
   only `ais-relay.cjs`'s copy did. The coalesce-by-VTEC-family logic I was
   porting would have compiled, run, and silently never coalesced anything
   (every alert falling through to the fallback per-alert key) — caught by
   checking the ported code's actual data dependencies against the source it
   was called on, not by any test (none existed yet to catch it).
2. Deleting `ais-relay.cjs`'s UCDP writer block also deleted
   `UCDP_TRAILING_WINDOW_MS` and `UCDP_PAGE_SIZE` — which the *separate*,
   untouched on-demand `/ucdp-events` relay-reader (a user-triggered lookup
   feature, not a Redis writer, that shared those two constants with the
   writer purely by module-scope proximity) still referenced. `node --check`
   stayed green throughout — it's a syntax checker, not a reference resolver.
   Caught only by grepping every identifier the deleted blocks had declared
   against the rest of the file before considering the deletion done.

**Test debt.** 8 test files source-grepped the now-deleted `ais-relay.cjs`
functions directly (`seedUcdpEvents`, `ucdpDiscoverVersion`,
`deriveWeatherCoalesceKey`, `UCDP_POLL_INTERVAL_MS`, …) — a real, load-bearing
pattern in this codebase (relay scripts are runtime side-effect modules with
no exports, so behavioral contracts are enforced by reading the source text).
Found them by running the full suite (105 failures on first pass vs. a
95-failure baseline established via `git stash` on the clean tree), diffing
failing-test names rather than trusting raw counts (this repo's parallel test
run carries real pre-existing flakiness — confirmed identical failing-name
sets across two consecutive runs, with only concurrency-flake churn in
between), then retargeting each one at the new source files rather than
weakening the coverage. One test's concern (a parallel-race-then-rank version
discovery algorithm, `Promise.allSettled` + `ucdpVersionNewer`) turned out to
not translate at all — the standalone script's discovery was always
sequential-in-pre-sorted-order, which is immune to the "faster-but-older
release wins" bug by construction, not by a guard. Deleted those three
assertions with an explanatory comment rather than force a translation that
would have tested nothing real.

Verified: `tsc --noEmit` clean repo-wide; full `npm run test:data` — 95
failures, identical failing-test-name set to the pre-session baseline (0 new
regressions, confirmed by name-diff not just count). Committed `069ea81`.

**Then, same session — started the loop extraction** (the operator said "let's
pick up next", accepting the 1:1 GSCPI template as the pattern to scale).

- **GSCPI** (`5d03aed`). The straightforward case: an existing standalone
  seeder didn't exist, so `scripts/seed-gscpi.mjs` is new — `runSeed()`
  contract, CSV fetch/parse + direct→proxy fallback ported verbatim from the
  deleted `seedGscpi()`. Dropped the in-process retry `setTimeout` (a
  one-shot cron's retry IS the next tick). Live-fetched the real CSV and ran
  the ported parser against it before wiring anything (348 observations).
- **Four RPC warm-pings** (`fb64f12`), consolidated — a deliberate deviation
  from 1:1. CII / chokepoint-status / cable-health / temporal-anomalies were
  four ~20-line loops that GET an RPC and write nothing (the handler
  refreshes its own `seed-meta`). Collapsed into one
  `scripts/seed-rpc-warmpings.mjs` (target table, sequential pings, modeled
  on `seed-news-digest.mjs`) on the tightest of the four cadences, 8 min.
  Over-pinging the 30-min ones is harmless — each handler serves from its own
  internal cache, so ping frequency doesn't change upstream load. The
  now-dead `warmPingHeaders()`/`RELAY_API_KEY` went too.
- **Test-debt sweep.** Both waves ran the full suite and diffed failing-test
  *names* against a fresh clean-tree baseline (`git stash -u` — learned to
  use `-u` after a bare `git stash` left the new untracked script on disk and
  produced a misleading intermediate "new failure"). Each wave *fixed* 3–4
  tests that had been red since S61's Cyber/ServiceStatuses removals —
  `layer-explanations.test.mts` (new `schedulerCadenceMinutes()` helper reads
  `CADENCES` instead of deleted `ais-relay.cjs` constants; the
  `CYBER_SEED_INTERVAL_MS` breakage flagged last entry is now among them),
  `relay-warm-ping-auth.test.mts`, `seed-health-risk-scores.test.mjs`,
  `seed-warm-ping-origin.test.mjs`. 0 new regressions (the lone "new" name,
  `renewable-energy-last-known-good`, fails identically on the clean tree — a
  wall-clock-sensitive flake, verified via stash).

**Remaining loop extraction:** Satellites, PositiveEvents, Classify,
USNI-fleet, SocialVelocity, WsbTickers, PizzINT, Transit, TransitSummary
(no notifications — straight ports, but PositiveEvents hits GDELT and
SocialVelocity/WsbTickers hit Reddit, both with existing throttle logic to
carry over faithfully); **CorridorRisk + ShippingStress call
`publishNotificationEvent`** — same migration as UCDP/Weather. Then Market's
`seed-sector-summary.mjs`, then WS-core/Telegram (blocked on cross-org
secrets). Still flagged, still not touched: `ais-relay.cjs`'s
`cyberPrevAlertedIds` (orphaned S61 leftover). Oref is a real-time poller,
not a `startBootSeedLoop` — it belongs with the Telegram/WS-core extraction,
not this batch.

### Session 61 — 2026-09-05

**Committed S60's cameras removal** (`8eaf658`), then started Workstream 7's
other big item: decomposing `ais-relay.cjs` (P14 Phase 2). Given the scope —
a new shared cross-org service, GCP scheduler migrations, a 27-loop audit —
went through plan mode first rather than editing an 11.6k-line production
file live; operator scoped this session to "audit + delete confirmed
redundant loops" (Stages 1–2 of an 8-stage plan), explicitly deferring the
WS-core/Telegram extraction and the direct-fetch handlers.

**The audit.** For each of the 27 `startBootSeedLoop`-based loops (plus the
Oref poller, a 28th loop using a different mechanism), pulled its Redis
meta-key/canonical key and grepped for a standalone `scripts/seed-*.mjs`
sibling already writing the same key on an already-scheduled cadence. Found
1 already fully dead (Cyber — defined, never invoked, superseded by a
standalone cron per its own neighboring comment) and 9 more with confirmed
exact-key-match duplicates already covered elsewhere (some via their own
`CADENCES` entry, several via `seed-bundle-relay-backup.mjs`/
`seed-bundle-market-backup.mjs`, one — ChokepointFlows — was already being
execFile-delegated to its standalone script by ais-relay itself, just never
independently scheduled).

**The near-miss.** Deleted all 10, then ran the actual test suite (not just
`tsc`) as the plan's verification step required. Two "confirmed redundant"
loops — UCDP and Weather — turned out to also fire live push notifications
(`conflict_escalation`, severe-weather alerts via `publishNotificationEvent`)
that their standalone Redis-mirroring siblings never replicated. The
key-match audit had only checked the *data* side, not side effects; the
notification loss wasn't visible in a `grep` for the Redis key, only in the
test suite actually failing (`tests/ucdp-seed-resilience.test.mjs`,
`tests/notification-relay-coalesce-key.test.mjs`). Restored both to their
exact pre-deletion state (`629df49`, `7febde9`) rather than attempt a
same-session migration of the notification logic into the standalone
scripts — that's real new code, out of this session's delete-only scope.
Net result: **8 loops deleted** (Cyber, TheaterPosture, ServiceStatuses,
Spending, WorldBank, ClimateNewsSeed, ChokepointFlows, TechEvents), file
shrank 11,775 → 10,117 lines.

**Market turned out to be a trap too.** `seedAllMarketData` looked like one
loop with one redundant sibling (`seed-market-quotes.mjs` matching
`seed-meta:market:stocks`) but is actually a 9-way bundle. Checked all 9
sub-seeds' keys individually: 8 have coverage (2 via their own `CADENCES`
entry, 5 via `seed-bundle-market-backup.mjs`, discovered by reading that
bundle's actual source rather than trusting the "ais-relay backup" comment
label alone), but `seedSectorSummary`/`market:sectors` has no replacement
anywhere in the repo. Left the whole loop running rather than delete 8/9 and
silently break the sectors panel.

**Verification.** `node -c` after every single deletion (10 separate
commits, one per loop, for easy `git revert`), `tsc --noEmit` clean
throughout. Full `npm run test:data` run against a `git worktree`-isolated
copy of the pre-session commit to get a *real* baseline rather than trust
the previously-documented "94 fail" figure (which didn't reproduce — actual
baseline was 55 fail/36 cancelled; this suite has more run-to-run variance
than its own documentation assumed, confirmed via a second full run showing
yet a different fail count with almost entirely different failing tests,
none touching `ais-relay.cjs`/the scheduler). Isolated the genuinely
attributable failures via `comm` diffing against that baseline rather than
eyeballing raw counts — found and fixed 2 stale tests
(`tests/relay-boot-seed-freshness-guard.test.mjs`'s `SEEDERS` inventory,
`tests/notification-relay-country-filter.test.mjs`'s dead-code `cyber_threat`
assertion) whose failures were expected consequences of the 8 real
deletions, not regressions.

**Also:** squashed a handful of blank-line artifacts left by the boot-block
invocation deletions; landed `scripts/railway-services.json` +
`gcp/scheduler/main.ts` changes for ChokepointFlows's new independent
schedule.

Not pushed (`main` now well ahead of `origin/main` — operator's call, as
every prior session). Next: migrate UCDP's/Weather's notification logic
into their standalone scripts (unlocks 2 more deletions), then the
remaining ~17 genuinely-unique loops, GSCPI/Classify extraction, and
eventually the WS-core/Telegram/shared-service pieces (Stage 7 is blocked
on an operator decision about cross-org Upstash-credential storage — not
yet raised).

### Session 60 — 2026-09-05

**Workstream 7's cameras removal (P7) done.** Started Workstream 7 fresh, as the
prior session's handoff suggested; the "quick" cameras-deletion item turned
out to touch ~60 files once two Explore agents mapped the full surface
(generated protobuf code, all three map renderers, config across every site
variant, 26 locale files, gateway routing, sync-domain denylist, health
classification, tests) — big enough to plan formally rather than improvise.

**The one real judgment call, surfaced rather than assumed:** the mapping
turned up a direct conflict. An older session (18-19) had explicitly
corrected a prior over-eager deletion attempt — *"do not delete `api/webcam/*`
or its generated client/server code"* — because it protected a real, wanted
feature (`PinnedWebcamsPanel`, "pin a webcam to the map") that a different,
already-approved removal (`LiveWebcamsPanel`, a TV-style stream wall) had
almost taken down with it by mistake. P7 (written much later, S55) names
`PinnedWebcamsPanel` for removal too — reading as a deliberate reversal made
in the platform-pivot context (one fewer of the ~26 per-org data-source keys,
`WINDY_API_KEY`, every tenant would otherwise need), but there was no way to
tell from the repo alone whether that reversal was intentional or whether P7
was written without cross-checking the older correction. Asked the operator
directly rather than guessing either way: confirmed to proceed with full
removal, and to bundle in leftover dead code from the already-settled
`LiveWebcamsPanel` removal that the mapping surfaced as a free find
(orphaned locale keys in all 25 languages, a stale e2e spec, unused
`localStorage` keys).

**Execution, in dependency order:** proto files deleted → `make generate`
(after installing `buf` + the `sebuf` plugins, see below) regenerated every
other domain's client/server code byte-identical to what was already
committed, cleanly dropping only webcam → `scripts/generate-nitric-routes.mjs`
re-run for `gcp/api/routes.generated.ts` → backend RPC handlers, seeder,
scheduler entry, sync-domain deny line, health classification, env docs, and
CSP all cleaned → frontend panel + service deleted → all three map renderers
(`Map.ts`/`GlobeMap.ts`/`DeckGLMap.ts`) had their marker/tooltip/popup layers
removed individually (each renderer duplicates this logic, not shared) →
config/types/app-wiring cleaned across every site variant, with the
`MapLayers.webcams` type removal used deliberately as a `tsc` completeness
check → all 26 locale files cleaned via a small Node script (safer than 100+
manual JSON edits) → 9 test files updated to match.

**A self-inflicted, self-healing detour:** `make generate`'s first run
depended on a `clean` step that wiped the *entire* generated-code directory
before failing on a missing `buf` binary — briefly broke `tsc` repo-wide
across every domain, not just webcam. Recovered by installing `buf` (Homebrew
bottle, not `go install` from source — the latter kept stalling on this
network doing per-dependency `sum.golang.org` checksum lookups, ~1s each,
fixed generally by `GOSUMDB=off` for one-off tool installs) and the two
`sebuf` codegen plugins, then re-running `make generate` clean.

**A second network detour, diagnosed with the `local-network-optimizer`
skill:** the Homebrew bottle download itself then hung on `ghcr.io` — HTTP/2
protocol errors, and forcing HTTP/1.1 worked but crawled at ~15KB/s. The
skill's playbook correctly identified this as VPN-tunnel routing (`route get`
showed `utun6`) for GitHub's release-CDN range, not a broken link (a
Cloudflare speed-test control ran fine at ~580KB/s the whole time). Confirmed
with the operator this was their personal VPN and safe to route around, then
a `sudo route add -net 185.199.108.0/22 <physical-gateway>` fixed it
(270KB/s after). This route is **not persisted** — it's a plain routing-table
entry that won't survive a reboot or VPN reconnect; a future session hitting
the same ghcr.io slowness should re-check `route get` before troubleshooting
from scratch, and can persist it with a LaunchDaemon per the skill's own
template if it recurs often enough to be worth automating.

**Verification:** `npx tsc --noEmit` zero errors repo-wide (the main safety
net for the `MapLayers` type change rippling through every renderer/config
file). Touched-file `biome lint` clean (whole-repo lint has pre-existing
unrelated failures in files this work never touched, confirmed by scope).
Full `npm run test:data` at 94 fail / 36 cancelled — within the documented
pre-existing noise band (88↔94 under `--test-concurrency=16`); spot-checked
the two failures most plausibly connected to this work
(`nixpacks-seeder-import-graph.test.mjs`, `mission-presets.test.mts`) via
`git stash` and confirmed both fail identically on a clean tree, unrelated to
this session's changes. Final repo-wide grep clean except docs/history
(`CHANGELOG.md`, `TASKS.md`, this file) and 3 harmless leftover code
comments, two of which were fixed anyway for accuracy. Not yet committed —
operator's call on when to commit, per this repo's established pattern this
session of not committing without being asked.

### Session 59 — 2026-09-05

**Workstream 6 shipped.** Picked up a plan handed off from the previous
session (plan mode, no code written there — only a plan file + a memory
backup). Before executing, re-verified every one of that plan's factual
claims against the live repo (an Explore pass plus personally reading
`vercel.json`) rather than trusting a session-old plan at face value — all
held up, with one correction worth recording: **`vercel.json` uses only the
modern `rewrites` array (no legacy `routes` key)**, so Vercel's documented
filesystem-priority behavior applies and an existing static file always
wins over a rewrite rule — `settings.html`'s absence from the catch-all's
negative-lookahead allow-list is irrelevant, it was never at risk of being
shadowed. A literal regex-reading of that allow-list (which a first pass
did) gets this wrong; the platform-level serving-order rule is what
actually decides it.

- **The core design, unchanged from the handed-off plan:** a client-side
  gate in `settings-main.ts` — connect (org's Supabase URL + Publishable
  Key, `localStorage`) → sign in (native GitHub OAuth) → admin check
  (`app_metadata.wm_admin`) — ahead of the existing category-editing UI,
  for every non-desktop load (`isDesktopRuntime()` skips it entirely, so
  the Tauri desktop path is byte-for-byte untouched). New
  `src/services/admin-org-connection.ts` holds a Supabase client instance
  kept deliberately separate from `supabase-client.ts`'s dashboard
  singleton — own `auth.storageKey` (`'wm-admin-auth'`) so a signed-in
  admin session can never collide with a signed-in dashboard session in
  the same browser profile, confirmed necessary by checking that the
  dashboard singleton sets no custom storage key of its own (uses
  Supabase's default) — an admin visiting both `settings.html` and
  `dashboard.html` on the same org's project would otherwise fight over
  one `localStorage` slot.
- **Write path** reuses the one existing choke point,
  `settings-manager.ts`'s `commitVerifiedSecrets()`: a single
  `isDesktopRuntime() ? setSecretValue(...) : commitToPipelineConfig(...)`
  branch. `commitToPipelineConfig`'s actual upsert-vs-delete logic lives in
  a separate, directly-unit-testable function
  (`commitPipelineConfigValue(client, key, value)`) that takes the
  Supabase client as a parameter — mirroring `runtime-config.ts`'s existing
  split between pure `validateSecret()` and effectful `setSecretValue()` —
  so the branching is covered by a plain fake-client unit test with no
  `createClient()`/`localStorage` involved.
- **Read path** adds one new `runtime-config.ts` export,
  `seedSecretsFromCloudAdmin()` — the cloud-admin twin of the existing
  `loadDesktopSecrets()`, seeding `runtimeConfig.secrets[key] = { source:
  'vault' }` (presence only, never the plaintext value — `pipeline_config`
  rows are fetched by `key` column alone) for whatever
  `fetchPipelineConfigPresence()` returns. This means the entire existing
  render pipeline (`renderSecretInput()`, `MASKED_SENTINEL` masking) needed
  **zero changes** to treat an org-admin-set key identically to a desktop
  vault entry.
- **Category scope**: `ai` (`OPENROUTER_API_KEY`/`GROQ_API_KEY`/`OLLAMA_*`)
  is excluded from the cloud-admin render — it's per-operator tier (P3),
  already Workstream 3's dashboard tab's job, and not a `pipeline_config`
  key at all. A new `VISIBLE_SETTINGS_CATEGORIES` const in
  `settings-main.ts` (desktop keeps all 5; non-desktop filters to 4)
  replaces every direct `SETTINGS_CATEGORIES` reference in that file — the
  Workstream 6 checklist's own "full 5-category form" wording was wrong as
  literally written; corrected in the checklist itself.
- **Known nuance, deliberately not fixed:** `isFeatureAvailable()` already
  returns `true` unconditionally for any non-desktop runtime — a
  pre-existing assumption from when this render path had no real user
  (this repo's public dashboard, not an admin panel). That means a
  category's sidebar dot / overview progress ring in the cloud-admin view
  reads "Ready" even before an admin has actually saved a key, though each
  individual secret row's own status (Missing/Staged/masked-present) is
  accurate. Not fixed here: `isFeatureAvailable()` is called from many
  places across the live public dashboard, not just this panel, and making
  it admin-panel-aware risks a much broader behavior change than this
  workstream's scope calls for.
- **Docs corrected in place, not just the checklist:** P5's decision text,
  the component-map's admin-panel row, and this session's own Status/log
  entries — all previously described the GCP-colocated design that was
  never actually built. `deploy/orgs/README.md`'s new-org runbook gained
  step 6a (configure native GitHub OAuth on the org's Supabase project —
  the admin panel's sign-in silently fails without it).
- **Verification:** `tsc --noEmit` and `biome check` both clean on every
  touched file. Unit tests for `admin-org-connection.ts`'s connection
  storage round-trip and `commitPipelineConfigValue()`'s upsert/delete
  branching (fake-client, no network); a source-grep regression test for
  `settings-main.ts`'s gate sequence and category filter, matching this
  repo's own established convention for inline-HTML-string settings
  content (`tests/llm-key-settings.test.mjs`'s own header explains why:
  no jsdom is wired into `node:test` here). **Cannot be verified
  end-to-end from this environment** — needs a real org's Supabase project
  with native GitHub OAuth actually configured, and the `mosiq` test
  tenant doesn't have that set up yet. Stating that plainly rather than
  claiming live verification.

### Session 58 — 2026-09-05

**Workstream 5 shipped** (minus P14 Phase 2, deliberately deferred — see its
own checklist entry). Two Explore passes first confirmed every implementation
detail against the live codebase (exact file paths, existing patterns to
mirror, exact loop structures) before any code was written — see the
checklist above for the file-by-file detail; this entry covers what a
straight read of the checklist wouldn't.

- **`deploy/orgs/<org>.yml` + generator + hydration loop are pure config /
  fail-soft code — fully unit tested with zero live infra.** All three ran
  green locally: `scripts/generate-nitric-org-stack.mjs` (5 tests, one of
  them a real run against the `mosiq` fixture, not just a mock), `server/
  _shared/pipeline-config-hydration.ts` (7 tests, vitest — mocks
  `getSupabaseAdmin()` the same way `followed-countries.test.ts` already
  does). The hydration loop's initial call is **awaited**, not
  fire-and-forget, before either `gcp/api/main.ts` registers routes or
  `gcp/scheduler/main.ts` registers schedules — a fresh Cloud Run cold start
  should never serve its first request/tick with unhydrated (missing)
  data-source keys, and top-level `await` typechecks fine under this repo's
  `ES2020`/`ESNext` module target (verified, not assumed).
- **`supabase/config.toml` turned out unnecessary** — a real finding from
  reading `PROVISIONING.md`'s own command sequence: every step uses `supabase
  link --project-ref` or an explicit `--no-verify-jwt` flag, never anything a
  config.toml would supply. `deploy-org.yml` was written without one.
- **P14 Phase 1's queue-worker merge needed one real code change, not just
  orchestration.** `scenario-worker.mjs` had NO `{ once }` support at all
  (unlike its two siblings) — its `while (!shuttingDown)` loop only exits on
  SIGTERM. Extracted the loop body into `runOneIteration()` (every internal
  `continue` became a `return` — behaviourally identical, since both end the
  current iteration), then `runWorker({ once: true })` does exactly one call
  and returns. `scripts/queue-worker.mjs` (new) imports this plus
  `runSimulationWorker`/`runDeepForecastWorker` **directly from
  `seed-forecasts.mjs`**, deliberately bypassing the `process-simulation-
  tasks.mjs`/`process-deep-forecast-tasks.mjs` wrapper scripts — both execute
  their worker at module top level and `process.exit(1)` on error, which
  would kill the merged process before the other two workers ever ran
  (confirmed by reading them, not assumed). Verified import-safe by actually
  importing the merged module in a scratch Node process before writing any
  test — no live network calls fired, confirming `seed-forecasts.mjs`'s
  `_isDirectRun` gating holds. 3 tests for the `{once}` behavior (mocking
  Upstash REST via `fetch`, both the POST-body-array shape `redisCmd` uses
  and the plain-GET shape `redisGet` uses — these are different HTTP shapes
  and a mock only handling one silently drops the other's assertions), 4 for
  `queue-worker.mjs`'s exit-code contract (via an injectable worker-list
  param on `run()` — same pattern as the hydration loop's injectable `env`).
- **`gcp/scheduler/main.ts` gets 4 new hand-written registrations, explicitly
  NOT derived from `scripts/railway-services.json`'s existing nixpacks-driven
  loop.** Confirmed live (via `nitric-deploy.yml`'s own header + a `git
  stash` diff test) that Railway is still the actual live production deploy
  for the pre-pivot single-tenant fork, and that file is Railway's real
  config source — so every change in this session that touches scheduling
  is additive, never a rewrite of what Railway itself does. `nitric.yaml`'s
  dev `services:`/`runtimes:` blocks lost 5 now-redundant pinned entries
  (kept `ais-relay.cjs`); verified programmatically that every remaining
  `services:` entry still has a matching `runtimes:` block and no orphans
  exist either way.
- **Found and deliberately did NOT touch:** 3 Dockerfiles
  (`Dockerfile.process-simulation-tasks`/`.process-deep-forecast-tasks`/
  `.scenario-worker`) are now unreferenced by `nitric.yaml` and have no
  `railway-services.json` entry — created specifically for the old
  always-on-nitric-service pattern P14 retires. Read all three fully; each
  is self-contained (no shared base image, no other consumer). Left on disk
  rather than deleted — this session could not confirm whether Railway's
  dashboard points at them independently of the JSON registry, and deleting
  a Dockerfile that turned out to be live would be a real production
  incident for zero benefit. `tests/railway-services-registry-coverage.
  test.mts` already fails on exactly this Dockerfile/registry gap —
  confirmed via `git stash` to fail identically with none of this session's
  changes applied, so it's pre-existing, not introduced here.
- **P14 Phase 2 (shared AIS ingest deploy target) explicitly NOT built.**
  The architecture doc's own phasing puts the WebSocket-core extraction from
  `scripts/ais-relay.cjs` in Phase 2 (overlaps Workstream 7) — there is no
  standalone AIS-ingest artifact yet for a `deploy-ais-shared.yml`/`nitric.
  ais-shared.yaml` to deploy, so writing that workflow now would be
  scaffolding with nothing real behind it. `deploy/orgs/README.md`'s new-org
  runbook step 7 documents this directly (an earlier draft of that step
  pointed at a workflow file that doesn't exist yet — caught and fixed
  before finishing, not left as a dangling reference).
- Green: `tsc --noEmit -p tsconfig.gcp.json` 0 · `npm run typecheck:api` 0 ·
  `biome check` 0 on every touched/new file · 23 new tests across 5
  files, all passing (`tests/generate-nitric-org-stack.test.mjs` 5,
  `server/__tests__/pipeline-config-hydration.test.ts` 7,
  `tests/scenario-worker-once.test.mjs` 3, `tests/queue-worker.test.mjs` 4,
  plus `nitric.yaml`'s services/runtimes consistency checked by a one-off
  script, not a committed test).
- **Not done here:** nothing pushed (`main` still 8 ahead of `origin/main` at
  session start, now more — operator's call, unchanged policy). No real
  second org exists to actually run `deploy-org.yml` against — everything
  above is verified as far as this environment allows (unit tests, `tsc`,
  YAML parsing, `git stash` diffs) but the workflow itself has never
  executed in GitHub Actions.

### Session 57 — 2026-09-04

**Workstream 4 shipped** — the mirror's allowlist→denylist inversion (P6).

- `scripts/shared/sync-domains.mjs` rewritten: `SYNC_PREFIXES` (the ~55-entry
  allowlist) **removed**; new `classifyKey(key) → 'deny' | 'mirror' |
  'mirror-filtered'`, default-allow. `isMirroredKey()` is now
  `classifyKey(key) === 'mirror'` — a thin wrapper, so the four push-path
  consumers (`_seed-utils.mjs` `notifyChange`/`notifyMirroredWrites`,
  `sync-notify.ts` `notifyKeyChanged`/`notifyPipelineWrites`,
  `sync-listener.mjs` `applyChange`) need **zero logic change**. `.d.mts`
  updated (`classifyKey` + `KeyMirrorClass`, drop `SYNC_PREFIXES`).
- `local-sync.mjs` full-rescan: was N scoped `SCAN MATCH <prefix>*` passes,
  now ONE `SCAN MATCH *` over the whole keyspace → drop `deny` → existing
  `keepKey()` per-key (that IS the `mirror-filtered` behaviour — it scopes
  `brief:` to this operator). Read+write now batched (`SYNC_WRITE_BATCH =
  1000`) so a full-keyspace scan doesn't hold one multi-second SQLite write
  transaction (which blocks the sidecar's read-only opener). At 6h cadence +
  per-org DBs, scanning past `story:` (~69% of keys) is an accepted cost.
- **Three states, and why the split is load-bearing:** `brief:llm:*` (shared
  LLM output) → `mirror`, pushed to everyone; every other `brief:` key →
  `mirror-filtered`, reaches a mirror ONLY via rescan+`keepKey()`, never via
  the global `sync:notify` channel (no per-recipient filtering — the
  session-39 leak). `api/latest-brief.js` still reads the operator's own
  brief through the mirror — a blanket `brief:` deny would have been a
  regression, as P6 warned.
- **Denylist contents:** P6's shape patterns (`*:token`, `*:secret`,
  `*:oauth:*`, `*:cursor`, `session:`, `idempotency:`, `ratelimit:`,
  `lock:`) + the whole documented "DELIBERATELY EXCLUDED" block (`story:`,
  `wm:`, `cache:`, `digest:`, `baseline:`, `seed-{meta,routes,activated,lock,
  webcams}:`, `health:`, `relay:`, `cf:`, `shared:`, `ci-sebuf:`,
  `*smoke-test:`, `temporal:`, `preview:`, `acled:`) + `forecast:simulation-task`
  carried verbatim from `MIRROR_EXCLUDED_PREFIXES`.
- **Two prefixes the P6 table missed, found by auditing the live key
  surface** — this is the value of the inversion forcing a real audit:
  - `sync:` — `sync:changelog` is a real Redis stream key SCAN returns.
    Default-allow would mirror the sync changelog into every operator's
    cache.
  - `rl:` — the ACTUAL `@upstash/ratelimit` prefix (`rl:`, `rl:ep`,
    `rl:scope`, `rl:apikey:*`). P6's table guessed `ratelimit:` / `rate:`,
    neither of which the code emits. Kept all three.
- **`news:` stays mirrored.** The two files disagreed in comments —
  `sync-domains.mjs`'s allowlist had `news:`, `local-sync.mjs`'s header said
  it was excluded. The allowlist's actual behaviour won; the denylist
  preserves it (not denied).
- Green: `tsc` 0 · `typecheck:api` 0 · `biome` 0 · `sync-domains` +
  `sync-listener` + `seed-utils-notify` suites **62/62** · `test:sidecar`
  **238 / 237 pass** (the sole failure is still the pre-existing EADDRINUSE
  test). `test:data`'s fail-count moves within its own noise band (88↔94, 36
  cancelled at `--test-concurrency=16`); the one diffing name
  (`readBootstrapTierObject`, unrelated R2 domain) passes run in isolation.
- **Not done in W4:** the pre-existing `noConstAssign` lint error at
  `seed-digest-notifications.mjs:2223` — still untaken, still out of scope.

**Then OQ-P6 resolved (doc-only)** — operator chose option (c). New decision
**P14**: zero pinned instances per org. The investigation that led there is in
the OQ-P6 resolved entry and P14; the short version is that "6 long-running
services" was a Railway-model artifact — the real persistent surface of the
whole platform is one WebSocket (`ais-relay.cjs:11561` to aisstream.io), and
that file also carries 28 `startBootSeedLoop` timer loops that belong in the
scheduler. AIS ingest becomes one shared cross-org service (public data);
digest / bootstrap-tiers / the 3 forecast-scenario queue consumers (merged)
all become `min-instances: 0` scheduled jobs. Phased: Phase 1 ships the easy
moves with W5 and keeps `ais-relay.cjs` pinned per-org as a stopgap; Phase 2
(overlaps W7) decomposes it. Workstreams 5 and 7 updated with the concrete
steps. **No code — doc only.**

**Then Workstream 2 shipped** — `github-identity-bridge` vendored from platform
@ `bafbfb15`.

- `supabase/functions/github-identity-bridge/{index.ts, register-provider.ts,
  deno.json}` + `supabase/migrations/20260904130000_github_identity_bridge.sql`.
  Function + SQL bodies verified **byte-for-byte** against upstream (`diff`);
  the only code deviation is one comment path in `index.ts` repointed from the
  platform schema file to the migration. Vendor headers on the two `.ts` files
  record the upstream SHA and the "re-copy, don't diverge" rule (P9).
- Upstream keeps the SQL as a *declarative-schema* file (`db diff` → migration);
  vendored here directly as a plain forward-only migration since WorldMonitor
  has no declarative setup (W1's precedent). `CREATE OR REPLACE` + REVOKE/GRANT
  make re-application idempotent.
- `.npmrc` from the upstream function dir deliberately NOT copied — empty
  comment-only private-registry placeholder, unused.
- New `PROVISIONING.md` beside the function — the per-org runbook W5 will turn
  into workflow steps: 5 function secrets (a `jose` RS256 keygen snippet for
  the JWK + `kid`; `openssl rand` for the other three), then `db push` →
  `secrets set` → `functions deploy --no-verify-jwt` → `deno run
  register-provider.ts`, plus the manual Redirect-URL allow-list step (URL
  pins when W3's login wiring lands) and a discovery/JWKS smoke check.
- **No local gate** — `tsconfig` covers only `src/`, `lint` doesn't include
  `supabase/`, no `deno` here. Unrun until W5, exactly like `local-config`.

**Then Workstream 7's `list-feed-digest` seeder shipped** — the one RPC in the
pipeline with no producer.

- `list-feed-digest.ts` lazily read-through-caches a ~190-feed RSS crawl under
  `news:digest:v1:<variant>:<lang>` (TTL 900s, written by its own
  `cachedFetchJson`). Cold/expired key → the first dashboard request eats the
  crawl and regional-news panels show "unavailable" until a background rebuild
  lands. Under P2 the operator backend does no fetching, so the key family
  needs a server-side producer + the mirror.
- **Not a re-implementation.** `scripts/` cannot import `server/`
  (`tests/nixpacks-seeder-import-graph.test.mjs` enforces it) and `buildDigest`
  isn't exported. `scripts/seed-news-digest.mjs` HTTP-pings the worker's own
  `/api/news/v1/list-feed-digest` per `(variant, lang)` — the same warm path
  `seed-insights.warmDigestCache` / `ais-relay` already use. The RPC does the
  build, `setCachedJson` writes the key **and** fires the fast-path mirror
  notify (`isMirroredKey('news:digest:v1:…')` → true), and stamps a fresh
  `generatedAt` (the panels' freshness signal — so no `seed-meta:` write).
- Config: env `NEWS_DIGEST_SEED_VARIANTS` (default `full`),
  `NEWS_DIGEST_SEED_LANGS` (default `en,zh` — the only langs any caller sends
  and the only two with a materially distinct feed set). `en` pings first so
  the `zh` run reuses the hour-cached `rss:feed:v8:*` per-feed entries.
- **Cadence `*/10 * * * *`** in `railway-services.json` + `gcp/scheduler/main.ts`
  `CADENCES`. This is a hard constraint, not a TTL inference: it MUST stay
  below the 900s (15min) `news:digest:v1` cache TTL or the key expires between
  runs and the cold-hole returns — which is exactly what today's
  `seed-insights` side-effect (30min cadence) suffers. `*/10` leaves a 5min
  margin.
- Exit code: 0 on any success (a partial failure self-heals next tick and must
  not wedge the cron), 1 only when every ping fails (a real outage worth
  surfacing to scheduler alerting).
- **`classifyKey('news:digest:v1:*')` was already `'mirror'`** — no Workstream
  4 change. Side keys `buildDigest` writes stay correctly classified:
  `story:*` + `digest:accumulator:*` denied (the 69% bloat), `news:coverage-
  ledger:v1:*` mirrored (tiny, harmless).
- **The sidecar startup warm-ping (`local-api-server.mjs` ~2546) is removed.**
  It was already inert whenever `WS_RELAY_URL` is unset — `/api/news/v1/` is
  `cloudPreferred` then and `isCloudPreferred()` short-circuited it — i.e. in
  exactly the configuration the pivot operator backend runs in. The digest now
  arrives over the mirror and the sidecar serves it from SQLite with no crawl.
- Green: new `tests/seed-news-digest.test.mjs` 10/10 · `biome` clean on all
  touched files (one pre-existing `noConstAssign`-adjacent `let` *info* at
  `local-api-server.mjs:1740`, untouched, unrelated) · `test:sidecar`
  `local-api-server.test.mjs` **53/54** (the one failure is still the
  pre-existing EADDRINUSE test) · the registry-coverage + scheduler-cadence +
  nixpacks-import-graph guardrails pass for `seed-news-digest` (2 failures in
  that run — `seed-research` import graph, `Dockerfile.* CMD` coverage —
  **pre-exist on a clean tree**, unrelated; this change in fact clears 2 other
  pre-existing failures by registering + scheduling the new seeder).
- **Not done here:** widening `NEWS_DIGEST_SEED_LANGS` per org (one env change),
  and whether `seed-insights` should drop its own `warmDigestCache` fallback
  now that the key is always warm (left as a harmless fallback).

**Then Workstream 3 Part A shipped** — the per-operator LLM-key backend.

- **Why "Part A":** the obvious path — reuse `settings-main.ts` / `runtime-config`
  — doesn't work. `setSecretValue()` is Tauri-desktop only (`isDesktopRuntime()`
  gate; it invokes keychain commands) and silently no-ops in the VS Code
  operator backend. So the write path is new. W1 had already laid the read
  side: `OPENROUTER_API_KEY` was in `CONFIG_KEYS`, `loadConfigIntoEnv()`
  hydrates `process.env` at startup, `llm.ts` reads `process.env` and returns
  `null` per-provider when unset — the OQ-P5 hard-disable is already the
  server default.
- `config-store.mjs`: `OPERATOR_LLM_CONFIG_KEYS` = the 4 keys; folded into
  `CONFIG_KEYS`; `GROQ_API_KEY` added to `SECRET_CONFIG_KEYS` (`OLLAMA_API_URL`
  / `OLLAMA_MODEL` are an endpoint + a model name, shown verbatim). This alone
  gives the CLI (`worldmonitor-local config set GROQ_API_KEY …`) + startup
  hydration.
- `local-api-server.mjs`: new **`GET/PUT /api/local-llm-config`**. GET →
  `{ keys: { <KEY>: {set} | {set, value} }, anyProviderConfigured }`
  (`anyProviderConfigured` mirrors `getProviderCredentials()`: OpenRouter key
  OR Groq key OR Ollama URL). PUT → for each provided key: non-empty
  `setConfig()` + `process.env[key] = value`; empty → `deleteConfig()` +
  `delete process.env[key]`; unknown key → 403. Busts
  `moduleCache`/`failedImports`/`cloudPreferred` so handlers re-read env with
  **no restart** (none are `RESTART_REQUIRED_CONFIG_KEYS`). The key contrast
  with the pre-existing `/api/local-env-update` (orphaned — no client calls it,
  a `src-tauri` leftover) is **persistence**: that route is `process.env`-only
  and dies on the launchd/scheduled restart the operator backend runs under;
  this one writes `config.db`.
- Added to the traffic-log `skipRecord` list (config chatter, like its
  siblings).
- Green: 5 new tests in `local-api-server.test.mjs` (empty store →
  `anyProviderConfigured:false`; PUT persists + trims + masks the secret in the
  response + mirrors to `process.env` + durable in a re-read `config.db`; empty
  value clears; non-LLM key → 403; Ollama-URL-alone flips
  `anyProviderConfigured`). `config-store.test.mjs` 30/30 ·
  `worldmonitor-local.test.mjs` 7/7 · `test:sidecar` `local-api-server` 75/76
  (the one failure is still the pre-existing EADDRINUSE test) · `biome` clean
  on touched files (the one pre-existing `let contentType` info at
  `local-api-server.mjs:1747` is untouched, unrelated).
- **Parts B + C are frontend** (`src/` dashboard modal + the chat/summarize
  gating) — a separate pass.

**Then Workstream 3 Parts B + C shipped, in the same session** — the
dashboard-facing half of the LLM-key work.

- **Part B landed as a tab, not a new modal.** The dashboard already has a
  chrome-level settings surface — `UnifiedSettings` (gear icon / the
  `view:settings` command → `unifiedSettings.open()`), tabbed
  (`settings`/`panels`/`sources`/optionally `notifications`). Rather than
  build a parallel modal, added a 5th tab `ai`, gated `isVsCodeEmbedRuntime()`
  — **not** `isSidecarBackedRuntime()`, which also covers Tauri, where
  `settings-main.ts` already owns AI config via the (working, for Tauri) keychain
  path. `src/services/llm-key-settings.ts` mirrors
  `renderNotificationsSettings`'s `{html, attach(container) => cleanup}`
  content-module shape (the established pattern for tab content in this
  component) rather than inventing a new one.
- **Secrets never round-trip — by construction, not by policy.** The GET
  response's `{set: boolean}` for the two API-key fields has no `value` field
  at all (Part A's design), so there's nothing to prefill even if the modal
  wanted to. A field a user never touches submits nothing on save; the only
  way to unset a key is the field's own **Clear** button, which is the sole
  writer of an explicit `mode:'clear'`. A keystroke always means "set to a new
  value" — never "clear," so an accidental click-into-then-tab-away on an
  empty input cannot silently drop a live key. Save sends only the dirty
  subset as a partial PUT.
- **Part C's real finding: the server side of OQ-P5 was already done.**
  `getProviderCredentials()` (S57 Part A discovery) returning `null` per
  provider already makes the chat SSE path emit a clean
  `{error:'llm_unavailable'}` (`server/_shared/llm.ts`) and summarize fall
  through to the browser-T5 client fallback (`summarize-gate.ts`'s own header
  documents this). What was missing was **visibility, not degradation**:
  `LlmStatusIndicator` (the `/api/llm-health` red/green dot) already existed
  and already worked against the sidecar's own health endpoint — but
  `setupLlmStatusIndicator()` gated its mount to `isDesktopRuntime()` only, a
  guard that predates the VS Code embed as a second sidecar-backed runtime and
  silently excluded exactly the audience OQ-P5 is for. Widened to
  `isDesktopRuntime() || isVsCodeEmbedRuntime()`.
- Two small, targeted improvements riding along, both scoped to not touching
  the majority (cloud/Tauri) path: the tooltip now says **"No LLM provider
  configured"** rather than **"LLM offline"** when zero providers are set
  (`data.providers.length === 0`) — different problem, different fix, and the
  prior copy conflated them. And, embed-only, the indicator is now **clickable
  → `unifiedSettings.open('ai')`**; Tauri's indicator is unchanged
  (non-interactive, as before `onClick` was optional). A `wm:llm-config-changed`
  event (dispatched by the settings tab on a successful save) makes the
  indicator re-poll immediately instead of showing a stale red dot for up to
  the 60s interval.
- **Deliberately not attempted:** a sweep to hide/disable every individual
  chat/summarize button across the app. Searched for an existing app-wide "AI
  available" gate to hook — there isn't one; every panel independently calls
  its RPC and handles the response. Building that chokepoint is a real,
  separate-sized piece of work, not a corner cut here. The settings tab +
  status indicator are the honest, discoverable surface for this pass.
- Green: **19 new tests** in `tests/llm-key-settings.test.mjs` (source-grep
  style, matching this repo's own convention for inline-HTML settings content
  — no jsdom/vitest wired into `node:test` here, confirmed against
  `tests/notifications-settings-ui-invariants.test.mjs`'s own header before
  choosing the approach). `tsc --noEmit` 0 · `node scripts/lint-boundaries.mjs`
  clean · `biome` clean on every touched file.

**Then OQ-P7 resolved and P13 reviewed (doc-only)** — the two blockers on
Workstream 5.

- **OQ-P7 → `pipeline_config` wins, 5-minute worker hydration.** Rationale and
  the user-visible contract are recorded in the resolved-sub-questions entry
  and the Workstream 5 checklist above. No code — the hydration loop itself is
  W5 implementation work, now unblocked to start.
- **P13 → accepted as designed** (ban/delete the Supabase user, checked by
  `local-config` on every call). One review note added: revocation is
  per-org-project, so an operator moved between orgs needs banning in the OLD
  project, not just adding to the new one — flagged for the admin runbook.
- **No open sub-questions remain.** Workstream 5 has no operator-gated
  blocker left.

**Then a real tenant org was provisioned by hand for the first time ever** —
the validation Workstreams 1 and 2 had been waiting on since S56.

- **Project `mosiq`** (ref `lntyjouahofgewtkmpyi`, org "kc electronic industrial
  inc", region us-west-1) created as a standalone test tenant, separate from
  the current single-tenant fork's live project (`BIOVITA_BOTANICS`, untouched).
- **W1's `pipeline_config` migration and W2's `github_identity_bridge`
  migration both applied successfully** — the first time either has run
  against a real Supabase project rather than a throwaway container.
- **P15 found and fixed during this pass**: both migrations had put their
  objects in `public` with no explicit schema decision ever recorded,
  diverging from the convention the pre-pivot single-tenant fork already uses
  (a dedicated `worldmonitor` schema — see decisions table). Corrected in the
  repo's migration files (this session, before Workstream 5 or any real org
  could depend on the wrong schema) and re-validated end-to-end against
  `mosiq`: `worldmonitor.pipeline_config` and `worldmonitor.link_bridge_
  identity_if_needed()` exist with correct grants (`information_schema.
  routine_privileges` shows only `service_role` + owner on the function, as
  the migration's own verification query says it should); `public` is
  confirmed clean (`PGRST205` on a REST probe — nothing left there).
  **Schema exposure turned out to be scriptable**, contrary to what the
  original provisioning notes assumed (dashboard/Management-API only) —
  `alter role authenticator set pgrst.db_schemas = 'public, worldmonitor';
  notify pgrst, 'reload schema';` works from plain SQL, confirmed live. Folded
  into `pipeline_config`'s migration so Workstream 5 needs zero extra
  provisioning step for it.
- **Both edge functions deployed and proven live**:
  - `local-config` — `ACTIVE`, `verify_jwt: true`. Unauthenticated/malformed
    calls correctly rejected by Supabase's OWN platform-level gateway before
    function code even runs (`UNAUTHORIZED_NO_AUTH_HEADER` /
    `UNAUTHORIZED_INVALID_JWT_FORMAT`) — confirms `verify_jwt: true` deploys
    as designed.
  - `github-identity-bridge` — `ACTIVE`, `verify_jwt: false`. Discovery
    (`/.well-known/openid-configuration`) and `/jwks` both return correct,
    live 200s; the `jwks` response's `kid` matches the freshly-generated
    `OIDC_SIGNING_KID` exactly, proving the 5 function secrets (RS256 keypair
    via the PROVISIONING.md `jose` step, 3 `openssl rand` values, set via the
    already-authenticated local `supabase` CLI) are wired correctly end to end.
- **Still not exercised** (needs things outside any tool available this
  session): `register-provider.ts` (needs `deno`, not installed locally); a
  real GitHub OAuth token for a full `/tickets` → `/authorize` → `/token`
  round trip; `local-config`'s 3 secrets (`WM_UPSTASH_REST_URL`,
  `WM_UPSTASH_READONLY_TOKEN`, `WM_APP_DOMAIN`) need a real Upstash test DB,
  which no Supabase MCP tool can create. These remain the concrete next steps
  if the manual-provisioning validation continues.
- **`mosiq` is intentionally left live** as the reusable test tenant for that
  continuation — not torn down.

### Session 56 — 2026-09-04

Architecture review against the codebase, before any implementation. **Verdict:
the architecture holds.** Eight findings, folded into the sections above rather
than listed here. Still doc-only — no code touched.

Blocking (would have failed during implementation):

1. **Workstream R's revert list was self-contradictory.** `f1a90be` *created*
   `beginGithubLogin()`; reverting it deletes `local-login.mjs`. Boundary
   corrected to 3 commits (`ed3c281`, `e30f1cd`, `6ba93d2`); `f1a90be` stays.
2. **"Drop `settings.html` from the operator bundle" had no seam.** No operator
   Vite build exists (one unconditional 2-entry rollup input); the bundle does
   `copyDir('dist')` wholesale. Retargeted to a post-copy prune.
3. **P8 vs. OQ-P1** — persistent sockets cannot scale to zero. Re-opened as
   **OQ-P6**; `nitric.gcp.yaml` already had the TODO.

Corrections:

4. **P6's denylist was materially incomplete** — the documented "DELIBERATELY
   EXCLUDED" block (`story:` ~18.4k keys, `wm:`, `cache:`, `digest:`,
   `baseline:`, `seed-*:`, infra prefixes, and the live `forecast:simulation-task*`
   queue) matched none of the S55 shape patterns. And blanket-denying `brief:*`
   is a **regression** — `keepKey()` deliberately mirrors the operator's own
   brief. P6 now has three states.
5. **Workstream 7's S55 pointer was wrong** (line ~2718 is an SSRF allowlist);
   the real worklist is `cloudPreferredPrefixes` at ~769. Surface quantified: 22
   handlers + 9 shared modules of 276. `list-feed-digest` promoted to its own
   item — it has no seeder at all.
6. **Workstream 1 — `config-store.mjs` repurposes cleanly, no entanglement.**
   Two gaps: no TTL notion, and `.env`-wins precedence would let a stale
   v2.12/2.13 `.env` shadow the broker's token forever, defeating revocation.
7. **Workstream 2 path fix** — `fn_link_bridge_identity_if_needed.sql` is under
   `platform/tools/supabase/schemas/public/`, and `deno.json` was missed.
8. **Workstream 5** — nothing feeds `nitric.<org>.yaml` from `deploy/orgs/<org>.yml`
   (every org would land in `apps-453107`), and the key-home conflict became
   **OQ-P7**.

Workstream ordering confirmed, with one addition: start Workstream 7's
`list-feed-digest` seeder early — it is unblocked today and is 7's longest pole.
Recommended: **R → 1 → 4 → (2 ∥ 7-seeder) → 5 → 3 → 6 → rest of 7.**

**Then Workstream R shipped (`d39344f`)** — the pivot's first code.

- Reverted `ed3c281` + `e30f1cd` + `6ba93d2`, all cleanly (`local-api-server.mjs`
  auto-merged around `3897f7c`). `f1a90be` deliberately left in place.
- Both stale "shared by two callers" comments on `beginGithubLogin()` updated,
  and the reason the module stays factored out recorded in its header, so
  Workstream 1 re-adds a caller rather than re-extracting the flow.
- `settings.html` pruned from the operator bundle as a post-copy step.
  **The prune resolves its targets by a fixpoint over the real chunk graph.**
  An HTML-level subtraction — the obvious implementation — was measured wrong on
  this `dist/`: it classified `ollama-models-*.js` (dynamically imported by the
  dashboard entry `main-*.js` and by `panels-risk-*.js`) and
  `settings-persistence-*.js` as settings-exclusive, because a built HTML lists
  only *static* imports. Pruning either ships a dashboard that 404s on a dynamic
  import at runtime in an operator's webview, with nothing failing at build time.
  The fixpoint narrows 4 candidates to the correct 2.
- `dist/sw.js`'s Workbox precache manifest is rewritten to match — required, not
  tidiness: `precacheAndRoute()` fails the whole SW install on any 404, silently.
  The rewrite throws if an expected entry is missing, so a manifest shape change
  is a loud build failure.
- Green: `tsc` 0 · `typecheck:api` 0 · `biome` (changed files) 0 · `test:sidecar`
  **219 tests / 218 pass** (226 − the 7 dropped, exactly as predicted).
- **One pre-existing failure, NOT from this work:** `service-status reports bound
  fallback port after EADDRINUSE recovery` fails identically at HEAD with these
  changes stashed. The port-fallback code itself is intact. Untriaged.
**Then Workstream 1 shipped (`f09915f`)** — the config broker, +19 tests.

- New `supabase/` tree (the repo had none): `functions/local-config/` and
  `migrations/20260904120000_pipeline_config.sql`.
- **P13 was decided here**, because implementing P4 exposed that revocation had
  no mechanism at all. See the decisions table — it needs your review.
- **Failure policy is the core of the client design.** 401/403 drops the cache;
  network/5xx/timeout KEEPS it and retries. A Supabase outage must not wipe
  every operator's mirror simultaneously — stale-but-authorised beats empty. A
  200 missing a field counts as unavailable for the same reason: a broken
  deploy must not be able to blank a working cache.
- The TTL went in a separate `meta` table, not the reserved `config` row the
  review suggested: `readAllConfig()`/`loadConfigIntoEnv()` iterate `config`
  wholesale and treat every row as an env var, so a magic row would need
  filtering at each of those sites and every future one, and one missed filter
  would export it into the process environment.
- A refresh changing `UPSTASH_REDIS_REST_URL`/`APP_DOMAIN` warns to restart
  (captured at module load for the allowlists); a token rotation does not
  (`redis.ts` reads it per call). No auto-restart — that is the control-plane
  machinery R just removed.
- Two existing session-refresh tests were adjusted, not weakened: their fake
  Supabase answers every path, so a startup broker call counted as a GoTrue
  hit. Scoped to `/auth/` so they assert what their own messages claim.
- **The migration was actually executed**, in a throwaway postgres container
  (removed after): applied, re-applied twice for idempotency, `wm_is_admin()`
  checked across five JWT shapes — a garbage value returns false rather than
  raising, which is why it compares text instead of casting to boolean — and
  RLS proven to block a non-admin's select and insert while admitting an admin.
- That exercise produced one real change: **`pipeline_config_worker_read`**.
  Supabase's `service_role` has `BYPASSRLS`, so it is redundant today; without
  it, if that attribute ever changed, the worker would read **zero keys** and
  the pipeline would run unauthenticated against every data source, silently.
  Proven to hold with `bypassrls` removed.
- Green: `tsc` 0 · `typecheck:api` 0 · `biome` 0 · `test:sidecar` **238 / 237
  pass**; the sole failure is still the pre-existing EADDRINUSE test.
- **Coverage gap to close in Workstream 5:** the edge function has no local
  gate whatsoever — `tsconfig.json` includes only `src/`, and `deno` is not
  installed here. It is unrun.

- **Second pre-existing finding, untouched:** `npm run lint` reports one *error* —
  `scripts/seed-digest-notifications.mjs:2223` `lint/correctness/noConstAssign`.
  ESM is strict mode, so that assignment throws `TypeError` at runtime if the
  line is reached. In a production seeder. Last touched in `5b746bc`; left alone
  as out of scope for R, but worth its own fix.

### Session 55 — 2026-09-04

- Architecture pivot agreed across a long design conversation. The Local App Initiative's "every operator self-configures a local backend" model is replaced by a multi-tenant platform: repo devs operate isolated per-org instances (Supabase + Upstash + GCP), org admins manage their org's data-source keys via a cloud admin panel, operators run a thin read-only mirror + one LLM key.
- Decisions P1–P12 locked. Workstreams R + 1–7 defined. `v2.13.0` moved from "D12 gate" to "hold pending config-model change" (P12).
- `github-identity-bridge` decoupling resolved → **P9** (vendor a copy; platform stays upstream; revisit only on churn).
- **All five OQ-P sub-questions resolved** (see "Resolved sub-questions"): OQ-P1 Cloud Run · OQ-P2 Supabase-CLI-scripted in `deploy-org.yml` (repo has no CLI migration setup today — only `consumer-prices-core`'s plain-`pg` numbered-SQL runner precedent) · OQ-P3 `app_metadata.wm_admin` · OQ-P4 no `settings.html` in the operator bundle, LLM modal moves into `dashboard.html` · OQ-P5 no key → hard-disable chat/summarize.
- This file created as the new single source of truth; `LOCAL_APP_INITIATIVE.md` demoted to the operator-client sub-track.
- **Nothing implemented.** Doc-only session.
