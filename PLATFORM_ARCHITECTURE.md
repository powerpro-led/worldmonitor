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

- **As of:** 2026-09-04 (session 56) — architecture reviewed, then **Workstreams R and 1 shipped**.
- **Prior work state:** `main` @ `f09915f`. Local App Initiative Phases 0/1/3/4 complete + tested; **Phase 2's loopback control panel REVERTED** (`d39344f`); **config broker built** (`f09915f`). `v2.13.0` **not tagged**, on hold (P12).
- **⚠ Nothing in Workstream 1 has ever run against a real Supabase project.** The edge function is unrun (no `deno` here; `tsconfig.json` covers only `src/`, so it has no local gate at all) and the migration has only been exercised in a throwaway postgres. Both get their first real execution in Workstream 5.
- **S56 review verdict: architecture holds.** Corrections folded into R, 1, 2, 4, 5, 7 and P6 below. Two items re-opened as **OQ-P6** (Cloud Run vs. persistent sockets — a cost decision OQ-P1 closed prematurely) and **OQ-P7** (where the 26 data-source keys actually live at worker runtime — P3 and `nitric-deploy.yml` currently disagree).
- **OQ-P1–5 resolved S55** (OQ-P1 partially re-opened as OQ-P6): Cloud Run · Supabase-CLI-scripted provisioning · `app_metadata.wm_admin` · no `settings.html` in the operator bundle · no-LLM-key hard-disables chat.
- **START HERE: Workstream 4** (denylist mirror). Workstream 2 (vendor the bridge) and Workstream 7's `list-feed-digest` seeder are also unblocked and can run in parallel. Everything else waits on Workstream 5 (deploy pipeline).
- **Decisions needed from the operator before Workstream 5:** OQ-P6, OQ-P7, and a review of **P13** (revocation mechanism — decided during implementation, not by the S55 design conversation). None blocks 4, 2, or the 7-seeder.
- **Recommended order (S56):** R → 1 → 4 → (2 ∥ 7-seeder) → 5 → 3 → 6 → rest of 7. Workstream 4 lands before any tagging: P12's hold is about config UX, and 4 changes what data reaches a laptop.

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
| **P8** | **Live streams → worker-buffered.** Telegram / AIS / gpsjam: the **worker** holds the upstream socket and republishes a rolling window (last N messages / last known positions) into Upstash; `sync-listener` pushes it to local. ~30–60s staleness accepted. Metadata (channel list, AIS regions) mirrors like any other key. **⚠ Conflicts with OQ-P1's scale-to-zero Cloud Run — see OQ-P6.** A process holding a persistent socket cannot scale to zero; `nitric.gcp.yaml` already carries a standing TODO saying exactly this for the 6 long-running services. | "Upstash is the single source of truth" — consistency over sub-minute latency. | S55, flagged S56 |
| **P9** | **`github-identity-bridge` = vendored copy per repo.** Copy `index.ts` + `register-provider.ts` + `fn_link_bridge_identity_if_needed.sql` into `worldmonitor/supabase/functions/github-identity-bridge/` (+ a migration). The multi-org deploy workflow deploys it to each tenant's Supabase project. Header comment marks `platform/tools/supabase/functions/github-identity-bridge` as upstream to sync from. **Revisit** (extract to a dedicated repo, both consumers pin a tag) only if the bridge starts changing more than ~quarterly. | The bridge is generic, env-parameterized, done ("live and verified", one bug fixed), and frozen. A shared repo + versioning + a Supabase-function consumption mechanism for a ~300-line stable file is speculative infra. Self-contained source keeps the deploy workflow a plain `supabase functions deploy` with no cross-repo checkout / submodule / PAT. It is inherently **per-tenant-project** anyway (issuer URL, per-project service-role key for identity pre-linking, registered in each project's auth config) — a single shared deployment is not an option. | S55 |
| **P10** | **Deploy = GitHub Actions `workflow_dispatch(org)` + per-org GH Environments.** One Environment per tenant holding our GCP creds scoped to that project, Pulumi token, that org's Supabase service key + ref, that org's Upstash write URL+token, domain. Non-secret per-org bits (region, variant, domain) in `deploy/orgs/<org>.yml`. | Environments give per-tenant secret isolation + required-reviewer gating for free. | S55 |
| **P11** | **`org.env` shrinks to two public values** — the org's `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY`. That's the irreducible bootstrap: a fresh operator backend must know *which* org's Supabase to authenticate against before it can call `local-config`. No Upstash creds, no data-source keys in it anymore. | Everything else is brokered post-login. | S55 |
| **P13** | **Revocation = ban or delete the operator's Supabase user.** The `local-config` broker verifies via service role, on every call, that the caller still exists and is not banned; the local backend drops its cached credential on a 401/403. **⚠ Decided during Workstream 1's implementation, not in the S55 design conversation — review it.** | P4 promises that removing someone "propagates within the hour", but nothing in the design actually changed when access was withdrawn: `worldmonitor-org-gate` is a **before-user-created** hook, so it runs once at signup and dropping someone from the GitHub org never touches their Supabase user. A broker checking only "is this JWT valid?" would revoke nobody and the hourly re-fetch would be decorative. Alternatives rejected: re-checking live GitHub membership needs a stored GitHub token or a per-org PAT we don't have; an `org_members` table contradicts OQ-P3's explicit no-extra-tables stance for the admin flag. Membership itself needs no check — each org has its own project, so holding a live user in it *is* membership. | S56 |
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

- [ ] Copy **four** files into `worldmonitor/supabase/`, with the "upstream = platform @ &lt;sha&gt;" header. **S56 path correction** — they are not all in one place:
  - `platform/tools/supabase/functions/github-identity-bridge/{index.ts, register-provider.ts, deno.json}` (`deno.json` was missed in the S55 list)
  - `platform/tools/supabase/schemas/public/fn_link_bridge_identity_if_needed.sql` (**not** alongside the function)
- [ ] Per-project provisioning steps documented + scripted for Workstream 5 (generate RSA keypair, set 5 function secrets, `functions deploy --no-verify-jwt`, `db push`, `deno run register-provider`).

### Workstream 3 — per-operator LLM key modal (in `dashboard.html`, OQ-P4)

- [ ] A small modal **inside the dashboard** (fresh component, or a trimmed reuse of `settings-main.ts`'s AI category) — `OPENROUTER_API_KEY` / `GROQ_API_KEY` / `OLLAMA_API_URL` + `OLLAMA_MODEL`. Opened from a Settings affordance in the dashboard chrome — NOT a separate `settings.html` page.
- [ ] Stored per-operator in `config.db` (local) — NOT sent anywhere. `server/_shared/llm.ts` reads it.
- [ ] **No key → chat/summarize hard-disabled** (OQ-P5): `llm.ts` / `chat-analyst` return a clean "AI features need an API key" state; the dashboard hides/disables those affordances. No cloud LLM proxy.
- [ ] Everything else in `settings-main.ts` is admin-panel-only (Workstream 6).

### Workstream 4 — denylist mirror

- [ ] Replace `SYNC_PREFIXES` (the allowlist in `scripts/shared/sync-domains.mjs`) with a **three-state** classifier (P6): `classifyKey(key) → 'deny' | 'mirror' | 'mirror-filtered'`. A two-state `isMirrorableKey()` silently loses the `brief:` case below.
- [ ] `local-sync.mjs` full-rescan + `sync-listener.mjs` fast-path both consult it. `mirror-filtered` = rescan applies `keepKey()`; the fast path **never** pushes it (`sync:notify` is one global channel with no per-recipient filtering — the session-39 leak fix).
- [ ] Regression test: a fresh data prefix mirrors with no code change; a `brief:<other-uid>:*` / `*:token` / `forecast:simulation-task*` key never lands in the local mirror; the operator's **own** `brief:<uid>:*` still does.

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
- [ ] **Resolve OQ-P7 before writing the workflow.** `nitric-deploy.yml` today takes one `PRODUCTION_ENV_FILE` repo secret holding "Upstash, Supabase, provider API keys" — i.e. the 26 keys at *deploy time* — while P3 puts them in Supabase `pipeline_config`, edited live by an org admin. Those are two different homes for the same keys.
- [ ] GH Actions Environment per org — GCP creds (scoped to that project), Pulumi token, `SUPABASE_ACCESS_TOKEN` + project ref + DB password, Upstash write URL+token.
- [ ] `worldmonitor/supabase/` set up for the **Supabase CLI** (OQ-P2): `supabase/config.toml`, `supabase/migrations/*.sql` (`pipeline_config` + RLS + `fn_link_bridge_identity_if_needed`), `supabase/functions/{local-config,github-identity-bridge}/`.
- [ ] `.github/workflows/deploy-org.yml` — `workflow_dispatch(org)` → select Environment → `supabase link` → `supabase db push` → `supabase functions deploy --no-verify-jwt` (both fns) → set function secrets → `deno run register-provider.ts` → configure the org-gate auth hook → deploy the worker + admin panel to **Cloud Run** (OQ-P1) via `nitric up` / Pulumi (grow `nitric-deploy.yml`).
- [ ] Idempotent: re-running updates in place. "New org" runbook: create the Supabase project + Upstash DB + GCP project, add the GH Environment, run the workflow, then set the first admin's `app_metadata.wm_admin` (OQ-P3).

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
- [ ] Telegram / AIS / gpsjam: worker holds the socket, writes a rolling window to Upstash (P8); local `tauri-sidecar` routes become mirror reads. **Blocked on OQ-P6.**
- [ ] **`list-feed-digest` seeder — its own item, not a bullet in an audit** (S56). It has *no seeder at all*: it read-through-caches a live ~190-feed RSS crawl, which is the only reason the startup warm-ping at `local-api-server.mjs` ~line 2769 exists. "Move server-side" here means writing a **new seeder + schedule + Upstash key family**, not relocating existing code. Longest pole in this workstream; **unblocked today**, start it early.
- [ ] Work the remaining 21 direct-fetch handlers + 9 shared modules case by case → move server-side or accept degraded-offline. By domain: aviation (3), market (4), military (2), infrastructure (3), intelligence (3), economic, displacement, maritime, sanctions, imagery, research (1 each); shared: `aviation/_shared`, `cyber/_shared`, `market/_shared`, `trade/_shared`, `unrest/_shared`, `news/_feeds`, `economic/_bis-shared`, `military/_wingbits-aircraft-details`, `supply-chain/_bilateral-hs4-lazy`.
- [ ] `cloudFallback` — with a real per-org cloud origin now existing, decide whether operator backends may use it (probably still off; a miss = "not synced yet").

---

## Resolved sub-questions (session 55)

- **OQ-P1 → RESOLVED for the request-driven half; the scale-to-zero half re-opened S56 as OQ-P6.** Per-org worker on Cloud Run (scheduled pipeline runs via Cloud Scheduler → HTTP trigger). Not GKE, not an always-on VM. Verified S56: `nitric.gcp.yaml` does already target Cloud Run (`provider: nitric/gcp@1.27.6`, `config.default.cloudrun`, `min-instances: 0`) — so the scaffold and the decision agree. What does **not** hold is `min-instances: 0` for the persistent-socket services (P8).
- **OQ-P2 → RESOLVED: fully scripted in `deploy-org.yml`.** Review of current practice: the repo has **no Supabase-CLI migration setup**. The one migration precedent is `consumer-prices-core/` — plain numbered `migrations/NNN_name.sql` + a ~60-line forward-only runner (`src/db/migrate.ts`: `schema_migrations` tracking table, each file in a `BEGIN/COMMIT`, `pg` Pool via `DATABASE_URL`), run as `npm run migrate`. **Decision:** the deploy workflow needs the `supabase` CLI anyway for `functions deploy` + auth config, so use it for SQL too — `supabase/migrations/*.sql` (CLI convention) applied with `supabase db push`, `supabase/functions/*` with `supabase functions deploy --no-verify-jwt`, then `deno run register-provider.ts`. Per-org GH Environment holds `SUPABASE_ACCESS_TOKEN` + project ref + DB password. (The `consumer-prices-core` plain-`pg` runner is the CLI-free fallback if the CLI dependency proves painful.)
- **OQ-P3 → RESOLVED: `app_metadata`.** Admin = `app_metadata.wm_admin === true` (or `app_metadata.role === 'admin'`), set by repo devs — manual per org for now (small `admin.updateUserById` step; a management UI later if it grows). `pipeline_config` RLS checks it; the admin-panel gate checks it. No GitHub-team lookup, no `org_admins` table.
- **OQ-P4 → RESOLVED: operator bundle does NOT ship `settings.html`.** The per-operator LLM-key modal becomes a component **inside `dashboard.html`**. `settings.html` (+ the full `settings-main.ts` form) is admin-panel-only. Workstreams R + 3 updated below.
- **OQ-P5 → RESOLVED: hard-disable.** No LLM key configured → chat/summarize are disabled locally with a clean "AI features need an API key (Dashboard → Settings)" state. No cloud LLM proxy — that would re-create an org-tier key and outbound cost we're removing.

## Open sub-questions

### OQ-P6 — Cloud Run scale-to-zero vs. the persistent-socket services (opened S56)

P8 puts the Telegram/AIS sockets in the worker; OQ-P1 puts the worker on Cloud
Run at `min-instances: 0`. A process holding a socket cannot scale to zero.
`nitric.gcp.yaml` already carries the standing TODO:

> `min-instances: 0` means Cloud Run can scale them to zero between requests,
> which breaks a persistent connection.

Six services are long-running rather than request-driven: `ais-relay.cjs`
(websocket relay, `Dockerfile.relay`), `digest-notifications`,
`publish-bootstrap-tiers` (`--loop`), and the three BLMOVE/poll-loop consumers
`process-simulation-tasks` / `process-deep-forecast-tasks` / `scenario-worker`.

This is a **cost decision, not a technical one**, and it is the single place
where P1's "we carry the cost" meets a number: `min-instances: 1` is a standing
per-org charge multiplied by org count. Options: (a) accept a pinned
min-instances:1 relay tier per org; (b) drop the persistent-socket sources from
the platform tier; (c) run **one shared relay across all orgs** — it fetches
public AIS/Telegram, so the per-org isolation argument is materially weaker here
than for tenant data. **Decide before Workstream 5.**

### OQ-P7 — where the 26 data-source keys live at worker runtime (opened S56)

P3/P5 say Supabase `pipeline_config`, edited live by an org admin.
`nitric-deploy.yml` says a single deploy-time `PRODUCTION_ENV_FILE` secret. Both
cannot be true. If `pipeline_config` wins — and it should, or the admin panel is
decorative — then note the consequence: `config-store.mjs`'s own header records
**~600 `process.env.<KEY>` reads across the compiled `api/` route bundles**, none
of which can be rewritten to call an accessor. So the worker needs a startup +
periodic `pipeline_config → process.env` hydration, the exact mirror of
`loadConfigIntoEnv()`.

That in turn is a **user-visible contract P5 must state**: an admin's key edit
takes effect on the worker's next hydration (or restart), not immediately. Pick
the interval and say so in the panel.

---

## Session log

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
