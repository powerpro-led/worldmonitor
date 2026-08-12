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

- [ ] **`public/blog/` is now orphaned content** — found during the sweep below, but it's a real
      decision, not mechanical. `blog-site/` (the Astro *source*, 231 files) was deleted in
      `7a4308e`, but its pre-built static output at `public/blog/` (52 posts, RSS, sitemap,
      images, `_astro/` assets) was NOT deleted and is still served live — `index.html`,
      `public/sitemap.xml`, and `public/robots.txt` all still link/point into it, correctly, since
      it still works. The catch: there is no source left to ever edit, regenerate, or rebuild it —
      it's now permanently frozen content with no build pipeline. Decision needed: leave it frozen
      indefinitely (fine, just know that's the state), or delete `public/blog/` too for
      consistency with "no public product surface" (in which case *then* the links into it in
      `index.html`/`sitemap.xml`/`robots.txt` become real dead links to fix). Don't delete
      `public/blog/` without asking — unlike `blog-site/`, deleting it is a live-content removal,
      not cleanup of an already-dead thing.

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
      - `ARCHITECTURE.md` was not updated when Convex/Mintlify-docs were retired and needs an
        editing pass — confirmed stale in at least 5 places: the tech-stack table's `Convex` row
        (line 65, "Contact form submissions, waitlist registrations") and `Documentation |
        Mintlify` row (line 66); the "Source files" list citing `convex/schema.ts` (line 70,
        `convex/` dir is deleted); the CI-workflow table's `convex-deploy.yml` row (line 376 —
        **the workflow file itself is already deleted**, confirmed via `ls`, so this table row is
        pure fiction now); the directory-reference tree's `convex/` entry (line 395); and one
        pointer comment (line 3) citing `docs/generated/stats.json` as the stats source of truth
        — the actual path is now `scripts/generated/stats.json` (confirmed the script already
        writes there; only the doc comment wasn't updated to match). None of this is ambiguous —
        every referenced thing is already confirmed gone, so it's a straight accuracy pass, not a
        decision.
      - Confirmed clean, no action needed: `sdk/` package (zero leftover source references),
        `mcp-registry-auth` / `server.json` public-registry-publication surface (zero leftover
        references outside the one comment above), `.well-known/agent-skills/*` key-acquisition
        language in the 2 files sampled outside the Clerk issue (already correctly say
        "operator-issued, no self-service signup" — the retirement got this part right).

---

## 🟡 Mechanical / low-risk — pick up anytime, no decision blocking

- [ ] **`'checkout'` build-chunk bug.** `vite.config.ts`'s `LAZY_HTML_PRELOAD_CHUNKS` list and
      `tests/panel-cluster-chunks.test.mjs` still expect a `checkout-*.js` chunk. Root cause:
      `src/services/checkout.ts` was deleted in commit `3aed889` ("refactor: remove
      entitlement-check tests and add Supabase integration") — predates the Convex/SaaS
      retirement entirely. Silent in a bare `npm test` (the test no-ops when `dist/` doesn't
      exist) — only surfaces after a real `npm run build` / `vite build`. Confirmed pre-existing
      via `git stash` A/B. Fix = pick one: strip `'checkout'` from the exclusion list + test, or
      restore real code-splitting for it (probably nothing left to split, so likely just strip).

- [ ] **2 pre-existing typecheck errors** (`npm run typecheck:all`):
      - `api/user-prefs.ts:74` — `rateLimitHeaders` declared but never called (dead function;
        rest of file unrelated to any recent work)
      - `server/_shared/supabase-admin.ts:46` — `SupabaseClient<..., "worldmonitor", ...>` not
        assignable to `SupabaseClient<..., "public", "public", ...>` (generic mismatch)

- [ ] **2 pre-existing sebuf-contract violations** (`enforce-sebuf-api-contract.mjs`):
      `api/followed-countries.ts` and `api/telegram/pair-callback.ts` are missing entries in
      `api/api-route-exceptions.json` (or need to become real sebuf RPCs).

- [ ] **`robots.txt` + `sitemap.xml` dead-pointer cleanup** (found 2026-08-12 sweep, detail above).
      Remove the `Sitemap: .../docs/sitemap.xml` line from `public/robots.txt` and update the
      test asserting it (`tests/deploy-config.test.mjs:262`) in the same change; strip the 9 dead
      `<loc>` entries from `public/sitemap.xml` (6 `*.md` pages + 3 `llms*.txt` variants — exact
      list above). Do NOT touch the `/blog/...` entries in either file — those still resolve, see
      the orphaned-blog decision item above.

- [ ] **25 `SKILL.md` files still mention "Clerk JWTs"** in their auth boilerplate under
      `public/.well-known/agent-skills/*/SKILL.md` (full list above). Clerk is fully gone —
      find/replace the stale mention. Not the same as, and much bigger than, the 4-file
      Pro-gate SKILL.md item above.

- [ ] **`ARCHITECTURE.md` accuracy pass** — 5 confirmed-stale spots from the 2026-08-12 sweep
      (exact lines/content above): the tech-stack table's `Convex` and `Documentation | Mintlify`
      rows, the `convex/schema.ts` source-files citation, the `convex-deploy.yml` CI-workflow
      table row (that workflow file is already deleted), the `convex/` directory-tree entry, and
      the `docs/generated/stats.json` path comment (real path is `scripts/generated/stats.json`).

- [ ] **Stale comment in `api/http-message-signatures-directory.ts:19,36`** — describes
      `/.well-known/mcp-registry-auth` as still published; that endpoint no longer exists. Just
      fix the wording, no behavior change.

---

## 📌 Housekeeping — also don't forget

- [ ] Commit `7a4308e` (public-product-surface retirement: blog-site/docs/sdk/registry deletion)
      is committed to `main` but **not pushed**. Confirm with operator before pushing.

---

## ⚪ Confirmed pre-existing — reference only, do NOT re-investigate as regressions

Ten test failures, each individually confirmed via `git stash` A/B to predate both the
Convex/SaaS retirement and the public-surface retirement:

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
10. `panel cluster chunk guardrails` — same root cause as the checkout chunk bug above
