# `deploy/orgs/<org>.yml` — per-org, non-secret deploy config

One file per tenant org (P10). Everything **secret** (GCP service-account
creds, Supabase access token + DB password, Upstash write URL+token) lives in
that org's GitHub Environment, never here — this file is safe to commit and
diff in PRs.

## Schema

```yaml
org: <org-slug>              # short, lowercase, matches the GH Environment name
                              # and the generated nitric.<org>.yaml suffix
domain: <org's app domain>    # e.g. dashboard.nike-intel.example.com — becomes
                              # APP_DOMAIN at build/runtime; local-config's
                              # broker response also returns this value (P4)
supabase:
  projectRef: <ref>          # the org's Supabase project ref (from its dashboard
                              # URL / `supabase projects list`) — passed to
                              # `supabase link --project-ref` in deploy-org.yml
gcp:
  projectId: <gcp-project-id> # the org's own GCP project (P1: isolated per org)
  region: us-central1          # Cloud Run region — matches the data vendors'
                                # own US hosting unless an org has a reason to
                                # deviate (e.g. data residency)
variant: full                 # selects VITE_VARIANT at build time (see
                                # vite.config.ts's htmlVariantPlugin /
                                # src/config/variant-meta.ts's VARIANT_META_STATIC)
                                # — the branded-skin system already used for the
                                # single-tenant product family. Most orgs want
                                # `full`; a white-labeled org could pick/add
                                # another entry in variant-meta.ts.
```

## Consumers

| Field | Read by |
|---|---|
| `org` | `scripts/generate-nitric-org-stack.mjs` (output filename), `.github/workflows/deploy-org.yml` (stack-name input, GH Environment selection) |
| `domain` | build (`APP_DOMAIN` → `VITE_APP_DOMAIN`/`variant-meta.ts`), `local-config` edge function's `appDomain` response field |
| `supabase.projectRef` | `deploy-org.yml`'s `supabase link --project-ref` step |
| `gcp.projectId`, `gcp.region` | `scripts/generate-nitric-org-stack.mjs` → the generated `nitric.<org>.yaml`'s top-level `gcp-project-id`/`region` |
| `variant` | build step's `VITE_VARIANT` env var |

## New-org runbook

Provisioning a real org needs some manual, one-time steps outside this repo
(none of these are scripted — deliberately: they're rare, and each involves
an external console this repo has no API credentials for beyond what a single
GH Environment already scopes):

1. Create the org's Supabase project, Upstash database, and GCP project by
   hand (or via each provider's own CLI/console).
1a. **Deploy `github-identity-bridge` to the new project — BEFORE any app**
   (P9 superseded 2026-09-07). The bridge is owned by the pinned
   `powerpro-led/org-provisioning` repo (tag `v0.1.0`). `deploy-org.yml`'s
   **Provision github-identity-bridge** step checks it out and runs
   `./deploy.sh <project-ref>` for you (idempotent), so for a `worldmonitor`
   org this happens automatically inside step 4. Run it by hand here only for
   a **`platform`-only org** (no `worldmonitor` deploy) or to provision the
   bridge ahead of the first `deploy-org.yml` run:
   `SUPABASE_ACCESS_TOKEN=… SUPABASE_DB_URL=<direct> SUPABASE_SERVICE_ROLE_KEY=…
   OIDC_SIGNING_PRIVATE_KEY_JWK=… OIDC_SIGNING_KID=… TICKET_SIGNING_SECRET=…
   BRIDGE_CLIENT_ID=… BRIDGE_CLIENT_SECRET=… ./deploy.sh <project-ref>`
   (from an `org-provisioning` checkout at `v0.1.0`; needs `supabase` + `psql`
   + `deno` + Docker). Applies the SQL companion, sets the secrets, deploys the
   function `--no-verify-jwt`, registers the `custom:github-bridge` OIDC
   provider. See `org-provisioning/README.md`.
2. Create a GH Environment named `<org>` in this repo. See
   `.github/workflows/deploy-org.yml`'s own header for the authoritative,
   exact list of secrets/vars it reads — summarized here:
   - GCP: `GCP_CREDENTIALS` (service-account JSON scoped to the new project).
   - Deploy tooling: `PULUMI_ACCESS_TOKEN`.
   - Supabase CLI: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`,
     `SUPABASE_DB_URL` (the org's **direct/non-pooled** Postgres URL —
     `org-provisioning/deploy.sh` applies DDL over it),
     `vars.SUPABASE_PROJECT_REF` (also mirrors `supabase.projectRef` above —
     kept in both places since the workflow needs it as a `vars`/`secrets`
     context value, not just readable from a checked-out file).
   - Supabase API (this deploy's own worker + `pipeline-config-hydration.ts`):
     `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `VITE_SUPABASE_URL`,
     `VITE_SUPABASE_PUBLISHABLE_KEY`.
   - This org's own Upstash DB (the worker's write side):
     `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.
   - `local-config`'s 3 broker secrets (P4): `WM_UPSTASH_REST_URL`,
     `WM_UPSTASH_READONLY_TOKEN`, `WM_APP_DOMAIN`.
   - `github-identity-bridge`'s 5 function secrets
     (`OIDC_SIGNING_PRIVATE_KEY_JWK`, `OIDC_SIGNING_KID`,
     `TICKET_SIGNING_SECRET`, `BRIDGE_CLIENT_ID`, `BRIDGE_CLIENT_SECRET`) —
     still stored in this Environment, but **consumed by
     `../org-provisioning/deploy.sh`, not this workflow** (P9 superseded
     2026-09-07 — the bridge is per-org infra owned by `org-provisioning`).
     Generate ONCE via `org-provisioning/README.md`'s keypair step; never
     regenerate (rotates the OIDC signing key → logs out every operator).
   - This deploy's own session secret: `WM_SESSION_SECRET`.
   - The shared **"AIS results" Upstash**, read-only (P17 — the SAME value
     for every org): `AIS_RESULTS_UPSTASH_REST_URL`,
     `AIS_RESULTS_UPSTASH_READONLY_TOKEN`. `scripts/sync-ais-results.mjs`
     pulls the shared AIS-ingest deploy's output into this org's DB.
   - This org's **own Telegram** MTProto app + session (P18 — per org, not
     shared): `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`.
     See step 7.
   - Build-time vars (non-secret): `vars.APP_DOMAIN`, `vars.VITE_VARIANT`,
     `vars.WS_RELAY_URL` (the shared AIS-ingest deploy's URL —
     `deploy/shared/ais-ingest.yml`'s `domain`).
   - **Deliberately absent**: none of the ~26 data-source keys (ACLED, FRED,
     Finnhub, …) — those are set live, per org, via the Workstream 6 admin
     panel, into `pipeline_config`, never into this Environment.
   - **Repo- or org-level secret (not per-Environment):**
     `ORG_PROVISIONING_TOKEN` — a token with read access to the private
     `powerpro-led/org-provisioning` repo, for the checkout of tag `v0.1.0`.
3. Add `deploy/orgs/<org>.yml` (this schema) in a PR.
4. Run `.github/workflows/deploy-org.yml` via `workflow_dispatch`, selecting
   the `<org>` Environment.
5. After the first deploy, set the first admin's `app_metadata.wm_admin =
   true` by hand (`supabase.auth.admin.updateUserById`, OQ-P3 — no
   self-service admin bootstrap exists on purpose, see P5).
6. Add the org's redirect URL to its Supabase project's Auth → Redirect URLs
   allow-list (`PROVISIONING.md`'s post-deploy step — GoTrue silently drops
   an un-allow-listed `redirectTo`).
6a. **Configure native GitHub OAuth on this org's Supabase project**
   (Supabase dashboard → Authentication → Providers → GitHub → set the
   Client ID/Secret + callback URL from a GitHub OAuth App you register for
   this org). This is the sign-in the Workstream 6 admin panel
   (`settings.html`) uses for a plain browser visitor — deliberately the
   *native* provider, not `github-identity-bridge` (that bridge relays a
   GitHub token a VS Code session already holds; it doesn't originate a
   fresh consent screen for someone with no existing token, see
   `src/services/auth-provider.ts`'s module doc). Skipping this step means
   the admin panel's "Sign in with GitHub" button fails for every org
   admin visiting `settings.html`.
7. **Register a Telegram app for this org + capture a session string** (P18).
   The Telegram OSINT poller is NOT shared — Telegram creds aren't public
   data and each org polls its own channel set. Create a Telegram
   application at <https://my.telegram.org/apps> (gives `api_id` + `api_hash`),
   then run `node scripts/telegram/session-auth.mjs` locally with those two
   values to log in once and print a `StringSession`. Put all three into the
   `<org>` GH Environment as `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` /
   `TELEGRAM_SESSION`. `scripts/seed-telegram.mjs` runs every 5 min as a
   per-org `--once` job with a concurrency-1 Redis lock (a second live
   session invalidates the first with `AUTH_KEY_DUPLICATED`). If any of the
   three is unset the job is a clean no-op and the feed panel shows "not
   synced".

8. **Point this org at the shared AIS-ingest deploy** (P14 / P17). The AIS
   WebSocket ingest (`scripts/ais-relay.cjs` minus Telegram minus the
   TransitSummary merge) runs ONCE, shared — see `deploy/shared/README.md` +
   `.github/workflows/deploy-ais-shared.yml`. This org connects to it two
   ways, both wired by the GH Environment values from step 2:
   - `vars.WS_RELAY_URL` = the shared deploy's URL — the per-org RPC
     handlers (`get-vessel-snapshot`, `list-oref-alerts`, the RSS/market
     relay fallbacks) reach it directly for the HTTP-pull surfaces.
   - `AIS_RESULTS_UPSTASH_*` (read-only, shared value) — the per-org
     `scripts/sync-ais-results.mjs` cron pulls
     `supply_chain:chokepoint_transits:v1` from the shared "AIS results"
     Upstash into this org's own DB every 2 min, so
     `scripts/seed-transit-summaries.mjs` and the operator mirror read it
     locally.
   The shared deploy itself is provisioned once (not per org): run
   `.github/workflows/deploy-ais-shared.yml` with its own `ais-shared` GH
   Environment. **Scaffold status:** like the rest of the Nitric/GCP target,
   `nitric up` has not been run against any of this yet.

Re-running `deploy-org.yml` for an existing org is safe — every step it
performs (`supabase db push`, `supabase functions deploy local-config`,
`supabase secrets set`, `nitric up`) is idempotent by design. (The bridge
deploy + `register-provider.ts` moved to `org-provisioning/deploy.sh`, also
idempotent.)
