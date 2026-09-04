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

- **As of:** 2026-09-04 (session 54) — Phase 2 committed; **Phase 3 code-complete + verified** (2 commits, not pushed)
- **Phase:** 0 done · 1 done · 2 done + committed · **3 done — slim deps + `curl\|sh`/`irm` bootstrap + bundled Node + Desktop launcher + INSTALL.md, all verified except Windows-on-hardware** · **4 (CI) is the only phase left**
- **Branch:** `main` — Phase 2 = `f1a90be`..`ad77eb8`; Phase 3 = `1ff78f2` (slim deps) + the S54 bootstrap commit. **Ahead of `origin/main`, not pushed** (D12).
- **No release** — tag or GitHub release — until all four phases are complete and coherent (**D12**). v2.13.0's code ships inside that eventual release.
- **START HERE next session:** **Phase 4 only** — `.github/workflows/release.yml` (tag-triggered, single `ubuntu-latest`, no matrix, only `GITHUB_TOKEN`): `npm ci` → blank-env `npm run build` → `build:sidecar-sebuf` → `build:sidecar-handlers` → `build:backend-lockfile:check` → `build-release-bundle.mjs` → `.vsix` → `gh release create` with tar.gz + zip + both `.sha256` + `.vsix` + `install` + `install.ps1`. Then D12 lifts.
- **Open before release:** run the fresh-user `wmtest` install (the real `curl\|sh` once a v2.13.0 release exists, or via `WM_APP_TARBALL`); run `install.ps1` on real Windows.
- **Build artifacts:** `release/worldmonitor-local-2.13.0.{tar.gz,zip}` (+ `.sha256`, + `install`/`install.ps1`) rebuilt S54 — gitignored, safe to delete/rebuild.
- **Green (S54):** `tsc` 0 · `typecheck:api` 0 · `biome` changed-files exit 0 (2 pre-existing non-error findings in `local-api-server.mjs`, unrelated) · `test:sidecar` **226/226** · `build:backend-lockfile --check` clean · markdownlint clean · **bootstrap end-to-end**: real Node `v22.23.2` fetch+SHA256+extract → `setup.sh` on bundled Node → `npm ci` 39 pkgs → `.env`/`config.db` seeded → launcher built → backend boots on the bundled runtime (`status` shows `runtime bundled node v22.23.2`); 2nd run skips the Node download; `server/_shared/redis.js` ships + resolves.

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
| D15 | **Bundled Node = pinned to one EXACT version, SHA-256-verified against nodejs.org's `SHASUMS256.txt` before extraction.** No "latest 22.x" float. Currently **`v22.23.2`** (latest 22.x LTS as of S54; ≥ 22.18 so runtime `.ts` type-stripping is on by default). Bumping the pin = a one-line constant edit in `scripts/release/install` + `install.ps1` per release. Resolves OQ3. | A `curl \| sh` that fetches and runs a binary must be reproducible and integrity-checked; a bad upstream patch release shouldn't silently change every install. GPG-signature verification of SHASUMS is deferred (no gpg dependency in the bootstrap) — SHA-256 match over HTTPS is the bar. | S54 |
| D16 | **Fixed install layout: `~/.worldmonitor/runtime/` (bundled Node) + `~/.worldmonitor/app/` (extracted bundle), siblings.** `runtime/` is a sibling of `app/` — NOT `app/runtime/` as D3 loosely said — so an upgrade replaces `app/` wholesale without re-downloading Node on the operator's throttled link (the bootstrap re-fetches Node only when `runtime/bin/node -v` ≠ the pin). `.env` lives in `app/.env` and is carried across upgrades. | Upgrade behaviour on a bandwidth-constrained connection. | S54 |

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
- [x] **`install.sh` / `install.ps1`** — after writing `.env`, a `# 2b` step runs `node scripts/worldmonitor-local.mjs config import .env` (non-fatal on failure; `.env` stays authoritative — OQ1 = dual-write during transition). `bash -n` clean; seed step simulated (4 allow-listed keys imported from a sample `.env`, `LOCAL_API_MODE`/`SUPABASE_URL` skipped).
- [x] **`INSTALL.md`** — `config list` in the manage-backend block + a short paragraph on `.env` vs `config.db`.
- [ ] Fresh `wmtest` install verifying config comes from SQLite with no `.env` — deferred to the Phase 1/3 combined `wmtest` pass (needs the one-command installer too).
- **Green (S51):** `tsc` · `typecheck:api` · `biome` (changed files, exit 0) · `test:sidecar` 219/219 · `config-store.test.mjs` 9/9 · CLI `config` smoke (set/list/unset/import, write-cred rejected, secrets masked, `SUPABASE_URL` mirrored) · installer seed-step simulated.

**Phase 1 status: code complete.** Remaining item is a `wmtest` end-to-end check, folded into the Phase 3 installer test.

### Phase 2 — `/api/local-config` + settings.html control panel

**Entry points found in S51 (start here):**

- Route registration: `dispatch()` in `local-api-server.mjs` [:1760](vscode-extension/sidecar/local-api-server.mjs#L1760) special-cases pathnames before the generic route table — `/api/sidecar-health` [:1770](vscode-extension/sidecar/local-api-server.mjs#L1770), `/api/operator-session` [:1853](vscode-extension/sidecar/local-api-server.mjs#L1853). Add `/api/local-config` the same way (an `if (requestUrl.pathname === '/api/local-config')` block). The `x-worldmonitor-local-token` gate already runs in `dispatch()` for `/api/*` — confirm it covers this path.
- Store API is done: `import { CONFIG_KEYS, SECRET_CONFIG_KEYS, readAllConfig, setConfig, deleteConfig } from './config-store.mjs'` — the handler is mostly glue. `setConfig` already validates the allow-list + non-empty; add per-key shape checks (URL looks like a URL, etc.).
- After a successful POST: `process.env[key] = value` for the live process, THEN spawn `worldmonitor-local restart` (D7 — `SIDECAR_ALLOWED_ORIGINS` [:1157](vscode-extension/sidecar/local-api-server.mjs#L1157) and the Upstash-origin CSP allowance [:2469](vscode-extension/sidecar/local-api-server.mjs#L2469) are captured at module load and only a restart re-reads them).
- **`src/settings-main.ts` ALREADY EXISTS** (~40 KB) — a full settings UI with `SETTINGS_CATEGORIES`, `runtime-config.ts` (`getSecretState` / `setSecretValue` / `validateSecret` / `MASKED_SENTINEL`), `PLAINTEXT_KEYS`, desktop-secret loading. **Study `src/services/runtime-config.ts` + `src/services/settings-constants.ts` before adding a Config section** — likely extend the existing secret/masking machinery, not build new.

- [x] `/api/local-config` route — loopback + local-token gated. **Done S52.** `handleLocalControlPlane()` in `local-api-server.mjs`, special-cased in `dispatch()` right after `/api/operator-session` (past the global token gate).
  - [x] GET → `{ [key]: { stored, effective, value? } }` for `CONFIG_KEYS`; non-secret keys (`VITE_SUPABASE_URL`, publishable key) return `value`, `SECRET_CONFIG_KEYS` never do.
  - [x] POST → per-key shape check (`validateConfigValue`) → `setConfig` → `process.env[key] = value` (+ `SUPABASE_URL` mirror) → `spawnBackendRestart()` (detached `worldmonitor-local restart`, skipped under `WM_LOCAL_SKIP_RESTART=1` for tests).
  - [x] DELETE `?key=…` (query param, not a body — `fetch` DELETE+body is unreliable) → `deleteConfig` + `delete process.env[key]` + restart.
- [x] `settings.html` + `src/settings-main.ts` — **Done S52.** New **Backend** sidebar section + `renderBackend()`, shown only when `window.__WM_LOCAL_CONTROL_PANEL` (set by `buildLocalControlPanelShim`, injected into `settings.html` over loopback). Config rows reuse the `.settings-secret-row` + `MASKED_SENTINEL` idiom; "from .env" hint when `effective==='set' && stored==='unset'`. Save posts changed rows, then polls `/api/sidecar-health` through the restart. Status block from `/api/local-status`. Service = Restart button (`/api/local-restart`). NOT reusing the Tauri `runtime-config.ts` secret machinery (it routes through `invokeTauri`, no-ops off-desktop) — the section is self-contained around plain `fetch`.
- [x] Browser "Sign in with GitHub" — **Done S52.** `POST /api/local-login` → shared `beginGithubLogin()` in new `vscode-extension/sidecar/local-login.mjs` (factored out of the CLI `cmdLogin`, imported by both). Sidecar owns the PKCE flow + the `127.0.0.1:46124/callback` server; returns `202 { authUrl }`, the browser opens it (the service may have no GUI session), `writeOperatorSession` on the redirect. Panel polls `/api/operator-session`. `POST /api/local-logout` `rmSync`s session.json. **CLI `login` kept** for headless (resolves OQ4).
- [x] First-run: empty Supabase config → `buildFirstRunRedirectShim` injected into `dashboard.html`/`index.html` (server-side, no bundle rebuild) → `location.replace('/settings.html?firstrun=1#backend')`. `settings.html` never redirects itself. `initSettingsWindow` opens the Backend section on `firstrun=1` / `#backend`. The Save flow expects the restart (progress + `/api/sidecar-health` poll), not hot reload.

### Phase 3 — One-command install + bundled Node + slim deps

- [x] **Backend-only `package.json` — DONE + verified S54.** `scripts/release/backend-package.json` (5 deps: `@supabase/supabase-js`, `@upstash/ratelimit`, `@upstash/redis`, `@vercel/functions`, `aws4fetch`) + generated `scripts/release/backend-package-lock.json` (`scripts/build-backend-lockfile.mjs` regenerates it; `--check` mode for CI; asserts version == root). `build-release-bundle.mjs` now stages this pair AS `package.json`/`package-lock.json` and no longer stages `patches/` (slim manifest has no `postinstall`). **Verified against the real shipped tarball:** `npm ci --omit=dev --ignore-scripts` = exit 0, **39 pkgs / 19 MB / ~1 s** (was 736 / ~1.2 GB / ~5 min); backend boots, 70 routes, `/api/sidecar-health` 200, `/api/health` + `/api/bootstrap` run their full handlers (incl. `@vercel/functions` `waitUntil`), `worldmonitor-local status` works. **Why the prune is safe:** the Node process only ever loads hand-maintained `api/**/*.js` (bare imports = those 5) + self-contained esbuild bundles; every other root dep is frontend-only (Vite → `dist/`) or dev-only. `react-native`/`expo-secure-store` etc. that appear inside bundled `@supabase/supabase-js` are dead RN-detection branches, not installed today either.
- [x] `build-release-bundle.mjs` — stages the slim `package.json`/lock (S54). Still emits BOTH `.tar.gz` + `.zip` of one tree — the "ONE universal tarball, no per-platform" goal is already met (Node is fetched by the bootstrap, not bundled — D3 sub-option B); nothing further needed here for Phase 3.
- [x] **`scripts/release/install` (`curl | sh` bootstrap) — DONE + verified S54.** Detect OS/arch → fetch Node from nodejs.org into `~/.worldmonitor/runtime/` (SHA-256-verified against `SHASUMS256.txt`; skipped if the pin is already there) → download + `.sha256`-verify the app tarball into `~/.worldmonitor/app/` (keeps an existing `.env`) → hand off to `setup.sh` with the bundled Node on PATH → print the control-panel URL. Offline hooks: `WM_NODE_TARBALL` / `WM_APP_TARBALL`. `--config <org.env>` and `--app-version` pass through. **Verified end-to-end**: real Node `v22.23.2` download + checksum + extract, local app tarball, `setup.sh` ran on the bundled Node, `npm ci` 39 pkgs, `.env` + `config.db` seeded, `.vsix` installed, launcher created, backend boots on the bundled runtime; a 2nd run correctly skipped the Node download.
- [x] **`scripts/release/install.ps1` — DONE S54** (PowerShell mirror, `irm | iex`). `.zip`-based; same flow + offline hooks (`WM_NODE_TARBALL` / `WM_APP_ZIP`). **Not run on real Windows** (consistent with the standing Windows-hardware caveat).
- [x] **`worldmonitor-local.mjs` points the service at the bundled Node — DONE + verified S54.** New `nodeBin()` → `~/.worldmonitor/runtime/bin/node` (`\node.exe` on Windows) when present, else `process.execPath`. Wired into `writePlist`, `writeWinTaskFiles`, `cmdRun`, install/status echoes. New `status` line: `runtime  bundled|system node <ver>  <path>`.
- [x] **Desktop launcher — DONE S54.** `setup.sh` builds a minimal `WorldMonitor.app` (Info.plist + `open <panel URL>` exec + `icon.icns`, `LSUIElement` so no Dock bounce); `setup.ps1` writes `WorldMonitor.url` with `IconFile=icon.ico`. Placeholder icons (flat blue rounded square + "W") generated by `scripts/release/assets/make-placeholder-icons.mjs` (hand-rolled PNG encoder + PNG-in-ICO + `iconutil` for `.icns`) — committed as `scripts/release/assets/icon.{png,icns,ico}`, **replace `icon.png` with real artwork and re-run**.
- [x] **`INSTALL.md` — DONE S54.** Rewritten around the one-liner; the manual extract path is now `./setup.sh` / `.\setup.ps1` under a "Manual / offline install" heading.

**Renames (S54):** the in-bundle installers `install.sh` / `install.ps1` → **`setup.sh` / `setup.ps1`** (freed the `install` / `install.ps1` names for the D2 bootstrap asset). `setup.*` prefer `~/.worldmonitor/runtime/` Node on PATH; both honour `WM_SKIP_SERVICE=1` (deps + `.env` only, dry-run the service — for CI / containers / bring-your-own-supervisor). `build-release-bundle.mjs` stages `setup.*` + `assets/icon.{icns,ico}`, copies `install` / `install.ps1` to `release/` for Phase 4's `gh release create`.

**`server/_shared/redis` gap — FIXED S54.** `build-release-bundle.mjs` now esbuilds `server/_shared/redis.ts` → a self-contained `server/_shared/redis.js` (~42 KB, `sidecar-cache` + `node:sqlite` inlined) into the stage, and `local-api-server.mjs:989` imports it with an explicit `.js` (it's copied verbatim, not esbuild-bundled, so Node's ESM loader needs the literal path). Verified: `import('../../server/_shared/redis.js')` from the staged sidecar dir resolves and exports `runRedisPipeline`. (The path is still only reachable from the local-MCP Pro-quota branch, which `env_key` auth never enters — but it's now correct if it ever is.)

### Phase 4 — CI (GitHub Actions, production release)

- [ ] `.github/workflows/release.yml` — trigger on `v*` tag push
  - [ ] `ubuntu-latest`, single job (no matrix — sub-option B)
  - [ ] `npm run build:backend-lockfile:check` (fail the build on a stale `backend-package-lock.json`)
  - [ ] `npm ci` → `npm run build` (with `VITE_SUPABASE_URL='' VITE_SUPABASE_PUBLISHABLE_KEY=''`) → `build:sidecar-sebuf` → `build:sidecar-handlers` → `node scripts/build-release-bundle.mjs`
  - [ ] Build the `.vsix` (same workflow or a sibling job)
  - [ ] `gh release create $TAG` with tar.gz + zip + both .sha256 + .vsix + the `install` / `install.ps1` bootstrap scripts as release assets
  - [ ] Only `GITHUB_TOKEN` — no repo secrets (Model B builds `dist/` blank)
- [ ] Document: local `build-release-bundle.mjs` = dev/test only; tag push = production

---

## Open questions

- **OQ1** — Phase 1: during transition, does `install.sh` write BOTH `.env` and the SQLite `config`, or switch fully to SQLite? (Leaning: write both until Phase 2 ships, then SQLite-only + `.env` as override.)
- **OQ2** — Phase 2: separate `config.db` vs a `config` table inside `local-cache.db`? (`local-cache.db` is rebuilt atomically by `local-sync.mjs` via a tmp-file swap — a `config` table there would be clobbered. Leaning: **separate `~/.worldmonitor/config.db`**.)
- **OQ3** — RESOLVED S54 → **D15**: exact-version pin (`x.y.z`, ≥ 22.18) + SHA-256 verification against nodejs.org `SHASUMS256.txt`. GPG-signature check deferred.
- **OQ4** — RESOLVED S52: browser sign-in is the documented path for end users; `worldmonitor-local login` is kept for headless/server installs. Both call the same `beginGithubLogin()`.
- **OQ5** — APP_DOMAIN (session 49 Phase 2 deferral) — fold into this initiative's config store, or keep baked? Cosmetic for a loopback dashboard.

---

## Session log

### Session 54 — 2026-09-04

**Part 2 — rest of Phase 3 (bootstrap + bundled Node + launcher):**

- `nodeBin()` in `worldmonitor-local.mjs` → bundled `~/.worldmonitor/runtime/` Node when present; wired into plist/task/run + a new `status` `runtime` line.
- `server/_shared/redis.ts` → esbuilt into the stage as `redis.js` by `build-release-bundle.mjs`; `local-api-server.mjs:989` now imports it with explicit `.js`. Gap closed.
- Renamed in-bundle `install.{sh,ps1}` → `setup.{sh,ps1}` (prefer bundled-runtime Node on PATH; `WM_SKIP_SERVICE=1` support). New bootstrap `scripts/release/install` (bash) + `install.ps1` (pwsh) — fetch+verify Node → fetch+verify bundle → `setup.*` → launcher. `build-release-bundle.mjs` stages `setup.*` + `assets/icon.{icns,ico}`, drops `install*` into `release/`.
- Placeholder launcher icons via `scripts/release/assets/make-placeholder-icons.mjs` (no image libs). Desktop launcher: `WorldMonitor.app` (mac) / `WorldMonitor.url` (win).
- `INSTALL.md` rewritten around the one-liner.
- Verified end-to-end on macOS (real nodejs.org download + checksum, `WM_APP_TARBALL` for the bundle, `WM_SKIP_SERVICE=1`): boots on the bundled runtime, redis.js resolves, 2nd run skips the Node re-download. `install.ps1` unrun on real Windows.
- **D15 concrete pin: `v22.23.2`.** New **D16** (install layout: `runtime/` sibling of `app/`, not nested).
- **Phase 3 is code-complete.** Only Phase 4 (CI) remains before D12 lifts.

**Part 1 — slim backend `package.json` (committed as `1ff78f2`):**

- **OQ3 resolved → D15**: bundled Node = exact-version pin + SHA-256 verify against nodejs.org `SHASUMS256.txt`; pin ≥ 22.18 (default `.ts` type-stripping). GPG check deferred.
- **Phase 3 slim-deps slice — done + verified:**
  - New `scripts/release/backend-package.json` — 5 runtime deps only (`@supabase/supabase-js`, `@upstash/ratelimit`, `@upstash/redis`, `@vercel/functions`, `aws4fetch`). Derived by scanning every `.js/.mjs/.cjs` the backend actually loads for bare specifiers; the only survivors outside esbuild bundles are those 5.
  - New `scripts/build-backend-lockfile.mjs` — regenerates `scripts/release/backend-package-lock.json` (temp-dir `npm install --package-lock-only`); `--check` for CI; asserts manifest version == root `package.json` version. Added `build:backend-lockfile[:check]` npm scripts.
  - `scripts/build-release-bundle.mjs` — stages the slim pair AS `package.json`/`package-lock.json` (was: copy root pair); dropped `copyDir('patches')` (no `postinstall` in the slim manifest, `@nitric/sdk` isn't a backend dep); `BUNDLE_MANIFEST.txt` line added.
  - Verified end-to-end against the actual rebuilt tarball — see Status "Green (S54)".
- **Found (pre-existing, logged under Phase 3):** `server/_shared/redis.js` is never built/shipped but `local-api-server.mjs` dynamically imports it (`runRedisPipeline`) → `ERR_MODULE_NOT_FOUND`, masked by the SQLite-mirror-first path. Fix during the installer slice (prefer an esbuild pass for that one file).
- **Next:** the `curl | sh` / `.ps1` bootstrap (fetch + verify D15 Node → `~/.worldmonitor/app/runtime/`, repoint plist/.cmd/run), Desktop launcher assets, `INSTALL.md` one-liner.

### Session 52 — 2026-09-03

- **Phase 2 built** (all four parts, per operator direction: extend `settings-main.ts`, do it all, sign-in replaces CLI for end users).
  - New `vscode-extension/sidecar/local-login.mjs` — `beginGithubLogin()` factored out of CLI `cmdLogin`; CLI now a thin wrapper. Added to `SIDECAR_FILES`.
  - `local-api-server.mjs` — `handleLocalControlPlane()` (`/api/local-config` GET/POST/DELETE, `/api/local-login`, `/api/local-logout`, `/api/local-restart`), `buildLocalControlPanelShim()` + `buildFirstRunRedirectShim()` wired into `tryServeStaticAsset()`.
  - `settings-main.ts` — Backend section (`renderBackend`), gated on `window.__WM_LOCAL_CONTROL_PANEL`; self-contained around `fetch` (not the Tauri `runtime-config.ts` path).
  - 7 new `local-api-server.test.mjs` tests → `test:sidecar` 226/226.
  - `INSTALL.md` + `CHANGELOG.md` updated.
- **DELETE takes `?key=` in the query string, not a JSON body** — `fetch(url,{method:'DELETE',body})` produced a bare 400 from Node's HTTP parser through undici; raw `http.request` was fine. Query param sidesteps it and the UI is set-only this pass anyway.
- OQ4 resolved (see above). OQ5 (APP_DOMAIN) still deferred — cosmetic for a loopback dashboard.
- **Not committed at end of S52.** Committed in S53 as the 5 slices below (green re-verified first: `tsc` 0 · `typecheck:api` 0 · `biome` changed files 0 · `test:sidecar` 226/226).

### Session 53 — 2026-09-03

- **Phase 2 committed** to `main`, 5 slices (per the S52 plan), **not pushed** (D12):
  1. `f1a90be feat(local): shared beginGithubLogin() module`
  2. `ed3c281 feat(local): /api/local-config + control-plane routes`
  3. `e30f1cd feat(local): settings.html Backend control panel`
  4. `6ba93d2 test(local): control-plane route + shim tests`
  5. `docs(initiative): Phase 2 done` (this commit)
- **Next: Phase 3** — backend-only `package.json` prune · `curl | sh` bootstrap · fetched Node into `~/.worldmonitor/app/runtime/` · point plist/.cmd at the bundled node · Desktop launcher assets · `INSTALL.md` one-liner. Checklist in the Phase 3 section. OQ3 (Node version pin + SHASUMS) needs an answer first.

### Session 51 — 2026-09-03

- **Phase 0 blocker fixed** (`getSupabaseUrl()` + `githubIdentityBridgeIssuer()` derivation) + Tier A bundle verified. Committed as `c379806 release(v2.13.0)`, pushed. `6e38d82` = this file.
- **Tagging reversed.** Briefly pushed `v2.13.0`, operator said release only when the whole initiative is complete → **D12**. Tag deleted local + origin; no GitHub release was created (the `gh release create` was permission-blocked anyway).
- **OQ2 resolved → D13** (separate `~/.worldmonitor/config.db`). Design nuance → **D14** (body-level `loadConfigIntoEnv()`, not an import side-effect).
- **Phase 1 landed + pushed.** `4f7d4f3` config store core · `6d29490` installer seeding + INSTALL.md · `c2425dd` markdownlint fix. `main == origin/main @ c2425dd`, tree clean.
- **Handed off to the next session.** Phase 2 entry points captured in the Phase 2 section above (route dispatch pattern, existing `settings-main.ts` infra, restart-after-write). No open blockers.
- Note: `npm run lint:md` shows ~81 pre-existing errors repo-wide in OTHER `.md` files (predates this initiative; `lint.yml` only runs on PRs touching `.md`, and this repo commits straight to `main`). Our files are clean.

### Session 50 — 2026-09-03

- Design discussion: full install-UX overhaul explored and scoped. Decisions D1–D11 locked above.
- Codebase review of the `.env` → SQLite surface — findings + gotchas recorded above. Conclusion: contained if `process.env` stays the interface (load, don't rewrite accessors).
- Created this file as the single source of truth.
- Memory: `session50_local_launcher_app_direction.md` + MEMORY.md pointer.
- **Nothing implemented.** Next: operator go-ahead on the Phase 0 v2.13.0 blocker.
