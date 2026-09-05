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
2. Create a GH Environment named `<org>` in this repo. See
   `.github/workflows/deploy-org.yml`'s own header for the authoritative,
   exact list of secrets/vars it reads — summarized here:
   - GCP: `GCP_CREDENTIALS` (service-account JSON scoped to the new project).
   - Deploy tooling: `PULUMI_ACCESS_TOKEN`.
   - Supabase CLI: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`,
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
   - `github-identity-bridge`'s 5 function secrets — generate ONCE via
     `supabase/functions/github-identity-bridge/PROVISIONING.md`'s keypair
     step, do NOT regenerate on every deploy run (rotates the OIDC signing
     key, logs out every operator): `OIDC_SIGNING_PRIVATE_KEY_JWK`,
     `OIDC_SIGNING_KID`, `TICKET_SIGNING_SECRET`, `BRIDGE_CLIENT_ID`,
     `BRIDGE_CLIENT_SECRET`.
   - This deploy's own session secret: `WM_SESSION_SECRET`.
   - Build-time vars (non-secret): `vars.APP_DOMAIN`, `vars.VITE_VARIANT`.
   - **Deliberately absent**: none of the ~26 data-source keys (ACLED, FRED,
     Finnhub, …) — those are set live, per org, via the Workstream 6 admin
     panel, into `pipeline_config`, never into this Environment.
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
7. **Not yet available**: a standalone shared AIS-ingest deploy target (P14
   part b — one shared Cloud Run service pushing vessel data into every
   org's Upstash DB). Its WebSocket core still lives embedded inside
   `scripts/ais-relay.cjs`, run per-org as this deploy's own pinned
   `min-instances: 1` stopgap (Part 1's `PINNED_SERVICES`, P14 Phase 1) —
   extracting it into its own service is explicitly Phase 2 work (overlaps
   Workstream 7, PLATFORM_ARCHITECTURE.md), needing real code that doesn't
   exist yet. Until then, each org's own `ais-relay.cjs` instance already
   ingests AIS data for that org independently — no registry, no separate
   workflow, nothing missing operationally, just not yet consolidated to
   avoid running N redundant WebSocket connections to the same public feed.

Re-running `deploy-org.yml` for an existing org is safe — every step it
performs (`supabase db push`, `supabase functions deploy`, `supabase secrets
set`, `register-provider.ts`, `nitric up`) is idempotent by design.
