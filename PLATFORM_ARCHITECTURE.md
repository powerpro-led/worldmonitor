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

- **As of:** 2026-09-04 (session 57) — **Workstream 3 (per-operator LLM keys) fully shipped** (Parts A backend, B dashboard `ai` tab, C hard-disable visibility), alongside W4 + 2 + OQ-P6→P14 + W7's `list-feed-digest` seeder. **OQ-P7 resolved and P13 reviewed** (doc-only) — Workstream 5 has no remaining operator-gated blocker. Prior: S56 reviewed the architecture, then shipped Workstreams R and 1.
- **Prior work state:** `main` @ `46273e8` at S57 start. Local App Initiative Phases 0/1/3/4 complete + tested; **Phase 2's loopback control panel REVERTED** (`d39344f`); **config broker built** (`f09915f`); **mirror is now a denylist** (S57); **`github-identity-bridge` vendored into `supabase/`** (S57). `v2.13.0` **not tagged**, on hold (P12).
- **⚠ Nothing in Workstream 1 has ever run against a real Supabase project.** The edge function is unrun (no `deno` here; `tsconfig.json` covers only `src/`, so it has no local gate at all) and the migration has only been exercised in a throwaway postgres. Both get their first real execution in Workstream 5.
- **S56 review verdict: architecture holds.** Corrections folded into R, 1, 2, 4, 5, 7 and P6. **OQ-P6 and OQ-P7 both RESOLVED S57** — see P14 and the resolved-questions section; no open sub-questions remain.
- **OQ-P1–6 resolved** (OQ-P1 re-opened S56 as OQ-P6, re-closed S57): Cloud Run · Supabase-CLI-scripted provisioning · `app_metadata.wm_admin` · no `settings.html` in the operator bundle · no-LLM-key hard-disables chat · **one shared AIS ingest across all orgs, everything else scheduled at `min-instances: 0`, zero pinned instances per org (P14)**.
- **START HERE: Workstream 5 (deploy pipeline)** — everything remaining waits on it. **Both prior blockers cleared S57:** OQ-P7 resolved (`pipeline_config` wins, 5-min hydration) and P13 reviewed (accepted as designed). Nothing operator-gated remains before starting W5.
- **Recommended order (S56):** ~~R → 1 → 4 → 2 → (7-seeder) → 3~~ (done) → 5 → 6 → rest of 7.

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
| **P6** | **Mirror = denylist, not the `SYNC_PREFIXES` allowlist — with THREE states, not two** (corrected S56): `deny` / `mirror` / `mirror-filtered`. Deny = the shape patterns (`*:token`, `*:secret`, `*:oauth:*`, `ratelimit:*`, `lock:*`, `idempotency:*`, `session:*`, `*:cursor`) **plus the whole "DELIBERATELY EXCLUDED, verified by reading the keys" block already documented at the foot of `SYNC_PREFIXES`** — see Workstream 4 for the enumerated list, which the S55 shape patterns did **not** cover. `brief:` is **mirror-filtered**, NOT denied. | Kills "panel X broke because nobody added the prefix" without copying org secrets, live worker queues, or other operators' personal briefs onto laptops (the session-39 `brief:` leak class). **S56 correction:** a blanket `brief:*` deny is a functional regression — `local-sync.mjs`'s `keepKey()` deliberately mirrors the operator's *own* `brief:<uid>:*` (+ shared `brief:llm:*`), and `api/latest-brief.js` reads that key through the mirror. Deny it wholesale and Latest Brief is permanently empty locally. | S55, corrected S56 |
| **P7** | **Cameras removed entirely** — `PinnedWebcamsPanel`, `api/webcam`, `list-webcams`, webcam sync keys. Not wanted. | Operator's call. | S55 |
| **P8** | **Live streams → buffered upstream, republished to Upstash.** Telegram / AIS / gpsjam: a rolling window (last N messages / last known positions) is written to Upstash; `sync-listener` pushes it to local. ~30–60s staleness accepted. Metadata (channel list, AIS regions) mirrors like any other key. **S57: *where* the buffering runs is settled by P14** — AIS by the one shared ingest service, Telegram + gpsjam by scheduled `--once` jobs. The OQ-P1 scale-to-zero conflict is resolved: nothing in the per-org deploy holds a persistent socket. | "Upstash is the single source of truth" — consistency over sub-minute latency. | S55, resolved S57 |
| **P9** | **`github-identity-bridge` = vendored copy per repo.** Copy `index.ts` + `register-provider.ts` + `fn_link_bridge_identity_if_needed.sql` into `worldmonitor/supabase/functions/github-identity-bridge/` (+ a migration). The multi-org deploy workflow deploys it to each tenant's Supabase project. Header comment marks `platform/tools/supabase/functions/github-identity-bridge` as upstream to sync from. **Revisit** (extract to a dedicated repo, both consumers pin a tag) only if the bridge starts changing more than ~quarterly. | The bridge is generic, env-parameterized, done ("live and verified", one bug fixed), and frozen. A shared repo + versioning + a Supabase-function consumption mechanism for a ~300-line stable file is speculative infra. Self-contained source keeps the deploy workflow a plain `supabase functions deploy` with no cross-repo checkout / submodule / PAT. It is inherently **per-tenant-project** anyway (issuer URL, per-project service-role key for identity pre-linking, registered in each project's auth config) — a single shared deployment is not an option. | S55 |
| **P10** | **Deploy = GitHub Actions `workflow_dispatch(org)` + per-org GH Environments.** One Environment per tenant holding our GCP creds scoped to that project, Pulumi token, that org's Supabase service key + ref, that org's Upstash write URL+token, domain. Non-secret per-org bits (region, variant, domain) in `deploy/orgs/<org>.yml`. | Environments give per-tenant secret isolation + required-reviewer gating for free. | S55 |
| **P11** | **`org.env` shrinks to two public values** — the org's `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY`. That's the irreducible bootstrap: a fresh operator backend must know *which* org's Supabase to authenticate against before it can call `local-config`. No Upstash creds, no data-source keys in it anymore. | Everything else is brokered post-login. | S55 |
| **P13** | **Revocation = ban or delete the operator's Supabase user.** The `local-config` broker verifies via service role, on every call, that the caller still exists and is not banned; the local backend drops its cached credential on a 401/403. **Decided during Workstream 1's implementation, reviewed and accepted S57.** | P4 promises that removing someone "propagates within the hour", but nothing in the design actually changed when access was withdrawn: `worldmonitor-org-gate` is a **before-user-created** hook, so it runs once at signup and dropping someone from the GitHub org never touches their Supabase user. A broker checking only "is this JWT valid?" would revoke nobody and the hourly re-fetch would be decorative. Alternatives rejected: re-checking live GitHub membership needs a stored GitHub token or a per-org PAT we don't have; an `org_members` table contradicts OQ-P3's explicit no-extra-tables stance for the admin flag. Membership itself needs no check — each org has its own project, so holding a live user in it *is* membership. **Review note (S57):** revocation is per-org-project — an operator moved between orgs must be banned in the OLD project explicitly, not just added to the new one, or their local mirror keeps refreshing against the org they left until the next hourly broker check. State this in the admin runbook. | S56, reviewed S57 |
| **P12** | **`v2.13.0` stays untagged, on hold.** The install mechanics (bundled Node, `curl\|sh`, service, CI) are done and tested, but the config UX the bundle currently ships (`settings.html` Backend section, `org.env` with Upstash creds, `/api/local-config`) is being replaced. Tag only after Workstreams 1–4 + R land. | Don't ship a dead-on-arrival config flow. Supersedes D12's "all four phases cohere" gate. | S55 |
| **P14** | **No pinned instances in a per-org deploy. Resolves OQ-P6.** (a) **AIS WebSocket ingest** (`wss://stream.aisstream.io`, the ONE genuinely persistent connection in the stack) runs as **one shared service across all orgs** — public vessel data, identical for every tenant — fanning parsed output into each org's Upstash via that org's write token. New standalone deploy target (own GCP service, own GH Environment, own `AISSTREAM_API_KEY`, a registry of `{org → upstash write url+token}`). (b) **Everything else that was "long-running"** becomes scheduled at `min-instances: 0`, per org: `digest-notifications` → Cloud Scheduler job; `publish-bootstrap-tiers` → two Cloud Scheduler jobs (2m/10m); `process-simulation-tasks` + `process-deep-forecast-tasks` + `scenario-worker` → **one merged `queue-worker.mjs`**, scheduled `--once` (both flows are already async pending→poll, so queue latency ~1–2m is fine); `ais-relay.cjs`'s **28 `startBootSeedLoop` seed/warm-ping loops** → entries in `gcp/scheduler/main.ts`'s `CADENCES` map (many already there or shadowed as "ais-relay backup"); **Telegram MTProto poller** → scheduled `--once` + a Redis lock (concurrency 1, or `AUTH_KEY_DUPLICATED`). (c) **Phasing:** Phase 1 (ships with W5) does digest/bootstrap/queue-worker; `ais-relay.cjs` runs unchanged as a single pinned `min-instances:1` **per org** as a stopgap. Phase 2 (overlaps W7) decomposes `ais-relay.cjs` — 28 loops → `CADENCES`, extract the ~150-line WS core → the shared service, extract Telegram → scheduled. End state: **0 pinned per org.** | The "6 long-running services" were an artifact of Railway's "a container is a container" model — under inspection they are 1 WebSocket + ~30 timer loops + 3 async queue drains. Cloud Run + Cloud Scheduler (OQ-P1) is built to separate those. Sharing the AIS ingest is the one place cross-tenant coupling enters, and it is acceptable *because* the data is public and identical — the per-org-isolation argument that holds for tenant data is materially weaker here. | S57 |

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

- [ ] `deploy/orgs/<org>.yml` — non-secret per-org config (domain, GCP region, variant, Supabase project ref).
- [ ] **Generate `nitric.<org>.yaml` from `deploy/orgs/<org>.yml` at deploy time** (S56 gap). `nitric.gcp.yaml` hardcodes `gcp-project-id: apps-453107` and `region: us-central1`; Nitric selects a stack by *filename*, and `nitric-deploy.yml` already exposes a `stack-name` input — so the lever exists, but nothing currently feeds it from the per-org config. Without this step `deploy-org.yml` deploys every org into `apps-453107`.
- [ ] **OQ-P7 resolved S57 → implement the hydration.** `pipeline_config` wins; the deploy-time `PRODUCTION_ENV_FILE` secret stops being the 26 keys' home (confirm nothing else in `nitric-deploy.yml` still needs it before removing it). Worker needs a startup + 5-minute-interval `pipeline_config → process.env` hydration loop (mirrors `loadConfigIntoEnv()`). Workstream 6's admin panel copy must say "changes apply within 5 minutes."
- [ ] GH Actions Environment per org — GCP creds (scoped to that project), Pulumi token, `SUPABASE_ACCESS_TOKEN` + project ref + DB password, Upstash write URL+token.
- [ ] `worldmonitor/supabase/` set up for the **Supabase CLI** (OQ-P2): `supabase/config.toml`, `supabase/migrations/*.sql` (`pipeline_config` + RLS + `fn_link_bridge_identity_if_needed`), `supabase/functions/{local-config,github-identity-bridge}/`.
- [ ] `.github/workflows/deploy-org.yml` — `workflow_dispatch(org)` → select Environment → `supabase link` → `supabase db push` → `supabase functions deploy --no-verify-jwt` (both fns) → set function secrets → `deno run register-provider.ts` → configure the org-gate auth hook → deploy the worker + admin panel to **Cloud Run** (OQ-P1) via `nitric up` / Pulumi (grow `nitric-deploy.yml`).
- [ ] Idempotent: re-running updates in place. "New org" runbook: create the Supabase project + Upstash DB + GCP project, add the GH Environment, run the workflow, then set the first admin's `app_metadata.wm_admin` (OQ-P3).
- [ ] **P14 — no pinned instances per org.** Phase 1: `digest-notifications` + `publish-bootstrap-tiers` (×2) as Cloud Scheduler jobs; the 3 forecast/scenario queue consumers merged into one `queue-worker.mjs` run scheduled `--once`; `ais-relay.cjs` as a single per-org `min-instances:1` stopgap. The generated `nitric.<org>.yaml` carries that one pinned override and nothing else.
- [ ] **P14 — the shared AIS ingest is its OWN deploy target, not part of `deploy-org.yml`.** Separate workflow + GH Environment, own `AISSTREAM_API_KEY`, a maintained registry of `{org → Upstash write url+token}` (it writes vessel state into every org's DB). New-org onboarding must append the org to that registry. Deferred detail: how the registry is stored + rotated (candidate: a JSON secret in the shared service's Environment, updated by `deploy-org.yml` as a side effect).

### Workstream 6 — admin panel

- [ ] `settings.html` served by the Cloud Run deploy, behind a GitHub-login gate that checks `app_metadata.wm_admin` (OQ-P3).
- [ ] Write route: `pipeline_config` upsert via the Supabase client with the caller's session — RLS enforces admin-only.
- [ ] `settings-main.ts`: the full 5-category form is the admin view; masking machinery already exists. This is the ONLY place it renders now (removed from the operator bundle — Workstream R).

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

- [ ] Cameras: delete (P7) — includes `server/worldmonitor/webcam/v1/get-webcam-image.ts`, one of the 22.
- [ ] **Decompose `ais-relay.cjs` (P14 Phase 2).** 28 `startBootSeedLoop` seed/warm-ping loops → `gcp/scheduler/main.ts` `CADENCES` entries (map each against what's already registered/shadowed there first — the file already lists several as "ais-relay backup"). Extract the ~150-line AIS WS core → the shared ingest service. Extract the Telegram MTProto poller → scheduled `--once` + Redis lock. `tauri-sidecar` `telegram-feed` / `gpsjam` routes become mirror reads. End state: the per-org deploy has 0 pinned instances.
- [x] **DONE S57 — `list-feed-digest` seeder.** `scripts/seed-news-digest.mjs`: a nixpacks-root-scripts warm-ping job (NOT a re-implementation — `scripts/` can't import `server/` and `buildDigest` isn't exported). It HTTP-pings `/api/news/v1/list-feed-digest?variant=&lang=` per `(variant, lang)` pair (env `NEWS_DIGEST_SEED_VARIANTS`=`full`, `NEWS_DIGEST_SEED_LANGS`=`en,zh`; `en` first so `zh` reuses the warmed `rss:feed:v8:*` per-feed caches) — the RPC runs `buildDigest`, `setCachedJson`s `news:digest:v1:<variant>:<lang>` (which also fires the mirror notify) and stamps a fresh `generatedAt` (what the panels read for freshness, so no `seed-meta:` write here). Registered in `railway-services.json` + `gcp/scheduler/main.ts` `CADENCES` at **`*/10 * * * *`** — a hard constraint, not an inference: must stay under `list-feed-digest.ts`'s 900s `news:digest:v1` TTL or the cold-hole bug returns. `classifyKey('news:digest:v1:*')` was already `'mirror'` — no W4 change. Exit-code policy: 0 on any success (partial failure self-heals next tick), 1 only if every ping fails. Unit test: `tests/seed-news-digest.test.mjs` (10 cases). **The sidecar startup warm-ping (`local-api-server.mjs` ~2546) is removed** — it was already inert whenever `WS_RELAY_URL` was unset (`/api/news/v1/` is `cloudPreferred` then), i.e. in exactly the config the pivot backend runs; the digest now arrives over the mirror.
- [ ] Work the remaining 21 direct-fetch handlers + 9 shared modules case by case → move server-side or accept degraded-offline. By domain: aviation (3), market (4), military (2), infrastructure (3), intelligence (3), economic, displacement, maritime, sanctions, imagery, research (1 each); shared: `aviation/_shared`, `cyber/_shared`, `market/_shared`, `trade/_shared`, `unrest/_shared`, `news/_feeds`, `economic/_bis-shared`, `military/_wingbits-aircraft-details`, `supply-chain/_bilateral-hs4-lazy`.
- [ ] `cloudFallback` — with a real per-org cloud origin now existing, decide whether operator backends may use it (probably still off; a miss = "not synced yet").

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
