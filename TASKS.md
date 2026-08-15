# Open Work Tracker

Single source of truth for deferred/flagged work that survived the public-product-surface and
Convex/SaaS retirements (2026-08-11 → 2026-08-12). Purpose: so a long-running or future session
can pick one item cold without re-deriving context or re-investigating things that were already
confirmed pre-existing.

**Rule:** when you pick up an item, flip its checkbox and add a one-line "resolved: <how, commit>"
note under it. Don't delete resolved items — leave the trail. Add new deferred work here instead
of only writing a memory file, so it doesn't require a memory search to rediscover.

Related Claude memory entries (fuller narrative/context per item):
`retire_public_product_surface.md`, `retire_convex_saas_complete.md`, `domain_migration_scope.md`
(the item just below).

---

## ✅ Resolved 2026-08-15 (fifteenth session) — domain-literal eradication + second SaaS-cruft removal pass

**Picked up cold exactly as handed off — operator confirmed the fourteenth session's local commits
(`30c89d7`/`e677abb`) had already been pushed manually, then said "continue" to execute this
plan in full.** Executed the removal pass, all named functional gaps, and the mechanical test
sweep, in the order this entry originally specified. **Not committed** — holding per this entry's
own stated discipline ("nothing gets committed or pushed without fresh explicit go-ahead"); ask
before committing.

**Removal pass — all 4 operator decisions + all "also approved" items executed, one plan
correction found along the way:**

- Story/social-share cards removed (`api/story.js`, `api/og-story.js`, `StoryModal.ts`,
  `story-share.ts`, the whole share-button/dialog wiring chain across `event-handlers.ts`,
  `panel-layout.ts`, `App.ts`, `CIIPanel.ts`, `CountryDeepDivePanel.ts`). **`story-renderer.ts` and
  `story-data.ts` deliberately kept, not deleted** — tracing every call site found they're also used
  by the separate, kept "Export Image" feature on the Country Brief panel; only the watermark
  literal in `story-renderer.ts` was migrated to `APP_DOMAIN`, matching this entry's original
  "story-renderer.ts watermark" phrasing exactly.
- Public no-auth brief links removed (`api/brief/public/[hash].ts`, `api/brief/share-url.ts`,
  `server/_shared/brief-share-url.ts`). The kept `api/brief/[userId]/[issueDate].ts` needed a real
  edit too, not just "unaffected" — it was eagerly minting the same public-share Redis pointer and
  rendering a Share button on every view; left alone it would have kept writing dead pointers and
  shipped a button linking to the now-404'd public route.
- Embeddable widget removed (`src/embed/`, `embed-main.ts`, `embed.html`, the "Embed" button/dialog).
  Also found and removed a parallel Docker nginx security-header surface for `/embed` this entry
  didn't name (`docker/nginx-embed-security-headers.conf` + two `nginx.conf`/`nginx.conf.template`
  location blocks + a Dockerfile `COPY` line), and fixed a Vite chunk-splitting side effect (removing
  the `embed.html` entry point caused an unrelated premium-fetch data file to get inlined into
  `main.js`, tripping the eager-chunk-budget guard — fixed with a new stable `manualChunks` rule,
  not by re-adding the entry point).
- `api/download.js` + `DownloadBanner.ts` + desktop-updater.ts's Tauri-download references removed;
  the still-live update-check-and-toast mechanism deliberately preserved.
- Sandbox API-console demo removed (`public/sandbox/*.json`, `index.json`,
  `scripts/generate-sandbox-fixtures.mjs`).
- **Plan correction: `public/agent.txt` kept, not deleted.** Investigation found it's live,
  load-bearing infrastructure for the kept `api/ask.ts`/`api/a2a.ts` NLWeb/A2A discovery
  endpoints — their own code comments say it was deliberately chosen as their docs pointer after
  the Mintlify docs site was removed, and two test suites assert on that wiring. Deleting it would
  have broken two kept, live endpoints. `public/home.md` deleted as planned (no live dependents,
  and it already referenced other already-dead `.well-known/*` paths).
- Stale `pro-test/` references cleaned up beyond the two files this entry named — also found and
  fixed `biome.json`'s dangling lint-config entry, a stale `tests/deploy-config.test.mjs` comment
  block, and two "keep in sync with pro-test/..." maintenance comments in `src/App.ts` and
  `src/bootstrap/debugbear-rum.ts`.
- **Found and removed one item this entry never listed: `e2e/embed.spec.ts`**, an orphaned e2e spec
  for the embed feature, missed by the initial embed removal and only caught while auditing
  `e2e/*.spec.ts` for the mechanical sweep.

**Functional gaps — all fixed, each verified individually before moving on:**

- `scripts/ais-relay.cjs`: CORS allowlist now derived from `buildAllowedOriginPatterns()` (matching
  `api/_cors.js`'s exact pattern) instead of a hardcoded array; 5 RPC-URL consts, an OpenRouter
  `HTTP-Referer`, a warm-ping `Origin` header, and 2 external-API User-Agent strings all migrated.
  Required building new infrastructure first: `scripts/_domain-config.cjs`, a new generated target
  in `scripts/sync-domain-config.mjs` that mechanically transforms `shared/domain-config.js`'s ESM
  source into CommonJS (verified via `require()` sanity checks) — `ais-relay.cjs` and
  `notification-relay.cjs` are both CJS and can't `require()` an ESM file directly.
  `Dockerfile.relay` needed a new `COPY` line for it, caught by the repo's own
  `tests/dockerfile-relay-imports.test.mjs` transitive-import-closure guard, not by inspection.
- `scripts/notification-relay.cjs`: `RESEND_FROM` fallback, VAPID subject, and 4 notification-URL
  fallbacks migrated. Confirmed (but did not fix) that this script is not wired into any Railway
  deployment mode in `scripts/railway-services.json` — flagged as a separate, pre-existing
  discovery, not touched further.
- `src/bootstrap/web-vitals-utils.ts:65`: SSR-fallback base URL now uses `APP_ORIGIN` from
  `@/config/domain`.
- Scraper identity strings in `scripts/regional-snapshot/*`, `scripts/china-macro/*`,
  `scripts/lib/*`: 5 files migrated (OpenRouter `HTTP-Referer` headers, `WorldMonitor/2.10
  (+https://...)` User-Agent strings sent to OECD/NBS-China/ChinaMoney). No documented
  brand-substring-rejection history exists for any of these targets (unlike the HDX HAPI case) and
  only the URL suffix changed, not the "WorldMonitor" brand token itself, so this was lower-risk
  than the "check every target" caution implied — still checked each one individually before
  editing. `Dockerfile.digest-notifications` needed the same new `COPY scripts/_domain-config.cjs`
  line as `Dockerfile.relay`, caught by `tests/dockerfile-digest-notifications-imports.test.mjs`.
- `docker/Dockerfile` + `docker/docker-entrypoint.sh`: `VITE_WS_API_URL` build-arg default changed
  from `https://api.worldmonitor.app` to empty (matching `.env.example`'s own documented
  same-origin-when-empty convention). `API_UPSTREAM`'s runtime default changed from silently
  pointing at `api.worldmonitor.app` to **failing loudly** unless `API_UPSTREAM` or `APP_DOMAIN` is
  set — a real, deliberate behavior change (self-hosters relying on the old silent default now get
  an explicit startup error instead of a wrong backend proxy target). Confirmed this doesn't affect
  `docker-compose.yml`'s default `docker compose up` path, which builds from the separate root
  `Dockerfile` (bundled local API server, no `API_UPSTREAM` involved at all).
- `e2e/*.spec.ts`: built the `TEST_APP_DOMAIN`-equivalent wiring this entry called for —
  `playwright.config.ts`'s `webServer.env` now pins `APP_DOMAIN` to
  `tests/helpers/domain-config.mjs`'s `TEST_APP_DOMAIN` for the dev server e2e tests run against,
  so specs stay deterministic regardless of the local machine's real `.env`. Migrated the literal
  values in `e2e/runtime-fetch.spec.ts` and `e2e/secondary-startup.spec.ts` to match. Verified with
  a real Playwright run (22/23 pass; the 1 failure confirmed pre-existing via `git stash` A/B,
  unrelated `fetchHapiSummary` bug).

**Mechanical test sweep — 68 of ~73 candidate files migrated to `TEST_APP_DOMAIN`-equivalent
literals; the exclusions matter as much as the migration:**

- Confirmed-excluded per this entry: `tests/sentry-beforesend.test.mjs`,
  `tests/variant-meta-index-html-drift.test.mts:21`.
- Also excluded: `tests/cors-preflight-live.test.mjs` and `tests/live-api-cache-auth-regression.test.mjs`
  (both `LIVE_SMOKE`/`LIVE_API_CACHE_TESTS`-gated tests that deliberately hit real production
  infrastructure, not test fixtures — migrating their literals to a fake `example.test` domain
  would silently break their actual purpose) and `tests/browser-bundle-secret-guard.test.mts` (one
  of the pre-existing-failure baseline suites — left untouched to avoid muddying that baseline).
- **The real risk in this sweep wasn't the migration itself, it was files that assert against REAL,
  not-yet-migrated repo files** (`vercel.json`, `index.html`, `public/agent.txt`,
  `public/wm-widget-sandbox.html` — all still-parked, real-infra-provisioning-blocked literals per
  the "Parked" section below). Found and deliberately reverted 4 such assertions in
  `tests/widget-builder.test.mjs` (reads `wm-widget-sandbox.html`'s real source) and
  `tests/deploy-config.test.mjs` (reads `agent.txt` and `vercel.json`'s real content) — migrating
  those would have made the tests assert something false about files this pass never touched.
  `tests/secondary-startup.test.mts` (the `tests/` unit test, not the same-named e2e spec) needed
  no changes at all for the same reason — it already correctly reads real `index.html`/`vercel.json`.
- **A second real gotcha, caught only by running the full suite twice: plain-string fixture values
  and their paired regex/RegExp assertions don't always get swept together.** A literal search for
  `worldmonitor.app` correctly skips regex literals that escape the dot (`worldmonitor\.app` or
  `worldmonitor\\.app` inside a template string for `new RegExp(...)`) — but 5 of those escaped
  occurrences were the *assertion* half of a pair whose *input* half I'd already migrated, so the
  first full-suite run surfaced 3 new failures (`brief-url.test.mjs`, `brief-url-sign.test.mjs`,
  `resend-sender-normalize.test.mjs`) plus a 4th file (`crawlable-corpus.test.mjs`, 7 occurrences)
  found by the same targeted re-check before it could fail. Fixed all of them, then reran the full
  suite twice more to confirm — both runs landed on the exact same 40-failure/7-suite baseline as
  every prior verification this session.

**Full verification, run repeatedly at each stage and once more at the very end**: `typecheck:all`
(0 errors throughout), real `npm run build` (confirmed the right dist chunks appear/disappear at
each removal step), `docs:check` (fixed 3 rounds of stale component/service counts in
`AGENTS.md`/`CONTRIBUTING.md` as files were deleted), `lint:md` (clean except the same 4
pre-existing `TASKS.md` formatting errors, present before this session and untouched by it),
`sync:domain-config:check` / `sync:domain-literals:check` (clean — the latter's stale-file report
is unchanged from before this session: `vercel.json`, `docker/nginx-security-headers.conf`,
`docker/nginx.conf`, `public/wm-widget-sandbox.html`, `index.html`,
`shared/hapi-app-identifier.json`, `scripts/shared/hapi-app-identifier.json` — all still genuinely
parked, real-infra-decision territory, confirmed via `git stash` A/B that this session introduced
zero new drift there), `enforce-sebuf-api-contract.mjs` (clean), full `npm run test:data` (run 4
times across the session at major checkpoints, landed on the exact documented 40-failure/7-suite
baseline every time: `readBootstrapTierObject`, `Bootstrap endpoint`, `browser bundle secret guard`,
`CI workflow coverage`, `Edge Function no node: built-ins`, `no non-timing-safe secret comparison`,
`Railway service registry coverage`), `npm run test:sidecar` (210/211, same pre-existing
dev-machine port conflict as every prior session).

**Genuinely still open, not touched this session** (matches this entry's original "leave alone"
list plus what's newly confirmed parked): the 7-file `sync:domain-literals:check` stale-literal
report above (real infra decision needed — see the 🅿️ Parked section); `scripts/notification-relay.cjs`
not being wired into any Railway deployment mode (discovered, not diagnosed further — separate from
domain literals); `.env.example`, `data/resilience-snapshots/*.json`,
`scripts/seed-digest-notifications.mjs`'s email-template HTML branding (all explicitly deferred, as
before).

---

<details>
<summary>Original plan text (superseded by the resolution above, kept for the record)</summary>

**Fourteenth session (2026-08-14), planned via EnterPlanMode with 2 parallel Explore-agent
inventories + 4 explicit operator decisions, then execution deferred to a fresh session
("let's transfer to next new session's agent") — READ THIS BEFORE STARTING WORK ON DOMAIN
LITERALS OR ANY FURTHER SAAS-SURFACE REMOVAL, the decisions below are already made, don't
re-ask.** Full plan detail lives at `/Users/john/.claude/plans/dreamy-stargazing-dove.md` (local,
not git-tracked, may not survive to a new machine/session — this TASKS.md entry is the durable
copy, treat it as authoritative if the two ever disagree).

**Why**: operator looked at the result of the Tauri/CLI/CORS-Worker/agent-discovery removal
(above) and flagged two more things wrong: (1) 734 hardcoded `worldmonitor.app` literals across
151 files — should be brand-agnostic/`APP_DOMAIN`-driven throughout, not just the ~16 files
`scripts/sync-domain-literals.mjs` already covers; (2) more public/growth-product SaaS surface
remains beyond what prior sessions already cut.

**4 operator decisions already made — do not re-ask, just execute**:

- Story/social-share cards (`api/story.js`, `api/og-story.js`, `src/services/story-renderer.ts`
  watermark, `StoryModal.ts`) → **REMOVE**.
- Public no-auth brief links (`api/brief/public/[hash].ts`, its share-URL helper) → **REMOVE**.
  Keep `api/brief/[userId]/[issueDate].ts` (real signed-in digest delivery, unaffected).
- `api/ask.ts` (NLWeb endpoint, external-agent tool discovery) → **KEEP**, consistent with the
  already-kept MCP/A2A/OAuth surface (same shape, just wasn't named explicitly in the earlier
  decision).
- Embeddable widget product (`src/embed/`, `embed-main.ts`, `embed.html` Vite entry, "Get embed
  code" button) → **REMOVE**. Do NOT touch `api/widget-agent.ts` or `public/wm-widget-sandbox.html`
  — both confirmed unrelated despite the name collision (AI-widget-builder dashboard proxy, and a
  security-sandbox iframe, respectively — both load-bearing, both KEEP).

**Also approved as part of the same removal pass** (evidence-based, high-confidence, not asked
as separate questions): `api/download.js` + `DownloadBanner.ts` + the `desktop-updater.ts`
Tauri-download references (dead — points at deleted Tauri release artifacts);
`public/sandbox/*.json` and `index.json` and `scripts/generate-sandbox-fixtures.mjs` (public
API-console demo, zero real callers); `public/agent.txt` + `public/home.md` (bucketed with the
already-removed `.well-known/*` discovery surface — **but read both files first** to confirm
`home.md` isn't
load-bearing homepage copy for the kept core web app before deleting, this one wasn't explicitly
confirmed by the operator); stale `pro-test/` references in `AGENTS.md` and
`scripts/translate-locales.mjs`'s dead `--pro-test` flag (the directory itself was already deleted
pre-tracker, this is just cleanup of dangling mentions).

**Domain-literal eradication scope** (full detail + file-by-file inventory in the plan file):
real functional gaps to fix individually first (`scripts/ais-relay.cjs` — 18 hits, includes a
literal CORS allowlist, highest stakes in the whole sweep; `scripts/notification-relay.cjs`;
`src/bootstrap/web-vitals-utils.ts:65`; HTTP-Referer/User-Agent identity strings in
`scripts/regional-snapshot/*`/`scripts/china-macro/*`/`scripts/lib/*` — check each target API for
HDX-HAPI-style brand-substring rejection quirks before migrating, not blind find/replace;
`docker/Dockerfile` + `docker/docker-entrypoint.sh`; `e2e/*.spec.ts`, which needs a new e2e-side
`TEST_APP_DOMAIN`-equivalent helper since none exists yet), then the big mechanical sweep (~250+
hits across ~65 test files bypassing the already-established `tests/helpers/domain-config.mjs`
pattern — do as a small codemod, not 65 manual edits; explicitly exclude
`tests/sentry-beforesend.test.mjs` and `tests/variant-meta-index-html-drift.test.mts:21`, both
deliberately-literal for good reasons). Leave alone: docs prose, `.env.example`,
`data/resilience-snapshots/*.json` (frozen data-provenance records), and the
`seed-digest-notifications.mjs` email-template HTML branding (already deferred by a prior
session as "a separate and sizeable area" — stays deferred).

**Ordering**: do the removal pass first (shrinks the literal-migration surface — e.g.
`story-renderer.ts`'s literal disappears entirely rather than needing migration), then the
individual functional-gap fixes, then the mechanical test sweep last.

**Verification**: same discipline as the fourteenth-session removal pass above — typecheck,
build, docs:check, lint:md, full `test:data`, `git stash` A/B against `HEAD` (currently `e677abb`)
to separate new regressions from the 8 already-confirmed-pre-existing failures. Nothing gets
committed or pushed without fresh explicit go-ahead — the current holding pattern (commits
`30c89d7`/`e677abb` local-only on `main`, GitHub Actions disabled repo-wide for
`powerpro-led/worldmonitor`) carries forward unchanged; don't push or re-enable Actions as a side
effect of this work either.

</details>

---

## 🚧 IN PROGRESS — scope-down to VS Code dashboard + data pipeline only

**Operator decision (2026-08-14, twelfth session): this fork's real product is the VS Code
dashboard + the cloud→local data pipeline. Tauri desktop app, the published CLI, the Cloudflare
CORS Worker, the static SEO/agent-discovery surface, and most of `.github/workflows/` are NOT
being kept.** Verified against actual cross-references before agreeing to anything (not just taking
the premise at face value) — see the table this session worked out:

- **Keep**: `vscode-extension/`, `vscode-extension/sidecar/*` (dashboard engine + the cloud→local
  pipeline — `local-sync.mjs`), the core web app (`src/`, `api/`, `server/`), generic CI
  (`test.yml`, `typecheck.yml`, `lint*.yml`, `security-audit.yml`, `proto-check.yml`,
  `contributor-trust.yml`, `deploy-gate.yml`), and the workflows that watch/deploy the *cloud* side
  the local sync pulls from (`nitric-deploy.yml`, `seed-freshness-monitor.yml`,
  `analytics-collector-monitor.yml`, `mcp-live-smoke.yml`, `feed-validation.yml`,
  `live-api-cache-auth.yml`). `docker-publish.yml` probably keep (publishes the self-hostable
  server image on release) — not fully confirmed, ask before dropping it.
- [x] **Remove pass — DONE thirteenth session (2026-08-14), COMMITTED fourteenth session, NOT
      YET PUSHED — see the fourteenth-session handoff bullet below for current state.**
      Deleted exactly the enumerated set: `src-tauri/` (Rust app, all 3 `tauri.*.conf.json`,
      icons, `sidecar/node/`), `cli/`, `workers/api-cors-preflight/`, `public/.well-known/{agent-
      card.json, ai-catalog.json, api-catalog, webhook-sample.json, agent-skills/}` (`security.txt`
      deliberately spared — unrelated RFC 9116 file, not on the list), `public/{sitemap.xml,
      robots.txt, schemamap.xml}`, and `.github/workflows/{build-desktop,test-linux-app,
      deploy-worker,publish-cli}.yml`.
      **This alone would have broken the build/CI** — the real blast radius was bigger than this
      section's shorthand implied, since it's wired into more than static file references:
      - `npm run build`'s `prebuild`/`build` chain actively *generated* content into two of the
        deleted paths (`agent-skills/index.json`, `sitemap.xml`), not just read them — fixed by
        dropping `build:agent-skills`/`build:content-corpus` from `package.json`'s script graph
        (`scripts/build-agent-skills-index.mjs` deleted outright; `build-content-corpus-sitemap.mjs`
        left in place — its exports are still tested by pure-function fixture tests — just unwired
        from the npm build chain since its real target file is gone).
      - Both `Dockerfile` and `docker/Dockerfile` directly `RUN npm run build:content-corpus` —
        would have broken every Docker image build. Fixed.
      - `.husky/pre-push` (every future local `git push`) and the *kept* `lint-code.yml` CI workflow
        both unconditionally ran `npm run version:check` (→ `scripts/sync-desktop-version.mjs`,
        reads `src-tauri/tauri.conf.json`) — would have hard-failed every push/CI run on this repo
        from now on. Fixed (`sync-desktop-version.mjs` + `desktop-package.mjs` deleted outright,
        all `desktop:*`/`build:desktop`/`tauri` npm scripts and the `@tauri-apps/cli` devDependency
        removed — but NOT `build:sidecar-sebuf`/`build:sidecar-handlers`, which the docstrings
        mislabel "Tauri sidecar" but actually the *kept* `vscode-extension/sidecar/` still needs;
        added a standalone `build:sidecar-handlers` npm script since it previously only existed
        inline inside the now-deleted `build:desktop`, which would have stranded it entirely).
      - `tests/live-news-hls.test.mjs` (a live-channel/HLS test, unrelated in subject) read
        `src-tauri/tauri.conf.json` at module load — would have crashed the whole file. Fixed by
        dropping only its two Tauri-CSP assertions; everything else in that file is real and kept.
      - `scripts/sync-domain-literals.mjs` had `src-tauri/tauri*.conf.json` in its rewrite target
        list plus an entire Tauri-bundle-identifier substitution subsystem
        (`TAURI_BUNDLE_ID_BRAND`/`LEGACY_BUNDLE_BRAND`) with zero remaining targets — removed the
        whole subsystem and the stale `.env.example` entry documenting it.
      - `vercel.json`: dropped the `/schemamap.xml` and `/.well-known/api-catalog` headers rules
        and the `api-catalog`/`agent-skills-index` `Link` header rel entries (3 duplicate spots).
        Left the `.well-known/*` rewrites (`oauth-*`, `mcp`, `http-message-signatures-directory`)
        and the SPA catch-all's `robots.txt`/`sitemap.xml`/`schemamap.xml`/`.well-known` exclusions
        untouched — those serve **live** dynamic routes unrelated to the deleted static files
        (confirmed via `tests/*.test.mjs` triage, not assumption), and removing the catch-all
        exclusions would have made now-404-correct paths silently serve the dashboard HTML instead.
      - Tests gutted/updated for the deleted files: `tests/a2a.test.mjs` (kept the live
        `api/a2a.ts` JSON-RPC endpoint tests, dropped only the agent-card.json-dependent half),
        `tests/agent-skills-index.test.mjs` (deleted outright — 100% about the deleted dir/script),
        `tests/deploy-config.test.mjs` (the big one — removed/trimmed ~7 describe blocks tied to
        `robots.txt`/`sitemap.xml`/`schemamap.xml`/`api-catalog`/`ai-catalog.json`, kept the
        `variant subdomain dashboard SEO` and crawlable-corpus pure-function blocks, which are
        unrelated).
      - Docs updated for accuracy (not CI-enforced, but was live-false otherwise): `ARCHITECTURE.md`
        (topology diagram/table, CSP source count, CI/CD table, directory tree — flagged
        `src/services/tauri-bridge.ts`+`runtime.ts` as deliberately-unpruned dead Tauri-IPC
        feature-detection code, out of scope for a file/config pass), `AGENTS.md`, `README.md` +
        `README.zh-CN.md` (dropped the CLI section and desktop-app bullets/rows), `CONTRIBUTING.md`.
      **Verified**: every edited/new script passes `node --check`; `package.json`/`vercel.json`
      parse as valid JSON; `sync-domain-literals.mjs --check` runs to completion (no crash — the
      stale-literal report it prints is pre-existing drift from the separate domain-migration work
      in `domain_migration_scope.md`, not something this pass introduced). `npm run typecheck`,
      `npm run build`, `npm run docs:check`, and `npm run lint:md` all pass clean. Full `npm run
      test:data` (13,876 tests) run twice — before and after fixes — via a `git stash` A/B against
      unmodified `HEAD`: found 2 real regressions this pass caused (`tests/cli-package.test.mjs` and
      `tests/agent-skills-index.test.mjs`, both 100% about deleted code — deleted outright) plus one
      more file needing surgery (`tests/cors-fail-closed.test.mts` — trimmed the Worker-only
      `describe` block and the Worker entry from its `TWINS` parity array, kept the rest, which
      tests the still-live `server/cors.ts`/`api/_cors.js` twins). The remaining 8 named failures
      (`readBootstrapTierObject`, `Bootstrap endpoint`, `browser bundle secret guard`, `CI workflow
      coverage`, `Edge Function no node: built-ins`, `no non-timing-safe secret comparison`,
      `Railway service registry coverage`, `renewable energy last-known-good recovery`) fail
      identically on unmodified `HEAD` — confirmed pre-existing, not this pass's concern.
      **Not done, deliberately out of scope for this pass**: the `src/services/tauri-bridge.ts` +
      `runtime.ts` dead-code prune (real app source, not a file/config removal — flagged, not
      touched), and the `docker-publish.yml` question from the Keep list above (left as keep,
      per the prior session's "probably keep" note — never asked about dropping it this session).

- [x] **Fourteenth session (2026-08-14) — committed, push deliberately deferred, GitHub Actions
      disabled repo-wide, both on explicit operator instruction. READ THIS FIRST if you're picking
      up cold.**
      Committed the full thirteenth-session removal pass (above) together with the prior sessions'
      already-verified-but-still-uncommitted domain-config sweep (Stage 2/3 below) as a single
      commit — **`30c89d7`** on local `main`, since the two bodies of work had already accumulated
      interleaved in the same uncommitted working tree (many of the same files touched by both;
      a clean line-level split wasn't practical without risky hunk-by-hunk surgery). `main` is now
      **5 commits ahead of `origin/main`, 0 behind**.
      **Push attempted, hit a transient `git push` failure** (`Error in the HTTP2 framing layer`,
      then `Empty reply from server` on retry with `http.version=HTTP/1.1`) — before it could be
      isolated as transient-vs-real, the operator said **"push later"** — so the commit is
      deliberately sitting local-only. Don't assume the HTTP2 error is still live; just retry
      `git push origin main` (plain, no special flags) when told to push, and re-diagnose only if
      it still fails.
      **GitHub Actions disabled repo-wide** for `powerpro-led/worldmonitor` (operator: *"we need to
      stop all github actions for now since we are currently on big refactor"*) via `gh api -X PUT
      repos/powerpro-led/worldmonitor/actions/permissions -F enabled=false` (note `-F` not `-f` —
      the endpoint wants a typed boolean, `-f` sends a string and 422s). Verified via a follow-up
      GET: `{"enabled":false,...}`. This is a single account-level switch — blocks every trigger
      (push, PR, manual dispatch, and all cron schedules: `seed-freshness-monitor.yml`/
      `analytics-collector-monitor.yml` every 15 min, `mcp-live-smoke.yml`/`live-api-cache-auth.yml`
      every 6 hr, `security-audit.yml`/`feed-validation.yml` daily) — not a per-workflow disable.
      Checked `gh run list` first: nothing was in-flight, so nothing needed cancelling.
      **Both the push and re-enabling Actions need fresh explicit operator go-ahead** — do not do
      either unprompted just because this note exists. To re-enable: `gh api -X PUT
      repos/powerpro-led/worldmonitor/actions/permissions -F enabled=true` (restores default `"all"`
      `allowed_actions`; re-verify with a GET after).

- [x] **`src-tauri/sidecar/` moved to `vscode-extension/sidecar/` — DONE this session,** ahead of
      the full removal, since the dashboard engine (`local-api-server.mjs`) and the data pipeline
      (`local-sync.mjs`) both lived there and needed to survive `src-tauri/`'s eventual deletion.
      Moved via `git mv` (history preserved for the 4 tracked files) +
      plain `mv` for `local-cache.db` (gitignored) and `_domain-config.mjs` (untracked, generated).
      **Deliberately left behind**: `sidecar/node/` (only a `.gitkeep` is tracked — the real binary
      is downloaded at Tauri-build CI time; the VS Code extension already spawns via
      `process.execPath`, confirmed it never touches this, so it's genuinely Tauri-only and will go
      with the rest of `src-tauri/` next session).
      **7 functional references updated** (verified via a full repo grep for the literal old path,
      not just the obvious file): `vscode-extension/src/sidecarProcess.ts` (the spawn path
      itself), root `package.json` (`local-sync` + `test:sidecar` scripts), `.gitignore`,
      `scripts/sync-domain-config.mjs` (this session's own generated-copy target),
      `tests/live-news-hls.test.mjs` (cross-checks the sidecar source against `vercel.json`'s and
      `tauri.conf.json`'s CSP — real coupling, not just a mention), and `src-tauri/tauri.conf.json`'s
      `bundle.resources` (pointed outward to `../vscode-extension/sidecar/...` so the *still-present*
      Tauri build doesn't 404 in the interim before next session's removal).
      **Also caught and fixed a real regression while touching `tauri.conf.json` again**: this
      session's own earlier fix (`sidecar/_domain-config.mjs` added to `bundle.resources`) had been
      silently wiped out by a `git checkout HEAD --` run during an unrelated incident-recovery
      earlier tonight (that fix was never committed, so restoring to `HEAD` quietly reverted it
      too) — re-added it as part of this move.
      ~9 doc/comment mentions also updated for consistency (`AGENTS.md`, `ARCHITECTURE.md` — both
      tree diagrams too, `vscode-extension/README.md`, `vscode-extension/package.json`,
      `vscode-extension/esbuild.js`, `server/_shared/sidecar-cache.ts`, the moved
      `local-sync.mjs`'s own self-reference). **Deliberately left alone**: `TASKS.md`'s own older
      entries (historical record, not rewritten) and `.github/workflows/build-desktop.yml`'s
      `test -f src-tauri/sidecar/node/node[.exe]` checks (correct as-is — `node/` didn't move).
      **Verified**: all 3 moved `.mjs` files pass `node --check`; `npm run sync:domain-config:check`
      clean; `npm run test:sidecar` 217/217 (the previously-flaky port-binding test happened to pass
      clean this run too); `tests/live-news-hls.test.mjs` 50/50; `vscode-extension`'s own `tsc
      --noEmit` clean; a final repo-wide grep for the literal old path found zero remaining stale
      references outside the two intentional exceptions above. **Live-verified too, not just
      tests** — operator reloaded the actual running dashboard and it loaded correctly after one
      real deployment gotcha (see next item).

- [x] **Sharp edge hit and fixed while live-verifying the move: `npm run build` alone does NOT
      update the running extension.** VS Code doesn't load `vscode-extension/dist/` from the repo
      checkout directly — it runs a separately-*installed* copy at `~/.vscode/extensions/
      worldmonitor-internal.worldmonitor-local-dashboard-0.1.0/`. Rebuilding the repo's `dist/` and
      reloading the window still ran the stale (4-days-old, pre-move) installed bundle — confirmed
      by grepping the installed copy's `dist/extension.js` for the literal old path and finding it.
      **The actual fix needs both steps**: `npm run package` (runs `vsce package`, produces a fresh
      `.vsix`) then `code --install-extension <file>.vsix --force` to overwrite the installed copy
      — `npm run build` is necessary but not sufficient. **Next session should remember this** —
      any further `vscode-extension/` source changes (including parts of the removal work) need the
      same package+reinstall cycle to actually take effect for live testing, not just a rebuild.
      **Minor side effect noticed, not fixed**: packaging now bundles `vscode-extension/sidecar/*`
      (including the 4.4MB `local-cache.db`) straight into the `.vsix`, since the sidecar physically
      lives inside `vscode-extension/`'s own folder now (it didn't before this session's move, so
      this never happened previously). Harmless — the extension reads the sidecar from the live
      repo checkout at runtime via `repoRoot`, never from its own bundled copy — just wasted package
      size. Worth a `.vscodeignore` entry excluding `sidecar/` whenever that file is next touched.

---

## ✅ Resolved 2026-08-13 (ninth session, continued) — Stage 1: env-var-driven domain config

**This is NOT a rename to a new domain — it's the architectural piece that makes a future rename
(or genuine multi-instance/white-label support) possible without another 300-file sweep.** Operator
reframed the ask mid-session: instead of a one-time hardcoded rename, make the codebase read its
domain from configuration, defaulting to local dev — never to `worldmonitor.app`, since "we are not
official worldmonitor.app." Planned via `EnterPlanMode`/`ExitPlanMode` (plan saved at the time as
`glowing-prancing-bear.md`), scoped explicitly to the CORS-allowlist trio + whatever else turned out
to be required to make the test suite pass again after that change. It grew twice past that initial
scope, both times for concrete, discovered reasons — see below.

**New module: `shared/domain-config.js` (+ hand-written `.d.ts`).** Zero imports, no
`process.env`/`import.meta.env` reads inside it — pure functions taking a raw domain string,
defaulting to `localhost:3000` (matching `vite.config.ts`'s existing `DEV_PORT` default) when unset.
Exports `resolveAppOrigin`/`resolveWwwOrigin`/`resolveApiOrigin`/`resolveCookieDomain`/
`buildAllowedOriginPatterns` (the origin-allowlist regex builder, parameterized by domain instead of
hardcoding `worldmonitor.app`) plus the brand-agnostic Tauri/localhost origin-pattern constants that
were already generic. New env var: `APP_DOMAIN` (bare host, e.g. `example.com` or `localhost:3000`),
documented in `.env.example`.

- [x] **The CORS-allowlist trio wired to it** — `api/_cors.js` (via a new copy-sync script,
      `scripts/sync-domain-config.mjs` + `npm run sync:domain-config`/`:check`, modeled byte-for-byte
      on the existing `scripts/sync-bootstrap-tier-keys.mjs` precedent, since plain-JS `api/*.js`
      can't import `shared/` directly — generates `api/_domain-config.js`), `server/cors.ts` (direct
      import — confirmed `shared/` is already importable from the TS build graph), and
      `workers/api-cors-preflight/src/index.js` (direct relative import across the Worker's own
      package boundary — verified with a real `wrangler deploy --dry-run` that the bundle succeeds
      and the shared module's code actually gets inlined; `isAllowedOrigin`/`buildCorsHeaders` now
      take `domain` as an explicit second parameter since Workers have no `process.env`, only the
      `env` binding from `wrangler.toml`'s `[vars]`, which gained an empty `APP_DOMAIN = ""` entry).
      The `eliewm` Vercel-preview-team regex pattern was deliberately left hardcoded, local to each
      of the 3 files — it's an infra team-scope identifier, not a domain brand.
- [x] **2 stray hardcoded `'https://worldmonitor.app'` fallback defaults removed**:
      `scripts/seed-digest-notifications.mjs` (its `WORLDMONITOR_PUBLIC_BASE_URL` fallback) and
      `scripts/build-content-corpus-sitemap.mjs` (`SITE_ORIGIN`, converted from a module-load-time
      `const` to a lazily-evaluated `resolveSiteOrigin()` function — needed because the real,
      externally-generated `public/countries/` etc. content on this machine, 197+ files, still has
      `worldmonitor.app` canonical tags baked in; verified the fail-closed behavior directly: with
      `APP_DOMAIN` unset it correctly throws rather than silently validating against the wrong
      domain). **Real operational consequence handled, not just noted**: added an explicit
      `APP_DOMAIN=worldmonitor.app` to the local (gitignored) `.env` — a real configuration choice
      matching the actually-deployed content on this machine, not a code default — so
      `npm run build:content-corpus` keeps working locally until that content is regenerated under
      a real domain.
- [x] **Scope grew once, for a concrete reason: `api/wm-session.js`'s own independent cookie-domain
      hardcode.** Discovered while making `tests/cors-preflight-live.test.mjs`'s sibling CORS tests
      pass again — `shouldUseSharedCookieDomain()`/`cookieDomainAttribute()`/`clearReadableCookie()`
      each independently checked the request's host against a hardcoded `worldmonitor.app` family
      pattern, completely separate from the CORS trio's allowlist. Same class of hardcode Stage 1
      already targets, just in a file the original recon missed, and it was directly blocking the
      test suite — fixed using the same `shared/domain-config.js` (`resolveCookieDomain()`),
      preserving exact original semantics (host-gated for the session cookie, unconditional-but-now-
      domain-derived for the legacy-cookie-clearing path).
- [x] **Scope grew a second time: a much wider pre-existing test-fixture convention.** Running the
      full suite after the above surfaced 267 failing subtests across 128 files completely unrelated
      to CORS — `server/gateway.ts` gates requests via the (already-fixed) allowlist, and it turns
      out dozens of unrelated tests (rate limiting, telemetry, auth, MCP tools, briefs, etc.) used
      `https://worldmonitor.app` purely as a generic "this is a legitimate browser origin" fixture,
      relying on the old hardcoded default. Asked the operator explicitly rather than guess between
      "set `APP_DOMAIN=worldmonitor.app` for test runs only" vs. "sweep the fixture strings too" —
      operator chose the full sweep. Set `APP_DOMAIN=example.test` ambiently for `test:data`/
      `test:sidecar` (via `cross-env`, matching the existing pattern in this `package.json`) and
      added `tests/helpers/domain-config.mjs` (`TEST_APP_DOMAIN='example.test'` — deliberately
      neither the real brand nor the module's own `localhost:3000` default, so a test can't
      accidentally pass against either). Fixed **53 files** this touched (verified failing
      individually first, not just by grep — several files that merely *contained* the string were
      correctly left untouched because they assert on *other*, unrelated hardcodes: e.g.
      `tests/mcp-world-brief-routing.test.mjs`'s variant-subdomain/canonical-API-origin assertions
      test `api/mcp/downstream.ts`'s own separate hardcode, genuinely Tier-3 scope below, reverted
      after confirming the file needed no change at all). **6 confirmed pre-existing failures
      correctly left alone** (5 `server/__tests__/gateway-*.test.ts` files failing on an unrelated
      `vi.mock`/401-auth issue, confirmed via `git stash` A/B to fail identically — 34/50 — on the
      unmodified baseline; `browser bundle secret guard #3704`, already in this file's own ⚪
      reference list below).

**Verification**: `npm run typecheck:all`, `node scripts/enforce-sebuf-api-contract.mjs`,
`npm run docs:check`, `npm run sync:domain-config:check` all clean. A real `wrangler deploy
--dry-run` for the Worker succeeded (bundle inlines the shared module correctly, zero
`worldmonitor.app` strings left in the built output). Full `npm run test:data` re-run matches the
documented 40-failure baseline **exactly by name**, `npm run test:sidecar` 217/217 clean — both
re-run twice (once after the CORS-trio work, once after the full 53-file sweep) to confirm no new
regressions at either stage.

**Not pushed yet** (mirrors this session's earlier CORS-`DELETE` commit) — `workers/
api-cors-preflight/**` changed, and `.github/workflows/deploy-worker.yml` auto-deploys + live-smokes
on push to `main`. Also touches `package.json` (2 new npm scripts, `cross-env` added to 2 existing
test scripts) and a real behavior change to local `.env`. Needs an explicit push go-ahead like the
CORS-`DELETE` fix earlier this session.

**Explicitly still deferred** (Tier 2/3/4 from the original scoping below, now sharper since
`shared/domain-config.js` exists for them to build on): the CSP strings in `vercel.json`/
`docker/nginx*.conf`/`src-tauri/tauri.conf.json`, the 5 variant subdomains
(`src/config/variant-meta.ts`, `middleware.ts`'s `VARIANT_HOST_MAP`, `api/mcp/downstream.ts`'s
`MCP_CANONICAL_API_ORIGIN`/variant-host classification — the concrete thing
`tests/mcp-world-brief-routing.test.mjs` surfaced as out of scope this pass),
`src/utils/cross-domain-storage.ts`'s `COOKIE_DOMAIN` (client-side, ready to consume
`resolveCookieDomain()` when tackled), `src/services/analytics.ts` (separate per-instance Umami
secret, not just a domain swap), the Tauri bundle identifier, the `cli/package.json` git-remote
mismatch, `scripts/seed-digest-notifications.mjs`'s email-template HTML content (branding/links/
images, a separate and sizeable area — noticed but explicitly not touched this pass), `server/
gateway.ts:1304`'s unrelated cosmetic `'https://worldmonitor.app/'` redirect-link constant, and the
remaining ~150+ files in `scripts/`/`public/`/docs. Domain-migration blockers (new domain name, new
Vercel project, new Cloudflare zone, Tauri bundle-identifier go/no-go, a real mailbox on the new
domain) are unchanged from before — still nothing to decide there until a domain is picked.

---

## ✅ Resolved 2026-08-13 (tenth session) — Stage 2: full config-driven domain sweep

**Operator corrected the framing a second time**: a literal domain name was never actually the
blocker for making code *configurable* — only real infra provisioning (a new Vercel project, a new
Cloudflare zone, the Tauri bundle identifier, a live mailbox) needs an actual domain decision.
Everything else — every remaining hardcoded `worldmonitor.app` string in application code, CSP
configs, and static content — could and should become `APP_DOMAIN`-driven right now, same
mechanism as Stage 1. Explicit mandate: *"everything must be configurable... if you found something
need to hardcode in the codebase, that is not good architecture."* Planned via `EnterPlanMode`/
`ExitPlanMode` (plan saved as `starry-chasing-pinwheel.md`). **135 modified + 4 new files. NOT YET
COMMITTED** (not merely unpushed — no commit has been made for this work at all; see Housekeeping).

**`shared/domain-config.js` extended**: `VARIANT_SLUGS` (frozen 5-slug array, now the single source
every variant list converges on instead of independently duplicating), `resolveVariantDomain`/
`resolveVariantOrigin`/`resolveVariantOrigins`, `resolveAbacusOrigin` (Umami analytics-collector
subdomain), `resolveSubdomainOrigin` (generic), and 3 CSP-origin builders
(`buildCspFrameSrcOrigins`/`buildCspFrameAncestorsOrigins`/`buildCspFormActionOrigins` — kept as 3
named functions rather than one flag-driven function, since the 3 CSP directives use different
orderings of the same origins). New `src/config/domain.ts` — the single client-side import point,
wrapping `import.meta.env.VITE_APP_DOMAIN` (itself synthesized in `vite.config.ts`'s `define` block
from server-side `APP_DOMAIN`) so every browser file imports one place instead of each reading
`import.meta.env` independently.

- [x] **~20 functional/runtime files wired**: `middleware.ts` (`VARIANT_HOST_MAP`/`VARIANT_OG`/
      `ALLOWED_HOSTS`/the `/mcp` redirect, all now derived from `VARIANT_SLUGS` instead of hand-
      mirroring `variant-meta.ts`), `src/config/variant-meta.ts` (removed the static `VARIANT_META`
      export, added `buildVariantMeta(rawDomain)` factory + `resolveVariantMetaUrl`),
      `api/mcp/downstream.ts` (`MCP_CANONICAL_API_ORIGIN` const → function, recomputed per call),
      `src/services/analytics.ts` (`UMAMI_SCRIPT_SRC` → `resolveAbacusOrigin`; preserved
      `UMAMI_DOMAINS`'s deliberately-reduced apex+www+happy-only subset, a documented
      upstream-Umami-bug workaround — only the domain string became configurable, not the reduced
      set itself), `src/bootstrap/debugbear-rum.ts`, `src/services/runtime.ts` (left its
      pre-existing 3-of-5-variant `APP_HOSTS` gap alone, flagged not silently "completed"),
      `api/oauth/authorize.js`, `server/_shared/brief-render.js` (found via manual sweep, missed by
      earlier automated exploration — `renderBackCover`, `UMAMI_LOADER`'s own distinct reduced
      subset, `publicStripHref`), plus ~10 more single-purpose origin-constant files.
- [x] **New `scripts/sync-domain-literals.mjs`** — literal-substring substitution (not templating)
      across 46 static files: CSP configs (`vercel.json`, both nginx confs, `src-tauri/
      tauri.conf.json`) + SEO/agent-discovery content (25 `SKILL.md` files, `agent-card.json`,
      `ai-catalog.json`, `api-catalog`, `webhook-sample.json`, 9 `sandbox/*.json` fixtures,
      `robots.txt`, `schemamap.xml`, `wm-widget-sandbox.html`, `index.html`). True no-op when
      `APP_DOMAIN=worldmonitor.app` matches the real committed content (verified: `npm run
      sync:domain-literals:check` passes clean against the repo's actual `.env`-configured domain).
      **Important limitation, hit twice this session (see below)**: this is a one-time migration
      tool, not a bidirectional generator — it only replaces occurrences of the literal
      `worldmonitor.app`, so once a file has been rewritten to some *other* domain, re-running it
      with `APP_DOMAIN=worldmonitor.app` finds nothing left to substitute and silently reports
      clean. **The only real revert is `git checkout`, never re-running the script "backwards."**
- [x] **~29 `scripts/*.mjs` files repointed to a generated local copy**, not a `../shared/` import —
      discovered mid-session that `scripts/` is deployed standalone to Railway
      (`rootDirectory: scripts`), so a `../shared/` import resolves fine in dev but crashes at
      runtime in prod (caught by `tests/nixpacks-seeder-import-graph.test.mjs`/
      `tests/scripts-railway-nixpacks-no-escape-import.test.mts`). Fixed by extending
      `scripts/sync-domain-config.mjs` to generate a second copy at `scripts/_domain-config.mjs`
      (`.mjs`, not `.js` — `scripts/package.json` has no `"type": "module"`, so a plain `.js` copy
      gets treated as CommonJS by tsx's strict loader) alongside the existing `api/_domain-config.js`.
- [x] **All remaining server/client files + coupled tests fixed** (~30 test files touched — regex-
      extraction tests like `csp-filter.test.mjs`/`sentry-beforesend.test.mjs` needed domain values
      passed as explicit function parameters since `new Function()` reconstruction has no closure
      over module imports; browser-side tests built expected values from the same resolver the
      source imports, since `import.meta.env.VITE_APP_DOMAIN` is never populated under plain
      `tsx --test`).

**2 real, live pre-existing bugs found and fixed along the way, with explicit operator go-ahead
("Fix now, same session")**:
- [x] **13+ files hardcoded `koala73/worldmonitor` as the canonical GitHub repo** instead of the
      real `origin` remote (`powerpro-led/worldmonitor`) — same discrepancy already flagged (not
      fixed) during Stage 1's Tier-1 scoping (`cli/package.json` was one of the 13, covered by the
      same fix as the Housekeeping item above). Personal profile links for "Elie Habib"
      (`github.com/koala73`, a real person, not the repo) were correctly identified and left
      untouched throughout.
- [x] **`src/app/desktop-updater.ts`'s `/api/version`/`/api/download` fetch URLs were hardcoded to
      the `api.worldmonitor.app` subdomain**, but these are plain Vercel functions at same-origin
      `/api/*` paths, not the sebuf-gateway `api.` subdomain — fixed to use `APP_ORIGIN`. Affects the
      live desktop auto-updater.

**Verification found and fixed 2 real regressions**, both confirmed via the `git stash` A/B
methodology (40-failure baseline, compared by failure *name* not count):
- [x] **`Dockerfile.digest-notifications` was missing `COPY` lines** for the two new domain-config
      dependency files (`scripts/_domain-config.mjs`, imported by `seed-digest-notifications.mjs`;
      `shared/domain-config.js`, imported transitively via `brief-render.js`) — guarded by
      `tests/dockerfile-digest-notifications-imports.test.mjs`, fixed by adding both `COPY` lines.
- [x] **CSP `script-src` hashes in `vercel.json`/both nginx confs went stale** — an inline
      `<script>` in one of the 4 hashed HTML entry points changed byte-for-byte during the sweep —
      fixed via the existing `npm run sync:csp-hashes` (built in an earlier session specifically for
      this failure mode).
- Also confirmed via re-run (not a regression, pure environmental flake): `relay /health exposes
  auth.enabled`/`reports auth.enabled=false when bypass is engaged`
  (`tests/relay-auth.test.mjs`) — a real `EADDRINUSE` port collision under full-suite concurrency
  (test spawns a real WebSocket relay on a random port), passes clean in isolation. New to this
  session's testing but the same flakiness *class* as the already-documented ⚪ #9/#12 below — not
  added as its own numbered ⚪ entry since it's concurrency/port-timing noise, not a stable
  reproducible pre-existing name like the others.

**Full verification**: `typecheck:all`, `enforce-sebuf-api-contract.mjs`, `docs:check` clean; all
sync `--check` scripts clean (`sync:domain-config`, `sync:domain-literals`, `sync:csp-hashes`);
`npm run test:data` matches the 40-failure baseline exactly by name (zero new regressions, two full
`git stash` A/B passes run); `npm run test:sidecar` 216/217 (the 1 failure is a live VS Code
extension sidecar on this dev machine genuinely holding port 46123, unrelated to any code change —
see [[local_pipeline_and_vscode_dagu_plan]]); a real `wrangler deploy --dry-run` for
`workers/api-cors-preflight` succeeded (15KB bundle, all bindings resolve); two real `npm run build`
passes (default `worldmonitor.app` from `.env`, and an explicit `APP_DOMAIN=example.com`) both
produced correctly domain-propagated `dashboard.html` (canonical/og/preconnect origins actually
switch with the config, confirmed by direct inspection of the built HTML, not just "didn't crash").

**Deliberately still deferred, unchanged**: real infra provisioning (new domain, Vercel/Cloudflare
zone, Tauri bundle identifier, live mailbox) — see the 🅿️ Parked section below, now narrowed to just
this. Docs/README/CI-workflow `koala73` references — deliberately left alone this pass, flagged for
later. Pushing/committing — see Housekeeping.

---

## ✅ Resolved 2026-08-13 (eleventh session) — Stage 3: the 2 remaining hardcodes made configurable

**Operator pushed back on Stage 2's framing**: the Tauri bundle identifier and the live contact
mailbox were left as literals with the reasoning "these need an explicit human go/no-go, not a
default assumption" — operator's response: config-driven and requiring-a-decision aren't mutually
exclusive; for genuine multi-instance/white-label support (the Stage 1 mandate), both should be
env-driven too, just with safe defaults so the *existing* instance's behavior doesn't silently
change. Implemented both, config-only (no infra decision made or needed to land this).

- [x] **Contact mailbox (`shared/hapi-app-identifier.json`'s `email` field) now derives from
      `APP_DOMAIN`** — added it (and its Railway-mirror copy, `scripts/shared/hapi-app-identifier.json`
      — required by `tests/scripts-shared-mirror.test.mjs`'s byte-identical check, would have silently
      desynced otherwise) to `scripts/sync-domain-literals.mjs`'s target-file list; the script's
      existing bare-hostname substitution rule handles it with zero new logic. Deliberately did NOT
      touch the sibling `application` field — `scripts/seed-conflict-intel.mjs`'s own comment
      documents that HDX HAPI 429s any `application` value case-insensitively containing
      "worldmonitor" (confirmed live by an earlier session's probing), which is exactly why that
      field already reads `wm-crisis-tracker` instead of the brand name; the same comment confirms
      the `email` field was separately probe-verified NOT part of that trigger, so deriving it from
      `APP_DOMAIN` is safe.
- [x] **The 3 Tauri desktop bundle identifiers made configurable via a new, deliberately separate
      `TAURI_BUNDLE_ID_BRAND` env var** (`src-tauri/tauri.conf.json`, `tauri.tech.conf.json`,
      `tauri.finance.conf.json` — the latter two are a second hardcode surface `grep -rli
      worldmonitor.app` never caught, since their identifiers read `app.worldmonitor.desktop`-style,
      i.e. the bare brand token without a `.app` suffix, not the literal domain string). NOT tied to
      `APP_DOMAIN`, on purpose — unlike every other domain-derived value, changing an OS-level bundle
      identifier makes the OS treat it as a different app, breaking the auto-update chain for
      everyone with the current app already installed (same "not cosmetic" concern the Parked
      section's item 5 already flagged). Unset defaults to today's exact literals (verified byte-
      identical, see below), so setting `APP_DOMAIN` alone can never silently change app identity —
      an operator has to opt in to a new brand token explicitly and separately, which is the
      "explicit go/no-go" the earlier session wanted, just now expressed as a second env var instead
      of a permanent code literal.

**A real close call during verification, caught and fully repaired before handoff — sharpens the
Stage 2 "one-way-only" warning rather than just repeating it.** Live-testing with
`APP_DOMAIN=example.com TAURI_BUNDLE_ID_BRAND=examplecorp npm run sync:domain-literals` (to prove the
substitution actually works) wrote `example.com`/`examplecorp` into all ~46 target files, not just the
handful being spot-checked — and `git checkout` was only run against 2-4 of them. Because `--check`
can only detect the ORIGINAL `worldmonitor.app` literal (documented one-way limitation), it reported
a false-clean "OK" against the still-polluted files — checked, trusted, and moved on. A second
live-test + partial revert compounded it, and a stray `import()` of the script (to introspect its
file list) executed its `main()` for real with `APP_DOMAIN` unset, overwriting the 2
`hapi-app-identifier.json` copies with a `localhost:3000`-derived email. **Net effect: ~46 files sat
silently polluted for several tool calls before being noticed** by a plain `grep -rl example.com`
sweep across the actual target-file list — `--check` alone had already given a clean bill of health.
Fixed via exact reverse-substitution (recomputing the same `[correct, polluted]` pairs the polluting
run used and replacing polluted→correct token-for-token), NOT `git checkout`, since some of these
files (`vercel.json` in particular) carry real uncommitted Stage 2 content — a CSP script-hash fix —
that a blind revert-to-HEAD would have destroyed alongside the pollution. Verified the repair is
exact, not just plausible, three ways: `APP_DOMAIN=worldmonitor.app npm run sync:domain-literals:check`
clean (50 files, up from 46 in Stage 2 — +2 Tauri variant confs +2 `hapi-app-identifier.json` copies);
a full `npm run test:data` re-run landed on exactly the documented 40-failure baseline by name (`readBootstrapTierObject`,
`Bootstrap endpoint`, `browser bundle secret guard`, `CI workflow coverage`, `Edge Function no node:
built-ins`, `no non-timing-safe secret comparison`, `Railway service registry coverage` — the known
pre-existing set, not new content-mismatch failures); `docs:check`, `sync:domain-config:check`, and
`sync:csp-hashes:check` all clean. **Lesson for next time, sharper than Stage 2's own**: after ANY
write-mode test run of this script with a non-real `APP_DOMAIN`, `git status --short` the full repo
(not just the files you meant to touch) before doing anything else — `--check` passing is not proof
of a clean tree, only proof no `worldmonitor.app` literals remain, which a polluted-to-something-else
file also satisfies.

**A second, worse near-miss the same session, worth its own entry — `sync-domain-literals.mjs`'s
substitution is LOSSY for any local (`localhost`-shaped) `APP_DOMAIN`, not just one-way.** Operator
asked, mid-session, for the local default itself to stop resolving to `worldmonitor.app` ("we are
not them, use localhost"). Blanking `.env`'s `APP_DOMAIN` and re-running the generator against the
`localhost:3000` default did NOT just "de-brand" the 48 static target files — `shared/
domain-config.js`'s documented local-domain collapse (`www.`/`api.`/`abacus.`/every variant
subdomain all resolve to the same bare apex origin on a local domain, by design, for dev
convenience) made the generator's domain→literal mapping many-to-one instead of one-to-one for that
input. Concretely, live-verified before revert: `vercel.json`'s 5 variant-subdomain `Host`-header
routing rules all collapsed to the identical `tech.localhost:3000`-shaped value (breaking
tech/finance/commodity/happy/energy routing entirely — a `Host` header matching a literal that no
real request will ever carry); `public/wm-widget-sandbox.html`'s postMessage origin-allowlist became
`url.hostname === 'localhost:3000'`, which can never be true since `URL.hostname` never includes a
port; CSP `frame-src`/`frame-ancestors` degenerated to the same origin repeated 7 times; `did:web:
localhost:3000` is not valid DID syntax (the port needs percent-encoding). **Then the attempted fix
compounded it**: reversing the substitution by replacing the polluted value back to its
pre-substitution counterpart assumes a 1:1 mapping — since the forward mapping had just collapsed 7
distinct origins into 1, the reverse pass could only recover ONE of them (whichever pair matched
first in iteration order, `abacus.`), silently overwriting index.html's canonical/OG tags,
`vercel.json`'s frame-src list, etc. with `abacus.worldmonitor.app` in spots that should have said
the bare apex, `www.`, `tech.`, etc. — caught only by a full `test:data` re-run showing 56 failures
instead of the expected 40, not by `--check` (still reported clean) or a spot-check (only spotted
one broken line, not the systemic mis-restore). **Real fix**: `git diff HEAD` first, to confirm the
target files are pure literal-substitution content with `HEAD`'s domain-literal portions already
correct-by-construction (true for 45 of 48; `vercel.json` + both nginx confs additionally carry a
live, uncommitted CSP-hash fix) — then `git checkout HEAD --` those 45 outright, and for the CSP-hash-
bearing 3 files, `git checkout HEAD --` first (accepting the temporary loss of the hash fix) followed
by `npm run sync:csp-hashes` to cleanly reapply it on top of the now-correct content. Verified via a
full `git diff HEAD` sanity read on `vercel.json` (both the `Host` rules and the CSP directive), the
same `wm-widget-sandbox.html` grep, `sync:domain-literals:check` + `sync:csp-hashes:check` clean, and
a full `npm run test:data` back to the 7-category baseline. **`.env`'s `APP_DOMAIN` was restored to
`worldmonitor.app`, unchanged from before this session** — the operator's actual goal (nothing in the
*dynamic*/runtime application code defaults to the brand) was already true before this attempt and
needed no change; only the *static*-file generator was ever a candidate for a `localhost` target, and
it turns out to have no coherent one for the very files (CSP, host-routing) where the domain has to
be a real, distinct, addressable value to mean anything. **Lesson**: never point
`sync-domain-literals.mjs` at a local domain for real — it was designed and tested for "swap one real
domain literal for another," and both its forward substitution and any hand-rolled reverse of it
silently corrupt content once genuinely distinct target values collapse to one.

**Still deliberately hardcoded, unchanged**: nothing else identified — the 🅿️ Parked section's
remaining items (new domain, Vercel project, Cloudflare zone, live mailbox actually receiving mail,
and now optionally a real `TAURI_BUNDLE_ID_BRAND` value) are all real-world provisioning/product
decisions, not code. `TAURI_BUNDLE_ID_BRAND`/the mailbox's `APP_DOMAIN`-derived value are both now
*capable* of following a real domain choice the moment one is made — no further code change needed.

---

## 🅿️ Parked 2026-08-13 (ninth session; narrowed tenth session) — real infra provisioning only

**Blocked on operator decisions, not on more investigation — and now a much smaller list than
originally scoped.** Operator's stated final goal: this fork should stop being reachable at /
referencing `worldmonitor.app` in production, on **new independent infra** (a separate Vercel
project + a separate Cloudflare zone, not repointing the current ones) — but **no replacement
domain has been chosen yet**. **Stage 1 + Stage 2 + Stage 3 (the CORS-allowlist trio, the full
codebase/CSP/static-content configurability sweep, and making the Tauri identifier + contact
mailbox configurable) are DONE — see the three ✅ sections immediately above.** What's left below is
*only* the handful of things that genuinely require real-world action, not more code — a new Vercel
project, a new Cloudflare zone, an actual go/no-go + value for the Tauri bundle identifier, and an
actual working mailbox (items 1-3 and 5-6 in the "Needed before any code changes" list right below).
The original Tier 2-4 file-count breakdown further down is now **stale/superseded** by Stage 2's
actual sweep — kept only for historical reference, not as a to-do list.

**Scale**: `grep -rli worldmonitor\.app` (excluding node_modules/dist/git/build artifacts) hit
**339 files** before Stage 1. That count is now stale in the good direction — Stage 1 resolved the
CORS trio, `api/wm-session.js`'s cookie-domain hardcode, and ~60 test files' fixture usage; **Stage
2 (tenth session, see the ✅ section above) resolved effectively everything else that didn't require
real infra** — the Tier breakdown and file counts immediately below predate both stages and are now
**superseded/historical**, not a live to-do list; the only genuinely still-open items are the
infra-provisioning decisions in this "Needed before any code changes" list.

**Needed before any code changes** (operator/infra decisions, not something to guess at):
1. The new domain name itself (registered + DNS-controllable).
2. A new Vercel project provisioned under it.
3. A new Cloudflare zone + Worker route provisioned under it (mirrors the current
   `workers/api-cors-preflight` binding to `api.worldmonitor.app/*`).
4. ~~Whether the 5 "variant" subdomains carry over~~ — **moot as a blocking decision now**: Stage 2
   made every variant subdomain (`tech.`/`finance.`/`commodity.`/`happy.`/`energy.<domain>` —
   `src/config/variants/*.ts`, the Tauri CSP's `frame-src`) derive from `VARIANT_SLUGS` +
   `APP_DOMAIN`, so they automatically carry over to whatever domain gets picked with no further
   code change; still worth an explicit product call on whether to keep/drop/rename individual
   variants, but that's no longer a domain-migration blocker.
5. **Code-ready as of Stage 3 (eleventh session), decision itself still open.** Whether the Tauri
   desktop app's bundle identifier changes is still a real, standalone go/no-go — changing it
   breaks the auto-update chain for anyone with the app already installed (a new identifier = a new
   app identity to the OS; existing installs won't silently follow) — but it's no longer a code
   change to execute once decided: `TAURI_BUNDLE_ID_BRAND` (see the Stage 3 ✅ section above) now
   drives all 3 `src-tauri/tauri*.conf.json` identifiers, unset = today's exact literals.
6. **Code-ready as of Stage 3, only the real mailbox itself still needed.** `shared/
   hapi-app-identifier.json`'s `email` field now derives from `APP_DOMAIN` automatically (Stage 3);
   what's still missing is a real inbox actually receiving mail at whatever address that resolves
   to, before cutover.
7. Whether to fix the `ALLOWED_ORIGIN_PATTERNS`/`PRODUCTION_PATTERNS` **triple-duplication** (hand-
   synced today across `api/_cors.js`, `server/cors.ts`, and `workers/api-cors-preflight/src/
   index.js`, each with a header comment saying "keep in sync") as *part of* the migration —
   collapsing it to one shared source now would mean the new domain only needs updating in one
   place instead of three, same lesson as the `scripts/sync-csp-script-hashes.mjs` fix from an
   earlier session. Recommended, not required.

**Risk-tiered breakdown of the 339 files** (sampled, not individually read — a real pass would
re-verify each before touching):
- **Tier 1 — real infra identity, each needs its own explicit decision** (~6 files): `vercel.json`,
  `workers/api-cors-preflight/wrangler.toml` + `src/index.js`, `src-tauri/tauri.conf.json`,
  `shared/hapi-app-identifier.json`, `cli/package.json` (npm package literally named
  `worldmonitor`, bin commands `worldmonitor`/`wm`, `homepage` pointing at the now-deleted
  `/docs/cli` path — also: its `repository.url`/`bugs` point at `github.com/koala73/worldmonitor`,
  which does **not** match this repo's actual `origin` remote, `github.com/powerpro-led/
  worldmonitor` — a **pre-existing discrepancy, unrelated to the domain migration**, flagging
  separately since it looks like stale-from-before-the-fork metadata, not something to silently
  "fix" as part of this).
- **Tier 2 — structural content treating the domain as the canonical API host** (~50-60 files):
  the entire `public/.well-known/agent-skills/*/SKILL.md` surface (~25 files) + its generated
  `index.json` (regenerate via the existing `build:agent-skills` script, same as every prior
  SKILL.md edit), `agent-card.json`, `ai-catalog.json`, `api-catalog`, `webhook-sample.json`,
  `sandbox/*.json`, `sitemap.xml`, `robots.txt`, `schemamap.xml`, `index.html`.
- **Tier 3 — application source** (~150 files across `src/`, `server/`, `api/`, `scripts/`):
  CORS/CSP allowlists (security-relevant, needs care), embed URLs, cross-domain storage keys,
  analytics endpoints, variant configs, seed/deploy scripts. Mostly mechanical once the domain is
  fixed, but each CORS/CSP touch point should be individually verified, not bulk-replaced.
- **Tier 4 — tests** (121 files): should mostly follow automatically if Tier 1-3 introduce a
  single shared constant/env var instead of hardcoding the literal domain per-file — today many
  don't (e.g. `tests/cors-preflight-live.test.mjs`'s `ORIGIN`/`ENDPOINTS`/`PUBLIC_CORS_PROBES`
  constants, the concrete example that prompted this scoping pass).
- **Tier 5 — docs/markdown** (37 files): narrative, lowest urgency, can lag behind the code cutover.
- **Explicitly OUT of scope — do not touch**: `data/resilience-snapshots/*.json`'s
  `"source": "Live capture via https://api.worldmonitor.app/..."` fields are a **historical
  provenance record** of a real fetch that happened from that URL at that time — rewriting them
  would falsify the data, not rebrand it.

**Suggested execution order once unblocked**: (1) resolve the Needed-before-any-code-changes list
above, (2) Tier 1 first since it's small and gates whether anything else can be tested against
real infra, (3) Tier 2's agent-skills surface (self-contained, has its own regen tooling), (4) Tier
3 with care on every CORS/CSP touch point, (5) Tier 4 tests alongside whichever Tier 3 file they
cover, (6) Tier 5 docs last.

---

## ⚠️ READ FIRST — never `rm -rf dist/` on this machine without checking who's using it

**2026-08-12: a `dist/` cleanup broke the operator's live, running VS Code extension.** `dist/` is
gitignored and looks like disposable build output, but on this dev machine the VS Code extension's
local sidecar (`src-tauri/sidecar/local-api-server.mjs`, spawned by `vscode-extension/src/
sidecarProcess.ts`) serves the *actual live dashboard* straight from `<repo root>/dist/` over real
HTTP (see `local-api-server.mjs`'s `staticDir` resolution comment — this is intentional, the
mechanism [[local-pipeline-and-vscode-dagu-plan]] documents as DONE). Deleting `dist/` after a
diagnostic `npx vite build` (done here to verify the checkout-chunk-bug fix against a real build,
not a no-op `npm test`) made the sidecar 404 every request, which the operator saw as `{"error":
"Not found"}` in the extension's live panel. Fixed by running a full `npm run build` to regenerate
`dist/` — confirmed via `curl http://127.0.0.1:<sidecar-port>/dashboard.html?embed=vscode`
returning real HTML again; the extension self-recovers on next load/reload, no restart needed.
**Before deleting any build output directory on this machine, check `ps aux | grep local-api-
server` first** — if a sidecar is running, its `staticDir`/`apiDir` may point straight at what
you're about to delete. Side effect to know about: a full `npm run build` also regenerates
`public/sitemap.xml`'s content-corpus `<lastmod>` block (real file mtimes, auto-generated,
"do not edit by hand") — reverted that unrelated diff before this handoff since it wasn't an
intentional content update, but expect it to reappear if `npm run build` runs again.

---

## ✅ Resolved 2026-08-12 — the "Upgrade to Pro" leftover (commit `d580d1a`)

**The underlying question turned out to already be answered by the codebase itself, in writing,
three times over** — this was NOT actually an open product decision by the time it was
investigated properly. `server/_shared/entitlement-check.ts`, `src/services/entitlements.ts`, and
`src/services/panel-gating.ts` module headers all independently state the same Stage-1 decision:
there are no more tiers; every signed-in user (GitHub-org-gated via Supabase) gets full access,
forever; "Pro" is now just a synonym for "signed in." `ResilienceWidget.ts` already implemented
this correctly (locked state says "Sign In to Unlock", button calls `signInWithGithub()`) — the
~19-file leftover was simply code that predated that decision and never got updated to match it.
Operator confirmed all 3 sub-decisions below; executed and verified same session.

- [x] **3 API files' dead `pro_required` 403 branches removed.** `api/latest-brief.ts`,
      `api/notify.ts`, `api/brief/share-url.ts` each called `getEntitlements(userId)` and checked
      `tier < 1` — but `getEntitlements()` always returns `tier: 1` for any signed-in user, so the
      branch was unreachable dead code (confirmed before removing). Removed the branches, their
      now-unused `getEntitlements` imports, and the stale "PRO tier gated" docblock language.
      Verified: 128/128 tests pass across the 5 affected test files.

- [x] **~13 dashboard UI files matched to `ResilienceWidget.ts`'s already-correct pattern.**
      `src/components/Panel.ts` (`showLocked()` had a desktop-only branch opening the dead `/pro`
      page instead of calling `signInWithGithub()` like its own web branch already did —
      `signInWithGithub()` already handles desktop/Tauri correctly per its own header comment, so
      the special case was just wrong); `src/components/UnifiedSettings.ts` (panel-toggle click
      now calls `signInWithGithub()`); `src/components/RouteExplorer/RouteExplorer.ts` and
      `src/services/notifications-settings.ts` (primary action already correctly called
      `signInWithGithub()` — only the `.catch()` fallback pointed at `/pro`; replaced with a toast/
      alert, matching `ResilienceWidget.ts`'s own `showAuthUnavailable()` pattern);
      `src/components/CountryDeepDivePanel.ts` (7 `makeProLocked(...)` call sites, **not 6** — a
      7th, "Bypass corridors available with PRO", was missed by the original grep — plus 2 more
      "PRO" mentions outside `makeProLocked`: an evidence-export button tooltip and its toast) and
      `src/components/RouteExplorer/components/LeftRail.ts` (1 site) — these had **no click
      handler or link at all**, just static text; operator chose copy-only fix ("Sign in to unlock
      X"), not new interactivity. `src/components/CountryBriefPage.ts` — a **second, previously
      unknown copy** of the evidence-export gate/toast, found only by a final repo-wide grep after
      fixing the first one; same copy fix applied. All test assertions coupled to the old strings
      updated in lockstep (`tests/brief-edge-route-smoke.test.mjs`,
      `tests/multi-sector-cost-shock.test.mjs`, `tests/country-evidence-bundle-export.test.mts`,
      `tests/oauth-authorize.test.mjs`, `tests/brief-magazine-render.test.mjs`) — 62+18+91 tests
      pass.

- [x] **Agent/server-facing files reframed as "operator-issued, no self-service"** (not
      sign-in — these are API/webhook/agent-facing files with no browser session to sign into):
      `api/a2a.ts` (agent-facing note), `api/oauth/authorize.js` (2 dead links removed — a "get a
      key" hint and a footer link; the *working* `/mcp-grant` OAuth CTA kept, just relabeled off
      "...WorldMonitor Pro"), `api/brief/public/[hash].ts` (error-page CTA → homepage),
      `server/_shared/brief-render.js` (the public-brief "back cover" and "shared-issue strip"
      marketing surfaces reworded from "Subscribe →" to "Get your own →" pointing at the homepage
      instead of `/pro`; the per-story redaction disclaimer reworded off "Subscribe to
      WorldMonitor Brief"). `refCode` referral-attribution threading was deliberately **kept**
      (still live, unrelated to the deleted Convex leads/waitlist domain) — only its destination
      URL changed. Test assertions updated in `tests/brief-magazine-render.test.mjs`,
      `tests/oauth-authorize.test.mjs` (91 + 18 tests pass).

- [x] **Public marketing stripped from `index.html` and `cli/README.md`.** `index.html`: removed
      the JSON-LD `"Pro (Waitlist)"` offer entry, repointed the `contactPoint.url` off `/pro` to
      the homepage, removed the "World Monitor Pro" nav link and the noscript-block "upgrade to
      World Monitor Pro" sentence. `cli/README.md`: "get one at .../pro" → "operator-issued, no
      self-service enrollment."

- [x] **4 Pro-gated `SKILL.md` files rewritten to match the real (binary) entitlement model.**
      `check-sanctions-pressure`, `trace-trade-flows`, `track-tariff-trends`,
      `fetch-resilience-score` — all claimed "Pro-gated (entitlement tier ≥ 1)... a key on the
      free tier receives 403". **Verified this is not just stale but currently impossible**:
      traced the actual gateway auth path (`server/gateway.ts` + `server/_shared/
      entitlement-check.ts` + `server/_shared/premium-check.ts`) and confirmed there is no
      "free-tier key" concept left — any valid `X-WorldMonitor-Key` (all operator-issued via
      `WORLDMONITOR_VALID_KEYS`, no user-owned `wm_` keys since that product was retired with
      Convex/Dodo) resolves to full access, uniformly. Rewrote the entitlement lines to "none
      beyond a valid API key" and dropped the now-impossible 403 case from each file's Errors
      list. Regenerated `public/.well-known/agent-skills/index.json` after.

**Verification for the whole item**: `npm run typecheck:all` clean, `node scripts/enforce-sebuf-
api-contract.mjs` clean, `npm run test:data` failure set byte-identical to the pre-existing
baseline (`comm` diff empty both directions), `npm run test:sidecar` unchanged. One real
regression hit and fixed mid-pass — see the 🆕 section below ("CSP hash triple-maintenance").

---

## ✅ Resolved 2026-08-12 (later same-day session) — 3 of the 5 🆕 items below

Worked in the "ready to just do" order from the session's own triage: push blocked (see
housekeeping note), then these 3 in sequence. Verified throughout via `npm run typecheck:all`
(clean), `node scripts/enforce-sebuf-api-contract.mjs` (clean — 130 files/96 manifest entries),
`npm run test:data` (40 failures, byte-identical set to the pre-existing baseline: #1-9, #11, #12
below), `npm run test:sidecar` (1 failure, #12, unchanged).

- [x] **CSP `frame-src` Clerk/Dodo cleanup**, all 3 hand-synced files (`vercel.json`,
      `docker/nginx-security-headers.conf`, `docker/nginx.conf`): removed `*.clerk.accounts.dev`,
      `clerk.worldmonitor.app`, `*.dodopayments.com`, `checkout.dodopayments.com`, `test.checkout.
      dodopayments.com`, `*.hs.dodopayments.com`, `*.custom.hs.dodopayments.com`. Also found+fixed
      2 stale test assertions in `tests/deploy-config.test.mjs` that *required* Clerk's presence in
      frame-src "for auth modals... should Clerk reintroduce a handshake iframe" — confirmed via
      `src/services/auth-provider.ts`'s own header comment that Supabase's redirect flow has no
      iframe modal at all, so the defense-in-depth reasoning no longer applies; flipped both to
      `assert.doesNotMatch(frameSrc, /clerk|dodopayments/)`, matching the existing `/embed` route's
      same-style guard at line ~937. **Not touched, separate scope**: `vercel.json`'s
      `Permissions-Policy` `payment=(...)` directive still lists `checkout.dodopayments.com` /
      `test.checkout.dodopayments.com` — a different header, not flagged by the original item,
      has its own hardcoded-list test (`tests/deploy-config.test.mjs:604`) that would need updating
      too if this gets picked up later.

- [x] **`docs:check`'s 11 pre-existing errors** — all fixed. `ARCHITECTURE.md`'s CI/CD table got
      2 new rows (`nitric-deploy.yml`, `publish-cli.yml`, both manual-triggered per their own
      header comments). The other 9 were numeric drift resynced by hand (no `--write`/`--fix` mode
      exists on `scripts/docs-stats.mjs`, confirmed by reading it): `README.md` protos 281→278,
      services 35→34; `AGENTS.md` + `CONTRIBUTING.md` component files 167→161 (3 occurrences
      combined); `AGENTS.md` service modules 203→177; `CONTRIBUTING.md` domains 36→35, server
      handler domains 35→34; `SECURITY.md` domain APIs 35→34. `npm run docs:check` now prints
      "OK — 23 doc claims match code."

- [x] **2 stale "pending Clerk migration" reasons in `api/api-route-exceptions.json`** —
      `api/user-prefs.ts` and `api/notification-channels.ts` reworded to reference their sibling
      endpoints instead of Clerk, matching `api/followed-countries.ts`'s existing phrasing (the
      pattern that was deliberately used to avoid this exact staleness when that entry was added).
      Verified via `node scripts/enforce-sebuf-api-contract.mjs`.

- **`api/notify.ts`'s stale reason text — RESOLVED same day, fifth session**: reworded
  ("validates Clerk bearer auth" → "validates a Supabase session bearer") as part of the "PRO"
  internal-branding pass below, since it was directly adjacent to that pass's other
  `api-route-exceptions.json` edit. `api/latest-brief.ts`'s 3 remaining Clerk mentions — **RESOLVED
  2026-08-12, sixth session**, see the new ✅ section below (grew into a full repo-wide Clerk
  retirement sweep, not just those 3 comments).

---

## ✅ Resolved 2026-08-12 (fifth same-day session) — the "PRO" internal-branding rename

**Operator chose: badges/CTAs → "Sign In" framing, static always-shown badges → removed entirely
(not renamed, since a signed-in user seeing a permanent "SIGN IN" tag would be wrong), leave
identifiers (env vars, storage keys, CSS class *names*) untouched, propagate to all 24 non-English
locales.** 92 files changed. Scope grew substantially beyond a text rename once the sweep started
— every finding below was confirmed live/dead before touching it, verified via `typecheck:all`,
`enforce-sebuf-api-contract.mjs`, `test:data` (40 failures, byte-identical baseline), `test:sidecar`
(1 pre-existing failure), `docs:check`, and `sync:locales:check`, all clean.

- [x] **2 confirmed-dead Convex/Dodo entitlement-fallback branches removed from live auth code**,
      same shape and same proof already used earlier the same day (`session.role` is
      unconditionally `'pro'` for any verified session, so the fallback checking `getEntitlements`/
      `getBillingVerificationDenial` could never fire): `api/widget-agent.ts` and — much
      higher-blast-radius — **`server/gateway.ts` itself, the core API gateway dispatching all
      ~34 sebuf domains** (explicitly confirmed with the operator before touching, given its
      centrality). Deleted `server/__tests__/widget-agent-billing-denial.test.ts` and 2 stale
      `describe` blocks in `tests/widget-builder.test.mjs` that exclusively pinned the removed
      branches (their own header comments already documented 3 sibling tests removed for the same
      reason in an earlier pass).
- [x] **Real, still-reachable "Pro subscription required" / "Pro authentication required" 403s
      renamed to "Sign-in or API key required"** across 9 live call sites the wording sweep
      surfaced (not dead code — genuine `isCallerPremium`-gated endpoints, just stale copy):
      `server/gateway.ts` (2 sites), `server/worldmonitor/scenario/v1/{run-scenario,
      get-scenario-status}.ts`, `server/worldmonitor/shipping/v2/{register-webhook,list-webhooks,
      route-intelligence}.ts`, `server/worldmonitor/news/v1/summarize-article.ts`,
      `api/chat-analyst.ts`, `api/v2/shipping/webhooks/[subscriberId].ts` (+`[action].ts`),
      `api/_api-key.js`, `api/mcp-proxy.ts`. Updated every test/script assertion pinned to the old
      literal in lockstep (`tests/forecast-trigger-simulation.test.mts`,
      `server/__tests__/summarize-article-handler-security.test.ts`,
      `tests/resilience-validation-artifacts-schema.test.mts`, `api/_api-key.test.mjs`,
      `scripts/capture-resilience-energy-v2-acceptance.mjs`).
- [x] **`WidgetChatModal.ts`'s preflight-error handler fixed** — it still showed real anonymous
      users "Pro subscription required... Upgrade to unlock" on a 403, missed by the earlier
      "Upgrade to Pro" sweep because it was gated behind an `isPro`-tier conditional, not a static
      link. Added explicit 401 handling (sign-in-required) and collapsed the now-meaningless
      isPro-conditional 403 branch into one honest message, since the server no longer
      differentiates by entitlement tier.
- [x] **2 more dead `worldmonitor.app/pro` + `worldmonitor.app/docs` footer links removed**
      (`src/app/panel-layout.ts`, mobile menu + site footer) — missed by both the earlier
      "Upgrade to Pro" sweep and the public-product-surface retirement (an absolute external URL,
      not a local route, so neither sweep's grep pattern caught it).
- [x] **2 more hardcoded lock-CTA/badge text sites found and fixed**: `SupplyChainPanel.ts`'s
      "Bypass corridors available with PRO" (a duplicate of the exact string already fixed in
      `CountryDeepDivePanel.ts` during the earlier sweep — reused that fix's exact wording, "Sign
      in to unlock bypass corridors") and `MapPopup.ts`'s 2 chokepoint-transit-chart/sector-ring
      lock overlays (`isPro`-conditional, genuine lock CTAs → "SIGN IN").
- [x] **All static "PRO" badges removed entirely** (not renamed — they rendered unconditionally
      regardless of the viewer's own sign-in state, so "SIGN IN" text would have been wrong for an
      already-signed-in viewer): `Panel.ts` (`panel-pro-badge`), `panel-layout.ts` (2 Add-Panel
      discovery tiles), `MobilePanelNav.ts` (the mobile nav's PRO category chip — filtering
      functionality removed too, not just the label), `UnifiedSettings.ts`
      (`panel-toggle-pro-badge`), `DeckGLMap.ts`/`GlobeMap.ts` (`layer-pro-badge`),
      `CustomWidgetPanel.ts`, `WidgetChatModal.ts`'s modal-title badge. Removed the now-orphaned
      CSS (`main.css`, 5 rules) and locale keys (`widgets.proBadge`, `premium.pro`) once confirmed
      zero remaining references; removed `getProPanelKeys()` from `src/config/panels.ts` (its sole
      consumer was the deleted chip) plus its dedicated test suite in
      `tests/mobile-panel-nav-categories.test.mts`.
- [x] **Confirmed-dead billing/promo locale content deleted from `en.json` + `en.shell.json`**
      (zero live code references found via repo-wide grep before deleting): `components.proBanner`
      (a "Pro is launched" marketing banner), `components.billingState` (payment-failed/renewal
      copy), `components.checkoutFailureBanner`, `components.proActivation` (a whole onboarding
      wizard), `premium.upgradeDesc`/`upgradeToPro`. `en.shell.json` needed a hand-applied pass
      separately — it's explicitly excluded from `sync-locale-keys.mjs`'s scope as a distinct
      partial first-paint bundle, so it never inherited the `en.json` edits automatically.
- [x] **Real user-facing copy renamed** to "Sign In" framing: `widgets.preflightInvalidProKey`,
      `widgets.preflightProUnavailable` (kept the `PRO_WIDGET_KEY` identifier name, reworded the
      adjective), `settingsWindow.freePanelLimit`/`freeSourceLimit` (the real, still-enforced
      `FREE_MAX_PANELS`/`FREE_MAX_SOURCES` anonymous-visitor cap), `commands.tips.flight`. Deleted
      `widgets.preflightProRequired`/`preflightProSubscriptionRequired` (superseded by the
      WidgetChatModal.ts fix above), added `widgets.preflightSignInRequired`/`preflightRequestRejected`.
      **Propagated to all 24 non-English locales** — translated by hand for each language (not
      machine-API-translated), reusing each locale's own existing "Sign In to Unlock" phrasing
      where natural for consistency; verified via `npm run sync:locales:check`.
- [x] **~35 files' internal `// PRO-gated`/`PRO entitlement`/`PRO tier` code comments** reworded to
      "auth-gated"/"entitlement"/"signed-in" phrasing for consistency, across `src/App.ts`,
      `src/app/{country-intel,data-loader}.ts`, `src/components/*` (8 files), `src/services/*`
      (5 files), `server/_shared/*` (6 files), `server/worldmonitor/{supply-chain/v1,scenario/v1,
      shipping/v2,forecast/v1}/*`. Left identifier-referencing comments alone (e.g.
      `api/widget-agent.ts`'s "PRO-only deployments" note, which is describing the
      `PRO_WIDGET_KEY` env var by name, not the entitlement concept).

- [x] **CSP `script-src` hash allowlist triple-maintenance — RESOLVED 2026-08-12 (new session).**
      Was: hand-maintained in 3 separate files that must stay in byte-identical sync (`vercel.json`,
      `docker/nginx-security-headers.conf`, `docker/nginx.conf`) — editing any inline `<script>` in
      `index.html` (including JSON-LD blocks) changes that script's SHA-256 hash and silently
      desyncs all 3 until `tests/deploy-config.test.mjs` catches it after the fact. Fixed by adding
      `scripts/sync-csp-script-hashes.mjs` (+ `npm run sync:csp-hashes` / `sync:csp-hashes:check`,
      same `--check` convention as `sync:locales`/`version:sync`): derives the hash set from the
      same 4 HTML entry points and extraction logic `tests/deploy-config.test.mjs` uses, then writes
      it into all 3 files, preserving each file's existing token order and only touching a file
      whose hash *set* actually differs (true no-op — byte-identical output — when nothing
      changed, verified live: ran `--check` against the untouched repo, got a clean pass with 0
      files rewritten). Sanity-tested the drift-detect-and-fix path against scratch copies with one
      hash deliberately corrupted: correctly flagged only the corrupted file, fixed it back to
      byte-identical with the real repo's copy, left the other 2 untouched files alone. Verified via
      `npx tsx --test tests/deploy-config.test.mjs` (99/99 pass). Doesn't remove the underlying
      3-file requirement (still real infra, `docker/nginx.conf`'s hashes live in only one of its 3
      `location` blocks by design) but removes the manual-edit failure mode entirely — the lesson
      below is now "run the sync script", not "hand-edit 3 files and hope".

~~CSP `frame-src` Clerk/Dodo cleanup~~, ~~`docs:check`'s 11 errors~~, and ~~the 2
`api-route-exceptions.json` Clerk-reason entries~~ — all **FIXED**, see the ✅ section above.

- [x] **`src/settings-main.ts`'s "License / API Key" description — RESOLVED 2026-08-12 (new
      session), English-only fix, operator explicitly chose this over a full 26-locale pass.**
      `src/locales/en.json`'s `modals.settingsWindow.worldMonitor.apiKey.description` rewritten from
      "API Starter and API Business subscribers create this key on the web dashboard under Settings
      → API Keys..." (dead self-service/billing flow) to "API keys are operator-issued, no
      self-service enrollment. Paste the key you were given here...", matching the phrasing already
      used in `cli/README.md` and `api/a2a.ts`'s agent-facing note for the same real flow. The other
      25 locale files' translations of the old copy are now stale (same accepted tradeoff as the
      removed "register" section) — `npm run sync:locales:check` still passes since it only checks
      key structure, not value freshness, so this doesn't fail CI; a real fix would need translating
      this one string into 25 languages, not done. **Caught a real regression while verifying**:
      this key also lives in `src/locales/en.shell.json` (the first-paint shell bundle,
      deliberately excluded from `sync-locale-keys.mjs`'s scope per the earlier "PRO" rename
      session's own note above) and must stay byte-identical with `en.json` per
      `tests/i18n-english-shell.test.mjs` — editing only `en.json` broke that test; fixed by
      applying the identical text to `en.shell.json` too. Verified via `npx tsx --test tests/i18n-
      english-shell.test.mjs` (5/5 pass) and a full `npm run test:data` re-run (40 failures, exact
      category match to the documented pre-existing baseline, confirmed no new regressions).

---

## ✅ Resolved 2026-08-12 (sixth session, continued) — full Clerk retirement sweep

**What started as "fix `api/latest-brief.ts`'s 3 remaining Clerk comments" turned into a full
repo-wide sweep once a broad grep showed ~140 files still mentioned "Clerk" — most legitimate
history, but a real tail of live bugs, live dead infrastructure, and stale current-behavior
comments.** Operator explicitly signed off on each escalation (full sweep incl. `gateway.ts`, then
removing the dead `@clerk/clerk-js` dependency). ~65 files changed. Every category verified live —
not assumed — before touching; see the verification note at the end.

- [x] **Real bug: `analytics.ts` mislabeled live signup-analytics data.** `trackSignUp('clerk')`
      fired on every real sign-up completion even though auth is Supabase/GitHub OAuth — fixed to
      `trackSignUp('github')`, matching `auth-provider.ts`'s own `provider: 'github'` convention.

- [x] **Real bug: 4 test files' auth mock silently no-op'd.** `tests/{cii-panel-pin-to-top,
      country-deep-dive-notify-sub-action,country-panels-followed-only-filter,followed-only-chip}
      .test.mjs` called `_setDepsForTests({ getCurrentClerkUser: () => null, ... })`, but
      `src/services/followed-countries.ts`'s real interface expects `getCurrentAuthUser` — the
      stale field name silently no-op'd the override in these untyped `.mjs` files, so the tests
      were unknowingly exercising the real (accidentally also-null in node:test) auth getter
      instead of the intended deliberate mock. Renamed to `getCurrentAuthUser` in all 7 call
      sites; all 62 tests across the 4 files still pass (confirms this was latent, not currently
      user-visible — but no longer fragile).

- [x] **Removed the fully-dead `@clerk/clerk-js` npm dependency and its build machinery**, orphaned
      since its sole consumer (`src/services/clerk.ts`) was already deleted: `package.json`'s
      dependency entry; `vite.config.ts`'s version-extraction + major-pairing build-fail guards,
      the `__CLERK_JS_VERSION__` define, the dead `manualChunks` `'clerk'` bucket, and the
      `**/clerk-*.js` PWA-precache glob (which had a dedicated test requiring its own presence —
      `tests/deploy-config.test.mjs`'s "keeps the lazy Clerk SDK out of the PWA precache" — deleted,
      not flipped, since the whole premise no longer applies); `src/vite-env.d.ts`'s orphaned type
      declaration. `npm install` removed 431 packages (Clerk's optional Solana-wallet →
      react-native chain). **Verified via a real `npm audit` A/B** (stash the removal, audit, pop,
      audit again): introduces zero new advisories, only removes ones reachable solely through that
      now-gone chain (`GHSA-mh99-v99m-4gvg`, `GHSA-rgw5-rvv9-x895`, `GHSA-5p4m-2wfm-xmqj`,
      `GHSA-w5hq-g745-h8pq`) — updated `.github/scripts/audit-production-dependencies.mjs`'s
      now-stale `GHSA-mh99-v99m-4gvg` baseline entry for root `package-lock.json` accordingly.
      `tests/security-audit-baseline.test.mjs`'s own `@clerk/clerk-js` mentions are synthetic
      fixture data unrelated to the real dependency, needed no change. Full `npm run build`
      succeeded; confirmed the running VS Code extension sidecar still served the rebuilt
      `dist/` correctly afterward (see the `dist/` warning at the top of this file) and reverted
      the build's incidental `public/sitemap.xml` `<lastmod>` touch (documented side effect,
      not an intentional content change).

- [x] **Removed dead Clerk-specific Sentry noise-suppression**, unreachable now that the SDK never
      loads: `src/bootstrap/sentry-init.ts`'s `clerk.worldmonitor.app` host-allowlist entry and 3
      `ignoreErrors` regexes (`ClerkJS: Network error`, `ClerkJS: Response: needs_*_factor`,
      `[clerk] failed to load`) + their 2 dedicated tests in `tests/sentry-beforesend.test.mjs`;
      `src/bootstrap/lcp-attribution.ts`'s dead `'clerk'` branch in the LCP-attribution classifier;
      `e2e/secondary-startup.spec.ts`'s dead `clerk.worldmonitor.app` regex alternative (confirmed
      no `dns-prefetch` tag for it exists anywhere in `index.html` or `src/`); the live desktop
      `src-tauri/tauri.conf.json` CSP's `https://*.clerk.accounts.dev` in `script-src` + `frame-src`
      (missed by the earlier session's web-CSP `frame-src` Clerk/Dodo cleanup since it's a separate
      Tauri config file, not `vercel.json`/nginx); `tests/browser-bundle-secret-guard.test.mts`'s
      dead `VITE_CLERK_PUBLISHABLE_KEY` client-env-allowlist entry (confirmed unread anywhere in
      `src/`).

- [x] **Renamed live internal identifiers off "Clerk" naming** (functionally correct — all already
      delegated to the real Supabase-backed `auth-provider.ts` — just misleadingly named):
      `server/_shared/usage-identity.ts` (`clerkOrgId` → `authOrgId`), `server/_shared/
      entitlement-check.ts` (`clerkRole` → `sessionRole`), `server/gateway.ts` (both field usages +
      ~10 comments describing the auth mechanism as "Clerk JWT"/"Clerk bearer"), `src/services/
      premium-fetch.ts` (`resolveClerkToken`→`resolveAuthToken`, `isClerkUserSignedIn`→
      `isAuthUserSignedIn`, `delayBeforeClerkRetry`→`delayBeforeAuthRetry`,
      `CLERK_TOKEN_RETRY_DELAY_MS`→`AUTH_TOKEN_RETRY_DELAY_MS`, its test-provider interface fields,
      and its file-header docblock's auth-chain description). Updated every touched test file in
      lockstep: `server/__tests__/{usage-identity,entitlement-check,gateway-direct-llm-quota,
      gateway-summarize-article-security}.test.ts`, `tests/usage-telemetry-emission.test.mts`,
      `tests/premium-fetch.test.mts` (22 tests, full rename incl. test titles/prose — all still
      pass). **Deliberately left untouched**: the `auth_kind: 'clerk_jwt'` `AuthKind` union member
      and every place that sets/asserts it — this is a live telemetry wire value shipped to Axiom,
      same category as the "leave identifiers (env vars, storage keys) untouched" decision from the
      earlier "PRO" rename session; renaming it would break continuity of existing analytics data
      for zero benefit. Also left `server/worldmonitor/forecast/v1/trigger-simulation.ts`'s
      `authKind = ... 'clerk_jwt'` log value and `tests/wm-session-interceptor-target.test.mts`'s
      use of `clerk.worldmonitor.app` as one of 3 example third-party domains (a generic
      URL-classifier test, not asserting anything Clerk-specific) — same reasoning.

- [x] **Reworded ~30 more files' current-behavior comments/docblocks/log strings** off stale "Clerk"
      vocabulary (confirmed each describes real current behavior, not history, before touching):
      `INSTALL_GUIDE.md`, `e2e/auth-ui.spec.ts` (retitled the test itself — it was asserting on a
      Clerk-modal premise that doesn't match Supabase's redirect-only flow), `api/mcp-proxy.ts`,
      `api/{discord,slack}/oauth/start.ts`, `api/api-route-exceptions.json` (one reason string),
      `api/brief/[userId]/[issueDate].ts`, `scripts/lib/brief-compose.mjs`, `scripts/
      enforce-premium-fetch.mjs`, `server/_shared/{brief-render.d.ts,brief-render.js,brief-url.ts}`,
      `server/worldmonitor/shipping/v2/{list-webhooks,register-webhook}.ts`, `src/App.ts`, `src/app/
      country-intel.ts`, `src/bootstrap/sw-update.ts`, `src/components/{DeckGLMap,LatestBriefPanel,
      McpConnectModal,McpDataPanel,RegionalIntelligenceBoard,WidgetChatModal}.ts` (`LatestBriefPanel
      .ts` was the largest single file — 11 mentions, entirely un-migrated Clerk framing describing
      already-correct Supabase-backed code), `src/services/{breaking-news-alerts,entitlements(one
      line),notifications-settings,runtime,scenario/index,supply-chain/index,threat-classifier,
      trade/index,wm-session}.ts`, `src/shared/premium-paths.ts`, `src/utils/{cloud-prefs-migrations,
      cloud-prefs-sync,proxy}.ts`. **Left alone as legitimate history** (matches the established
      "accurate migration-narrative comments stay" precedent): every `// Stage 2/3 of the
      Convex/Clerk -> Supabase migration` header (api/{user-prefs,followed-countries,
      notification-channels,telegram/pair-callback}.ts, server/_shared/{alert-rules,
      followed-countries,notification-channels,telegram-pairing,user-preferences,iso2}.ts,
      scripts/seed-digest-notifications.mjs), `src/services/{auth-provider,supabase-client,
      entitlements}.ts`'s "replaces/unlike clerk.ts" comparisons, `src/components/
      AuthHeaderWidget.ts`, `api/mcp/types.ts`, `api/_oauth-token.js` + `api/oauth/token.ts` (both
      already correctly say the Clerk-grant flow "was retired"), `server/_shared/auth-session.ts`,
      and `CHANGELOG.md` (a historical record, never edited).

**Verification for the whole sweep**: `npm run typecheck:all` clean, `node scripts/
enforce-sebuf-api-contract.mjs` clean, `npm run docs:check` clean, `npm run sync:locales:check`
clean (24/24), `npm run sync:csp-hashes:check` clean, a real `npm run build` succeeded, `npm run
test:data` re-run to the exact documented 40-failure baseline (one round briefly showed 41 — the
dead-PWA-precache-test removal — fixed and re-verified clean), `npm run test:sidecar` unchanged (1
pre-existing failure). `npx vitest run server/__tests__/` showed 44 failures across 6 files when run
as a whole directory — **confirmed via `git stash` A/B to be a pre-existing cross-file
test-isolation artifact, unrelated to this session**, since the exact same 44/6 reproduces on the
unmodified baseline; the individual affected files all pass cleanly in isolation (the correct way
to run them, per how earlier sessions verified too).

## ✅ Resolved 2026-08-13 (eighth session) — 3 of the 4 🆕 items below

Picked the two zero-risk, already-recon'd items first, then got an explicit operator go-ahead on
the third (`IS_EMBEDDED_PREVIEW`, a feature-removal call per the tracker's standing convention).
Verified via `npm run typecheck:all` (clean), `node scripts/enforce-sebuf-api-contract.mjs`
(clean — 130 files/96 manifest entries), `npm run docs:check` (clean — 23 doc claims match code),
and targeted `npx tsx --test` runs of every affected test file (all pass, no regressions).
Commits not yet made — pending operator go-ahead alongside the push, per standing convention.

- [x] **`pro-test/package-lock.json` dead baseline entry removed** from
      `BASELINE_ADVISORIES_BY_LOCKFILE` in `.github/scripts/audit-production-dependencies.mjs`
      (entry + its 15-line comment block), confirmed dead against the real CI matrix before
      touching. `tests/security-audit-baseline.test.mjs`'s 4 call sites updated: the two example-key
      tests now use `'scripts/package-lock.json'` + its real `GHSA-mh99-v99m-4gvg` advisory instead
      of the deleted pro-test/clerk example; the baseline-keys-list assertion drops the removed key;
      the stale-entry-detection test was restructured (same logic, no pro-test fixture) into two
      explicit scenarios — both baselines' advisories present (nothing stale) vs. the scripts
      advisory missing (flagged stale) — since no remaining real lockfile has more than one baseline
      entry to demonstrate "some present, some stale" in a single call the old test relied on.
      8/8 tests pass in the file.
- [x] **4 dead Convex-specific `ignoreErrors` patterns removed** from `src/bootstrap/
      sentry-init.ts` (`ConvexError: CONFLICT`, `ConvexError: API_ACCESS_REQUIRED`, the
      `[CONVEX ...]` connection-lost pattern, the sync-protocol version-mismatch pattern) — exact
      4-line deletion as scoped, confirmed zero test coverage before removing (`grep -rn
      "ConvexError\|CONVEX \[AQM\]\|Invalid start version" tests/` empty). Left the other
      Convex-mentioning comments in the same file untouched (lines ~79, ~136-137, ~575, ~621-623)
      — those are migration-history/context comments on still-relevant logic, not dead
      `ignoreErrors` patterns, same distinction the Clerk sweep drew elsewhere. 233/233 tests pass
      across `sentry-beforesend.test.mjs` + `sentry-defer-replay.test.mts`.
- [x] **`IS_EMBEDDED_PREVIEW` mechanism removed** (operator go-ahead given explicitly this
      session) — deleted `src/utils/embedded-preview.ts` outright and its 3 one-line consumer
      guards + matching imports: `src/app/country-intel.ts` (`fetchProSections`'s early return),
      `src/components/RegionalIntelligenceBoard.ts` (`loadCurrent`'s early `renderEmpty()`
      branch), `src/services/trade/index.ts` (2 sites — `fetchTariffTrends` and
      `fetchComtradeFlows`, one more than the original 4-file/1-line-each estimate since that file
      had two call sites). Confirmed zero remaining references repo-wide after
      (`grep -rl IS_EMBEDDED_PREVIEW` clean outside `TASKS.md`'s own history text and
      `src-tauri/target/` build artifacts). 96/96 tests pass across
      `regional-intelligence-board.test.mts` + `trade-policy-tariffs.test.mjs` +
      `country-intel-brief-sources.test.mjs` + `premium-paths-guard.test.mts`.

---

## ✅ Resolved 2026-08-13 (eighth session, later same-day) — the "Dodo" residue sweep

Triaged every file a `grep -rli dodo` (excluding node_modules/dist/git/lockfiles) surfaced (~24
files, close to the earlier session's ~26 estimate). Most were legitimate migration-history
comments matching the Clerk sweep's own established pattern — left untouched. 3 zero-risk fixes
applied directly; one much bigger orphaned-feature cluster found and removed with an explicit
operator go-ahead (asked via the same "feature-removal needs a nod" convention as
`IS_EMBEDDED_PREVIEW` above). Verified via `npm run typecheck:all` (clean), `node scripts/
enforce-sebuf-api-contract.mjs` (clean), `npm run docs:check` (clean), targeted `npx tsx --test`
runs of every directly-affected test file (all pass), and a full `npm run test:data` `git stash`
A/B (40 failures both sides, byte-identical failure-name sets except 2 subtests of the
already-documented flaky `renewable-energy-last-known-good.test.mts` file — reproduced in 3
isolated re-runs, confirmed unrelated to anything touched this session).

- [x] **3 zero-risk stale-comment/dead-config fixes**: `src/config/panels.ts`'s `isPanelEntitled`
      comment ("Dodo entitlements unlock all premium panels" → accurate binary-entitlement
      wording, since Dodo billing tiers don't exist); `tests/browser-bundle-secret-guard.test.mts`'s
      `CLIENT_ENV_ALLOWLIST` dropped the dead `VITE_DODO_ENVIRONMENT` entry (nothing in `src/`
      reads it — the client-side pricing page that used to was already deleted); `tests/
      usage-telemetry-emission.test.mts`'s module header corrected to match the test body's own
      already-documented FIXME (the bearer-JWT `tier` field is now pinned at 0, a known
      post-Stage-1 regression — the header previously claimed it was "covered indirectly," which
      the test directly beneath it disproves).

- [x] **Orphaned "Dodo Product Prices" production seed loop removed from `scripts/ais-relay.cjs`.**
      `startDodoPriceSeedLoop()` was wired into the real boot sequence and, whenever
      `DODO_API_KEY` is configured, called the live Dodo Payments API every 6h to build a pricing
      catalog and write it to Redis key `product-catalog:v2` — confirmed via repo-wide grep that
      **nothing reads that key anymore**: its sole consumer, `api/product-catalog.js`, and the
      freshness test the seeder's own comment cited (`tests/product-catalog-freshness.test.mjs`)
      were both already deleted in an earlier retirement pass, with nothing left behind to clean up
      the seeder itself. Removed the ~150-line block (constants, `fetchDodoProductPrice`,
      `seedDodoPrices`, `startDodoPriceSeedLoop`) and its boot-loop call site; `node -c` confirms
      the file still parses. Also removed the same dead feature's tail:
        - `middleware.ts`'s `PUBLIC_API_PATHS` entry + comment for `/api/product-catalog` (an inert
          bot-filter bypass for a route that 404s) and the matching dedicated describe block +
          `ALLOWED_PATHS` entry in `tests/middleware-bot-gate.test.mts`.
        - `tests/relay-boot-seed-freshness-guard.test.mjs`'s `DodoPrices` row in `SEEDERS` — the
          file's own live source-count assertion (`startBootSeedLoop('` occurrences vs.
          `SEEDERS.length`) self-corrected once both the row and the real call site were gone.
        - `tests/helpers/runtime-config-panel-harness.mjs`'s `dodo-checkout-stub`/`dodo-empty-stub`
          modules and the 4 `dodopayments*`/`@dodopayments/*` alias-map entries pointing at them —
          confirmed dead: the `dodopayments` npm package isn't even in `package.json` anymore, so
          these aliases could never have resolved a real import even before this fix.
        - CSP `Permissions-Policy` `payment=(...)` directive in `vercel.json` +
          `docker/nginx-security-headers.conf` collapsed to `payment=()` (dropped
          `checkout.dodopayments.com`, `test.checkout.dodopayments.com`, `pay.google.com`,
          `hooks.stripe.com`, `js.stripe.com` — all 5 were payment-iframe origins with no
          remaining first-party purpose). Matching `tests/deploy-config.test.mjs:596` hardcoded
          assertion updated to `'payment=()'`.
        - **Bonus finding**: the same 3 files' `frame-src` directive (`vercel.json`,
          `docker/nginx-security-headers.conf`, `docker/nginx.conf`) *also* still allowlisted
          `pay.google.com`/`hooks.stripe.com`/`js.stripe.com` — missed by the earlier "CSP
          frame-src Clerk/Dodo cleanup" session because that pass grepped specifically for
          `clerk|dodopayments`, and these 3 origins match neither string. Dropped from all 3 files;
          no test hardcoded their presence (the existing `frame-src` tests only assert *absence*
          of clerk/dodopayments tokens), so nothing else needed updating.
      **Deliberately left untouched, flagged rather than fixed**: `workers/api-cors-preflight/`'s
      `ALLOW_METHODS` still includes `DELETE`, originally justified by `api/product-catalog.js`'s
      purge endpoint. Whether any other live `api/*` route still needs `DELETE` was **not**
      re-audited this session (a broad grep for real — not vendored-SDK-internal — `DELETE` route
      registrations across `server/worldmonitor/*/v1/*.ts` and hand-written `api/*.ts` found none,
      but the generated `api/*/v1/[rpc].js` gateway files were inconclusive within a reasonable
      search effort) — removing a CORS method without full confidence risks silently breaking a
      real route's preflight, so it's left in place. Reworded the now-stale citations honestly in
      3 places instead of silently deleting: `workers/api-cors-preflight/src/index.js`'s own
      comment, `workers/api-cors-preflight/index.test.mjs`'s `ACAM_EXPECTED` comment, and
      `tests/cors-preflight-live.test.mjs`'s live-preflight comment. **A future session should
      re-audit whether `DELETE` can be dropped from `ALLOW_METHODS` now that `api/product-catalog.js`
      is gone** — flagging here so it isn't lost.
      **Also noticed, explicitly out of scope, not touched**: `tests/seed-contract-probe.test.mjs`'s
      "checkPublicBoundary: a transient first-attempt failure on each endpoint recovers on retry"
      test still simulates a `/api/product-catalog` response and asserts on "both endpoints," but
      the real `api/seed-contract-probe.ts`'s `BOUNDARY_CHECKS` array already only has one entry
      (`/api/bootstrap`) — `/api/product-catalog` was removed from the real boundary-check list in
      an earlier session without the test being updated to match. This is a **pre-existing**
      staleness unconnected to "Dodo" text specifically (predates this sweep, wasn't caught by its
      grep), found only incidentally while tracing the product-catalog cluster. The test currently
      still passes (its `path === '/api/product-catalog'` mock branch is simply unreachable, not
      failing), so it's low-urgency, but worth a follow-up pass.

- **Left alone, confirmed as legitimate migration-history comments** (same precedent as the Clerk
  sweep — accurately describe *why* current code looks the way it does, not stale claims about
  current behavior): `api/widget-agent.ts`, `server/gateway.ts` (×2), `server/_shared/
  entitlement-check.ts`, `server/_shared/notification-channels.ts`, `scripts/
  seed-digest-notifications.mjs`, `scripts/check-sentry-coverage.mjs`, `server/__tests__/
  entitlement-check.test.ts`, `src/components/DeckGLMap.ts`, `src/services/entitlements.ts`,
  `src/services/trade/index.ts` (the fingerprint-fix history comment — separate from the
  `IS_EMBEDDED_PREVIEW` guards removed above), `tests/entitlement-transition.test.mts`, `tests/
  mcp-world-brief-routing.test.mjs`, `tests/mcp.test.mjs`, `tests/notification-relay-ticker-
  filter.test.mjs`, `tests/premium-paths-guard.test.mts`, `tests/widget-builder.test.mjs`.
  `tests/seed-contract-transform-regressions.test.mjs`'s `'dodo'`/`'dodo-v1'` sample string values
  are also fine as-is — illustrative fixture data for a generic envelope-transform test, not a
  reference to any dead function.
  Two self-documented, already-flagged (not newly discovered) larger deferred items surfaced while
  reading `tests/mcp-world-brief-routing.test.mjs` / `tests/mcp.test.mjs`'s own comments: the
  "dead-but-still-wired-up" `BillingDenialError` passthrough machinery in `api/mcp/dispatch.ts`,
  `api/mcp/auth.ts`, `api/mcp/billing-denial.ts` — those comments already say "a future cleanup
  pass should either delete this now-dead machinery or restore its correctness," which is broader
  Convex/Dodo entitlement-fallback scope than this Dodo-text sweep, not picked up here.

---

## ✅ Resolved 2026-08-13 (ninth session) — CORS `DELETE` re-audit + stale probe mock

Picked up the eighth session's 2 leftover low-priority items, in the order the tracker suggested.
Verified via `npm run typecheck:all` (clean), `node scripts/enforce-sebuf-api-contract.mjs` (clean
— 130 files/96 manifest entries), `npm run docs:check` (clean — 23 doc claims match code), targeted
`npx tsx --test` runs of every directly-affected test file (63/63 pass across the 3 files), a full
`npm run test:data` re-run (40 failures — exact byte-for-byte match to the documented pre-existing
baseline names), and `npm run test:sidecar` (0 failures this run — #12's port-binding flake simply
didn't reproduce this time, consistent with its already-documented flakiness).

- [x] **`tests/seed-contract-probe.test.mjs`'s stale `/api/product-catalog` mock fixed.** The
      "checkPublicBoundary: a transient first-attempt failure on each endpoint recovers on retry"
      test simulated 2 boundary endpoints (bootstrap + product-catalog), but the real
      `BOUNDARY_CHECKS` array in `api/seed-contract-probe.ts` only has one entry
      (`/api/bootstrap`) — confirmed by reading the source directly. Rewrote the test to simulate
      only the one real endpoint, dropped the dead `product-catalog`-specific mock branch, and
      retitled it (singular "the endpoint," not "each endpoint"/"both endpoints"). 21/21 tests
      pass in the file.
- [x] **`workers/api-cors-preflight/`'s `ALLOW_METHODS` `DELETE` removed after a full re-audit
      found nothing else needs it.** Traced every possible source of a live DELETE route before
      touching anything: (1) hand-written `api/*.ts` files — repo-wide grep for
      `req.method === 'DELETE'`/`request.method === 'DELETE'` across all of `api/` returned zero
      hits; the handful of case-insensitive "delete" matches in `api/a2a.ts`, `api/notify.ts`,
      `api/notification-channels.ts` are all either the JS `delete` operator, a JSON-RPC method
      *name* (`tasks/pushNotificationConfig/delete`), or an `action: 'delete-channel'` field
      inside a POST body — none are an HTTP DELETE dispatch. (2) `server/gateway.ts`, the core
      sebuf RPC dispatch for all ~34 domains — its only `request.method` branches are
      `'OPTIONS'`, `'POST'`, and `'GET'`; no DELETE branch exists. (3) The generated
      `api/*/v1/[rpc].js` gateway bundles (previously "inconclusive within a reasonable search
      effort" per the eighth session's recon) turned out to be resolvable: read one in full
      (`api/forecast/v1/[rpc].js`, 36.7k lines) and confirmed its noisy `DELETE` string hits are
      all inside bundled vendored SDK code (a Supabase admin client) — the file's own actual route
      registration, at its tail, is just `createDomainGateway(createForecastServiceRoutes(...))`,
      which routes through the same `server/gateway.ts`/`server/router.ts` dispatch already
      checked in (2). (4) `server/router.ts`'s `RouteDescriptor.method` values come from
      sebuf-codegen'd arrays driven by `.proto` HTTP-method annotations; `proto/sebuf/http/
      annotations.proto` does define an `HTTP_METHOD_DELETE` option, but a repo-wide search of
      every `server/worldmonitor/**/*.proto` found zero domains that use it — every real RPC
      sticks to GET/POST. (5) `api/_cors.js`'s `getCorsHeaders(req, methods = 'GET, OPTIONS')` /
      `getPublicCorsHeaders` take a per-caller `methods` string; grepped every call site
      repo-wide and none passes `DELETE`. `server/cors.ts`'s own fallback CORS headers were
      already `'GET, POST, OPTIONS'` with no DELETE, an existing signal this session's audit
      confirms rather than contradicts. Dropped `DELETE` from `ALLOW_METHODS` in
      `workers/api-cors-preflight/src/index.js` (now `'GET, POST, HEAD, OPTIONS'`), reworded its
      header comment to record the audit trail instead of the old "not re-audited" caveat, removed
      the now-obsolete "OPTIONS preflight advertises DELETE (regression — api/product-catalog
      purge)" pinning test and updated `ACAM_EXPECTED` in
      `workers/api-cors-preflight/index.test.mjs` (21/21 tests pass), and updated
      `tests/cors-preflight-live.test.mjs`'s required-methods list + comment to match (this file
      is gated behind `LIVE_SMOKE=1` and hits real production — not run this session since it only
      becomes accurate once the Worker is actually redeployed; syntax-checked via `node --check`
      instead). **Not done — a follow-up, not this session's scope**: actually deploying the
      updated Worker to Cloudflare (`workers/api-cors-preflight/`'s `wrangler` config) so
      production's live `Access-Control-Allow-Methods` header matches the repo; until deployed,
      prod will keep advertising `DELETE` (harmless — a superset is always safe, just no longer
      minimal) and `tests/cors-preflight-live.test.mjs` would still see the old header if run.

---

## 🆕 New flagged items surfaced by the sweep — NOT fixed, out of scope for this pass

- **`pro-test/package-lock.json` dead baseline entry — RESOLVED 2026-08-13 (eighth session)**,
      see the ✅ section immediately above.
- **`IS_EMBEDDED_PREVIEW` mechanism — RESOLVED 2026-08-13 (eighth session)**, operator gave an
      explicit go-ahead when asked; see the ✅ section above this one.
- **4 dead Convex-specific `ignoreErrors` patterns in `sentry-init.ts` — RESOLVED 2026-08-13
      (eighth session)**, see the ✅ section above this one.
- **"Dodo" residue sweep — RESOLVED 2026-08-13 (eighth session)**, see the new ✅ section below
      ("the Dodo sweep") for the full writeup. Triaged all ~24 files a `grep -rli dodo` surfaced;
      most were legitimate migration-history comments (left alone). Found and fixed 3 zero-risk
      stale-comment/dead-config spots directly, plus one much bigger live finding — an orphaned
      production seed loop in `scripts/ais-relay.cjs` still calling the real Dodo Payments API
      every 6h for a feature (`api/product-catalog.js`) that was already deleted — removed with
      explicit operator go-ahead, including its full dead-config tail (middleware bypass, pinning
      test, dead test-harness stub aliases, and the CSP `Permissions-Policy`/`frame-src`
      `payment`-related entries in `vercel.json` + both nginx configs, which turned out to include
      2 more dead origins — `pay.google.com`, `hooks.stripe.com`/`js.stripe.com` — that the earlier
      Clerk/Dodo `frame-src` cleanup session missed because they don't contain "clerk" or "dodo").
- [ ] **`server/__tests__/gateway-summarize-article-security.test.ts`'s "active user API keys
      reuse the resolved entitlement and use the principal bucket" test is a newly-confirmed
      pre-existing failure** (expected 200, got 401) — confirmed via `git stash` A/B against the
      unmodified baseline, unrelated to anything in this session. Already added to the ⚪ reference
      list below as #13 — not an action item, informational only, do NOT "fix" without first
      understanding whether it's a real bug (it hasn't been individually investigated beyond the
      A/B pre-existing-confirmation).
- **`workers/api-cors-preflight/`'s `ALLOW_METHODS` `DELETE` — RESOLVED 2026-08-13 (ninth
      session)**, see the new ✅ section below ("CORS `DELETE` re-audit + stale probe mock").
- **`tests/seed-contract-probe.test.mjs`'s stale `/api/product-catalog` mock — RESOLVED
      2026-08-13 (ninth session)**, see the same ✅ section below.

**Suggested next-session order** (updated 2026-08-13, ninth session — both remaining 🆕 items from
the eighth session done and verified, not yet pushed, see the ✅ section below and Housekeeping):
the tracker's flagged-item backlog is now empty. A future session should ask the operator what's
next rather than assume there's more deferred cleanup to find.

---

## 🟡 Mechanical / low-risk — RESOLVED 2026-08-12, commit `dd63ae6`

Verified via `npm run typecheck:all` (clean), `node scripts/enforce-sebuf-api-contract.mjs`
(clean), `npm run test:data` (failure set byte-identical to the pre-existing `main` baseline,
confirmed both directions via `git stash` A/B), and `npm run test:sidecar` (its one failure
confirmed pre-existing the same way). The checkout-chunk fix was additionally verified against a
real `npx vite build` — the exact condition that used to trigger it — not just the no-op `npm
test` path.

- [x] **`'checkout'` build-chunk bug.** Stripped `'checkout'` from `vite.config.ts`'s
      `LAZY_HTML_PRELOAD_CHUNKS` and the matching helpers/assertions in
      `tests/panel-cluster-chunks.test.mjs` (including the now-pointless
      `checkoutSdkValueImportOffenders` helper, which only existed to vacuously pass against a
      file that's been gone since `3aed889`).

- [x] **2 pre-existing typecheck errors.** `api/user-prefs.ts`: rather than deleting the dead
      `rateLimitHeaders` helper, wired it into the 429 response that was duplicating its exact
      header logic inline — DRYs up real behavior instead of throwing away a working helper.
      `server/_shared/supabase-admin.ts`: gave the memoized client the type
      `SupabaseClient<any, 'worldmonitor'>` instead of the default `'public'`-schema type, matching
      what `createClient(..., { db: { schema: 'worldmonitor' } })` actually returns.

- [x] **2 pre-existing sebuf-contract violations.** Added both to `api/api-route-exceptions.json`:
      `api/followed-countries.ts` as `deferred` (same bucket/reasoning as sibling
      `api/user-prefs.ts` and `api/notification-channels.ts` — plain JSON API, not yet ported to
      sebuf); `api/telegram/pair-callback.ts` as `external-protocol` (permanent — its shape and
      always-200 contract are dictated by the Telegram Bot API, not something to redefine as
      proto, same category as the existing MCP/A2A/NLWeb entries).

- [x] **`robots.txt` + `sitemap.xml` dead-pointer cleanup.** Removed the `Sitemap:
      .../docs/sitemap.xml` line and updated `tests/deploy-config.test.mjs`'s matching assertion;
      stripped the 9 dead `<loc>` entries. Combined with the `public/blog/` cascade fix (below),
      since it touched the same two files.

- [x] **25 `SKILL.md` files' stale "Clerk JWTs" mentions.** Stripped via scripted find/replace
      across all 25, then regenerated `public/.well-known/agent-skills/index.json` (its
      per-file content digests went stale the moment the 25 `SKILL.md` bodies changed — caught
      by `tests/agent-skills-index.test.mjs`, which briefly regressed until the regen). The 4
      Pro-gated files' entitlement language was left untouched at the time (verified via
      `git diff --stat` showing exactly 1 line changed per file) — later resolved separately, see
      the ✅ section above.

- [x] **`ARCHITECTURE.md` accuracy pass.** All 7 confirmed-stale spots fixed (2 more than
      originally estimated, found mid-fix: `pro-test/` directory-tree entry, and the
      `docs/api/` sebuf-codegen diagram line), plus the `.husky/pre-push` dead MDX-lint step
      (called a deleted test file — would have crashed a `RUN_ALL` run) and `docs/api/`
      freshness-check paths that fixing the pre-push step list surfaced.

- [x] **Stale comment in `api/http-message-signatures-directory.ts`.** Fixed both occurrences
      (docblock + inline comment) to stop describing `/.well-known/mcp-registry-auth` as live.

- [x] **`public/blog/` orphaned content — operator said delete it.** `blog-site/` (the Astro
      *source*, 231 files) was deleted in `7a4308e`, but its pre-built static output at
      `public/blog/` (52 posts, RSS, sitemap, images, `_astro/` assets) survived on disk with no
      source left to ever rebuild it. Turned out to be moot either way: `public/blog/` was
      **gitignored and never committed** (`.gitignore:4`, alongside `public/countries/`,
      `public/chokepoints/`, `public/reference/`, `public/crises/` — all externally-generated
      content dirs that don't live in git), so a fresh clone or real deployment never had it in
      the first place; the local copy was just leftover from an Astro build run before
      `blog-site/` was deleted. `rm -rf public/blog` (no git diff — it was never tracked). Fixed
      what pointed at it, since those files ARE tracked: `index.html` (5 links: the "Blog" nav
      item, 3 post links, the glossary link, the noscript-block "Read more" paragraph's 3 post
      links), `public/sitemap.xml` (~15 `<url>` blocks), `public/robots.txt` (the
      `blog/sitemap-index.xml` `Sitemap:` line).

---

## 📌 Housekeeping — also don't forget

- [x] **First 7 commits (`7a4308e`..`6ea13d7`) pushed to `origin/main` 2026-08-12** — confirmed
      `main`/`origin/main` in sync after a transient HTTP/2 framing error resolved on retry.
- [x] **The "PRO" internal-branding rename commit (fifth session, 92 files) pushed 2026-08-12** —
      `f233f7c` pushed to `origin/main` on operator's go-ahead at the start of the next session;
      `main`/`origin/main` confirmed in sync.
- [x] **`e8d59a7`, `d02f27c`, and `056d990` (this eighth session's work: the 3 zero-risk 🆕
      fixes, `IS_EMBEDDED_PREVIEW` removal, and the Dodo sweep) pushed to `origin/main`
      2026-08-13** — operator go-ahead given; `main`/`origin/main` confirmed in sync
      (`f233f7c..056d990`).
- [ ] **Ninth session's 4 commits are committed locally but NOT pushed** (one more than previously
      recorded — `d6b92cb` was added closing out the ninth session, a docs-only housekeeping-count
      correction in this file) — `d6b92cb`, `5e80a62` (CORS `DELETE` re-audit + stale probe mock),
      `4ef902a` (docs-only domain-migration scoping in this file), `c62a798` (domain-config Stage
      1). Confirmed via `git branch -vv`: `main` is 4 ahead of `origin/main`, **verify this count
      yourself before trusting it** — it has drifted between sessions before. `5e80a62` and
      `c62a798` both touch `workers/api-cors-preflight/**`, which triggers a real Cloudflare Worker
      deploy via `.github/workflows/deploy-worker.yml` on push to `main` — needs an explicit operator
      go-ahead before pushing, same standing convention as every other session. Simplest to push all
      4 together once given the go-ahead (pushing the docs-only ones out of order would leave `main`
      history with the Worker-affecting commits still stacked on top locally).
- [x] **2 small items noticed during the ninth session's domain-config work — RESOLVED tenth
      session**, see the Stage 2 ✅ section above: `server/gateway.ts:1304`'s cosmetic hardcode now
      uses `resolveAppOrigin(process.env.APP_DOMAIN)`; `cli/package.json`'s `repository.url`/`bugs`/
      `homepage` now point at the real `origin` remote (`github.com/powerpro-led/worldmonitor`).
- [ ] **Tenth session's entire Stage 2 sweep (135 modified + 4 new files) is UNCOMMITTED** — not
      merely unpushed, no commit exists for this work yet at all. Needs an explicit decision on
      commit granularity (one large commit vs. several logical ones — e.g. core module +
      client-plumbing / functional-code wiring / static-content sync / bugfixes / Dockerfile+CSP
      regression fixes) before it can even be considered for push. Once committed, it joins the
      same `workers/`-adjacent push-gate as the items above (`scripts/_domain-config.mjs`
      generation touches ops scripts deployed to Railway, not Cloudflare, but several touched files
      — `middleware.ts`, `api/mcp/downstream.ts`, `api/oauth/authorize.js` — are security/CORS/
      routing-relevant enough to warrant the same explicit-go-ahead treatment as a Worker-touching
      commit, even though this particular sweep didn't touch `workers/api-cors-preflight/**`
      itself). **Read the tenth-session ✅ section above in full before touching any of this again**
      — it documents a sharp edge (`sync-domain-literals.mjs` can only be reverted via `git
      checkout`, never by re-running itself) that cost real time twice in one session.

---

## ⚪ Confirmed pre-existing — reference only, do NOT re-investigate as regressions

`panel cluster chunk guardrails` (was #10 here) is **FIXED** — see the 🟡 section above — and
dropped from this list. Two more confirmed pre-existing via the same `git stash` A/B method
during the 2026-08-12 mechanical pass, added below (#11, #12); the original ten are otherwise
unchanged. `readBootstrapTierObject` (#1) is confirmed **flaky under concurrent execution** —
passes reliably in isolation (`npx tsx --test tests/bootstrap-r2-reader.test.mjs`, 3/3 clean
runs), only fails intermittently as part of the full concurrent `npm run test:data` suite; two
consecutive full-suite runs during the Pro-leftover pass showed it failing once and passing once
with zero other differences — not something to chase further, matches the same flakiness class as
#9.

1. `readBootstrapTierObject` — confirmed flaky under concurrency, see note above.
2. `Bootstrap endpoint (api/bootstrap.js)`
3. `browser bundle secret guard (#3704)`
4. `CI workflow coverage`
5. `Edge Function no node: built-ins` — stale committed `api/*/v1/[rpc].js` build artifacts;
   regenerate via build to fix
6. `no non-timing-safe secret comparison in api/ (#3803)`
7. `public documentation plan-reference guard` — references the separate `platform` repo's docs
8. `Railway service registry coverage` — 3 `Dockerfile.*` CMD entries missing from
   `scripts/railway-services.json`
9. `renewable energy last-known-good recovery (#5497)` — flaky, inconsistent even in isolation
   on `main`; looks like a real timing race in the test's async persistence-flush helper, not
   date-dependent
10. ~~`panel cluster chunk guardrails`~~ — **FIXED**, see 🟡 section above.
11. `dashboard critical CSS graph` — confirmed pre-existing 2026-08-12 via `git stash` A/B; not
    yet individually investigated beyond that.
12. `service-status reports bound fallback port after EADDRINUSE recovery`
    (`src-tauri/sidecar/local-api-server.test.mjs`, part of `npm run test:sidecar`) — confirmed
    pre-existing 2026-08-12 via `git stash` A/B, re-confirmed again during the Pro-leftover pass;
    a port-binding test, plausibly flaky/environment-dependent rather than a real bug, but not
    individually investigated beyond the A/B.
13. `server/__tests__/gateway-summarize-article-security.test.ts`'s "active user API keys reuse
    the resolved entitlement and use the principal bucket" test (expects 200, gets 401) —
    confirmed pre-existing 2026-08-12 via `git stash` A/B during the Clerk-retirement sweep; not
    individually investigated beyond the A/B. Note: running the full `server/__tests__/` directory
    together via `npx vitest run` also shows 44 failures across 6 files total (vs. 1 when files
    run individually/in their normal small groups) — confirmed via the same A/B to be a
    pre-existing cross-file test-isolation artifact unrelated to any session's changes, not
    something to chase; run affected files individually to get the real signal.

**Not pre-existing failures, but worth remembering — both were real regressions introduced and
fixed within the same session/pass, not carried forward as open items:**

- `agent readiness: agent-skills index` (`tests/agent-skills-index.test.mjs`) broke during the
  mechanical-backlog pass — the 25-file Clerk-mention edit invalidated
  `public/.well-known/agent-skills/index.json`'s per-file content digests. Fixed by running
  `npm run build:agent-skills`. **Reminder: editing any `SKILL.md` requires that regen step** —
  easy to forget, silent until this specific test catches it.
- `security header guardrails` (`tests/deploy-config.test.mjs`) broke during the Pro-leftover
  pass — editing `index.html`'s JSON-LD content changed 2 inline-script SHA-256 hashes that are
  hand-maintained in 3 separate files. See the 🆕 "CSP hash triple-maintenance" entry above for
  the full lesson.
