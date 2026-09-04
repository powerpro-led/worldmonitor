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

- **As of:** 2026-09-04 (session 55) — architecture agreed, nothing built yet. Doc-only.
- **Prior work state:** `main` == `origin/main` through `07c280c` (Local App Initiative Phases 0/1/3/4 complete; Phase 2's loopback control panel is **to be reverted** — see Workstream R). `v2.13.0` **not tagged** and now on hold pending the config-model change.
- **START HERE:** Workstream 1 (`local-config` edge fn + `pipeline_config` table) and Workstream R (revert Phase 2) are the unblocked entry points. Everything else depends on the per-org deploy pipeline (Workstream 5).

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
| **P5** | **Admin panel is colocated with the worker, not a separate release.** `settings.html` + a write route ship inside the org's GCP deploy (same Vite build), gated to that org's admin GitHub logins. It writes the 26 keys to that org's Supabase (`pipeline_config` table, RLS = admins). NOT bundled with the operator local backend; NOT its own downloadable artifact. | The admin already runs the full repo as the worker host — the panel rides along. | S55 |
| **P6** | **Mirror = denylist, not the `SYNC_PREFIXES` allowlist.** Mirror every Upstash key **except** `*:token`, `*:secret`, `*:oauth:*`, `brief:*` (per-user), `ratelimit:*`, `lock:*`, `idempotency:*`, `session:*`, `*:cursor` (final list TBD in Workstream 4). | Kills "panel X broke because nobody added the prefix" without copying org secrets or other operators' personal briefs onto laptops (the session-39 `brief:` leak class). | S55 |
| **P7** | **Cameras removed entirely** — `PinnedWebcamsPanel`, `api/webcam`, `list-webcams`, webcam sync keys. Not wanted. | Operator's call. | S55 |
| **P8** | **Live streams → worker-buffered.** Telegram / AIS / gpsjam: the **worker** holds the upstream socket and republishes a rolling window (last N messages / last known positions) into Upstash; `sync-listener` pushes it to local. ~30–60s staleness accepted. Metadata (channel list, AIS regions) mirrors like any other key. | "Upstash is the single source of truth" — consistency over sub-minute latency. | S55 |
| **P9** | **`github-identity-bridge` = vendored copy per repo.** Copy `index.ts` + `register-provider.ts` + `fn_link_bridge_identity_if_needed.sql` into `worldmonitor/supabase/functions/github-identity-bridge/` (+ a migration). The multi-org deploy workflow deploys it to each tenant's Supabase project. Header comment marks `platform/tools/supabase/functions/github-identity-bridge` as upstream to sync from. **Revisit** (extract to a dedicated repo, both consumers pin a tag) only if the bridge starts changing more than ~quarterly. | The bridge is generic, env-parameterized, done ("live and verified", one bug fixed), and frozen. A shared repo + versioning + a Supabase-function consumption mechanism for a ~300-line stable file is speculative infra. Self-contained source keeps the deploy workflow a plain `supabase functions deploy` with no cross-repo checkout / submodule / PAT. It is inherently **per-tenant-project** anyway (issuer URL, per-project service-role key for identity pre-linking, registered in each project's auth config) — a single shared deployment is not an option. | S55 |
| **P10** | **Deploy = GitHub Actions `workflow_dispatch(org)` + per-org GH Environments.** One Environment per tenant holding our GCP creds scoped to that project, Pulumi token, that org's Supabase service key + ref, that org's Upstash write URL+token, domain. Non-secret per-org bits (region, variant, domain) in `deploy/orgs/<org>.yml`. | Environments give per-tenant secret isolation + required-reviewer gating for free. | S55 |
| **P11** | **`org.env` shrinks to two public values** — the org's `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY`. That's the irreducible bootstrap: a fresh operator backend must know *which* org's Supabase to authenticate against before it can call `local-config`. No Upstash creds, no data-source keys in it anymore. | Everything else is brokered post-login. | S55 |
| **P12** | **`v2.13.0` stays untagged, on hold.** The install mechanics (bundled Node, `curl\|sh`, service, CI) are done and tested, but the config UX the bundle currently ships (`settings.html` Backend section, `org.env` with Upstash creds, `/api/local-config`) is being replaced. Tag only after Workstreams 1–4 + R land. | Don't ship a dead-on-arrival config flow. Supersedes D12's "all four phases cohere" gate. | S55 |

---

## Component map

| Component | Runs where | Holds | Talks to |
|---|---|---|---|
| **Operator local backend** (`curl\|sh` bundle — `LOCAL_APP_INITIATIVE.md`) | each operator's machine (launchd / Scheduled Task) | Supabase session · brokered Upstash RO token (cached, hourly) · the operator's own LLM key | that org's Supabase (login + `local-config`) · that org's Upstash (RO, sync) · OpenRouter/Groq (LLM only, on-demand, operator's key) |
| **`local-config` edge fn** | each org's Supabase project | — (reads function secrets) | verifies caller's session; returns `{ upstashUrl, upstashReadonlyToken, appDomain }` |
| **`github-identity-bridge` edge fn** (vendored, P9) | each org's Supabase project | per-project OIDC signing keys | GitHub API · that project's GoTrue |
| **`pipeline_config` table** | each org's Supabase project | the 26 data-source keys (RLS: org admins write, worker reads via service role) | — |
| **Admin panel** (`settings.html`, P5) | inside each org's GCP deploy | — | that org's Supabase (`pipeline_config` R/W, admin-gated) |
| **Worker** (pipeline) | each org's GCP deploy | that org's 26 data-source keys · that org's Upstash **write** token | external APIs · LLM · that org's Upstash (write) |
| **Upstash DB** | Upstash cloud, one per org | the org's computed dashboard state — **single source of truth** | — |

---

## Workstreams

### Workstream R — revert the per-operator control panel (Phase 2)

- [ ] Revert / neutralize `f1a90be`, `ed3c281`, `e30f1cd`, `6ba93d2` (keep `ad77eb8`'s doc structure). Specifically: remove `handleLocalControlPlane()` (`/api/local-config`, `/api/local-login|logout|restart`), `buildLocalControlPanelShim()`, `buildFirstRunRedirectShim()`, the `settings-main.ts` **Backend** section + its `window.__WM_LOCAL_CONTROL_PANEL` gate.
- [ ] **Keep** `beginGithubLogin()` (`local-login.mjs`) — operators still sign in; just not through a "control panel."
- [ ] Decide: does the operator bundle still ship `settings.html` at all? If the per-operator LLM-key modal lives in `dashboard.html` instead, drop `settings.html` from the bundle. (Workstream 3.)
- [ ] `test:sidecar` — drop the 7 Phase-2 tests, keep the rest green.

### Workstream 1 — config broker (`local-config` edge fn + `pipeline_config`)

- [ ] `worldmonitor/supabase/functions/local-config/index.ts` — `verify_jwt: true`; read user from JWT; confirm org membership; return `{ upstashUrl, upstashReadonlyToken, appDomain }` from function secrets.
- [ ] `worldmonitor/supabase/migrations/*_pipeline_config.sql` — `pipeline_config(key text primary key, value text, updated_at timestamptz)`; RLS: `select/insert/update` for a member with an `admin` claim; service-role bypass for the worker.
- [ ] Local backend: `config.db` becomes a **cache** of the broker response, hourly refetch (repurposes Phase 1's `config-store.mjs` / `loadConfigIntoEnv()`); on `SIGNED_OUT` or a 401 from the broker, drop the cache.
- [ ] `worldmonitor-local.mjs login` / `beginGithubLogin()` → after session, immediately call `local-config` and seed the cache.

### Workstream 2 — vendor `github-identity-bridge` (P9)

- [ ] Copy `index.ts` + `register-provider.ts` + `fn_link_bridge_identity_if_needed.sql` into `worldmonitor/supabase/`, with the "upstream = platform @ <sha>" header.
- [ ] Per-project provisioning steps documented + scripted for Workstream 5 (generate RSA keypair, set 5 function secrets, `functions deploy --no-verify-jwt`, `db push`, `deno run register-provider`).

### Workstream 3 — per-operator LLM key modal

- [ ] A minimal settings modal in the dashboard (filtered view of `settings-main.ts`'s AI category, or a fresh small component) — `OPENROUTER_API_KEY` / `GROQ_API_KEY` / `OLLAMA_API_URL` + `OLLAMA_MODEL`.
- [ ] Stored per-operator: `config.db` (local) — NOT sent anywhere. `server/_shared/llm.ts` reads it.
- [ ] Everything else in `settings-main.ts` becomes admin-panel-only (Workstream 6).

### Workstream 4 — denylist mirror

- [ ] Replace `SYNC_PREFIXES` (the allowlist in `scripts/shared/sync-domains.mjs`) with a denylist: `isMirrorableKey(key)` returns true unless it matches a deny pattern (P6 list — finalize by auditing live Upstash keys, as session 43 did, but inverted).
- [ ] `local-sync.mjs` full-rescan + `sync-listener.mjs` fast-path both consult it.
- [ ] Regression test: a fresh data prefix mirrors with no code change; a `brief:<uid>:*` / `*:token` key never lands in the local mirror.

### Workstream 5 — multi-org deploy pipeline

- [ ] `deploy/orgs/<org>.yml` — non-secret per-org config (domain, region, variant, Supabase project ref).
- [ ] GH Actions Environment per org — GCP creds (scoped), Pulumi token, Supabase service key, Upstash write URL+token.
- [ ] `.github/workflows/deploy-org.yml` — `workflow_dispatch(org)` → select env → provision Supabase (functions deploy, `db push`, `register-provider`, org-gate hook) → deploy GCP (worker + admin panel) via `nitric up` / Pulumi (grow `nitric-deploy.yml`).
- [ ] Idempotent: re-running updates in place. A "new org" runbook: create the 3 projects + the Environment, run the workflow.

### Workstream 6 — admin panel

- [ ] `settings.html` served by the GCP deploy, behind a GitHub-login gate that checks the `admin` claim (org-gate hook sets it for designated logins).
- [ ] Write route: `pipeline_config` upsert (admin-gated, via Supabase client with the caller's session — RLS enforces).
- [ ] `settings-main.ts`: the full 5-category form is the admin view; masking machinery already exists.

### Workstream 7 — worker: absorb the direct fetches

- [ ] Cameras: delete (P7).
- [ ] Telegram / AIS / gpsjam: worker holds the socket, writes a rolling window to Upstash (P8); local `tauri-sidecar` routes become mirror reads.
- [ ] Audit remaining `tauri-sidecar`-mode direct fetches (`local-api-server.mjs` line ~2718 relay list, RSS digest, climate/Open-Meteo, threat-intel) → move server-side or accept degraded-offline, case by case.
- [ ] `cloudFallback` — with a real per-org cloud origin now existing, decide whether operator backends may use it (probably still off; a miss = "not synced yet").

---

## Open sub-questions

- **OQ-P1** — Worker deploy target: Cloud Run (per-service, scale-to-zero, cron via Cloud Scheduler) vs. GKE vs. a single always-on VM per org? Affects `nitric.yaml` provider config and cost.
- **OQ-P2** — Per-org Supabase provisioning: fully scripted in `deploy-org.yml` (needs a Supabase management token with project-admin scope as a repo secret) vs. a documented one-time manual setup + the workflow only deploys functions/migrations after.
- **OQ-P3** — "admin" claim: where does it come from — the org-gate `before-user-created` hook keying off a GitHub team, a `pipeline_config`-adjacent `org_admins` table, or a manual `app_metadata` flag?
- **OQ-P4** — Does the operator bundle keep `settings.html` (for the LLM modal) or move that into `dashboard.html` and drop `settings.html` from the bundle entirely? (Workstream R / 3.)
- **OQ-P5** — LLM on-demand for operators with no key: hard-disable chat/summarize, or proxy through an authenticated per-org cloud LLM endpoint that holds the org key (turns "operator LLM key" into an org-tier key after all)?

---

## Session log

### Session 55 — 2026-09-04

- Architecture pivot agreed across a long design conversation. The Local App Initiative's "every operator self-configures a local backend" model is replaced by a multi-tenant platform: repo devs operate isolated per-org instances (Supabase + Upstash + GCP), org admins manage their org's data-source keys via a cloud admin panel, operators run a thin read-only mirror + one LLM key.
- Decisions P1–P12 locked. Workstreams R + 1–7 defined. `v2.13.0` moved from "D12 gate" to "hold pending config-model change" (P12).
- `github-identity-bridge` decoupling resolved → **P9** (vendor a copy; platform stays upstream; revisit only on churn).
- This file created as the new single source of truth; `LOCAL_APP_INITIATIVE.md` demoted to the operator-client sub-track.
- **Nothing implemented.** Doc-only session.
