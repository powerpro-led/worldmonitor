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

## 🔴 Needs an operator product decision first — do not do mechanically

- [ ] **"Upgrade to Pro" leftover — re-grepped 2026-08-12, corrected count: 19 files, not 12.**
      Live links/UI/API gates pointing at the now-deleted `/pro` page. Decision needed: what
      should each of these *do* now that there's no Pro tier — just strip the link, or does the
      underlying gate need real logic removed too?

      **Files with actual enforcement (403 `pro_required` gate) — most important sub-decision:**
      - `api/latest-brief.ts:201-203` — gates the brief endpoint
      - `api/notify.ts:61` — gates event publishing
      - `api/brief/share-url.ts:98` — gates brief sharing. **Not in the original memory list —
        found only by this re-grep.**

      **Files that link to `/pro` but don't gate anything themselves (informational/CTA only):**
      - `api/a2a.ts:92` — tells agents to issue a key at `/pro`
      - `api/oauth/authorize.js:188,193` — HTML page, "Get one at worldmonitor.app/pro" (2x)
      - `api/brief/public/[hash].ts:81` — "Start your own WorldMonitor Brief" → `/pro`
      - `server/_shared/brief-render.js:726,1618` — generates the `/pro` URLs the above consume
      - `src/settings-main.ts:256`
      - `src/app/panel-layout.ts:88,718,785` — comment + 2 live links
      - `src/components/Panel.ts:934` — base Panel class click handler, opens `/pro`
      - `src/components/RuntimeConfigPanel.ts:375`
      - `src/components/UnifiedSettings.ts:129`
      - `src/components/RouteExplorer/RouteExplorer.ts:364`
      - `src/services/notifications-settings.ts:117`
      - `src/components/CountryDeepDivePanel.ts` — 6x "Upgrade to PRO" text via a `makeProLocked`
        helper (no direct URL in this file — delegates to the shared helper)
      - `src/components/RouteExplorer/components/LeftRail.ts:75` — same `makeProLocked` pattern
      - `src/components/LatestBriefPanel.ts:112` — comment only, references the base class's
        generic "Upgrade to Pro" state

      **Public-facing docs/marketing (same decision, different bucket):**
      - `cli/README.md:32` — "Data commands need a user API key (get one at .../pro)"
      - `index.html` — 5 occurrences: JSON-LD `Offer` schema named `"Pro (Waitlist)"` (line ~86,
        **the "Waitlist" word is stale on its own — see below**), `url` field (~150), a
        "World Monitor Pro" nav link (~445), plus a separate "upgrade to World Monitor Pro" link
        in the footer blurb (~530). **CORRECTION (2026-08-12 re-grep): the footer blurb's 3
        `blog-site` post links are NOT dead** — `blog-site/` (the Astro *source*) was deleted, but
        its pre-built static output at `public/blog/` was not, and still serves all 52 posts
        including those 3. See the orphaned-blog item below; don't "fix" these as broken links.

- [ ] **4 `SKILL.md` files** (not 3) still describe a defunct Pro-gated (entitlement tier ≥ 1)
      model, all under `public/.well-known/agent-skills/`:
      `check-sanctions-pressure/SKILL.md`, `trace-trade-flows/SKILL.md`,
      `track-tariff-trends/SKILL.md`, `fetch-resilience-score/SKILL.md`. Same decision bucket as
      above. Bonus staleness: `fetch-resilience-score/SKILL.md` also references Clerk JWTs, and
      Clerk is already gone per [[supabase-migration-stage1]]/[[retire-convex-saas-complete]] —
      that line is doubly stale independent of the Pro decision.

- [x] **`public/blog/` orphaned content — RESOLVED 2026-08-12, operator said delete it.**
      `blog-site/` (the Astro *source*, 231 files) was deleted in `7a4308e`, but its pre-built
      static output at `public/blog/` (52 posts, RSS, sitemap, images, `_astro/` assets) survived
      on disk with no source left to ever rebuild it. Turned out to be moot either way:
      `public/blog/` was **gitignored and never committed** (`.gitignore:4`, alongside
      `public/countries/`, `public/chokepoints/`, `public/reference/`, `public/crises/` — all
      externally-generated content dirs that don't live in git), so a fresh clone or real
      deployment never had it in the first place; my local copy was just leftover from an Astro
      build run before `blog-site/` was deleted. `rm -rf public/blog` (no git diff — it was never
      tracked). Fixed what pointed at it, since those files ARE tracked: `index.html` (5 links:
      the "Blog" nav item, 3 post links, the glossary link, the noscript-block "Read more"
      paragraph's 3 post links), `public/sitemap.xml` (~15 `<url>` blocks), `public/robots.txt`
      (the `blog/sitemap-index.xml` `Sitemap:` line). Commit `dd63ae6`.

- [x] **Broader "assumes a public audience" sweep — DONE 2026-08-12.** Re-grepped for deleted
      docs/blog-site/sdk/mcp-registry surfaces plus Convex/Clerk (both retired separately, see
      [[retire-convex-saas-complete]]). Findings below, split into what needs a decision (above)
      vs. pure mechanical cleanup (moved to the 🟡 section below since none of it is ambiguous):
      - `public/robots.txt` still advertises `Sitemap: https://www.worldmonitor.app/docs/sitemap.xml`
        — `docs/` (Mintlify) is fully deleted, this now points at a 404. A test
        (`tests/deploy-config.test.mjs:262`) actively *asserts* this dead line must stay present —
        fix the line and the test together or the test will fail.
      - `public/sitemap.xml` carries **9 dead `<loc>` entries**: `support.md`, `ai-search.md`,
        `developers.md`, `mcp-server.md`, `openapi.md`, `sdks.md` (lines 16–46) and `llms.txt`,
        `llms-full.txt`, `api/llms.txt` (lines 52–64) — confirmed none of these files exist under
        `public/` anymore. The ~15 `/blog/...` entries in the same file are, by contrast, **fine**
        — see the orphaned-blog decision item above, they still resolve.
      - `public/schemamap.xml` was already correctly cleaned up when the retirement happened (down
        to just the homepage entry) and even carries a comment + a passing test
        (`deploy-config.test.mjs`, "NLWeb schemamap" describe block) guaranteeing every `<loc>`
        resolves — worth using as the template for how `sitemap.xml` should end up.
      - `api/http-message-signatures-directory.ts:19,36` — comments describe the Ed25519 key as
        "mirroring the Ed25519 key already published at `/.well-known/mcp-registry-auth`", but
        that endpoint no longer exists (no route serves it; the only remaining trace is a
        gitignored, stale `dist/.well-known/mcp-registry-auth` build artifact). Low-severity —
        engineer-facing comment only, nothing user-facing — but factually wrong as written.
      - **25 of ~28 `SKILL.md` files** under `public/.well-known/agent-skills/*/SKILL.md` carry a
        boilerplate auth line mentioning "Clerk JWTs" (e.g. `"Authorization: Bearer ... is for
        MCP/OAuth or Clerk JWTs — not raw API keys"`). Clerk was fully removed per
        [[supabase-migration-stage1]]. This is separate from, and much bigger than, the 4-file
        Pro-gate SKILL.md item above — those 4 files already correctly say "operator-issued, no
        self-service signup," they just *also* have the stale Clerk mention. **Not
        decision-blocked** — Clerk is unambiguously gone, this is a mechanical find/replace.
      - `ARCHITECTURE.md` was not updated when Convex/Mintlify-docs were retired — stale in **7**
        places, not 5 (2 more found while fixing): the tech-stack table's `Convex` and
        `Documentation | Mintlify` rows; the "Source files" citation of `convex/schema.ts`; the
        CI-workflow table's `convex-deploy.yml` row (that workflow file is already deleted); the
        directory-tree's `convex/` **and `pro-test/`** entries (`pro-test/` confirmed gone too,
        same SaaS-retirement sweep); the `docs/generated/stats.json` path comment (real path moved
        to `scripts/generated/stats.json`); the sebuf-codegen directory diagram still showing
        `docs/api/` as an output (removed from `proto/buf.gen.yaml` when docs/ was retired, per
        that file's own comment); and the pre-push-hook step list still naming a "MDX lint
        (Mintlify compatibility)" step. **That last one uncovered a live bug, not just a doc
        staleness**: `.husky/pre-push` still had that MDX-lint block for real, calling
        `node --test tests/mdx-lint.test.mjs` — a file that no longer exists — gated behind
        `RUN_ALL`, so a full/forced pre-push run would have crashed. Also dropped `docs/api/` from
        the proto-freshness-check's `git diff`/`git ls-files` paths in the same hook for the same
        reason.
      - Confirmed clean, no action needed: `sdk/` package (zero leftover source references),
        `mcp-registry-auth` / `server.json` public-registry-publication surface (zero leftover
        references outside the one comment above), `.well-known/agent-skills/*` key-acquisition
        language in the 2 files sampled outside the Clerk issue (already correctly say
        "operator-issued, no self-service signup" — the retirement got this part right).

---

## 🟡 Mechanical / low-risk — pick up anytime, no decision blocking

**All items below RESOLVED 2026-08-12, commit `dd63ae6`.** Verified via `npm run typecheck:all`
(clean), `node scripts/enforce-sebuf-api-contract.mjs` (clean), `npm run test:data` (failure set
byte-identical to the pre-existing `main` baseline, confirmed both directions via `git stash`
A/B), and `npm run test:sidecar` (its one failure confirmed pre-existing the same way). The
checkout-chunk fix was additionally verified against a real `npx vite build` — the exact
condition that used to trigger it — not just the no-op `npm test` path.

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
      stripped the 9 dead `<loc>` entries. Combined with the `public/blog/` cascade fix above,
      since it touched the same two files.

- [x] **25 `SKILL.md` files' stale "Clerk JWTs" mentions.** Stripped via scripted find/replace
      across all 25, then regenerated `public/.well-known/agent-skills/index.json` (its
      per-file content digests went stale the moment the 25 `SKILL.md` bodies changed — caught
      by `tests/agent-skills-index.test.mjs`, which briefly regressed until the regen). The 4
      Pro-gated files' entitlement language was left untouched (verified via `git diff --stat`
      showing exactly 1 line changed per file) — that part is still in the 🔴 decision-blocked
      bucket above.

- [x] **`ARCHITECTURE.md` accuracy pass.** All 7 confirmed-stale spots fixed (see the sweep
      writeup above for the extra 2 found mid-fix), plus the `.husky/pre-push` dead MDX-lint step
      and `docs/api/` freshness-check paths that fixing #6 (the pre-push step list) surfaced.

- [x] **Stale comment in `api/http-message-signatures-directory.ts`.** Fixed both occurrences
      (docblock + inline comment) to stop describing `/.well-known/mcp-registry-auth` as live.

---

## 🆕 New findings from the 2026-08-12 fix pass (not yet actioned)

- [ ] **`npm run docs:check` already fails with 11 pre-existing errors** — confirmed via `git
      stash` A/B unrelated to anything in this session. 2 are CI-workflow-table gaps
      (`nitric-deploy.yml` and `publish-cli.yml` exist but aren't listed in `ARCHITECTURE.md`'s
      table — the opposite direction of the `convex-deploy.yml` staleness fixed above, i.e. this
      checker only catches *missing* entries, not *stale/removed* ones, which is how
      `convex-deploy.yml` survived undetected for as long as it did). The other 9 are numeric
      capability-count drift across `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`
      (protos, services, component files, service modules — doc says one number, code says a
      lower one in every case, consistent with recent deletions shrinking real counts). Fix is
      mechanical: add the 2 workflow rows, then run `npm run docs:stats` to resync the numbers —
      not done here, this is new scope beyond the original TASKS.md list.

- [ ] **2 more `api-route-exceptions.json` entries carry the same stale "pending Clerk migration"
      reason text** as the one originally flagged in `fetch-resilience-score/SKILL.md`:
      `api/user-prefs.ts` ("part of user/v1 service work pending Clerk migration") and
      `api/notification-channels.ts` ("Deferred until Clerk migration settles"). Clerk is fully
      gone. Not touched — the new `api/followed-countries.ts` entry added above was deliberately
      worded to avoid repeating this (references the sibling endpoints instead of Clerk).

---

## 📌 Housekeeping — also don't forget

- [ ] **3 commits on `main` not yet pushed** — confirm with operator before pushing:
      `7a4308e` (public-product-surface retirement: blog-site/docs/sdk/registry deletion),
      `5551550` (this TASKS.md tracker), `dd63ae6` (the 2026-08-12 mechanical-backlog fix pass +
      `public/blog/` deletion, detailed throughout this file).

---

## ⚪ Confirmed pre-existing — reference only, do NOT re-investigate as regressions

`panel cluster chunk guardrails` (was #10 here) is now **FIXED** — see the 🟡 section above —
and dropped from this list. Two more confirmed pre-existing via the same `git stash` A/B method
during the 2026-08-12 fix pass, added below (#11, #12); the original ten are otherwise unchanged.
`npm run test:data`'s failure set is now byte-identical to this list, confirmed via
`comm -13 <(git-stash-baseline) <(current)` being empty.

1. `readBootstrapTierObject`
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
    pre-existing 2026-08-12 via `git stash` A/B; a port-binding test, plausibly flaky/environment-
    dependent rather than a real bug, but not individually investigated beyond the A/B.

**Not a pre-existing failure, but worth remembering:** `agent readiness: agent-skills index`
(`tests/agent-skills-index.test.mjs`) broke *during* the 2026-08-12 fix pass — a real,
self-inflicted regression from the 25-file Clerk-mention edit, not a pre-existing one. Cause:
`public/.well-known/agent-skills/index.json` stores a content digest per `SKILL.md`, which the
edit invalidated. Fixed in the same pass by running `npm run build:agent-skills` to regenerate
it. Documented here only as a reminder that **editing any `SKILL.md` requires that regen step**
— easy to forget, the failure mode is silent until this specific test catches it.
