# Open Work Tracker

Single source of truth for deferred/flagged work that survived the public-product-surface and
Convex/SaaS retirements (2026-08-11 → 2026-08-12). Purpose: so a long-running or future session
can pick one item cold without re-deriving context or re-investigating things that were already
confirmed pre-existing.

**Rule:** when you pick up an item, flip its checkbox and add a one-line "resolved: <how, commit>"
note under it. Don't delete resolved items — leave the trail. Add new deferred work here instead
of only writing a memory file, so it doesn't require a memory search to rediscover.

Related Claude memory entries (fuller narrative/context per item):
`retire_public_product_surface.md`, `retire_convex_saas_complete.md`.

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

## 🆕 New flagged items surfaced by the sweep — NOT fixed, out of scope for this pass

- [ ] **`.github/scripts/audit-production-dependencies.mjs`'s `'pro-test/package-lock.json'`
      baseline entry references a directory that no longer exists on disk** (`ls pro-test` →
      no such file/directory) — unrelated to Clerk specifically; looks like a leftover from the
      retired "Pro" test-build path (see `public/pro/` mentions in the same file's comments). If
      this lockfile path is ever audited for real in CI, `readAuditReport`'s `copyFileSync` would
      throw. Needs its own investigation of what actually calls this script with that path today.
- [ ] **`src/utils/embedded-preview.ts`'s `IS_EMBEDDED_PREVIEW` mechanism may be entirely dead
      code.** It exists solely to detect the `/pro` marketing page's live-preview iframe (marker:
      `?embed=pro-preview`, embedder: `pro-test/src/App.tsx`) — but `pro-test/` doesn't exist on
      disk (same missing directory as the item above) and the whole `/pro` marketing surface was
      already retired. If confirmed unreachable, this touches 4 files (`embedded-preview.ts` +
      3 consumers: `src/app/country-intel.ts`, `src/components/RegionalIntelligenceBoard.ts`,
      `src/services/trade/index.ts`). Not investigated further — a real feature-removal decision,
      not a Clerk-cleanup task; flagging for a future session.
- [ ] **`src/bootstrap/sentry-init.ts` still has 4 dead Convex-specific `ignoreErrors` patterns**
      (`ConvexError: CONFLICT`, `ConvexError: API_ACCESS_REQUIRED`, the `[CONVEX ...]` connection-
      lost pattern, the Convex sync-protocol version-mismatch pattern) — same "unreachable now that
      the SDK is gone" category as the Clerk patterns just removed from this same file, but Convex
      is a separate retirement (see `retire-convex-saas-complete` memory) and out of scope here.
- [ ] **`server/__tests__/gateway-summarize-article-security.test.ts`'s "active user API keys
      reuse the resolved entitlement and use the principal bucket" test is a newly-confirmed
      pre-existing failure** (expected 200, got 401) — confirmed via `git stash` A/B against the
      unmodified baseline, unrelated to anything in this session. Add to the ⚪ reference list below
      as #13 next time that list gets touched.

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
- [ ] **The CSP-hash-tooling + settings-copy commit (`e8d59a7`) and the full Clerk-retirement-sweep
      commit that follows it are NOT yet pushed** — confirm with operator before pushing, per
      standing repo convention.

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
