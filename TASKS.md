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

## 🅿️ Parked 2026-08-13 (ninth session) — full domain migration off `worldmonitor.app`

**Blocked on operator decisions, not on more investigation.** Operator's stated final goal: this
fork should stop being reachable at / referencing `worldmonitor.app` in production, on **new
independent infra** (a separate Vercel project + a separate Cloudflare zone, not repointing the
current ones) — but **no replacement domain has been chosen yet**. Do not start executing any part
of this until a domain is picked; the scoping below exists so the actual migration can move fast
once one is.

**Scale**: `grep -rli worldmonitor\.app` (excluding node_modules/dist/git/build artifacts) hits
**339 files**. This is roughly 5× the size of the largest prior sweep (the "PRO" rename, 93 files).
Breakdown: 121 `tests/`, 46 `scripts/`, 46 `public/`, 34 `api/`, 32 `src/`, 17 `server/`, 7
`workers/`, plus `src-tauri/`, `docker/`, `.github/`, `e2e/`, `cli/`, `vscode-extension/`, `data/`,
and root-level config/docs.

**Needed before any code changes** (operator/infra decisions, not something to guess at):
1. The new domain name itself (registered + DNS-controllable).
2. A new Vercel project provisioned under it.
3. A new Cloudflare zone + Worker route provisioned under it (mirrors the current
   `workers/api-cors-preflight` binding to `api.worldmonitor.app/*`).
4. Whether the 5 "variant" subdomains (`tech.`/`finance.`/`commodity.`/`happy.`/`energy.
   worldmonitor.app` — see `src/config/variants/*.ts`, the Tauri CSP's `frame-src`) carry over as
   the same concept on the new domain, or get dropped/renamed.
5. Whether the Tauri desktop app's bundle identifier (`app.worldmonitor.desktop` in
   `src-tauri/tauri.conf.json:6`) changes. **This is not cosmetic** — changing it breaks the
   auto-update chain for anyone with the app already installed (a new identifier = a new app
   identity to the OS; existing installs won't silently follow). Needs an explicit go/no-go, not a
   default assumption either way.
6. A real, working mailbox on the new domain before cutover — `shared/hapi-app-identifier.json`
   hardcodes `monitor@worldmonitor.app` as a live contact address, not just a string.
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
