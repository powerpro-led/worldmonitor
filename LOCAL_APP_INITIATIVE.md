# Local App Initiative — process log

**Single source of truth** for the multi-part effort to turn `worldmonitor-local`
(the standalone backend) into an app-like, one-command install with a self-service
control panel, plus move production builds to CI.

> This file is the canonical tracker for this initiative. `TASKS.md` keeps its
> numbered-block history; link here from the next `TASKS.md` block rather than
> duplicating. Update the **Status** line and the **Session log** every working
> session.

---

## Status

- **As of:** 2026-09-03 (session 51)
- **Phase:** 1 of 4 in progress — config store landing; Phase 0 (v2.13.0) code done + pushed, **not tagged** (see D12)
- **Branch:** `main == origin/main`, `c379806` = v2.13.0 Model B (incl. the S51 blocker fix), Phase 1 work uncommitted in the working tree
- **No release** until all four phases are complete and coherent — **D12**. The `v2.13.0` tag that was briefly pushed in S51 was deleted; no GitHub release exists.
- **Next action:** finish Phase 1 (installer seeding + doc), then Phase 2.

---

## Goal

Install journey today (from-source-ish, 6 steps, terminal + dotfile):
`install Node → download+extract → get org.env → ./install.sh (1.2 GB npm ci) → open VS Code → worldmonitor-local login (terminal) → hand-edit .env for OpenRouter + restart`

Target journey ("form-fill"):
`curl … | sh   →   double-click launcher   →   paste Supabase URL+key, click Sign in with GitHub   →   done`
(VS Code dashboard extension installed separately, unchanged.)

---

## Scope decisions (locked)

| # | Decision | Rationale | Date |
|---|---|---|---|
| D1 | **VS Code dashboard extension is FROZEN.** Separate downloadable `.vsix`, keeps connecting to `127.0.0.1:46123`. Not in scope. | Already good; the operator's call. | S50 |
| D2 | **One-command install** via `curl -fsSL <release>/install \| sh` (macOS/Linux) + `irm <release>/install.ps1 \| iex` (Windows). | "Like any other app." | S50 |
| D3 | **Bundle Node, but NOT `node_modules`.** Sub-option **B**: the bootstrap fetches the platform Node build from nodejs.org into `~/.worldmonitor/app/runtime/`. | Keeps ONE universal ~15 MB artifact, no per-platform release matrix. Sub-option A (Node in tarball → 4× ~65 MB artifacts) rejected as too heavy. | S50 |
| D4 | **Slim backend-only `package.json`** so `npm ci --omit=dev --ignore-scripts` drops from 736 pkgs / ~1.2 GB / ~5 min to a few hundred MB / ~1 min. | The lever that makes the dep step tolerable without shipping `node_modules`. | S50 |
| D5 | **No native shell.** The "app icon" is a Desktop launcher file (`.command` / `.lnk`) with a custom icon → opens `settings.html`. Native Tauri/Electron/Swift shell + OS-keychain secrets = explicitly deferred. | Cheap, no new toolchain. | S50 |
| D6 | **Config in local SQLite, not `.env`** — but keep `process.env` as the interface. A `config` table in the existing mirror db; a `load-config.mjs` choke-point module loads it into `process.env` via `??=` as the FIRST import of each entrypoint. `.env` stays a valid override. | A literal `getConfig()` rewrite of ~600 `process.env.X` sites in compiled `api/**/*.js` build output is infeasible and would touch the cloud path. Loading, not accessing. | S50 |
| D7 | **`/api/local-config`** — loopback + `x-worldmonitor-local-token` gated, tight key allowlist (Supabase URL/key, Upstash URL + read-only token, OpenRouter key — nothing else), validates each value's shape, GET returns masked `set`/`not set`, NEVER echoes a secret. Always triggers `worldmonitor-local restart` after a write. | Same discipline as session 49's key removal. Restart because several consumers capture `process.env` at module load (see Gotchas). | S50 |
| D8 | **`settings.html` becomes the backend control panel**: Config · Status (credential-free local `/api/health`) · **Sign in with GitHub** (browser OAuth — replaces the `worldmonitor-local login` CLI step) · Restart / View Logs. | Removes the two worst friction points (dotfile editing, terminal login). | S50 |
| D9 | **`org.env` (Model B) is KEPT.** `install.sh --config org.env` pre-seeds the SQLite `config` for zero-touch org rollouts; the UI is for self-service + the per-operator OpenRouter key. | Multi-operator fork — org admin hands out one file; the two coexist. | S50 |
| D10 | **Production build+publish = GitHub Actions**, tag-triggered. Local `build-release-bundle.mjs` stays the dev/test path only; the Actions workflow must not become a blocker for dev. | Operator's throttled local network. Two freebies: sub-option B ⇒ single `ubuntu-latest` job, no matrix; Model B ⇒ no repo secrets, only `GITHUB_TOKEN`. | S50 |
| D11 | **`wmtest` fresh-user testing** via Fast User Switching (`MultipleSessionEnabled` on, account UID 503 — set up S49). | Fast dev/test iteration without polluting the main account. | S50 |
| D12 | **No release (tag or GitHub release) until all four phases are complete and coherent.** v2.13.0's code ships inside that eventual release, not as its own tag. | Operator: "release when full complete, not half." The S51 `v2.13.0` tag was created then deleted. | S51 |
| D13 | **Config store = a SEPARATE `~/.worldmonitor/config.db`**, not a table in `local-cache.db`. Resolves OQ2. | `local-sync.mjs` `fs.renameSync`s a freshly-built `local-cache.db` over the old one every run ([local-sync.mjs:565](vscode-extension/sidecar/local-sync.mjs#L565)) — any table there is destroyed each sync. `config.db` sits with `session.json` / `local-api-token`, which nothing rewrites. | S51 |
| D14 | **`loadConfigIntoEnv()` fills `process.env` for any allow-listed key not already non-empty** (`.env` / real env wins), run as the first statement after the import block — NOT `??=` on a `load-config.mjs` module, and NOT the first *import*. | ESM evaluates all of a file's static imports before its body; `local-api-server.mjs`'s imports (`_domain-config.mjs`, `session-file.mjs`) are env-free at eval, and every config consumer (`api/` handlers, sync workers) is `await import()`ed later — so a body-level call is early enough and clearer than an import side-effect. | S51 |

---

## Codebase review findings (session 50)

**How config reaches the backend today:** `node --env-file-if-exists=~/.worldmonitor/.env` is the only injection point — `scripts/worldmonitor-local.mjs` [:150](scripts/worldmonitor-local.mjs#L150) (plist), [:234](scripts/worldmonitor-local.mjs#L234) (.cmd), [:411](scripts/worldmonitor-local.mjs#L411) (`run`), plus `process.loadEnvFile()` [:297](scripts/worldmonitor-local.mjs#L297) for the CLI itself. API handlers are `await import()`ed per-route ([local-api-server.mjs:896](vscode-extension/sidecar/local-api-server.mjs#L896)) and read `process.env` at call time. The mirror already uses `node:sqlite` `DatabaseSync` ([local-sync.mjs:111](vscode-extension/sidecar/local-sync.mjs#L111)).

**Read sites by category:**

| Consumer | Sites | Action |
|---|---|---|
| `api/**/*.js` compiled bundles (`SUPABASE_URL`, `UPSTASH_*`, `OPENROUTER_API_KEY`, `APP_DOMAIN`) | ~600 lines / ~20 repeated helper snippets across 20+ domain bundles | **Do not touch.** Build output. Populate `process.env` and they work. |
| Sidecar `.mjs` per-request reads — `local-api-server.mjs` lines 843, 1676-77, 1874, 2201, 2278-79, 2469-71, 2520 | ~10 | No change — populated `process.env` covers them |
| **Module-level captures** — `local-sync.mjs` [:122-123](vscode-extension/sidecar/local-sync.mjs#L122), `sync-listener.mjs` [:54-55](vscode-extension/sidecar/sync-listener.mjs#L54), `var SUPABASE_URL = … ?? ""` atop most `api/*.js` | ~6 | OK **iff** `load-config.mjs` runs before these import. Live change needs a restart. |
| Client-side — `supabase-client.ts` `readEnv()`, `buildRuntimeConfigShim()` | 2 | Already choke-pointed (S49); `buildRuntimeConfigShim()` reads `process.env` → covered |
| `worldmonitor-local.mjs` config summary [:302-303](scripts/worldmonitor-local.mjs#L302) | 1 | Add a SQLite read alongside |

**Gotchas to design around:**
- `SIDECAR_ALLOWED_ORIGINS` ([local-api-server.mjs:1157](vscode-extension/sidecar/local-api-server.mjs#L1157)) and the Upstash-origin CSP allowance ([:2469](vscode-extension/sidecar/local-api-server.mjs#L2469)) are computed at module load. Changing the Upstash URL via the UI needs a process restart → `/api/local-config` always calls `restart` (D7).
- Import ordering is the only real constraint: `load-config.mjs` must be the FIRST import of `local-api-server.mjs` and `worldmonitor-local.mjs`. `local-sync.mjs` / `sync-listener.mjs` are `import()`ed after the server's top-of-file, so they see a populated `process.env`.
- ~4 sidecar tests `delete process.env.X` — they'll need to also clear the config table or point `LOCAL_SQLITE_PATH` at a temp db.

---

## Work breakdown

### Phase 0 — Ship v2.13.0 (blocking predecessor, NOT part of this initiative but gates it)
- [x] Fix `src/services/auth-provider.ts:298` — **done S51.** `getSupabaseUrl()` exported from `supabase-client.ts`; new `githubIdentityBridgeIssuer()` in `auth-provider.ts` derives `${getSupabaseUrl()}/functions/v1/github-identity-bridge`, returns null when unset; call site in `completeVsCodeGithubSignIn()` guards on it. Hardcoded `ixuezudybhjptisexgxx` const removed.
- [x] `grep` for other project-specific literals — **done.** Only remaining hits: a prose comment in `supabase-client.ts:6` (stripped from `dist/` at minify) and `status.supabase.com` in `api/infrastructure/v1/[rpc].js` (unrelated status-page URL). No runtime literal.
- [x] Green checks — **done S51.** `tsc --noEmit` ✓ · `typecheck:api` ✓ · `biome` (2 changed files) ✓ · `test:sidecar` 210/210 ✓ · health suites (10 files, run via `tsx --test`) 126/126 ✓ · no test references the issuer.
- [x] `node scripts/build-release-bundle.mjs` — **done S51.** Built `release/worldmonitor-local-2.13.0.tar.gz` (19.7 MB) + `.zip` (20.7 MB). `grep -rl ixuezudybhjptisexgxx …/dist/` → **empty**; no `*.supabase.co` project URL in `dist/`; identity-bridge is the bare `/functions/v1/github-identity-bridge` path.
- [x] Live check — **done S51 (Tier A, sandbox on :46202).** `npm ci --omit=dev --ignore-scripts` exit 0. `/dashboard.html` 200 and carries `<script>window.__WM_RUNTIME_CONFIG={supabaseUrl,supabaseKey}</script>` from `.env`. `/api/health` **200 with ZERO Upstash creds** (real verdict from the SQLite mirror; no shared-Redis read/write). `/api/sidecar-health` 200. No `ERR_MODULE_NOT_FOUND`. (Note: `/api/health` needs a *populated* mirror — `readMirrorValues()` opens read-only and fails closed on a missing db; a real install's `local-sync` writes it first.)
- [x] CHANGELOG — **done S51.** Orphan `[2.12.1]` folded into `[2.13.0]` as a `### Security` subsection; added a bullet for the identity-bridge issuer derivation.
- [x] Commit → push — **done S51.** `c379806` on `origin/main`.
- [ ] ~~`git tag -a v2.13.0` → `gh release create`~~ — **cancelled per D12.** Ships inside the eventual full-initiative release.
- [ ] (Parallel, independent) Tier B fresh-user test — see `TASKS.md` FORTY-NINTH block

### Phase 1 — Config store (`.env` → SQLite, `process.env` interface kept)
- [x] **`vscode-extension/sidecar/config-store.mjs`** (new) — separate `~/.worldmonitor/config.db` (D13), `config(key,value,updated_at)` table. Exports `CONFIG_KEYS` (5-key allow-list, no write creds) · `SECRET_CONFIG_KEYS` · `getConfigDbPath()` (honours `$LOCAL_CONFIG_DB_PATH`) · `readAllConfig()` (`{}` when absent) · `loadConfigIntoEnv(env=process.env)` (fills gaps, mirrors `VITE_SUPABASE_URL`→`SUPABASE_URL`, never throws) · `setConfig` / `deleteConfig` · `importFromEnvText`.
- [x] Wired into **`local-api-server.mjs`** — `loadConfigIntoEnv()` as the first body statement after the import block (D14), logs `[local-api] config.db filled: …`.
- [x] Wired into **`worldmonitor-local.mjs`** — `loadConfigIntoEnv()` inside `loadDotenv()` (covers the `login` path); new **`config`** subcommand (`list` / `set` / `unset` / `import`) + `usage()` entry; `readFileSync`/`existsSync` already imported.
- [x] **`build-release-bundle.mjs`** stages `config-store.mjs` in `SIDECAR_FILES`.
- [x] Tests — **`config-store.test.mjs`** (new, 9 tests) added to `test:sidecar`; the script now also sets `LOCAL_CONFIG_DB_PATH=./.test-no-config.db` so the whole suite is hermetic regardless of a real `~/.worldmonitor/config.db` (`.gitignore`d). No `delete process.env.X` test needed changes — `loadConfigIntoEnv` respects already-set values and the suite's db path is a non-file. `test:sidecar` 219/219.
- [ ] `install.sh` / `install.ps1`: after writing `.env`, `node scripts/worldmonitor-local.mjs config import <org.env-or-.env>` (keep `.env` too during transition — OQ1).
- [ ] Green checks + a fresh `wmtest` install verifying config comes from SQLite with no `.env`
- **Green so far (S51):** `tsc` · `typecheck:api` · `biome` (changed files, exit 0) · `test:sidecar` 219/219 · `config-store.test.mjs` 9/9 · CLI `config` smoke (set/list/unset/import, write-cred rejected, secrets masked, `SUPABASE_URL` mirrored).

### Phase 2 — `/api/local-config` + settings.html control panel
- [ ] `/api/local-config` route in `local-api-server.mjs` dispatch — loopback + local-token gated
  - [ ] GET → `{ key: 'set' | 'not set' }` for the allowlist; never the value
  - [ ] POST → validate shape per key, write SQLite row, `process.env[key] = value`, then trigger `worldmonitor-local restart`
  - [ ] Key allowlist: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_READONLY_TOKEN`, `OPENROUTER_API_KEY`
- [ ] `settings.html` + `src/settings-main.ts` — Config section (masked fields), Status section (`/api/health` + last sync + mirror key count), Service section (Restart / View Logs)
- [ ] Browser "Sign in with GitHub" in settings.html — reuse `auth-provider.ts` identity-bridge flow; writes `~/.worldmonitor/session.json`; retire the `worldmonitor-local login` CLI step for end users
- [ ] First-run: empty config → dashboard detects "not configured" → routes to `settings.html`. Requires `load-config`/reads to be lazy enough that no restart is needed after the first save of the Supabase pair (verify).

### Phase 3 — One-command install + bundled Node + slim deps
- [ ] Backend-only `package.json` — prune to what `local-api-server.mjs` + `local-sync.mjs` + `sync-listener.mjs` + `api/**` + `server/_shared/*` + `scripts/shared/sync-domains.mjs` actually import. Test a clean `npm ci --omit=dev --ignore-scripts` + full boot.
- [ ] `build-release-bundle.mjs` — emit ONE universal tarball (no per-platform), stage the slim `package.json`
- [ ] `scripts/release/install` (the `curl | sh` bootstrap): detect OS/arch → download platform Node from nodejs.org → `~/.worldmonitor/app/runtime/` → download+extract the app tarball → `npm ci` with the bundled Node → register service (existing `worldmonitor-local install` logic) → drop Desktop launcher + icon → print the settings URL
- [ ] `scripts/release/install.ps1` — the PowerShell mirror (`irm | iex` entry)
- [ ] Point `worldmonitor-local.mjs` (plist / .cmd / run) at `~/.worldmonitor/app/runtime/bin/node` instead of system node
- [ ] Desktop launcher assets — `.command` (mac) + `.lnk`→`.bat` (win) + an `.icns` / `.ico`
- [ ] `INSTALL.md` — replace the manual steps with the one-liner

### Phase 4 — CI (GitHub Actions, production release)
- [ ] `.github/workflows/release.yml` — trigger on `v*` tag push
  - [ ] `ubuntu-latest`, single job (no matrix — sub-option B)
  - [ ] `npm ci` → `npm run build` (with `VITE_SUPABASE_URL='' VITE_SUPABASE_PUBLISHABLE_KEY=''`) → `build:sidecar-sebuf` → `build:sidecar-handlers` → `node scripts/build-release-bundle.mjs`
  - [ ] Build the `.vsix` (same workflow or a sibling job)
  - [ ] `gh release create $TAG` with tar.gz + zip + both .sha256 + .vsix + the `install` / `install.ps1` bootstrap scripts as release assets
  - [ ] Only `GITHUB_TOKEN` — no repo secrets (Model B builds `dist/` blank)
- [ ] Document: local `build-release-bundle.mjs` = dev/test only; tag push = production

---

## Open questions

- **OQ1** — Phase 1: during transition, does `install.sh` write BOTH `.env` and the SQLite `config`, or switch fully to SQLite? (Leaning: write both until Phase 2 ships, then SQLite-only + `.env` as override.)
- **OQ2** — Phase 2: separate `config.db` vs a `config` table inside `local-cache.db`? (`local-cache.db` is rebuilt atomically by `local-sync.mjs` via a tmp-file swap — a `config` table there would be clobbered. Leaning: **separate `~/.worldmonitor/config.db`**.)
- **OQ3** — Phase 3: nodejs.org download — pin to a specific Node version, or track "latest 22.x"? Checksum verification against the official SHASUMS?
- **OQ4** — Phase 2: does browser GitHub sign-in fully replace `worldmonitor-local login`, or stay side-by-side (CLI kept for headless/server installs)?
- **OQ5** — APP_DOMAIN (session 49 Phase 2 deferral) — fold into this initiative's config store, or keep baked? Cosmetic for a loopback dashboard.

---

## Session log

### Session 51 — 2026-09-03
- **Phase 0 blocker fixed** (`getSupabaseUrl()` + `githubIdentityBridgeIssuer()` derivation) + Tier A bundle verified. Committed as `c379806 release(v2.13.0)`, pushed. `6e38d82` = this file.
- **Tagging reversed.** Briefly pushed `v2.13.0`, operator said release only when the whole initiative is complete → **D12**. Tag deleted local + origin; no GitHub release was created (the `gh release create` was permission-blocked anyway).
- **OQ2 resolved → D13** (separate `~/.worldmonitor/config.db`). Design nuance → **D14** (body-level `loadConfigIntoEnv()`, not an import side-effect).
- **Phase 1 core landed** (uncommitted): `config-store.mjs` + wiring in `local-api-server.mjs` + `worldmonitor-local.mjs` (new `config` subcommand) + `build-release-bundle.mjs` staging + `config-store.test.mjs` (9 tests) + hermetic `test:sidecar`. All green (219/219 sidecar, CLI smoke). See Phase 1 checklist.
- **Next:** commit Phase 1 core → installer seeding (`config import`) → then Phase 2.

### Session 50 — 2026-09-03
- Design discussion: full install-UX overhaul explored and scoped. Decisions D1–D11 locked above.
- Codebase review of the `.env` → SQLite surface — findings + gotchas recorded above. Conclusion: contained if `process.env` stays the interface (load, don't rewrite accessors).
- Created this file as the single source of truth.
- Memory: `session50_local_launcher_app_direction.md` + MEMORY.md pointer.
- **Nothing implemented.** Next: operator go-ahead on the Phase 0 v2.13.0 blocker.
