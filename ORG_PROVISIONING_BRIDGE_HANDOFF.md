# Handoff — `github-identity-bridge` moved to `../org-provisioning`; drop worldmonitor's vendored copy

> **STATUS (checked 2026-09-15, new worldmonitor session): still PENDING, do not
> execute yet.** `../org-provisioning` has moved well past the state this file
> assumed — it now has a real `origin` remote, 11 commits, tags `v0.1.0`/
> `v0.2.0`, a working `deploy.sh`/`provision-org.yml`, and Tier-1 bridge
> secrets already set on both the `mosiq`/`biovita` GitHub Environments (see
> `org-provisioning`'s own `HANDOFF_per-org-provisioning.md`, 2026-09-14). But
> this file's own safety gate — "don't remove worldmonitor's bridge deploy
> steps until `deploy.sh` has run green against `mosiq` (test tenant), then
> `biovita`" — is **not yet satisfied**: `provision-org.yml` has never been
> dispatched for real against either org; the operator has explicitly said
> "not ready yet" more than once (per that same handoff). Only local-stack
> dry runs (a synthetic `sample-org`) have executed. Re-check
> `org-provisioning`'s live git log / latest handoff before acting on the
> steps below — do not delete worldmonitor's vendored bridge or edit
> `deploy-org.yml` until a real cloud `deploy.sh` run against `mosiq` is
> confirmed. This file was previously sitting untracked in the repo root for
> over a week (written 09-07, found untracked 09-15) — now committed so it
> doesn't go missing again.

**Written 2026-09-07 by the `platform` session.** Not committed — different repo,
your review. Companion doc: `../platform/CROSS_REPO_SUPABASE.md` (the full
cross-repo model). This asks `worldmonitor` to stop carrying its vendored copy of
the bridge and consume the one now owned by a new sibling repo.

---

## Why this changed

The earlier framing ("every org runs both apps") was wrong. Corrected model:

- **An org = one Supabase project + whichever of `platform` / `worldmonitor`
  that org wants.** Either app can be deployed for an org *without* the other.
  Neither is the base.
- So anything **both** apps need — the identity bridge above all — cannot live
  inside either app. If the bridge lived in `platform`, a `worldmonitor`-only
  org couldn't stand up auth without `platform`'s pipeline. Same the other way.

**Resolution: the bridge is per-org infrastructure with its own repo,
`../org-provisioning`**, owned by neither app. Per-org provisioning deploys it
once per project, before any app:

```
provision org <name>:
  1. create the org's Supabase project
  2. org-provisioning/deploy.sh <project-ref>     ← always
  3. deploy platform      (if the org wants it)
  4. deploy worldmonitor  (if the org wants it)
```

## What `../org-provisioning` contains (scaffolded, not yet published)

```
org-provisioning/
  functions/github-identity-bridge/   index.ts, register-provider.ts, deno.json, .npmrc
  sql/link_bridge_identity_if_needed.sql   schema-parameterized (__BRIDGE_SCHEMA__)
  deploy.sh <project-ref>             idempotent: apply sql (psql) → supabase secrets set
                                       → functions deploy --no-verify-jwt → register-provider.ts
  README.md                           the 5 function secrets + keypair step + env contract
```

- `index.ts` is `worldmonitor`'s current vendored `index.ts` minus the vendoring
  header, with the one real divergence turned into config:
  `createClient(url, key, { db: { schema } })` now reads **`BRIDGE_DB_SCHEMA`**
  (default `public`) instead of hardcoding `"worldmonitor"`.
- `platform` has **already deleted** its own copy
  (`tools/supabase/functions/github-identity-bridge/`) this session. Its SQL
  companion is kept a bit longer only because it's declarative-schema source of
  truth for a live DB object (removing it early would make platform's schema
  diff emit a `DROP FUNCTION`).

⚠️ `../org-provisioning` is a local `git init` with **no remote and no commit
yet**. Until it has a remote + a pinned tag you can't `git submodule add` it or
check it out in CI. Near-term this handoff = *stop maintaining your copy, treat
`../org-provisioning` as the source*. Full CI wiring comes after it's published.

## Changes in `worldmonitor`

### Remove

| Path | Note |
|---|---|
| `supabase/functions/github-identity-bridge/` (whole dir, incl. `PROVISIONING.md`) | superseded by `org-provisioning/` — its keypair-gen steps are in `org-provisioning/README.md` |
| `supabase/migrations/20260904130000_github_identity_bridge.sql` | the SQL companion is now applied by `deploy.sh`. Safe to delete: Supabase migrations are forward-only, `create or replace function` means already-applied projects are unaffected, and new orgs get the function from `deploy.sh` instead. |

### `.github/workflows/deploy-org.yml` — edit the bridge steps

- **`Apply migrations` step** — still runs `supabase db push` for
  `pipeline_config` (Workstream 1). Just loses the bridge migration once you
  delete that file. No change to the step itself.
- **`Deploy github-identity-bridge` step** — delete.
- **`Set function secrets` step** — **split, don't delete.** It currently sets
  8 secrets in one call: keep `WM_UPSTASH_REST_URL`, `WM_UPSTASH_READONLY_TOKEN`,
  `WM_APP_DOMAIN` (those are for `local-config`). Remove the 5 bridge ones
  (`OIDC_SIGNING_PRIVATE_KEY_JWK`, `OIDC_SIGNING_KID`, `TICKET_SIGNING_SECRET`,
  `BRIDGE_CLIENT_ID`, `BRIDGE_CLIENT_SECRET`) — `deploy.sh` sets those now.
- **`Register github-identity-bridge as an OIDC provider` step** — delete
  (`deploy.sh` runs `register-provider.ts`).
- **Add** (once `org-provisioning` is published): a step that checks out
  `org-provisioning` at a pinned tag and runs
  `./deploy.sh "$SUPABASE_PROJECT_REF"` with the env its header lists. It's
  idempotent, so running it on every deploy is harmless; running it once per org
  at provisioning time is tidier. The 5 bridge GH secrets stay in the org's
  Environment — they're just passed to `deploy.sh` now.

### `BRIDGE_DB_SCHEMA` — pick per org, not per app

Your vendored copy hardcoded the `worldmonitor` schema (both `createClient` and
the SQL companion). There is **one** bridge + **one**
`link_bridge_identity_if_needed` per project, so its schema is an org-level
choice:

- **Org also runs `platform`** (or might later) → `BRIDGE_DB_SCHEMA=public`
  (the default). On `biovita` / `mosiq`, `deploy.sh` will create
  `public.link_bridge_identity_if_needed`; the old
  `worldmonitor.link_bridge_identity_if_needed` becomes unused — drop it
  manually or leave it.
- **Pure `worldmonitor` org, `public` kept empty by policy** → you *may* pass
  `BRIDGE_DB_SCHEMA=worldmonitor` to `deploy.sh` and add `worldmonitor` to the
  project's PostgREST exposed schemas (`config.toml [api].schemas`). Simplest is
  still `public` — the function is isolated regardless.

### Keep unchanged (client side of the flow)

`src/services/auth-provider.ts`, `src/services/supabase-client.ts`,
`src/services/admin-org-connection.ts`, `vscode-extension/src/panel.ts` — they
use the issuer URL + `BRIDGE_CLIENT_ID`/`SECRET`, which don't change.
`supabase/functions/local-config/` is worldmonitor's own, untouched.

### Docs to update

- `PLATFORM_ARCHITECTURE.md` — **P9** ("bridge is per-tenant-project by
  construction"): still true, but ownership moves out of this repo to
  `../org-provisioning`; the deploy is a provisioning step, not a Workstream-5
  step. Add to the session log.
- `deploy/orgs/README.md` — the `github-identity-bridge` 5-secrets paragraph now
  points at `org-provisioning/README.md`; the deploy actions list drops the
  bridge `functions deploy` / `register-provider.ts` entries.
- `CHANGELOG.md`, `TASKS.md` — as you normally track.

## Sequencing / safety

Live DB state, verified 2026-09-07 via Supabase MCP:

| | `biovita` (`ixuezudybhjptisexgxx`) | `mosiq` (`lntyjouahofgewtkmpyi`) |
|---|---|---|
| `github-identity-bridge` edge fn | v5 ACTIVE | v4 ACTIVE |
| `link_bridge_identity_if_needed` | `public` schema | **`worldmonitor` schema** (no `public` copy) |
| `custom:github-bridge` provider | registered | **not registered** |

So on `mosiq`: your `20260904130000` migration's function is in the
`worldmonitor` schema, the provider was never registered, and there's no
`public` copy. `deploy.sh` (with default `BRIDGE_DB_SCHEMA=public`) will create
the `public` copy + register the provider.

1. Don't remove worldmonitor's bridge deploy steps until
   `org-provisioning/deploy.sh` has run green against `mosiq` (your test tenant),
   then `biovita`.
2. After `deploy.sh`, the `mosiq` bridge (once redeployed from `org-provisioning`)
   calls `public.link_bridge_identity_if_needed`. The old
   `worldmonitor.link_bridge_identity_if_needed` is then an orphan — drop it:
   `DROP FUNCTION worldmonitor.link_bridge_identity_if_needed(text,text,text,text,text);`
   **Only after** the redeploy — dropping it while the current v4 edge fn (which
   hardcodes `db.schema = "worldmonitor"`) is still live disables the
   duplicate-account guard on `mosiq` (fails open — sign-in works, guard off).
3. Everything is idempotent — switching the *deploy source* shouldn't touch a
   working sign-in. Verify anyway: after `deploy.sh`, real password-grant token
   fetch + a bridge sign-in.
4. The 5 bridge secrets are unchanged values — do **not** regenerate them
   (rotating `OIDC_SIGNING_*` logs out every operator).

## Open question back to you

Who owns per-org **provisioning orchestration** long-term? Today `deploy-org.yml`
in this repo does it, which re-introduces "worldmonitor required" for the
provisioning step. If a `platform`-only org must be provisionable without this
repo, the `deploy.sh` call belongs in something neutral (the `org-provisioning`
repo's own workflow, or a separate provisioning repo) — not `deploy-org.yml`.
Not blocking the bridge extraction; flag for the architecture tracker.
