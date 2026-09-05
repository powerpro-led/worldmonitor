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
- **Recommended order (S56):** ~~R → 1 → 4 → 2 → (7-seeder) → 3 → 5 → 6~~ (done, minus P14 Phase 2) → rest of 7 (incl. P14 Phase 2).

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
| **P9** | **`github-identity-bridge` = vendored copy per repo.** Copy `index.ts` + `register-provider.ts` + `fn_link_bridge_identity_if_needed.sql` into `worldmonitor/supabase/functions/github-identity-bridge/` (+ a migration). The multi-org deploy workflow deploys it to each tenant's Supabase project. Header comment marks `platform/tools/supabase/functions/github-identity-bridge` as upstream to sync from. **Revisit** (extract to a dedicated repo, both consumers pin a tag) only if the bridge starts changing more than ~quarterly. | The bridge is generic, env-parameterized, done ("live and verified", one bug fixed), and frozen. A shared repo + versioning + a Supabase-function consumption mechanism for a ~300-line stable file is speculative infra. Self-contained source keeps the deploy workflow a plain `supabase functions deploy` with no cross-repo checkout / submodule / PAT. It is inherently **per-tenant-project** anyway (issuer URL, per-project service-role key for identity pre-linking, registered in each project's auth config) — a single shared deployment is not an option. | S55 |
| **P10** | **Deploy = GitHub Actions `workflow_dispatch(org)` + per-org GH Environments.** One Environment per tenant holding our GCP creds scoped to that project, Pulumi token, that org's Supabase service key + ref, that org's Upstash write URL+token, domain. Non-secret per-org bits (region, variant, domain) in `deploy/orgs/<org>.yml`. | Environments give per-tenant secret isolation + required-reviewer gating for free. | S55 |
| **P11** | **`org.env` shrinks to two public values** — the org's `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY`. That's the irreducible bootstrap: a fresh operator backend must know *which* org's Supabase to authenticate against before it can call `local-config`. No Upstash creds, no data-source keys in it anymore. | Everything else is brokered post-login. | S55 |
| **P13** | **Revocation = ban or delete the operator's Supabase user.** The `local-config` broker verifies via service role, on every call, that the caller still exists and is not banned; the local backend drops its cached credential on a 401/403. **Decided during Workstream 1's implementation, reviewed and accepted S57.** | P4 promises that removing someone "propagates within the hour", but nothing in the design actually changed when access was withdrawn: `worldmonitor-org-gate` is a **before-user-created** hook, so it runs once at signup and dropping someone from the GitHub org never touches their Supabase user. A broker checking only "is this JWT valid?" would revoke nobody and the hourly re-fetch would be decorative. Alternatives rejected: re-checking live GitHub membership needs a stored GitHub token or a per-org PAT we don't have; an `org_members` table contradicts OQ-P3's explicit no-extra-tables stance for the admin flag. Membership itself needs no check — each org has its own project, so holding a live user in it *is* membership. **Review note (S57):** revocation is per-org-project — an operator moved between orgs must be banned in the OLD project explicitly, not just added to the new one, or their local mirror keeps refreshing against the org they left until the next hourly broker check. State this in the admin runbook. | S56, reviewed S57 |
| **P12** | **`v2.13.0` stays untagged, on hold.** The install mechanics (bundled Node, `curl\|sh`, service, CI) are done and tested, but the config UX the bundle currently ships (`settings.html` Backend section, `org.env` with Upstash creds, `/api/local-config`) is being replaced. Tag only after Workstreams 1–4 + R land. | Don't ship a dead-on-arrival config flow. Supersedes D12's "all four phases cohere" gate. | S55 |
| **P14** | **No pinned instances in a per-org deploy. Resolves OQ-P6.** (a) **AIS WebSocket ingest** (`wss://stream.aisstream.io`, the ONE genuinely persistent connection in the stack) runs as **one shared service across all orgs** — public vessel data, identical for every tenant — fanning parsed output into each org's Upstash via that org's write token. New standalone deploy target (own GCP service, own GH Environment, own `AISSTREAM_API_KEY`, a registry of `{org → upstash write url+token}`). (b) **Everything else that was "long-running"** becomes scheduled at `min-instances: 0`, per org: `digest-notifications` → Cloud Scheduler job; `publish-bootstrap-tiers` → two Cloud Scheduler jobs (2m/10m); `process-simulation-tasks` + `process-deep-forecast-tasks` + `scenario-worker` → **one merged `queue-worker.mjs`**, scheduled `--once` (both flows are already async pending→poll, so queue latency ~1–2m is fine); `ais-relay.cjs`'s **28 `startBootSeedLoop` seed/warm-ping loops** → entries in `gcp/scheduler/main.ts`'s `CADENCES` map (many already there or shadowed as "ais-relay backup"); **Telegram MTProto poller** → scheduled `--once` + a Redis lock (concurrency 1, or `AUTH_KEY_DUPLICATED`). (c) **Phasing:** Phase 1 (ships with W5) does digest/bootstrap/queue-worker; `ais-relay.cjs` runs unchanged as a single pinned `min-instances:1` **per org** as a stopgap. Phase 2 (overlaps W7) decomposes `ais-relay.cjs` — 28 loops → `CADENCES`, extract the ~150-line WS core → the shared service, extract Telegram → scheduled. End state: **0 pinned per org.** | The "6 long-running services" were an artifact of Railway's "a container is a container" model — under inspection they are 1 WebSocket + ~30 timer loops + 3 async queue drains. Cloud Run + Cloud Scheduler (OQ-P1) is built to separate those. Sharing the AIS ingest is the one place cross-tenant coupling enters, and it is acceptable *because* the data is public and identical — the per-org-isolation argument that holds for tenant data is materially weaker here. | S57 |
| **P15** | **Every WorldMonitor object in a tenant's Supabase project lives in a dedicated `worldmonitor` schema, never `public`.** Corrects W1/W2, which had put `pipeline_config` + `wm_is_admin()` + `link_bridge_identity_if_needed()` in `public` with no explicit schema decision ever recorded. Applies to every future table/function/trigger this repo adds to a tenant project. **Schema exposure IS scriptable, folded into the migration itself** — `alter role authenticator set pgrst.db_schemas = 'public, worldmonitor'; notify pgrst, 'reload schema';`, confirmed live against a real hosted Supabase project (S57): before it, a REST call against the new schema 404s `PGRST106 "Invalid schema"`; the schema-cache reload notify is separately required or a freshly-migrated table 404s `PGRST205` even once the schema itself is exposed. No dashboard/Management-API step needed, contrary to what W1/W2's provisioning notes originally assumed. | (1) Matches the convention the pre-pivot single-tenant fork already uses (see the `supabase-worldmonitor-schema-access` memory note) — one convention, not two. (2) Keeps `public` free for a tenant project to someday host a sibling product's schema (e.g. `platform`) without collision, if a project is ever shared rather than fully dedicated. (3) A schema outside `public` gets NONE of Supabase's default grants — forces every grant to be explicit rather than incidental, the same lesson that memory note already learned the hard way once. | S57 |

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
- [~] **Decompose `ais-relay.cjs` (P14 Phase 2) — IN PROGRESS, started S61.** 28 `startBootSeedLoop` seed/warm-ping loops → `gcp/scheduler/main.ts` `CADENCES` entries (map each against what's already registered/shadowed there first — the file already lists several as "ais-relay backup"). Extract the ~150-line AIS WS core → the shared ingest service. Extract the Telegram MTProto poller → scheduled `--once` + Redis lock. `tauri-sidecar` `telegram-feed` / `gpsjam` routes become mirror reads. End state: the per-org deploy has 0 pinned instances.
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
      - **Remaining after S63 (6):** CorridorRisk + ShippingStress (notification migration — next); Classify (notification tier, own session); Transit + TransitSummary (blocked on the in-process-AIS decision above); Market (needs `seed-sector-summary.mjs`). **21 of 27 loops out.**
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
