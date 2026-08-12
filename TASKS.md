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

- **Not done, still stale, found while touching this file**: `api/latest-brief.ts`'s reason
  ("Auth-gated and Clerk-coupled...") and `api/notify.ts`'s reason ("validates Clerk bearer
  auth...") still say Clerk by name — same category as the 2 fixed above but outside this item's
  original 2-file scope; add to the next pass.

---

## 🆕 New findings from the 2026-08-12 fix passes (2 still open)

- [ ] **"PRO" is used as a pervasive internal badge/naming convention across ~60 files** — found
      via a final repo-wide grep while closing out the item above, and **deliberately NOT
      touched**: this is a much bigger question (rebrand the whole "Pro feature" concept's
      internal naming?) than the dead-link/dead-gate bugs this session fixed. Examples: visible
      "PRO" badges/chips (`panel-toggle-pro-badge`, `layer-pro-badge`, mobile nav's "PRO" tab,
      CSS in `main.css`), a **real, currently-enforced** anonymous-user cap (`FREE_MAX_PANELS =
      40`, `FREE_MAX_SOURCES = 80` in `src/config/panels.ts`, shown via locale strings
      `freePanelLimit`/`freeSourceLimit` — genuinely still enforced for signed-out visitors, not
      dead, just worded "Upgrade to PRO" instead of "Sign in"), and dozens of `// PRO-gated`
      code comments describing the (real, correct) signed-in/signed-out gate mechanism. None of
      this is broken — it's consistent, working internal terminology that predates the Stage-1
      binary-entitlement decision and was never renamed to match it. Whether to rename "PRO" →
      something reflecting "signed in" throughout the UI is a real product/branding call, not a
      mechanical fix — ask the operator before touching any of this.

- [ ] **CSP `script-src` hash allowlist is hand-maintained in 3 separate files that must stay in
      byte-identical sync**: `vercel.json`, `docker/nginx-security-headers.conf`,
      `docker/nginx.conf`. Editing any inline `<script>` in `index.html` (including JSON-LD
      `<script type="application/ld+json">` blocks — not just executable scripts) changes that
      script's SHA-256 hash, which must be updated in **all three** files or `tests/deploy-
      config.test.mjs` fails (caught this exact regression during the Pro-leftover fix pass —
      editing `index.html`'s JSON-LD `offers` array changed 2 hashes; found and fixed all 3
      copies only because the test suite has 3 separate assertions, one per file-pair, that
      caught each one in turn). **Lesson for next time**: after any `index.html` edit that
      touches content inside a `<script>` tag, immediately run `npx tsx --test tests/deploy-
      config.test.mjs` before considering the change done — don't wait for the full suite.

~~CSP `frame-src` Clerk/Dodo cleanup~~, ~~`docs:check`'s 11 errors~~, and ~~the 2
`api-route-exceptions.json` Clerk-reason entries~~ — all **FIXED**, see the ✅ section above.

- [ ] `src/settings-main.ts`'s "License / API Key" section (the one that *survived* the "register"
      section removal) still describes "API Starter and API Business subscribers create this key
      on the web dashboard under Settings → API Keys" — also describes a dead self-service/billing
      flow, same category as the section that was removed, but this text is translated across 26
      locale files and wasn't in scope of the 3 questions asked this session. Flagging, not fixing
      — would need either a real 26-locale translation pass or an English-only fix that leaves the
      other 25 locales inconsistent (the same tradeoff already declined for the removed
      "register" section, resolved there by deletion instead — deletion isn't available here since
      the manual-key-paste feature itself is real and still needed).

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

- [ ] **5 commits on `main` not yet pushed** — confirm with operator before pushing:
      `7a4308e` (public-product-surface retirement: blog-site/docs/sdk/registry deletion),
      `5551550` (TASKS.md tracker creation), `dd63ae6` (2026-08-12 mechanical-backlog fix pass +
      `public/blog/` deletion), `1eaab4c` (TASKS.md updated with those results), `d580d1a`
      (the "Upgrade to Pro" leftover resolution — see the ✅ section above).

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
