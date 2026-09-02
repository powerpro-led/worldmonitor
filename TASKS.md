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

## 🔀 HANDOFF (2026-09-02, FORTY-FOURTH session) — NEXT TASKS: session.json auto-refresh, review #4, review #3

`main == origin/main` @ `cca85e2`. Everything from the FORTY-THIRD block below is done and pushed
(local-backend split, `worldmonitor-local` CLI, login↔iframe unification, `npm run build` fix,
data-pipeline review leads #1/#2/#5/#6). Four items remain, in priority order:

### 1. Backend must auto-refresh `~/.worldmonitor/session.json` (the "we sign in all the time" bug)

**Symptom the operator hit:** premium-gated panels (AI Market Impact / `list-market-implications`, and
any other panel behind `hasPremiumAccess()` in `src/services/panel-gating.ts`) showed "unavailable"
while non-premium panels (news) worked. Root cause: `session.json`'s access token has a ~1h TTL and
**nothing refreshes the file**. The dashboard iframe's supabase-js auto-refreshes its *own in-memory*
copy while open, but once the webview is closed >1h the file is stale; on reopen
`reconcileWithOperatorSession()` (`src/services/auth-provider.ts`) calls
`supabase.auth.setSession({access_token, refresh_token})` which only recovers if the **refresh token**
is still alive — and a ~24h-untouched session had aged past Supabase's inactivity timeout, so adoption
failed → iframe had no session → `hasPremiumAccess()` false → premium panels dead. A fresh
`worldmonitor-local login` fixes it until the next expiry — not a real fix.

**The fix:** `local-api-server.mjs` refreshes `session.json` on a timer. Pattern to mirror: the news
digest warm-ping added in `0f493b5` (fire-and-forget block in the server's `start()`, right after the
LLM-health warm). Roughly:
  - every ~45 min (before the 1h access-token expiry), if `readOperatorSession()` returns a session,
    `POST ${VITE_SUPABASE_URL||SUPABASE_URL}/auth/v1/token?grant_type=refresh_token` with
    `{ refresh_token }` in the body, headers `{ apikey: VITE_SUPABASE_PUBLISHABLE_KEY, Authorization:
    'Bearer ' + VITE_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' }`.
  - on 200, rewrite `session.json` (0600) with the new `access_token`/`refresh_token`/`expires_at`/
    `user` — reuse the CLI's `writeSession()` shape in `scripts/worldmonitor-local.mjs` (don't import
    it; the server file is plain `.mjs` bundled standalone — inline a small writer or factor a shared
    helper into a new `vscode-extension/sidecar/*.mjs` both can import).
  - `tauri-sidecar` mode only; wrap in try/catch; never block or fail startup. Log one line on
    success/failure like the warm-ping does.
  - Also run it once immediately on startup (a backend that booted after >1h down needs it now, not in
    45 min) — but AFTER the server is listening so it doesn't delay `start()`.
  - `close()` must clear the interval (see how `stopReconciliationLoop`/`stopSyncListener` are torn
    down — same pattern; session-39 review deferred-finding-#4 discipline).
  - Update the `worldmonitor-local login` output line in `scripts/worldmonitor-local.mjs` — it was
    softened to "The dashboard adopts this on load and refreshes it itself" in `4980671`; once the
    backend genuinely refreshes the file, it can say so accurately again.
  - Test: `vscode-extension/sidecar/local-api-server.test.mjs` — a case that sets
    `WM_LOCAL_SESSION_FILE` to a fixture with a near-expiry `expires_at`, stubs the Supabase token
    endpoint (the suite already stands up local HTTP servers — see `setupRemoteServer`/`restoreHttps`
    helpers), and asserts the file gets rewritten. Guard the real timer behind the same
    `context.mode === 'tauri-sidecar'` check so it never fires in other tests.

**Verify after:** `worldmonitor-local status` should keep showing a non-EXPIRED identity across >1h;
premium panels stay populated after a long webview close + reopen with no manual `login`.

### 2. Data-pipeline review lead #4 — systemic `notifyChange()` gap (the biggest review item)

~11 seeders write **mirrored** data keys via a raw `redisCommand(['SET', …])` / private per-file
`redisPipeline()` and never call `_seed-utils.mjs`'s `notifyChange()`, so `sync-listener.mjs`'s
real-time push never fires for those domains — freshness lags to `local-api-server.mjs`'s 6h
`FULL_RECONCILIATION_INTERVAL_MS` rescan. Session 40 patched only 3 (`seed-military-cii`,
`seed-forecasts` ×2). Confirmed-affected (prefix in `SYNC_PREFIXES`, `notifyChange`=0):
`seed-wb-indicators` (`economic:`), `seed-resilience-scores` + `seed-resilience-static`
(`resilience:`), `seed-portwatch-port-activity` (`portwatch:`), `seed-jodi-oil` / `seed-energy-spine`
/ `seed-ember-electricity` / `seed-owid-energy-mix` / `seed-gas-storage-countries` (`energy:`),
`seed-comtrade-bilateral-hs4` / `seed-hs2-chokepoint-exposure` (`comtrade:`/`supply_chain:`),
`seed-health-air-quality` (`climate:` half only).

**Approach (don't blast 11 ad-hoc loops):** add ONE shared helper to `scripts/_seed-utils.mjs` —
`notifyMirroredWrites(url, token, commands)` — that sweeps a pipeline command array, and for every
`['SET', key, serialized, …]` entry calls the existing `notifyChange(url, token, key, serialized)`
(which already self-gates on `isMirroredKey()`, so meta keys are safe no-ops). Add a unit test for it
(precedent: `tests/seed-utils*.test.mjs`). THEN wire each of the ~11 seeders: one call after their
`redisPipeline()`/pipeline flush succeeds. Each seeder has its own `redisPipeline()` local + differing
`url`/`token` var names — do them one at a time, `tsc`/lint after each; they can't be run live (hit
external APIs + real Redis) so lean on the helper's test + reading each call site carefully.
Full context: the "REVIEWED" block below.

### 3. Data-pipeline review lead #3 — dead GDELT code removal (low-risk cleanup)

`scripts/seed-cross-source-signals.mjs`: remove the 4 dead keys from the batch-read list (lines ~28-31
— `intelligence:gdelt-intel:v1`, `gdelt:intel:tone:{military,nuclear,maritime}` — removed in
`4d0608b`), the `extractMediaToneDeterioration()` function (~line 658, always returns `[]` now) and
its call site, and `GDELT_TONE_TOPICS` / `MAX_TONE_SIGNAL_AGE_MS` if then unused. Also delete
`src/services/sentiment-gate.ts` (dead export, no importers — grep-confirmed). `node -c` +
`tsc --noEmit` after; the seeder can't be run live.

### 4. Pre-existing, not this handoff's making — noted so a cold agent doesn't rediscover

- `local-api-server.mjs`'s inline `/api/llm-health` probe still hardcodes `PROBE_TIMEOUT = 2000`
  (~line 1790, has a `TODO` to import `getLlmHealthStatus()`). `b5323c7` only fixed the shared
  `server/_shared/llm-health.ts`. Backend log still shows `[llm:openrouter] Offline, skipping` from
  the too-tight 2s probe when openrouter round-trips take 2.1-3.8s on this network. Any LLM-gated
  panel that depends on the sidecar's own probe (rather than the shared module) can false-negative.
- 4 untracked `.docx` files ("外部系统接入…") in the repo root — 4th session flagged, operator's to
  deal with, not ours to `git add` or delete.

### Verify-changes checklist (unchanged from FORTY-FIRST)
`tsc --noEmit` (root + `tsconfig.api.json` + `tsconfig.gcp.json`), `npm run test:sidecar` (expect
207/208 — the lone `service-status … EADDRINUSE` failure is a pre-existing port conflict with the
running launchd backend, `git stash`-confirmed), `node scripts/verify-seed-envelope-parity.mjs`,
`npm run test:data` (diff against baseline — ~21-suite pre-existing/flaky set). After any
`server/_shared/*.ts` or `server/worldmonitor/**` change that the sidecar serves: `npm run
build:sidecar-handlers` then `worldmonitor-local restart` (the sidecar loads bundled `api/**/[rpc].js`,
NOT `.ts` source).

### Machine state a cold agent inherits
`com.worldmonitor.local-api` LaunchAgent installed + running (port 46123, `worldmonitor-local status`).
`com.worldmonitor.local-sync` LaunchAgent also present (the freshness backstop). `~/.worldmonitor/`
holds `local-api-token` + `session.json` (freshly re-logged-in this session, ~1h TTL — will expire
again until item 1 lands). `~/.claude.json` `mcpServers.worldmonitor-local` → `:46123` + real token,
`✔ Connected`. Nitric running (PID from `pgrep -f 'nitric start'`). The extension `.vsix` installed is
current (19.57 KB, no `sidecar/`); `dist/` is a fresh plain `npm run build`. The one thing never
visually confirmed all session: premium panels populating in the webview after iframe auth adoption —
should work now with the fresh session; a cold agent can ask the operator to reload + eyeball.

---

## 🔀 HANDOFF (2026-09-01, FORTY-THIRD session) — local backend split shipped+GUI-verified; login↔iframe unified; data-pipeline reviewed; `npm run build` fixed

The FORTY-SECOND handoff below (split the local backend from the dashboard) is **done, committed, and
live-tested on this machine**. Commits on `main` (not pushed): `b5323c7` (llm-health probe 2s→5s),
`4e10711` (.vscodeignore identity leak), `3a88e25` (42nd handoff doc), `ead1068` (the split),
`8bdd094` (43rd handoff doc), `55271ee` (restart bootstrap-fallback fix). `main` is 6 ahead of
`origin/main`.

### What shipped
- **`scripts/worldmonitor-local.mjs`** — new CLI, `bin: worldmonitor-local`. `install` / `uninstall` /
  `run` / `restart` (machine plumbing: writes `~/.worldmonitor/local-api-token` 0600, installs a
  `com.worldmonitor.local-api` LaunchAgent, RunAtLoad + KeepAlive, running `local-api-server.mjs` with
  `LOCAL_API_MODE=tauri-sidecar`; **token is never in the plist**). `login` / `logout` / `whoami`
  (identity: loopback GitHub OAuth via the existing Supabase `github` provider → session at
  `~/.worldmonitor/session.json` 0600; invite gate = the existing `worldmonitor-org-gate`
  before-user-created Auth Hook, i.e. GitHub org membership — nothing new deployed). `status` / `token`.
  `install --dry-run` writes the files but skips `launchctl` (that's what the test uses).
- **`local-api-server.mjs`** — `resolveLocalApiToken()`: `options.token` → `LOCAL_API_TOKEN` env →
  `~/.worldmonitor/local-api-token`. Resolved once onto `context.token`; the auth gate and the
  `?embed=vscode` shim read that, not `process.env` directly. Tauri/Docker/child-spawn env path
  unchanged. Default-deny preserved (the test now passes `tokenFile:` an absent path so a real
  installed token can't mask the regression). `readSessionUserId()` + `local-sync.mjs`
  `readOperatorUserId()` now prefer `session.json`, so per-user `brief:` scoping works from a cold
  start instead of only after the dashboard's first authed request.
- **Extension → thin client.** `src/sidecarProcess.ts` **deleted**, replaced by `src/backendClient.ts`:
  health-check, read the token file, and at most `launchctl kickstart -k` — never spawns/kills a
  backend. `panel.ts` offers a "Start backend" action on failure; `extension.ts` `deactivate()` is a
  no-op; `.vscodeignore` drops `sidecar/**` from the `.vsix` entirely; `worldmonitorLocal.repoRoot`
  setting removed, `worldmonitorLocal.startBackend` command added.
- Docs: `vscode-extension/README.md` rewritten (architecture diagram, first-run, CLI table, MCP-client
  JSON); `install-local-sync-agent.sh` header notes it's now the backstop for when the backend is down.

### Verified — live, on this machine
- `worldmonitor-local install` → LaunchAgent bootstrapped, backend on 46123, `RunAtLoad`+`KeepAlive`.
- REST auth: no token → 401, file token → 200 real payload (`mode: tauri-sidecar`, `cloudFallback:
  false`). Backend launched by launchd with **no `LOCAL_API_TOKEN` in env** reads
  `~/.worldmonitor/local-api-token` and gates on it. `?embed=vscode` shim carries the real token.
- MCP surface: `initialize` + `tools/list` → 41 tools, `auth_kind: env_key`.
- `restart` both paths: loaded job → `kickstart -k`; booted-out job → `bootstrap <plist>` fallback
  (this gap was the one live-test bug — fixed in `55271ee`, in the CLI *and* `backendClient.ts`).
- `worldmonitor-local login` → real GitHub OAuth in the browser → `Logged in as
  powerpro.led@gmail.com` (Supabase user `15ae70b6-…`, matches the id already on this machine) →
  `session.json` 0600 with refresh token. `local-sync` log: `operator identity … — brief: scoped to
  this user`. `operator-identity.json` write-through correctly *skipped* (ids already matched).
- **User-scoped route:** `/api/latest-brief` + loopback token + Supabase bearer → 200, real per-user
  brief (`status: ready`, URL scoped to the operator's own id).
- Fresh `.vsix` built + installed: **19.57 KB / 6 files** (was ~3 MB — the old one bundled `sidecar/`
  incl. `local-cache.db`); `unzip -l` confirms zero `sidecar/` content. Old
  `worldmonitor-internal.worldmonitor-local-dashboard@0.1.0` **uninstalled** (it was still running the
  pre-split spawner — its `killStaleOccupant()` was `kill -9`ing the launchd backend on every dashboard
  open; launchd `KeepAlive` won the race every time).
- **MCP client config fixed:** `~/.claude.json` `mcpServers.worldmonitor-local` was stale (`:46200`,
  placeholder token). Re-registered via `claude mcp` at `http://127.0.0.1:46123/api/mcp` with the real
  token → `claude mcp get` shows `✔ Connected`. Tools land in a session after a Claude Code restart.
- `scripts/worldmonitor-local.test.mjs` 7/7. `npm run test:sidecar` 205/206 — the lone failure
  (`service-status … EADDRINUSE`) is a pre-existing port conflict, confirmed via `git stash`. Extension
  `tsc --noEmit` + esbuild clean.

### Still open
1. ~~Final visual confirm of the dashboard in the GUI.~~ **DONE** — operator reloaded the VS Code
   window, the dashboard **fully rendered**. The `worldmonitor-local` MCP server also came live in the
   Claude Code session (41 tools); a real `get_chokepoint_status` call returned real mirror data and
   logged `mcp.toolcall` on the backend. So the whole loop is proven from *both* real clients (VS Code
   thin client + MCP agent), not just curl.
2. ~~`login` ↔ iframe auth are still separate.~~ **DONE** (`914a04d`). Backend serves
   `~/.worldmonitor/session.json` from the loopback-gated `GET /api/operator-session` (204 when logged
   out); `auth-provider.ts`'s `initAuthProvider()` adopts it via `supabase.auth.setSession()` when
   `getSession()` is empty AND the page is the VS Code embed, falling back to the in-page GitHub button
   on any failure. Backend half live-tested (401 / 204 / 200-with-tokens). **The iframe-side adoption
   is bundled but not yet visually confirmed** — a fresh `dist/` now exists (item 4 fixed `npm run
   build`); just needs a window reload to eyeball.
3. **Pre-existing, noticed in passing (NOT this task):** the sidecar's own inline `/api/llm-health`
   probe still hardcodes `PROBE_TIMEOUT = 2000` (`local-api-server.mjs` ~line 1770, has a `TODO` to
   import `getLlmHealthStatus()`), so `[llm:openrouter] Offline, skipping` still shows in the backend
   log despite `b5323c7` fixing the shared `server/_shared/llm-health.ts`. Same false-unreachable class,
   different code path.
4. ~~`npm run build` is broken on `main`~~ **FIXED (`1b3fdbe`).** Pre-existing (discovered `914a04d`,
   `git stash`-confirmed): `wm-variant-dashboard-html`'s `replaceCounted` hreflang anchor (min:1)
   matched 0 because `index.html` hard-codes 26 `https://www.worldmonitor.app/dashboard` hreflang
   links while `buildVariantMeta()` resolves to the configured domain. `htmlVariantPlugin` already
   normalised `canonical`/`og:url` but skipped the hreflang cluster; it now rewrites every hreflang
   href to `activeMeta.url` (preserving `?lang=`), same as canonical. Verified: `npm run build` clean,
   `dashboard.html` + all 5 variant pages regenerate. (The `index.html`→`/dashboard.html` sidecar
   fallback from `914a04d` stays — still useful for a `VITE_DESKTOP_RUNTIME=1` build.)
5. FORTY-FIRST session's data-pipeline code review — **done this session**, see the block just below.

---

## 🔍 REVIEWED (2026-09-01, FORTY-THIRD session) — data-pipeline code review (the FORTY-FIRST task)

Manual pass over the 6 leads in the FORTY-FIRST handoff (the `/code-review` skill keyed off the
unpushed session-43 commits instead, so it was done by hand against the choke-point files).

- **Lead #2 — CONFIRMED, fixed (`6a2f317`).** `sidecarCacheGet()`'s in-memory `store` branch
  returned `JSON.parse` raw while the mirror branch (`decodeMirrorEntry`) and redis.ts's live path
  both `unwrapEnvelope()`. No caller stores an envelope today (checked all 156 `setCachedJson` sites),
  and `unwrapEnvelope()` is a no-op on non-enveloped values, so this was a latent shape-flip footgun,
  now closed by unwrapping symmetrically in both branches.
- **Lead #1 — NOT WARRANTED.** The 223-raw-read-site audit the handoff feared isn't needed: unwrap is
  centralized at the redis.ts choke point (`readCachedJson`/`getRawJson`/`getCachedJsonBatch` all
  `unwrapEnvelope`; sidecar mirror does it in `decodeMirrorEntry`). The only non-unwrapping read is
  `runRedisPipeline`, and its 3 `['GET',…]` call sites in `server/worldmonitor/` read webhook regs /
  story-alias dedup / a score cache (which unwraps) — none a contract-mode seeder's canonical key.
  FORTIETH's 2 bugs were the exception, not a pattern. (Caveat: choke-point centralization verified;
  not every one of the 223 sites individually read.)
- **Lead #6 — CONFIRMED + fixed (`911a9a4`).** `list-webcams.ts` read `webcam:cameras:active` non-raw
  → `VERCEL_ENV=preview` deploys prefix-missed it (seeder writes unprefixed). Verified still wired
  (`handler.ts` + generated client/server + `src/services/webcams/index.ts`). Now `raw:true`, matching
  the geo/meta reads right below it. `military/v1/list-military-bases.ts:134` has the same non-raw read
  but self-heals with a `raw:true` retry (`rawKeys` flag) — ugly, not broken, left alone.
- **Lead #4 — CONFIRMED broader than session 40's 3-site patch, NOT fixed (needs a plan).** ~11
  seeders write mirrored data keys via raw `redisCommand(['SET',…])` and never call `notifyChange()`,
  bypassing `_seed-utils.mjs`'s centralized push: `seed-wb-indicators` (`economic:`),
  `seed-resilience-scores`/`seed-resilience-static` (`resilience:`), `seed-portwatch-port-activity`
  (`portwatch:`), `seed-jodi-oil`/`seed-energy-spine`/`seed-ember-electricity`/`seed-owid-energy-mix`/
  `seed-gas-storage-countries` (`energy:`), `seed-comtrade-bilateral-hs4`/`seed-hs2-chokepoint-exposure`
  (`comtrade:`/`supply_chain:`), `seed-health-air-quality` (`climate:` half). All those prefixes are in
  `SYNC_PREFIXES`, so `sync-listener.mjs`'s real-time push never fires for their seed writes —
  freshness lags to `local-api-server.mjs`'s 6h `FULL_RECONCILIATION_INTERVAL_MS` rescan. Fix: route
  these through `writeExtraKey()` or add explicit `notifyChange(key, type)` per raw SET of a mirrored
  key. (`_seed-utils.mjs` already has the `type` param since session 40.)
- **Lead #3 — CONFIRMED dead code, not broken.** `scripts/seed-cross-source-signals.mjs:29-32` still
  batch-reads the 4 GDELT keys removed in `4d0608b` (fallbacks at 661/685/687);
  `src/services/sentiment-gate.ts` has no importers. Wasted reads per seed run + a dead module.
  Cleanup only.
- **Lead #5 — CONFIRMED + fixed (`0f493b5`).** `news:feed-digest:*` has no seeder;
  `list-feed-digest.ts` read-through-caches a live ~190-feed crawl, and a cold backend's first
  dashboard open hit `NEWS_DIGEST_DEADLINE_MS` before the crawl finished -> every regional news panel
  "unavailable", data on the *second* open (operator reproduced exactly). `local-api-server.mjs` now
  fires one `GET /api/news/v1/list-feed-digest` per lang (en, then zh) in the background on startup —
  tauri-sidecar only, only when news isn't cloud-preferred. Verified: crawl runs on restart, digest
  then returns 16 categories / 267 items.

**Net actionable, not yet done:** lead #4 (systemic `notifyChange` gap — the biggest; ~11 bespoke
seeder edits, each unrunnable without live external APIs + Redis — deserves a dedicated pass: a shared
`_seed-utils.mjs` helper that sweeps a command array + a test, then per-seeder wiring). lead #3
cleanup (remove `extractMediaToneDeterioration` + the 4 dead GDELT batch-read keys +
`GDELT_TONE_TOPICS`/`MAX_TONE_SIGNAL_AGE_MS` if then unused, + `src/services/sentiment-gate.ts`).
#2, #5, #6 done; #1 not warranted; `npm run build` fixed.

---

## ✅ RESOLVED (2026-09-01, FORTY-SECOND session) — split local backend from the VS Code dashboard

**Resolved by the FORTY-THIRD session, commit `ead1068`.** Original scoping notes kept below for the trail.

Operator decision this session, explicitly requested as a big-enough refactor to hand to a fresh
session rather than continue mid-conversation: **separately release** (a) a local backend that runs
silently in the background on the operator's machine, consumed by both the VS Code dashboard AND the
operator's own local MCP agent, and (b) the VS Code dashboard extension itself, as a thin UI-only
client. Internal/invite-only distribution — operator explicitly ruled out building hosted-proxy or
self-service auth for this. (Final auth model landed richer than the "manually-shared token" first
sketched here: a `worldmonitor-local login` GitHub→Supabase flow reusing the existing org-gate hook —
see the FORTY-THIRD block above.)

### What's already built — no new implementation needed for these two parts

1. **MCP already works over the existing sidecar.** `vscode-extension/sidecar/local-api-server.mjs`
   routes `/api/mcp` straight to the real production handler (`api/mcp/handler.ts`, reused unmodified —
   see the routing comment right above the `/api/mcp` branch, ~line 1676). Any MCP client pointed at
   `http://127.0.0.1:<port>/api/mcp` already works today, whenever the sidecar happens to be running.
   Nothing to build here — just needs the sidecar to be reachable independent of VS Code.
2. **The background-daemon pattern already exists, scoped to the wrong process.**
   `scripts/install-local-sync-agent.sh` installs a macOS `launchd` **LaunchAgent** (user-domain, not a
   root LaunchDaemon — correct, since it needs the operator's own `.env`/repo access) that keeps
   `local-sync.mjs` running independent of the editor. Its own header comment states the exact argument
   for this whole refactor: *"the mirror is the operator's own local copy of the data layer, and its
   freshness is a property of the machine, not of whether an editor happens to be open."* Extend this
   same pattern to `local-api-server.mjs` itself rather than inventing a new mechanism.

### What blocks the split — all three are in `vscode-extension/src/sidecarProcess.ts`

1. **`dispose()` kills the backend process when VS Code deactivates** (~line 236-239,
   `this.proc?.kill()`) — directly contradicts "runs silently in the background." Under the split, the
   extension must stop owning the child process's lifetime entirely.
2. **`killStaleOccupant()` SIGKILLs whatever's already listening on port 46123 before spawning its own
   copy** (~line 94-109). Correct today (cleans up orphaned sidecars from a previous VS Code activation,
   per the `ensureRunning()` comment above it). Under the split it becomes a bug: the dashboard would
   kill the very backend service it's supposed to just connect to. Needs to become a pure health check
   with no kill path, or at minimum gated on "is this actually MY orphan" vs. "is this the intended
   standalone backend."
3. **The auth token is minted fresh and random every VS Code activation** (~line 38,
   `randomBytes(24).toString('hex')`) and handed to the child process it spawns in the same breath —
   `start()` (~line 111) passes it as `LOCAL_API_TOKEN` env var to ITS OWN child. This is the one real
   architectural fork, not just a refactor: today exactly one process (the spawner) can ever know the
   token, by construction. A standalone backend with two independent consumers (dashboard + MCP agent,
   possibly starting in either order, possibly before VS Code even opens) needs a token that already
   exists and gets *distributed*, not minted per-spawn. Proposed default (not yet confirmed with
   operator): backend generates the token once on first run and persists it to `~/.worldmonitor/
   local-api-token`; both the dashboard extension and any local MCP client config read that same file.
   Confirm this location/mechanism before implementing — it's the one genuine judgment call here.

### Proposed target shape (operator has not yet signed off on implementation, only the direction)

- **`worldmonitor-local-backend`** (naming TBD) — `local-api-server.mjs` + `local-sync.mjs`, moved out
  from under `vscode-extension/sidecar/` into its own top-level package/directory. Installed via a
  `launchd` LaunchAgent (extend `install-local-sync-agent.sh`'s pattern — likely two agents, or one
  installer covering both jobs) that starts at login, independent of VS Code. Serves `/api/*` (REST, for
  the dashboard) and `/api/mcp` (already-working MCP surface, for any local agent) on the same port.
- **`worldmonitor-local-dashboard`** (the existing extension) — becomes a pure client: on activation,
  health-check the already-running backend and read the persisted token; if not running, instruct the
  operator to start it (`launchctl` command or similar) rather than spawning/killing anything itself.
  `vscode-extension/README.md`'s "Prerequisites"/"How it works" sections will need a rewrite once this
  lands — they currently describe the extension spawning its own sidecar.

### Suggested entry point
Read `sidecarProcess.ts` in full, the `/api/mcp` routing block in `local-api-server.mjs` (~line
1658-1683), and `install-local-sync-agent.sh` (the launchd pattern to extend) before writing code.
Confirm the token-persistence decision with the operator first — it's the one piece here that's a real
design choice, not a mechanical extraction.

### Incidental work this session (uncommitted — not what the split refactor is about, but sitting in
the working tree; a fresh session should either commit or fold these in)
- `server/_shared/llm-health.ts`: `PROBE_TIMEOUT_MS` 2000ms → 5000ms. Fixed a confirmed-live bug — the
  probe timeout was too tight for this network's real round trip to `openrouter.ai` (measured 2.1s-3.8s
  via curl), causing false "unreachable" verdicts that silently skipped real OpenRouter calls for 60s at
  a time (`isProviderAvailable()` gates real calls in `llm.ts`/`summarize-article.ts`, not just logging).
- `vscode-extension/.vscodeignore`: added `sidecar/local-cache.db` + `sidecar/operator-identity.json` to
  the exclusion list. **Found a real privacy leak**: the packaged `.vsix` was baking in whoever built it
  own Supabase-authenticated identity and a live snapshot of their synced `brief:` data — defeats the
  fail-closed guard `local-sync.mjs`'s `readOperatorUserId()` depends on (null userId ⇒ no user-scoped
  data mirrored; a shipped file is never null). The existing `vscode-extension/worldmonitor-local-
  dashboard-0.1.0.vsix` on disk still has this baked in (not git-tracked, gitignored, but physically
  present) — delete and rebuild with `npm run package` once ready, don't redistribute the current file.
- Live-debugging detour this session (nitric log review, unrelated to both items above) is fully
  captured in Claude memory `session42_nitric_log_review_fixes.md` — fixed a wedged
  `worldmonitor-redis-rest` `blockingClient` connection (same class as the FORTIETH session's SUBSCRIBE
  wedge below, different connection) and found the orphaned-process mechanism behind `ais-relay.cjs`'s
  `EADDRINUSE` crash on nitric restart. Not part of this handoff's scope, referenced here only so a cold
  session doesn't rediscover it from scratch.

### Still open, unrelated to this handoff
FORTY-FIRST session's data-pipeline code review (block immediately below) was not started this session
— operator redirected to live nitric debugging instead, then to this backend/dashboard split decision.
Still the standing "next task" once the split above is scoped/done.

---

## 🔀 HANDOFF (2026-09-01, FORTY-FIRST session) — NEXT TASK: data-pipeline code review

`main == origin/main` @ `421624b`. The FORTIETH-session handoff below is fully closed (all 6 items +
item 4's deferred list + a tsconfig deprecation fix, all committed and pushed). This block sets up
the **next session's requested work: a focused code review of the data pipeline** — the seed →
Redis → RPC-handler → panel path, plus the operator-mirror sync that shadows it. Not started; a cold
agent should be able to begin from here.

### The pipeline, end to end

1. **Seed scripts** `scripts/seed-*.mjs` (+ `scripts/_bundle-*.mjs` wrappers) fetch external data and
   write canonical keys to Redis. **109 of them run in "contract mode"** — pass `declareRecords` /
   `envelopeMeta` to `runSeed()`/`writeExtraKey()` in `scripts/_seed-utils.mjs`, which wraps the
   payload as `{_seed:{fetchedAt,recordCount,state,...}, data:<payload>}`. Others write FLAT (bare
   payload) via plain `writeExtraKey()` / raw `redisCommand()`.
2. **Envelope contract** lives in THREE hand-kept-in-sync copies: `scripts/_seed-envelope-source.mjs`
   (source), `server/_shared/seed-envelope.ts` (Edge), `api/_seed-envelope.js` (Edge). Parity is
   enforced by `scripts/verify-seed-envelope-parity.mjs` ↔ `tests/seed-envelope-parity.test.mjs`.
   `stripSeedEnvelope()` / `unwrapEnvelope()` are no-ops on a bare (non-enveloped) value.
3. **Read choke point** `server/_shared/redis.ts`: `getCachedJson(key, raw?)`, `getRawJson(key)`,
   `runRedisPipeline()`. The `raw`/second-arg flag ONLY toggles key-prefixing, NOT envelope
   unwrapping — `readCachedJson()`'s live path always `unwrapEnvelope()`s; **the tauri-sidecar path
   does NOT** (see #known-lead-2). **223 `getCachedJson(…, true)` / `getRawJson()` call sites** across
   `server/` + `api/` — each one must unwrap the envelope itself iff its backing seeder is
   contract-mode.
4. **RPC handlers** `server/worldmonitor/<domain>/v1/*.ts` read those keys, and on a miss/empty return
   `unavailable(ctx)` / `emptyResponse` → the panel shows "unavailable". `server/gateway.ts` dispatches
   and wraps every call in `runWithUsageScope({ ctx })`.
5. **Sidecar mirror** (VS Code embed / Tauri): `vscode-extension/sidecar/local-sync.mjs` full-rescans
   `SYNC_PREFIXES` (`scripts/shared/sync-domains.mjs`) from Redis into `local-cache.db`;
   `sync-listener.mjs` applies real-time pushes; `server/_shared/sidecar-cache.ts` serves reads back.
   Write-side push nudges: `scripts/_seed-utils.mjs`'s `notifyChange()` (scripts) and
   `server/_shared/sync-notify.ts`'s `notifyKeyChanged()`/`notifyPipelineWrites()` (RPC side).
6. **Freshness/health**: `api/health.js`'s `SEED_META` + `BOOTSTRAP_KEYS`, `api/seed-health.js`'s
   `SEED_DOMAINS`, `src/services/health-freshness-map.ts` (check-name → client source), and
   `src/services/data-freshness.ts` (`getSourcesForPanel` needs EVERY panel source health-mapped or the
   badge disappears — see FORTIETH item 6 follow-up A).
7. **Scheduling**: `gcp/scheduler/main.ts`'s `CADENCES` + `scripts/railway-services.json`. **No live
   scheduler runs any of this right now** — Railway abandoned, `nitric up` never run against GCP, no
   seeder GitHub Action. Locally, seeders run via `nitric start`'s scheduler service or by hand.

### Concrete leads a review should chase (found this session, not fully run down)

1. **Seed-envelope unwrap audit — NOT DONE.** FORTIETH item 5 fixed exactly 2 handlers
   (`list-global-tenders.ts`, `get-chokepoint-status.ts`) that read `snapshot.tenders` /
   `.summaries` off the still-wrapped envelope. Only the keys behind that session's screenshot were
   checked. The real audit: cross-reference all 223 raw-read sites against whether their seeder is
   contract-mode, and confirm each unwraps. `tests/forecasts-ticker-set-envelope-unwrap.test.mjs` is
   the precedent for a per-key regression test.
2. **`sidecarCacheGet()`'s in-memory `store` path skips `unwrapEnvelope()`** —
   `server/_shared/sidecar-cache.ts`: the `store` (in-memory LRU) hit returns
   `JSON.parse(entry.value)` raw, while `decodeMirrorEntry()` (mirror path) AND the live-Redis path
   both unwrap. Plausible single root cause for the whole envelope-mismatch class in sidecar mode.
   Verify whether `store` is even populated in the VS Code sidecar (it may only read the mirror).
3. **Orphaned read fallbacks after the GDELT removal** — `scripts/seed-cross-source-signals.mjs`
   still batch-reads `intelligence:gdelt-intel:v1` + `gdelt:intel:tone:{military,nuclear,maritime}`
   (dead keys now) and `src/services/sentiment-gate.ts` is a dead export. Both degrade gracefully;
   wasteful, not broken.
4. **`notifyChange()` type coverage** — FORTIETH item 4 added a `type` param and wired the 3 raw-write
   bypass sites it knew about (`seed-military-cii.mjs`, `seed-forecasts.mjs` ×2). Other seeders with a
   private `redisSetJson`/raw `redisCommand()` for a mirrored key may still bypass the push.
5. **`news:feed-digest:*` has no seeder** — it's purely read-through-cached by `list-feed-digest.ts`
   itself, so a cold sidecar / empty local Redis shows every regional news panel "unavailable" until a
   live ~190-feed RSS crawl finishes (up to `NEWS_DIGEST_DEADLINE_MS`). Confirm that's intentional vs.
   a coverage gap; there's no warm-ping for it in `local-api-server.mjs`.
6. **`getCachedJson` NON-raw vs raw + prefix interaction** — worth a pass on whether any handler reads
   a seeder-written (unprefixed) key WITHOUT `true`, which would prefix-miss in preview/dev.

### How to verify pipeline changes
`tsc --noEmit` (root + `tsconfig.api.json` + `tsconfig.gcp.json`), `node scripts/enforce-sebuf-api-contract.mjs`,
`node scripts/verify-seed-envelope-parity.mjs`, `npm run test:data` (has a ~21-suite pre-existing/flaky
failure set — diff against a baseline, don't assume net-new). The per-seeder tests
(`tests/*-seed.test.mjs`) and `tests/seed-utils*.test.mjs` cover the write path.

### Suggested entry point
`/code-review high` on a scoped diff, or `/code-review ultra` for a multi-agent cloud pass over the
pipeline files. There is no pending diff — this is a review of existing code, so the reviewer should
target the paths above by path, e.g. `server/_shared/redis.ts`, `server/_shared/sidecar-cache.ts`,
`server/_shared/seed-envelope.ts`, `scripts/_seed-utils.mjs`, and a sample of contract-mode
seeder ↔ handler pairs.

---

## 🔀 HANDOFF (2026-08-31, FORTIETH session) — read this first, supersedes every block below

**TL;DR**: session 39's real-time sync (still unpushed, 4 commits) turned out to be live — the VS Code
sidecar was already running it against local dev, and it exposed a real, previously-unknown bug in
`docker/redis-rest-proxy.mjs` (the local Redis-REST dev shim) that was breaking most dashboard panels.
Root-caused and fixed live, not guessed. Also fixed a nitric.yaml quoting bug (Latest Brief resumes
locally), re-confirmed a known-but-forgotten orphaned seeder (`fetch-gpsjam.mjs`), found+fixed a
seed-envelope unwrap bug in 2 more RPC handlers (item 5), and — operator's own call, not a bug fix —
removed `实时情报`/GdeltIntelPanel entirely after a redundancy review (item 6, ~65 files, fully verified).
**STATUS — session 40 (continued): ALL SIX handoff items done + pushed, AND item 4's full deferred
list.** Session-40 commits on top of session 39's 4:
`d995272` (item 1) · `56d1f7b` (item 2) · `1feb98c` (item 3) · `43a4451` (item 5) ·
`4d0608b` (item 6 + both follow-ups) · `1bdf245` (docs) · then item 4's 7 deferred reliability
findings in one pass (see the "RESOLVED — session 40 (continued)" block at the end of the
THIRTY-NINTH handoff below — the `ctx.waitUntil()` one needed NO 21-call-site refactor because
`redis.ts` already has ambient `ctx` via `getUsageScope()`/AsyncLocalStorage).
Nothing from the handoff left open. 4 unrelated `.docx` files still sit untracked in the tree
(3rd session flagged, operator's to deal with).

1. **`docker/redis-rest-proxy.mjs` — critical connection-isolation bug, fixed.** The proxy holds ONE
   shared `client` connection for every GET/SET/SCAN. `SUBSCRIBE` was in its command allowlist and got
   dispatched through the same generic path onto that SAME shared connection (only `BLMOVE`-family
   commands got their own dedicated connection, via `blockingClient`). SUBSCRIBE flips a RESP connection
   into subscribe-only mode until it unsubscribes — nothing ever did, so the first caller to hit
   `/subscribe/<channel>` (a route the proxy didn't actually implement; it just fell through to the
   generic command dispatcher) permanently wedged EVERY other request through the proxy, proxy-wide,
   regardless of key. `local-api-server.mjs`'s `sync-listener.mjs` (session 39's feature) does exactly
   this on every reconnect (2s→30s backoff) — so a freshly recreated container got re-wedged within ~1s,
   every time. Symptom in the app: `[redis] getCachedJson failed: Redis HTTP 500` /
   `[redis] setCachedJson failed: ERR Can't execute 'set': only (P|S)SUBSCRIBE ... allowed` spamming the
   vite log, most panels stuck on "Loading…"/"CACHED · 1/35 sources" — looked exactly like missing seed
   data, was actually one poisoned connection.
   Fixed: `SUBSCRIBE` removed from the shared-client allowlist entirely; a real `POST /subscribe/{channel}`
   SSE route added, using `client.duplicate()` per listener (opened/closed with the request) and Upstash's
   real wire format (`data: subscribe,<ch>,<n>` / `data: message,<ch>,<payload>`, matching
   `sync-listener.mjs`'s `decodeFrame()` exactly). Also added `XADD`/`XRANGE` to the allowlist — missing
   entirely, which meant `sync:changelog` (the catch-up half of the same feature) 403'd independent of the
   wedge. Verified live: 6 SET/GET probes clean across 30s spanning sidecar reconnects; `CLIENT LIST`
   showed the shared client idle at `cmd=set` while the sidecar's subscribe sat isolated on its own
   connection (`flags=P`); dashboard reload showed zero new `[redis]` errors, Strategic Risk sources
   went 1/35→2/35, Country Instability scores moved off static placeholders. **Commit `d995272`.**
   - Side incident while testing the fix: `docker restart` on the wedged container hung indefinitely, and
     every follow-up (`start`/`inspect`, even read-only) on that specific container ID hung too — daemon
     was fine for everything else (`docker ps`, other containers). Looked like a stuck containerd shim from
     the SIGKILL. Needed an actual Docker Desktop restart to clear; `docker rm` + `docker compose up -d`
     were instant once it was back. If this recurs: don't keep retrying `docker start`/`restart` on the
     same container — one hang can queue every subsequent op on that container ID behind it.

2. **`nitric.yaml`'s `seed-digest-notifications` loop wrapper — fixed.** The inline
   `start: sh -c "while true; do node $SERVICE_PATH; sleep 1800; done"` (added session 38-ish to give the
   one-shot digest script a local re-invoke cadence) throws `unexpected EOF while looking for matching "`
   on every `nitric start` — nitric's local start-command parser splits the quoted `-c` argument on
   whitespace instead of passing it through intact. Fixed by extracting the loop into a real file,
   `scripts/loop-digest-notifications.mjs` (spawns the digest script as a child every 30min, matching
   Railway's real cron cadence), and pointing `match:`/`start: node $SERVICE_PATH` at that instead — same
   pattern `publish-bootstrap-tiers.mjs` already uses successfully. Production's
   `Dockerfile.digest-notifications` untouched — still runs the digest script directly, one-shot, per
   Railway's own cron; this only affects local `nitric start` sessions. Verified live: clean start, ran a
   real cycle (`[digest] Cron run start...`, `watchlist scan: hashes=316 candidates=7...`). **Not yet
   committed** (`nitric.yaml`, `scripts/loop-digest-notifications.mjs`).

3. **`/api/gpsjam` 503 — not a new bug, a rediscovery.** Already diagnosed by a past session, documented
   at TASKS.md's "twenty-ninth session" entry further below: `scripts/fetch-gpsjam.mjs` is an orphaned
   seeder, scheduled nowhere — not in `nitric.yaml`, not in `gcp/scheduler`, no GitHub Actions workflow,
   **in production either**, confirmed by grep this session too. That session fixed 3 real bugs inside the
   script but never actually wired it to run anywhere, so any Redis reset (this session's Docker Desktop
   restart counts) wipes `intelligence:gpsjam:v2` and nothing repopulates it until someone runs the script
   by hand again. Ran it this session (`node scripts/fetch-gpsjam.mjs`) — 47,985 hexes fetched, key
   restored, route back to 200. **The real gap (where should this actually be scheduled) is still open —
   operator's call, same as every other seed-source scheduling decision in this file.**

4. Session 39's own deferred list (`ctx.waitUntil()` threading etc.) is UNTOUCHED this session — see that
   block immediately below for the full list, still the next scoped-pass candidate whenever picked up.

5. **Seed-envelope unwrap bug — found in 2 RPC handlers, likely present in more.** 117 seed scripts write
   their canonical key in "contract mode" (`declareRecords` passed to `runSeed`), which wraps the payload
   as `{_seed, data}` — a documented, established convention (`server/_shared/seed-envelope.ts`'s
   `stripSeedEnvelope()`/`unwrapEnvelope()`, already used correctly by e.g. `get-resilience-ranking.ts`).
   Found via the VS Code sidecar dashboard showing several panels stuck on "unavailable" with real,
   fresh seeded data sitting right there in Redis/the mirror:
   - `server/worldmonitor/economic/v1/list-global-tenders.ts` (Global Procurement panel): read
     `snapshot.tenders` directly instead of `snapshot.data.tenders` — always empty, always fell through
     to `unavailable(ctx)`, regardless of 525 real tenders sitting in Redis. **Fixed — commit `43a4451`.**
   - `server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts` (Chokepoints/Supply Chain panel):
     same pattern on TWO keys (`supply_chain:transit-summaries:v1`, `energy:chokepoint-flows:v1`) —
     `.summaries` read off the raw envelope was always `{}`, which pinned `upstreamUnavailable = true`
     unconditionally. **Fixed — commit `43a4451`.**
   - Checked and ruled out for the OTHER panels in the same screenshot: FRED series, economic stress
     index, WTO trade-restrictions/tariff-barriers all write FLAT (non-enveloped) via plain
     `writeExtraKey()` with no `envelopeMeta` — those 3 panels' "unavailable" state was pure missing
     data (their seeders hadn't fired yet this session — same "6h cron doesn't fire in a short local
     `nitric start` session" gap as item 3's gpsjam finding), not a code bug. Ran `seed-economy.mjs` and
     `seed-supply-chain-trade.mjs` (~9.5min, live WTO API is slow) by hand to populate them; verified
     live, no code changes needed there.
   - **NOT a full audit** — 117 seeders use contract mode; only checked the specific keys backing the
     panels visible in this session's screenshot. A real audit (every `getCachedJson(key, true)` call
     site cross-referenced against whether ITS seeder's `writeExtraKey`/`runSeed` call passes
     `envelopeMeta`/uses the canonical enveloped write) would very plausibly turn up more of the same —
     worth a dedicated pass, not done here.
   - Sidecar bundle rebuilt twice this session (`npm run build:sidecar-handlers`) to pick up both fixes —
     handler modules are cached in the sidecar's memory for its process lifetime
     (`local-api-server.mjs`'s `moduleCache`), so a rebuild alone doesn't reach an already-running
     sidecar. Killed the sidecar (pid 20689, port 46123) after both rebuilds; VS Code respawns it on
     next panel use.

6. **`实时情报` (GdeltIntelPanel/"Live Intelligence") removed from the codebase entirely, plus MapPopup's
   hotspot live-intel context — operator's explicit decision after a redundancy review, not a bug fix.**
   Reviewed whether the panel earned its place given 100+ other data sources already covered: its
   article-search half largely duplicated the RSS-backed Intel Feed panel; its one genuinely unique
   piece (per-topic tone/volume sparkline) was a nice-to-have, not decision-grade signal; and GDELT's
   conflict-relevant contribution already reaches the dashboard through a *different, working* path
   (`_conflict-gdelt-bulk.mjs`'s official 15-min bulk CSV export from GCS, feeding CII/conflict-intel —
   completely unaffected by the DOC API blocking that's plagued this one panel across sessions 35-37 and
   again this session). Verdict: drop it.
   Before cutting, evaluated 3 OTHER consumers of the same shared `gdelt-intel.ts` service that weren't
   part of the original panel discussion — MapPopup hotspot context (same broken pipeline, weak match
   design even when healthy → **also removed**), PizzINT tensions (`fetchGdeltTensions`, completely
   separate pipeline/seed key, unaffected either way → **left alone**), Good News Explorer's positive
   topics (`fetchAllPositiveTopicIntelligence`, queries topics that were NEVER part of the removed
   6-topic seed cache, so it **structurally could never have worked** — a real, separate, pre-existing
   bug, not caused by or fixed by this removal → **left alone, flagged as its own open item**).
   Touched ~65 files: panel component, 2 RPC handlers (kept `search-gdelt-documents.ts` — Good News
   Explorer still calls it; removed `get-gdelt-topic-timeline.ts` — panel-only), the `.proto` schema +
   hand-edited generated client/server TS (no `buf`/sebuf codegen toolchain installed locally to
   regenerate — verified by hand, `tsc --noEmit` clean on both configs), the seeder + its 3 dedicated
   tests, `nitric.yaml`/`gcp/scheduler`/`railway-services.json` scheduling entries, all panel-registry/
   config/mission-preset/command-palette entries, ~180 locale keys across all 26 locale files (via a
   one-off script, verified against `sync:locales:check`), dead CSS (~170 lines), and 10 test files
   (deleted 3, trimmed 7 — verified against a stashed-baseline diff of the FULL `npm run test:data` run
   so only genuinely new failures got attention, not this repo's large pre-existing/flaky set).
   **One real near-miss worth remembering**: initially also removed `api/health.js`'s `gdeltIntel` health
   check and its `health-freshness-map.ts` mapping, reasoning it was orphaned cleanup — reverted after
   realizing `'gdelt'` is `requiredForRisk: true` in `CORE_SOURCES`, gating Strategic Risk AND CII panels'
   hard insufficient-data state. That coupling is real and out of this task's scope — left the health
   check in place, which means `intelligence:gdelt-intel:v1`'s `seed-meta` will now report stale forever
   (nothing seeds it again). **Deliberately not resolved — a real follow-up**: either retarget what
   `'gdelt'` freshness means (it also gets written from a live, unrelated path — unrest-events'
   GDELT contribution, `dataFreshness.recordUpdate('gdelt', ...)` in `data-loader.ts`'s protests loader)
   or relax `requiredForRisk`. Separately: `server/worldmonitor/_bootstrap-cache-key-refs.ts` turned out
   to have ZERO real importers anywhere — its `gdeltIntel` entry removal was cosmetic-only; the REAL
   bootstrap registry is `shared/bootstrap-tier-keys.js` (synced via `npm run sync:bootstrap-tier-keys`
   into `api/_bootstrap-tier-keys.js` — a generated file, don't hand-edit it directly), which needed the
   same removal to satisfy `tests/bootstrap.test.mjs`'s real coverage checks.
   Fully verified: `tsc --noEmit` clean (both configs), `biome lint` clean, `enforce-sebuf-api-contract.mjs`
   clean, `sync:locales:check` clean, full `npm run test:data` diffed against a stashed pre-change
   baseline (zero net-new failures after fixes — 2 real regressions found and fixed:
   `mcp-bootstrap-parity.test.mjs` needed an `EXCLUDED_FROM_MCP` entry for the now-orphaned-but-still-
   bootstrapped key, `mcp-tools-list-compression.test.mjs`'s direct-enum mutation-isolation test needed
   retargeting from the removed `topic` param to `get_prediction_markets.category`).

   **RESOLVED — session 40 (continued).** Both flagged follow-ups above were then closed, operator's
   call, and committed together with the rest of item 6:
   - **Good News Explorer / positive-topic path — removed too.** `search-gdelt-documents.ts` (kept in the
     first pass "because Good News Explorer still calls it") actually reads `intelligence:gdelt-intel:v1`
     — the exact key the deleted seeder wrote — so post-removal it returns `seed-unavailable` forever: a
     dead RPC + always-empty path in the shipped surface. Cut the lot: deleted `src/services/gdelt-intel.ts`
     entirely, `server/worldmonitor/intelligence/v1/search-gdelt-documents.ts`,
     `proto/.../search_gdelt_documents.proto`; unwired the RPC from `service.proto` + hand-edited
     generated client/server + `handler.ts` + `server/gateway.ts`'s `RPC_CACHE_TIER` +
     `scripts/lib/sebuf-query-param-contract.mjs`'s two registries; removed the always-empty GDELT
     supplementary merge from `data-loader.ts`'s `loadHappySupplementaryAndRender()` (the `positive-feed`
     panel already renders fine off curated RSS `happyAllItems`); dropped the now-dead
     `EXCLUDED_FROM_MCP` entry the first pass had added; trimmed `tests/mainjs-eager-clients.test.mjs` +
     `tests/hapi-gdelt-circuit-breakers.test.mjs` header. `src/services/sentiment-gate.ts` +
     `scripts/seed-cross-source-signals.mjs`'s `intelligence:gdelt-intel:v1` / `gdelt:intel:tone:*` read
     fallbacks are now orphaned-but-inert (graceful-degradation branches) — left in place, flagged.
   - **`gdeltIntel` health check — retargeted, not removed.** Removing it outright ALSO drops the
     freshness badge on Strategic Risk / CII / Intel panels — `data-freshness.ts`'s `getSourcesForPanel`
     returns `[]` unless EVERY panel source is health-mapped, and `gdelt` was the health-backed half of
     `CORE_SOURCES`. So: kept `gdeltIntel: ['gdelt']` in `health-freshness-map.ts`, removed the dead
     `intelligence:gdelt-intel:v1` from `api/health.js`'s `BOOTSTRAP_KEYS` and from `api/seed-health.js`,
     and pointed `api/health.js`'s `SEED_META.gdeltIntel` check at the LIVE `seed-meta:news:insights`
     (the news-intelligence aggregate — GDELT-inclusive, seeded every 30 min; 720 min budget preserved).
     Badge keeps working; `requiredForRisk` gating unchanged; no more stale-forever.
   Re-verified to the same bar: `tsc` (root/api/gcp) clean, `enforce-sebuf-api-contract` clean,
   `sync:locales:check` clean, `sync:bootstrap-tier-keys:check` clean, biome clean on touched files,
   full `npm run test:data` diffed against an item-6-absent baseline → identical failing-suite set (this
   repo's ~21 pre-existing/flaky suites), zero net-new. **Commit `4d0608b` (pushed).**

5. **Seed-envelope unwrap bug — found in 2 RPC handlers, likely present in more.** 117 seed scripts write
   their canonical key in "contract mode" (`declareRecords` passed to `runSeed`), which wraps the payload
   as `{_seed, data}` — a documented, established convention (`server/_shared/seed-envelope.ts`'s
   `stripSeedEnvelope()`/`unwrapEnvelope()`, already used correctly by e.g. `get-resilience-ranking.ts`).
   Found via the VS Code sidecar dashboard showing several panels stuck on "unavailable" with real,
   fresh seeded data sitting right there in Redis/the mirror:
   - `server/worldmonitor/economic/v1/list-global-tenders.ts` (Global Procurement panel): read
     `snapshot.tenders` directly instead of `snapshot.data.tenders` — always empty, always fell through
     to `unavailable(ctx)`, regardless of 525 real tenders sitting in Redis. **Fixed — commit `43a4451`.**
   - `server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts` (Chokepoints/Supply Chain panel):
     same pattern on TWO keys (`supply_chain:transit-summaries:v1`, `energy:chokepoint-flows:v1`) —
     `.summaries` read off the raw envelope was always `{}`, which pinned `upstreamUnavailable = true`
     unconditionally. **Fixed — commit `43a4451`.**
   - Checked and ruled out for the OTHER panels in the same screenshot: FRED series, economic stress
     index, WTO trade-restrictions/tariff-barriers all write FLAT (non-enveloped) via plain
     `writeExtraKey()` with no `envelopeMeta` — those 3 panels' "unavailable" state was pure missing
     data (their seeders hadn't fired yet this session — same "6h cron doesn't fire in a short local
     `nitric start` session" gap as item 3's gpsjam finding), not a code bug. Ran `seed-economy.mjs` and
     `seed-supply-chain-trade.mjs` (~9.5min, live WTO API is slow) by hand to populate them; verified
     live, no code changes needed there.
   - **NOT a full audit** — 117 seeders use contract mode; only checked the specific keys backing the
     panels visible in this session's screenshot. A real audit (every `getCachedJson(key, true)` call
     site cross-referenced against whether ITS seeder's `writeExtraKey`/`runSeed` call passes
     `envelopeMeta`/uses the canonical enveloped write) would very plausibly turn up more of the same —
     worth a dedicated pass, not done here.
   - Sidecar bundle rebuilt twice this session (`npm run build:sidecar-handlers`) to pick up both fixes —
     handler modules are cached in the sidecar's memory for its process lifetime
     (`local-api-server.mjs`'s `moduleCache`), so a rebuild alone doesn't reach an already-running
     sidecar. Killed the sidecar (pid 20689, port 46123) after both rebuilds; VS Code respawns it on
     next panel use.

---

## 🔀 HANDOFF (2026-08-23, THIRTY-NINTH session) — read this first, supersedes every block below

**TL;DR**: resolves session 38's STILL OPEN item 1 (real-time local-sync mechanism) — implemented, live-
verified against real Upstash (item 2), then put through a 7-pass multi-agent code review (item 4) that
found one genuinely critical bug (a cross-user privacy leak on the new push path) plus several real,
lower-severity/bigger-scope findings — the critical one and 6 others are fixed and verified; the rest are
explicitly deferred with reasons, not silently dropped (see item 4's own "genuinely deferred" sub-list —
that IS the next session's work-list, in priority order). **3 commits, merged to `main` locally (fast-
forward, clean) — `main` is 3 commits ahead of `origin/main`, NOT pushed**, standing "ask before push"
discipline. Nothing in this feature is live in production yet: it only runs once an operator's sidecar
process is restarted (picks up the new `local-api-server.mjs` code) AND `main` is actually pushed/deployed
— as of this handoff neither has happened, so there is no live behavior to monitor yet, just code sitting
locally ready to go out. If asked to push, that's the very next natural step; if picking up further work
instead, start from item 4's deferred list, in the order given (`ctx.waitUntil()` threading is the biggest
single item — real reliability gap, not a correctness bug, needs its own scoped pass touching ~21+ call
sites).

1. **Local operator real-time sync — built.** Replaces the "loop the existing full-rescan every 10-15s"
   idea (session 38's other option) entirely — that would have cost ~21M Upstash commands/day/operator
   (measured: 2,500 commands/run × 8,640 runs/day), almost certainly the real explanation for a
   multi-million-command spike the operator found on the Upstash dashboard from before local dev switched
   to Docker Redis. New design, three parts:
   - **Write side** (`scripts/_seed-utils.mjs`'s `notifyChange()`, `server/_shared/sync-notify.ts`'s
     `notifyKeyChanged()`/`notifyPipelineWrites()`): after a write to a mirrored-domain key lands, fires a
     best-effort, un-awaited `PUBLISH sync:notify` (small values inline, oversized ones signal-only) +
     `XADD sync:changelog` (key + type, for catch-up). Hooked into exactly 2 real choke points — seed
     scripts' `redisCommand()`-based `atomicPublish`/`writeExtraKey`, and the RPC-handler side's
     `setCachedJson`/`runRedisPipeline` — NOT 184 files; every write path funnels through one of these two.
     Never blocks or fails the actual data write (fire-and-forget, `.catch()`-swallowed).
   - **Listener side** (new `vscode-extension/sidecar/sync-listener.mjs`): one persistent HTTPS/SSE
     connection (`POST {UPSTASH_URL}/subscribe/sync:notify` — confirmed via Upstash's own docs to be plain
     REST/SSE, NOT the raw RESP/TCP connection that was rejected as "unreliable over VPN" back on
     2026-08-06) applies each change directly to `local-cache.db` (inline value, or one targeted read for
     signal-only messages). Reconnects with backoff on any drop, and on every (re)connect — including the
     process's first connect, which is what covers "operator's laptop just woke from sleep" with **no**
     explicit sleep/wake detection needed (a suspended process's timers don't fire while asleep, but
     wall-clock time still advances via the RTC, so the dropped connection just surfaces as an ordinary
     stream error on resume) — first runs a changelog catch-up (`XRANGE sync:changelog` from a persisted
     cursor) to backfill anything missed. Opens/closes the SQLite handle per write rather than holding one
     open, specifically to avoid the "long-lived handle keeps writing to the old inode after
     `local-sync.mjs`'s atomic rename swap" trap `sidecar-cache.ts` already documented.
   - **`local-sync.mjs`'s full rescan** stays, demoted from "the mechanism" to a correctness backstop —
     `local-api-server.mjs`'s new `startFullReconciliationLoop()` spawns it once at sidecar startup
     (bootstraps a fresh machine) and then every 6h (not tight), catching whatever the push path missed
     (a silently-failed notify, a gap wider than the changelog's retention). `startSyncListener()` starts
     the listener in-process alongside it. Both gate on `tauri-sidecar` mode + a read-only token present,
     matching every other Redis-touching code path in that file; neither can block or crash server startup
     (verified live: booted the sidecar with a fake unreachable Upstash host, watched both paths fail
     gracefully into their own retry/backoff instead of taking the HTTP server down).
   - Shared mirrored-key allowlist extracted to `scripts/shared/sync-domains.mjs` (imported by
     `local-sync.mjs` and the seed-side write hook) with a duplicate in `server/_shared/sync-notify.ts` for
     the Edge-bundled RPC side (no existing cross-import path reaches there — same reasoning
     `_domain-config.mjs`'s own "generated tracked copy" comment already documents for this exact class of
     problem, just not applied here since this repo's sidecar currently runs against a full checkout on
     disk, not a self-contained bundle — see that comment in `local-api-server.mjs` if a real Tauri
     packaging step ever gets built, since that would change this tradeoff).
   - **Real bug found and fixed along the way, not by design**: `forecast:simulation-task*` (a live worker
     queue, `SIMULATION_TASK_QUEUE_KEY`) was accidentally sweeping into the mirrored allowlist via the
     broad `forecast:` prefix — same mistake class as the already-excluded `seed-lock:`. Caught because the
     new write-hook instrumentation broke `tests/simulation-queue-parity.test.mts` (the TS and `.mjs`
     write paths would have started notifying asymmetrically for the same key). Fixed via a narrow
     `MIRROR_EXCLUDED_PREFIXES` exclusion in both prefix files, not by touching the broader `forecast:`
     prefix — confirmed the parity test passes again with ZERO test changes once the underlying scope bug
     was fixed, the strongest signal it was the right fix rather than a test-shape patch.
   - **Also fixed**: `Dockerfile.relay` was missing a `COPY` line for the new
     `scripts/shared/sync-domains.mjs` (caught by `tests/dockerfile-relay-imports.test.mjs` — would have
     been a silent `ERR_MODULE_NOT_FOUND` on next relay deploy).
2. **VERIFIED LIVE against real Upstash, same session — the SSE payload-shape guess was WRONG, fixed.**
   Connected `sync-listener.mjs` to the real hosted Upstash endpoint (the commented-out
   `[switched-to-local-redis]` credentials in `.env` — the active ones point at local Docker Redis for dev)
   and found two things:
   - **The operator's own long-running `nitric start` dev server (up since before this session, watching
     the repo, hot-reloading on save) had ALREADY exercised the new write-side notify code for real** —
     `sync:changelog` held 18 real entries (`risk:scores:sebuf:v8`, `infra:service-statuses:v1`,
     `supply_chain:chokepoints:v4`, ...) from ordinary live traffic through that server, entirely
     independent of anything run for this verification. Good organic proof the write side works; also a
     reminder that saving a file this repo's dev server watches has real, immediate production-adjacent
     effects, not just local ones.
   - **The actual `/subscribe/{channel}` wire format, confirmed via curl against a real PUBLISH**: a plain
     comma-separated string, NOT JSON — `subscribe,<channel>,<count>` once on connect, then
     `message,<channel>,<the raw PUBLISH payload, verbatim>` per message. `decodeFrame()`'s original guess
     (bare JSON or a `{channel,message}` envelope) was wrong on both counts — confirmed by a live PUBLISH
     that Redis reported as delivered (`PUBLISH` returned `{"result":1}`, i.e. one subscriber received it)
     but that never applied to the local mirror. Fixed by splitting on the first two commas only (the
     message itself is our JSON and legitimately contains commas, so a naive full split would truncate
     it) and ignoring non-`message` frames. Re-verified live after the fix: published a synthetic
     `resilience:zz-sync-verify-test-3` key, confirmed it landed in `local-cache.db` with the exact value
     published, real end-to-end proof, not inferred from logs alone. Unit tests
     (`tests/sync-listener.test.mjs`'s `decodeFrame` suite) rewritten to match the confirmed format.
   - Left 3 small synthetic test entries in the real `sync:changelog` stream
     (`resilience:zz-sync-verify-test`, `-2`, `-3`) — harmless (not a mirrored prefix's real key, streams
     don't get scanned by anything, `local-sync.mjs` never reads this stream), not cleaned up, safe to
     ignore or `XDEL` if it bothers anyone.
3. Committed on a new branch `local-realtime-sync` (not `main`), **not pushed** — standing "ask before
   push" discipline. Two commits: the initial implementation (new files:
   `scripts/shared/sync-domains.mjs`, `server/_shared/sync-notify.ts`,
   `vscode-extension/sidecar/sync-listener.mjs`, `tests/sync-listener.test.mjs`; modified:
   `scripts/_seed-utils.mjs`, `server/_shared/redis.ts`, `vscode-extension/sidecar/local-sync.mjs`,
   `vscode-extension/sidecar/local-api-server.mjs`, `Dockerfile.relay`,
   `tests/aviation-cache-poison.test.mts`, `tests/redis-caching.test.mjs`), and a follow-up commit for the
   `decodeFrame()` wire-format fix found via the live verification above. `tsc --noEmit` clean; full `npm
   run test:data`-equivalent (13,910 tests) compared via a real before/after run (not `git stash`, since
   two of the new files are untracked) — 57 pre-existing failures unchanged, 34 pre-existing cancellations
   unchanged, +18 new tests (`tests/sync-listener.test.mjs`, after the decodeFrame rewrite) all passing, zero
   regressions.
4. **Multi-agent code review (7 independent passes) run against the branch, findings verified and the real
   ones fixed — committed (3rd commit, `0c387ae`) and merged to `main`.** One finding was a genuine, serious
   pre-fix bug; the rest were real but lower-severity or out of scope for this pass. Fixed:
   - **CRITICAL, fixed**: `isMirroredKey()` (the shared write-side/listener gate) only checked the broad
     `brief:` prefix, with no per-user scoping — `sync:notify` is one global channel every operator's
     sidecar subscribes to identically, so ANY user's private brief content would have been pushed and
     written into EVERY operator's local mirror in real time, exactly the leak `local-sync.mjs`'s own
     `keepKey()` exists to prevent during the full rescan (which was and still is correct — this bug only
     affected the new push path). Fixed by excluding user-scoped `brief:<userId>:<slot>` keys from the
     real-time push entirely (they still reach the mirror correctly via the full rescan); `brief:llm:*`
     (shared, non-user-scoped LLM output) stays pushable. Added regression tests
     (`tests/sync-domains.test.mjs`) — this case had zero test coverage before.
   - **Confirmed via the review AND independently already observed live during this session's own
     verification** (a "connection lost (This operation was aborted)" mid-catch-up that wasn't diagnosed at
     the time): `sync-listener.mjs`'s idle-timeout watchdog was armed before `catchUp()` ran and never reset
     during it, so a catch-up backlog taking longer than 90s would self-abort the connection before it ever
     reached the live read loop. Fixed by clearing the timer before catch-up and only arming it once the
     live read loop starts. This surfaced a second gap while fixing it: `catchUp()`'s Redis reads had no
     timeout of their own (the `@upstash/redis` SDK can hang a request forever with no error, per
     `local-sync.mjs`'s own documented finding) — added a 5-minute watchdog around the whole catch-up call
     specifically, separate from the stream idle timer.
   - `sync:changelog` had no `MAXLEN` anywhere — an unbounded-growth stream is the exact cost shape this
     whole feature was built to avoid. Added an approximate `MAXLEN ~ 10000` trim to both write-side XADD
     calls.
   - `tests/redis-caching.test.mjs`'s assertion (loosened to `captured.length >= 1` when the new notify
     calls were added) properly fixed to filter for the `SET` command specifically, matching the pattern
     already used in `tests/aviation-cache-poison.test.mts` — restores the ability to catch a duplicate
     write regression.
   - The "no existing cross-import path from `server/_shared` into `scripts/`" justification for
     hand-duplicating `SYNC_PREFIXES`/`isMirroredKey` in `server/_shared/sync-notify.ts` was **factually
     wrong** — `server/_shared/simulation-queue.ts` already imports from `scripts/_simulation-queue-
     constants.mjs` the same way, with a header comment confirming esbuild bundles it inline at Vercel
     build time. Fixed by having `sync-notify.ts` import `isMirroredKey` from
     `scripts/shared/sync-domains.mjs` directly (new `scripts/shared/sync-domains.d.mts` companion
     declaration, matching `_simulation-queue-constants.d.mts`'s existing pattern) — removes the whole
     hand-sync-drift risk class instead of just detecting it after the fact.
   - `local-sync.mjs` was missing the `isMainModule()`-style guard this codebase's own scripts overwhelmingly
     use (100+ existing instances) — `main()` ran unconditionally at module load. Added, matching
     `local-api-server.mjs`'s own `isMainModule()` exactly (`pathToFileURL` comparison, not a raw
     `file://${...}` template). `sync-listener.mjs`'s own guard was upgraded to the same robust pattern
     while at it (its original `file://${process.argv[1]}` template comparison could break on paths needing
     URL-encoding). Verified both fire correctly in both directions (real direct-invocation test, and the
     existing import-based test suite).
   - Hardened `extractFrames()` to normalize CRLF/CR to LF before splitting on the blank-line frame
     boundary — the live verification confirmed real Upstash currently uses bare `\n`, but the SSE spec
     permits `\r\n`, and a future change or intermediary proxy emitting it would otherwise make frames
     silently stop being extracted (connection looks healthy in logs, nothing ever applies).
   - **Genuinely deferred, not fixed this pass — real findings, bigger scope or lower severity:**
     - `setCachedJson`/`runRedisPipeline` don't accept a `ctx` parameter, so the new fire-and-forget notify
       fetches can't be registered with `ctx.waitUntil()` — this codebase's own established, documented
       requirement (`server/_shared/usage.ts`, `server/gateway.ts`) for background work in Vercel Edge
       handlers to survive past the response phase. Without it, the RPC-side push may be silently dropped
       by isolate teardown some fraction of the time in production — degrading gracefully to the 6h
       reconciliation backstop, not a correctness bug, but a real reliability gap. Fixing this properly
       means threading `ctx` through `setCachedJson`/`runRedisPipeline` and updating ~21+ call sites —
       real, but a bigger, separate change; needs its own pass.
     - Several writers bypass both blessed notify choke points entirely via private write helpers
       (`scripts/seed-military-cii.mjs`'s own `redisSetJson`, several raw `redisCommand()` calls in
       `scripts/seed-forecasts.mjs` for `forecast:predictions:history:v1`/`conflict:ema-windows:v1`), so
       those specific mirrored keys never get the real-time push, only the 6h backstop — an asymmetric,
       silent freshness gap contradicting this session's own "every write path funnels through one of these
       two" framing. Not a regression (these never had push before either), but incomplete coverage.
     - `local-sync.mjs`'s full rebuild-and-atomic-rename can silently revert a live push-applied value:
       a push landing between when the rebuild scanned that prefix and when the rebuild finishes (can be
       minutes) gets discarded when the rebuild's older snapshot replaces the whole file. Real, but fixing
       it properly needs a merge policy (e.g. comparing `synced_at` timestamps rather than a blind
       overwrite), not a quick patch — deferred.
     - `local-api-server.mjs`'s `close()` doesn't clear the 6h reconciliation `setInterval` or tear down the
       listener's SSE connection — only matters if the sidecar server is ever created+closed repeatedly
       in-process (not how it runs in practice today, but relevant if a test or future restart path does
       this).
     - `notifyPipelineWrites()` runs synchronously inside `runRedisPipeline`'s existing try block before
       `return result` — currently defensively type-guarded so it can't throw, but the structural coupling
       means a future edit that does throw would misreport a successful pipeline write as failed.
     - In non-production `VERCEL_ENV` (preview/dev), `setCachedJson`'s env-prefixed `finalKey` never matches
       `SYNC_PREFIXES` (the prefix strings don't start with `preview:<sha>:`), so the RPC-side push is a
       silent no-op there. Low practical severity — the whole local-mirror system implicitly targets
       production Upstash already (operators aren't mirroring from preview deployments) — but worth knowing
       if that assumption ever changes.
     - Minor: `sync-listener.mjs` and `local-sync.mjs` independently define the identical `kv_cache` DDL —
       low risk (schema is stable, write logic itself isn't duplicated — one does upsert, the other plain
       insert into a fresh file), but a future column addition needs remembering to edit both.

   **RESOLVED — session 40 (continued). All seven deferred findings above fixed in one pass.**
   The `ctx.waitUntil()` one turned out NOT to need the ~21-call-site refactor: `server/_shared/redis.ts`
   already imports `getUsageScope()` from `./usage.ts`, and `server/gateway.ts` already wraps every
   handler in `runWithUsageScope({ ctx, … })` (AsyncLocalStorage) — the exact mechanism
   `emitUpstreamFromHook()` uses for usage telemetry. So `ctx` is available *ambiently* inside
   `setCachedJson`/`runRedisPipeline` with zero call-site changes.
   - **#1** — `sync-notify.ts`'s `notifyKeyChanged`/`notifyPipelineWrites` now RETURN their in-flight
     promise (or `null`); `redis.ts` has a `registerSyncNotify(p)` helper that does
     `getUsageScope()?.ctx?.waitUntil(p)` (try/caught — no scope outside a request = fetches already
     dispatched, no keep-alive needed). Wired into both `setCachedJson` and `runRedisPipeline`.
   - **#2** — `scripts/_seed-utils.mjs`'s `notifyChange()` is now `export`ed and takes an optional
     `type` param (string values inline as before; list/zset/hash/set go signal-only, matching
     `notifyPipelineWrites`). Called from the three bypass sites: `seed-military-cii.mjs`'s
     `redisSetJson` (its canonical `intelligence:military-cii:v1`), and `seed-forecasts.mjs`'s raw
     `conflict:ema-windows:v1` SET + `forecast:predictions:history:v1` LPUSH (`appendHistorySnapshot`).
   - **#3** — `local-sync.mjs`'s rebuild now, just before the atomic rename, re-opens the LIVE db
     read-only and `SELECT … WHERE synced_at > <run-start>` — any row a listener push applied during
     the (minutes-long) rebuild is upserted into the tmp db so the rename can't revert it. Rows from a
     prior rebuild have `synced_at <= run-start` and are correctly superseded. Shrinks the lose-a-push
     window from minutes to the merge→close→rename gap (~ms); a push in that residual gap still
     self-heals on the next push/rebuild. Best-effort (try/caught, non-fatal).
   - **#4** — `startFullReconciliationLoop()` returns a `clearInterval` stop fn; `startSyncListener()`
     returns a `controller.abort()` stop fn and passes `{ signal }` to `runForever()`, which now
     breaks its reconnect loop on abort and links the signal into `runOneConnection`'s `AbortController`
     (aborts the in-flight fetch + read loop immediately). `createLocalApiServer().close()` calls both.
   - **#5** — the pipeline-write notify is now structurally OUTSIDE `runRedisPipeline`'s write
     try/catch (result captured, then `return` past it) — a future throwing edit can't misreport a
     completed write as failed.
   - **#6** — `setCachedJson` notifies with the caller's LOGICAL key and only when `finalKey === key`
     (production, or a `raw` write) — preview/dev is now an *intentional, commented* skip, not an
     accidental `isMirroredKey()` prefix miss.
   - **#7** — DDL extracted to `vscode-extension/sidecar/kv-cache-schema.mjs`, imported by both writers.
   Also fixed a stale comment in `scripts/shared/sync-domains.mjs` ("sync-notify.ts DUPLICATES this
   list" — session 39 already switched it to import).
   Verified: `tsc` (root/api/gcp) clean, biome clean on touched files (1 pre-existing warning in
   `local-api-server.mjs:1598`, untouched), `node --check` on all `.mjs`, `sync-domains` + `sync-listener`
   + `redis-caching` + `simulation-queue-parity` + `aviation-cache-poison` suites all green, full
   `test:data` diffed against baseline — zero net-new. **No bespoke tests added for the reliability
   hardening** (matches how session 39 handled its own deferred set); `runForever({signal})` teardown
   and `notifyChange` type-routing are covered only by `tsc` + reading — a follow-up could extract
   `local-sync.mjs`'s merge into a testable unit.

---

## 🔀 HANDOFF (2026-08-23, THIRTY-EIGHTH session end) — superseded by the thirty-ninth block above

**TL;DR for whoever picks this up**: everything this session got fixed IS committed locally (2 commits,
`234416d` + `812e839`) — NOT pushed, same standing "ask before push" discipline. Two independent threads
finished and verified: (1) `consumerPrices*`'s `DATABASE_URL` is now genuinely wired and connection-tested
end-to-end (a real incident happened and was cleanly resolved along the way — read item 7 below before
touching that service again); (2) a real, previously-invisible bug where the **VS Code embed's own client-side
cache masked already-correct backend fixes indefinitely** — root-caused across three separate layers, all
fixed and tested. **One big, explicit, unresolved architecture decision is left for you**: STILL OPEN item 1
below. Read it before doing anything with `local-sync.mjs` or `sidecar-cache.ts`.

1. **STILL OPEN — real decision needed, not investigated further by design.** The operator wants
   `vscode-extension/sidecar/local-cache.db` (the VS Code embed / Tauri desktop's local SQLite mirror of
   Redis) kept close to real-time, not the 30-min-poll default this session was about to implement before
   being told to stop and hand off. Two genuinely different paths, not yet chosen between:
   - **Fast polling** (simple): keep `local-sync.mjs`'s existing full-rescan design, just run it much more
     often (e.g. every 10-15s) via a loop wrapper in `local-api-server.mjs` or `nitric.yaml` (see the
     `seed-digest-notifications.mjs` precedent already in `nitric.yaml` — `sh -c "while true; do node
     $SERVICE_PATH; sleep N; done"`). No new connection model, stays consistent with this whole repo's
     REST-only Upstash convention (~184 files). Costs more Upstash read-command volume than 30-min polling,
     scales worse the more often you shrink the interval, and is never literally instant — just "close
     enough that a human watching a dashboard won't notice."
   - **True push** (bigger, riskier): a persistent Redis protocol connection using keyspace notifications,
     so `local-sync.mjs` (or whatever replaces its trigger mechanism) reacts the moment a write happens
     instead of polling at all. Genuinely real-time, but a real architecture change — this project's
     `@upstash/redis` usage is deliberately REST-based everywhere else (session context: an earlier
     hand-rolled raw-protocol version "proved unreliable from an operator workstation on a VPN," per
     `local-sync.mjs`'s own header comment on why it now uses the SDK's REST-shaped `scan`/`pipeline`
     calls) — pub/sub needs an always-open connection with its own reconnect/failure handling, a new
     class of "what happens when this drops silently" bug this codebase doesn't have anywhere else yet.
   - Neither is implemented. `local-sync.mjs` is STILL a fully manual `npm run local-sync` command as of
     this handoff — nothing schedules it. Do not assume the mtime-reload fix (item 2 below) means syncing
     itself became automatic; it only made an *already-running* sidecar capable of noticing a sync if one
     happens to occur.
2. **FIXED, tested, committed (`812e839`) — VS Code embed showing stale/degraded risk-scores data long
   after the backend was already correct.** Root-caused across 3 stacked layers, in order discovered:
   - **Layer 1 (separate issue, fixed first)**: the sidecar's own local execution of RPC handlers runs
     from a **pre-bundled esbuild artifact** (`api/**/[rpc].js`), completely separate from both the
     frontend's `dist/` and the live `.ts` source — generated by `npm run build:sidecar-handlers`, a THIRD
     build step nobody had run after this session's earlier ACLED-catch verification. Ran it (51 entry
     points) — confirmed the rebuilt bundle now has the fix. **Lesson: any backend fix needs BOTH `npm run
     build` (frontend) AND `npm run build:sidecar-handlers` (backend RPC bundles) to actually reach the VS
     Code embed** — two independent artifacts, easy to remember only one. This alone made the sidecar's
     own direct computation correct (verified live via curl with an extracted session token — see this
     session's transcript for the token-extraction technique if you need to hit the sidecar directly again:
     `curl .../dashboard.html?embed=vscode` and grep the embedded `LOCAL_TOKEN`).
   - **Layer 2 (the actual masking bug)**: even with a correct backend, the panel still showed the old
     value. `src/utils/circuit-breaker.ts`'s `persistCache` option (localStorage + IndexedDB, used by
     **36 different services**) is redundant AND actively harmful inside a sidecar-backed runtime: it
     already has `sidecar-cache.ts`'s SQLite mirror as its local persistent cache, and layering a second
     one on top means `recordSuccess()` stamps a rehydrated old snapshot with `Date.now()`, re-arming a
     fresh `cacheTtlMs` window from "now" — every window reload could defer a real refetch indefinitely.
     Fixed with one choke point: `isSidecarBackedRuntime()` in `circuit-breaker.ts` (checks
     `window.__TAURI__`/`__TAURI_INTERNALS__`/`__wmVsCodeApi` directly, no import from
     `services/runtime.ts`, matching the file's existing `isDesktopOfflineMode()` style) disables
     `persistCache` for both real Tauri desktop and the VS Code embed. Two services
     (`cached-risk-scores.ts`, `cached-theater-posture.ts`) had their OWN separate hand-rolled localStorage
     sync-prime on top of the breaker — same bug, gated the same way. **A whitebox test
     (`tests/circuit-breaker-persistent-stale-ceiling.test.mts`) asserts the literal source text
     `this.cacheTtlMs === 0 ? false` and `tests/cached-risk-scores.test.mts` does a literal string-replace
     on `import { createCircuitBreaker } from '@/utils';`** — both broke on a naive first attempt; fixed by
     restructuring to preserve the exact substrings (`&& !isSidecarBackedRuntime()` appended rather than
     folded into the ternary; the new import added as its own line via `@/utils/circuit-breaker` directly,
     not merged into the existing `@/utils` import). All 3 relevant test files pass (60/60 combined),
     `tsc --noEmit` clean.
   - **Layer 3 (prerequisite fix for item 1 above)**: `sidecar-cache.ts`'s `loadMirror()` cached the SQLite
     mirror in memory for the sidecar process's *entire lifetime*, by explicit prior design ("this does
     not and should not expire rows... static for the process's lifetime"). That was reasonable when
     `local-sync.mjs` was manual and rare, but it structurally means automating the sync (item 1) would
     have been invisible to an already-running sidecar regardless. Fixed: now does a cheap `statSync()` on
     `local-cache.db` per read and only pays the full reload cost when the mtime actually changed —
     amortizes the expensive part across however often syncing actually happens, whatever cadence item 1
     lands on. Deliberately does NOT keep one persistent open SQLite connection instead of reload-on-change
     — `local-sync.mjs` publishes via an atomic `fs.renameSync()` swap (deliberate, avoids a reader ever
     seeing a half-written DB), and a long-lived file handle on POSIX keeps reading the OLD inode after a
     rename replaces the path — so a persistent connection would never see a sync take effect at all,
     forever, not just late. `node:fs` loaded via `process.getBuiltinModule` (not a static import), same
     reasoning as the existing `node:sqlite` loading in this file — it's transitively reachable from
     `api/*.ts` Vercel Edge handlers.
3. **`consumerPrices*` — `DATABASE_URL` wired, connection verified live, real incident hit and cleanly
   resolved. FIXED, tested, committed (`234416d`).** Operator supplied both Supabase pooler connection
   strings (Session pooler port 5432, Transaction pooler port 6543 — wired the Session pooler one per this
   file's own pre-existing warning against Transaction-pooler for `pg.Pool`). Found and fixed:
   `consumer-prices-core/` had never had `npm install` run at all (unrelated to `DATABASE_URL`); a 5s
   `connectionTimeoutMillis` too tight for the pooler's TLS+auth handshake (raised to 20s; raw TCP itself
   connects in ~0.4s, ruling out a VPN-throttle explanation like the other 7 bypassed hosts). **Real
   incident**: `migrate.ts`'s SQL uses unqualified `CREATE TABLE retailers` (relies on connection
   `search_path`); the app's `client.ts` never set one, so the first real `npm run migrate` run created a
   **complete duplicate set of all 12 consumer-prices tables in the shared `public` schema** (RLS-disabled,
   PostgREST-exposed — unlike the correct `consumer_prices` schema, never registered for that). Caught via
   `list_tables` immediately after running it, before doing anything further; operator approved cleanup.
   Dropped the 12 stray `public.*` tables (verified `public` back to its original 38-table baseline,
   `consumer_prices` untouched), added `options: '-c search_path=consumer_prices'` to the `Pool` config so
   this can't recur, re-ran `npm run migrate` clean (`[skip]` × 9, correctly resolved). Still genuinely
   open, unchanged from session 37: the hosting decision for the job pipeline, and no scraping run yet
   (deliberately out of scope — real Firecrawl/Exa API costs).

---

## 🔀 HANDOFF (2026-08-23, THIRTY-SEVENTH session end) — superseded by the thirty-eighth block above

**TL;DR for whoever picks this up**: everything actionable this session got fixed and verified live
(not just "should work") — `riskScores` staleness, CanadaBuys timeout, VPN LaunchDaemon persistence
(now 5 hosts), and — the big one — **Climate Anomalies is fully resolved end-to-end**, confirmed via
direct Redis reads on both `climate:zone-normals:v1` and the cascading `climate:anomalies:v2`. GDELT
was tried again with a residential proxy and conclusively did NOT work (0/4 clean across 2 rounds) —
closed as a dead lever, not left ambiguous. `consumerPrices*` went from a vague "needs new infra"
note to a concretely-scoped, partially-executed plan (Postgres schema + migrations done, `DATABASE_URL`
+ hosting decision still needed from the operator). All commits are local-only, NOT pushed — same
"ask before push" discipline as every prior session, operator hasn't been asked this exact question
at close (see STILL OPEN item 1). The rest of this block below (session 36's original items,
inline-updated throughout this session as things got resolved) is kept as the full trail — read the
STILL OPEN list at the bottom for the authoritative current state, not the item-by-item narrative
above it if the two ever seem to disagree (the STILL OPEN list was updated last, closest to now).

Picked up cold from the thirty-sixth session's handoff (verified nitric pid 68604/ais-relay pid
68614 alive at session start; both later restarted by the OPERATOR THEMSELVES mid-session to pick up
a `.env` change — new pids 50340/50420 as of session close, confirmed alive; a separate `vite` dev
process, pid 41694, was still independently running since 2026-08-19 as of last check, unrelated to
this handoff, not touched).

1. **FIXED**: VS Code embed CORS error on `country-boundary-overrides.geojson`. Root cause:
   `dist/` (gitignored, what the sidecar serves) was last built with `APP_DOMAIN=worldmonitor.app`
   baked in — `getSubdomainOrigin('maps')` collapses to the app origin ONLY when `APP_DOMAIN` is a
   `localhost` value (`shared/domain-config.js`'s `isLocalDomain` check), so the compiled bundle
   always fetches the real `https://maps.worldmonitor.app/...` CDN regardless of where it's served
   from. In a browser tab hitting the real deployed site this is same-site and fine; inside the VS
   Code sidecar the page's real origin is `http://127.0.0.1:<sidecar port>` (confirmed via `lsof`,
   pid 71417 → 127.0.0.1:46123), which the CDN's CORS policy doesn't allow → console CORS error.
   Discovered a **second, bigger bug while trying to fix this by rebuilding `dist/` locally**:
   `npm run build` with `.env`'s current `APP_DOMAIN=localhost:3000` fails outright —
   `src/config/variant-dashboard-html.ts`'s hreflang-anchor replacement expects
   `variantMetaMap.full.url` (domain-derived) to appear in `dashboard.html`, but that file's
   hreflang `<link>` tags are hardcoded to `https://www.worldmonitor.app/dashboard` literally, so
   the anchor match count is 0 and the build's own drift guard (#4996) fails it loudly. **Local
   `npm run build` with a non-`worldmonitor.app` `APP_DOMAIN` is currently broken** — flagging, not
   fixing (touches the #4996 SEO-regression guard, deserves its own deliberate pass, not a
   rebuild-triggered side quest). Actual fix applied instead, precedented pattern: gated the
   override fetch in `src/services/country-geometry.ts` behind `isVsCodeEmbedRuntime()` (same
   reasoning `getConfiguredWebApiBaseUrl()` in `src/services/runtime.ts` already uses for the
   embed's `/api` base URL) — skips the guaranteed-to-fail cross-origin fetch inside the VS Code
   embed entirely, degrading silently to the base `countries.geojson` boundaries (no user-visible
   change; the override was already optional/best-effort). `tests/country-geometry-overrides.test.mts`
   still passes (2/2, run via `APP_DOMAIN=example.test npx tsx --test`). Not yet rebuilt into the
   sidecar's `dist/` or verified live in the extension — needs `npm run build` (will still emit the
   *worldmonitor.app*-domain bundle, since a local-domain build is broken per above) then a VS Code
   window reload.
2. **"实时情报" (GDELT intel) panel still empty — nitric restart NOT needed, confirmed live.**
   `gcp/scheduler/main.ts`'s scheduler entry point spawns `seed-gdelt-intel.mjs` as a **fresh**
   `node` child process every cron tick (`spawn('node', [...])`, `0 */2 * * *`) — no module-caching
   staleness is possible here (that trap only applies to code loaded in-process, like the
   `chat-analyst.ts` fix two sessions ago). Verified directly: `seed-meta:intelligence:gdelt-intel`
   shows a run at `2026-08-23T02:23:15Z`, ~22 minutes before this check, already running post-fix
   code — and it still returned `recordCount: 0`. The canonical `intelligence:gdelt-intel:v1` key is
   completely absent from Redis (never a successful write to fall back to). This is the same
   still-open external blocker the thirty-fifth session already root-caused and left as **STILL
   OPEN item 1** below (Decodo datacenter-proxy IP likely GDELT-blocklisted; needs the operator's
   Decodo dashboard for a residential-endpoint check) — re-confirmed, not re-diagnosed from scratch.
3. **Latest Brief showing 22 Aug, not 23 Aug — found a genuinely orphaned cron, NOT a display bug.**
   `api/latest-brief.ts` reads a `brief:latest:{userId}` pointer "written by the digest cron"
   (its own doc comment). Direct Redis scan: exactly one such pointer exists
   (`brief:latest:15ae70b6-2045-49e5-9381-7e426c1d8295`), pointing at slot `2026-08-22-2237` — i.e.
   the digest cron has not run since 22:37 UTC on 2026-08-22, which is exactly the stale brief the
   operator is seeing. Root cause: **`scripts/seed-digest-notifications.mjs` (the composer —
   Dockerfile.digest-notifications's own header: "Railway cron, every 30 min", one-shot script,
   `main()` + `process.exit()`, no internal loop) is not running anywhere in this dev environment**
   (`ps aux` — no matching process) **and is not registered in `gcp/scheduler/main.ts`'s CADENCES
   map** (grepped for `brief`/`digest` — zero matches), unlike every other Railway-era cron that
   already got migrated there. `nitric.yaml` lists it under the "always-on services" block with a
   bare `node $SERVICE_PATH` start command and no `--loop`/re-invoke wrapper, which — given the
   script has no internal loop — would only run it once even if something did start it; this looks
   like a genuine gap in the Railway→GCP-scheduler migration, same class as `seed-global-tenders.mjs`
   in the thirty-fifth session. **Not run or fixed yet, deliberately**: `RESEND_API_KEY` is a live
   key in `.env` and `DIGEST_CRON_ENABLED` has no kill-switch value set, so invoking this script for
   real would send actual email (and possibly Telegram/Slack/Discord) to real users — an
   outward-facing, hard-to-reverse action that needs the operator's explicit go-ahead, either to
   run it once now (refreshes the brief immediately) and/or to register it in
   `gcp/scheduler/main.ts` for a recurring local trigger going forward.
4. **Digest cron (item 3) — RESOLVED, operator-approved.** Root cause was mischaracterized as a
   "missing from `gcp/scheduler/main.ts` CADENCES" gap — it isn't: that file's CADENCES map is
   deliberately scoped to `railway-services.json`'s `nixpacks-*` entries only (per its own header
   comment); `seed-digest-notifications` is registered `deployMode: "dockerfile"`, wired directly
   as its own service in `nitric.yaml` on purpose, same as `ais-relay.cjs`/`scenario-worker.mjs`.
   The REAL bug: that nitric.yaml entry's `start: node $SERVICE_PATH` runs the script exactly once
   (it has no internal loop — one-shot `main()` + `process.exit()`, its real cadence came from
   Railway's own Cron Schedule re-invoking the container every 30 min, a primitive `nitric start`
   doesn't have). Fixed: wrapped the local `start:` command in a shell loop (`while true; do node
   $SERVICE_PATH; sleep 1800; done`) so `nitric start` gives it the same recurring cadence Railway
   did. Needs a nitric restart to pick up (service list is read at nitric startup, not live).
   **Also ran it once manually** (operator-approved, live `RESEND_API_KEY` in `.env`): composition
   succeeded (`compose_success=1 compose_failed=0`) and `brief:latest:{userId}` now points at slot
   `2026-08-23-1055` — Latest Brief panel fixed, confirmed via direct Redis read. Run reported
   `0 digest(s) sent` — the per-channel due/cooldown gate didn't fire an actual notification this
   cycle, so no surprise live email went out despite the manual invocation.
5. **Timeout-widen item (STILL OPEN item 2) — investigated, turns out NOT a simple fix, flagging
   back rather than guessing at numbers (same caution the thirty-fifth session already applied
   here).** Did the actual math before touching any timeout value:
   - **CanadaBuys**: 6MB CSV ÷ its VPN-bypassed 14KB/s ≈ **439s needed**. Its per-attempt timeout
     (currently 60s) is bounded by `seed-bundle-relay-backup.mjs`'s hard 180s SIGTERM ceiling for
     the whole "Global-Tenders" bundle section (confirmed in code, `fetchResponse`'s own comment in
     `seed-global-tenders.mjs`) — no per-attempt timeout under ~170s can ever complete this pull.
     Actually fixing it needs the SECTION deadline raised to ~450-500s, a bigger, more consequential
     change (that section blocks the bundle runner for that long every hourly tick) — not a decision
     to make silently.
   - **OFAC**: `seed-sanctions-pressure.mjs`'s own header says the source is a **~120MB** XML feed.
     At its VPN-bypassed 4KB/s (barely above the pre-bypass 6KB/s baseline — the bypass essentially
     didn't help this host), that's **~30,720s (8.5h)** to download in full. No timeout value fixes
     this; it needs genuinely faster network access, which this session doesn't have a lever for.
   - **Submarine cables — FIXED, verified live.** Structurally different from the other two: many
     small per-cable JSON fetches (`cable/${id}.json`, 86 total, batches of 5), not one giant
     payload. Widened the per-request timeout 15s → 30s in `scripts/seed-submarine-cables.mjs`
     (confirmed headroom first: 18 batches × 30s worst-case still fits under runSeed's default 240s
     fetch-phase deadline — `lockTtlMs` 120s + `FETCH_PHASE_DEADLINE_MARGIN_MS` 120s — since batches
     don't realistically all hit the ceiling simultaneously). Ran it live: **86/86 cables fetched**,
     `state: OK`, 104.6s total (2 retries at the whole-fetch level before the clean pass), verified
     written to `infrastructure:submarine-cables:v1` in Redis. `submarineCables` health should clear
     on the next check.
6. **气候异常 (Climate Anomalies) panel empty — root-caused, partially fixed, then a live test made
   it WORSE, stopped deliberately.** `climate:anomalies:v2` and its hard dependency
   `climate:zone-normals:v1` (`seed-climate-anomalies.mjs` throws immediately if the normals
   baseline is missing) were both completely absent from Redis — never a successful write, ever, in
   this environment. Root cause is NOT the VPN body-stream throttle documented for the other 6 hosts
   — Open-Meteo's `archive-api.open-meteo.com` was returning fast HTTP 429s, not slow stalls. Found
   and fixed a real reliability bug in `scripts/seed-climate-zone-normals.mjs`: on partial failure,
   `runSeed`'s own outer `withRetry(fetchFn)` re-invokes the WHOLE 13-batch fetch from scratch,
   discarding every already-succeeded zone — with a heavy 429 rate, some batch fails on nearly every
   full sweep, so a clean pass essentially never happens by chance (confirmed: 4 full-sweep restarts
   burned an entire 540s budget with zero net progress). Fixed: restructured to track failed zones
   and retry only those on subsequent internal passes (`NORMALS_MISSING_ZONE_RETRY_PASSES`), so
   progress accumulates instead of resetting; also trimmed `maxRetries` 4→1 (same fix pattern as the
   GDELT rate-gate work — stop burning budget on same-IP direct retries that rarely clear a 429, get
   to the proxy-fallback leg faster) and raised `fetchPhaseTimeoutMs` explicitly (240s default →
   540s then 570s, matching `seed-bundle-climate.mjs`'s real 600s SIGTERM ceiling with margin). All
   53 tests across `climate-seeds`/`open-meteo-proxy-fallback`/`seeder-content-age-coverage` pass.
   **First live verification run (2 internal passes) showed the fix genuinely working**: 25→14→12
   zones still missing across passes — real convergence, unlike the unfixed version, which never
   converged at all. Bumped passes 2→4 and re-ran to try to clear the 17-zone minimum. **That second
   run was a clean regression: 100% of batches failed on direct AND both Decodo proxy legs (CONNECT
   + curl) simultaneously, on every one of 3 full sweeps, zero zones succeeded** — a harder, total
   block, not the ~50%-success partial state the first run saw. Very plausibly self-inflicted: 3
   full test runs in quick succession this session may have escalated Open-Meteo from ordinary
   per-IP rate-limiting into a firmer temporary block covering both the direct IP and Decodo's
   egress pools. **Stopped testing live at this point — deliberately, not from a budget cutoff** —
   matching the GDELT lesson already on record ("retrying more after a 429 makes it worse"). The
   code fix is real and committed to disk but UNVERIFIED end-to-end this session (never actually
   wrote `climate:zone-normals:v1`). Needs: (a) a cooldown period before trying again — do not
   immediately re-run; (b) if a next attempt also sees the 100%-blocked pattern rather than the
   earlier ~50% partial pattern, that's a materially different, harder problem than what the code
   fix targets and deserves fresh diagnosis, not more retry-tuning.
7. **`SCRAPECREATORS_API_KEY` added** to `.env` (operator-supplied) — fixes `WsbTickers`/
   `socialVelocity`'s documented Reddit-policy gap from session 35 (unauthenticated endpoint 403s;
   this is the one working fallback). Needs `ais-relay.cjs` restarted to pick it up (module-load-time
   env read, same class of trap as the `chat-analyst.ts` fix two sessions ago).
8. **FIXED, verified live: `ais-relay.cjs` warm-ping 405s** (`ServiceStatuses`, `Chokepoints`,
   `CableHealth`, `TemporalAnomalies`). Root cause: all four warm-pinged their RPC route via POST
   with an empty `{}` body, but every one of those routes is registered GET-only (confirmed in the
   generated `service_server.ts` — the GET handlers hard-code an empty request object regardless of
   any body/query params, so the POST body was always discarded anyway). Production's real gateway
   (`server/gateway.ts`'s `createDomainGateway`) has an explicit "POST→GET for stale clients"
   compatibility fallback, but `vite.config.ts`'s local-dev `sebufApiPlugin` — despite its own
   comment claiming to route through "the same handler pipeline as the Vercel catch-all gateway" —
   is actually a separate, simpler router that does NOT implement that fallback, so locally a POST
   just 405s outright. Fixed by switching all four warm-pings to plain GET (matching how the CII
   warm-ping already worked) — removes the dependency on the missing fallback entirely rather than
   porting the fallback into the vite plugin. All 41 `relay-boot-seed-freshness-guard` tests pass.
   Verified live against the real local route for all four: 200 with real payloads (`cable-health`
   and `get-chokepoint-status` came back structurally empty — `upstreamUnavailable: true` / `{}` —
   which is a separate, pre-existing data-freshness question, not the 405 this item targeted).
9. **`bootstrap-r2` R2 credentials — FIXED, operator's explicit call to set up in dev.** Root cause
   confirmed: `scripts/_r2-storage.mjs`'s `bootstrap` storage profile needs its OWN dedicated
   `R2_ACCOUNT_ID`/`R2_BOOTSTRAP_BUCKET`/`R2_BOOTSTRAP_ACCESS_KEY_ID`/`R2_BOOTSTRAP_SECRET_ACCESS_KEY`
   — deliberately separate from `CLOUDFLARE_R2_*` (used by `seed-military-bases.mjs`/
   `seed-forecasts.mjs`), per `.env.example`'s own comment: the bootstrap bucket carries two
   differently-scoped credentials (write for the Railway publisher, read for the Vercel edge
   reader) and "no consumer may fall back to the forecast/military object credentials." Confirmed
   `worldmonitor-data` (the operator's existing bucket) is NOT interchangeable with
   `worldmonitor-bootstrap` for this reason — reusing it would blur that isolation. `.env.example`
   itself flags this credential "never in development" — operator made the explicit call to set it
   up locally anyway (new bucket-scoped R2 API token created, Object Read & Write on
   `worldmonitor-bootstrap` only). Added to `.env`; the token-creation flow also issued a
   Cloudflare-API-style token (`cfut_...`) alongside the S3-compatible access-key pair — not stored,
   since `_r2-storage.mjs`'s bootstrap profile has no `apiToken` mapping and never reads it. **Verified
   with two real publishes, not just config resolution**: `node scripts/publish-bootstrap-tiers.mjs
   --tier=fast` wrote 1,029,980 bytes to R2, `--tier=slow` wrote 3,133,433 bytes, both clean (no
   credential error; `missing: 5`/`9` keys per tier is a separate, pre-existing data-completeness
   gap, not a credential issue). Needs `publish-bootstrap-tiers.mjs`'s own long-running process (part
   of `nitric.yaml`'s always-on services) restarted to pick up the new `.env` values.

### Verified live after the final restart (2026-08-23 ~14:38 local) — not just config, actual log evidence

Read `.nitric/services.log` directly rather than trusting "should work now": zero `HTTP 405`
warm-ping lines since the 14:26 `ais-relay.cjs` restart (last one was 14:16:56, from the pre-fix
process); `bootstrap-r2` went from repeated `credentials are missing` (last at 14:22:56) to clean
publishes every ~2min continuously through 14:38, both tiers; `WsbTickers` had already succeeded
once before today's restart too (13:17:33, "Seeded 15 tickers from 150 posts") — the current loop
just skipped re-fetching because that data's still inside its 180min freshness window, not because
anything is broken.

### Dev stack at close — confirmed alive, not assumed

`nitric start --no-browser` (operator's own terminal, pid 68604) with `ais-relay.cjs` running AS
ITS OWN MANAGED CHILD this time (pid 68614, port 3004) — cleaner than earlier sessions' pattern of
a separately-launched standalone `ais-relay.cjs`. Both `clean-nitric-history.mjs` copies (pids
10018/39551) still alive from prior sessions. **Ignore a `vite` process on pid 41694 if `ps aux`
still shows one** — it's a 4+ day old orphan from before session 35, bound to `[::1]:3000` only
(IPv6 loopback, not `127.0.0.1` — this is WHY `curl http://localhost:3000/...` fails while
`curl http://[::1]:3000/...` works on this machine), unrelated to anything this or the prior
session touched. Not killed — no evidence it's causing harm, and killing an operator-visible
process without a clear reason isn't this session's call.

### 🔭 STILL OPEN — handed off, pick this up first

Health not re-checked at this close (`/api/health?compact=1` needs the vite dev server or sidecar
running correctly to hit — see the `[::1]` note above; use whichever port actually answers, don't
assume `localhost:3000` works).

1. **RESOLVED — clean handoff, nothing owed.** Working tree is clean, every session-37 change
   committed AND pushed — operator explicitly confirmed the push at session close.
   `origin/main` == `HEAD` == `ba48a1b` as of this handoff. No uncommitted or unpushed work to pick
   up; the next session starts with a fully synced remote, same as session 35's own clean close.
2. **气候异常 (Climate Anomalies) — FULLY FIXED session 37, verified end-to-end via the real
   scheduled cron. This panel had never had a successful write, ever, across at least 3 sessions of
   attempts — resolved by session 36's retry-storm fix AND this session's residential proxy BOTH
   being needed together.** Ran `node scripts/seed-climate-zone-normals.mjs`
   once more per this handoff's own suggestion (cooldown had elapsed). Trap hit first: a bare `node
   scripts/seed-climate-zone-normals.mjs` fails immediately with `Missing UPSTASH_REDIS_REST_URL or
   UPSTASH_REDIS_REST_TOKEN` — `loadEnvFile()` in `scripts/_seed-utils.mjs` only ever looks for
   `.env.local` (repo root, one level up, or `~/Documents/GitHub/worldmonitor/.env.local`), never
   `.env`, and this repo only has `.env`. Confirmed via memory (`local_redis_dev_stack.md`) this is
   already known: the correct invocation is `node --env-file=.env scripts/<script>.mjs`. Re-ran that
   way and watched it live end-to-end (well past the first live-test's partial-success point): **15/15
   batches failed on direct AND both proxy legs (CONNECT + curl) in pass 1**, then pass 2 started
   repeating the identical batch list from the top and failed the same way again — unanimous, not a
   fluke on a subset. This is the same "100%-blocked" signature the prior attempt saw, not the earlier
   ~50%-partial pattern that showed real convergence. Killed the process deliberately mid-pass-2
   (`kill <pid>`) rather than let it grind through all 4 configured passes against an
   already-confirmed-blocked endpoint — same "retrying more after a 429 makes it worse" lesson already
   on record from the GDELT investigation. No partial/corrupt write risk from the kill: the script only
   writes to Redis after all passes complete, so `climate:zone-normals:v1` is untouched, same absent
   state as before. **Conclusion: this is no longer a code problem.** The retry-storm bug fix (session
   36) is real, tested, and already committed — it is not what's blocking this. What's blocking it now
   is an external Open-Meteo block on this environment's egress (direct IP and both Decodo proxy pools)
   that isn't clearing with hours-scale cooldowns. Needs either a much longer cooldown (days, not
   hours) before the next attempt, or a genuinely different egress path — re-running the exact same
   script again on the same IPs is very unlikely to produce a different result and risks extending the
   block further.
   - **UPDATE, same session: the "genuinely different egress path" this needed now exists and works.**
     The residential Decodo proxy obtained for the GDELT check (see item 3 below) was tested directly
     against `archive-api.open-meteo.com/v1/archive` — 2 single, spaced requests at different
     coordinates, both clean **HTTP 200** — where the datacenter proxy (and direct) hit a 100% block
     on every leg. Not yet wired into `seed-climate-zone-normals.mjs` or run as a full seed — this was
     a raw connectivity check only, deliberately kept light (2 requests, not a batch) given the prior
     session's caution about hammering an already-blocked target. Holding off on wiring this in and
     running a full seed until the GDELT retest (item 3) resolves, so `PROXY_URL` gets one considered
     decision covering both use cases instead of two separate partial migrations.
   - **FINAL RESOLUTION, same session, confirmed via direct Redis read not just log lines**: after
     `PROXY_URL` was swapped to the residential credentials (item 4 below) and `ais-relay.cjs`/the
     dev stack restarted (operator's own terminal), the real scheduled `Bundle:climate` cron ran
     `Zone-Normals` live: an honest mixed picture at first (~8/11 batches succeeding via the proxy
     legs, matching real sustained-load conditions rather than my earlier 2-request manual sample),
     then session 36's retry-pass logic converged the rest — "retry pass 2/4: 2 zone(s) still
     missing" — down to a clean finish: `[Zone-Normals] Verified: data present in Redis`,
     `=== Done (327106ms) ===`. Confirmed directly: `climate:zone-normals:v1` present, 16205 bytes,
     `seed-meta` 23.5s fresh, `recordCount: 25`. **Then it cascaded automatically**: `Anomalies`
     (`seed-climate-anomalies.mjs`) runs immediately after `Zone-Normals` in the SAME
     `seed-bundle-climate.mjs` bundle — now that the baseline it hard-depends on existed, it
     succeeded too in the same run (`section=Anomalies status=OK durationMs=48905 records=17`).
     Confirmed directly: `climate:anomalies:v2` present, 3670 bytes, seed-meta 37.4s fresh. Whole
     bundle finished `ran:4 skipped:2 deferred:0 failed:0 graceful:0` — zero failures. Both the
     panel's own key and its hard upstream dependency are populated for the first time in this
     environment. Nothing further needed — this item is closed, not just improved.
3. **GDELT residential-proxy check — operator got a residential Decodo plan, tested live, result is
   MIXED — do not round up to "fixed."** `.env`'s existing `PROXY_URL` is a *datacenter* Decodo
   proxy (`dc.decodo.com`), documented as shared across 9 other seed scripts + `ais-relay.cjs` for
   its fixed-egress-IP property — deliberately did NOT overwrite it based on one inconclusive test.
   The new residential credentials (`us.decodo.com`, NOT yet written anywhere in this repo or
   `.env` — operator pasted them in chat, keep it that way, don't commit them) were verified
   directly: genuine residential ISP egress (confirmed via `https://ip.decodo.com/json` — a real
   ISP, not a datacenter host), and **sticky** (same IP across 3 separate requests) — same
   fixed-egress-IP behavioral contract as the current datacenter proxy, so a full `PROXY_URL` swap
   would not obviously break the other 9 consumers' IP-consistency assumptions IF this residential
   proxy turns out to actually help. Tested directly against `api.gdeltproject.org`: attempt 1 was a
   connection-level failure (`000`, not even an HTTP response), attempts 2–3 both returned `429`.
   Stopped testing further deliberately — matches the standing "retrying more after a 429 makes it
   worse" lesson from this project's own GDELT investigation; 3 rapid requests may simply have been
   too aggressive for GDELT's own tight per-IP threshold, not proof the residential IP itself is
   blocked. Unknown: whether this specific proxy plan is a *shared* residential pool (other Decodo
   customers' GDELT traffic through the same IP could already eat into the quota) or a
   dedicated/exclusive IP — operator couldn't immediately find that on the dashboard, not chased
   further. **Follow-up after a real cooldown (~30min elapsed, not immediate) — CONCLUSIVE, GDELT
   stays open.** One single retest, not a batch: another connection-level failure (`000`, curl exit
   28/timeout) — the exact same failure mode as attempt 1, not a 429 this time. Across the full
   session: 4 GDELT attempts total (2 rounds, real cooldown between), **0/4 clean**. In the same
   window, the identical residential proxy/IP got **2/2 clean HTTP 200** against
   `archive-api.open-meteo.com` (see item 2 above) — same egress, wildly different outcome. That
   asymmetry is the real signal: this isn't "needs more cooldown," GDELT specifically has a harder
   or more persistent problem than a datacenter-vs-residential distinction fixes. Stopping here
   rather than testing a target that's shown zero success across two separate rounds — matches the
   standing "retrying more after a 429 makes it worse" lesson. **Decision: did NOT swap `PROXY_URL`**
   (GDELT was the one motivating this) — but the residential credentials proved themselves
   independently valuable for Open-Meteo, so they're worth keeping for that even with GDELT
   unresolved. Next session: either accept GDELT stays blocked from this environment (defer to
   UCDP-only conflict coverage, already the documented fallback), or investigate GDELT's specific
   blocking mechanism directly (its own rate-limit documentation, contacting them, or a completely
   different provider) rather than more proxy/IP experimentation — that lever appears exhausted.
   **`PROXY_URL` SWAPPED to the residential credentials**, operator-approved, since GDELT was closed
   out but Open-Meteo proved the swap genuinely valuable: datacenter → residential in `.env`, old
   value kept commented directly above the new line for instant revert. Rationale in the `.env`
   comment itself. **Only Open-Meteo individually re-verified working post-swap** — the other 8
   `PROXY_URL` consumers (CanadaBuys, submarine-cables, Yahoo Finance, etc.) were reasoned to be
   likely neutral-to-positive (residential is sticky like the old datacenter proxy, generally more
   trusted by anti-bot systems) but NOT individually tested — watch for regressions. `ais-relay.cjs`
   needs restarting to pick this up (module-load-time env read via `_proxy-utils.cjs`, same class of
   trap as everything else this session) — operator said they'll handle that restart themselves, not
   done as of this commit. Nitric's scheduled seed scripts spawn fresh `node` children per run
   (`gcp/scheduler/main.ts`), so those pick up the new value automatically without a restart.
4. **Widen timeouts for canada-buys/OFAC — CanadaBuys FIXED session 37, verified live. OFAC
   remains genuinely not fixable this way, unchanged.** Session 36's "not a simple fix" verdict for
   CanadaBuys turned out to be about a constraint that doesn't actually apply here — worth re-reading
   before assuming a prior session's "not fixable" verdict is final:
   - The 180s figure session 36 cited as a "hard bundle ceiling" was actually just this ONE section's
     own `timeoutMs` in `scripts/seed-bundle-relay-backup.mjs` — independently adjustable, not shared
     with any other section, and the bundle itself has no `maxBundleMs` wall-clock budget opted in at
     all. The doc-comment reason that budget mechanism exists — "Railway cron SIGKILLs the container
     at 10min" — turned out to be moot for THIS bundle specifically: confirmed with the operator this
     session that nothing is deployed to Railway yet (local dev stage only), so there's currently no
     live 10-min ceiling to protect against.
   - Root cause of the 60s-per-attempt cap (in `fetchCanadaBuys()`, `scripts/seed-global-tenders.mjs`):
     it was sized to fit inside the old 180s section budget, not to the actual ~439s the 6MB CSV needs
     at this environment's VPN-bypassed ~14KB/s (session 36's measurement). No `maxRetries` count could
     ever have made 60s attempts succeed — every individual attempt was capped far below what one
     download needs, regardless of retry budget.
   - Fix: raised `fetchCanadaBuys()`'s per-attempt `timeoutMs` 60s→500s (covers the ~439s need with
     margin), kept `maxRetries: 1` (preserves `tests/global-tenders-transient-retry.test.mjs`'s tested,
     valuable fast-fail-transient-retry behavior — a socket reset or 408/503 fails and retries in
     milliseconds, unrelated to the slow-throughput case this timeout raise targets). True worst case
     is therefore two full 500s attempts + 1s backoff (~1001s), not one — raised the section's
     `timeoutMs` 180s→1_050_000ms and `seed-global-tenders.mjs`'s own `runSeed` `fetchPhaseTimeoutMs`
     (a SEPARATE inner ~240s-default deadline that would otherwise have silently undercut the outer
     raise, same stacked-timeout class as session 36's climate-zone-normals fix) explicitly to
     1_020_000ms, both sized with margin over that ~1001s true worst case.
   - Verified: all 45 tests across `global-tenders`, `list-global-tenders`, `global-tenders-transient-
     retry`, `global-tender-health`, `global-tender-sources`, `global-tenders-sam-rate-limit`,
     `seed-ttl-outlives-staleness-fleet` pass (an unrelated pre-existing `nixpacks-seeder-import-graph`
     failure about the `seed-research` bundle confirmed present on the unmodified baseline too).
     **Live**: an isolated `fetchCanadaBuys()` call against the real endpoint succeeded in 62.9s with
     100 real records parsed from the real CSV — notably, 62.9s is itself just over the OLD 60s cap,
     confirming that cap was too tight even on a good network moment, not only in the documented
     slow-throughput case.
   - **OFAC unchanged, still not fixable this way**: `seed-sanctions-pressure.mjs`'s ~120MB XML feed
     needs ~8.5h at this environment's VPN-bypassed ~4KB/s (session 36's measurement, essentially the
     pre-bypass baseline — the bypass barely helped this specific host). No timeout value closes an
     8.5-hour gap; this needs genuinely faster network access, which isn't available from this
     environment. Not attempted this session.
5. **LaunchDaemon persistence for the VPN bypass routes — DONE session 37, operator-installed and
   live.** Checked current routing state before proposing anything: 4 of the 7 session-35 bypass
   hosts (`www.contractsfinder.service.gov.uk`, `www.submarinecablemap.com`,
   `archive-api.open-meteo.com`, `canadabuys.canada.ca`) were routing via `en0` (bypass active) but
   with NO persistence — only FIRMS had a LaunchDaemon (`com.worldmonitor.firms-vpn-bypass`, session
   32). Those 4 routes were almost certainly added by hand during live testing and would have
   silently reverted to the slow `utun8` VPN path on the next reboot or VPN reconnect. OFAC
   (`treasury.gov`) deliberately excluded — still on `utun8` (never bypassed), and even bypassed
   only reaches 4KB/s, nowhere near its 8.5h need, so persisting it buys nothing. GDELT excluded —
   session 35's bypass test was a clean negative, already ruled out.
   - Found while building the plist: `www.contractsfinder.service.gov.uk` resolved to two
     DIFFERENT IPs a few minutes apart (`3.9.218.171` then `18.175.36.151`, both already present as
     separate routes in the live table) — genuinely multi-IP/rotating AWS ELB backend, not a fluke.
     A naive single-IP-per-tick daemon would leave gaps as DNS round-robins. Designed the script to
     resolve and route EVERY currently-returned A record per host on each 60s tick, not just one
     (`for IP in $(dig +short "$HOST" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')`).
   - Kept as a SEPARATE new daemon (`com.worldmonitor.seed-hosts-vpn-bypass`), not merged into the
     existing FIRMS one — easier to audit/revert independently, same reasoning as the existing
     `.env` revert-marker convention elsewhere in this project.
   - Operator installed and confirmed live: `sudo launchctl list | grep seed-hosts` shows exit
     status `0` (last run succeeded); all 5 known target IPs (both contracts-finder ELB addresses
     included) confirmed present in `netstat -rn -f inet` after install.
   - **Delete-and-observe verification — DONE, matches the FIRMS precedent.** Operator ran `sudo
     route delete -host 40.82.191.205` (CanadaBuys), waited past one 60s tick, then `route get
     canadabuys.canada.ca` showed `interface: en0` again (not `utun8`) — the daemon re-added the
     deleted route on its own, unattended. Full parity with FIRMS's own "self-heal verified by
     delete-and-observe" record now achieved for this daemon too.
6. **`riskScores`' staleness — FIXED session 37, verified live. Session 35's "warm-ping/cache-TTL
   mismatch" diagnosis was a plausible theory but NOT the actual root cause** — corrected here so a
   future session doesn't re-chase the TTL-race explanation. Traced the real mechanism end-to-end
   with live evidence rather than re-deriving from code alone:
   - Empirically confirmed first: `seed-meta:intelligence:risk-scores` was **8710 min (~6 days)
     stale**, while `ais-relay.cjs`'s CII warm-ping was firing cleanly every 8 min and logging
     `[CII] Warm-ping OK: 31 scores` every single time — and BOTH the live cache key
     (`risk:scores:sebuf:v8`) and the 1h stale-fallback key (`risk:scores:sebuf:stale:v8`) had TTL
     `-2` (never existed), not just expired. That "31 scores, always" was the tell: 31 is exactly
     `TIER1_COUNTRIES`'s count, matching `getRiskScores`'s FINAL degraded fallback
     (`computeCIIScores([], emptyAuxiliarySources())`) rather than a real computed or cached result.
   - Root cause: `server/worldmonitor/intelligence/v1/get-risk-scores.ts`'s `fetchACLEDEvents()`
     called `fetchAcledCached()` twice via `Promise.all` with **no try/catch**, unlike every other
     source in `fetchAuxiliarySources()` (all individually `.catch(() => null)`-wrapped). ACLED is
     blocked on this environment's account tier (session 32's finding, unchanged) — confirmed live:
     OAuth token exchange succeeds (200), but the actual data-read call returns
     **`403 {"message":"Access denied"}`**. `fetchAcledCached`'s inner `cachedFetchJson` call
     re-throws on any non-2xx upstream response, and with no catch above it, that exception
     propagated straight through `buildRiskScoresPayload()`'s `Promise.all`, rejecting the ENTIRE
     risk-scores computation on every single call — live traffic and warm-ping alike. `getRiskScores`'s
     outer catch then fell through to the stale-cache check, which was also always empty, landing on
     the final all-zero baseline every time — a path that never reaches `persistFreshRiskScorePayload`,
     so `seed-meta` and both cache keys could never be written. The existing code comment on
     `fetchACLEDEvents()` already assumed graceful `[]`-on-failure was happening ("fetchAcledCached
     returns [] both when ACLED auth is unconfigured AND on upstream failure") — that assumption was
     simply wrong for the "upstream failure" half; only the "unconfigured" half short-circuits before
     ever throwing.
   - Fix: wrapped both `fetchAcledCached()` calls in `fetchACLEDEvents()` with `.catch()`, matching
     the pattern already used everywhere else — restores the graceful degradation the comment assumed.
     Deliberately did NOT touch the cache-TTL/warm-ping tuning code PR #3562 carefully set up (session
     35's caution about that code was well-founded, it's just not what was broken).
   - Verified: 124 tests pass across `cii-scoring`, `seed-health-risk-scores`, `ttl-acled-ais-guards`,
     `frontend-cii-source-of-truth` (zero new failures — 2 pre-existing failures in
     `relay-warm-ping-auth.test.mts` confirmed present on the unmodified baseline too, unrelated to
     this change). **Live end-to-end verification**: an isolated `tsx --env-file=.env` invocation of
     `getRiskScores()` against the real Redis produced `degraded: false, stale: false`, all 31 scores
     with real non-zero `combinedScore` values, and confirmed writes — `seed-meta` `fetchedAt` 12s old
     (`recordCount: 3`), live cache TTL 588s, stale-fallback TTL 3588s (both matching their configured
     600s/3600s TTLs on a fresh write).
   - **One loose end, not a code bug**: hitting the RPC through the browser-facing local dev server
     (vite pid 41694, the 4+ day orphan already flagged in session 36's memory) returns the same
     correct non-degraded response but does NOT persist to the real Redis — almost certainly the same
     "process holds env from before a `.env` edit" trap this session hit repeatedly elsewhere (chat-
     analyst, ais-relay, digest cron), not investigated further since it required restarting an
     operator-visible process without being asked to. If the dashboard's Strategic Posture panel still
     looks stale after this fix, restarting that vite process (or however local dev is normally
     restarted) is the next step — the underlying computation is confirmed correct.
   - **UPDATE, session 38 — found the REAL cause of the VS Code panel specifically showing degraded
     data (flat `combinedScore: 60`, `advisoryProvenance: "fallback"` for every country) while a
     real browser tab showed correct varied scores; corrects the "restart vite" guess above.** The
     VS Code sidecar (`vscode-extension/sidecar/local-api-server.mjs`) does NOT proxy `/api/*` to
     nitric or vite at all when `cloudFallback: false` (confirmed live via its own
     `/api/local-status` endpoint) — it dynamically `import()`s a handler module directly from
     `api/intelligence/v1/[rpc].js`, a **separate pre-bundled esbuild artifact**, distinct from the
     `.ts` source and from the frontend's `dist/` build. Found `[rpc].js` was dated Aug 22 22:37 —
     a full day before this session's ACLED-catch fix (which lives only in `server/` source) —
     because `npm run build:sidecar-handlers` (the dedicated script that bundles `server/**` into
     every `api/**/[rpc].js`) is a THIRD build step, separate from both `npm run build` (frontend
     `dist/`, session 37/38's CORS fix) and nitric's live process (which reads `server/` source
     directly, no bundling needed). Ran `node scripts/build-sidecar-handlers.mjs` (51 entry points,
     ~24MB) — confirmed the fresh `[rpc].js` now has `.catch()` wrapped around both
     `fetchAcledCached()` calls, matching the source fix. Also confirmed `local-api-server.mjs`
     caches imported modules in a plain in-process `Map` with **no mtime invalidation** — a rebuild
     alone doesn't take effect on an already-running sidecar process; needs a restart (a VS Code
     window reload, already independently needed for the CORS fix, does this — confirmed by
     observing the sidecar's PID change across an earlier reload this session). **Lesson for next
     time, generalizes beyond just this panel**: any backend fix in `server/` is NOT live in the VS
     Code embed until BOTH `npm run build` (frontend) AND `npm run build:sidecar-handlers` (backend
     RPC bundles) are re-run — two independent build artifacts, easy to remember only one. Since this
     rebuild covered all 51 sidecar handler entry points, not just intelligence/risk-scores, it may
     also silently fix other panels' staleness in the VS Code embed specifically — worth a broader
     spot-check next time the embed is open, not assumed.
7. **`consumerPrices*` (5 keys) — SCOPED session 37 (while waiting on the GDELT cooldown), the
   "needs new infra" note carried since session 35 was under-specified and one part of it is
   flatly wrong.** `consumer-prices-core/` is not a from-scratch project — it's a complete, mature
   microservice already in this repo: 10 markets (AE/AU/BR/CH/GB/IN/KE/SA/SG/US), 25 retailer
   scrapers, 9 Postgres migrations, a Fastify API server, a scrape→aggregate→publish job pipeline,
   and a real product-pinning stability plan already at "Rev 3." It's unused only because its
   runtime dependencies were never provisioned, not because it needs building.
   **Correction: no second Redis client is actually needed** — grepped `consumer-prices-core/src/`
   directly for `REDIS_URL`/`createClient`, zero hits anywhere in the source despite `.env.example`
   listing `REDIS_URL` and `redis` being a `package.json` dependency (vestigial/unused, not wired
   to anything). `src/jobs/publish.ts` — the actual handoff point to WorldMonitor — writes directly
   via the Upstash REST API (its own `upstashCommand()` helper, `Authorization: Bearer` calls) using
   the SAME Upstash instance the rest of the fork already uses, with its own inlined seed-envelope
   shape mirrored from `scripts/_seed-envelope-source.mjs`. This claim should have been verified
   against the code the first time it was written, not carried forward on assumption.
   **What's actually still needed to go live**: (1) a real Postgres instance (`DATABASE_URL`) — the
   one genuine infra gap; (2) one acquisition provider API key — Firecrawl, Exa, or Parallel P0 (the
   code supports all three; the stability plan's primary flow is Exa search → Firecrawl scrape); (3)
   `WORLDMONITOR_SNAPSHOT_API_KEY`, a shared secret, trivial to generate; (4) running the 9
   migrations (`npm run migrate` inside `consumer-prices-core/`); (5) a host to actually run the job
   pipeline — the Dockerfile is built for Railway specifically (real outage-tolerance engineering in
   its `apt-get` steps, not a stub), matching this project's original design, but Railway isn't
   live per this session's confirmation — would need either provisioning Railway specifically for
   this one service, wiring into the still-scaffold GCP/Nitric setup, or a local-dev-only loop
   wrapper (same pattern as the digest-cron fix, session 36) for local visibility only.
   **UPDATE, same session — operator had Postgres AND both API keys already: schema + migrations
   DONE.** Operator confirmed Postgres is already available (the same Supabase project already
   backing `worldmonitor`'s own schema, `ixuezudybhjptisexgxx`) and `FIRECRAWL_API_KEY`/`EXA_API_KEYS`
   were already in `.env`. Two of the three "genuine gaps" above were already solved, not new work.
   - Inspected the Supabase project first via MCP tools before touching anything: this project is
     genuinely shared across multiple unrelated apps (an OKR/meta-aggregator/BPMN system's own
     migration history sits alongside `worldmonitor`'s `_stage1/2/3` migrations) — confirmed a
     dedicated new schema was the right call, not reusing `worldmonitor` (scoped to user auth/prefs)
     or `public` (crowded with the unrelated app, 38 tables).
   - Read all 9 migration files in full before running any of them (one is literally named
     "drop_unused_schema" — checked it only touches this same schema's own table/column, not an
     external reference). Created a new `consumer_prices` schema, applied all 9 migrations in order
     via direct SQL (`SET search_path TO consumer_prices, public, extensions;` per migration, since
     they create tables unqualified), and manually populated `consumer_prices.schema_migrations`
     with each version as applied — replicates `src/db/migrate.ts`'s own bookkeeping exactly, so a
     LATER real `npm run migrate` (once `DATABASE_URL` is wired up) correctly sees all 9 as already
     applied and skips them, rather than re-running and erroring on already-existing tables.
   - Verified via `list_tables`: all 12 expected tables present, `schema_migrations` = 9 rows,
     `baskets` = 10 (all markets), `canonical_products` = 75 (deduped across markets),
     `basket_items` = 119, everything else correctly empty (no scraping has happened).
   - **RLS advisory surfaced twice this session, both times per the tool's own requirement, not
     silently decided**: (1) 38 pre-existing tables in this project's `public` schema — an unrelated
     app, not touched, operator said not their concern right now; (2) the 12 new `consumer_prices`
     tables also have RLS disabled — lower practical risk since this schema isn't registered as
     PostgREST-exposed (unlike `worldmonitor`), so the anon/authenticated API keys can't reach it via
     Supabase's REST layer the way `public`'s tables can — operator confirmed not a concern for now,
     revisit if this schema is ever exposed that way.
   - Created `consumer-prices-core/.env` (gitignored, confirmed via `git check-ignore`): copied
     `FIRECRAWL_API_KEY`/`EXA_API_KEYS` from the main `.env`, generated a fresh
     `WORLDMONITOR_SNAPSHOT_API_KEY` (`node crypto.randomBytes(32)`), left `DATABASE_URL` and
     `REDIS_URL` blank (the latter deliberately — see the correction above, nothing reads it).
     Added the matching `CONSUMER_PRICES_CORE_API_KEY` to the main repo's `.env` too (same value).
     Also caught a second stale-note issue while there: the main `.env.example`'s own top-level
     `DATABASE_URL` entry is ALSO vestigial — grepped the whole repo outside `consumer-prices-core/`
     for `process.env.DATABASE_URL`, zero hits; didn't add it to the main `.env`.
   - **What's still genuinely missing, deliberately not done**: (1) `DATABASE_URL` itself — needs the
     operator to pull it from the Supabase dashboard (Project Settings → Database → Connection
     String, Session pooler or Direct connection mode, NOT Transaction pooler — `pg.Pool`'s
     multi-statement transactions break under PgBouncer transaction mode) and add it to
     `consumer-prices-core/.env`; (2) the hosting decision for the job pipeline (Railway
     specifically, GCP/Nitric, or a local-dev loop wrapper) — genuinely unresolved, not attempted;
     (3) no scraping has been run — real Firecrawl/Exa costs, deliberately out of this session's
     agreed scope ("schema + migrations only, stop there").
   - **UPDATE, session 38 — `DATABASE_URL` wired and the real pg connection verified live, but hit
     and fixed a real incident along the way, not a clean pass.** Operator supplied both Supabase
     pooler connection strings (Session pooler port 5432, Transaction pooler port 6543). Wired the
     Session pooler one into `consumer-prices-core/.env` per this file's own pre-existing warning
     above. Found `consumer-prices-core/` had **never had `npm install` run** — no `node_modules` at
     all, unrelated to `DATABASE_URL` and not previously flagged; fixed (`npm install`, 208 packages).
     First `npm run migrate` attempt failed with a 5s connection timeout — raw TCP to the pooler
     host connects in ~0.4s (confirmed via `nc`), so this wasn't a reachability/VPN-throttle issue
     like the other 7 hosts, just `client.ts`'s `connectionTimeoutMillis: 5_000` being too tight for
     the full TLS+auth handshake through the pooler; raised to 20s, connected fine.
     **Real incident**: `migrate.ts`'s SQL migrations use unqualified `CREATE TABLE retailers` (never
     `consumer_prices.retailers`), relying entirely on the connection's default `search_path`.
     Session 37's manual migration via the Supabase MCP tool explicitly set
     `search_path=consumer_prices` per statement; `client.ts` never sets one and neither pooler URL
     does either — so the first real `npm run migrate` run silently created a **complete duplicate
     set of all 12 consumer-prices tables in the shared `public` schema** (same schema with the
     unrelated 38-table app session 37 deliberately avoided), all with RLS disabled and, unlike
     `consumer_prices`, actually PostgREST-exposed to the anon/authenticated Supabase API keys —
     confirmed via `list_tables` immediately after. Caught before doing anything further; operator
     approved cleanup. Fixed both the symptom and the cause: dropped all 12 stray `public.*` tables
     (verified `public` back to its original 38-table baseline, `consumer_prices` untouched, same
     9/9 migrations and 75/10/119 row counts as before), and added `options: '-c
     search_path=consumer_prices'` to the `Pool` config in `client.ts` so this can't recur regardless
     of which connection string is used later. Re-ran `npm run migrate` after the fix: clean `[skip]`
     on all 9, confirming it now correctly resolves against `consumer_prices` — the connection itself
     is genuinely proven working end-to-end, not just reasoned about. Lesson for next time: a
     migration/query layer relying on implicit `search_path` needs that pinned at the connection
     layer, not just gotten right once via a manual admin tool — the two paths (MCP admin query vs.
     the app's own pool) don't share that state. Still genuinely open, unchanged: the hosting
     decision for the job pipeline, and no scraping run yet (out of scope, real API costs).

---

## 🔀 HANDOFF (2026-08-22→23, THIRTY-FIFTH session end) — superseded by the thirty-sixth block above

**Scope**: picked up the thirty-fourth session's scoped "seed/sync reliability sweep" NEXT
INITIATIVE. Verified the handoff was actually clean first (git tree matched exactly, dev-stack
processes all alive, health baseline unchanged) before starting — no leftover cleanup needed.

### Fixed and committed (`83e86a0`, not pushed)

1. **`globalTendersCanadaBuys`/`ContractsFinder`** — `scripts/seed-global-tenders.mjs` was a
   genuine orphan: never in `scripts/railway-services.json` OR `gcp/scheduler/main.ts`'s CADENCES
   map, missed entirely by the thirty-second session's own orphan sweep. Registered it (hourly,
   matching its own `CACHE_TTL_SECONDS` comment) in both files.
2. **`wildfires`/`wildfiresBootstrap`** — real bug, not a registration gap. During active
   Siberian/Russian wildfire season the raw combined VIIRS feed (Russia's monitored bbox spans
   nearly the whole country) grew past 100k detections → 13MB serialized, blowing
   `_seed-utils.mjs`'s 5MB per-key write guard every single run. The bootstrap extraKey already
   used `compactWildfireDashboardPayload` (500-record priority sort: explosion > confidence >
   brightness > FRP > recency) but the canonical key's write never did. Applied the same transform
   via `publishTransform`. Verified live: 500 records, 130KB, `state: OK`.

### Fixed via one-time manual backfill (data only, no code change needed)

- **`resilienceStaticFao`/`resilienceStaticIndex`** — correctly registered (90-day interval in
  `gcp/scheduler/main.ts`), just never backfilled locally — "registration ≠ backfill," the exact
  trap the thirty-second session's memory already named (a 90-day local-nitric-uptime interval
  essentially never elapses given how often this dev environment restarts). Hand-ran
  `seed-bundle-resilience.mjs`; verified `status: ok`, 196 countries, FAO aggregate 43 countries.
- **`military:bases`** (not on the original crit list, found as a bonus while backfilling the
  static-ref bundle) — same story, backfilled successfully, 1,058 entries.

### Root-caused, six upstream hosts confirmed VPN-throttled — needs the OPERATOR'S own terminal

Diagnosed via the `local-network-optimizer` skill (Shape A: VPN is the slow path, same class as
session 32's FIRMS fix). **`contractsfinder.service.gov.uk`, `canadabuys.canada.ca`,
`sanctionslistservice.ofac.treas.gov` (OFAC), `archive-api.open-meteo.com`, `comtrade.un.org`, and
`submarinecablemap.com`** all route through `utun8` and get throttled to ~6KB/s on response-BODY
transfer specifically (headers/connect are fine, the body stream stalls) — confirmed empirically
with paired Node `fetch()` timing tests, not guessed. Cloudflare through the *same* tunnel gets
~300KB/s, ruling out a VPN-wide problem. This explains, in one shared root cause:
`globalTendersCanadaBuys`/`ContractsFinder` (per-source, registration fix above doesn't help until
this is fixed too), `sanctionsPressure`/`sanctionsEntities` (OFAC — **not** ACLED-related, verified
by reading the script; the original handoff's caution to double-check rather than assume was
correct), `climateZoneNormals`/`climateAnomalies` (Open-Meteo; Anomalies cascades from
Zone-Normals' baseline dependency), `comtradeBilateralHs4`, `submarineCables`.

I can't run `sudo route add` myself (no passwordless sudo in this environment — confirmed, not
assumed). **Ready-to-run script**: `/private/tmp/claude-502/-Users-john-Documents-CODE-worldmonitor/69766dc5-50f8-448b-923f-67e4357dfde6/scratchpad/vpn-bypass-seed-sources.sh`
(session-scratchpad path — copy out if it needs to survive past this session) — resolves current
IPs for all six hosts, tests a live bypass via the physical gateway, re-checks speed, and lists the
seeders to re-run afterward. Ask for the persistent-LaunchDaemon variant (matching
`com.worldmonitor.firms-vpn-bypass`) once the live test is confirmed working.

**`seed-comtrade-bilateral-hs4.mjs` specifically**: doesn't use the shared `runSeed()` wrapper (no
lock/deadline machinery), so a VPN-throttled run has no bounded ceiling — it was killed after
~13min rather than left to retry indefinitely. Root cause (same VPN throttle) confirmed via routing
check before killing, not guessed.

### Explained, not bugs — credential/infra/policy gaps (flagged, not implemented unprompted)

- **`consumerPrices{Overview,Categories,Movers,Spread,Freshness}`** — the entire
  `consumer-prices-core` microservice was never provisioned in this environment: no Postgres
  (`DATABASE_URL` unset, 9 pending migrations), no `CONSUMER_PRICES_CORE_BASE_URL`, no running
  process, absent from `nitric.yaml`. The manual fallback seeder
  (`scripts/seed-consumer-prices.mjs`) even prints "writing empty placeholders" by design when
  unconfigured. Standing it up needs a new Postgres instance + Playwright-based scraping + a second
  Redis client (raw RESP, not the HTTP-REST shim the rest of the fork uses) — new infra, not a
  sweep-scope fix.
- **`socialVelocity`/`wsbTickers`** — Reddit's 2026 policy blocks the unauthenticated public
  endpoint (already proven false-safe against proxy/UA changes, per the code's own comment); the
  one working fallback (ScrapeCreators) needs `SCRAPECREATORS_API_KEY`, absent from `.env`
  entirely, not even as an empty placeholder.
- **`telegramFeed`** — needs a real Telegram MTProto login session
  (`TELEGRAM_API_ID`/`_API_HASH`/`_SESSION`, via `node scripts/telegram/session-auth.mjs`), never
  set up.

### Found, deliberately NOT patched — needs a deliberate next-session fix

- **`riskScores`** — subtle bug, confirmed empirically: `ais-relay.cjs`'s CII warm-ping runs every
  8 minutes, but the RPC's own cache TTL (`get-risk-scores.ts`) is 10 minutes. Since 8 < 10, the
  warm-ping's own frequent hits keep the cache perpetually warm, so the "genuine fresh compute,
  leader" branch that writes `seed-meta:intelligence:risk-scores` essentially never fires — the
  warm-ping's *success* at keeping the cache warm is exactly what starves the health heartbeat.
  Verified live: a fresh manual RPC call returned valid current CII data but did NOT update the
  seed-meta timestamp (stuck 5+ days old). Not patched this session — touches shared caching code
  (`cachedFetchJsonWithMeta`) a prior PR (#3562) already carefully tuned; a rushed fix risks
  re-breaking that tuning. Fix direction: either have the warm-ping periodically force a real
  cache-bypass call, or decouple `riskScores`' staleness classification from the fresh-vs-cache
  distinction specifically.

### Continued later same session — 3 more fixes, VPN bypass live-tested with real (partial) results

**`api/chat-analyst.ts` — DIRECT_LLM_DAILY_QUOTA_LIMIT=unlimited was silently blocking EVERY call**
(commit `4153ff4`). Live bug report from the operator: `429` on `/api/chat-analyst`. Root cause:
`.env`'s `DIRECT_LLM_DAILY_QUOTA_LIMIT=unlimited` resolves to `0` (the documented "disable the
quota" sentinel per `direct-llm-quota.ts`'s own doc comment). `server/gateway.ts` correctly guards
its own quota reservation with a `DIRECT_LLM_QUOTA_DISABLED` check for its 5 gateway-routed
endpoints — but `chat-analyst.ts` is the one "self-metered" route (`DIRECT_LLM_SELF_METERED_QUOTA_PATHS`)
that bypasses `gateway.ts` entirely and never got the same guard. `reserveDirectLlmQuota`'s check
is `newCount > DIRECT_LLM_DAILY_QUOTA_LIMIT` i.e. `newCount > 0` — true on the very first call,
forever, since Redis `INCR` always returns >= 1. Fixed by adding the missing guard, matching
`gateway.ts`'s exact pattern. Restarted `nitric start --ci` (module caching means a running process
wouldn't pick up the source edit) and ran `npm run build:sidecar-handlers` (the VS Code extension's
sidecar serves a separate esbuild bundle of this same file) so the fix is live on both paths.
**Confirmed fixed by the operator** ("good, it worked").

**VPN bypass script live-tested by the operator** — real, partial results, not a clean win:

| Host | Before | After | Verdict |
|---|---|---|---|
| contractsfinder | ~6KB/s | 27KB/s | fixed — `contracts-finder` source now `sourceState: ok` |
| canadabuys | ~6KB/s | 14KB/s | still fails — needs ~6MB in 60s budget, not enough |
| OFAC | ~6KB/s | 4KB/s | still fails, barely moved |
| submarinecable | ~6KB/s | 7KB/s | still fails (confirmed via seed-meta, not just exit code) |
| GDELT | 429 | still 429 | **bypass did NOT help — confirmed NOT an IP-sharing issue** |

`globalTendersContractsFinder` is now genuinely fixed (verified via the actual per-source
`seed-meta:economic:global-tenders:contracts-finder` key, not the seeder's misleading top-level
"state: OK" — same trap as before). `globalTendersCanadaBuys`, `sanctionsPressure`/`Entities`, and
`submarineCables` are now a **timeout-budget mismatch**, not a total-failure — the network is
faster than before, just not fast enough for their existing per-attempt timeouts. Widening those
timeouts (a real, scoped code change, not yet done) is the next lever, separate from the VPN fix
itself. LaunchDaemon persistence for the routes was NOT set up yet — operator hasn't confirmed they
want it yet, pending the timeout-widening discussion.

**`scripts/seed-gdelt-intel.mjs` — direct retries were starving the proxy leg's budget** (commit
`dec48a3`, the "实时情报" panel). `fetchTopicArticles` called `fetchGdeltJson` with all defaults
(`maxRetries: 3` → 4 direct attempts). Direct's own worst case (4×15s + 60s backoff = 120s) was
eating most of the 150s soft budget before the proxy leg — where the actual chance of success lives
(Decodo's session-rotating egress) — got its full 5-attempt allowance. Observed live: only 3/5
proxy attempts ran before the soft budget cut it off. Fixed: trimmed `maxRetries` to 1 for this
call site only (GDELT's throttle window is documented as wide, so a 2nd-4th direct attempt within
30-60s rarely lands in a cleared window anyway — mostly wasted budget). New worst case: 135s,
inside the 150s budget with room for a 2nd topic. **Verified this genuinely works as designed**: a
live re-run got the full 5/5 proxy attempts (vs 3/5 before) — but all 5 still failed (2 timeouts,
3× 429), 0/5 vs the documented historical ~40%/attempt (~2/5 expected). All 17
gdelt-intel/fetch-deadline-budget tests pass unchanged (they mock the fetch dependency, don't
exercise this code path).

**Real lead, not yet actioned — needs the operator's Decodo account**: the configured `PROXY_URL`
in `.env` is Decodo's **datacenter** endpoint (`dc.decodo.com`). Datacenter IP ranges are exactly
what scraping-sensitive public APIs like GDELT blocklist hardest — very plausibly why the proxy leg
is now failing far worse than its own documented ~40%/attempt historical measurement (from
2026-04-16, 4+ months stale). If Decodo's plan includes a **residential** endpoint, swapping to it
would likely help far more than any retry-budget tuning can. Needs the operator to check their
Decodo dashboard — not something checkable from this environment.

### Final continuation (2026-08-23) — GDELT cross-process rate gate, then handed off

**`scripts/_gdelt-fetch.mjs` + `scripts/seed-unrest-events.mjs` — distributed rate gate across
every GDELT caller** (commit `e4b1326`). Root cause dug further than the earlier per-seeder budget
fix: at least 4 independent processes hit `api.gdeltproject.org` with zero awareness of each other
(`seed-gdelt-intel`/`seed-conflict-intel`/`seed-recall-benchmark` via `fetchGdeltJson`, plus
`seed-unrest-events` via its own separate v1 GKG fetch) — and `seed-conflict-intel.mjs`'s own
country loop fires **4 requests concurrently** (`Promise.all`, `CONCURRENCY=4`) with only 500ms
between batches, already exceeding GDELT's stated ≤1-request/5s guidance on every batch, by itself.
A real GDELT-wide storm was diagnosed 2026-07-13 (`#5256`) and mitigated with a circuit breaker
after the fact, but the over-rate firing pattern that plausibly triggers these storms was never
fixed. Added `acquireGdeltRateSlot()` reusing the existing `acquireLock()` SET-NX-PX primitive —
every real network attempt across every GDELT-calling file now claims a slot from one shared
Redis-backed gate (`seed-lock:gdelt:rate-gate`, 5.5s window) before firing. Concurrent callers,
even a `Promise.all` burst, naturally serialize to one winner per window — no caller's own
concurrency needed restructuring. Fails OPEN on Redis errors. All 111 tests across the GDELT test
suite pass (7 needed a `_acquireGdeltRateSlot` test-seam fix — the real gate's Redis call was
consuming `globalThis.fetch` mocks meant to simulate GDELT responses).

**Verified live, not assumed**: ran `seed-gdelt-intel.mjs` and `seed-conflict-intel.mjs`
concurrently. Mixed but real result — `gdelt-intel`'s own article-search still got fully blocked
(GDELT/Decodo proxy pool is severely throttled today, 0/5 to 0/8 across everything tested this
session), but `conflict-intel`'s GDELT-derived humanitarian data for 32 countries **succeeded**
running at the same time — confirmed via a direct Redis read of fresh, real content (Ukraine: 6
events, 13 fatalities, correctly timestamped), not just a clean exit code. The gate demonstrably
works and lets real traffic through without crashing anything; it cannot force GDELT to stop
blocking a request pattern that's structurally sound now but was never the sole cause of today's
severity.

### 🔭 STILL OPEN — handed off, pick this up first

Health at hand-off (2026-08-23): 232 total, 183 ok, 15 warn, 10 onDemandWarn, 0 staleContent, 24
crit — re-fetch `/api/health?compact=1` rather than trusting this number, it drifts hour to hour
(every prior session's note on this still holds).

1. **GDELT residential-proxy check** — the one concrete lead left on GDELT's persistent 429s.
   Configured `PROXY_URL` in `.env` is Decodo's **datacenter** endpoint (`dc.decodo.com`);
   datacenter IP ranges are exactly what scraping-sensitive APIs like GDELT blocklist hardest.
   Needs the operator to check their Decodo dashboard for a residential option — not checkable from
   this environment. If they have one, swapping `PROXY_URL` would likely help far more than any
   further retry/pacing work (which is now about as tuned as this session could take it — see the
   rate-gate above).
2. **Widen the per-attempt timeout** for `canada-buys`/OFAC/`submarine-cables` — the operator's VPN
   bypass script (session scratchpad, see the VPN-bypass section above) made these hosts genuinely
   faster (contracts-finder went from ~6KB/s to 27KB/s and is now fully fixed) but not fast enough
   to clear their existing per-attempt timeouts for the larger-payload sources. Discussed with the
   operator, not yet implemented — needs picking concrete new timeout values, flagged rather than
   silently decided last time it came up.
3. **Decide on LaunchDaemon persistence for the VPN bypass routes** — live-tested and working
   (partially — see above), but NOT persisted. The routes will not survive a reboot/VPN reconnect
   on their own. Matches the existing `com.worldmonitor.firms-vpn-bypass` pattern from session 32
   if the operator wants it.
4. **`riskScores`' warm-ping/cache-TTL mismatch** — confirmed live (a fresh manual RPC call
   returned valid data but did not update the seed-meta timestamp, stuck 5+ days old). Needs a
   deliberate fix to shared caching code (`cachedFetchJsonWithMeta`, a prior PR already carefully
   tuned this exact tradeoff) — not a quick patch, was deliberately left alone this session.
5. **`consumerPrices*` (5 keys)** — needs new infra (Postgres + Playwright scraping + a second
   Redis client), an operator decision, not a code fix. Not touched.
6. Everything else from the original crit-candidate list not mentioned above was resolved this
   session — see the full item-by-item record further up this block before re-diagnosing anything
   that looks unexplained; check here first.

**Session ends here — user explicitly requested handoff to the next session's agent.** Git tree is
clean, 19 commits ahead of `origin/main`, 0 pushed (operator's standing manual-push discipline).
Dev-stack processes confirmed alive at hand-off: `nitric start --ci` (pid 2095), two
`clean-nitric-history.mjs` copies (harmless known duplicate), `ais-relay.cjs` (pid 9874), VS Code
extension's own sidecar (pid 71417) — don't assume any of these PIDs are still current by the time
this is picked up, re-`ps` first.

---

## 🔀 HANDOFF (2026-08-22, THIRTY-FOURTH session end) — superseded by the thirty-fifth block above

**Scope**: closed all three open items from the thirty-third session's handoff (below), then chased a
live bug report ("several VS Code dashboard panels stuck loading forever") through **four** independent
root causes across two repos: an unguarded service worker (Part 2), a cross-repo duplicate-Supabase-
account bug (Part 3), external links doing nothing on click (Part 4), and — the highest-impact one —
`AbortSignal.timeout()` being silently ineffective sidecar-wide, which had been quietly undermining
every upstream call's own timeout bound, not just the one symptom that surfaced it (Part 5).
**Important standing correction**: earlier sessions'
memory framed this fork as single-operator/dev-stage/low-stakes — operator corrected this explicitly:
it is distributed as a **private GitHub release that multiple internal operators each install on their
own machine** — not public SaaS, but not single-user either. Re-evaluate "low priority, only affects
me" reasoning on any future finding against this corrected model.

### Part 1 — thirty-third session's three open items, all closed

| # | Item | Resolution |
|---|---|---|
| 1 | `/api/health` 503 | Fixed: `redisPipeline()`'s tauri-sidecar branch now falls through to live Redis for non-GET commands when creds exist. Verified live, 503→200. `4373bc0` |
| 2 | `BRIEF_URL_SIGNING_SECRET` rotation | Rotated in `.env` (local-only, gitignored) per its own "Normal roll" runbook. `571cc0b` |
| 3 | 6 third-party key rotations | Researched — no self-service API path exists for any of them (all dashboard-only). **Operator explicitly declined** rotating them: dev-stage credentials, not worth the manual cost right now. `bab5e5b`, `fd6aeaa` |

### Part 2 — VS Code extension: unguarded service worker registration (repo-local, fixed)

**Symptom**: six+ dashboard panels (commodities, energy-complex, markets, trade-policy, Premium Stock
Analysis, Premium Backtesting) stuck on an infinite loading spinner, zero console output — not an
error, an absence. Network tab showed every request duplicated (page fetch + a `workbox-*.js`
service-worker-intercepted copy), several stuck at `(pending)` forever on both copies, one response
served with `access-control-allow-origin: tauri://localhost` baked in from a completely different
context.

**Root cause**: `src/main.ts`'s service-worker registration guard only excluded the real Tauri desktop
app (`__TAURI_INTERNALS__`/`__TAURI__` globals). The VS Code extension's embedded iframe has neither,
so it fell through and registered a full production PWA service worker — designed for a real
top-level browser tab — inside a nested webview iframe, where its fetch-interception/caching
lifecycle visibly misbehaves.

**Fix**: extended the guard with the already-existing `isVsCodeEmbedRuntime()` helper (was already
used elsewhere for this exact kind of gating, just never wired into this one call site). Added a
self-heal block for sessions that registered a SW before this fix existed: on next load, if the VS
Code embed finds an existing registration, unregisters it + clears Cache Storage + reloads once.
Rebuilt (`APP_DOMAIN=worldmonitor.app npm run build`, `dist/` is gitignored, nothing to commit there).
Verified live: network log went from duplicate-fetch/pending-forever chaos to clean 200s/304s/disk-cache
hits after a webview reload. **`src/main.ts` change still uncommitted** — pick this up.

### Part 3 — github-identity-bridge duplicate-account bug (cross-repo: platform, NOT this repo)

**Symptom**: after Part 2's fix, one thing stayed stuck: `/api/latest-brief` returned a genuine
`{"status":"composing"}` — not an error, but wrong, since the operator's browser could open a real,
already-composed brief for the same date.

**Root cause, confirmed via direct Supabase SQL** (project `ixuezudybhjptisexgxx`, "BIOVITA_BOTANICS"):
the VS Code extension signs in through a custom `custom:github-bridge` Supabase provider (reuses VS
Code's own GitHub session, avoiding a manual OAuth click-through) instead of native `github` OAuth. Both
resolve to the *same* GitHub account (verified: identical numeric GitHub id `64537609`,
`@powerpro-led`), but Supabase's GoTrue links identities by exact `(provider, provider_id)` — different
provider names never auto-link even for the same real person — so the bridge had minted a **second,
permanently separate Supabase user** (`ffb0c1e8-...`, zero email, zero real data) instead of resolving
to the operator's real account (`15ae70b6-...`). Every user-scoped read/write from the VS Code extension
(briefs, and structurally anything else keyed by Supabase user id) was silently hitting the empty ghost
account. Not fixable in this repo — the bridge function lives in the sibling `platform` repo.

**Handoff**: wrote a full bug brief (root cause, evidence, why a naive if-check inside the OIDC flow
doesn't work — GoTrue itself owns account-creation-vs-reuse by `(provider, provider_id)`, not the
Edge Function — recommended fix: check for an existing identity under any *other* provider by
provider_id at ticket-mint time and mint a session for that existing user instead of proceeding through
the OIDC flow) and handed it to an agent working in `platform`.

**Result, confirmed live in Supabase**: `platform` shipped a fix same-day —
`public.link_bridge_identity_if_needed()` SQL function (`SECURITY DEFINER`, `service_role`-only
EXECUTE, looks up any non-bridge identity by `provider_id` before a bridge sign-in would mint a new
user), wired into `handleTickets` before ticket-mint, deployed as edge function v5, commit
`bafbfb15916c1db973f96a60564f99196c4e4428` on `platform` branch `fix/github-bridge-duplicate-account`
(pushed, not yet a PR). One-time backfill applied for this operator (bridge identity UPDATEd onto the
real user — an INSERT wasn't possible, a row already occupied the identity). **Verified here**: real
account now shows 1 bridge identity + 2 others; ghost account now has 0 identities (unloginable) and 0
app data after cleanup below. Detection query for other affected operators (safe to re-run anytime,
currently returns exactly the one now-fixed row) is in the bug brief, also saved at
`/private/tmp/claude-502/-Users-john-Documents-CODE-worldmonitor/221b7d4a-e139-4d5f-afd9-f5c2bcb354e1/scratchpad/github-identity-bridge-bug-brief.md`
(session-scratchpad path — copy it out if it needs to survive past this session).

**Data cleanup, also confirmed via SQL**: the ghost account had exactly one piece of real app data —
a duplicate `worldmonitor.alert_rules` digest-subscription row (`sensitivity: critical`, created
2026-08-22, one day after the operator's REAL account's own subscription). **Correction worth noting**:
initially planned to migrate this row to the real account, but a `(user_id, variant)` unique-constraint
violation on the UPDATE caught that the real account already had a working `variant='full'` subscription
(`sensitivity: high`, since 2026-08-21 — already the exact fix an earlier session applied). The ghost's
row was genuinely redundant, not a hidden dependency — deleted rather than merged. **The digest-subscription-missing
theory from an earlier session's "Latest Brief needs operator action" note was itself a red herring once
this account-split was found** — the real account never lacked a subscription; the extension was just
asking the wrong account.

**Trap worth carrying forward**: a multi-statement `execute_sql` call to Supabase silently returned only
the LAST statement's result set with no error — an early check that assumed "no output shown = empty
result" was wrong and nearly caused a bad data merge. Run one statement per call when the emptiness of
an early result actually matters to a decision.

### Part 4 — target="_blank" links do nothing inside the VS Code embed (repo-local, fixed)

**Symptom**: Latest Brief panel's cover card (a plain `<a target="_blank">`) did nothing on click
inside the extension; the identical link opened a new browser tab fine outside it. ~40 dashboard
components use `target="_blank"` — all equally affected, not just this one panel.

**Root cause**: VS Code's webview architecture blocks `window.open()`/`target="_blank"` navigation
from webview content by design (a security boundary) — the click's default navigation silently goes
nowhere, no error, no console output. Opening an external URL from a webview requires an explicit
`vscode.env.openExternal()` call from the extension host, reached via `postMessage`.

**Fix**: one global, capture-phase `click` listener in `src/main.ts` (gated by
`isVsCodeEmbedRuntime()`) intercepts any `<a target="_blank">` click, cancels the default navigation,
and relays the URL through `window.__wmVsCodeApi.postMessage()` — the same bridge already used for
GitHub sign-in. `vscode-extension/src/panel.ts` relays it up one more hop (mirroring the existing
`wm-github-signin` relay) to a new `handleOpenExternal()` that validates the URL is http(s) before
calling `vscode.env.openExternal()`. One listener covers all ~40 components; no per-component changes.

### Part 5 — AbortSignal.timeout() silently ineffective sidecar-wide (repo-local, fixed) — the big one

**Symptom**: `/api/market/v1/analyze-stock` 500'd after a consistent, suspicious 60 seconds for every
symbol (AAPL/MSFT/GOOGL/NVDA), and other panels were reported "still slowly loading."

**Root cause, confirmed live** (spawned an isolated debug sidecar instance to get the real stack
trace `console.error` output doesn't surface in the HTTP response): the sidecar's global `fetch`
override (`ipv4Fetch` in `local-api-server.mjs`, needed for IPv4-pinned DNS resolution against
broken-IPv6 upstreams) handled `AbortSignal` incorrectly —
`init.signal.addEventListener('abort', () => req.destroy())` alone does **not** reliably settle the
surrounding Promise: Node's `http.ClientRequest` doesn't guarantee an `'error'` event fires from a
bare `destroy()` with no error argument when the request has no response yet. Every
`AbortSignal.timeout(N)` throughout the ENTIRE codebase — Yahoo/Exa/every upstream call with its own
short timeout bound — was silently defanged inside the sidecar specifically: the timer fired,
`destroy()` ran, and the request just hung, with nothing settling the promise except whichever
unrelated OUTER timeout happened to exist (here, `cachedFetchJson`'s own independent 60s
`Promise.race` backstop — explains the suspiciously exact 60s figure, and the missing
`[stock-news-search] exa failed` warning that should have logged at ~10s). Confirmed the Exa API
itself was NOT slow — a bare `curl` to the same endpoint with the same key returned in 1.6s.

**Fix**: the abort listener now explicitly `reject()`s with an `AbortError`/the signal's own reason,
in addition to calling `req.destroy()`, so an abort actually aborts regardless of whether Node
chooses to emit its own `'error'` event.

**Verified live**: same debug-instance method, same symbol (AAPL) — went from a 60s hang → 500 to a
real ~22s 200 with full analysis data (technical snapshot, Exa-sourced headlines, dividend profile).
The 22s is genuine sequential/parallel upstream latency (Yahoo history + analyst data + dividends +
news), not a hang.

**Likely broader impact, not individually verified**: this bug affected every fetch in the sidecar
process bounded by its own `AbortSignal.timeout()`, not just analyze-stock — plausibly the actual
explanation for "some panels still slowly loading" reported alongside this symptom. Worth revisiting
"slow panel" reports against this fix before assuming a new, separate cause.

### Part 4 correction — a window reload alone did NOT pick up the panel.ts fix; RESOLVED

Parts 4 and 5 were verified live (2026-08-22, same session): `analyze-stock` now returns 200s
(Part 5), general panel loading is faster than before (Part 5's broader impact), **but** external
links still did nothing after "Developer: Reload Window."

**Root cause of the leftover gap**: this extension is a genuinely **installed** VS Code extension
(`~/.vscode/extensions/worldmonitor-internal.worldmonitor-local-dashboard-0.1.0/`, a separate copy
from the workspace repo — matches the "operators download+install a `.vsix`" deployment model), NOT
loaded live from source. `sidecarProcess.ts`'s `resolveRepoRoot()` points the spawned sidecar
(`.mjs`, hand-written, runs directly) and the served dashboard `dist/` at the **live workspace repo**
— which is why Parts 4/5's fixes to `main.ts` and `local-api-server.mjs` worked immediately, no
reinstall needed. But the extension HOST's own code (`panel.ts` → `dist/extension.js`) is loaded
from whatever's **installed**, and a window reload only re-runs that already-installed code — it
does not rebuild or reinstall it. The installed copy was 5 days stale (Aug 17) and had zero trace of
the fix, confirmed via `grep` before touching anything.

**Fix**: `npm run package` (in `vscode-extension/`) → fresh `.vsix` → `code --install-extension
<path> --force`. Confirmed the freshly installed `dist/extension.js` now contains the fix before
handing back.

**Trap worth carrying forward**: for this extension specifically, "did my fix take effect" has
**three different answers depending on which file changed** — `src/*.ts` (dashboard) and
`vscode-extension/sidecar/*.mjs` changes are live from the workspace repo (rebuild + reload/respawn
is enough), but `vscode-extension/src/*.ts` (extension-host code) changes are NOT live — they need
`npm run package` + `code --install-extension --force`, and only THEN does a window reload matter.
Assuming "I rebuilt and reloaded" covers all three is how this got missed the first time.

### Part 4 fully confirmed working — surfaced a self-inflicted regression, now also fixed

Operator confirmed Part 4 (external links) working after the `.vsix` reinstall + one more window
reload. Clicking Latest Brief's cover card opened a new browser tab correctly — but the tab itself
showed Supabase's genuine "This link is no longer valid" error, not a WorldMonitor bug: the token
failed HMAC verification.

**Root cause — this session's own earlier secret rotation, applied incompletely**: earlier in this
same session (see "Part 1 — thirty-third session's three open items" above, item 2), rotating
`BRIEF_URL_SIGNING_SECRET` in `.env` did not include restarting `nitric start`. Brief links point at
`WORLDMONITOR_PUBLIC_BASE_URL=http://localhost:9001` (nitric) by deliberate design from an earlier
session — but the sidecar (which *signs* the token, freshly respawned multiple times since the
rotation) and nitric (which *verifies* it, running unbroken since 11:19 AM, well before the
rotation) are two independent processes that each snapshot `.env` at their own startup. The sidecar
signed with the new primary secret; nitric verified against its own stale-only-old-secret snapshot.
Exactly the documented trap this repo already knows about (**"restart `nitric start` after any
`.env` edit"**) — violated by not re-applying it after today's own rotation.

**Fix**: restarted `nitric start --ci` (killed PID 10019, respawned). Verified live: the exact
previously-failing URL now returns the real rendered brief page (`curl` for the "no longer valid"
error text now returns 0 matches). `clean-nitric-history.mjs` and the standalone `ais-relay.cjs`
were left untouched — nitric's own internal `ais-relay` attempt failed with the expected, harmless
`EADDRINUSE` on `:3004` (the standalone copy already owns that port, matches prior sessions' notes).

### 🔭 STILL OPEN — pick this up first

1. `platform`'s fix is a plain commit+push on `fix/github-bridge-duplicate-account`, not yet a PR —
   not this repo's concern to chase, but flagging in case it's relevant context later.
2. **Nothing else open from this session's bug-fix thread as of this handoff** — all four VS-Code-
   embed bugs (SW, click-handling, AbortSignal, and the secret-rotation regression it surfaced) are
   verified live.

### 🔭 NEXT INITIATIVE — seed/sync reliability sweep (operator's choice for the next session)

Scoped cold-start, same shape as sessions 31–33's orphan sweeps: audit seeders and the
Redis→local-SQLite mirror sync for staleness, orphaned crons, or silent failures.

**Baseline, measured this session's close (2026-08-22, ~21:15)**: `/api/health?compact=1` — 232
total, 181 ok, 15 warn, 12 onDemandWarn, 0 staleContent, **24 crit**. Full crit/warn key list below;
don't re-fetch as step one, start from this.

**Already explained by prior sessions — don't re-diagnose these, they're expected**:
- `acledIntel` EMPTY — ACLED blocked on account tier (Open, needs Research), not code. Don't re-test
  credentials (`session32_orphan_seeder_sweep.md`).
- `gdeltIntel` EMPTY — GDELT self-rate-limits (429), expected to self-resolve on its own cron cycle
  (`session32_orphan_seeder_sweep.md`).
- `jodiGas`/`jodiOil` EMPTY — China coverage gate can never pass as currently designed; decoupling it
  is an unanswered **operator policy call**, don't implement unprompted (`jodi_seed_source_contracts.md`).

**Not yet explained — genuinely open, good starting candidates**:
- `consumerPrices{Overview,Categories,Movers,Spread,Freshness}` — all 5 EMPTY simultaneously, smells
  like one shared upstream/seeder problem rather than 5 independent ones.
- `globalTendersCanadaBuys`, `globalTendersContractsFinder` — both `SEED_ERROR`.
- `resilienceStaticFao`, `resilienceStaticIndex` — both `SEED_ERROR` (long `maxStaleMin`, ~576000 —
  near-static reference data, so a persistent error here has likely been silently broken for a while).
- `socialVelocity` — `SEED_ERROR`.
- `sanctionsPressure`, `sanctionsEntities` — both EMPTY; check whether these are ACLED-adjacent
  (same account-tier block) or a genuinely separate cause before assuming the former.
- `comtradeBilateralHs4`, `submarineCables`, `climateAnomalies`, `climateZoneNormals`, `riskScores`,
  `telegramFeed`, `wsbTickers`, `wildfires`, `wildfiresBootstrap`, `webcams` — EMPTY, uninvestigated
  this session. `webcams` in particular: cross-check against `vscode_live_news_debugging_session.md`
  before assuming it's the same already-accepted removal — that note says `api/webcam` itself is
  NOT dead (still serves `PinnedWebcamsPanel`), so this EMPTY key may be tracking something distinct.
- Several `STALE_SEED`/`EMPTY_ON_DEMAND` entries not listed above — full raw list was captured via
  `/api/health?compact=1`'s `problems` object at session close; re-fetch if this list feels stale by
  the time it's picked up (health state drifts hour to hour).

**Environment left running** (all confirmed stable at session close): `nitric start --ci` (restarted
this session at ~21:10, PID reassigned — don't assume any PID number above is still current, re-`ps`),
`node scripts/clean-nitric-history.mjs` (running since this morning's boot — **note: TWO copies
running, one from today, one orphaned since Thursday**, harmless duplicate, not worth killing but
don't be alarmed if `ps aux` shows two), `node --env-file=.env scripts/ais-relay.cjs` (since this
morning's boot, untouched all session), the VS Code extension's own sidecar (respawned by the
extension itself during this session's testing, fresh token each spawn — read it live via
`ps eww $(pgrep -f local-api-server.mjs) | tr ' ' '\n' | grep LOCAL_API_TOKEN`, don't reuse any token
value written earlier in this file).

---

## 🔀 HANDOFF (2026-08-22, THIRTY-THIRD session end) — superseded by the thirty-fourth block above

**Scope**: two threads. (1) Closed the thirty-second session's "🔭 NEXT INITIATIVE" — Redis→local-SQLite
data pipeline for the VS Code extension — end to end: restored a dead sync, audited every Redis prefix
against every handler, scoped user data correctly, and automated it with a launchd agent. (2) That work
put a *working* mirror in front of the sidecar for the first time, which exposed **six** VS-Code-only
bugs nothing had ever exercised before. All six fixed and verified. Console errors: **122 → 5**
(operator-confirmed, live). **0 commits pushed** (standing manual-commit discipline); 34 commits sit
ahead of `origin/main` on `main`, tree clean.

### Part 1 — Redis → local SQLite mirror (the prior NEXT INITIATIVE, now CLOSED)

| # | Problem | Fix |
|---|---|---|
| 1 | `npm run local-sync` dead 4 days, nothing reported it | 4 stacked blockers: no `.env` loading in the npm script, wrong Redis token under the local-Redis switch, `SCAN…WITHTYPE` (an Upstash extension a real Redis rejects), and the shim silently mangling any value that happened to *be* valid base64 (it ignored `Upstash-Encoding: base64`, which `@upstash/redis` sends by default and decodes unconditionally) |
| 2 | Rebuild not crash-safe | `DELETE FROM kv_cache` auto-committed immediately; a killed run left an empty/partial mirror **stamped with a fresh `synced_at`**, so the new staleness warning would call the wreckage healthy. Fixed: stage into `.tmp`, rename only on full success |
| 3 | Mirror age was invisible | `synced_at` written since the mirror existed, read by nothing. Sidecar now logs age on load and warns past 24h |
| 4 | Sync had no cadence | `scripts/install-local-sync-agent.sh` installs `com.worldmonitor.local-sync`, a **LaunchAgent** (not a root Daemon — it writes into the repo). `RunAtLoad` + 900s. **Deliberately not tied to VS Code lifecycle** — the mirror is a machine property. Source stays 100% env-driven (`UPSTASH_REDIS_REST_URL`); no second selector was added, per explicit operator correction — see `redis_env_not_codebase_switch.md` |
| 5 | 19 domains had data in the browser, empty in the extension | Audited all 59 Redis prefixes (23,351 keys) against every handler. `SYNC_PREFIXES` 15 → 42. Classified by **reading keys, not names** — `acled:` looks like a data prefix, its only key is `acled:oauth:token`, a **credential**, deliberately excluded |
| 6 | `brief:` mirrored everyone's briefs | Now filtered to the signed-in operator only. Sidecar records the Supabase user id (from the VS Code GitHub-session bearer) to `operator-identity.json` beside the mirror; fail-closed cold start (no identity → no user-scoped brief mirrored at all) |

Two classes of empty panel a bigger `SYNC_PREFIXES` can **never** fix, both diagnosed and left alone:
premium-gated RPCs (tell: `fetchedAt: ''`, not a stamped timestamp) and fetch-through caches under
**prefixless** keys (`cable-health-v1`, `chokepoint-status`) — every `SYNC_PREFIXES` entry ends in `:`.

### Part 2 — six VS-Code-only bugs, all the same shape

**Every one of these is "the browser has Vite in front of it, the extension has the sidecar."** Vite
proxies `/api` same-origin; the extension's `<iframe>` hits the sidecar directly, so anything that
depends on same-origin cookies, a specific origin string, or a resolvable `.ts` import breaks silently
in the extension while the identical bundle works in a tab.

| # | Symptom | Root cause | Commit |
|---|---|---|---|
| 1 | almost every RPC 401 | `getConfiguredWebApiBaseUrl()` returned `VITE_WS_API_URL` (`:9001`=nitric) as its FIRST statement, before any runtime check → every call went cross-origin, where the embed shim can't attach `x-worldmonitor-local-token` | `85fe9d5` |
| 2 | Latest Brief 404 | `build:sidecar-handlers` only compiled `api/{domain}/v1/[rpc].ts`, never top-level `api/*.ts` — 18 routes (`latest-brief`, `chat-analyst`, `user-prefs`, …) simply didn't exist. Route table 53→70 | `2c40250` |
| 3 | telegram/oref 502 "SSRF blocked" | `RELAY_URL=http://localhost:3004` is a private origin the sidecar's SSRF guard rejects | `a77215a` |
| 4 | bootstrap/gpsjam 503 | `api/_upstash-json.js`'s two sidecar branches did `await import('.../sidecar-cache')` — a **`.ts` path**. This module is hand-written plain JS the sidecar loads directly with node → `ERR_MODULE_NOT_FOUND`, always. Domain RPCs worked because esbuild **inlines** the TS into those bundles; this file is not one of them | `0510ed5` |
| 5 | wm-session 503 "Rate-limit service temporarily unavailable" | Same SSRF guard blocked the rate limiter's own Redis pipeline call. The existing docker-only allowance's comment ("desktop UPSTASH_REDIS_REST_URL is a public https origin") is stale the moment local Redis dev exists — extended the gate to `tauri-sidecar` | `4746487` |
| 6 | latest-brief 503 "service_unavailable" | Same root cause as #5, different symptom: `readRawJsonFromUpstash` has no sidecar branch, always calls `UPSTASH_REDIS_REST_URL` directly, was SSRF-blocked, and `latest-brief.ts`'s outer catch deliberately turns any Upstash-read throw into 503 rather than a false "composing" state | fixed by same commit as #5 |

**The trap worth carrying forward**: the sidecar loads two kinds of route with *opposite* module
resolution — esbuild bundles (`api/{domain}/v1/[rpc].js`, can `import` `.ts`) vs. hand-written plain JS
(`api/bootstrap.js`, `api/_upstash-json.js`, cannot). Code that "obviously" works because the same line
works elsewhere may sit in the wrong kind of file. Full write-up: `local_pipeline_and_vscode_dagu_plan.md`.

### 🔭 STILL OPEN — pick this up first

**1. `/api/health?compact=1` 503 "Redis snapshot lock failed" — RESOLVED (2026-08-22, thirty-fourth session).**

Fix applied exactly as recommended below: the `tauri-sidecar` branch of `redisPipeline()` now falls
through to a live pipeline call for non-GET commands whenever `getRedisCredentials()` finds live creds,
and only returns the old "unavailable" `null` when they're genuinely absent (packaged-desktop-without-
local-Redis case). GET-only pipelines are untouched — still served from the mirror unconditionally.
Verified live against the running extension sidecar (killed by captured PID, relaunched with the same
env/token so the already-open webview kept working): `/api/health` **503 → 200** (now correctly reports
real subsystem health — 25 crit/19 warn/232 total, a separate pre-existing signal, not an infra failure);
`/api/bootstrap` and `/api/gpsjam` both stayed 200. `tsc --noEmit` clean.

Root cause: `api/health.js`'s snapshot lock does `SET … NX EX` via `redisPipeline()`. Commit `0510ed5`'s
sidecar branch in that function only serves **all-GET** pipelines from the SQLite mirror — anything else
(this SET) returns `null` by design ("the mirror is read-only, a write should never report success").
`health.js` sees `null`, throws `'Redis snapshot lock failed'`, answers 503.

That guard was right for a **read-only** mirror, but it's now too blunt: in `tauri-sidecar` mode with
local Docker Redis, `UPSTASH_REDIS_REST_URL`/`TOKEN` point at a **real, writable** store, and commit
`4746487` already allowlisted that origin for SSRF — so `redisPipeline()` *could* fall through to a live
call instead of returning `null`, and the lock would just work.

**Recommended fix (applied above)**: in the `tauri-sidecar` branch, only serve from the mirror when
live Redis creds are absent (the packaged-Tauri-desktop-without-local-Redis case, where the mirror is
the only option). When `UPSTASH_REDIS_REST_URL`/`TOKEN` are set — true for every local-dev sidecar
today — fall through to the real pipeline call below instead of intercepting. Needs deciding whether
that changes behavior for GET-only calls too (currently served from the mirror even when live creds
exist) — probably keep GET-from-mirror as is (mirror is deliberately the *fast*, offline-safe path) and
only widen the non-GET branch. Verify against `bootstrap`/`gpsjam` (must stay 200) AND `health`
(must go 503→200) in the same test pass.

**2. Two remaining console entries are external/environmental, not local bugs — do not chase them:**
- `GET /_vercel/insights/script.js` 404 — Vercel Web Analytics isn't present locally. Harmless.
- `maps.worldmonitor.app` CORS block on `country-boundary-overrides.geojson` — that remote host replies
  `Access-Control-Allow-Origin: http://localhost:3000`, rejecting the `:46123` embed origin. It's the
  external service's own CORS config; nothing in this repo can fix it. Map falls back without overrides.

**3. Rotate `BRIEF_URL_SIGNING_SECRET` — RESOLVED (2026-08-22, thirty-fourth session).** Its real value
was pasted into this session's chat transcript in plaintext (operator opened `.env` in the IDE and
copy-pasted while debugging). Unlike the six third-party keys below, this one is a purely local,
self-issued HMAC secret (`server/_shared/brief-url.ts`'s own header: "No external counterpart — any
high-entropy value works") with no deployment-config copy to update (`.env` only, confirmed via grep —
nothing deployed anywhere yet). Rotated per that module's own documented "Normal roll" runbook: new
`crypto.randomBytes(32)` value set as `BRIEF_URL_SIGNING_SECRET`, previous value moved to
`BRIEF_URL_SIGNING_SECRET_PREV` so in-flight brief links (7-day envelope TTL + delivery window) keep
validating. **`nitric start` needs a restart to pick up the new `.env` value** — not yet done this
session; until then the already-running process keeps signing with the old value in memory, which is
harmless since the new PREV mechanism accepts both either way.

The six third-party keys below (OpenRouter, OTX, URLhaus, AbuseIPDB, Firecrawl, OpenSky) still need
manual rotation via each provider's own dashboard — no local/API-only rotation path exists for those,
unlike this one.

**4. `readMirrorValues()` in `api/_upstash-json.js` opens `node:sqlite` once per process and never
closes it.** Fine for a long-lived sidecar process; would leak a handle in a short-lived script that
imported this module repeatedly. Not observed as a problem, just noted.

### Traps specific to this session

- **`pkill -f local-api-server` kills the operator's OWN running extension sidecar**, not just test
  probes — they share the exact script path. Symptom is deceptive: the ServiceWorker keeps serving
  cached HTML/JS so the dashboard still renders, and only the Network tab shows every fetch as
  `net::ERR_CONNECTION_REFUSED`. Kill test sidecars by captured PID or by port, never by name.
- **The sidecar runs PREBUILT bundles**, not live TS. `server/_shared/` edits need
  `npm run build:sidecar-handlers` before they're visible in the extension — the opposite of nitric,
  where tsx resolves the sibling `.ts` first and edits are live.
- **`npx vite build` needs `APP_DOMAIN=worldmonitor.app`** (the apex, not `www.` — that double-prefixes)
  or the `wm-variant-dashboard-html` plugin's hreflang-rewrite anchor matches zero times and the build
  fails at the very last step, leaving `dist/` with prerendered SEO pages but **no `dashboard.html`, no
  `assets/`** — which 404s the extension's dashboard entirely.
- Every finding in this session was verified live (curl probes with forged-but-correctly-rejected
  bearers, crash-mid-run tests, A/B against a clean tree for the one pre-existing test failure) rather
  than inferred from source reading alone — see the individual commit messages for the actual numbers.

---

## 🔀 HANDOFF (2026-08-21, THIRTY-SECOND session end) — superseded by the thirty-third block above

**Scope**: closed item G (Latest Brief) from the thirty-first session, then followed the consequences
into the orphaned-seeder sweep that block had already flagged as "the single highest-value follow-up".
`/api/health` went from **44 crit / 157 ok → ~24 crit / ~185 ok**. Twenty-nine seeders that nothing in
the repo could invoke are now registered and running on their own cadences.

**Git state**: 0 commits (operator's standing manual-commit discipline held). 60 files uncommitted —
**but only ~14 are this session's**; the other ~46 were already modified when this session started
(Umami removal, domain-config work from earlier sessions). Do not fold those into a commit message
claiming they are session-32 work. `npx tsc --noEmit` clean; 214/215 on the registry/scheduler suites
(the 1 failure is pre-existing, see "KNOWN PRE-EXISTING" below). Commit `0114fcf` still sits ahead of
`origin/main` from an earlier session — not mine.

### What got fixed

| # | Item | Root cause |
|---|---|---|
| A | "Read brief" opened `https://nitric.internal/...` | `api/latest-brief.ts:167` falls back to `new URL(req.url).origin`, which under Nitric is the **synthetic** host `gcp/api/adapt-vercel-handler.ts:45` invents. Fixed by pinning `WORLDMONITOR_PUBLIC_BASE_URL=http://localhost:9001` in `.env` |
| B | Digest sent 0 / brief was boilerplate | NOT a bug. `sensitivity: "critical"` matched **0 of 1284** stories in the 24h pool (2 of 2857 all-time). Operator switched to `high` → pool 81 |
| C | Groq 404 on every call | `scripts/lib/llm-chain.cjs:45` was the **last** call site still on retired `llama-3.1-8b-instant`; the 2026-08-18 sweep missed it (it lives in `scripts/lib/`, not next to a seeder) |
| D | Brief prose stuck on `level=3_stub` | `brief-llm.mjs` pins to OpenRouter via `skipProviders`, and no key existed. Key added; **`google/*` and `openai/*` return 403 on this account** (reproduced from two egress IPs), so `OPENROUTER_MODEL=deepseek/deepseek-v4-flash` was set — this IS the U4 brief-voice cutover, done via env so it reverts by deleting one line |
| E | **29 orphaned seeders** | Present in `scripts/` but absent from every registry, bundle, npm script, scheduler entry, and GitHub workflow. Registered + cadenced; guard widened |
| F | `seed-ember-electricity` always failed | 70 MB CSV, 5-min timeout demanded ≥234 KB/s. Deeper: the direct connection **decays** (83 KB/s → 21.8 KB/s over 300s ⇒ ~54 min needed). Fixed with direct-first/`PROXY_URL` fallback (454 KB/s, 21×) + separate direct/proxy timeout budgets |
| G | `seed-security-advisories` silently fetched nothing | `RELAY_URL` unset → `resolveProxyOrigin(APP_DOMAIN)` → `:3000` (Vite, no `/rss` route). Set to `:3004` where `ais-relay.cjs:6822` actually serves it |
| H | FIRMS 66× slower than control | VPN-throttled. Static route + LaunchDaemon (`com.worldmonitor.firms-vpn-bypass`), self-heal verified by delete-and-observe. 10.9 KB/s → 238 KB/s |

### The two rules worth carrying forward

**1. A name match is not a fact.** Every wrong turn this session came from treating a string match as
semantics. Orphan detection found `seed-chokepoint-flows` referenced in `ais-relay.cjs` and I nearly
double-registered it — that one is a real `execFile` at `:6566`, while `seed-aviation` /
`seed-energy-spine` / `seed-cyber-threats` appear at `:11656` only in **comments** saying a standalone
cron owns them (so those three ARE genuine orphans). Same failure mode built `requiredEnv` lists by
regexing `process.env.X`, inventing three phantom "missing credentials" that were legacy fallbacks or
optional degradation paths. **Open the call site and read the branch.**

**2. `exit 0` is not evidence that work happened.** A killed run left an orphaned Redis lock; the next
`seed-ember-electricity` printed "Lock held by another run, skipping" and **exited 0** having done
nothing. Only `/api/health` still saying `SEED_ERROR` caught it. Related: a multi-source seeder fails
only when *all* sources fail at once — `seed-unrest-events` exit 1 was GDELT 429 + ACLED 403
simultaneously, and simply re-running it succeeded.

### KNOWN PRE-EXISTING (do not chase, `git stash` A/B confirmed)

- `tests/railway-services-registry-coverage.test.mts` → `every Dockerfile.* CMD has a matching registry
  entry` **fails on a clean tree**. `Dockerfile.{process-deep-forecast-tasks,process-simulation-tasks,
  scenario-worker}` exist (dated Aug 6) while those three services are registered as
  `nixpacks-root-scripts`. Which artifact is authoritative is a deployment-contract decision — left alone.
- This session **fixed** a different pre-existing failure in that file (`every script header-documented
  Railway service is registered`) as a side effect of the registrations.

### Environment left running

Vite `:3000`, `ais-relay.cjs` `:3004`, docker redis+redis-rest `127.0.0.1:8079`, `nitric start --ci`
`:9001`, and `scripts/clean-nitric-history.mjs`. **Relay trap:** nitric declares its own `ais-relay`
service, so whichever starts second loses `:3004` and **crashes permanently — nitric never retries it**.
While the standalone copy is alive nitric's is dead-on-arrival; the moment the standalone one exits,
*nothing* owns `:3004` and no health check flags it. Restart it with
`node --env-file=.env scripts/ais-relay.cjs` — plain `node` dies on `AISSTREAM_API_KEY not set`.

### 🔭 STILL OPEN — pick these up first

1. **Commit the work.** 60 files uncommitted, ~14 from this session across five themes:
   (1) `WORLDMONITOR_PUBLIC_BASE_URL` pin, (2) `llm-chain.cjs` Groq model, (3) `OPENROUTER_MODEL` knob
   (`llm-chain.cjs`, `server/_shared/llm.ts`, `ais-relay.cjs`, `seed-insights.mjs`, both
   `regional-snapshot/*`, `.env.example`), (4) orphan sweep (`railway-services.json`,
   `gcp/scheduler/main.ts`, `tests/railway-services-registry-coverage.test.mts`), (5)
   `seed-ember-electricity.mjs`. Stage by explicit path — never `git add -A`, the other ~46 files
   are earlier sessions' work.

2. **ACLED is blocked on the operator, not on code.** OAuth token issues fine; every data call 403s
   because `led4signage.com` sits on the **Open** tier, which has no API entitlement (ACLED's own
   access table: API is ✓ only from Research up). An access-review email was sent 2026-08-21 asking
   for Research level. Until it lands, `acledIntel` + `sanctionsPressure` stay EMPTY and
   `seed-conflict-intel` exits 75 by design. **Do not re-test the credentials — they are correct.**
   Optional small task: `seed-conflict-intel` logs a bare `ACLED API error: 403`, which reads like a
   broken credential; a one-line hint at the call site would stop the next session re-diagnosing it.

3. **Rotate credentials — CLOSED, operator's call (2026-08-22, thirty-fourth session): not worth doing.**
   OpenRouter, OTX, URLhaus, AbuseIPDB, Firecrawl, and OpenSky keys were pasted into the session-32
   transcript in plaintext. Confirmed no self-service API rotation path exists for any of them (all six
   need the operator to log into each provider's own web dashboard by hand — see prior commit
   `bab5e5b` for the per-provider detail, don't re-research it). **Operator explicitly declined**: this
   fork is dev-stage only, these six keys are dev credentials, not production, so a transcript exposure
   isn't worth the manual-rotation cost right now. Do not re-raise this as urgent in a future session —
   `BRIEF_URL_SIGNING_SECRET` (self-issued, no dashboard needed) was still rotated same session, since
   that one had zero cost either way.

4. **`gdeltIntel` EMPTY** — GDELT returns HTTP **429** (its own rate limiter), not a network fault.
   Expected to self-resolve on the `0 */2 * * *` cron. Verify before treating as a bug.

5. **The thirty-first session's NEXT INITIATIVE (Redis → local SQLite) is still unstarted** and its
   measured baseline still stands — but re-measure it. Several of its 7 zero-row `SYNC_PREFIXES` were
   plausibly empty *because the seeder that fills them never ran*; that is now fixed, so the baseline
   in that block predates 29 newly-registered seeders.

6. **Nine registered seeders still lack credentials** and skip cleanly until they exist (declared in
   each entry's `requiredEnv`): `ENTSO_E_TOKEN` is **not needed** (vendor discourages it; the seeder
   degrades to EIA-only, US prices only). The rest are genuinely absent.

### Traps specific to this work

- **Registration ≠ backfill.** Nitric's `schedule().every()` fires *after* the interval, not on
  registration. A weekly seeder stays EMPTY for 7 days unless run by hand once.
- **`exit=75` is `EX_TEMPFAIL`** (`scripts/_seed-utils.mjs:586`), not a crash — "fetch failed, last-good
  TTL extended, retry". Three of five backfill "failures" were this.
- **`nitric start` throws at module load** if any `nixpacks-*` registry entry lacks a `CADENCES` entry
  in `gcp/scheduler/main.ts`. That is a feature: the scheduler starting proves the two files agree.
- **The Bash tool caps at 10 min.** `seed-ember-electricity` needs ~4 min minimum on this link; a
  foreground run gets SIGKILLed and **orphans its Redis lock** (`seed-lock:energy:ember`, 20 min TTL).
  Run long seeders with `run_in_background`.

---

## 🔀 HANDOFF (2026-08-21, THIRTY-FIRST session end) — superseded by the thirty-second block above

**Scope**: cleared every open item the thirtieth session handed off (A–E below), plus three more found
while verifying (F, G, H). Dashboard panels that were blank now render. **Next initiative is a data-
pipeline review — see "NEXT INITIATIVE" at the bottom of this block; it is scoped and has a measured
baseline, so it can be picked up cold.**

**Git state**: 0 commits (operator's standing manual-commit discipline held). ~46 modified, 4 deleted,
3 untracked (`docker-compose.dev.yml`, `docker/`, `patches/`). `npx tsc --noEmit` clean on all three
tsconfigs at session end. One pre-existing commit `0114fcf` sits ahead of `origin/main` from an
earlier session — not mine.

### What got fixed (details in items A–H below)

| # | Item | Root cause |
|---|---|---|
| A | `classify-event` 500 on any `%` | Redundant `decodeURIComponent` in `@nitric/sdk` — patched via NEW `patches/` + `postinstall` |
| B | Umami analytics | Deleted entirely, 21 files (operator's call) |
| C | 预测 + 经济指标 empty | **Orphaned seeders** — registered + cadenced |
| D | 2 dead RSS feeds | Dead upstream (Cloudflare / 404), URLs replaced both sides |
| E | Premium Stock Analysis / Backtesting | **Two** Yahoo blockers: CSRF crumb + a UA-platform-token 429 |
| F | 贸易政策 (WTO) | **Two more orphaned seeders** — registered + cadenced |
| G | Latest Brief | Not a bug: needs a digest subscription (**operator action, still open**) |
| H | Settings modal "won't save" | Read/write variant mismatch — real bug, fixed |

### The theme of this session, and the two rules worth carrying forward

**1. Four orphaned seeders.** `seed-economy`, `seed-prediction-markets`, `seed-supply-chain-trade`,
`seed-trade-flows` were working scripts that **nothing ever invoked** — absent from
`scripts/railway-services.json`, every `seed-bundle-*`, and npm scripts. Each emptied a panel. All
four are now registered with cadences taken from **each script's own TTL comments** (they document the
intended cron — read them, don't invent one). The guard that should have caught this,
`tests/railway-services-registry-coverage.test.mts`, only inspects scripts carrying a
`//   - Service name:` header — **3 of 318 did**; now 7. **Widening it to all `scripts/seed-*.mjs`
would likely surface more orphans and is the single highest-value follow-up here.**

**2. Every empty panel lied about why.** Four separate panels rendered an empty state naming a cause
that had already been ruled out — Predictions ("加载预测失败" on `data.length === 0`), Premium Stock
Analysis ("waiting for eligible watchlist symbols" on `results.length === 0`, behind a bare
`catch {}`), Economic Indicators, Latest Brief ("composing" whenever a pointer is missing). **Never
take a panel's empty-state text as a diagnosis — find the branch that renders it and read its actual
condition.**

### Environment left running

`nitric start --ci` (:9001), Vite (:3000), `scripts/ais-relay.cjs` (:3004),
`docker compose -f docker-compose.dev.yml` (redis + redis-rest on 127.0.0.1:8079), and
**`node scripts/clean-nitric-history.mjs &`** — that last one must run alongside `nitric start` EVERY
session. **`nitric start` wedged twice this session** (once from a 662-request dashboard load, once
from `git stash` churn rewriting watched files): every route returns `000`/hangs while all processes
stay alive. A restart is the only cure — and note a *hung* request fires neither `.then` nor `.catch`,
so UI shows a spinner rather than an error. Symptom to recognise, not a bug to chase.

---

## 🔭 NEXT INITIATIVE — data-pipeline review: Redis → operator's local SQLite

### ▶ STARTED 2026-08-21 (thirty-third session) — sync restored, questions 1 & 2 ANSWERED

**Result: the mirror went from 548 rows (frozen since Aug 17) to 3358, and `npm run local-sync` now
works with no manual overrides.** The baseline table further down is superseded but kept as the
historical record.

**Four independent blockers, each hiding the next.** The sync had not run since Aug 17 because it
*could not* run — and nothing automates it, so nothing ever reported the failure:

| # | Blocker | Fix |
|---|---|---|
| 1 | `npm run local-sync` never loaded `.env` (plain `node`, and the script does no env loading), so the documented invocation died instantly on `UPSTASH_REDIS_REST_URL not set` | `package.json` → `node --env-file-if-exists=.env …` |
| 2 | `local-sync` requires `UPSTASH_REDIS_REST_READONLY_TOKEN` and deliberately refuses the write token. Under the local-Redis switch that variable still held the **hosted Upstash** credential, which the shim rejects → bare `Unauthorized` | `.env` (gitignored): hosted value commented with the `[switched-to-local-redis]` marker, local value added to the local block with the rationale |
| 3 | `SCAN … WITHTYPE` is an **Upstash extension, not a Redis command** — real redis-server answers `ERR syntax error` | `local-sync.mjs`: probe the capability once per run, fall back to a pipelined `TYPE` pass |
| 4 | The shim ignored `Upstash-Encoding: base64` while `@upstash/redis` **sends that header by default and decodes unconditionally** | `docker/redis-rest-proxy.mjs`: implement the encoding (bind-mounted — `docker restart worldmonitor-redis-rest`, no rebuild) |

**Blocker 4 is the one that matters beyond this initiative.** It silently corrupted any value that
happened to be *valid base64*, and left everything else untouched — the SDK's `base64decode()` returns
non-base64 input unchanged, and every Redis key here contains `:`, so keys always survived and the shim
looked correct. SCAN cursors exposed it because roughly a quarter of them have a length divisible by 4:
cursor `32208` (5 chars) passed through, the next page's `3432` decoded to 3 junk bytes, and the
following SCAN died on `ERR invalid cursor` — which is why it failed on page 2 rather than page 0.
**Eight source files use the SDK**, including `server/_shared/rate-limit.ts` and the OAuth token/code
paths, where values are base64url *by construction*. Raw-REST callers (seeders, `server/_shared/redis.ts`)
never sent the header and were never affected. Verified with a round-trip test over plain strings,
valid-base64 strings, base64url tokens, JSON, unicode and numeric `INCR` — 6/6, against a known-failing
before-state.

**Re-measured baseline, 2026-08-21** (local Redis; SCAN iterated to cursor 0):

| prefix | Redis | mirrored | | prefix | Redis | mirrored |
|---|---|---|---|---|---|---|
| `intelligence:` | 1566 | 1566 | | `classify:` | 47 | 47 |
| `energy:` | 590 | 590 | | `forecast:` | 23 | 23 |
| `resilience:` | 407 | 407 | | `summary:` | 22 | 22 |
| `market:` | 310 | 310 | | `climate:` | 5 | 5 |
| `supply_chain:` | 196 | 196 | | `portwatch:` | 2 | 2 |
| `rss:` | 102 | 102 | | `theater-posture:` | 2 | 2 |
| `economic:` | 79 | 79 | | `theater_posture:` | 1 | 1 |
| | | | | **`risk:`** | **0** | **0** |

**Question 1 answered**: not a scan/pagination limit and not a TTL rule — the six "zero-row" prefixes
were empty because the sync had been broken since Aug 17. All now mirror 1:1. `supply_chain:` at 3 rows
was not truncation either; it is 196 now.

**Question 2 answered**: `summary:` and `classify:` land correctly and hold real content
(`{"level":"high","category":"infrastructure",…}`). Their counts grew between two runs minutes apart,
which is independent evidence the LLM pipeline is live.

### Questions 3, 4 and 5 — ALL CLOSED

**Q5 (dev-vs-prod source) — verified end to end, not merely by reading the wiring.** Ran the sidecar
against the real mirror: `[sidecar-cache] loaded 3358 keys`, and
`/api/intelligence/v1/list-cross-source-signals` returned HTTP 200 with real signal data. The whole
chain is live: Redis → `local-sync.mjs` → `local-cache.db` → `sidecar-cache.ts` → RPC.
`sidecarProcess.ts:114` points `LOCAL_SQLITE_PATH` at exactly the file `local-sync` writes by default.
**Asymmetry worth knowing**: the WRITER defaults that path, the READER does not — `loadMirror()` returns
an empty mirror if `LOCAL_SQLITE_PATH` is unset, so a hand-started sidecar silently serves nothing.

**Q4 (freshness/TTL) — closed, and it was a real gap.** `synced_at` was written on every row since the
mirror existed and **read by nothing** — `loadMirror()` did not even SELECT it. That is precisely how a
four-day-old mirror looked identical to a fresh one. The loader now reports the age and warns past 24h.
It deliberately does **not** expire rows: serving a stale mirror is the point of an offline operator
cache, and "static for the process's lifetime" is a documented, intentional tradeoff. Verified against a
fixture in both directions — fresh logs `synced 14m ago` silently, a copy aged four days logs
`synced 4d ago` plus the warning.

**Q3 (automation) — a launchd agent, per operator decision.** `scripts/install-local-sync-agent.sh`
installs `com.worldmonitor.local-sync` (LaunchAgent, user domain — it writes into the operator's repo, so
a root LaunchDaemon would leave root-owned files in the tree; that is the one deliberate difference from
`com.worldmonitor.firms-vpn-bypass`). `RunAtLoad` + 900s. **Explicitly NOT tied to VS Code extension
start/stop** — the mirror is a property of the machine, and a lifecycle hook is where this class of
failure hides. Verified live: `runs=1 exit 0` on load, and a temporary 60s interval proved `runs=2`, so
the timer fires and not merely `RunAtLoad`.

**Automating it forced a second fix.** The rebuild opened the LIVE database and began with an
auto-committing `DELETE FROM kv_cache`, so any failure after that point left an empty or partial mirror
— *and stamped it with a fresh `synced_at`, so the new staleness warning would have called the wreckage
healthy*. Now staged into `<path>.tmp` and renamed only on full success. Proven by killing a run
mid-flight: live mirror byte-identical, while the abandoned scratch held 622 KB of a 4.6 MB rebuild —
about 13%, which under the old code would have *been* the mirror. Rename was chosen over one big
transaction because a multi-second write txn blocks the sidecar's read-only opener and `loadMirror()`
swallows that into an EMPTY mirror.

**The source stays env-driven.** The agent runs the ordinary `local-sync` entry point and reads
`UPSTASH_REDIS_REST_URL` from `.env` — Upstash in production, local Docker Redis in dev. A second
selector (`LOCAL_SYNC_REDIS_*`) was considered and **rejected by the operator**: configuration already
answers this, and code must never branch on which Redis is in use. See
`redis_env_not_codebase_switch.md`.

### ⚠ `pkill -f local-api-server` kills the OPERATOR'S extension sidecar

Learned the hard way 2026-08-21. Test sidecars share the script path with the one VS Code spawns
(`Code Helper (Plugin) … local-api-server.mjs`, normally port **46123**), so a pattern kill hits both.

**It misdiagnoses as a data problem.** The dashboard keeps rendering — the ServiceWorker serves HTML/JS
from cache and cached panels still show values — so only the Network tab shows the truth: every `fetch`
is `net::ERR_CONNECTION_REFUSED` while scripts are 200 `(ServiceWorker)`.

Kill probes by captured PID or by port instead. And treat ERR_CONNECTION_REFUSED on *every* fetch as
"nothing is listening", never as missing data — a mirror gap yields 200s with empty payloads.

### ✅ FIXED — panels with data in the browser but empty in the VS Code sidecar

**Cause: the mirror is prefix-filtered and 27 data prefixes were missing.** The browser reads live
Redis; the sidecar reads only `local-cache.db`. Any prefix absent from `SYNC_PREFIXES` is invisible
there, silently. Audited all 59 top-level prefixes in Redis (23,351 keys) against every
`server/worldmonitor/*/v1` handler — **19 domains** were reading at least one unmirrored prefix.
15 prefixes → 42; mirror 3,357 → 4,042 rows.

- **trade policies**: `trade:` (418 keys) + `comtrade:` (55) entirely unmirrored.
- **supply-chain**: partial rather than blank — its `supply_chain:` keys were mirrored, only its
  `comtrade:` half was missing.

**Classify prefixes by READING their keys, never by name.** `acled:` looks exactly like a data prefix
and is deliberately EXCLUDED: its only key is **`acled:oauth:token`, a credential** — mirroring it
would copy an OAuth token onto the operator's laptop and defeat the read-only-token rationale in
`assertEnv()`. `wm:` is notification dedup / events queue / locks. Verified post-sync that `acled:`,
`wm:`, `story:`, `cache:`, `digest:`, `baseline:` and `seed-*` all hold **0 rows**.

`brief:` is the **only user-scoped prefix**, and is filtered rather than mirrored wholesale (operator
decision, 2026-08-21). The sidecar records the operator's Supabase user id — obtained from the bearer
the dashboard derives by exchanging the **VS Code GitHub session token** — to
`vscode-extension/sidecar/operator-identity.json` (gitignored, beside the mirror, the one path both the
sidecar and the headless agent compute identically). `local-sync` then mirrors `brief:llm:*` plus only
that user's rows.

Claims are decoded, not cryptographically verified, and need not be: recording runs only on the
`/api/*` dispatch path (static responses return earlier) and is gated on a **non-error status**, so the
handler having accepted the request stands in for validation — measured, a correctly-shaped bearer with
a bad signature 401s from intelligence, seismology, trade and research alike and records nothing. `exp`
and `iss` are checked regardless.

**Cold start is fail-closed**: with no recorded identity, *no* user-scoped brief is mirrored at all
rather than guessing. Self-heals on the agent's next run after one authenticated request. Verified in
four states — no identity (29 keys, 9 skipped), wrong uuid (29, still skipped), correct uuid (38, 0
skipped), and expired/foreign-issuer/bad-signature tokens never recorded.

**Two categories that a prefix will never fix** (both verified, do not chase as mirror bugs):

1. **Premium-gated RPCs.** `get-tariff-trends` and `list-comtrade-flows` return
   `{..., fetchedAt: '', upstreamUnavailable: true}` for a non-premium caller. The empty `fetchedAt`
   is the tell — the cache-miss path stamps a real timestamp. Their keys ARE mirrored (159 tariff
   rows), so they populate for a signed-in operator.
2. **Fetch-through caches with PREFIXLESS keys.** `get-cable-health` uses
   `cachedFetchJson('cable-health-v1', …)`; no `*cable*` key has ever existed in Redis. Every entry in
   `SYNC_PREFIXES` ends in `:`, so a prefixless key can never be mirrored — and a fetch-through path
   cannot work offline regardless. If more panels turn out to depend on such keys, that is a design
   question about the mirror, not a list to extend.

`conflict/v1/list-acled-events` returning `[]` is the known ACLED account-tier block, not this.

### ✅ TRIAGED — `npm run build` failing on a clean tree (was "pre-existing, untriaged")

**It is not a code bug, and `dist/` was unusable because of it.** `dist/` held only prerendered SEO
pages and public files — **no `dashboard.html`, no `assets/`** — so the VS Code extension would have
404'd the dashboard. Prior sessions recorded this as "`npx vite build` fails on a clean tree (hreflang
alternates anchor, pre-existing, untriaged), don't use it as a verification step."

**Root cause: a build-time `APP_DOMAIN` mismatch.** The `wm-variant-dashboard-html` plugin rewrites the
built HTML's hreflang links using a regex built from `resolveWwwOrigin(process.env.APP_DOMAIN)`
(`src/config/variant-dashboard-html.ts:89,126`). `.env` sets `APP_DOMAIN=localhost:3000` — correct and
load-bearing for the local stack — while `index.html` still carries the apex production literals. Zero
matches, and `replaceCounted` **fails closed** rather than silently emitting wrong canonical URLs. That
is the plugin behaving correctly.

**Working invocation — no tracked file changes, `.env` untouched:**

```
APP_DOMAIN=worldmonitor.app npm run build
```

Verified: exit 0, `dist/dashboard.html` (46,958 bytes) + 456 asset files, and served end to end through
the sidecar — `GET /` 200, main JS asset 200 (1.04 MB), `list-cross-source-signals` 200 with real data,
`[sidecar-cache] loaded 3357 keys ... (synced 2m ago)`.

**Trap — pass the APEX, not the `www.` host.** `resolveWwwOrigin('www.worldmonitor.app')` returns
`https://www.www.worldmonitor.app`; adding the `www.` is the function's job. Setting the `www.` form
produces the identical "matched 0 time(s)" error and looks like the fix simply didn't work.

Baking the production domain is safe for local use: `getApiBaseUrl()` returns `''` outside desktop
runtime, so the dashboard calls the sidecar same-origin. Confirmed no production API origin is
reachable from the built bundle. The alternative — running `scripts/sync-domain-literals.mjs`, which
does cover `index.html` — would rewrite tracked files and reopens the de-branding cleanup the operator
explicitly closed, so it was **not** done.

### ✅ FIXED — the VS Code extension's 401/502/503 wall (four distinct causes)

All four are VS-Code-only, and each is the same shape: **code that behaves differently purely because
the browser has Vite in front of it and the extension has the sidecar.**

1. **Every RPC 401'd** — `getConfiguredWebApiBaseUrl()` returned `VITE_WS_API_URL`
   (`http://localhost:9001`, i.e. nitric) as its FIRST statement, ahead of every runtime check. The
   embed shim attaches `x-worldmonitor-local-token` only to relative/same-origin `/api/` URLs, so a
   cross-origin call to :9001 arrived with no credentials. A browser tab is immune: served from :3000
   where Vite proxies `/api` same-origin. Fixed by returning `''` under `isVsCodeEmbedRuntime()`.

2. **Latest Brief 404** — `build:sidecar-handlers` compiled only `api/{domain}/v1/[rpc].ts`, never
   top-level `api/*.ts`. `buildRouteTable()` collects only `.js`, so 18 routes did not exist. Route
   table 53 → 70.

3. **Relay routes 502 "SSRF blocked"** — `RELAY_URL` is `http://localhost:3004`, a private origin the
   sidecar's SSRF guard rejects. Vite proxies it in the browser, so the guard is never in the path.
   Fixed narrowly: mode-gated to `tauri-sidecar`, trusting exactly ONE configured origin, mirroring
   the existing docker/Redis allowance rather than opening a general env-driven allowlist.

4. **bootstrap / gpsjam 503** — `api/_upstash-json.js`'s two sidecar branches did
   `await import('../server/_shared/sidecar-cache')`, a **TypeScript** path. This module is
   hand-written plain JS loaded directly by node → `ERR_MODULE_NOT_FOUND` → neither branch ever
   served a value. Now reads the mirror directly via `node:sqlite`.
   `/api/bootstrap` 503 → 200 (628 KB fast / 1.47 MB slow), `/api/gpsjam` 503 → 200 (245 KB).

**The trap worth carrying forward (cause 4).** The sidecar loads TWO kinds of route and they have
OPPOSITE module-resolution behaviour:

| route kind | example | can import `.ts`? |
|---|---|---|
| esbuild bundle | `api/{domain}/v1/[rpc].js` | **yes** — esbuild inlines it |
| hand-written plain JS | `api/bootstrap.js`, `api/_upstash-json.js` | **no** — plain node, ERR_MODULE_NOT_FOUND |

So identical-looking sidecar code works in one and silently fails in the other. **Never assume a
`sidecar-cache` import works because the same line works elsewhere** — check which kind of file it is.

### ⚠ The sidecar runs PREBUILT bundles, not your source

`local-api-server.mjs` imports `api/{domain}/v1/[rpc].js` — gitignored esbuild bundles that embed a
**copy of `server/_shared/`**. They were dated **Aug 8** here, so the sidecar had been serving a
two-week-old snapshot of shared server code, including every fix from sessions 30-32. Nothing rebuilds
them automatically.

**Run `npm run build:sidecar-handlers` after touching anything under `server/_shared/`, or your change is
simply not live in the sidecar** — and it will fail in a way that looks like the fix didn't work.
(Distinct from nitric, where tsx resolves the sibling `.ts` first and source edits ARE live.)

### Still open here

- **`risk:` has 0 keys in Redis.** Real prefix — `risk:scores:sebuf:v8` in `server/_shared/cache-keys.ts`.
  Everything found so far only *reads* it; the writer was not identified. Determine whether it is
  seeded, computed on demand, or genuinely dead. **Not a sync bug** — the mirror is faithful, and
  `get-risk-scores` still returns 200.
- **No regression test covers the shim's base64 encoding**, nor the mirror-age warning. Both need
  fixtures/containers; flagged rather than half-built. `test:sidecar` is the suite they belong to.
- **The agent's node path is nvm-versioned** (`~/.nvm/versions/node/v22.16.0/bin/node`). A node upgrade
  breaks it silently — launchd logs "No such file or directory" to
  `/tmp/com.worldmonitor.local-sync.log` and nothing else mentions it. Re-run the installer after
  upgrading node.
- A resync does **not** reach a running sidecar; the mirror is read once per process. Restarting the
  sidecar is still required to see fresh data.
- Re-check: `seed-cross-source-signals` is **absent from `scripts/railway-services.json`** but is NOT an
  orphan — `seed-bundle-derived-signals.mjs:6` invokes it. Recording it so the next registry sweep does
  not "fix" it. (Same name-match trap as session 32.)


**The chain**: Upstash Redis (production) / local Redis (dev) → `vscode-extension/sidecar/local-sync.mjs`
→ `vscode-extension/sidecar/local-cache.db` (`node:sqlite`, table `kv_cache`) → the sidecar's
`local-api-server.mjs` → the VS Code dashboard. Read side also touches
`server/_shared/sidecar-cache.ts` and `vscode-extension/src/sidecarProcess.ts`.
`SQLITE_PATH = process.env.LOCAL_SQLITE_PATH || <sidecar>/local-cache.db`.

**Operator principle that constrains any design discussion** (do not re-litigate): Upstash =
production, local Redis = dev, **switched by ENV (`UPSTASH_REDIS_REST_URL`), never by codebase logic.**

**Measured baseline, 2026-08-21** — `local-cache.db` holds **548 rows** in one table (`kv_cache`;
columns `key, value, type, synced_at`), last written **Aug 17**:

| prefix | rows | | prefix | rows |
|---|---|---|---|---|
| `intelligence:` | 300 | | `portwatch:` | 1 |
| `resilience:` | 102 | | `theater_posture:` | 1 |
| `energy:` | 100 | | **`summary:`** | **0** |
| `economic:` | 41 | | **`classify:`** | **0** |
| `supply_chain:` | 3 | | | |

**Concrete questions this baseline already raises** (all unverified — start here):
1. **7 of 15 `SYNC_PREFIXES` have ZERO rows**: `market:`, `climate:`, `risk:`, `rss:`, `forecast:`,
   `theater-posture:` (hyphen — the underscore twin *did* sync), and `supply_chain:` at 3 rows looks
   truncated. Some may simply have had no Redis keys on Aug 17, but `rss:`, `market:` and `forecast:`
   demonstrably have keys now. Is this a scan/pagination limit, a TTL/skip rule, or genuinely empty?
2. **`summary:` / `classify:` are still 0.** The session-30 fix that added them to `SYNC_PREFIXES` is
   in the working tree but **`local-sync` has not been run since** (db Aug 17 vs. fix Aug 20). These
   are the content-hash-keyed LLM outputs — the whole economic point of a shared cache, since two
   operators reading the same article derive the same key and one model call serves both. Re-run and
   confirm they land.
3. **Nothing automates the sync.** It is a manual `npm run local-sync` (`package.json:37`). Decide
   whether that is intended (the file's own header calls it a "one-way, periodic pull") or whether it
   needs a cadence — and if so, whether it belongs in the scheduler alongside the seeders.
4. **No freshness/TTL story is verified.** `synced_at` exists per row; nothing observed reads it. What
   happens when a mirrored row outlives its Redis TTL — does the sidecar serve indefinitely-stale data?
5. **Confirm the dev-vs-prod source.** In dev, `local-sync` will pull from whatever
   `UPSTASH_REDIS_REST_URL` points at — currently the LOCAL redis proxy. Verify the operator's SQLite
   is being fed from the source they expect, and that the `# [switched-to-local-redis]` marker in
   `.env` is the only switch involved.

**Read before starting**: memory `local_redis_dev_stack.md`, `redis_env_not_codebase_switch.md`,
`nitric_local_data_layer_lessons.md`, `local_pipeline_and_vscode_dagu_plan.md`
(**do NOT delete any `dist/` — the sidecar serves it directly**), and `supabase_migration_stage1.md`
(Rust-side `LOCAL_SQLITE_PATH` wiring + the stage-5 MCP/"local Agent" half are still open).

**Traps that apply directly to this work**: iterate `SCAN` to cursor 0 or you get a false "0 keys";
`EXISTS <prefix>` is meaningless when handlers compose `prefix:a:b` keys — check how the key is built
before testing for it; and `node --env-file` does not expand `${VAR}`.

---


## 🔀 HANDOFF (2026-08-20, THIRTIETH session end)

**Scope**: picked up the twenty-ninth session's one open item (RSS panels never load) and resolved it,
then followed the consequences through **three more independent bugs that were masking each other**.
Dashboard now renders news across all regional panels and the console's 429 flood is gone
(operator-confirmed). Handing off **4 panels with no data + 2 console errors**, all triaged to a root
cause below — none of them started.

**Git state**: 0 commits (operator's standing manual-commit discipline held). Working tree:
`M .env.example`, `M TASKS.md`, `M scripts/_proxy-utils.cjs`, `M scripts/ais-relay.cjs`,
`M scripts/fetch-gpsjam.mjs`, `M scripts/lib/supabase-admin.cjs`, `M server/_shared/direct-llm-quota.ts`,
`M server/_shared/rate-limit.ts`, `M server/_shared/supabase-admin.ts`, `M server/gateway.ts`,
`M server/worldmonitor/news/v1/list-feed-digest.ts`, `M vscode-extension/sidecar/local-sync.mjs`,
`?? docker-compose.dev.yml`, `?? docker/`. `.env` also changed (gitignored). `npx tsc --noEmit` clean on
all three tsconfigs.

### THE BIG LESSON OF THIS SESSION — one symptom, four independent causes

The news panels being empty was NOT one bug. Fixing each one exposed the next, and **each fix made the
next symptom louder**, which repeatedly looked like regression:

1. **RSS routing** — feed hosts split-tunneled outside the VPN, ECONNRESET. Fixed with a
   `PROXY_URL` fallback in the relay's RSS path.
2. **Batch deadline** — the digest could only fetch ~20 of 190 feeds. Fixed with env-tunable timeouts.
   *Fixing #1 did not help until #2 was also fixed.*
3. **Rate limiter** — all local traffic shares one `ip:unknown` bucket. Fixed with `RATE_LIMIT_LOCAL_DEV`.
   *Only became visible once #2 made the app actually fetch things.*
4. **Daily LLM quota (50/user/day)** — the real source of the surviving 429s. Fixed via
   `DIRECT_LLM_DAILY_QUOTA_LIMIT=unlimited`. *Bypassing #3 changed nothing because #4 was never involved.*

**Generalizable**: `429` is a status code, not a diagnosis — this app has three independent throttles
that all return it. And **a fix that increases throughput can push a different subsystem past a limit
it was never near before**; when errors get louder right after a fix, check that first.

---

## OPEN ITEMS HANDED OFF (all triaged, none started)

### A. [RESOLVED 2026-08-20, thirty-first session] `classify-event` 500s on any headline containing a literal `%`

**resolved**: patched `@nitric/sdk@1.4.2` via `patch-package` — `patches/@nitric+sdk+1.4.2.patch`,
applied by a new `"postinstall": "patch-package"` script. Not committed (manual-commit discipline).
Full rationale + evidence in `patches/README.md`.

**The triage below was right about the mechanism but understated the damage.** The redundant
`decodeURIComponent` was not only crashing on `%` — it was **silently corrupting every well-formed
percent-escape too**. Measured on the wire, pre-patch: `?title=a%2520b` reached the handler as
`a b` (two decodes). So a query param carrying a URL, or any text containing `%20`/`%26`, arrived
mangled with no error at all. That is why the fix is to **remove** the decode rather than wrap it in
`try/catch` — a catch stops the crash but leaves the corruption.

**Proof the membrane already decodes** (so removing it is safe, not a guess):
- Structural: in the same SDK function, **headers and path params are not decoded** — only query
  params were. If values arrived raw, all three would need decoding.
- Empirical, post-patch: `?title=a%2520b` → `a%20b` (correct, single decode) while an ordinary
  `?title=x%20y` → `x y` (still decoded correctly, by the membrane).

**Verified**: `%25` titles now return `401` exactly like plain ones (was `500`); a URL-valued param
round-trips intact; `npx tsc --noEmit` clean on all three tsconfigs; `npx patch-package` re-applies
idempotently; `URIError` count in the nitric log went 6 → 0.

**Fix options closed out**: "check whether a newer `@nitric/sdk` fixes it" is a dead end — **1.4.2 IS
the latest published version**. The POST-with-body option was rejected: it would fix one endpoint
while leaving the silent corruption on the other 86 routes.

**Left deliberately unpatched**: the identical pattern in `WebsocketNotificationContext`
(`lib/index.js` ~15565). Same bug class, but this repo doesn't use Nitric websockets so the membrane's
behaviour there was never verified. Verify before patching.

**Correction to the triage below**: the note that a repo-side guard "is not possible" is right about
the handler layer, but `adapt-vercel-handler.ts` is a viable instrumentation point — logging
`ctx.req.query` there for one request is what settled the double-decode question in seconds. Worth
remembering as a probe point, not a fix point.

---

<details>
<summary>Original triage (kept for the trail)</summary>


**The browser reports CORS; the truth is a 500.** The error response carries no
`Access-Control-Allow-Origin` because the request dies **before any repo code runs**, so the gateway
never attaches CORS headers. Do not go looking for a CORS misconfiguration — preflight is fine
(verified: `OPTIONS` with a short title returns `204` with correct headers).

**Root cause — a double-decode inside the Nitric SDK, not this repo.**
`node_modules/@nitric/sdk/lib/index.js:13720` (`@nitric/sdk@1.4.2`), in `HttpContext.fromHttpRequest`:

```js
const query = http2.getQueryParamsMap().getEntryList().reduce(
  (acc, [key, [val]]) => ({ ...acc,
    [key]: val.length === 1 ? decodeURIComponent(val[0]) : val.map(v => decodeURIComponent(v)) }), {});
```

The gRPC membrane already hands over **decoded** values; the SDK decodes them a **second** time. So
`?title=...4%25+past...` → first decode yields a bare `%` → `decodeURIComponent` throws
`URIError: URI malformed` → 500, no CORS headers. Confirmed in the nitric log with a full stack trace
ending at that SDK line.

**Bisected precisely** (every row an `Origin: http://localhost:3000` GET):

| title contains | status |
|---|---|
| plain words | 401 (expected — unauthenticated) |
| `%24` ($) only | 401 |
| `%2C` (,) only | 401 |
| full-length title, no encoded chars | 401 |
| **`%25` (literal `%`) — alone or in context** | **500** |

**Why it matters more than it looks**: financial headlines are full of percent signs ("Gold price jumps
4%"), so this fires constantly and silently drops those events from classification.

**Fix options for the next agent** (none attempted): `patch-package` on the SDK; check whether a newer
`@nitric/sdk` fixes it; or move `classify-event` to POST-with-body so the value never rides the query
string. A repo-side guard is not possible at the handler level — the throw precedes all repo code.

</details>

### B. [RESOLVED 2026-08-20, thirty-first session] Umami analytics removed entirely

**resolved**: operator chose full deletion over a local-domain guard. Umami is gone from the repo —
21 files touched, 4 deleted. Not committed (manual-commit discipline).

**Why deletion rather than a one-line guard**: the obvious minimal fix (`if (IS_LOCAL_DOMAIN) return`
in `initAnalytics()`) is NOT zero-churn. Under `node:test` `import.meta.env` is undefined, so
`IS_LOCAL_DOMAIN` is `true` in the test environment too, and `tests/secondary-startup.test.mts`
asserted `appendedScripts.length === 1`. A guard silently turns ~5 passing tests into failures, so
either path rewrites test semantics — which made it worth choosing the destination deliberately.

**The footprint was much larger than "one module"** — worth recording, because a grep for `umami`
only in `src/` would have missed most of it:
- `src/services/analytics.ts` — Umami transport removed (script loader, queue, retry ladder,
  `window.umami` beacon, the hardcoded production `data-website-id`). **The facade is kept**: ~40
  modules import it, and the file already used "keep the function, empty the body" for a dozen
  exports from an earlier de-SaaS pass. Every export survives, so no call site was touched. `EVENTS`
  is retained so event names stay a closed, compile-checked set. 534 → 415 lines.
- `server/_shared/brief-render.js` — a **second, independent** surface: it injected an Umami loader
  `<script>` into rendered magazine HTML plus an inline `brief-thread-open` click tracker. Found only
  via `tests/brief-thread-open-telemetry.test.mjs`, not from the client-side trail.
- `shared/domain-config.js` + `.d.ts` — `resolveAbacusOrigin()` (the `abacus.` collector subdomain)
  removed, then the **five** generated copies regenerated with `node scripts/sync-domain-config.mjs`
  (`api/`, `scripts/` x2, `vscode-extension/sidecar/`). `scripts/sync-domain-literals.mjs` lost its
  abacus substitution pair; `src/config/domain.ts` lost `ABACUS_ORIGIN`.
- `src/bootstrap/sentry-init.ts` — the collector host was in `THIRD_PARTY_FETCH_HOST_ALLOWLIST`
  (dropped beacons were being suppressed from Sentry). Removed.
- `src/vite-env.d.ts` (`window.umami` global), `index.html` (stale explainer comment),
  `Dockerfile.digest-notifications` + `ARCHITECTURE.md` (doc references).
- **Deleted**: `.github/workflows/analytics-collector-monitor.yml` (15-min cron probing the
  collector), `scripts/check-analytics-collector.mjs`, `tests/analytics-collector-monitor.test.mjs`,
  `tests/analytics-beacon-rejection.test.mts`.
- Trimmed: `tests/secondary-startup.test.mts` (466 → 150), `tests/brief-thread-open-telemetry.test.mjs`
  (487 → 208), `tests/sentry-beforesend.test.mjs`, `e2e/secondary-startup.spec.ts`.

**Verified**: `npx tsc --noEmit` clean on all three tsconfigs; `node scripts/sync-domain-config.mjs
--check` reports the 5 copies in sync; the Vite-served `src/services/analytics.ts` and `index.html`
both contain **zero** `umami`/`script.js` references, so the 404 cannot recur. Test deltas are
removals only, no regressions: secondary-startup 13→8 pass/0 fail, sentry-beforesend 225→222 pass/0
fail, brief-thread-open-telemetry 21 pass+1 fail → 9 pass/0 fail (**that pre-existing failure was
inside a removed block — it went away by deletion, it was not fixed**), signup-analytics-gate 13/13
unchanged. 33 test files touching the changed modules were run; the only failures
(`brief-magazine-render`, `brief-edge-route-smoke`, `china-coverage-health`, `mcp-resources`) were
confirmed **pre-existing** by a full `git stash` A/B against clean HEAD.

**Deliberately left in place** (flagged, not decided):
- The `data-thread-open` / `data-country` / `data-severity` / `data-followed` attributes still
  stamped on magazine source-links. They now have no consumer, but removing them cascades into the
  recipient-watchlist "followed" computation, which is real product logic with its own tests.
- `e2e/secondary-startup.spec.ts` **lost its positive control**: the deferred Umami request was the
  one request that environment reliably produced after idle, so the spec is now negative-only. A
  NOTE in the file says so. This is exactly the session-30 trap — a test that cannot produce a
  positive proves nothing — so do not read a green run there as proof the deferred loader fired.

**Separately discovered, NOT caused by this work**: `npx vite build` fails at HEAD with
`[wm-variant-dashboard-html] anchor "hreflang alternates" matched 0 time(s)`. Confirmed pre-existing
via `git stash` A/B — **the production build is currently broken on a clean tree.** Not triaged.

---

<details>
<summary>Original triage (kept for the trail)</summary>


Cosmetic, self-inflicted by de-branding. `src/services/analytics.ts:13` builds
``UMAMI_SCRIPT_SRC = `${ABACUS_ORIGIN}/script.js` ``, and `ABACUS_ORIGIN` derives from
`VITE_APP_DOMAIN`, which is **unset** in this fork — so it resolves to the local dev origin and Vite
answers `/script.js` with `index.html` (hence the MIME complaint). It self-limits:
`UMAMI_LOAD_ATTEMPT_LIMIT = 2`, then stops.

Umami is SaaS analytics with a hardcoded production `UMAMI_WEBSITE_ID`
(`e8800335-…`) — almost certainly **dead weight in an internal fork**, and a candidate for deletion
rather than configuration (consistent with the SaaS-cruft removal already done in earlier sessions).
Minimal alternative: early-return from `initAnalytics()` when the domain is local
(`IS_LOCAL_DOMAIN` already exists in `src/config/domain.ts`).

### C. [PARTLY RESOLVED 2026-08-20, thirty-first session] Panels with no data

**Two of them resolved, and the triage below was wrong about both.** Root cause for each was an
**orphaned seeder** — a working script that nothing ever invoked — not a render/RPC bug.

**预测 (Predictions)** reads `prediction:markets-bootstrap:v1` via `list-prediction-markets`. Redis
had **0** `prediction:*` keys. `scripts/seed-prediction-markets.mjs` existed but was referenced
**nowhere** — not in `railway-services.json`, not in any bundle, not in any npm script; the only
mentions anywhere were code comments. **The triage below looked at the wrong dataset**: it counted
`forecast:*` keys (36) and concluded "data exists → render bug", but this panel renders
`PredictionMarket[]` from the **`prediction`** domain, not `forecast:predictions:v2`.
Compounding it, `PredictionPanel.renderPredictions()` calls `showError(failedPredictions)` when
`data.length === 0` — **an empty list is displayed as a load failure**, which disguised a
never-seeded key as a fetch error.

**经济指标 (Economic Indicators)** — the client asks for FRED series `DGS2`, `DGS10`, `DGS30`
(`data-loader.ts:2210`). Redis held only **5** `economic:fred:*` keys, all European (ESTR,
EURIBOR3M/6M/1Y, GSCPI) written by the scheduled `seed-bundle-ecb-eu`. The US series come from
`scripts/seed-economy.mjs` — **also orphaned**. So `fredData.length === 0` → "上游API不可用".

**Why the triage said "29 keys present, so it's a render bug"**: running the orphaned seeder by hand
restores **exactly 29** `economic:fred:*` keys. Whoever observed 29 had run it manually; the keys
carry a TTL (26h) and nothing re-seeds them, so they decayed to 5. **A key count is a snapshot, not
proof of a working pipeline** — "data is in Redis" and "something keeps putting data in Redis" are
different claims, and only the second keeps a panel alive.

**Fixed durably** (not just re-seeded):
- Both seeders added to `scripts/railway-services.json` (`nixpacks-root-repo`, with `requiredEnv`).
- Cadences added in `gcp/scheduler/main.ts`, each following the repo's TTL = 6x-interval rule:
  `seed-economy` **hourly** (`STRESS_INDEX_TTL` 21600 = 6h, same TTL/cadence as `seed-forecasts`),
  `seed-prediction-markets` **every 30 min** (`CACHE_TTL` 10800 = 3h, a figure the constant's own
  comment already documents as "6x the 30 min cron interval").
- Ran both once: `seed-economy` 15.8s (FRED 5 → **29** keys, plus macro-signals, crude-inventories,
  stress-index), `seed-prediction-markets` 34.5s (272 raw markets → **75** stored, 25 each across
  geopolitical/tech/finance). `prediction:markets-bootstrap:v1` now exists.

**The guard that should have caught this was nearly inert.** `tests/railway-services-registry-coverage.test.mts`
checks "every script header-documented Railway service is registered" — but it only inspects scripts
that opt in by carrying a `//   - Service name: <x>` line, and **only 3 of 318 scripts did**. A script
that was never registered also never documented itself, so the one failure mode the test exists to
catch is the one it structurally cannot see. Both seeders now carry that header (3 → 5 covered), so
removing either from the registry fails the test loudly. **Widening that guard to all
`scripts/seed-*.mjs` would likely surface more orphans — not attempted, worth doing.**

**Verified**: `npx tsc --noEmit` clean on all three tsconfigs; the scheduler reloaded without
throwing its "no cadence registered" build-time error; registry-coverage test unchanged at 8 pass /
1 fail (that failure is the pre-existing Dockerfile-CMD one).

**Still open from this item**: 供应链 (supply chain, 181 keys — untouched this session) and 贸易政策
(WTO, 0 keys, never seeded — check whether it too is an orphaned seeder rather than a missing one).

**Not a bug**: PREMIUM STOCK ANALYSIS / PREMIUM BACKTESTING showing "waiting for eligible watchlist
symbols" is correct behaviour for an empty watchlist, not missing data.

---

<details>
<summary>Original triage (kept for the trail — note it misidentified both datasets)</summary>


Verified what is actually in Redis for each — this is the part that saves the next agent an hour:

| Panel | Redis | Diagnosis |
|---|---|---|
| 经济指标 (FRED) | **29 keys** present (`economic:fred:v1:*`) | data exists, panel shows "尚无指标数据 – FRED可能正在加载" → **render/RPC path bug** |
| 预测 (forecast) | **36 keys** present (`forecast:predictions:v2` etc.) | data exists, panel shows "加载预测失败" → **render/RPC path bug** |
| 供应链 (supply chain) | **181 keys** present (`supply_chain:portwatch-ports:v1:*`) | data exists, panel shows "No data" → **render/RPC path bug** |
| 贸易政策 (WTO) | **0 keys** | genuinely never seeded — panel is telling the truth; needs a seeder, not a fix |

The first three are one class: the data is present and the rendering path is not reaching it. Worth
checking whether they share an RPC or a common client cache. **Note the `classify-event` bug in (A) may
be implicated** — several panels classify their items before display.

**Useful for testing any of these**: `X-WorldMonitor-Key: $WORLDMONITOR_RELAY_KEY` authenticates against
the API (returns 200 on `list-feed-digest`); the same value in `X-Api-Key` returns 401. Not every
endpoint accepts it — `classify-event` does not, which invalidated two of my own test runs.

</details>

### D. [RESOLVED 2026-08-20, thirty-first session] Two dead RSS feeds (news24 403, eia.gov 404)

Reported as console errors from `/api/rss-proxy`. **Neither was a code bug** — the proxy was
faithfully passing upstream status through, and both hosts are correctly allowlisted.

- **`feeds.news24.com`** → 403 with a `<title>Just a moment` body: a **Cloudflare bot challenge**.
  Confirmed not IP-based — it 403s from the residential IP *and* through `PROXY_URL` (Decodo), so no
  proxy fallback recovers it. Same failure mode as the `blockworks.co` case already locked out by
  `tests/feeds-client-server-parity.test.mjs`.
- **`www.eia.gov/rss/press_room.xml`** → plain 404; that feed path no longer exists.

**Fixed by replacing the URLs (names left untouched — feed names are keys in
`shared/source-provenance-declarations.ts` and the parity test)**:
- News24 → `news.google.com/rss/search?q=site:news24.com+when:1d&hl=en-ZA&gl=ZA&ceid=ZA:en`, in
  **both** `src/config/feeds.ts` and `server/worldmonitor/news/v1/_feeds.ts` (via `gnLocale`). Both
  sides were required: `News24` is not in the parity test's `KNOWN_DRIFTS`, so changing only the
  client would have failed the build on new routing drift. The test is designed to force exactly this.
- EIA → `www.eia.gov/rss/todayinenergy.xml`, in the two client entries (`EIA Reports`,
  `EIA Press Room`). The server side already used a `gn('site:eia.gov …')` workaround — **the two
  feed lists had silently drifted**, and `EIA Reports` is a grandfathered `KNOWN_DRIFTS` entry, so it
  stays a drift and the test still passes.

**Verified live** through the app's own relay (`X-Cache: MISS`, i.e. real fetches, not cached
artifacts): EIA 18 items, News24-via-Google-News 99 items. Parity test still 5/5; tsc clean.

**Related but NOT the same class — `www.atlanticcouncil.org` 403s intermittently.** Worth recording
because the obvious inference is wrong: the feed is healthy (200 + 174 KB of valid RSS direct, via
`PROXY_URL`, and from a bare Node `https.get` using the relay's exact headers). The relay's own log
shows it succeeding (`relay_status=200`) and only *then* 403ing — a Fastly/Varnish edge response
(`Error 54113`), i.e. **rate limiting of a burst, not a block**. Atlantic Council appears in **two**
categories in each feed list, so a dashboard load requests the same URL twice in quick succession;
repeated probing during debugging makes it worse. The relay handles it correctly — exponential
backoff (60s → 120s → 240s) and `X-Cache: BACKOFF-STALE` from cache — so no data is lost. Left alone.
A possible improvement, not attempted: in-flight request coalescing in the relay, so N simultaneous
requests for the same feed URL produce one upstream fetch.

Note: `feeds.news24.com` deliberately remains in the three `rss-allowed-domains` files — an allowlist
entry for a host we no longer request is harmless, and removing it risks the relay-only/allowlist
parity invariant asserted in `api/rss-proxy.test.mjs`.


</details>

---

### E. [RESOLVED 2026-08-21, thirty-first session] Premium Stock Analysis / Backtesting empty — TWO independent Yahoo blockers

Panels showed "Stock analysis is waiting for eligible watchlist symbols" **even with NVDA saved to the
watchlist**. The watchlist was never the problem: `STOCK_ANALYSIS_FREE_LIMIT` is 4 and the list is
topped up from defaults, so targets always resolve. The real condition at `data-loader.ts:1649` is
`results.length === 0`, and `runThrottledTargetRequests` only keeps results where `result.available`
is true **and silently swallows every error** (`catch {}`) — so any upstream failure surfaces as a
message naming the one cause already ruled out. Third panel this session whose empty state asserts a
cause it never checked (see items C and D).

`available:false` came from `fetchFreshAnalysis()` returning null. Two *independent* upstream failures,
each needing its own fix:

**1. `quoteSummary` → 401 `{"code":"Unauthorized","description":"Invalid Crumb"}`.** Yahoo requires a
CSRF crumb plus the cookie the crumb is bound to. **Not IP-related** — identical 401 from a residential
IP and through `PROXY_URL`, so the existing proxy fallback could never fix it, and the code comment in
`ais-relay.cjs` blaming "Railway container IPs" was wrong (corrected in place). Session 26 diagnosed
this and left it unfixed; now implemented in **both** places that call the endpoint:
- `server/worldmonitor/market/v1/analyze-stock.ts` — a cached crumb session (30 min TTL, concurrent
  misses coalesced, one refresh-and-retry on a 401).
- `scripts/ais-relay.cjs` — same flow in the relay's CJS style; the cookie is now also threaded into
  the Decodo curl fallback, since the URL carries a cookie-bound crumb.

**2. `chart` (v8) → 429, keyed to the User-Agent's PLATFORM TOKEN.** The bigger surprise. Yahoo 429s
the `Macintosh` token and serves 200 to `Windows NT` **from the same IP seconds apart, regardless of
Chrome version**:

| UA | result |
|---|---|
| `Macintosh …Chrome/131` (the shared constant) | 429 |
| `Macintosh …Chrome/139` / `…/141` | 429 |
| `Windows NT …Chrome/120` / `…/141` | 200 |

Alternating A/B, 5/5 reproducible. `server/_shared/constants.ts` held the **only Macintosh UA
definition in the repo** — every other `CHROME_UA` is already Windows/Linux. That asymmetry explains
the whole split symptom: the relay (Windows UA) reached `chart` fine and only ever hit the crumb 401,
while everything importing the shared constant was 429'd before it got anywhere. Operator chose to
update the shared constant globally; it now carries a Windows token plus the evidence in a comment.
**Recorded honestly: a per-UA throttle is a rate limit, not an auth wall — if Yahoo request volume is
the real driver this will decay again, and the durable fix is fewer/better-cached Yahoo calls.**

**A regression the test suite caught, worth remembering.** The first crumb implementation returned
`null` when the handshake failed, so a transient failure to *obtain* a crumb meant sending **no request
at all** — strictly worse than before. `tests/stock-analysis.test.mts` went 9 pass/0 fail → 4/5, and a
`git stash` A/B confirmed it was mine, not pre-existing. Fixed by degrading to an un-crumbed request
(exactly the pre-crumb baseline). **When adding an auth handshake in front of an existing call, make
handshake failure fall back to the old path rather than becoming a new hard failure.**

**Verified**: `analyzeStock('NVDA')` returns `available=true price=216.85 signal="Hold"(51)
analysts=61 target=304.12` — the analyst count and price target come *only* from the crumb path, so
they prove both fixes. Relay log: `[Market] Seeded 12/12 sectors, 12 valuations (redis: OK)`, and
Yahoo `quoteSummary` 401s went **2705 → 0** across a full restart cycle, with zero Yahoo errors of any
kind. `npx tsc --noEmit` clean on all three tsconfigs; `stock-analysis.test.mts` back to 9/0; relay
suites green (`ais-relay-rss` 7/7, health-recon 6/6, opensky-tls 2/2, dockerfile-imports 4/4).
Pre-existing failures confirmed unchanged by A/B: `premium-fetch` 18/4, `gateway-rpc-no-store-contract`
1/3, `gateway-cdn-origin-policy` 4/13.

**Also noted, not fixed**: `eia.gov/rss/todayinenergy.xml` (the replacement feed from item D) takes
**~9.2s** upstream against `api/rss-proxy.js`'s **12s** budget, so a cold fetch can 504 before the
cache warms. It succeeds and then serves from cache in 0.001s. Marginal, not broken — but if it
becomes noisy, either raise that budget for this host or pre-warm the feed.

---


### F. [RESOLVED 2026-08-21] 贸易政策 (Trade Policy / WTO) — two more orphaned seeders

`trade:*` and `comtrade:*` held **zero** keys, so the panel's "WTO data temporarily unavailable /
no tariff overview data" was honest. Same root cause as item C: two working seeders that **nothing
ever invoked** (registry=0, bundles=0, no npm script).

- `scripts/seed-supply-chain-trade.mjs` → `trade:restrictions:v1:tariff-overview:50` (the 概览 tab),
  `trade:barriers:v1:tariff-gap:50`, `trade:tariffs:v1:*`, `trade:customs-revenue:v1`.
  Needs `WTO_API_KEY` + `FRED_API_KEY` — **both already in `.env`**, so nothing was missing but the
  invocation. Ran it: 8.6 min, `trade:*` went **0 → 418 keys**.
- `scripts/seed-trade-flows.mjs` → `trade:flows:v1:{reporter}:{partner}:{years}` and
  `comtrade:flows:{reporter}:{cmd}`. Needs no API key (`COMTRADE_API_KEY` is unset and is not
  required). Ran it: 8.6 min, 102 records — `comtrade:flows*` 55 keys, `trade:flows*` 256 keys.

**Registered durably** at the cadence each script's own TTL comments already assume — read them, don't
invent one: `seed-supply-chain-trade` **every 6h** (its TTLs say "8h — 2h buffer over 6h cron
cadence"), `seed-trade-flows` **daily 04:00 UTC** (`CACHE_TTL = 259200 // 72h = 3x daily interval`,
placed off the 6h ticks since each run takes ~8.5 min). Both now carry the `// - Service name:` header,
so the registry-coverage guard covers them — **3 → 7 scripts covered** across this session.
**Do not retune those TTLs to fit a different cadence**: issue #4864's note in
`seed-supply-chain-trade.mjs` explains each data-key TTL is paired with a `maxStaleMin` and they must
move in lockstep or you open a silent EMPTY / false-STALE window.

**A false negative I nearly published**: `EXISTS trade:flows:v1` and `EXISTS comtrade:flows` both
returned 0 *after* a successful seed, which read as "the seeder didn't work". They are **key prefixes,
not keys** — the handlers build `trade:flows:v1:{reporter}:{partner}:{years}` and
`comtrade:flows:{reporter}:{cmd}`. Same shape of mistake as reading a partial `SCAN` batch as "0 keys".
**Check how the handler composes the key before testing for it.**

### G. [OPEN — needs an operator action, not a code fix] LATEST BRIEF stuck on "Your brief is composing"

Not a bug and not a seeder. The digest cron said it plainly:

```
[digest] Cron run start: 2026-08-21T03:33:36.608Z
[digest] watchlist scan: hashes=1274 candidates=21 events=0 enqueued=0
[digest] No digest rules found — nothing to do
```

The brief is **user-scoped and subscription-driven**. `api/latest-brief` returns `status:'composing'`
whenever the `brief:latest:{userId}` pointer is missing — **for any reason** — so "your brief is
composing" is the fallback for "no brief exists", not evidence anything is in flight. (Fourth panel
this session whose empty state asserts a cause it never checked.)

**Ruled out, in order** — worth recording so nobody re-walks it:
- `BRIEF_URL_SIGNING_SECRET` — **set**. (It gates compose entirely; a missing secret logs a loud
  error and returns `composeFailed: 1`.)
- `BRIEF_COMPOSE_ENABLED` — absent from `.env`, which **means enabled**: the code is
  `BRIEF_COMPOSE_DISABLED_BY_OPERATOR = process.env.BRIEF_COMPOSE_ENABLED === '0'`, so only the
  literal `'0'` disables it. (I initially misread this as a false default — check the comparison, not
  just the presence of the var.)
- `VITE_DIGEST_CRON_ENABLED` — also absent, also means enabled (`!== '0'`), so the settings UI does
  render the digest options.
- Supabase access — fine. `fetchDigestRules()` returned **0** cleanly, no error, so the
  `worldmonitor.alert_rules` table is simply empty (consistent with the memory note that all 8 tables
  had 0 rows — these features have never been exercised in this fork).

**What actually unblocks it** (operator action):
1. Settings → Notifications → digest mode → **Daily digest** (writes the `alert_rules` row via
   `setDigestSettings`).
2. Then run `node --env-file=.env scripts/seed-digest-notifications.mjs`, or restart nitric.
   **Locally the digest is NOT on a timer**: `nitric.yaml` starts it with `node $SERVICE_PATH`, so it
   performs one run at startup and exits (`pgrep` confirms it is not resident). It is neither in
   `CADENCES` nor in `ALWAYS_ON_NOT_SCHEDULED` — it is a `dockerfile`-mode entry, so the scheduler
   never touches it.

**The step that actually trips people up — `isDue()` is an EXACT hour match**, not a "has enough time
passed" check:

```js
const primaryHour = rule.digestHour ?? 8;          // default 08:00
const localHour   = toLocalHour(nowMs, rule.digestTimezone ?? 'UTC');
if (localHour !== primaryHour) return false;        // ← bails immediately
```

So choosing "Daily digest" alone composes nothing unless the current hour in the rule's timezone happens to
equal its digest hour. Set the hour select (`#usDigestHour`, revealed once Delivery Mode leaves
real-time) to the **current** hour and confirm the TIMEZONE field matches, then run the digest — or
the run will correctly report "not due" and you will think the fix failed.

**UI-vs-code naming, worth writing down**: the panel section is labelled **"Delivery Mode"**, the
client/server field is `digestMode`, and the Postgres column is `digest_mode`. Three names, one
control (`<select id="usDigestMode">`). Telling an operator to "set digest mode" sends them looking
for a label that does not exist.

---


### H. [RESOLVED 2026-08-21] Settings → Notifications discarded changes on reopen — read/write variant mismatch

**Real code bug, found while trying to enable a digest for item G.** Operator reported the modal "does
not save at all" — Delivery Mode reverted to "Real-time (immediate)" every reopen. It *was* saving;
the modal was rendering a **different row than it wrote**.

`GET /api/notification-channels` → `getAlertRules(userId)` returns **every variant's row** for the
user, in no guaranteed order (it filters on `user_id` only). The modal then did
`data.alertRules?.[0]`. But all writes are variant-scoped — `setAlertRules` / `setDigestSettings` /
`setQuietHours` each send `variant: SITE_VARIANT` and the server upserts on `(user_id, variant)`.

Observed rows for this user, straight from `getAlertRules()`:

```
[0] variant="full"     enabled=false  countries:["CN"]     ← NO digestMode  ← rendered
[1] variant="finance"  enabled=true   digestMode:"daily"   ← written
```

So the modal rendered `full`, hit `digestMode ?? 'realtime'`, and showed Real-time — while Postgres
correctly held `daily` on `finance`. Every symptom follows, including the confusing one: Country Scope
showed **CN** (row [0] has it) at the same time Delivery Mode looked unsaved (row [0] lacks it).
On localhost `SITE_VARIANT` comes from `localStorage['worldmonitor-variant']`, so this reproduces for
anyone who has ever switched variants — the modal silently splits across rows.

**Fix**: new `selectRuleForVariant()` in `src/services/notification-channels.ts` — match
`rule.variant === SITE_VARIANT`, falling back to the first row so a user whose only row predates
variant scoping still sees their settings. Applied at all **three** variant-agnostic reads
(`notifications-settings.ts` ×2, `notification-channels.ts` ×1 for watchlist ticker sync — that one
was silently syncing tickers onto the wrong variant's row too).

**Verified against the live rows**: old `[0]` → `variant=full, digestMode=undefined` → dropdown
"realtime"; new → `variant=finance, digestMode=daily` → dropdown "daily". `npx tsc --noEmit` clean on
all three tsconfigs. `notification-channels-watchlist-sync` 4/0 and
`notifications-settings-country-picker` 44/0 unchanged; the three failures nearby
(`dashboard-critical-css` 7/2, `no-non-timing-safe-secret-compare` 4/1,
`notification-channels-relay-timeout` 3/1) confirmed **pre-existing** by `git stash` A/B.

**Generalizable**: when a write is scoped by a key the matching read does not filter on, the UI
appears to discard input — and it will look like a save bug while the data is sitting in the database.
**Diff the read's selector against the write's scope before touching either.** Also note the
fire-and-forget auto-save (no Save button, 800 ms debounce) means a successful write shows no
confirmation, so the screen looks identical whether the save worked or not — the DB is the only
honest witness.

---


## TRAPS CONFIRMED THIS SESSION — read before touching anything

1. **`api/*/v1/[rpc].js` are stale 1.5 MB bundles, but they are NOT what runs.**
   `gcp/api/routes.generated.ts` imports them **extensionless**, and a 445-byte `[rpc].ts` sits beside
   each one — **tsx resolves `.ts` first**, and that file imports `server/gateway` + the real handlers.
   Source edits ARE live. The `.js` files are from 2026-08-08 and contain none of this session's work.
   **Do not "fix" a working source edit by rebuilding or editing those bundles.** I nearly did.
2. **`nitric start` wedges under concurrent load.** A 700-request burst at 25-way parallelism produced
   427 connection failures and left the API answering nothing (HTTP 000 after 30s) while every process
   stayed alive. `pgrep` showed a healthy stack that was not serving; only a restart cleared it.
   **Do not load-test this stack**, and never treat "the process is running" as proof it is serving.
3. **Upstash = production, local Redis = dev, switched by environment — never by codebase logic.**
   Operator's words: *"they should be switch based on environment, not codebase logics."*
   `UPSTASH_REDIS_REST_URL` IS the switch. Do not raise it as a design decision, do not branch on it,
   and do not describe dev-points-at-local as a gap (in dev there are no other operators to share with).
4. **A negative result from a test that cannot produce a positive is not evidence.** Two of my HTTP
   tests "proved" a fix worked when they could not have detected failure (`classify-event` 401s before
   reaching the limiter; 700 requests over >120s never exceed 600 in any 60s window). Testing the module
   directly settled it in seconds.
5. **`EVAL` is NOT blocked on the local Redis proxy** (returns `{"result":1}`) — corrects a stale
   session-29 note. `Ratelimit.slidingWindow` works; any 429 from it is genuine exhaustion.
6. `node --env-file` does not expand `${VAR}`; `.env.bak*` is NOT gitignored — never write one into the repo.

---

## Environment left running

`nitric start --ci` (:9001), Vite (:3000), `scripts/ais-relay.cjs` (:3004),
`docker compose -f docker-compose.dev.yml` (redis + redis-rest on 127.0.0.1:8079), and
**`node scripts/clean-nitric-history.mjs &`** — that last one must be run alongside `nitric start`
EVERY session (5-minute `setInterval`, does not survive a reboot, nothing auto-starts it). It is
path-based (`readdirSync` + `truncateSync` each tick), so it survives a nitric restart fine.
Restart nitric after any `.env` change; Vite only needs a restart for `VITE_`-prefixed vars.

---

## 🔀 HANDOFF (2026-08-20, twenty-ninth session end) — read this first, supersedes every block below

**Git state**: 0 commits (operator's standing "commit manually" discipline held). Working tree carries
everything from sessions 26-28 plus this session's: `M .env.example`, `M TASKS.md`,
`M scripts/fetch-gpsjam.mjs`, `M scripts/lib/supabase-admin.cjs`, `M server/_shared/supabase-admin.ts`,
`?? docker-compose.dev.yml`, `?? docker/`, plus the thirtieth session's `M scripts/ais-relay.cjs` and
`M scripts/_proxy-utils.cjs`. `.env` also changed (gitignored). `npx tsc --noEmit` clean on all three
tsconfigs (`tsconfig.json`, `tsconfig.api.json`, `tsconfig.gcp.json`). Backups of `.env` are in the session scratchpad, **never** in the repo (`.env.bak*` is NOT
gitignored — re-verified this session).

### [RESOLVED 2026-08-20, thirtieth session] The REAL remaining 429s — a daily LLM spend quota

The rate-limit bypass below did not stop the 429s because a **third, independent** throttle was doing it:
`DIRECT_LLM_DAILY_QUOTA_LIMIT = 50` in `server/_shared/direct-llm-quota.ts` — **50 LLM calls per user
per day**, gating exactly five paths (`classify-event`, `deduct-situation`, `get-country-intel-brief`,
`analyze-stock`, `summarize-article`). Those are precisely the endpoints that were 429ing, and no others.

Live counters proved it: `llm:direct-usage:<uid>:2026-08-20 = 50` (pinned AT the cap) and
`:2026-08-19 = 53`. **It is keyed by UTC date, so no restart could ever clear it** — which is why three
nitric restarts appeared to change nothing. Same root driver as the other two: the digest went from 0 to
267 articles.

**Lesson: "429" is a status code, not a diagnosis.** This app has three independent throttles that all
return 429 — global per-IP sliding window, per-endpoint policy table, and this daily LLM spend quota.
Bypassing the first two changed nothing because the third was never involved.

**Fix (operator: "this is our own fork for internal tools, no longer SaaS open for public users, so no
more limit")**: `DIRECT_LLM_DAILY_QUOTA_LIMIT` is now read from env —
unset → 50 (original default, unchanged); a positive int → that budget; `0`/`off`/`unlimited` → disabled
via a new exported `DIRECT_LLM_QUOTA_DISABLED`, checked at the top of
`shouldReserveGatewayDirectLlmQuota` so the counter is never even incremented. **A malformed value falls
back to 50, not to unlimited**, so a typo can never silently uncap LLM spend. Set to `unlimited` in
`.env` under `# [internal-fork-no-llm-quota]`; documented in `.env.example`. Both exhausted counters
deleted. Verified: unset→50/false, `unlimited`→0/true, `abc`→50/false.

### IMPORTANT correction — `api/*/v1/[rpc].js` are stale, but they are NOT what runs

Earlier notes say these are gitignored build artifacts; here is the part that matters and was nearly a
false alarm. `gcp/api/routes.generated.ts` imports them **extensionless** (`from '../../api/news/v1/[rpc]'`)
and nothing imports `server/gateway.ts` directly — which looks like "the stale bundle is what serves".
It isn't: **a 445-byte `[rpc].ts` sits beside each 1.5 MB `[rpc].js`, and tsx resolves `.ts` first.**
That `.ts` imports `server/gateway` + the real handlers, so source edits ARE live. The `.js` bundles are
from 2026-08-08 and contain none of this session's work, but they are dead weight, not the served path.
**Do not "fix" a source edit that appears not to apply by rebuilding or editing these bundles.**

### [RESOLVED 2026-08-20, thirtieth session] LLM output was never mirrored to operators

Operator's question: *"why not cached so it can share to all our operators on their own local sqlite db?
so no repeat same things for every single operator?"* — correct instinct; the machinery existed but one
list was wrong.

**What already existed (no change needed):**
1. **LLM output is cached, content-keyed.** `summarize-article` wraps its model call in
   `cachedFetchJsonWithMeta(cacheKey, CACHE_TTL_SECONDS=86400)`; the key comes from
   `src/utils/summary-cache-key.ts`, self-described as *"the canonical cache-key builder shared by both
   client and server"* — a content hash over headlines/bodies/geo/mode/variant/lang. Two operators
   reading the same article therefore derive the SAME key, which is the whole precondition for sharing.
   `classify-event` is the same (`CLASSIFY_CACHE_TTL = 86400`).
2. **The share pipeline exists**: `vscode-extension/sidecar/local-sync.mjs` — *"One-way, periodic pull:
   shared Upstash Redis → local SQLite cache"* — with `server/_shared/sidecar-cache.ts` reading
   `LOCAL_SQLITE_PATH`. Exactly the architecture the operator described.

**The actual bug**: `SYNC_PREFIXES` omitted `summary:` entirely, and listed `classify:*` as a deliberate
exclusion labelled *"ML/log metadata"* — a misclassification. Live values confirm it:
`classify:sebuf:v6:<hash>` holds `{"level":"info","category":"economic","timestamp":…}`, i.e. the cached
LLM verdict that drives panel alert levels, and `/api/intelligence/v1/classify-event` is itself one of
the LLM-spend-quota'd paths, so a miss costs a real model call. So the two most expensive key families
in the store were the two that never mirrored down, and **every operator silently re-paid for identical
summaries and classifications, in every environment**.

Same failure mode the file already documents for `theater-posture:` (*"read empty theaters forever… no
error, because the key it needs was never mirrored down"*) — but costing money instead of a blank panel.

**Fix**: added `'summary:'` and `'classify:'` to `SYNC_PREFIXES`, and removed the now-contradictory
`classify:*` entry from the exclusion note above it. 48 keys newly in scope locally (18 summary,
30 classify). No test guards that list. `node --check` clean.

**CORRECTION to an earlier draft of this entry** — operator guidance, worth not repeating:
> *"upstash redis is for production, local redis is for dev, they should be switch based on environment,
> not codebase logics"*

An earlier version of this section framed *".env points at local Redis, so nothing is shared between
operators"* as a blocker and asked where the canonical store should live. That was wrong on both counts:
`UPSTASH_REDIS_REST_URL` **is** the switch (local in dev, hosted in prod), it is settled configuration
rather than an architecture decision, and in dev there are no other operators to share with — correct
behaviour, not a gap. Never branch on which Redis is in play; never escalate it as a design question.

---

### [RESOLVED 2026-08-20, thirtieth session] 429 flood — local dev shares ONE rate-limit bucket

Surfaced right after the news fix landed, and **the news fix is what made it visible**:
`/api/news/v1/summarize-article` is capped at **30 req/60s**, and the digest went from 0 articles to
**267**. The panels summarize what they render, so the cap is ~9x oversubscribed. The console got
louder *because* the fix worked.

**Second, deeper mechanism**: `getClientIp()` (`server/_shared/client-ip.ts`) deliberately refuses to
trust `cf-connecting-ip` / `x-forwarded-for` (GHSA-c267, #3531) and falls back to `x-real-ip` — a header
only a reverse proxy sets. **There is no proxy in front of `nitric start`**, so every request collapses
onto the `UNKNOWN_CLIENT_IP` sentinel and the entire dashboard (~20 panels on first paint) shares ONE
per-IP bucket against the global 600/60s. Observed on a real key:
`rl:ep:/api/intelligence/v1/classify-event:ip:unknown:29786843`.

**Not a limiter malfunction** — verified `EVAL` is NOT blocked on the local Redis proxy (returns
`{"result":1}`), so `Ratelimit.slidingWindow` works and `limitWithFallback` never engages its non-Lua
path. These were genuine exhaustions. (This corrects a stale session-29 note claiming EVAL was blocked.)

**Fix**: new `RATE_LIMIT_LOCAL_DEV=1` env flag gating the same three early-returns the existing
`isLocalSidecarMode()` bypass already used (`rate-limit.ts` lines ~207/417/510, now via a shared
`rateLimitBypassed()`). Same rationale the repo's own author wrote for the sidecar bypass: *a single
operator hitting their own machine has no abuse surface to defend*.

**TRAP — do NOT just set `LOCAL_API_MODE=tauri-sidecar` to get this.** That value is also read in
**five places in `server/_shared/redis.ts`**, where it means "no live Upstash at all" — setting it
would disable the local Redis data layer session 29 built. That is exactly why this is a separate var.

**Verified by direct A/B on the module** (an HTTP burst test could not prove it — 700 requests spread
over >120s never exceed 600 inside any single 60s window, and `classify-event` rejects the relay key
with 401 *before* reaching the limiter, so both HTTP attempts were inconclusive):

| `RATE_LIMIT_LOCAL_DEV` | 45 calls against the 30/60s cap |
|---|---|
| `"1"` | allowed **45**, limited **0** — bypass active |
| unset | allowed **30**, limited **15** — cap enforced exactly as documented |
| `"0"` | allowed 0, limited 45 (window already spent by the prior run) |

The unset row landing on exactly 30 independently confirms the 30/60s policy. **Production behaviour is
unchanged when the var is unset.** Documented in `.env.example`; set in `.env` under
`# [local-dev-rate-limit]`.

Tests: `api/_rate-limit.test.mjs` 15/15. The 3 `.mts` rate-limit suites fail with
`ERR_UNKNOWN_FILE_EXTENSION` — pre-existing, `git stash` A/B confirmed. `tsc` clean on all 3 configs.

**Incidental finding (not caused by any change here)**: `nitric start` **wedges under concurrent load**.
A 700-request burst at 25-way parallelism produced 427 connection failures and left the API answering
nothing (HTTP 000 after 30s) while all processes stayed alive — `pgrep` showed a healthy stack that was
not serving. Only a restart cleared it. **Do not load-test the local nitric stack**; and note that
"processes are up" is not evidence it is serving.

---

### [RESOLVED 2026-08-20, thirtieth session] News panels empty — TWO independent causes

The RSS routing fix (below) was **necessary but not sufficient**. After it landed, the panels still
rendered `无可用新闻`. The second cause was arithmetic, not networking, and would have kept the panels
empty even on a full-tunnel VPN.

**Cause 2 — the digest could only ever fetch ~20 of 190 feeds.** `list-feed-digest.ts` walks the feed
list in `ceil(190 / BATCH_CONCURRENCY=20)` = **10 SEQUENTIAL batches**, all sharing one
`OVERALL_DEADLINE_MS`, which was derived from `VERCEL_INITIAL_RESPONSE_LIMIT_MS` (25s) minus
`POST_FETCH_HEADROOM_MS` (15s) = **10,000 ms — i.e. 1 second per batch.** Measured per-feed cost on
this machine is **3.5-4.0s direct** (VPN-throttled) and **2.8-8.9s proxied**. Batch 1 alone consumed
the entire budget; the loop then hit `if (deadlineController.signal.aborted) break` and **batches 2-10
(170 feeds) never executed**. The regional categories live in those later batches — which is exactly
why those specific panels were empty while the top row had content.

Corroborating evidence: a Redis SCAN found only **37** `rss:feed:v8:*` keys had EVER been written, out
of 190 feeds. 153 feeds had never run once.

**Cause 2b — aborted feeds poisoned the cache, so it could never recover.** A deadline-aborted feed
fell into the same `if (!text)` branch as a genuinely-dead one and was written as empty for
`CACHE_TTL_EMPTY_S` (300s), with no distinction between the two. The relay's own RSS cache is also
300s, so both expired together and each run restarted from the same truncated state.

**Fixes applied** (operator chose "env-tunable timeouts + stop caching aborts"):
1. `FEED_TIMEOUT_MS`, `OVERALL_DEADLINE_MS`, `DIGEST_RESPONSE_TIMEOUT_MS` are now read via a new
   `envPositiveInt()` helper from `NEWS_FEED_TIMEOUT_MS` / `NEWS_DIGEST_DEADLINE_MS` /
   `NEWS_DIGEST_RESPONSE_TIMEOUT_MS`. **Production defaults are unchanged** — unset means today's
   values. `envPositiveInt` ignores zero/negative/NaN so an `.env` typo degrades to the safe default
   rather than to an instant deadline. Local values are set in `.env` under a
   `# [local-dev-news-timeouts]` marker, and documented (blank) in `.env.example`.
   **Ordering constraint: RESPONSE_TIMEOUT > DEADLINE > FEED_TIMEOUT** — otherwise `cachedFetchJson`'s
   `timeoutMs` abandons the builder before the deadline can apply. Current local: 110s / 100s / 20s.
2. `list-feed-digest.ts` now returns early **without** the empty-cache write when `signal.aborted`,
   so a deadline abort no longer writes off the tail of the feed list.

**Third poisoning layer worth knowing about** (not changed): `handler` wraps the build in
`cachedFetchJson(key, 900, fn, 120, ...)` and the builder returns `null` when `totalItems === 0`,
which caches a **negative sentinel for 120s**. So an empty digest stays empty for 2 minutes even after
the underlying cause is fixed — budget for that when testing.

**Result, measured**: `GET /api/news/v1/list-feed-digest?variant=full&lang=zh` returns **267 items
across 16 categories**. Previously-empty panels: `middleeast` 20, `africa` 15, `latam` 10, `asia` 20,
`gov` 20, `thinktanks` 20, `energy` 15. Only `crisis` is still 0. Feed outcomes: **8 via relay-proxy,
2 still failing** (`www.pbs.org` returns a non-RSS body; `feeds.news24.com` fetch-error), rest direct.

**Auth note for future testing**: this endpoint is gated. `X-WorldMonitor-Key: $WORLDMONITOR_RELAY_KEY`
returns 200; `X-Api-Key` with the same value returns 401. Useful for driving the digest from curl
instead of a browser.

Tests: 293/295 across the 17 digest test files. The 2 failures
(`tests/news-feed-digest-*.test.mts`) are `ERR_UNKNOWN_FILE_EXTENSION: ".mts"` — a runner/loader
problem, **pre-existing**, confirmed byte-identical via `git stash` A/B. `npx tsc --noEmit` clean on
all three tsconfigs.

**STILL OPEN — separate bug, not investigated**: the browser console shows a flood of **429s** from
`:9001` (`/api/market/v1/...include_news=true` repeated ~14x, `summarize-article`, `classify-event`).
These are **genuine** exhaustions of the global 600-req/60s-per-IP ceiling, not a limiter malfunction —
I verified `EVAL` is NOT blocked on the local Redis proxy (returns `{"result":1}`), so
`Ratelimit.slidingWindow` works correctly and `limitWithFallback` never engages its non-Lua path.
**This also corrects a stale note in memory** claiming EVAL was blocked. Something client-side is
hammering `market/v1`; that request storm is the thing to find.

---

### [RESOLVED 2026-08-20, thirtieth session] RSS-backed panels never load

**Resolved in code, NOT by the VPN switch.** The diagnosis below is accurate and the routing problem
is still present on this machine — but the conclusion that "it is not a code change and not something
an agent can do" was **wrong**. `scripts/ais-relay.cjs` fetches from many upstreams and 8 of them
(Yahoo, Weather, Spending, CoinPaprika, OpenSky) already use a **direct-first / `PROXY_URL`-fallback**
pattern. The RSS handler was the **only** one that didn't — it was a bare `https.get` whose
`request.on('error')` just armed a backoff and served stale.

Fix: added `rssTryProxy()` to the RSS handler, wired into BOTH network-failure paths
(`request.on('error')` and `request.on('timeout')`). Plus one additive line in
`scripts/_proxy-utils.cjs` so `proxyFetch` surfaces `location` (it does not follow redirects; the RSS
path follows them itself under the same per-hop allowlist the direct path enforces).

**Non-obvious correctness point, do not "simplify" this away**: on proxy SUCCESS the code deliberately
does NOT call `rssRecordFailure()`. The backoff guard runs *before* the fetch code on the next request,
so recording a failure there would 503 the feed for up to 15 minutes and the proxy would never get
another chance to serve it. It calls `rssResetFailure()` instead.

Verified live against the running relay on `:3004` (not just unit tests):

| Feed | Result | `X-Cache` |
|---|---|---|
| `theguardian.com/world/rss` | **200**, 150,649 B, 5.7s | `MISS-PROXY` |
| `lemonde.fr/rss/une.xml` | **200**, 22,160 B, 6.3s | `MISS-PROXY` |
| `de.euronews.com/rss` | **200**, 31,753 B, 8.9s | `MISS-PROXY` |
| `feeds.bbci.co.uk/...` (control, on utun8) | **200**, 32,843 B, 4.0s | `MISS` (never touched proxy) |
| `theguardian.com` 2nd request | **200** in **0.001s** | `HIT` |

So: blocked hosts are rescued, direct-reachable hosts pay nothing, and the proxy cost is paid once per
5-minute cache TTL per feed — not per request.

Tests: `scripts/ais-relay-rss.test.cjs` **7/7 pass** (includes a stale-on-error test that exercises the
rewired error path, with no `PROXY_URL` set — proving the no-proxy path is behaviourally unchanged).
`api/rss-proxy.test.mjs` shows 34/35 failing, but that is **pre-existing** — confirmed identical with
and without these changes via `git stash` A/B. `npx tsc --noEmit` clean on all three tsconfigs.

**The VPN switch below is now OPTIONAL** — it would make these feeds faster (direct instead of a ~3-9s
proxy hop) but is no longer required for them to work. Original diagnosis retained below for reference.

---

### [ORIGINAL DIAGNOSIS — retained for reference] RSS-backed panels never load

**Symptom**: the dashboard panels 中东 / 非洲 / 拉丁美洲 / 亚太地区 / 政府 / 智库 sit on `加载中...`
forever. They are **not slow — their upstream feeds are unreachable**, so they wait out timeouts and
never resolve. This is NOT the same failure class as the (now-fixed) latency problem below; do not
conflate them.

**Root cause, measured not inferred — it is a ROUTING problem, not code**:
a subset of feed hosts is **split-tunneled outside the VPN** (`route get` → `en0`) and the direct path
resets the connection immediately. Correlation was 100% across every host tested:

| Host | `route get` iface | Result |
|---|---|---|
| `www.theguardian.com` | **en0** (direct) | **HTTP 000, 0.33s — reset** |
| `www.lemonde.fr` | **en0** | **HTTP 000, 0.30s** |
| `www.euronews.com` | **en0** | **HTTP 000, 0.31s** |
| `www.pbs.org` | utun8 (VPN) | **200** |
| `apnews.com` | utun8 | **200** |
| `feeds.bbci.co.uk` | utun8 | 404 (wrong path, but REACHABLE) |

Every `en0` host fails; every `utun8` host works. The tunnel itself is healthy (Cloudflare control
**183-327 KB/s** through the same `utun8`). Matching relay log lines:
`[Relay] RSS error: read ECONNRESET (backoff 60s)` and
`[feed-fetch] ... source=both-failed relay_status=502`.

**Scope**: feed hosts are defined in `src/config/feeds.ts` and `server/worldmonitor/news/v1/_feeds.ts`
— **1,135 unique hosts**. A random 50-host sample routed 6 via `en0`, 38 via `utun8`, 6 unresolved →
**~136 hosts (~12%) on the blocked path**. A minority, but it includes major outlets (Guardian, Le Monde,
Euronews), which is why whole regional panels look empty.

**Agreed fix (operator's choice, NOT yet applied): switch the VPN from split-tunnel to FULL-tunnel.**
Rationale: the blocked hosts are CDN-fronted with rotating IPs, so static `route add` entries would
silently break later; and the VPN path already works for every feed host that happens to be inside it.
This is a **VPN client setting the operator must change** — it is not a code change and not something an
agent can do. **Note the direction**: these hosts need to go INTO the tunnel. This is the inverse of the
`local-network-optimizer` skill's default bypass-the-VPN fix, which applies to a *different* set of hosts
here (see below). Do not apply a `route add ... <physical-gateway>` bypass to news hosts — they are
already direct, which is exactly the problem.

**Verify after the switch** with: `route get www.theguardian.com` (expect `utun8`, not `en0`), then
`curl -sI https://www.theguardian.com/world/rss` (expect 200), then reload the dashboard.
`scripts/rss-feeds-report.csv` exists if a fuller per-feed audit is wanted.

**Do NOT re-investigate these — already measured and ruled out**: it is not the relay's rate limiter
(`RELAY_RSS_RATE_LIMIT_MAX` default 300), not the relay's per-feed backoff map
(`rssBackoffUntil`, `scripts/ais-relay.cjs:8097` — that's a *consequence*), not bandwidth (these fail in
0.3s, they don't crawl), and not the app's cache.

### Resolved this session (details in the sections further below)

1. **`/api/gpsjam` 503 → 200.** Orphaned seeder (`scripts/fetch-gpsjam.mjs`, scheduled nowhere) plus 3
   bugs inside it. Route code untouched.
2. **Local Redis dev stack restored** (`docker-compose.dev.yml` + `docker/`), recovered from deleted
   commit `87787be`. Hosted Upstash read ~60s vs local **0.011s**.
3. **Hosted Upstash mirrored into local Redis**: 11,336/11,398 keys (99.5%) in 41 min, 11,128 TTLs
   preserved. The 229 that looked missing were 210 **expired** (verified: 0 of 40 sampled still exist on
   hosted) + 19 refilled. Effective coverage **100% of live keys**. Local is now ~14,700 keys.
   Median TTL of panel-relevant keys is **~32 days**, so this stays valid for weeks.
4. **Supabase: legacy `service_role` → modern secret key**, plus THREE stacked access blockers fixed
   (secret key / exposed schema / `service_role` GRANTs). `/api/followed-countries` and
   `/api/latest-brief` now return **200** (operator confirmed in browser).
5. **THE BIG LATENCY FIX — `.nitric/history-apis.json` had grown to 149.3 MB.** Nitric rewrites it in
   FULL, synchronously, before flushing every response (~15 ms/MB). `149.3 MB x 15 ms = 2,240 ms` vs a
   measured floor of 2,270 ms. Truncating took a no-work `405` from **2.38s → 0.0026s** and `nitric start`
   CPU from **135% → 3%**. Fix is `scripts/clean-nitric-history.mjs` (already tracked) — **it must be run
   ALONGSIDE `nitric start` EVERY session**: `node scripts/clean-nitric-history.mjs &`. It is a 5-minute
   `setInterval`, not a one-shot, and does not survive a reboot.
   **Diagnostic tell: a route that does NO work (a 405, an auth reject) costing the same as a
   fully-cached response.** I misread that fact three times before finding this — do not repeat it.
   **Corollary: do NOT trim services from `nitric.yaml` for performance.** The 10 non-API services were
   never the cause; they only generate the requests that grow the file. With the cleaner they cost ~3% CPU.

### Environment left running

`nitric start --ci` on `:9001`, Vite on `:3000`, `docker compose -f docker-compose.dev.yml` (redis +
redis-rest on `127.0.0.1:8079`), and `node scripts/clean-nitric-history.mjs &`. **Restart nitric AND vite
after any `.env` change** — but note only `VITE_`-prefixed vars affect the browser bundle, so a
server-only `.env` edit does not require a Vite restart.

---

## 🔀 HANDOFF (2026-08-19, twenty-eighth session end) — read this first, supersedes every block below

**Scope**: picked up the twenty-seventh session's unresolved browser-login bug and **RESOLVED it**, then
kept pulling the thread through two further, independent bugs that were masking each other. Ends with
the operator's dashboard fully authenticating and every `401` gone from the browser console. Handing
off a **new, larger, operator-requested initiative**: *"there is no longer Pro-tier in our fork, remove
anything related Pro-tier."* That removal is scoped below but **barely started** — only the parts that
were actively causing 401s were removed.

**Git state**: 0 commits made (operator's standing "commit manually" discipline held). Working tree
carries the twenty-seventh session's 22 modified files plus this session's. Files THIS session touched:
`src/utils/urlState.ts`, `src/utils/index.ts`, `src/app/event-handlers.ts`, `src/services/auth-provider.ts`,
`src/services/runtime.ts`, `src/services/premium-fetch.ts`, `tests/urlState.test.mts`, and `.env`
(gitignored — 2 keys commented out, see below). `local.nitric.yaml` still untracked-but-meant-to-be-committed.
`npx tsc --noEmit` clean at every step.

### THE LOGIN BUG IS FIXED — root cause, after three sessions

**Supabase Auth here runs IMPLICIT flow, not PKCE.** `src/services/supabase-client.ts:49` never sets
`flowType`, and the installed `@supabase/auth-js` defaults to `'implicit'` (verified in
`node_modules/@supabase/auth-js/dist/main/GoTrueClient.js:24`). Proof from the wire, not inference: the
Supabase edge log shows `GET /auth/v1/authorize?provider=github` with `?provider=github` as the **entire**
query string — no `code_challenge`, which PKCE would always add. Implicit flow returns the session in the
**URL FRAGMENT** (`#access_token=...`), never as `?code=`.

`src/app/event-handlers.ts`'s `debouncedUrlSync` fires **unconditionally on plain page load**
(`event-handlers.ts:1213`), and 250ms later called `history.replaceState()` with `getShareUrl()`, which
builds `origin + pathname + search` — **no hash**. Meanwhile `scheduleAuthProviderLoad()` deferred the
Supabase client construction (and thus `detectSessionInUrl`) behind `requestIdleCallback(..., {timeout: 4000})`.
The fragment was destroyed seconds before auth-js ever looked for it.

**The twenty-seventh session found the right function and hardened the wrong half of the URL** — it fixed
query-param wiping and left comments saying "PKCE `?code=`". The payload was in the fragment the whole time.
Generalizable lesson: confirm the payload's actual shape ON THE WIRE before assuming which branch is live.

Fixes (all typechecked, `tests/urlState.test.mts` 21/21 green):
- `withPreservedFragment()` in `src/utils/urlState.ts` (exported via `src/utils/index.ts`). Assigns `.hash`
  rather than concatenating, so it normalizes a missing `#` AND replaces an existing fragment —
  deliberate, because `buildMapUrl` does NOT strip fragments (a test proved my initial assumption wrong).
- `event-handlers.ts:240` preserves `window.location.hash`. **Intentionally NOT folded into `getShareUrl()`**:
  that value is also copied to the clipboard by the share button and must never carry an access token.
- `auth-provider.ts`'s new `hasPendingOAuthResponse()` — when the URL carries an OAuth return, auth init runs
  IMMEDIATELY instead of deferring up to 4s. Checks both `#access_token`/`#error` and `?code`/`?error` so a
  future `flowType` switch can't silently reintroduce the race. Defense-in-depth: the session no longer
  depends on every current and future URL writer preserving parts it doesn't own.

**Verified live, not just by tests**: `Object.keys(localStorage).filter(k => k.startsWith('sb-'))` now returns
`["sb-ixuezudybhjptisexgxx-auth-token"]` — the exact check that returned `[]` for two straight sessions.
Avatar renders, panels unlock. (Corroborating fingerprint: a trailing bare `#` appears in the URL afterwards,
which is auth-js's own `window.location.hash = ''` after it consumes the fragment.)

**"It doesn't redirect to GitHub, it just reloads" was always a red herring** — GitHub already holds the
authorization, so `authorize → github → callback → back` is four 302s with no consent screen, too fast to
perceive. The twenty-seventh session flagged this as an unconfirmed assumption; it is now confirmed harmless.

### THEN: two Pro-tier bugs were 401ing every panel even with a valid session

Both were found only after the login worked. **Two independent code paths carried the same dead-key
preference, so fixing one left the other producing identical 401s from a different call stack.**

1. **`src/services/runtime.ts`'s `enrichInitForPremium`** short-circuited on a "tester key" BEFORE reaching
   the Supabase Bearer — `if (testerKey) { set X-WorldMonitor-Key; return }`. The key comes from
   `VITE_PRO_WIDGET_KEY`. **REMOVED** (deleted, not reordered).
2. **`src/services/premium-fetch.ts`'s tester-key LADDER** (was step 2 of `premiumFetch`) looped over
   `loadTesterKeys()` firing a **real network request per key**, treating each 401 as "try the next".
   With both `VITE_PRO_WIDGET_KEY` and `VITE_WIDGET_AGENT_KEY` set that was **two guaranteed-401 round trips
   on every premium call** — which also tripped the gateway's rate limiter and turned recoverable calls into
   `429`s. **REMOVED**, along with the now-unused `loadTesterKeys()` and `uniqueNonEmptyKeys()` helpers.
3. **`.env`**: `VITE_PRO_WIDGET_KEY` and `VITE_WIDGET_AGENT_KEY` commented out (with an explanatory comment).
   **Requires a Vite restart** — `.env` is read once at startup (the known stale-`.env` trap). Backup of the
   pre-edit `.env` is at the session scratchpad as `env.bak-protier`, NOT in the repo (it was briefly written
   to the repo root as `.env.bak-protier` and moved out after `git check-ignore` showed it was NOT ignored —
   **never leave an `.env` backup in this repo, `.env.bak*` is not gitignored**).
   `PRO_WIDGET_KEY` / `WIDGET_AGENT_KEY` (non-`VITE_`, server-side) are **still live** in `.env` — deliberately
   left, inert for this bug, belong in the bigger sweep.

Proof these keys were dead, taken against the live local gateway (not assumed):
`curl -H "X-WorldMonitor-Key: <VITE_PRO_WIDGET_KEY>" http://localhost:9001/api/intelligence/v1/list-market-implications`
→ **401**, byte-identical to sending no credentials at all.

**Operator-confirmed result after the final reload: every `401` is gone from the console.**

### Method notes worth reusing

- The single most valuable diagnostic was **DevTools' Initiator column**. `runtime.ts:548` pointed *inside*
  the injection patch, proving the patch DID run and enrichment DID execute — which killed the boot-race
  theory and redirected the search to why `getAuthToken()` returned null.
- Three layers wrap `window.fetch`, each with its own auth opinion, and a stack trace reads outermost-last:
  `premium-fetch.ts` → `wm-session.ts` → `runtime.ts` → native. Any auth debugging here must identify WHICH
  layer attached (or refused to attach) a credential.
- `import.meta` is unavailable in the DevTools console, but `await import('/src/services/foo.ts')` works in
  Vite dev and returns the **same module instance the app uses** — this is how `getAuthToken()` was proven
  healthy in isolation.

### STILL OPEN — the operator's next initiative: remove Pro-tier entirely

Operator's words: *"there is no longer Pro-tier in our fork, remove anything related Pro-tier."* Consistent
with the already-completed Convex/SaaS/billing retirement (`getCurrentAuthUser().plan` is already hardcoded
`'pro'` for every signed-in user).

**Measured scope: 277 TRACKED source files.** An earlier "204" figure was inflated — `api/*/v1/[rpc].js` are
**gitignored build artifacts** (`.gitignore:56`), so never count them. Breakdown by area:

| Area | Files | What lives there |
|---|---|---|
| `src/components/**` | 36 | lock overlays, upsell UI |
| `server/worldmonitor/**` | 36 | `isCallerPremium` gating per RPC |
| `src/services/**` | 31 | `premium-fetch.ts`, `entitlements.ts`, `widget-store.ts` |
| `src/locales/**` | 26 | the "登录以解锁" lock strings, 26 languages |
| `server/_shared/**` | 11 | `premium-check.ts` — `isCallerPremium` definition |
| `server/__tests__`, `tests/**` | ~15 | premium guards/fixtures |
| `src/app`, `src/config`, `src/shared`, `api/mcp`, `api/v2` | ~21 | `premium-paths.ts` = `PREMIUM_RPC_PATHS` |

**This removes SERVER-SIDE AUTH ENFORCEMENT — treat it as a security-relevant change, not a cleanup.**
Suggested staging (not yet agreed with the operator): (1) client-side lock UI + locale strings, (2) client
`premium-fetch`/`entitlements`/`widget-store`, (3) `PREMIUM_RPC_PATHS` + gateway `isCallerPremium`, each
stage independently verifiable in the browser. Get sign-off on the server stage specifically.

**Known trap for that work**: `tests/premium-fetch.test.mts` and `tests/premium-paths-guard.test.mts`
**cannot execute at all** under `node --experimental-strip-types --test` — they die on module resolution
(`Cannot find package '@/services'`; `Cannot find module 'server/_shared/redis'`). Confirmed pre-existing via
`git stash` A/B (identical fail before and after this session's changes). **Consequence: the tester-key
ladder removal above is NOT covered by any passing test** — it was verified live in the browser instead.
Do not read those files' green/red status as signal; they need a runner with alias support (vitest or a loader).

### Local dev data layer + Supabase key migration (2026-08-19/20, twenty-ninth session, UNCOMMITTED)

- **Local Redis dev stack restored** — `docker-compose.dev.yml` + `docker/redis-rest-proxy.mjs` +
  `docker/Dockerfile.redis-rest`, recovered from commit **`87787be`** ("remove Docker/nginx + npm+Upstash
  self-hosting entirely"), which deleted them as a *product surface*; the dev-loop value was collateral.
  What is restored is a **dev-only slice (redis + redis-rest only)** — no app/nginx/relay services, so the
  retired self-hosting surface stays retired. **Do not let it grow back into that.**
  Why it is needed: this repo speaks **Upstash HTTP REST, not RESP**, in ~184 tracked files, so a plain
  `redis-server` cannot be dropped in — the swap point is the protocol shim, which is why pointing
  `UPSTASH_REDIS_REST_URL` at it needs **zero application code changes**. Measured: hosted Upstash read
  **~60s** vs local **0.011s**. That fits inside the existing production 3s timeout, so `/api/gpsjam` went
  503 -> 200 with **no production code edited**.
  Gotchas fixed while restoring: `EVAL` was **blocked** by the proxy allowlist but is used by the seed lock
  (`scripts/_seed-utils.mjs:372`), the forecast CAS and `api/health.js`; the 1 MB body cap is now
  `SRH_MAX_BODY_BYTES` (16 MB default); **`node --env-file` does NOT expand `${VAR}`**, so
  `UPSTASH_REDIS_REST_TOKEN` must repeat `REDIS_TOKEN`'s literal value. Both docker images were already in
  the local cache, and the compose file bind-mounts the proxy source rather than using `build:`, so no pull
  is needed. Revert marker in `.env` is `# [switched-to-local-redis]`. **Local Redis starts EMPTY** — it is
  not a mirror; seeders repopulate it but still pay throttled upstream fetches.

- **This machine's VPN throttles specific destinations, not the tunnel** — Cloudflare control **176 KB/s**
  through the same `utun8` while Upstash gets **11 KB/s** and gpsjam.org **4.7 KB/s** (github.com times out).
  Physical gateway `192.168.123.1` on `en0`; VPN gateway `172.27.232.1`. This is shape A in the
  `local-network-optimizer` skill, so a `sudo route add` bypass applies; **not applied** — operator approved
  it, then local Redis removed the need for the Upstash half. **Rule: measure the actual transfer before
  changing any timeout constant.** A prior session raised an Upstash timeout to 45s and recorded the problem
  as "not fixable locally" — that was wrong. Never raise a *production* timeout to accommodate this link.

- **Supabase legacy `service_role` -> modern secret key** — operator's call, correct: Supabase replaced the
  JWT-derived `anon`/`service_role` keys with `sb_publishable_...`/`sb_secret_...` (legacy supported until
  end of 2026). The **browser half was already migrated** (`VITE_SUPABASE_PUBLISHABLE_KEY` holds a real
  `sb_publishable_...`). `server/_shared/supabase-admin.ts` and `scripts/lib/supabase-admin.cjs` now read
  `SUPABASE_SECRET_KEY || SUPABASE_SERVICE_ROLE_KEY`; `.env.example` documents both. A secret key authorizes
  through the same `service_role` Postgres role and keeps `BYPASSRLS`, so the cross-user lookups are
  unaffected. Compatibility checked against this codebase, not assumed: nothing decodes these as JWTs,
  nothing sends them as `Authorization: Bearer` (the one documented incompatibility), and both live Edge
  Functions (`github-identity-bridge`, `worldmonitor-org-gate`) already have `verify_jwt: false`.
  **Secret keys are deliberately NOT exposed via the Supabase MCP** — only publishable ones; the operator
  must copy it from Dashboard -> Settings -> API Keys.

### Also unresolved, lower priority (unchanged by this session)

- **`503` on `/api/gpsjam`, `/api/followed-countries`, `/api/latest-brief`, some `summarize-article`** — a
  DIFFERENT failure class from the 401s (upstream/Redis data availability), never investigated.
  **resolved (2026-08-19/20, twenty-ninth session, uncommitted): these were THREE unrelated causes, not one
  class.** Grouping them cost time — investigate such lists per-endpoint, not as a bucket. Also note
  `/api/followed-countries` + `/api/latest-brief` return **401, not 503, to an unauthenticated caller**: the
  JWT gate precedes the 503 branch, so curl cannot see the real bug and only the browser shows the 503.
  1. **`/api/gpsjam` — FIXED, now 200.** `intelligence:gpsjam:v2`/`:v1` did not exist; `scripts/fetch-gpsjam.mjs`
     is an **orphaned seeder scheduled nowhere** (no cron, no npm script, nothing in `gcp/scheduler`) — same
     class as session 26's four orphans. Running it exposed 3 further bugs in that script, all fixed:
     (a) `fetchText` timeout was 30s but the download takes **35.3s** on this link, so it had literally never
     succeeded — and the failure path is `catch -> extendExistingTtl -> exit 0`, i.e. a silent no-op once the
     keys had expired; (b) `seed-meta` was written AFTER a read-back verify that pulls the whole ~325 KB value
     back down, so a slow verify aborted the run and left `seed-meta` unwritten — data present in Redis while
     `api/health.js` (`maxStaleMin=1440`) reported the seed stale; `seed-meta` now goes first and the verify is
     non-fatal; (c) `main().catch()` labelled EVERY error `"Fetch failed"`, including `seedRedis()` failures
     that happen after a fully successful fetch — now labelled by phase. The route itself was NOT changed.
  2. **`/api/latest-brief` — cause found, `BRIEF_URL_SIGNING_SECRET` was absent from `.env`** (empty
     placeholder in `.env.example`); `api/latest-brief.ts:198` 503s without it. Generated. **NOT verified
     end-to-end** — the 401 gate hides it from curl; needs a browser check with a real session.
  3. **`/api/followed-countries` — FIXED, but it was THREE stacked blockers, not one.** Each fix only revealed
     the next, and each presented as a different error: (a) no secret key -> `getSupabaseAdmin()` returned
     `null` -> `CONFIG` -> **503**; (b) the `worldmonitor` schema was not in Supabase's **exposed schemas** ->
     `406 PGRST106`; (c) the `service_role` Postgres role had **USAGE on the schema but zero table privileges**
     -> `403 42501`. (c) is the subtle one: a schema created outside `public` does NOT inherit Supabase's
     default grants, and **Postgres checks GRANT before RLS**, so the `select own` policies on these tables had
     never once been evaluated. Fixed by granting `service_role` (only — NOT `authenticated`; the browser never
     queries these tables directly, it goes through `/api/*`) plus `alter default privileges` so a future table
     cannot silently reintroduce it. Verified: 6/6 tables reachable, `listFollowed`/`countFollowers`/
     `getUserPreferences` all succeed through the app's own modules, and an INSERT returns `23503`
     (foreign-key) rather than `42501` — proving write permission. **Blast radius was much wider than this one
     route**: the same `getSupabaseAdmin()` guard gates `alert-rules`, `notification-channels`,
     `user-preferences` and `telegram-pairing`. All 8 tables have 0 rows — these features have never worked in
     this fork.
- **`429 Too Many Requests`** still appears on `classify-event` / `analyze-stock` / `summarize-article`.
  Much of the pressure that caused it is gone with the tester-key ladder, but the underlying rate limit was
  never examined; residual 429s may just be genuine burst load from first paint.
- **`GET http://localhost:3000/script.js 404`** from `analytics.ts:180` — the analytics script is absent in
  dev. Harmless noise, but it's 2 console errors on every load.
- Anonymous `wm-session` cookie: confirmed working (`POST /api/wm-session` → 200, and
  `get-eu-gas-storage` returns **401 without / 200 with** the cookie). Not a bug — recorded because it was
  briefly a suspect and the next session shouldn't re-derive it.
- Everything from the twenty-sixth session's block below (APP_DOMAIN/API_BASE_URL gap for seed scripts,
  Yahoo Finance crumb flow, `military:bases` coverage) remains untouched.

### Environment left running

`nitric start --ci` on `:9001` (PID varies) and `npm run dev` (Vite) on `:3000`, restarted after the `.env`
edit. Vite log at the session scratchpad `vite.log`. **Restart Vite after ANY `.env` change.**

---

## 🔀 HANDOFF (2026-08-19, twenty-seventh session end) — superseded by the block above; the login bug it describes is now FIXED

**Scope this session**: entirely local-dev-environment debugging, triggered by trying to actually
run `nitric start` + `npm run dev` together and log in through the browser for the first time (not
just curl). Zero of the twenty-sixth session's "still open" items were touched. Ends UNRESOLVED —
the operator explicitly asked to hand off after real, verified fixes still didn't clear the actual
symptom (browser login never persists a session). Read the "STILL BROKEN" section below before
attempting anything new — several plausible-looking theories are already ruled out with evidence,
don't re-try them.

**Git state**: 0 commits made, nothing staged, operator's standing "commit manually" discipline
held throughout. Working tree has 22 modified files + `scripts/seed-infra.mjs` deleted (pre-existing
from session 26, untouched this session) + one **untracked** file, `local.nitric.yaml` (see below —
this one matters, it's not accidental cruft). Files this session actually touched:
`.env` (gitignored, see credentials below), `server/auth-session.ts`, `server/_shared/auth-session.ts`,
`server/gateway.ts` (only a comment touched by an earlier fix, not the JWT rewrite),
`src/utils/urlState.ts`, `src/app/event-handlers.ts`, `.env.example`, and 5 test files
(`tests/auth-session.test.mts`, `tests/gateway-pro-fresh-cache.test.mts`,
`tests/premium-stock-gateway.test.mts`, `tests/usage-telemetry-emission.test.mts`,
`tests/auth-resource-timeout.test.mts` — comment-only in the last one) plus a new
`tests/urlState.test.mts` regression test. `npx tsc --noEmit` and `-p tsconfig.api.json` both clean.

**`nitric start` is running**, PID varies — restarted ~8 times this session chasing the port issue
below, always via `pgrep -fl "nitric start"` → kill → confirm zero survivors → relaunch with
`nohup nitric start --ci > <logfile> 2>&1 &`. **`npm run dev` (Vite) is ALSO running, separately, in
the operator's own foreground terminal** — the two are independent processes serving different
things (see the port-pinning and Vite-sebuf-plugin findings below); don't assume killing one
affects the other.

**Resolved + verified this session, in order**:

1. **`WM_SESSION_SECRET` was entirely unset** → `api/wm-session.js` fails closed with a 503
   ("Session service not configured") by design → cascaded into 401s on every downstream route that
   checks for a session. Generated fresh (`openssl rand -hex 32`, 64 hex chars, well above the
   enforced 32-char minimum in `api/_session.js`), operator explicitly approved generating a random
   value. **Verified live**: `curl -X POST .../api/wm-session` → `200`, real signed `wm-session=wms_...`
   cookie.
2. **Nitric's local API/MCP gateway ports are NOT stable across `nitric start` restarts** — spent a
   long time brute-force-discovering the live port after every restart before finding the real fix:
   the sibling repo `platform/backend` pins ports via a `local.nitric.yaml` file at the project root
   (confirmed via `strings` on the `nitric` binary: `./local.nitric.yaml` is a real, hardcoded
   discovery path, not a guess). Created one here too — **but the first attempt (`api: 4001, mcp: 4010`)
   collided** with nitric's own auto-assigned internal service ports (it claims `4000-4009`
   sequentially for this project's other 9 services before the pinned gateway gets a turn; confirmed
   via `.nitric/services.log`: `"error mapping api to port 4001 ... address already in use"`).
   **Fixed by moving to `9001`/`9010`** (mirrors the sibling repo's own safe-range choice) — confirmed
   stable across a subsequent clean restart via `curl http://localhost:9001/api/health` → `200`.
   `local.nitric.yaml` is **untracked but meant to be committed** (confirmed via `git ls-files` on the
   sibling repo — it's real shared config, not a personal override).
3. **`.env`'s `WM_API_BASE_URL`/`API_BASE_URL`/`VITE_WS_API_URL` all point at `http://localhost:9001`**
   now (was `:4004`, an earlier now-invalidated ephemeral-port guess — superseded by item 2's pinning).
   `VITE_WS_API_URL` specifically fixes browser `fetch('/api/...')` calls, which otherwise default to
   same-origin (`:3000`, Vite) — and Vite's own `sebufApiPlugin` (`vite.config.ts:411`, an in-process
   dev router for `/api/{domain}/v1/*`) calls RPC handlers **directly with zero auth/session layer**
   (confirmed by reading its `matchedHandler(webRequest)` call site — no `createDomainGateway`
   anywhere in that path). Without the redirect, requests either 404 (paths outside the sebuf shape,
   e.g. `/api/wm-session`) or would silently bypass auth entirely (paths inside it) — neither is
   correct. The redirect ensures every request actually goes through nitric's real, fully-auth-checked
   gateway.
4. **Supabase project migrated off legacy HS256 shared-secret JWT signing to asymmetric ES256 signing
   keys** (operator confirmed via the dashboard's own "Legacy JWT secret" deprecation notice, then
   supplied the real public JWK). `server/auth-session.ts` rewritten: `importJWK` + `jwtVerify` with
   `algorithms: ['ES256']` against a **hardcoded public key** (`SUPABASE_JWT_PUBLIC_JWK` env var, a
   single JWK object, JSON-encoded) — **explicit operator choice over Supabase's own recommended
   `createRemoteJWKSet` pattern**, trading automatic recovery from key rotation for zero network
   dependency on the verify path. This trade-off is documented directly in the file's header comment
   — if auth ever silently breaks again after this was working, check whether the signing key was
   rotated in the Supabase dashboard before assuming anything else. `server/_shared/auth-session.ts`'s
   doc comment updated to match. **One real bug caught and fixed by `tsc -p tsconfig.api.json`
   specifically** (the main `tsconfig.json` didn't catch it): an edit accidentally dropped the
   `SessionResult` interface entirely.
   Rewrote 5 test files off the old HS256-shared-secret-string fixture pattern onto a real
   `generateKeyPair('ES256')` keypair (mint tokens with the private half, configure the module under
   test with the exported public half) — **verified 2 ways**: `git stash` A/B on the 2 files with
   pre-existing unrelated failures (14 + 12, confirmed identical before/after, not caused by this
   session), and all 5 files run together at 28 pass / 29 pre-existing fail, matching exactly.
   **Live-verified the real configured key** imports cleanly (`importJWK` against the actual `.env`
   value → real `CryptoKey`, not a parse error) and a real `/api/wm-session` POST against the pinned
   `:9001` gateway returns a genuine signed session — but see STILL BROKEN below, this was never
   actually the blocker for the end-to-end symptom.
5. **Real, verified, but INSUFFICIENT bug fix**: `src/app/event-handlers.ts`'s `debouncedUrlSync`
   (fires 250ms after almost any map interaction, including initial load) calls
   `history.replaceState()` with a URL rebuilt by `buildMapUrl()` (`src/utils/urlState.ts`), which
   used to start from a **fresh, empty** `URLSearchParams()` — silently discarding any query param it
   doesn't own itself (`zoom`/`view`/`timeRange`/`layers`/etc.), including an in-flight Supabase OAuth
   `?code=...&state=...` PKCE callback mid-exchange. Fixed: `buildMapUrl` now seeds its param set from
   whatever's already on the URL; `getShareUrl()` (the only real caller) now passes the current query
   string through instead of stripping it via `${origin}${pathname}` first. **Verified as a real bug,
   not a hunch**: added a regression test (`tests/urlState.test.mts`, "preserves query params it does
   not own") that fails on a `git stash` of just this fix (15/16) and passes with it applied (16/16);
   full existing suite (102 tests, 4 files) passes identically before/after — no regressions.
   **This did NOT fix the reported symptom** — see below. It's still a real, worthwhile fix (this
   exact race would eventually bite something), just not sufficient on its own.

**STILL BROKEN, unresolved at session end — the actual thing the operator cares about**:
Signing in via GitHub never results in a persisted session. Symptom, unchanged across every fix
above: redirect to GitHub happens (confirmed via the exact `github.com/login/oauth/authorize?...`
URL, correct `client_id`/`redirect_uri`/`scope`), **no visible consent screen** (assumed to be a
normal "already authorized this app before" skip — the operator's avatar rendered successfully at
least once earlier in this same session, so a prior real login did work at some point — but this
assumption was never independently confirmed and deserves fresh scrutiny next session, since nothing
tried since has fixed anything), lands back on `localhost:3000` at the exact pre-login URL with
**zero visible trace** of `?code=`/`#access_token=`/`?error=`, login button still shows, every panel
still shows "登录以解锁" (locked).

**Ruled out, with direct evidence — do not re-investigate these**:
- Server-side session verification (item 4 above) — curl-confirmed working in isolation.
- Server-side OAuth completion itself — queried Supabase's own `auth_logs` directly via the Supabase
  MCP tools (`mcp__claude_ai_Supabase__query_logs`, project `ixuezudybhjptisexgxx`): **every single
  login attempt this session succeeded server-side**, repeated ~10 times over several hours,
  including one at `09:47:04Z` — the operator's last attempt before requesting handoff. `/callback`
  returns `302` every time; GoTrue logs `"msg":"Login"` with a real `user_id`
  (`15ae70b6-2045-49e5-9381-7e426c1d8295`, `powerpro.led@gmail.com`) every time. This is the single
  most important fact for the next session: **whatever is broken is 100% client-side**, the server
  has never been the problem despite how much of this session was spent there.
- The Supabase Redirect URLs allow-list — operator confirmed `http://localhost:3000/**` was already
  added; verified the wildcard semantics against Supabase's own docs (`**` matches across `/` and `?`
  both, separators are only `.` and `/`) so this pattern does cover a URL with a query string.
- `localStorage` genuinely holds ZERO Supabase-shaped session data — checked both the specific
  expected key (`sb-ixuezudybhjptisexgxx-auth-token`) AND an unprefixed sweep
  (`Object.keys(localStorage).filter(k => k.startsWith('sb-'))` → `[]`). A stray
  `sb-localhost-auth-token` **cookie** was found early and is a confirmed red herring — this app's
  Supabase client (`src/services/supabase-client.ts:49`) uses `persistSession: true` with the default
  `localStorage` backend, never cookies, so that cookie is leftover noise from something unrelated on
  this machine, not this app's own session.
- Item 5's URL-param-wiping bug — real and fixed, but confirmed (by the operator, after reload)
  NOT the actual blocker. Something else is also wrong, or item 5 wasn't the only place stripping/
  losing the OAuth response.

**Not yet tried — concrete next steps, roughly in order**:
- Confirm Vite actually picked up item 5's fix (HMR of `event-handlers.ts`/`urlState.ts` vs. needing
  a full hard reload) before concluding it's insufficient rather than just not yet live.
- The "no consent screen" detail was talked past rather than confirmed — check with Network tab
  **Preserve log + Doc filter** whether the browser does a REAL full navigation to `github.com` at
  all (a `Doc`-type request to `github.com/login/oauth/authorize`), versus something short-circuiting
  before that ever happens. This was asked for twice this session and never actually delivered by the
  operator — get it before theorizing further.
- Re-examine `src/services/auth-provider.ts:107`'s `window.__wmVsCodeApi` branch — if that global is
  ever truthy in a plain browser tab (shouldn't be, but never definitively ruled out this session),
  `signInWithGithub()` silently `postMessage`s to a nonexistent VS Code host and returns, doing
  nothing — total silence, no network request, no error. Cheap to check: `console.log(window.__wmVsCodeApi)`
  in the browser before clicking sign-in.
- Check **`sessionStorage`** (not just `localStorage`) for a PKCE `code_verifier`-shaped key —
  supabase-js's PKCE flow needs one written before the GitHub redirect and read back after; never
  explicitly checked this session.
- Search more broadly for a SECOND place that might strip/redirect the URL early on boot — item 5's
  `debouncedUrlSync` was the one found, but the search for `history.replaceState`/`pushState` callers
  (`src/app/event-handlers.ts`, `src/bootstrap/sentry-init.ts`, `src/components/RouteExplorer/url-state.ts`,
  `src/services/i18n.ts`) wasn't exhaustively traced past the one that matched the URL shape being
  investigated — the other 3 files were never actually opened.
- Late in the session, some RPC calls started returning `429 (Too Many Requests)` after several rapid
  login retries — never investigated whether a rate limiter is also throttling the auth path itself
  in a way that could be masking the real state.

**Credentials/config added this session, all in local `.env` (gitignored)**:
- `WM_SESSION_SECRET` — random, `openssl rand -hex 32`, operator-approved (item 1).
- `SUPABASE_JWT_PUBLIC_JWK` — the project's real public ES256 signing key, operator-supplied from the
  Supabase dashboard (item 4). Old `SUPABASE_JWT_SECRET` line replaced, not left dangling.
- `WM_API_BASE_URL`/`API_BASE_URL`/`VITE_WS_API_URL` all set to `http://localhost:9001` (items 2-3).
- `APP_DOMAIN=localhost:3000` (carried over from earlier the same session, before this handoff's
  scope starts — see the domain-strategy conversation that opened this session for why: a dedicated
  `monitor.led4signage.com` subdomain is the long-term intent once something is actually deployed
  there, `localhost:3000` is correct for local dev right now).

**Still open, in priority order for the next session**:
- **The browser-login symptom above — top priority, this is what the operator actually asked for.**
- Everything from the twenty-sixth session's handoff below is untouched and still open (APP_DOMAIN/
  API_BASE_URL gap for seed scripts, Yahoo Finance crumb flow, `military:bases` coverage, untriaged
  log-noise clusters) — not re-summarized here, read that block directly.

---

## 🔀 HANDOFF (2026-08-19, twenty-sixth session end) — superseded by the block above, still relevant, read after it

**Repo context**: unchanged from the twenty-fifth session's block below — fork of official
worldmonitor.app, Railway abandoned, Nitric/GCP still scaffold-only for THIS fork specifically
(nothing of this fork's own is deployed anywhere). Read that block's repo-context paragraph if this
is your first time in this file. One correction to it, found this session (see the APP_DOMAIN
finding below): "nothing deployed" is true for this fork's own infra, but local `.env`'s
`APP_DOMAIN=worldmonitor.app` still points seed scripts at the **original upstream project's real,
live production site** by default — don't conflate the two when a script's RPC call behaves
unexpectedly.

**Git state**: `main` and `origin/main` are in sync (0 ahead, 0 behind) — this session made ZERO
commits. **13 files changed in the working tree, nothing staged/committed**, per this repo's
standing discipline (operator commits/pushes manually — don't do it unprompted). Full list:
`.env.example`, `TASKS.md`, `api/health.js`, `scripts/ais-relay.cjs`,
`scripts/seed-bundle-derived-signals.mjs`, `scripts/seed-infra.mjs` (deleted),
`scripts/seed-insights.mjs`, `scripts/seed-military-maritime-news.mjs`,
`scripts/seed-service-statuses.mjs`, `server/gateway.ts`, `tests/health-classify.test.mjs`,
`tests/relay-boot-seed-freshness-guard.test.mjs`, `tests/seed-warm-ping-origin.test.mjs`. `.env`
also has 3 new/changed lines (gitignored, won't show in `git status`) — see credentials below.

**`nitric start` is running** (PID varies — `pgrep -fl "^nitric start$"`), restarted 3 times this
session: once for `WORLDMONITOR_RELAY_KEY`, once for `PROXY_URL`, and once more at session end
specifically so the live process would match the final working tree. (`CLOUDFLARE_API_TOKEN` never
needed its own restart — verified via a standalone `node --env-file=.env
scripts/seed-internet-outages.mjs` run, not through the live relay.) `ais-relay.cjs` runs as plain
`node`, not `tsx watch` — it does NOT pick up source edits until restarted, unlike
`gcp/api/main.ts`/`gcp/scheduler/main.ts` which auto-restart on save. **Confirmed via log**:
`[TemporalAnomalies] Warm-ping loop starting` present,
all 10 services + the relay respawned. **Standing gotcha, now observed 3 times across sessions,
worth treating as a hard rule**: killing the `nitric start` parent does NOT reliably kill its
`tsx watch` grandchildren (both the API and scheduler children have orphaned separately this
session) — always `pgrep -fl "ais-relay.cjs|gcp/api/main.ts|gcp/scheduler/main.ts"` after any kill
and explicitly kill survivors before restarting, or you'll end up running two generations of every
service at once.

**Credentials added this session (all live in local `.env`, verified working before use)**:
- `WORLDMONITOR_RELAY_KEY` — self-generated (`openssl rand -hex 32`), NOT a `WORLDMONITOR_VALID_KEYS`
  entry (dedicated relay↔gateway secret, least-privilege — see `server/gateway.ts`'s
  `isRelayWarmPingRequest`).
- `PROXY_URL` — operator-supplied Decodo datacenter proxy (`dc.decodo.com:10001`). Verified live via
  direct `curl` before wiring in. **Does NOT fix Yahoo Sector 401s** (see below) but is real
  infrastructure now available to 8 other scripts that share this config
  (`scripts/_proxy-utils.cjs`'s `resolveProxyString`/`resolveProxyConfig`).
- `CLOUDFLARE_API_TOKEN` — operator-supplied, read-only Radar/Analytics scope. Verified live against
  all 3 Cloudflare Radar endpoint groups the `internet-outages` seed needs before use.

**Resolved this session, in order** (numbers refer to items further down this file):
1. **`WORLDMONITOR_RELAY_KEY`** (top "Still open" bullet from the prior handoff) — generated, wired,
   verified via live log (`[Relay] WORLDMONITOR_RELAY_KEY configured`). Also fixed 5 stale comment
   sites across `.env.example` + 4 seed scripts that documented the old, wrong "reuse a
   `WORLDMONITOR_VALID_KEYS` value" approach.
2. **`news:digest` re-verify (former item 6)** — re-verified with the key now set. Found the REAL
   cause was never the missing key: `/api/news/v1/list-feed-digest` was simply never added to
   `server/gateway.ts`'s `RELAY_WARM_PING_PATHS` allowlist. Fixed (operator-approved) — added it.
   **This fix is UNVERIFIED** — see the APP_DOMAIN finding immediately below, discovered while trying
   to verify it.
3. **⚠️ NEW FINDING, significant, not fully resolved — seed scripts default to the REAL LIVE
   upstream `api.worldmonitor.app`, not this fork's own code.** `resolveApiOrigin(APP_DOMAIN)`
   (`scripts/_domain-config.mjs`) resolves to `https://api.worldmonitor.app` whenever
   `API_BASE_URL`/`WM_API_BASE_URL` isn't explicitly overridden — confirmed live and answering
   (`curl` → `HTTP 403`/`401` depending on path). No local override exists today, and no reachable
   local address for the Nitric-managed gateway was found for scripts to target instead. **Any
   earlier session's "verified against local nitric start" claim involving an actual RPC call
   (not a direct Redis read) should be treated with suspicion** until re-checked with this in mind.
   Full trace: category 9's writeup in the item-6 section further down.
4. **Yahoo Finance `[Sector]` 401 cluster (from the prior handoff's untriaged log-noise list)** —
   fully diagnosed after two rounds (first wrong, then corrected via direct testing — see the
   writeup, it's a useful cautionary example about trusting dated code comments over live requests).
   **Real cause: Yahoo's `quoteSummary` now requires a CSRF-style crumb+session-cookie**, confirmed
   via direct `curl` (identical `"Invalid Crumb"` response with or without the new proxy). NOT the
   IP-blocking the existing 2026-04-16 code comment describes — that may have been true then, isn't
   now. **Not fixed** — needs a real code change (implement Yahoo's crumb flow) that wasn't
   attempted this session. The `PROXY_URL` credential obtained while chasing this wrong-then-right
   diagnosis is still real, live infrastructure, just not the fix for this specific item.
5. **Orphaned crons — all 4 resolved** (was the prior handoff's item 5, "scheduling decisions, not
   code fixes"):
   - `infra`: `seed-infra.mjs`'s one non-redundant warm-ping (`list-temporal-anomalies`) folded into
     `ais-relay.cjs`'s existing loop; **`seed-infra.mjs` deleted**, all 7 references to it elsewhere
     fixed (comments, `.env.example`, `api/health.js`, 2 tests).
   - `regulatory-actions` and `internet-outages`: both folded into `bundle-derived-signals` as new
     members (2h and 30min intervals respectively), reusing its already-scheduled 5min outer cron —
     no new schedule entries needed.
   - `webcams`: operator decided not worth pursuing (missing `WINDY_API_KEY`) — removed its
     `api/health.js` alarm so it stops looking like a silent failure.
   - **Bonus bug found+fixed along the way**: `outages`' own `api/health.js` alarm had only a 1x
     staleness margin (would false-alarm on any single missed run) — bumped to 3x, matching this
     repo's usual convention.
6. **Full unit suite baseline re-established rigorously**, twice — via `git stash`/`stash pop`
   round-trips rather than trusting the prior session's approximate "~40-41" figure. True clean-tree
   baseline: **exactly 40 failures across 7 suites** (1 flaky — `readBootstrapTierObject`,
   appears/disappears across otherwise-identical `--test-concurrency=16` runs, unrelated to any code
   — worth someone eventually diagnosing but not this session). With every change in this session
   restored, the failing-suite list matches that baseline exactly both times checked — zero net-new
   failures introduced. `npx tsc --noEmit` clean throughout.

**Still open, in priority order for the next session**:
- **APP_DOMAIN/API_BASE_URL gap (item 3 above)** — arguably the highest-leverage item now: until a
  local `API_BASE_URL` override + reachable local gateway address exists, NO seed script's RPC-call
  behavior can be verified against this fork's own code, only against upstream production. This
  blocks confidently verifying item 2's fix and item 4's eventual crumb-flow fix, and calls into
  question older "verified locally" claims. Not a quick fix — needs someone to decide what "this
  fork's own local gateway" even means as a reachable URL under Nitric's dev model.
- **Yahoo Finance crumb flow (item 4)** — concrete, scoped next step if Sector ETF data matters:
  implement a real crumb+cookie fetch in `scripts/ais-relay.cjs`'s `fetchYahooQuoteSummary` (Yahoo's
  documented pattern: fetch a session cookie + crumb token first, attach both to the `quoteSummary`
  request). Not started.
- **`military:bases` full coverage** — still externally blocked, unchanged from the prior handoff:
  Polyglobe `SUPABASE_ANON_KEY` (nobody has it), OSM regional-fetch blocked by this machine's network
  throughput ceiling to `overpass-api.de` (code is correct and committed, needs a normal-bandwidth
  environment to actually run).
- **Remaining untriaged log-noise clusters from the prior handoff, NONE touched this session** —
  `[scenario-worker] BLMOVE error` (~1,161 occurrences/8.5h, possibly Upstash REST quota burn from a
  polling-frequency issue), `[TheaterPosture] OpenSky failed: OpenSky proxy 503` (~1,035
  occurrences), `[UCDP-Events] v# failed` (~969 occurrences), `military:flights` no-prior-data skip
  (~855 occurrences, likely cascades from one of the above). Apply the same lesson this session
  relearned twice: verify live behavior directly before trusting a hypothesis, dated comment, or
  prior session's framing.

---

## 🔀 HANDOFF (2026-08-18, twenty-fifth session end) — superseded by the block above, kept for history

**Repo context, confirmed by the operator this session (don't re-litigate)**: this repo is a
**fork of the official worldmonitor.app**, mid-refactor. Convex/Clerk → Supabase is done (see
`retire_convex_saas_complete.md`). **Railway has been abandoned entirely** — any "production
Upstash Redis is deployed and monitored" framing you find in older sections below this one is
stale; that deployment never existed in the form described. All cron/seed-bundle orchestration is
moving to **Nitric-SDK-managed GCP infra**, currently still local-dev-only: `nitric.yaml`
(scaffold, "no `nitric up` has been run") + `nitric start` run locally is the actual dev workflow.
**Do not ask for Railway logs or install the Railway CLI — there is nothing there.** Fuller
narrative: memory `fork_and_nitric_gcp_refactor.md`.

**Git state**: `main` is 7 commits ahead of `origin/main`, 0 behind, working tree clean as of this
handoff. Operator pushes manually — don't push unprompted.

**`nitric start` is currently running** (PID varies — `pgrep -fl "^nitric start$"`), live since this
session's second restart. **Restart it after any `.env` edit** — it does not hot-reload; verify a
new value took effect by checking `pgrep -f "scripts/ais-relay.cjs"` respawned after the restart.
`.nitric/services.log` is a JSON-lines log (grows large — 50MB+/8h) with one line per event; pipe
through a Python `Counter` on normalized `msg` text before triaging rather than reading raw.

**Resolved this session** (5 commits `1d3fa0f`..`24b94d2` — see each item's full writeup below for
what was actually done, this is just the index; numbers refer to the fix-list items further down):
- Fix-list items 1-2 (former "P1"s) reclassified — not empty production, root-caused differently.
- Fix-list item 3, `military:bases` R2 bucket, populated with a real (if smaller-than-intended)
  dataset.
- `RELIEFWEB_APPNAME` (not on the original numbered fix list — a separate credential the operator
  received approval for mid-session) approved + wired up, `climate-disasters` pulls real ReliefWeb
  data again.
- Fix-list item 4, Groq model 404s, fixed across all 7 live call sites, `GROQ_MODEL` env var added.

**Still open, in priority order for the next session**:
- ~~`WORLDMONITOR_RELAY_KEY` unset~~ — **resolved (2026-08-19, twenty-sixth session)**: generated a
  dedicated random secret (`openssl rand -hex 32`, NOT a `WORLDMONITOR_VALID_KEYS` entry — see
  `server/gateway.ts`'s `isRelayWarmPingRequest`), set in local `.env`, restarted `nitric start`
  (killed an orphaned `ais-relay.cjs` child that survived the parent's death — check for this on any
  future restart, `pgrep` the child scripts not just the parent). Verified via fresh log line
  `[Relay] WORLDMONITOR_RELAY_KEY configured`. Also fixed 5 stale comment sites that documented the
  old "reuse a `WORLDMONITOR_VALID_KEYS` value" approach + Railway framing (`.env.example`,
  `seed-infra.mjs`, `seed-service-statuses.mjs`, `seed-military-maritime-news.mjs`,
  `seed-insights.mjs`) — not committed yet, comment-only diff. Local verification of warm-ping RPCs
  and the `news:digest` re-check (item 6) can now proceed.
- ~~Orphaned crons~~ (item 5) — **all 4 resolved, 2026-08-19, twenty-sixth session**: `infra` folded
  into `ais-relay.cjs`, `seed-infra.mjs` deleted; `regulatory-actions` and `internet-outages` both
  folded into `bundle-derived-signals` (operator supplied `CLOUDFLARE_API_TOKEN` mid-session,
  verified live before use); `webcams` alarm removed (operator's call, not worth pursuing). Also
  fixed a real pre-existing bug found along the way: `outages`' health.js alarm had only a 1x
  staleness margin, bumped to 3x. Full unit suite re-verified against a true clean-tree baseline (via
  `git stash`) twice, typecheck clean both times. See item 5's full writeup for details.
- **`military:bases` full coverage** — two independent gaps, both external: the Polyglobe
  `SUPABASE_ANON_KEY` (nobody has it, operator doesn't know where Polyglobe's site is either), and
  OSM's regional-partition fetch (code is correct and committed, just needs to run from a machine
  without this session's network throughput ceiling — see item 3's full writeup).
- ~~`news:digest` re-verify~~ — **re-verified (2026-08-19, twenty-sixth session), real gap found and
  fixed, but the fix is UNVERIFIED — see the APP_DOMAIN finding below, it's the more important
  result of this investigation.** `/api/news/v1/list-feed-digest` was never in `server/gateway.ts`'s
  `RELAY_WARM_PING_PATHS`, so no value of `WORLDMONITOR_RELAY_KEY` could ever have warmed it —
  confirmed empirically, then fixed with operator approval (1-line allowlist addition). Submarine-
  Cables timeout still unverified — separate cause (network throttle), not re-checked this session.
- **NEW, significant — seed scripts silently call the REAL LIVE upstream `api.worldmonitor.app`,
  not this fork's own code**, unless a currently-nonexistent `API_BASE_URL` override is set. Found
  while re-verifying the fix above (see category 9's writeup for the full trace). This means **any
  earlier session's "verified against local nitric start" claim involving an RPC call — not a direct
  Redis read — should be treated with suspicion** until re-checked with this in mind; the RPC leg
  may have silently hit upstream production instead of this fork's local gateway the whole time.
  Not investigated further this session (operator's explicit call) — the fix for it (a local
  `API_BASE_URL` + reachable local gateway address) doesn't exist yet.

**New finding from this session, not yet triaged — quantified log noise nobody has looked at
individually.** While debugging the live `nitric start` log (see item 2's writeup for method), a
`Counter` over 8.5h of `.nitric/services.log` surfaced several recurring errors that were *not*
investigated this session (all effort went to items 1-4 above). Rough frequency, in one 8.5h
window, most-frequent first:
- ~~`[Sector] Yahoo quoteSummary <TICKER> HTTP 401`~~ — **fully diagnosed (2026-08-19, twenty-sixth
  session) after TWO rounds of investigation, both partially wrong before real testing settled it —
  see the correction trail below, it's a useful cautionary example.**

  **Round 1 (wrong)**: assumed the crumb/cookie hypothesis from the original untriaged note was
  wrong, based on `fetchYahooQuoteSummary`'s 2026-04-16 code comment attributing this 401 to Yahoo
  IP-blocking Railway's egress — without actually testing what Yahoo returns today. Got the operator
  a real Decodo proxy credential (`dc.decodo.com`, a datacenter endpoint) on that theory, wired it
  into `PROXY_URL`, restarted `nitric start`, confirmed the proxy fallback now genuinely executes
  (new `"... proxy HTTP 401"` log line, not a silent no-op — the wiring itself is correct and the
  credential is real/live, verified independently via `curl` against `ip.decodo.com`) — **but the
  401 persisted even through the proxy.**

  **Round 2 (correct, verified directly)**: `curl`'d Yahoo's `quoteSummary` endpoint directly, both
  through the new proxy and with no proxy at all. **Identical response both ways**:
  `{"finance":{"result":null,"error":{"code":"Unauthorized","description":"Invalid Crumb"}}}`. This
  settles it — **it is not, or at least is no longer, IP-based blocking; it's Yahoo's CSRF-style
  crumb+session-cookie requirement**, which is exactly the original untriaged note's hypothesis (the
  one this session initially, wrongly, overrode). Neither `fetchYahooQuoteSummary` nor
  `_yahooQuoteSummaryProxyFallback` (`scripts/ais-relay.cjs:2010-2112`) implement a crumb/cookie
  flow at all — both just send `User-Agent`/`Accept` headers, so both were always going to 401
  regardless of egress IP. The 2026-04-16 comment may have been accurate for what Yahoo enforced
  *then*; it does not describe what's failing *now*.

  **Net result**: the `PROXY_URL`/Decodo credential is now live in `.env`, real, and confirmed
  working against an actual proxy-check service — worth keeping for the 8 other scripts that consume
  it (`seed-military-flights.mjs`, `seed-economy.mjs`, `seed-resilience-static.mjs`,
  `seed-bundle-portwatch-port-activity.mjs`, `seed-fuel-prices.mjs`, `seed-unrest-events.mjs`,
  `seed-energy-intelligence.mjs`, `seed-portwatch-chokepoints-ref.mjs`, worth rechecking each
  individually rather than assuming any of them are fixed by this). But it does **not** fix the
  Sector/Yahoo 401 — that needs a real code change (implement Yahoo's crumb flow: fetch a session
  cookie + crumb token from Yahoo first, attach both to the `quoteSummary` request), not a config
  change. Not implemented this session — flagged as the next concrete step if this data source is
  wanted; deliberately not attempted without discussing scope/effort first.

  **Lesson for future sessions, stated plainly**: a dated code comment explains what was true when
  it was written, not necessarily what's true now — verify current behavior with a real request
  before trusting or overriding a hypothesis based on a comment alone. This session did that wrong
  once (dismissed the correct hypothesis) before doing it right (direct `curl` test settled it).
- `[scenario-worker] BLMOVE error` — two distinct variants seen (`max requests limit exceeded` and
  plain `fetch failed`), ~1,161 occurrences. Possibly a polling-frequency issue against Upstash's
  REST API (which doesn't support true blocking commands) burning through request quota fast.
- `[TheaterPosture] OpenSky failed: OpenSky proxy 503 for WESTERN` — ~1,035 occurrences. Upstream
  proxy issue, not diagnosed.
- `[UCDP-Events] v# failed: UCDP GED API error` — ~969 occurrences, not diagnosed.
- `military:flights:v1 read returned no flights, no prior intelligence:military-cii:v1 — skipped
  publish` — ~855 occurrences. Likely cascades from one of the above rather than its own root
  cause — check whether a flights-source failure upstream explains this before treating it
  separately.
None of these were confirmed as real bugs vs. expected-degraded-mode vs. another instance of this
session's network-throughput-ceiling finding (see item 2) — that's the first thing to check for
each, the same way item 2 turned out not to be the bug it first looked like.

**What this session actually did on items 1-4, working directly against a live local `nitric
start`** (was already running, 8.5h stale at session start — restarted to pick up `.env` changes):

1. ~~P1 — resilience:score/ranking empty~~ — **reclassified, not investigated further this
   session**. The "empty in production" framing doesn't apply (no production existed to be empty).
   Whether this resolves once the Nitric/GCP dev stack actually runs the resilience bundle for a
   full cycle is untested — pick this up by watching `.nitric/services.log` for
   `Bundle:resilience` output during a `nitric start` session, not by chasing Railway.
2. ~~P1-adjacent — correlation/cross-source-signals empty~~ — **root-caused and fixed differently
   than hypothesized.** Not a "199-command unchunked pipeline" problem (these pipelines are only
   9-20 keys) — the actual cause is 2 large individual values
   (`market:stocks-bootstrap:v1` ~180KB + `market:commodities-bootstrap:v1` ~227KB) moving over a
   **destination-specific local network throttle to Upstash** (~9-11 KB/s measured, confirmed NOT
   VPN-routing via the `local-network-optimizer` skill — bypassing the tunnel made no difference;
   confirmed NOT GCP-wide — `storage.googleapis.com` ran 8x faster on the same link). No further
   network-level fix exists locally (private Redis instance, no mirror possible). **Mitigated**:
   bumped `seed-correlation.mjs` (10s→45s) and `seed-cross-source-signals.mjs` (15s→45s) pipeline
   timeouts, comment explains why. Once run against real cloud infra this class of timeout should
   simply not occur (normal cloud-to-cloud bandwidth) — don't carry the 45s number forward as a
   "real" requirement, it's a local-throttle accommodation.
3. **Two unrelated real bugs found + fixed while investigating the above**, both committed:
   `scripts/ais-relay.cjs`'s OREF history bootstrap was missing a proxy-availability guard its
   sibling function already had (wasted ~21s/relay-start on guaranteed-fail curl calls);
   `nitric.yaml`'s `seed-bundle-resilience-validation` entry was missing the `NODE_OPTIONS`
   tsx-loader wiring its Railway Dockerfile counterpart sets, so its Sensitivity-Suite step always
   failed importing a `.ts` file. **Treat `nitric.yaml` gaps like this as a bug class** — it was
   hand-written to approximate the old Railway Dockerfiles rather than derived from them, so other
   entries may have similar silent gaps if failures surface.

Items 3 and 4 below (military:bases R2, Groq 404s) were resolved later in this same session — see
their own ✅ writeups. Items 5-6 (orphaned crons, lower-priority re-verify list) were not touched —
still open, and any "deployed on Railway" framing inside them is stale.

### The fix list, in priority order (items 1-2 above are now historical — see reclassification)

3. ✅ **RESOLVED (2026-08-18, twenty-fifth session)** — `military:bases` R2 bucket populated,
   `military:bases:active` confirmed live in Redis (1,058 entries, validated via `ZCARD`/`HLEN`
   sample-check inside `seed-military-bases.mjs` itself). **Shipped with a real but reduced
   dataset** — neither of the two largest intended sources was obtainable this session, both for
   external reasons outside this repo's code:
   - **`pizzint-processed.json` (intended ~79K records, primary)**: needs `SUPABASE_ANON_KEY` for
     an external "Polyglobe" Supabase project (ref `qevdnlpgjxpwusesmtpx`) — a public anon key, but
     not one this repo or its history has ever held. Operator supplied a key on request; verified
     live against the Polyglobe project and got `401 Invalid API key ... might also be owned by
     another Supabase project` — confirmed it was this app's own (different) Supabase key, not
     Polyglobe's. Operator doesn't know where to find the real one. **Still open** — if anyone finds
     Polyglobe's actual public site/app, its anon key is likely visible client-side there.
   - **`osm-military-processed.json` (secondary, public API, no credential needed)**: two real
     things found and fixed in `scripts/fetch-osm-bases.mjs`, but a third thing couldn't be fixed
     from this session's network:
     1. Node's `fetch()` got `406`/`504` from `overpass-api.de` where curl with identical headers
        got `200` — a TLS/HTTP client-fingerprinting difference, not a fixable header (tested
        `User-Agent`/`Accept` individually and together). **Fixed**: switched to `execFileSync`
        curl, same pattern as `ais-relay.cjs`'s `orefCurlFetch`.
     2. The original query was global/unbounded (no bbox) — too large for the public instance to
        complete even at a 15min budget (partial 550KB delivered, then a genuine server-side 504
        after the full 14min). **Fixed**: partitioned into 8 continent-scale regional bbox queries,
        merged + deduped by `osm_id` across regions, individual region failures logged and skipped
        rather than failing the whole fetch.
     3. **Not fixed — genuine local throughput limit**: even continent-scale regions timed out
        (N. America, S. America both 504'd), while a trivial single-point query succeeded in <5s —
        ruling out rate-limiting. This is the same class of destination-specific throughput ceiling
        diagnosed for Upstash earlier this session (see the handoff above), just against a
        different host (`overpass-api.de`, Germany, not GCP) — so possibly a broader pattern on
        this connection, not Upstash-specific. **The regional-partition code is still correct and
        worth keeping** — it's the standard fix for a global Overpass query against a shared public
        instance, and should work from an environment with normal bandwidth (e.g. once actually
        deployed). Re-run `node scripts/fetch-osm-bases.mjs` from such an environment to get real
        OSM coverage; no further local fix exists for this session's connection.
   - **What shipped instead**: `build-military-bases-final.mjs`'s hard-fail gate
     (`!pizzintRaw && !osmRaw`) was overly conservative — Steps 2-4 (OSM/MIRTA/curated merges) are
     each independently gated and don't actually require Step 1 (pizzint/osm) to have populated
     anything. Relaxed the gate to only fail if *all four* sources are missing, with loud
     `console.warn` when falling back to the smaller mirta+curated-only path (832 + 226 = 1,058
     entries after dedup, 0.3MB) so this never silently looks like the full dataset. **To get the
     real ~79K+ dataset**: either source the Polyglobe key, or re-run the OSM regional fetch from
     an environment without this throughput ceiling.

4. ✅ **RESOLVED (2026-08-18, twenty-fifth session)** — Groq model 404s fixed, commit `6147e6b`.
   Replaced `llama-3.1-8b-instant` / `llama-3.3-70b-versatile` with `openai/gpt-oss-20b` across all
   7 live call sites (not 9 — 2 of the originally-listed sites turned out to be the same file's 2
   literals; a fresh grep also found `scripts/lib/llm-chain.cjs` had a matching literal, but it's
   explicitly deferred, see below), each overridable via a new `GROQ_MODEL` env var (mirrors
   `OLLAMA_MODEL`'s existing pattern) — operator's decision, confirmed live: gpt-oss-20b over
   gpt-oss-120b (identical rate limits) and over Prompt Guard (ruled out — it's a classifier, not a
   text generator, live-verified: asked for a summary, got a bare probability score back).
   **Real complication found along the way**: gpt-oss models are *reasoning* models (unlike the
   retired llama ones) — live-tested a 5-token budget spent entirely on hidden reasoning tokens,
   returning empty content. Added `reasoning_effort: 'low'` to every groq `extraBody` (Groq's own
   param, no hard "off" exists) — same failure class `server/_shared/llm.ts` already documents for
   OpenRouter's DeepSeek V4 under `#4983`. Live-verified end-to-end via `callLlm()`: real content,
   correct model, `finishReason: stop` (not truncated).
   **Rate-limit correction**: confirmed via Groq's own docs that every real text-generation model on
   this account's free tier (gpt-oss-20b, gpt-oss-120b, qwen3.6-27b) shares an identical 1,000
   req/day cap — not model-specific, an account-tier constraint switching models doesn't escape.
   Accepted given Groq is a last-resort fallback tier only. Also fixed a stale `.env.example`
   comment claiming "14,400 req/day" for `GROQ_API_KEY` — that figure was actually Prompt Guard's
   limit, not the chat models the key is used for.
   **`scripts/lib/llm-chain.cjs` deliberately NOT touched** — its own comment says "Do not swap it
   in isolation," gated on a separate DeepSeek migration (`#4944`), and its sole caller already pins
   to openrouter (`skipProviders`), so the dead literal there is unreachable in practice.
   **`critical_signals`** (a probability-coupled, review-pinned stage in `seed-forecasts.mjs`) got
   its own `FORECAST_LLM_CRITICAL_MODEL_GROQ` env var rather than inheriting the global
   `GROQ_MODEL` — preserves the existing isolation pattern (`FORECAST_LLM_CRITICAL_MODEL_OPENROUTER`
   already works this way, review finding `#4965`).
   Fixed 5 assertions in `tests/forecast-detectors.test.mjs` that were pinned to the old literals;
   the other 4 test files referencing them needed no changes (self-consistent mock fixtures, not
   real assertions) — confirmed via full run, 373/373 pass. Full-suite run also surfaced 1 more
   failure than the documented 40-baseline, confirmed pre-existing and unrelated: a Railway-registry
   coverage test expecting 3 Dockerfiles that moved into `nitric.yaml` back on 2026-08-06 (weeks
   before this session) — not a regression from this fix, not touched.

5. ~~**Orphaned crons**~~ — **all 4 resolved (2026-08-19, twenty-sixth session), operator decided
   each individually:**
   - ✅ **`infra`**: confirmed `list-temporal-anomalies` was genuinely `seed-infra.mjs`'s only
     non-redundant target (the other 2 — `list-service-statuses`, `get-cable-health` — were already
     duplicated by `ais-relay.cjs`'s own loop). Folded a 4th warm-ping (`seedTemporalAnomaliesWarmPing`
     / `startTemporalAnomaliesWarmPingLoop`, 15min interval = the 45min health.js alarm ÷ 3, same
     margin convention as CableHealth) directly into `ais-relay.cjs` (`scripts/ais-relay.cjs`, added
     right after `startCableHealthWarmPingLoop`, invoked alongside the other 3 warm-ping loops at
     startup). **`scripts/seed-infra.mjs` deleted.** Updated everything that referenced it: the
     `RELAY_API_KEY` rationale comment (moved to `seed-service-statuses.mjs`, other 2 siblings
     repointed there), `.env.example`, `api/health.js`'s `temporalAnomalies` alarm comment, and
     `tests/seed-warm-ping-origin.test.mjs` (now reads `ais-relay.cjs` instead). Also had to fix
     `tests/relay-boot-seed-freshness-guard.test.mjs`'s exact-wiring `SEEDERS` list (adding the new
     loop; its "exactly N boot seeds, no drift" count self-corrects off `SEEDERS.length`).
   - ✅ **`regulatory-actions`**: folded into `bundle-derived-signals` (`scripts/seed-bundle-derived-signals.mjs`)
     as a new member, `intervalMs: 2*HOUR` matching health.js's existing 360min alarm — reuses the
     bundle's already-scheduled 5min outer cron rather than needing a new schedule entry (each member
     gates independently, e.g. its existing `Regional-Snapshots` member already sits at 6h in the
     same bundle). No new files, no `nitric.yaml`/`railway-services.json` changes needed.
   - ✅ **`internet-outages`**: operator supplied `CLOUDFLARE_API_TOKEN` later the same session.
     Verified live before touching anything: `curl`'d all 3 Cloudflare Radar endpoint groups
     (`radar/annotations/outages`, `radar/attacks/layer3/*`, `radar/traffic_anomalies`) directly —
     all `HTTP 200` — then ran the real seed script end-to-end (`node --env-file=.env
     scripts/seed-internet-outages.mjs`), confirmed all 3 keys written (`infra:outages:v1`,
     `cf:radar:ddos:v1`, `cf:radar:traffic-anomalies:v1`), ~8s runtime. Folded into
     `bundle-derived-signals` as a new member (`intervalMs: 30*MIN`, matching the script's own
     `CACHE_TTL` comment — "6x the 30 min cron interval"), same pattern as Regulatory-Actions above.
     **Also found and fixed a real pre-existing bug while investigating cadence**: `api/health.js`'s
     `outages` alarm was `maxStaleMin: 30` on a 30min cadence — a 1x margin (any single missed run
     would immediately false-alarm), inconsistent with this repo's usual 3-4x convention (its own
     sibling entries `ddosAttacks`/`trafficAnomalies` already use 4x). Bumped to 90 (3x). Confirmed
     via `tests/health-classify.test.mjs`'s existing `outages` tests that nothing depended on the old
     value (the one test using a 200min-stale fixture exceeds both 30 and 90, so its assertion was
     unaffected — only fixed a comment that cited the stale number).
   - ✅ **`webcams`**: operator decided not worth pursuing (WINDY_API_KEY gap). Removed its
     `maxStaleMin: 1440` alarm from `api/health.js`'s `SEED_META` table (was a permanent false
     "looks broken" signal on a key nothing will ever populate) — the friendly-name key registry
     entry (a separate table, `STANDALONE_KEYS`) was left alone, it's not tied to alerting.
   - **All changes verified, including the internet-outages follow-up**: `npx tsc --noEmit` clean;
     full unit suite re-run against a `git stash` clean-tree baseline for a true comparison (not
     trusting the older ~40-41 approximate figure) — baseline was exactly 40 failures across 7 suites
     (1 flaky: `readBootstrapTierObject`, appeared/disappeared across otherwise-identical runs under
     `--test-concurrency=16`, unrelated to any code), all pre-existing and undiagnosed before this
     session. With every change in this item restored, the failing-suite list is IDENTICAL to the
     clean baseline both times (before and after the internet-outages follow-up) — the 2 tests the
     `infra`/`webcams` work broke were fixed to describe the new intended behavior, not reverted or
     skipped; zero net-new failures across the whole item.
   - **`CLOUDFLARE_API_TOKEN` permission scope, for reference**: read-only, account-scoped Radar/
     Analytics access, no Zone Resources, no write permissions — verified this is sufficient (all 3
     endpoint groups returned real data with the token as configured). Cloudflare's dashboard wording
     for this scope wasn't independently confirmed against a live token-creation screen.

6. **Lower-priority / needs re-verification, not confirmed bugs — don't spend time here until 3-5
   are closed.** `news:digest*` reading empty (category 9) is plausibly just a 900s on-demand cache
   behaving normally, not a bug — re-verify per the category-9 section's suggested probe
   (`WORLDMONITOR_RELAY_KEY` set + immediate read) before treating it as broken. Submarine-Cables'
   timeout in `bundle-static-ref` (category 10) is plausibly the standard local network throttle —
   this session confirmed that exact throttle is real and destination-specific to Upstash (see the
   handoff above), so it's very plausibly the same cause here too; re-check once/if the throttle is
   ever resolved rather than assuming it's a code bug. `seed-service-statuses` reading empty is
   explicitly by-design (on-demand, excluded from strict alarms) — not on this list at all, do not
   "fix" it.

### Consolidated credential checklist — resolve what you can before starting item 3

Ask the operator for these (a var being unset in this local `.env` may or may not be set wherever
this eventually deploys — check before assuming either way, and don't assume Railway has it, that
platform is abandoned):
- `CLOUDFLARE_API_TOKEN` — blocks `internet-outages` (item 5)
- `WINDY_API_KEY` — blocks `webcams` (item 5)
- `WORLDMONITOR_RELAY_KEY` — blocks local verification of `insights`/`infra`/`service-statuses`
  warm-ping RPCs and the `news:digest` re-check (item 6) — confirmed unset in this session's live
  `nitric start` run too (`.nitric/services.log` shows repeated 401s from `ais-relay.cjs`'s
  warm-ping loops: `[CII]`, `[CableHealth]`, `[Chokepoints]`, `[ServiceStatuses]`)
- `WORLDMONITOR_SEED_REFRESH_KEY` — blocks local diagnosis of item 1 (now lower priority, see
  reclassification above)

### ✅ Deferred item B RESOLVED — `resend` was never actually missing; the handoff's diagnosis across three sessions was wrong

Sessions 22/23/this session's own start all recorded "`resend` is not in `node_modules` and not in
`package.json` — the script can never start, needs `pnpm add resend`." **All three were reading the
wrong manifest.** This repo has two `package.json` files: the root one (the web app) and
**`scripts/package.json`** (the Railway relay/seeder package, name `worldmonitor-railway-relay`).
`resend: "^4"` has been declared in `scripts/package.json` **the whole time** —
`Dockerfile.digest-notifications` installs it with `npm ci --prefix scripts --omit=dev`, exactly as
documented in the Dockerfile's own header comment ("Install scripts/ runtime dependencies (resend,
convex, etc.)"). The *deployed* cron was never broken. The only real gap was that
`scripts/node_modules/` (gitignored) had never been installed in this local checkout.

**Fix applied**: ran `npm ci --prefix scripts --omit=dev` (175 packages, `resend@4.8.0` present).
No `pnpm add` — this project uses npm (`package-lock.json`, no `pnpm-lock.yaml`), and adding
`resend` to the *root* manifest would have created a second, driftable declaration. **Zero tracked
files changed** — `scripts/node_modules/` is gitignored (`.gitignore:1`).

**`RESEND_API_KEY` added to `.env`** (operator supplied it this session — `re_KmzsJoS8...`).
`RESEND_FROM_EMAIL`/`RESEND_FROM_BRIEF` deliberately left unset (they must be a Resend-verified
sender domain; leaving them unset exercises the documented `WorldMonitor Brief <brief@$APP_DOMAIN>`
fallback in `normalizeResendSender`, which is correct behavior to test, not a gap to fill blind).

**Verification, safe by construction**: `DIGEST_CRON_ENABLED=0 node --env-file=.env
scripts/seed-digest-notifications.mjs` proved the full ~40-file import graph (createRequire +
static imports across `shared/`, `server/_shared/`, `api/`) resolves cleanly — that kill switch
exits *after* every top-level import but *before* `main()`, so it's a zero-side-effect import-graph
smoke test for a 3010-line script. Then ran it for real (see category 9 table below) — it reached
`main()`, ran the watchlist scan, and exited clean at "No digest rules found" because
`SUPABASE_SERVICE_ROLE_KEY` is unset locally, which makes `getSupabaseAdmin()` return `null` and
`fetchDigestRules()` fail-closed to `[]` **before any Resend send is reachable**. Confirmed this by
reading `scripts/lib/supabase-admin.cjs` *before* running — this is a fail-closed guard, not a
lucky no-op, so it was safe to run for real rather than only smoke-test.

### ▶ Category 9 EXECUTION LOG — 2026-08-18 (session 24)

**✅ Category 9, News, Intel & Briefs (7 scripts) — DONE.** All 7 exercised.

| Script | Result |
|---|---|
| `regulatory-actions` | ✅ 55 records — **FILLED AN ABSENT PRODUCTION KEY**. 4/6 RSS feeds succeeded (SEC, Fed, FDIC×partial, FINRA); CFTC×2 → HTTP 403 from Cloudflare (verified: 403 regardless of UA/headers — a Cloudflare bot-challenge on the outbound IP, not a header bug); FDIC → one timeout, non-fatal (`Promise.allSettled`, needs only 1/6 to succeed) |
| `research` | ✅ healthy — arXiv (3 categories, 150 papers), GitHub Trending (3 langs), HN top+best, dev.events (99), Techmeme timed out (non-fatal) |
| `displacement-summary` | "Failed gracefully" — network timeout after 3 retries, TTL extended on existing 2 keys, no data loss. Consistent with the documented local throttle; already healthy in production via category-3's `bundle-health` |
| `bundle-regional` (regional-snapshots + regional-briefs) | ran 36.7s — regional-snapshots persisted 8/8 regions; regional-briefs correctly cooldown-skipped (4.9d < 6.5d) |
| `insights` | ✅ 8 records, healthy — digest warm-cache RPC 401'd locally (`WORLDMONITOR_RELAY_KEY` unset, long-standing deferred item D), correctly fell back to LKG (reused existing insights) rather than failing |
| `digest-notifications` | ran to completion, exit 0 — see resend section above. `resend` import resolved; exited safely at "No digest rules found" (Supabase creds gap, fail-closed, expected) |

Two pre-identified problem areas from the pre-analysis, now resolved/explained:

**1. `regulatory-actions` "produces nothing in production" — NOT a code bug, it's an orphaned
cron.** The seeder itself works (55 records this run, clean data). Checked
`scripts/railway-services.json` (36 entries) and every `seed-bundle-*.mjs`'s section table
(`grep -c "script: 'seed-regulatory"` across all bundles → **0**): `seed-regulatory-actions.mjs` is
registered in **no Railway service and no bundle**. Nothing on any schedule ever invokes it — that's
why `seed-meta:regulatory:actions` was absent, not a runtime failure. This needs an operator
decision (new standalone Railway cron, or fold into an existing bundle like
`bundle-derived-signals`) — not something to wire up unprompted.

**2. `news:digest*` "empty in production" — a plausible ephemeral-cache explanation, not confirmed
either way; worth the next relevant session verifying rather than assuming brokenness.**
`news:digest:v1:full:en` is written by `server/worldmonitor/news/v1/list-feed-digest.ts` via
`cachedFetchJson` with a **900s (15min) TTL**, populated on-demand by live traffic (the frontend's
`src/app/data-loader.ts` calls this RPC directly — this is a real user-facing endpoint, not
seed-only). Critically, `cachedFetchJson`'s fetcher returns `null` when `buildDigest()` yields zero
items, which **explicitly skips the Redis write** and caches a 120s negative-sentinel instead — so
if upstream RSS is thin at generation time, the canonical key legitimately stays absent even under
live traffic. A point-in-time probe catching this key empty is therefore expected/normal behavior
for a short-TTL, demand-driven cache, not proof of an outage — unlike `resilience:ranking:v25`
(category 8's P1), which has no such short-TTL/on-demand design and an explicit 14h staleness
monitor. `seed-insights.mjs`'s LKG fallback (this session, and presumably production) means
insights' own health is decoupled from digest's momentary state, which is why `news:insights:v1`
reads fresh while `news:digest*` reads empty — they're on different cadences by design, not one
masking a failure in the other. **Next step if this needs a real answer**: with
`WORLDMONITOR_RELAY_KEY` set, run `insights` (which calls the warm-cache RPC) and immediately GET
`news:digest:v1:full:en` before the 900s TTL lapses, to see whether it actually populates.

**Re-run (2026-08-19, twenty-sixth session) — ran the probe above with the key now set. Result:
still 401, but for a DIFFERENT reason than "key unset" — a real, previously-undiscovered gap, not
the ephemeral-cache explanation above.** `seed-insights.mjs`'s warm-ping hits
`/api/news/v1/list-feed-digest` (`scripts/seed-insights.mjs:459`) — but `server/gateway.ts`'s
`RELAY_WARM_PING_PATHS` allowlist (lines 371-377) only contains 5 infra/intel endpoints
(`list-service-statuses`, `get-cable-health`, `list-temporal-anomalies`, `get-risk-scores`,
`get-chokepoint-status`); `list-feed-digest` was never added. `isRelayWarmPingRequest` returns
`false` unconditionally for any path not in that set (`server/gateway.ts:618`), before it even
looks at the key — so **no value of `WORLDMONITOR_RELAY_KEY` could ever have made this warm-ping
succeed**, key-unset was never the actual blocker. Confirmed empirically: ran
`node --env-file=.env scripts/seed-insights.mjs` live (`[Relay] WORLDMONITOR_RELAY_KEY configured`
logged, so the key itself was correctly picked up) — got `Digest warm failed: HTTP 401` anyway, and
an immediate `news:digest:v1:full:en` GET right after came back `ABSENT (ttl: -2)`, same as the
untouched baseline taken moments before the run. Not a coincidence/timing issue — the request never
reached `buildDigest()` at all.

**Decision made, fix applied, but UNVERIFIED — see the APP_DOMAIN finding right below for why.**
Operator approved adding `/api/news/v1/list-feed-digest` to `RELAY_WARM_PING_PATHS`
(`server/gateway.ts:371-378`, committed shape matches the other 5 entries). Re-ran
`node --env-file=.env scripts/seed-insights.mjs` after `tsx watch` auto-restarted on the source
change (confirmed via `.nitric/services.log`: `[tsx] change in ./server/gateway.ts Restarting...`)
— **still got HTTP 401**, same as before the fix. This is NOT evidence the fix is wrong; see below.

### ⚠️ NEW FINDING — seed scripts default to the REAL LIVE upstream `api.worldmonitor.app`, not this fork's own (undeployed) local gateway

While re-verifying the fix above, discovered the actual reason the re-test still 401'd: it was never
exercising this repo's own code at all. `seed-insights.mjs`'s `warmDigestCache()` calls
`resolveApiOrigin(process.env.APP_DOMAIN)` (`scripts/_domain-config.mjs:67-71`); local `.env` has
`APP_DOMAIN=worldmonitor.app` and no `API_BASE_URL` override, so this resolves to
`https://api.worldmonitor.app` — confirmed **live and answering** (`curl` → `HTTP 403`), not the
local `nitric start` gateway process this session's `gateway.ts` edit lives in. Given this repo is a
fork of the official worldmonitor.app (`fork_and_nitric_gcp_refactor.md`), the coherent explanation
is `.env`'s `APP_DOMAIN` still points at the **original upstream project's real production site**,
carried over from the fork, not at anything this fork operates — which has no live deployment at
all per that same memory. No local port/URL for the Nitric-managed gateway was found for scripts to
target instead (checked `.nitric/services.log`, `nitric.yaml` — no explicit local bind address
surfaced).

**Consequence, flagged not yet acted on**: any seed script using the default
`resolveApiOrigin(APP_DOMAIN)` path without an explicit local `API_BASE_URL` override is silently
calling the real upstream site, not this fork's code — meaning **any prior session's "verified
against local nitric start" claim involving an actual RPC call (not a direct Redis read) deserves a
second look**, since the RPC leg of that test may have hit upstream production rather than this
fork's gateway. The `gateway.ts` fix above is left in place (correct by inspection, same pattern as
5 pre-existing entries) but cannot be verified until either (a) this fork gets its own real
deployment, or (b) a local `API_BASE_URL` override + a way to reach the Nitric-managed gateway's
actual local address is set up — neither exists today. Operator's explicit call: keep the fix,
document the gap, move on rather than chase the deeper APP_DOMAIN/API_BASE_URL question this
session.

### ⚠️ NEW FINDING — two hardcoded Groq model names return HTTP 404 against the live API (confirmed with the key added this session)

Verified directly against `https://api.groq.com/openai/v1/chat/completions` with `GROQ_API_KEY`
(already set in `.env` from a prior session, unrelated to the resend work above):

```
llama-3.1-8b-instant        -> HTTP 404 "does not exist or you do not have access to it"
llama-3.3-70b-versatile     -> HTTP 404 "does not exist or you do not have access to it"
openai/gpt-oss-20b          -> HTTP 200 (works)
```

`GET /v1/models` on this key lists only: `openai/gpt-oss-120b`, `openai/gpt-oss-20b`,
`openai/gpt-oss-safeguard-20b`, `qwen/qwen3.6-27b`, `allam-2-7b`, `groq/compound`,
`groq/compound-mini`, plus audio/guard/orpheus models — **no `llama-*` chat model exists on this
account at all.** This surfaced because `bundle-regional`'s run this session logged
`[narrative] groq: HTTP 404` for all 8 regions (falling through to "shipping empty narrative" since
`OPENROUTER_API_KEY` is also unset locally).

**Blast radius — both literals are hardcoded (not read from an env var) in 9 files**, split across
live-request-path server code and seed/relay scripts:
- `server/_shared/llm.ts:96` — **live API path**: `groq` is 3rd in the `['ollama', 'openrouter',
  'groq', 'generic']` chain (`PROVIDER_CHAIN`), used by chat/summarize/deduction endpoints as the
  free-tier outage fallback
- `scripts/regional-snapshot/narrative.mjs:76` (`llama-3.3-70b-versatile`) — regional narrative,
  reproduced live this session
- `scripts/regional-snapshot/weekly-brief.mjs:47` (`llama-3.3-70b-versatile`)
- `scripts/seed-insights.mjs:94` (`GROQ_MODEL = 'llama-3.3-70b-versatile'`)
- `scripts/seed-forecast-resolutions.mjs:509` (`FORECAST_RESOLUTION_JUDGE_MODEL_GROQ` default)
- `scripts/seed-forecasts.mjs:14645` (`llama-3.3-70b-versatile`) **and** `:14753`
  (`llama-3.1-8b-instant`, a second distinct hardcoded literal in the same file)
- `scripts/ais-relay.cjs:3738` (`llama-3.3-70b-versatile`)

**Why this hasn't been an alarming outage**: Groq sits as a fallback/safety-net tier everywhere it
appears (never the primary provider), and every call site degrades gracefully — fall through to the
next provider, or ship an empty narrative/summary — rather than throwing. That's exactly why it went
unnoticed: it silently removes a safety-net tier project-wide rather than breaking anything outright.
Whether this is a Groq-account-specific restriction or a platform-wide deprecation of the `llama-*`
chat models wasn't determined here (not verified against a second Groq account) — but the
`/v1/models` response containing zero `llama-*` entries at all is at minimum strong evidence.

**Deliberately not fixed this session** — same posture as category 8's P1: this is a genuine,
independently-corroborated finding (live 404, live models list, live production log line), but
`server/_shared/llm.ts` is live-request-path code touching chat/summarize/deduction endpoints, and a
proper fix means picking a real replacement model (likely `openai/gpt-oss-20b`, confirmed working
above, or reading the model from an env var like the Ollama provider already does) across all 9
sites consistently — an operator call on scope and replacement model, not a single-line patch.

### ▶ Category 10 EXECUTION LOG — 2026-08-18 (session 24)

**✅ Category 10, Infrastructure & Misc (7 scripts) — DONE.** All 7 exercised (`bundle-regional`
already covered in category 9). Read-only production probe done first per the established method:
of 12 `seed-meta:*`/canonical keys checked, **6 were absent** (`infra:service-statuses`,
`infra:outages`, `webcam:cameras:geo`, `infrastructure:submarine-cables`, `military:bases` — plus
their canonical keys), a much higher hit rate than any prior category. Traced every one to a root
cause rather than assuming brokenness:

| Script | Result |
|---|---|
| `infra` | 0/3 warm-pings OK — `WORLDMONITOR_RELAY_KEY` 401 (deferred item D). Also: this script is **likely dead code** — 2 of its 3 RPC targets (`list-service-statuses`, `get-cable-health`) are already warm-pinged continuously by `ais-relay.cjs`'s own loop (`CABLE_HEALTH_RPC_URL`/`SERVICE_STATUSES_RPC_URL`, both 30min); `seed-infra.mjs` itself is registered in zero Railway services and zero bundles |
| `internet-outages` | Clean skip — `CLOUDFLARE_API_TOKEN` unset locally (new credential gap; the script itself checks first and exits 0 before any write). **Confirmed genuinely orphaned**: `seed-internet-outages.mjs` appears in zero Railway services and zero bundle section tables (`grep` across all `seed-bundle-*.mjs`), same shape as category 9's `regulatory-actions` — except `infra:outages:v1` carries a strict **30-minute** `maxStaleMin` alarm in `api/health.js:351`, tighter than any other orphan found so far |
| `service-statuses` | Failed gracefully — `WORLDMONITOR_RELAY_KEY` 401, TTL-extend was a no-op (production key genuinely absent). **Not a bug**: `api/health.js:380` and `:641` explicitly document this key as `ON_DEMAND — RPC-populated, no dedicated seed, goes stale when no users visit` and exclude it from strict staleness alarms. `seed-service-statuses.mjs`'s own header says "Standalone fallback — primary seeder is the AIS relay loop," which runs continuously in production; local absence is expected without live traffic or the relay key |
| `webcams` | Clean skip — `WINDY_API_KEY` unset locally (new credential gap). **Confirmed genuinely orphaned**: `seed-webcams.mjs` is referenced nowhere in the codebase except itself, `.env.example`, and the `api/health.js` monitor (`maxStaleMin: 1440`) — zero Railway services, zero bundles. Distinguish from [[vscode_live_news_debugging_session]]'s correction: the `api/webcam` *serving* endpoint is confirmed still live for `PinnedWebcamsPanel`; this is about the *seeder* that's supposed to keep its cache warm, which has no scheduling path at all |
| `bundle-relay-backup` | ✅ clean — ran 3/5 sections (Climate-News 86 records, USA-Spending 15, Global-Tenders 242), correctly cooldown-skipped 2 already-fresh from earlier categories (UCDP-Events, WB-Indicators). 0 failures |
| `bundle-static-ref` | **Mixed — one real finding.** Defense-Patents/Chokepoint-Baselines correctly skipped (not due yet, per their WEEK/400-day intervals). **Submarine-Cables**: failed gracefully after 4 retries / 130s against TeleGeography — plausibly the standard local network throttle (not confirmed either way; production's own key was also already absent before this run, so this deserves a re-check from a non-throttled connection rather than being written off). **Military-Bases: genuine FAILURE, exit 1** — see below |

### ⚠️ NEW FINDING — `military:bases` R2 data bucket is empty; created one day before this session, never populated

`seed-military-bases.mjs` failed hard (exit 1, not graceful) trying every fallback in order: no
Railway volume file, no local `scripts/data/military-bases-final.json` (gitignored, never
generated in this checkout), then an R2 download that returned **HTTP 404**. Verified this is not a
credential or URL-shape bug — `CLOUDFLARE_R2_TOKEN`/`CLOUDFLARE_R2_ACCOUNT_ID` are both set, and
curling the exact URL the script constructs returns a well-formed Cloudflare error, not an
auth/routing failure:
```
{"success":false,"errors":[{"code":10007,"message":"The specified key does not exist."}]}
```
Listing the bucket directly confirms why: **`worldmonitor-data` is a real, existing R2 bucket
(`creation_date: 2026-08-17T12:41:04Z` — literally the day before this session) that is completely
empty** (`GET .../objects` → `result: []`). This isn't a broken seeder — it's a provisioning gap:
someone stood up the R2 bucket and wired the seeder's fallback path to it, but the actual data
asset was never generated and uploaded. The generator exists and is unrun: `scripts/build-
military-bases-final.mjs` (header: "Output: scripts/data/military-bases-final.json"). **Fix path,
not executed this session** (generating + uploading a production data asset is a bigger step than
"test a seeder," and the R2 bucket's very recent creation date suggests this may be mid-flight work
from a session not reflected in this file — worth asking the operator before assuming it's simply
unfinished): run `node scripts/build-military-bases-final.mjs`, then upload the resulting JSON to
`worldmonitor-data/seed-data/military-bases-final.json` via the R2 API or `rclone`/`aws s3 cp`
against the R2 S3-compatible endpoint.

### ▶ Category 11 EXECUTION LOG — 2026-08-18 (session 24) — LAST CATEGORY, INITIATIVE NOW COMPLETE

**✅ Category 11, Cross-Cutting / Derived Signals (3 scripts) — DONE.** Read-only probe first:
`seed-meta:correlation:cards` and `seed-meta:intelligence:cross-source-signals` both **absent**,
`seed-meta:intelligence:regional-snapshots` fresh (131min ago, correctly within its 360min
interval). Ran `bundle-derived-signals` (exercises all 3 scripts in one process):

| Section | Result |
|---|---|
| Correlation | Failed gracefully after 3 retries / 51.7s — Redis pipeline read timed out |
| Cross-Source-Signals | Failed gracefully after 3 retries / 73.3s — Redis pipeline read timed out |
| Regional-Snapshots | Correctly skipped (131min ago vs 360min interval, already covered in category 9) |

### ⚠️ NEW FINDING — `correlation` and `cross-source-signals` both empty in production, on a deployed+tightly-monitored bundle; same P1-shaped pattern as category 8

**What's NOT in question**: the local timeout is a genuine reproduction of the documented network
throttle. Both failures are Redis-pipeline reads (`AbortSignal.timeout` 10s/15s respectively)
against Upstash's REST endpoint — the exact same failure shape category 8 already root-caused for
`seed-resilience-static.mjs` (an unchunked ~199-command pipeline choking under the 6-10 KB/s local
throttle). Neither script calls a 3rd-party upstream at this step; they're reading their own prior
Redis state. Both are architecturally resilient to *missing individual source keys* — each only
needs "any data available" among ~20+ possible source keys (`cross-source-signals`'s `SOURCE_KEYS`
list includes several keys already confirmed healthy from earlier categories) — so a normal-latency
run should not fail this way.

**What IS the open question, and why it's flagged at P1-adjacent severity rather than dismissed as
the same local-throttle non-issue**: unlike category 8's finding (where only a *rare recovery-path*
timeout was reproduced locally, and the production key itself was healthy), here **both canonical
outputs were already completely absent in production BEFORE this session touched anything** —
confirmed via `EXISTS`/`TTL` both before and after the run (still `0`/`-2`). Both keys sit on:
- an **actively deployed** vehicle (`seed-bundle-derived-signals` has its own Railway
  `nixpacks-root-scripts` service, confirmed in `scripts/railway-services.json` — not an orphan
  like several category 9/10 findings)
- a **tight cron cadence** (5min for Correlation, 15min for Cross-Source-Signals, per the bundle's
  own section table)
- a **tight staleness alarm** (`api/health.js:463` `maxStaleMin: 30` for correlationCards — the
  comment there even documents the threshold was already tuned down once after bundle-jitter false
  positives, i.e., this alarm is actively maintained, not a stale config; cross-source-signals
  carries the same 30min threshold per `api/health.js:477`, checked in category 9)

If both sections have genuinely been failing on every production cycle, that's a currently-active
monitored alarm, structurally identical to category 8's P1 — same escalation path applies: **check
the `seed-bundle-derived-signals` Railway service's recent run logs** to see whether it's timing out
there too (would indicate a real production issue, e.g., Upstash-side latency or an oversized
unchunked pipeline read) or succeeding cleanly (which would mean the absence predates this session
for some other reason, e.g., a recent key-prefix bump with no backfill — the same "cold start after
cache key bump" shape category 8's P1 hypothesized for resilience). **Not diagnosable further from
here** — this session had no way to distinguish those two explanations without production log
access, same limitation as the category 8 P1.

**Initiative status**: this closes category 11, the last of 11. Every one of the 156
`scripts/seed-*.mjs` files has now been run at least once across sessions 20-24. See the "START
HERE" section at the top of this file for the consolidated list of what's still open across all
categories — that list, not this per-category log, is the authoritative next-steps summary.

---

## 🔖 HANDOFF (2026-08-18, twenty-third session — category 8 of 11 DONE) — SUPERSEDED by the session-24 block above; kept for its category-8 findings and P1

### ▶ START HERE — next session, in order

1. **Re-verify repo state; do not trust these numbers.**
   `git fetch && git rev-list --left-right --count origin/main...main` and `git status --short`.
   End of session 23: the seven bug fixes from sessions 20-22 were COMMITTED this session
   (`be399f3`..`c40d855`, plus bookkeeping `852ce98`) on operator go-ahead, and the operator then
   **PUSHED them** — `origin/main` is at `852ce98`, verified via `git branch -vv`. Only this
   handoff commit (`657df0e`) sits ahead, so `main` is **1 ahead / 0 behind** with a clean tree.
   Caveat that bit this session: `git fetch` failed here with an HTTP2 framing error while the
   remote-tracking ref was already current — so re-verify with `git branch -vv` / `git log
   origin/main` even when `fetch` errors, and do not trust a stale "N ahead" from an earlier turn.

2. **Resume seed testing at category 9** (News, Intel & Briefs, 7 scripts). Categories 1-8 done =
   **139 of 156 scripts**. Do not restart from category 1.
   **The category 9 pre-analysis is ALREADY DONE** — see "▶ Category 9 pre-analysis" below. It has
   the read-only production probe, the credential pre-flight, the bundle map, and a suggested run
   order. Two problem areas are already pinpointed (`regulatory-actions` produces nothing;
   `news:digest*` is empty and is category 3's blocker). Start there; do not re-derive it.

3. **Carry forward, unchanged from session 22**: the 6-10 KB/s local network throttle (check
   `seed-meta:<domain>:<resource>` for a recent production success before calling a local timeout a
   bug); local runs write to PRODUCTION Redis; exit 0 ≠ healthy; the 40 pre-existing test failures.

4. **The single most valuable thing this session did was a read-only production probe BEFORE
   running anything.** Reading `seed-meta:*` + canonical-key TTLs for the whole category up front
   predicted exactly which bundle sections would gate-skip, found two absent keys, and surfaced the
   P1 below without spending a single upstream call. Do this first in every remaining category.

### ⚠️ P1 FOUND — resilience scores/ranking produce NOTHING in production (monitored outage)

`resilience:score:v25:*` → **0 keys**. `resilience:ranking:v25` → **absent**. `resilience:score:v24:*`
and `:v23:*` → 0 keys (so this is not a namespace-bump artifact leaving data under an old prefix).
Both `seed-meta:resilience:scores` and `seed-meta:resilience:ranking` are **absent**, not merely
stale — and the meta TTL is 12h, so there has been no successful run in at least that long.

**This is monitored and should already be alarming**: `api/health.js:269` tracks
`resilience:ranking:v25` and `api/health.js:545` tracks `seed-meta:resilience:ranking` with
`maxStaleMin: 840` (14h). The feature is fully live — `server/worldmonitor/resilience/v1/*`,
the map choropleth, and `CountryDeepDivePanel` all consume it. `seed-bundle-resilience` IS deployed
(`scripts/railway-services.json`, nixpacks-root-scripts).

**Independently corroborated three times** by the validation bundle, which is entirely downstream:
- External-Benchmark: "No ranking data in Redis … cold start after cache key bump" → graceful skip
- Outcome-Backtest: "only **0/196** scores in Redis — scores seeder likely hasn't run yet" → skip
- Sensitivity-Suite: "Only 0 countries scored (need >= 20)" → **FATAL exit 1**

**Not diagnosable from here**: `seed-resilience-scores.mjs` fails closed at
`WORLDMONITOR_SEED_REFRESH_KEY is required` (unset locally, correct fail-closed behaviour, logs a
structured `reason:missing_seed_refresh_key` — NOT a code bug). It drives the LIVE API
(`${API_BASE}/api/resilience/v1/get-resilience-ranking?refresh=1`) and the SERVER writes the cache,
so the seeder cannot be exercised without both that secret and a valid production API key.
`API_BASE_URL`/`WORLDMONITOR_API_KEY` are also unset; the local `WORLDMONITOR_VALID_KEYS` value is a
placeholder that returns **HTTP 401 Invalid API key** against `https://api.worldmonitor.app`.

**Unblock**: check the `seed-bundle-resilience` Railway service's recent run logs. The
"cold start after cache key bump" hint suggests the v25 prefix bump may never have been repopulated.

### 📌 Robustness finding (NOT a confirmed bug — do not "fix" on local evidence alone)

`seed-resilience-static.mjs:937` `redisPipeline` sends **~199 commands unchunked** with a fixed
**15s** `AbortSignal.timeout`, for both the recovery READ (198 GETs) and the publish WRITE. Its
sibling `seed-resilience-scores.mjs:273` chunks the identical operation at `PIPE_BATCH = 50`.
Consequence when it does trip: `recoverFailedDatasets` is the **safety net** that carries prior
per-country values forward when a dataset fails — so the one path designed to degrade gracefully is
the one that throws, converting a partial failure into `FATAL` + exit 1.
Production hit this exact signature 21.9 days ago; a local run reproduced it verbatim
(`Dataset(s) (wgi, iea) failed and Redis pipeline read also failed: aborted due to timeout`).
**But the local repro is fully explained by the 6-10 KB/s throttle**, and on Railway ~200 GETs
would normally complete well inside 15s — so one production occurrence is not proof the timeout is
categorically too tight. Chunking it to match the sibling is cheap and low-risk, but it is a
judgment call, deliberately left for the operator.

### ▶ Category 8 EXECUTION LOG — 2026-08-18 (session 23)

**✅ Category 8, Resilience & Recovery Scores (12 scripts) — DONE.** All 12 exercised.

| Script | Result |
|---|---|
| `bundle-resilience` | ran — Scores FAILED (missing local secret, fails closed), Static gate-skipped |
| `bundle-resilience-energy-v2` | ran — 3/3 gate-skip (1420-1425min ago vs 10080min interval) |
| `bundle-resilience-recovery` | ran 1337s — **ran:2 skipped:5 failed:0** |
| `bundle-resilience-validation` | ran — 2 graceful skips + 1 FATAL, all downstream of the P1 |
| `resilience-scores` | **BLOCKED** — see P1 |
| `resilience-static` | reproduced production's exact failure; **no data loss** (TTL extended on 198 keys, 196 countries preserved, meta honestly re-recorded `status:error`) |
| `recovery-fiscal-space` | ✅ 191 records |
| `recovery-reserve-adequacy` | ✅ 163 records |
| `recovery-external-debt` | ✅ 100 records (drops 4 countries with debt=0 — HIC out-of-IDS-scope, would have falsely scored 100) |
| `recovery-fuel-stocks` | ✅ 26 records (from IEA index, dataMonth 2026-05) |
| `recovery-import-hhi` | ✅ **167 records — FILLED AN ABSENT PRODUCTION KEY** |
| `recovery-reexport-share` | ✅ 1 record — **FILLED AN ABSENT PRODUCTION KEY** |

All four pass-2 recovery seeders returned **record counts identical to production** (191/163/100/26),
which is good evidence they are healthy and deterministic rather than merely "exited 0".

**Two production gaps filled by this session's runs.** `resilience:recovery:import-hhi:v1` and
`resilience:recovery:reexport-share:v1` were both **completely absent** (meta + canonical +
checkpoint) before the run and are now live (167 records / 90d TTL, and 1 record / 35d TTL).
Since both keys were absent, there was no live data to downgrade — the run was safe by inspection,
not by luck. Why they were absent in production is **still unexplained** and worth a look.

`reexport-share` publishing only 1 of its 2-country cohort is CORRECT, not a miss: AE published at
35.5% (Y=2023, RX $167.0B / M $470.5B); PA was omitted at 2.46%, below the documented 5% floor.

**Import-HHI cost + quota note.** 239 reporters, 2 keys, 2 workers, 1.5s per-key pacing → ~120
calls/key, 1284s locally (7 errors, 4 of them visible local-throttle timeouts SK/ES/TR/GB; 1
reporter `MF` hit a Comtrade quota/auth status). Publish floor is 135, so 167 published safely.
**Three seeders share `COMTRADE_API_KEYS`** against the Free tier's **500 calls/month PER KEY**:
`comtrade-bilateral-hs4` (~197/key/month), `recovery-import-hhi` (~120/key), `recovery-reexport-share`
(~2/key) ≈ **319 of 500**, ~36% headroom. This session's local run consumed ~120/key on top of that
for August 2026 — still within budget, but a second full local import-hhi run this month would not be.

**Invocation note for `bundle-resilience-validation`**: plain `node` is NOT enough — its three
scripts are analysis tools (not seeders) that dynamically import `../server/*.ts`. Use the
Dockerfile's own wiring, which works verbatim locally (tsx 4.21.0 is already in `node_modules`):
`NODE_OPTIONS="--max-old-space-size=8192 --dns-result-order=ipv4first --import=file://$PWD/node_modules/tsx/dist/loader.mjs" node --env-file=.env scripts/seed-bundle-resilience-validation.mjs`

**Scope notes**: `bundle-resilience-energy-v2`'s three sections (`low-carbon-generation`,
`fossil-electricity-share`, `power-reliability`) are **category-1** scripts already exercised there,
and production seeded all three successfully ~1 day ago — pass 2 for that bundle is already covered.
`bundle-resilience-recovery` also carries `seed-sovereign-wealth` (category 6). Note too that
`resilience:static` and the score namespace are **sharded per-country** (`resilience:static:XX`,
`resilience:history:v20:XX`, 196 each) — a `:v1` miss on those is the expected shape, NOT a bug.

### New credential gaps from category 8

- **`WORLDMONITOR_SEED_REFRESH_KEY`** — blocks `seed-resilience-scores` entirely. Intentionally
  stronger than the normal API-key allowlist: only this seed-only secret can force the expensive
  ranking recompute. Needed to diagnose the P1 locally.
- **`API_BASE_URL` / `WORLDMONITOR_API_KEY`** — unset; the `WORLDMONITOR_VALID_KEYS` fallback in
  `.env` is a placeholder that 401s against production.
- **`RESILIENCE_WHO_MEASLES_INDICATOR`** — unset (`seed-resilience-static.mjs:59`); did not block
  the run, listed for completeness.

---

### ▶ Category 9 pre-analysis — done 2026-08-18 (session 23) so the next session does not re-derive it

**Category 9 = News, Intel & Briefs (7 scripts)**: `digest-notifications`, `insights`,
`regional-briefs`, `regional-snapshots`, `regulatory-actions`, `research`, `displacement-summary`.
All 7 files exist. Sizes: digest-notifications **3010 lines** (by far the largest), insights 763,
regulatory-actions 368, research 391, regional-snapshots 342, displacement-summary 248,
regional-briefs 213.

**Read-only production probe (already done — do NOT redo before starting):**

| seed-meta | age | records | canonical key state |
|---|---|---|---|
| `news:insights` | 0.0d | 8 | `news:insights:v1` + `:CN` present (0.1d TTL) — healthy |
| `intelligence:regional-snapshots` | 0.1d | 8 | `intelligence:regional-snapshots:summary:v1` present — healthy |
| `intelligence:regional-briefs` | 4.9d | 7 | 7 × `intelligence:regional-briefs:v1:weekly:*` — healthy |
| `research:tech-events` | 0.2d | 125 | `research:tech-events:v1` (0.8d) + bootstrap — healthy |
| `displacement:summary` | 0.5d | 212 | `displacement:summary:v1:2026` present — healthy |
| `regulatory:actions` | **ABSENT** | — | `regulatory:*` → **0 keys** ⚠️ |
| `news:digest` | **ABSENT** | — | `news:digest*` → **0 keys** ⚠️ |

⚠️ **Two pre-identified problem areas — start here, they are where the value is.**
1. **`regulatory-actions` produces nothing in production**: meta absent AND zero keys in the whole
   `regulatory:*` namespace. Needs no credentials (see below), so it should be directly runnable
   and diagnosable locally — the best first target in this category.
2. **`news:digest*` is empty**, which is the *same* `news:digest:v1:full:en` that
   **category 3's `recall-benchmark` is blocked on**. Session 22 corrected the record: `seed-forecasts`
   READS this key, it does not write it. `seed-insights.mjs` is the writer. Since `news:insights:v1`
   is healthy and fresh (0.0d) while `news:digest*` is empty, the digest write path specifically is
   worth tracing — fixing it may retroactively unblock category 3.

**Do NOT repeat this session's near-miss**: a first pass called `displacement:summary:v1` and
`intelligence:regional-snapshots:v1` "absent" — they are simply **suffixed differently**
(`…:v1:2026`, `…:summary:v1`). Always `SCAN` the namespace before calling a canonical key missing.
Only `regulatory:*` and `news:digest*` are genuinely empty.

**Credential pre-flight (checked 2026-08-18):**
- **5 of 7 need no env beyond Redis** — `regional-briefs`, `regional-snapshots`, `regulatory-actions`,
  `research`, `displacement-summary` reference no `process.env.*` of their own. These should run
  clean with the standard `node --env-file=.env scripts/seed-<name>.mjs`.
- **`digest-notifications` — still hard-blocked (deferred item B).** Re-verified this session:
  `resend` is **not in `node_modules` and not in `package.json`**, so the script cannot start. It
  also wants the largest env surface in the category, ALL currently unset: `RESEND_API_KEY`,
  `RESEND_FROM_EMAIL`, `RESEND_FROM_BRIEF`, `TELEGRAM_BOT_TOKEN`, `DIGEST_CRON_ENABLED`,
  `AI_DIGEST_ENABLED`, `BRIEF_COMPOSE_ENABLED`, `BRIEF_LLM_ENABLED`, `BRIEF_URL_SIGNING_SECRET`,
  `WORLDMONITOR_PUBLIC_BASE_URL`. (`RELAY_SHARED_SECRET` IS set.) Expect to defer this one again
  unless the operator approves `pnpm add resend` **and** provides credentials.
- **`insights`** wants `OLLAMA_API_KEY` / `OLLAMA_MODEL` (both UNSET), plus `API_BASE_URL` and
  `WORLDMONITOR_RELAY_KEY` (both UNSET — the latter is long-standing deferred item D). Check whether
  it degrades gracefully without the LLM or fails closed; its Redis output is currently healthy.
- **`GROQ_API_KEY` IS SET (56 chars)**; `OPENROUTER_API_KEY` and `ANTHROPIC_API_KEY` are unset.
  `bundle-regional` documents "GROQ and/or OPENROUTER" for the narrative + brief LLM, so the LLM
  path should work on Groq alone.

**Bundle coverage is scattered — these 7 are NOT one tidy bundle:**
- `seed-bundle-regional.mjs` = `regional-snapshots` (always) + `regional-briefs` (weekly, skipped if
  the brief meta is younger than 6.5 days — it is **4.9d** now, so expect a SKIP). Railway cron 6h.
  **Structural caveat worth knowing**: it imports both sub-seeders **in-process**, not via
  `child_process.execFile`, precisely because they were refactored to throw instead of
  `process.exit(1)`. If either re-introduces `process.exit()` inside `main()`, the bundle dies
  before the second seeder runs.
- `displacement-summary` is a section of **`bundle-health`** (category 3 — already run there), so it
  has most likely already been exercised once; its production state is healthy.
- `regional-snapshots` is also a section of **`bundle-derived-signals`** (category 11, to be run LAST).

**Suggested order**: (1) `regulatory-actions` standalone — no creds, known-empty, best signal;
(2) `research`, `displacement-summary` standalone — no creds, healthy baseline to compare against;
(3) `bundle-regional` (expect Regional-Briefs to gate-skip at 4.9d), then `regional-snapshots` /
`regional-briefs` individually in pass 2; (4) `insights` — watch the `news:digest` write path;
(5) `digest-notifications` last, expected to be deferred on the missing `resend` dependency.

---

## 🔖 HANDOFF (2026-08-18, twenty-second session — category 7 of 11 DONE) — SUPERSEDED by the session-23 block above; kept for its category-7 findings and method notes

### ▶ START HERE — next session, in order

1. **Re-verify repo state; do not trust these numbers.**
   `git fetch && git rev-list --left-right --count origin/main...main` and `git status --short`.
   As of session 23 (2026-08-18): `main` **13 ahead / 0 behind**, **working tree CLEAN**.

2. **~~Landing the working tree~~ — DONE (session 23).** The seven bug fixes from sessions 20-22
   are committed as seven separate commits (`be399f3`..`c40d855`); see "⛔ CANNOT FIX HERE" item G
   for the per-commit map. **Deliberately not pushed** — the operator pushes manually. The next
   session's first step is therefore category 8, not committing.

3. **Baseline the test suite BEFORE blaming yourself.** The full unit suite is
   `APP_DOMAIN=example.test npx tsx --test --test-concurrency=16 tests/*.test.mjs tests/*.test.mts api/security/report.test.mjs`
   → **13730 tests, 13684 pass, 40 fail, 6 skipped**. Those **40 failures are PRE-EXISTING on a
   clean tree** — verified this session by `git stash`-ing everything (0 files dirty) and re-running:
   identical 40. They live in exactly 7 suites:
   `bootstrap.test.mjs`, `ci-workflow-coverage.test.mts`, `edge-functions.test.mjs`,
   `railway-services-registry-coverage.test.mts`, `browser-bundle-secret-guard.test.mts`,
   `no-non-timing-safe-secret-compare.test.mts`, `renewable-energy-last-known-good.test.mts`.
   **Do not attribute them to your changes, and do not fix them as part of seed testing** — they
   are a separate, unexamined workstream. `tsc --noEmit` is clean.

4. **Resume seed testing at category 8.** Categories 1-7 done = **127 of 156 scripts**.
   Invocation is always `node --env-file=.env scripts/seed-<name>.mjs` — bare `node` fails every
   script identically (aborts at "Missing UPSTASH_REDIS_REST_URL", harmlessly, before any write).

5. **Read the network caveat before calling anything a bug.** This machine throttles nearly every
   upstream to **6-10 KB/s**; Finnhub and Cloudflare are the exceptions. A local timeout is NOT
   evidence of a bug — check `seed-meta:<domain>:<resource>` in Redis for a recent production
   success first. This session that check correctly exonerated `seed-forecasts` (exit 75).

6. **Know the three traps this session hit**, they generalize to every remaining category:
   - **Exit 0 ≠ healthy.** `aaii-sentiment` exited 0 with `state:OK, recordCount:52` while serving
     4.5-month-old hardcoded data. Judge on `recordCount` **and** real source lines in the log.
   - **A green test suite proves nothing about upstreams.** 29 AAII assertions passed against
     fixtures built to match the parsers' own assumptions while the integration was 100% broken.
   - **Local runs WRITE TO PRODUCTION Redis** and can downgrade a live key. Read a key's current
     value before re-running a seeder you suspect.

7. **Method that worked for a bundle category** (reuse it): run the bundle first; every section
   that gate-skips gets run individually in pass 2; run any dependency chain last, in order.
   Peer seeders can run in parallel where the lock check shows distinct `domain:resource`.

8. **Alpha Vantage budget**: free tier is **25/day AND ~5/minute**. ~22 of 25 were spent on
   2026-08-18. If you resume on the same day, expect rate-limit warnings that are **not** bugs.

### What changed this session
Two credentials added and verified (`FINNHUB_API_KEY`, `ALPHA_VANTAGE_API_KEY`), category 7 fully
executed (21/21 scripts), **6 fixes applied** (see "✅ FIXES APPLIED"), **7 items deferred** (see
"⛔ CANNOT FIX HERE"), and **one earlier handoff claim corrected** — `seed-forecasts` does *not*
write `news:digest:v1:full:en`; it reads it. Category 3's `recall-benchmark` is blocked on a
900-second request-driven API cache, not on any seeder.

---

## 🔖 HANDOFF (2026-08-17/18, twenty-first session — categories 5 AND 6 of 11 done) — SUPERSEDED by the session-22 handoff above; kept for its method notes and category 5/6 findings

### ▶ START HERE — next session, in order

1. **Re-verify repo state first; do not trust these numbers blindly.**
   `git fetch && git rev-list --left-right --count origin/main...main` and `git status --short`.
   As of the end of this session: `main` **6 commits ahead of `origin/main`**, 0 behind, and
   **11 uncommitted files** (10 modified + 1 new test) *(as of session 21 — ALL COMMITTED in
   session 23, see the top block)*. **Nothing is committed — the standing
   discipline in this repo is to hold for the operator's explicit go-ahead.** The 11 files carry
   all SIX bug fixes from sessions 20–21; ask about committing before starting new work, because
   the pile is getting large.
2. **Read the network caveat immediately below** before running any seed script. On this machine a
   timeout is *not* evidence of a bug.
3. **Resume the sweep at category 7, Markets & Finance (21 scripts).** Categories 1–6 are done
   (106 of 156 scripts). Do not restart from category 1. The per-category script lists are in the
   NEXT INITIATIVE section further down.
4. **Use the two-pass bundle method** (see the category 6 entry) — pass 1 bundles, then pass 2 for
   every gate-skipped section individually. Skipping pass 2 silently tests almost nothing.

**Method, unchanged and operator-confirmed**: run each script live once with
`node --env-file=.env scripts/seed-<name>.mjs` (bare `node` fails every script identically),
confirm it writes fresh Redis data without error, batch-run a whole category, then review the
category together. Default on a real finding: fix + verify + hold the commit; flag anything that
is an operator decision.

**Verified state at handoff**: `npx tsc --noEmit` clean; all four comtrade suites **88/88**;
`node --test tests/seed-comtrade-bilateral-freshness-gate.test.mjs` **18/18**. Nitric restarted and
healthy (PID 77333, all 7 long-running services up).

**Open decisions waiting on the operator** (none block category 7):
- Commit / push the 11 files.
- `pnpm add resend` — undeclared dep; `seed-digest-notifications` can never start without it.
- Add `IRAN_EVENTS_ENABLED=false` to `.env` — `publish-bootstrap-tiers` has published nothing for 8+ days.
- `api/health.js:474` `maxStaleMin: 34560` (24d) vs the 30d comtrade cron — will report stale ~6 days per cycle.
- Still-unset credentials: `RELIEFWEB_APPNAME`, `PROXY_URL`, `WORLDMONITOR_RELAY_KEY`.
- Run the full comtrade seeder in production (see "How to actually run the full comtrade seeder").

### ⚠️ Read before trusting ANY live-run verdict from this machine

**This machine's network throttles nearly every upstream to 6–10 KB/s, or times it out entirely.**
Measured 2026-08-17 across six hosts on the same link within one minute:

| host | result | throughput |
|---|---|---|
| Cloudflare speedtest | 500,000 B in 4.2s | **117.4 KB/s** ✅ |
| UN Comtrade | 269,552 B in 43.2s | 6.1 KB/s |
| npm registry | 55,804 B in 6.2s | 8.7 KB/s |
| Upstash (558 KB key) | 558,947 B in 56–78s | 9.4 KB/s |
| GitHub codeload | **timeout** at 45s | — |
| `storage.googleapis.com` | **timeout** at 45s | — |

A full-tunnel VPN is active (`utun8`, gateway `172.27.232.1`; physical gateway `192.168.123.1`).
Both fast and slow hosts route through it, so the tunnel is not uniformly bad — Cloudflare is the
lone fast destination. Per-destination route bypasses were investigated and **rejected**: they'd
have to be repeated for every upstream in the initiative. Operator's decision (this session):
**keep the VPN and keep testing**, classifying payload/latency failures as environment artifacts.

**Consequence for the method**: a seed script failing on a timeout here is NOT evidence of a bug.
Confirm against `seed-meta:<domain>:<resource>` in Redis first — if production seeded it recently,
the local failure is an artifact. That single check is what correctly saved `chokepoint-flows`
from a wrong "fix" this session. Also note one control host is not enough to localise a network
fault — Cloudflare's speed made a link-wide throttle look destination-specific.

**Re-test list (operator: flag, don't re-run now).** These were logged in categories 1–4 as
upstream/external blockers, but all match the throttle profile above and their verdicts should NOT
be trusted as upstream problems: `ember-electricity` (category 1 — its blocker host,
`storage.googleapis.com`, times out here), `jodi-oil` (category 1, 6 retries aborting at 30s),
`sanctions-pressure` (197s), `submarine-cables` (131s), `thermal-escalation` (81s), `fatf-listing`
(all category 4). Re-verify each on a healthy link before concluding anything about the upstream.

### Category 5 — Supply Chain, Trade & Ports/Chokepoints (13 scripts) — DONE

13 scripts covered by **9 runs**, because bundles spawn their component scripts as subprocesses.
Three ordering facts worth reusing for later categories:
- **The lock is `seed-lock:<domain>:<resource>`**, not `seed-lock:<domain>` (`_seed-utils.mjs:1608`)
  — finer-grained than earlier handoffs imply. All 9 `runSeed` users here had distinct pairs, so
  the only real collision risk is a bundle against the components it spawns. Bundles therefore ran
  sequentially, never in parallel with their own sections.
- **Run bundles BEFORE their components.** `_bundle-runner.mjs:275` skips any section seeded within
  `intervalMs * 0.8`; individual `runSeed` scripts have no such gate. Components-first makes the
  bundle a no-op "pass" that tests nothing.
- **A bundle section can skip because *production* seeded it**, not because of your run
  (`PW-Disruptions` skipped as "last seeded 10min ago"). Skipped sections need individual runs.

Results — 7 pass, 2 environment artifacts, 1 real bug, 1 degraded, plus 1 budget artifact:

- ✅ `bundle-portwatch` (76s) — PW-Main 13 records / 491 KB. Other 2 sections gate-skipped, both
  re-run individually in pass 2 and clean: `portwatch-disruptions` (5 records),
  `portwatch-chokepoints-ref` (28 records).
- ✅ `bundle-portwatch-port-activity` (124s) — 30 countries, 0 errors. Ran in **designed cap-mode**:
  cold cache → 144 countries dropped for no prior payload, `PARTIAL PERSIST: 30/50 below
  canonical-publish floor`, so `supply_chain:portwatch-ports:v1:_countries` was NOT rewritten.
  Correct behaviour (~6 runs to fully rotate), but **a single local run can never exercise this
  seeder's canonical write** — don't read that as a failure.
- ✅ `chokepoint-baselines` (5s) — 7 records, read-back verified.
- ✅ `global-tenders` (131s) — 256 records. Its 312 KB payload tripped the same "verification read
  returned null" warning; write confirmed OK first.
- ✅ `supply-chain-trade` (17s) — 9 records, but **DEGRADED: `WTO_API_KEY` not set** (×22), giving
  `Trade flows: 0 pairs` and `Tariff trends: 0 countries`. New credential gap.
- ⚠️ `chokepoint-flows` (rc=75) — **NOT a bug, environment artifact.** `fetchAll` does 3 Redis GETs
  with a flat `AbortSignal.timeout(10_000)`; one is the 558 KB `supply_chain:portwatch:v1`, which
  measured 56–78s here. Production seeded this 12.1h ago with all 7 chokepoints through the same
  10s timeout. **Do not bump this timeout** — unlike the UCDP/defense-patents fixes (upstream-side
  latency that also hits production), this latency is purely local.
- ⚠️ `trade-flows` (rc=143 twice) — **testing-budget artifact, not a script failure.** Its own
  `TRADE_FLOW_FETCH_PHASE_TIMEOUT_MS` is 25 min (1500s) and my pass-2 watchdog was also 1500s, so I
  killed it exactly at its own deadline. Matrix is only 84 requests with a 252s pacing floor
  (~5–7 min on a healthy link); it overran solely because each request crawls (27 requests hit the
  15s per-request timeout, concentrated on the largest responses — Semiconductors is 269 KB, which
  needs ~18–20s at the measured 6.1 KB/s). Lock released cleanly both times, no orphan. Re-run with
  a >1800s budget on a healthy link. `seed-meta:trade:comtrade-flows` is ABSENT in Redis.
- ❌ `hs2-chokepoint-exposure` (rc=1) — two stacked causes: starved by the comtrade bug below
  (`Comtrade data loaded for 0/197 countries`), then timed out in `redisPipeline` writing 1971 keys
  (`seed-hs2-chokepoint-exposure.mjs:187`), plausibly the same throttle. Re-test after both the
  comtrade credential and a healthy link are in place.
- ❌ `comtrade-bilateral-hs4` — **real bug, fixed this session. See below.**

### Bug #4 of the initiative — `comtrade-bilateral-hs4` silently dark for 21 days (FIXED, COMMITTED session 23 as `be399f3`)

**Symptom**: `seed-meta:comtrade:bilateral-hs4` read `{fetchedAt: 21.2d ago, recordCount: 0,
status: 'ok'}` — reporting healthy while having published nothing, and invisible to freshness
monitoring precisely because it claimed OK.

**Root cause, in two independent layers:**
1. **Credential gap** — `COMTRADE_API_KEYS` is unset, so `usePublicApi` selects
   `comtradeapi.un.org/public/v1/preview/...`. Reproduced directly: that endpoint returns
   **HTTP 200 `{"count":0,"data":[],"error":""}`** for every keyless variant tried, and HTTP 500
   whenever a `period` is supplied. The authenticated endpoint returns 401 without a key. **This
   seeder structurally cannot produce data without `COMTRADE_API_KEYS`.**
2. **Code bug (the fixed part)** — zero rows for every reporter throws no exception, so the catch
   block's correct `writeMeta(0, 'error')` was unreachable, and the success path ran
   `writeMeta(writtenCount)` with the default `status='ok'`, stamping `fetchedAt=now`. Because
   `checkSeedMetaFreshness` compared **only `fetchedAt`**, a totally-failed run armed the 24-day
   gate and suppressed its own retries. The failure disabled its own recovery.

**Fix** (2 files): the gate now also rejects `status !== 'ok'` and `recordCount <= 0`
(`seed-comtrade-bilateral-hs4.mjs:120`), which additionally **self-heals the already-stuck
production record** instead of waiting out its remaining ~2.8 days; and the writer records
`'error'` on a zero-write run (`:368`). Failing open here is safe against the UN Comtrade 500
calls/month quota because the script's own comment states the monthly cron is the primary guard
and this gate is only secondary.

**Verified**: gate suite 15/15 (was 10 — added 5), `comtrade-bilateral-hs4` + `seed-comtrade-5xx-retry`
66/66, `tsc --noEmit` clean, and a `git stash` A/B confirming the 3 bug-pinning tests fail against
the unfixed script while the 2 over-correction guards pass either way.

**Why `FORCE_RESEED=true` was deliberately NOT run**: it would spend ~23 min and ~396 requests to
reproduce all-zeros already proven in 3 API calls, and would rewrite `fetchedAt=now` — extending
the blackout by a fresh 24 days. Don't run it until `COMTRADE_API_KEYS` exists.

**Same test-fixture blind spot as bug #1 (`iea-oil-stocks`)**: all 9 pre-existing gate tests passed
`recordCount: 180, status: 'ok'`, so a thorough-looking green suite never exercised the shape
production actually produced. Worth checking fixtures against real output in later categories.

### Credential gaps found in category 5 — BOTH RESOLVED 2026-08-18

- **`COMTRADE_API_KEYS`** — ✅ operator supplied both keys (comma-separated, so the seeder's
  rotation doubles the effective 500/month-per-key quota). Was blocking `comtrade-bilateral-hs4`
  completely and transitively `hs2-chokepoint-exposure`. **Note: the key alone was not enough —
  see bugs #5 and #6 below.**
- **`WTO_API_KEY`** — ✅ operator supplied (primary; secondary kept as a comment in `.env`).
  `supply-chain-trade` re-run now yields 159 tariff-trend countries and 256 trade-flow pairs.

### Category 6 — Economic Indicators & Central Banks (35 scripts) — DONE

35 scripts covered by **29 runs** (14 in pass 1, 15 in pass 2). 3 bundles cover 21 of the 35;
`bundle-macro` and `bundle-imf-extended` both spawn `seed-imf-macro.mjs`, so bundles never ran
concurrently. **Pass 2 was essential and will be for later categories too**: pass 1's bundles
freshness-skipped 16 of their 23 sections (production seeds these on schedule), so the bundles
alone tested almost nothing. Individual `runSeed` scripts have no gate, so pass 2 ran them for real.

**Result: 31 of 35 clean with verified data; 1 guarded by design; 2 blocked by a missing
credential; 1 environment artifact.**

- ✅ Clean, read-back verified (records in parens): `bis-data` (11), `bis-extended` (32),
  `ecb-fx-rates` (7), `ecb-short-rates` (168), `yield-curve-eu` (6), `fsi-eu` (252), `fx-rates` (47),
  `fx-yoy` (45), `economic-calendar` (7), `usa-spending` (15), `wb-indicators` (6 keys, older
  logging convention with no `seed_complete` envelope — its absence is NOT a failure signal),
  `china-coverage-health` (12), `economy` (2 + stress-index composite 8.6, 6/6 components),
  `china-macro` (4), `bls-series` (2), `eurostat-country-data` (10), `eurostat-house-prices` (28),
  `eurostat-gov-debt-q` (28), `eurostat-industrial-production` (26), `fao-food-price-index` (12),
  `national-debt` (186), `wb-external-debt` (119), `bis-lbs` (200), `imf-macro` (191),
  `imf-growth` (191), `imf-labor` (191), `imf-external` (190). All 3 bundles exited 0.
- ⚠️ `sovereign-wealth` — exits clean with 6 records, but match quality is **6 OK / 2 partial /
  4 MISS**; the misses include Norway and Saudi Arabia, whose NBIM and PIF are among the largest
  sovereign funds in the world. A data-quality gap that reports success, so no freshness check will
  ever flag it. Not investigated — flagged for the operator.
- 🛡️ `consumer-prices` — **deliberately guarded, NOT run.** It refuses without `--force`: "This
  script overwrites Redis keys with short TTLs (10-60 min), stomping the authoritative publish.ts
  26h TTLs. Only run manually when publish.ts is broken." Forcing it would degrade live data to
  score a green tick. Treat like category 4's `iran-events` (deliberately disabled ≠ broken).
- ⚠️ `china-release-calendar` — rc=75 both passes, `NBS_REQUIRED_SOURCE_UNAVAILABLE:FETCH_FAILED`
  against `www.stats.gov.cn`. **Environment artifact**: production seeded it 38.6h ago with 154
  records, so the code path works. Same seed-meta test that exonerated `chokepoint-flows`.
- ❌ `bigmac` (rc=1) and `grocery-basket` (no write) — **both blocked solely by `EXA_API_KEYS`**,
  documented at `.env.example:625` but absent from `.env`. Every one of bigmac's ~45 countries
  returned "EXA error: EXA_API_KEYS or EXA_API_KEY not set".

### ⚠️ Production gap found while triaging the EXA failures — worth acting on

`economic:bigmac:v1`, `seed-meta:economic:bigmac`, and `economic:grocery-basket:v1` **all return
`exists=0` in Redis.** These two data sources are dark in production, not merely untestable
locally — nothing has ever been published, or it expired long ago. The seeders' own
graceful-degradation masked it: `grocery-basket` logs "existing cache TTL extended", but the
warning right above it (`2 key(s) were expired/missing — EXPIRE was a no-op; manual seed required`)
is the real signal — last-good preservation had no last-good to preserve. Setting `EXA_API_KEYS`
is the prerequisite for both.

**Checked and cleared, NOT a second comtrade-style bug**: `grocery-basket` logs "seed-meta
refreshed (recordCount=0)", which pattern-matches bug #4. But it has no freshness gate of its own
and is not a bundle section, so nothing consumes that meta as a retry gate — the write comes from
shared `_seed-utils.mjs:1884` and is deliberate last-good preservation
(see the design note at `_seed-utils.mjs:1458`). What made comtrade a bug was the *gate that read
`fetchedAt` and blocked retries for 24 days*, not the zero-record write itself. Worth re-applying
that distinction whenever this log line shows up again.

### New credential gaps from category 6

- **`EXA_API_KEYS`** — ✅ **RESOLVED 2026-08-18** (operator supplied; both dark sources now live).

### 2026-08-18 — operator supplied 3 credentials; 2 more real bugs found in comtrade-bilateral-hs4

Operator provided `EXA_API_KEYS`, `WTO_API_KEY` (+ secondary, kept as a comment) and
`COMTRADE_API_KEYS` (both keys, comma-separated so the seeder's rotation doubles the effective
quota). All three added to `.env` and **verified by direct API reproduction**, not by re-running
the seeders: WTO `GET /timeseries/v1/reporters` -> 200, 288 reporters; Exa `POST /search` -> 200.

**Credential re-runs — the two dark sources are now LIVE in Redis:**
- `bigmac` — rc=0, **47 records**, `economic:bigmac:v1` now `exists=1` (was 0).
- `grocery-basket` — rc=0, **24 records**, `economic:grocery-basket:v1` now `exists=1` (was 0).
- `supply-chain-trade` — ✅ rc=0 in **16.5 min** (993858ms), 9 records verified. WTO now doing real
  work: `WTO reporters: 278 economies`, `Tariff trends: 159 countries` (was 0), `Trade flows: 256
  pairs` (was 0), plus per-country `trade:tariffs:v1:<code>:all:10` extra keys and
  `trade:customs-revenue:v1`. Note the canonical recordCount stays 9 (shipping indices) either way —
  **the WTO gain is entirely in the extra keys**, so recordCount alone would not have shown it.
  Budget note: the first re-run SIGTERM'd at 701s, which was sized when WTO was a no-op; it needs
  >=1200s now.

### Bug #5 — `comtrade-bilateral-hs4` sent the classification revision where the API route family belongs

The new key alone would NOT have fixed this seeder. It interpolated
`STRATEGIC_PRODUCT_METADATA.classification.code` (`H6` = HS2022, a *classification revision*) into
the URL path, where Comtrade expects its *API route family* (`HS`). Measured live on otherwise
identical queries:

```
.../data/v1/get/C/A/H6  ->  HTTP 500 {"count":-1,"error":{...}}   every request
.../data/v1/get/C/A/HS  ->  HTTP 200 count=25158
```

Two independent faults produced the same "zero records" symptom, which is why bug #4 hid so well:
the missing key made the keyless preview return empty 200s, and the `H6` path would have 500'd even
*with* a key. Fixing either alone leaves the seeder dark.

**The repo already knew the right answer in two places** — `seed-trade-flows.mjs:14` ("API route
family; metadata tracks the active H6/HS2022 revision separately") and
`_bilateral-hs4-lazy.ts:20`, which uses `/C/A/HS` for the same data. Fix is the URL path only;
`comtrade-strategic-products.json`'s `H6` is correct provenance and was deliberately left alone.

**Verified**: new `tests/seed-comtrade-route-family.test.mjs` (4 tests), assertion-level A/B (all 4
fail when flipped back to `H6`), and the decisive check — the seeder's OWN `fetchBilateral()`
against Iceland returned **1,428 records** across all 5 requested HS4 codes.

### Bug #6 — data TTL (72h) far shorter than the monthly cron, so keys were absent ~27 of every 30 days

`TTL_SECONDS` was `259200` (72h) while the Railway service `seed-comtrade-bilateral-hs4` runs
monthly. Every per-country key therefore expired 3 days after a run and stayed gone for the rest of
the cycle — about 10% availability. Confirmed live: `comtrade:bilateral-hs4:{CN,US,DE}:v1` all
returned TTL `-2` (key does not exist).

**Why nobody noticed**: `api/health.js:243` deliberately probes the **seed-meta** key for this
domain ("meta-only aggregate: payloads are sharded by country"), so the vanished data keys were
structurally invisible to health. And `_bilateral-hs4-lazy.ts` silently refetches missing keys
per-request (concurrency 1, 5s timeout), keeping panels populated via an expensive degraded
fallback. Same masking pattern as bugs #4 and #5.

**Nothing wanted 72h.** Gate 24d; seed-meta TTL 25d; `api/health.js:474` `maxStaleMin: 34560` (24d);
`api/seed-health.js:104` `intervalMin: 17280` (12d); and the lazy fallback writes the SAME namespace
with `SUCCESS_TTL = 2592000` (30d) — the seeder was undercutting its own fallback's lifetime.

**Fix**: added `CRON_PERIOD_SECONDS = 30d` (pinning the Railway cadence, which lives in Railway's UI
not the repo) and `TTL_SECONDS = CRON_PERIOD_SECONDS + 5d` = **35 days**. Raising the TTL is the only
available lever: one run is 394 authenticated calls (197 countries x 2 batches) against a 500/month
**per-key** quota, so with 2 keys the ceiling is 2 runs/month — the cron cannot simply run more often.

**Verified**: 3 new invariant tests in the freshness-gate suite (TTL outlives cron with >=3d slack;
TTL >= the lazy fallback's `SUCCESS_TTL`, parsed from its source; TTL covers the full gate window),
assertion-level A/B (all 3 fail at the old 72h value). Also **updated a stale test**:
`comtrade-bilateral-hs4.test.mjs` pinned `TTL_SECONDS = 259200` "to match the cache interval" — a
bare literal-pin with no consumer behind it; it now asserts the literal cannot return and that TTL
derives from `CRON_PERIOD_SECONDS`. All comtrade suites: **88/88 pass**, `tsc --noEmit` clean.

### How to actually run the full comtrade seeder (answered for the operator 2026-08-18)

- **Not on this machine.** 394 calls; China's authenticated response alone is 22.5 MB, which at this
  link's 6-10 KB/s is 40-60 min for ONE request. A local run would burn most of the monthly quota
  and still not finish.
- **Preferred**: trigger the Railway service `seed-comtrade-bilateral-hs4`
  (`scripts/railway-services.json`, `nixpacks-root-repo`) after these fixes deploy.
- **Alternative**: locally with the VPN off — ~10 min of pacing plus transfer, so 20-40 min total.
- **`FORCE_RESEED=true` is no longer needed**: the bug #4 gate fix treats the stuck
  `recordCount=0` record as not-fresh, so the run proceeds on its own.
- **Cadence**: monthly. 1 run/month = 197 calls/key (39% of the 500 quota); 2 runs/month = 394/key
  (79%, fits); 3 runs/month = 591/key (exceeds). Monthly is also generous versus the data itself —
  these are *annual* series (`freqCode=A`) that UN Comtrade updates with a 1-2 year lag.

**⚠️ Related inconsistency, flagged NOT fixed (monitoring policy, operator's call)**: with a 30-day
cron, `api/health.js:474`'s `maxStaleMin: 34560` (24d) will report this domain stale for the last
~6 days of every cycle. Either the health threshold should be ~2x the cron (60d, matching the
convention used by its neighbours) or the cron should tighten to ~24d. Not changed unprompted.

### 2026-08-18 — Nitric fully restarted (operator's call: "too stale, couple of days")

`.env` is read by services only at process start (`nitric.yaml:11,14` -> `npx tsx watch
--env-file=.env`). Verified empirically that **`.env` is NOT watched**: `touch .env` left the API
worker PID unchanged. The running instance (PID 18199, up since **Aug 10 21:55**; newest worker
reloaded Aug 17 11:02) therefore predated the 2026-08-18 12:09 credential edit and could not see it.

Two of the three new credentials ARE read by Nitric-served code — `WTO_API_KEY`
(`server/worldmonitor/trade/v1/_shared.ts:50`) and `EXA_API_KEYS`
(`server/worldmonitor/market/v1/stock-news-search.ts:285`). `COMTRADE_API_KEYS` is seeder-only
(the lazy fallback uses the keyless public endpoint), so it needed no restart.

**Restart done**: SIGTERM to 18199 (clean exit in 3s), three orphaned children
(`npm exec tsx` x2, `scenario-worker`) terminated before restart so they could not conflict — same
orphan shape as the session-19 sidecar work. New instance PID 77333, port 4001 up in 4s, detached
via `nohup`. **Zero `WTO_API_KEY not set` / `EXA_API_KEYS not set` warnings in the new log** —
credentials confirmed live.

**⚠️ Nitric's local supervisor does NOT respawn a service that exits.** Correct accounting of the
10 declared services (an earlier note in this session overstated this as "half the tree died" by
counting one-shot seeders as casualties — they exit by design):

- **7 long-running** (the real steady-state count): `gcp/api/main.ts`, `gcp/scheduler/main.ts`,
  `ais-relay.cjs`, `publish-bootstrap-tiers.mjs --loop`, `scenario-worker.mjs`,
  `process-simulation-tasks.mjs` and `process-deep-forecast-tasks.mjs` (both log `once=false`).
- **2 one-shot** bundle runs that complete and exit normally:
  `seed-bundle-portwatch-port-activity.mjs`, `seed-bundle-resilience-validation.mjs`.
- **1 permanently broken**: `seed-digest-notifications.mjs` (missing `resend`, see below).

**Real finding: the 8-day-old instance was running 5 of the 7 long-running services** — it had
silently lost `process-simulation-tasks` and `process-deep-forecast-tasks`, the two task
processors, with the parent still healthy and all ports open. The fresh instance runs all 7, so the
restart recovered both. **Uptime is a misleading health signal here — check the 7 long-running
names are present via `pgrep -P <nitric pid>`, not just a raw child count** (a raw count drifts
legitimately as the one-shot bundles finish).

**Three errors the restart made visible (all pre-existing, none caused by it):**
1. `seed-digest-notifications` — crashes instantly with `Cannot find module 'resend'`. Confirmed
   `resend` is **not in `package.json`** and not in `node_modules`, so this service can never start.
   Fix would be `pnpm add resend` — NOT done, it is a dependency change and the operator's call.
2. `publish-bootstrap-tiers` — both tiers fail: `Bootstrap publisher requires explicit
   IRAN_EVENTS_ENABLED=true|false`. Documented at `.env.example:234` as `IRAN_EVENTS_ENABLED=false`
   but **absent from `.env`**, and the publisher refuses to default. Process stays up publishing
   nothing, and has been doing so for at least 8 days. One-line `.env` fix — NOT done, operator's call.
3. `ais-relay` — `WORLDMONITOR_RELAY_KEY not set`, warm-pings will 401. Already flagged in category 4.

Nitric log for this instance: `scratchpad/nitric-start.log` (session scratchpad — the operator may
prefer re-running `nitric start` in their own terminal for live visibility).

### ▶ Category 7 pre-analysis — done 2026-08-18 so the next session does not re-derive it

All 21 files exist. **21 scripts are covered by 13 runs in pass 1**, plus a pass 2 for whichever
bundle sections gate-skip.

**`bundle-market-backup` spawns 8 of them** — `crypto-quotes`, `hyperliquid-flow`,
`stablecoin-markets`, `etf-flows`, `gulf-quotes`, `token-panels`, `gold-etf-flows`,
`gold-cb-reserves`. Section timeouts 60-180s each; **no `maxBundleMs`**, so worst case is the
900s sum. Run the bundle FIRST (sections skip if seeded within `intervalMs * 0.8`), then pass 2
each skipped section individually.

**The other 12 run standalone**: `aaii-sentiment`, `commodity-quotes`, `cot`, `crypto-sectors`,
`earnings-calendar`, `fear-greed`, `market-breadth`, `market-quotes`, `prediction-markets`,
`forecasts`, `forecast-resolutions`, `forecast-bets`.

**Lock check: no peer collisions.** Every `runSeed` caller has a distinct `domain:resource`
(mostly `market:*`, plus `prediction:markets`, `forecast:resolutions`, `forecast:predictions`).
Only the bundle-vs-its-own-8-components can collide, so keep the bundle out of any parallel batch.
`bundle-market-backup` and `forecast-bets` do not call `runSeed` at all.

**⚠️ Real dependency chain — run these four IN THIS ORDER, last:**
`commodity-quotes` → `forecasts` → `forecast-resolutions` → `forecast-bets`
- `forecast-resolutions` reads `forecast:predictions:history:v1` (from `forecasts`) and
  `market:commodities-bootstrap:v1` (from `commodity-quotes`), and writes `forecast:resolutions:v1`
  + `forecast:scorecard:v1`.
- `forecast-bets` reads `forecast:resolutions:v1` (from `forecast-resolutions`).
Out of order these fail for dependency reasons, exactly like `hs2-chokepoint-exposure` did in
category 5 — do not log that as a bug.

**🎁 Cross-category bonus**: `seed-forecasts.mjs` writes `news:digest:v1:full:en` (lines 370, 952),
which is the missing input that blocked **category 3's `recall-benchmark`**. Once `forecasts` has
run, go back and test `recall-benchmark` — that closes the last open category-3 item.
(`seed-insights.mjs` in category 9 writes the same key.)

**Credential pre-flight for category 7** (checked 2026-08-18):
- `FINNHUB_API_KEY` — ✅ **SET 2026-08-18** (`.env:60`), operator-supplied. Live-verified against
  all four endpoints the repo calls, on both auth forms (`?token=` and the `X-Finnhub-Token`
  header that `scripts/ais-relay.cjs:2124` uses): `/quote`, `/search`, `/calendar/earnings`,
  `/stock/insider-transactions` all HTTP 200 on the free tier. Finnhub is also one of the few
  hosts NOT throttled on this machine (~1.8s), so local runs of `market-quotes` /
  `earnings-calendar` are trustworthy.
  - **Free tier does NOT cover candles**: `/stock/candle` and `/crypto/candle` return HTTP 403
    `"You don't have access to this resource."`. `scripts/seed-economy.mjs:419` uses those for
    BTC/QQQ/XLP, but *only* as Yahoo-failure fallbacks, and it degrades to `[]` → status
    `UNKNOWN`. Same behaviour as with no key at all — not a regression, but do not log it as a
    new bug when Yahoo is down.
  - **Restart required for the relay**: `scripts/ais-relay.cjs:1898` reads the key into a
    module-level const at load. The relay running since before 2026-08-18 still logs
    `finnhub: no` and will keep using the Yahoo-only path until restarted.
- `ALPHA_VANTAGE_API_KEY` — ✅ **SET 2026-08-18** (`.env:69`), operator-supplied. Free tier.
  Live-verified per function family:
  - ✅ **Physical commodities** (`WTI`, `BRENT`, `NATURAL_GAS`, `COPPER`, `ALUMINUM`, `GOLD`,
    `SILVER`) — HTTP 200, real daily-close data. Used by `commodity-quotes` + `gulf-quotes`.
  - ✅ **`FX_DAILY`** — HTTP 200, real series. Used by `gulf-quotes`.
  - ❌ **`REALTIME_BULK_QUOTES` is PREMIUM** — and it does **not** return an error. It returns
    **HTTP 200 with fabricated sample data** (`{endpoint, message, data:[...]}`, prices stamped
    `2024-10-18`) for exactly the symbols you asked for. Neither guard in
    `scripts/_shared-av.mjs:135-141` catches it: there is no `Information` key, and `json.data`
    *is* an array.
    - **Why nothing is poisoned anyway**: the parser reads `item.price` and
      `item['previous close']`, but the payload carries `close` / `previous_close`. Every row
      fails `Number.isFinite(price)` and is skipped. **Empirically confirmed** by running the real
      `fetchAvBulkQuotes()` against the real captured response — returns an **empty Map**.
    - **So this is a latent trap, not an active corruption**: the field-name mismatch is the only
      thing standing between the artificial data and Redis. Anyone "fixing" the field names to
      match AV's schema, without first adding a premium-gate guard, turns a silent no-op into
      silent fake-price ingestion across `market-quotes`, `etf-flows` and `commodity-quotes`.
    - **Fix (NOT applied — operator's call, and it is a behaviour change):** reject in
      `fetchAvBulkQuotes` when `json.message` is absent/not `success`, or when `json.endpoint`
      is present alongside a non-`success` message. Do that BEFORE any field-name correction.

**⚠️ Alpha Vantage free tier = 25 requests/DAY, shared across every script.** Measured call
volume for one full category-7 pass:
| script | AV calls | note |
|---|---|---|
| `commodity-quotes` | 7 physical + 1 bulk = **8** | 7 of 33 symbols map to AV physical |
| `gulf-quotes` | **8** | 2 `oil` + 6 `currency` of 14 (`index` skips AV) |
| `market-quotes` | **1** per 100 symbols | bulk — premium-gated, returns nothing |
| `etf-flows` | **1** | bulk — premium-gated, returns nothing |
| **total** | **~18** | plus up to 2x on retry (`_shared-av.mjs:22` retries once) |
**3 of those ~18 are guaranteed-useless bulk calls.** A single pass fits in 25/day only if it is
not repeated. If a rerun is needed the same day, expect `json.Information` rate-limit warnings and
AV-sourced rows to silently vanish — **do not log that as a seeder bug**, check the quota first.
- `INFOWAY_API_KEY` — ✅ set. Expect `market-quotes` and `earnings-calendar` to run degraded rather
  than fail outright; confirm against `seed-meta` before calling either a bug.

### ⛔ CANNOT FIX HERE — needs an operator decision or a credential

Ordered by value. Each says exactly what is blocked and what unblocks it.

**A. `seed-aaii-sentiment` XLS parser — needs a new dependency.** `parseXlsRows` cannot read a real
AAII `.xls`: the SST string table never resolves (so no text cell survives, so the
"Bullish/Bearish" header is never found) and MULRK/MULBLANK records are unhandled. Proven against
the fully-downloaded 1.28 MB file, so this is **not** a network artifact. `exceljs@^4.4.0` is
already present but reads xlsx/csv only — **legacy BIFF `.xls` needs a SheetJS-class reader**.
*Impact while deferred*: the HTML path (fix 1) supplies a correct **current** week, so the panel is
healthy, but `weeks`/`avg8w`/`extremes` are computed from a single row instead of 52.
*Unblock*: approve adding an `.xls` reader, then restore the multi-week history path.

**B. `pnpm add resend`** — `seed-digest-notifications` crashes instantly with
`Cannot find module 'resend'` and can never start. Dependency change = operator's call. Unchanged
from session 21.

**C. `R2_BOOTSTRAP_*` credentials** — blocks `publish-bootstrap-tiers` (see fix 6). Also
`CLOUDFLARE_R2_BUCKET` / `CLOUDFLARE_R2_TRACE_BUCKET` unset disables R2 trace storage in
`seed-forecasts` (account id + token ARE set; only bucket names are missing).

**D. Still-unset credentials**: `RELIEFWEB_APPNAME`, `PROXY_URL`, `WORLDMONITOR_RELAY_KEY`
(ais-relay warm-pings 401 without it), `WM_SESSION_SECRET`, `WM_API_BASE_URL`.

**E. AV per-minute pacing — deliberately NOT fixed.** `seed-gulf-quotes.mjs:50` and
`seed-commodity-quotes.mjs:167` fire 7-8 AV calls back-to-back with no delay and trip the free
tier's per-minute cap after ~2. The obvious fix (a `sleep` between calls) needs ~12s spacing × 8
calls ≈ 96s, which risks blowing the bundle **section timeouts (60-180s)** for a path that
currently costs nothing: both seeders fall through to Yahoo and reach full coverage (14/14 and
33/33). Fixing pacing without first raising those section timeouts would convert a harmless warning
into a real timeout. Needs a decision, not a patch.

**F. `api/health.js:474` staleness threshold vs the 30-day comtrade cron** — carried from
session 21, untouched.

**G. ~~Committing the working tree.~~ ✅ RESOLVED 2026-08-18 (session 23).** Operator gave the
go-ahead; all 13 files landed as **seven commits, one per fix**, on `main`, deliberately NOT pushed
(operator pushes manually). Verified before committing: the 5 touched suites pass 93/93 and
`tsc --noEmit` is clean. `be399f3` comtrade bilateral HS4 (route family + TTL + empty-run gate),
`8363954` iea-oil-stocks extraKey leak, `0e21dd4` ucdp-events timeouts, `49ab19b` defense-patents
timeouts + `USPTO_API_KEY` in `.env.example`, `25fd81b` aaii-sentiment fallback publishing,
`5714af7` alpha vantage premium-sample guard, `c40d855` this handoff. Tree clean, **`main` 13 ahead
/ 0 behind `origin/main`**.

### ✅ FIXES APPLIED 2026-08-18 (session 22) — all verified, ALL COMMITTED session 23 (see item G)

**1. `scripts/seed-aaii-sentiment.mjs` — HTML fallback URL** (`:14`)
`/sentimentsurvey` → `/sentimentsurvey/sent_results`. Verified: `HTML scraped: 1 rows` →
`{2026-08-13, bull 34.7, neutral 27.4, bear 37.9}`. Parser unchanged; it was already correct.

**2. `scripts/seed-aaii-sentiment.mjs` — `validate()` now rejects `fallback === true`**
This is the fix for the *invisibility*, which mattered more than the URL. Publishing fallback used
to overwrite last-good data AND arm `seed-meta` with `fetchedAt = now`, so health read fresh over a
months-old payload. Returning `false` routes into `runSeed`'s validate-fail branch
(`scripts/_seed-utils.mjs:1829`), which is purpose-built for exactly this: it does **not** publish,
extends the TTL on existing keys, and mirrors canonical's **original** `fetchedAt` into `seed-meta`
so `STALE_SEED` fires naturally.
**Verified live** — a fallback run now prints:
`SKIPPED: validation failed ... seed-meta mirrors canonical (fetchedAt=...) ... === Done (no write) ===`
*Trade-off, deliberate*: if both upstreams fail AND the canonical key has expired (7-day TTL), the
panel shows nothing rather than April data. Preferred over silently serving stale numbers as fresh.

**3. `scripts/seed-aaii-sentiment.mjs` — HTML failure is no longer silent**
A non-2xx response logged nothing at all, and a 200-with-0-rows logged nothing either — which is
why defect 1 survived. Both now warn. Immediately paid off: the next run printed
`HTML scrape: HTTP 200 but 0 parsable rows (6058B)`, revealing AAII was serving a 6 KB stub.

**4. `scripts/_shared-av.mjs` — REALTIME_BULK_QUOTES premium-gate whitelist**
Refuses any response whose `message` is not literally `"success"`. **Whitelist, not blacklist**: if
AV changes its gate wording we degrade to "no data", never to fake data. Verified against the real
captured premium payload → **rejected with a warning** (previously silent).

**5. `scripts/_shared-av.mjs` — bulk-quote field names**
The parser read `item.price` / `item['previous close']`; AV's documented schema is `close` /
`previous_close` / `change_percent`, so the loop dropped every row **even on a paid plan**. Now
accepts both spellings. **Safe only because fix 4 lands first** — widening the parser without the
guard is precisely the change that would turn the silent no-op into fake-price ingestion.
Verified: artificial payload → 0 rows; simulated paid-shape payload → parsed correctly.

**6. `.env` — `IRAN_EVENTS_ENABLED=false`** (value from `.env.example:234`)
`publish-bootstrap-tiers.mjs` refuses to default and both tiers had been failing for 8+ days.
**⚠️ This was only the FIRST of two blockers** — the earlier note calling it "a one-line fix" was
incomplete. With the flag set, the publisher now gets further and fails on the *next* one:
`[R2] Config: accountId=MISSING, bucket=MISSING` → `fatal: Bootstrap publisher R2 credentials are
missing`. It needs the `R2_BOOTSTRAP_*` profile (`.env.example:229-244`) — a **different** profile
from the `CLOUDFLARE_R2_*` keys that are set. Operator must supply; cannot be fabricated.

**Production repair**: `market:aaii-sentiment:v1` had been left holding the stale fallback this
session wrote. Repaired with genuine AAII data captured at 05:31Z (real upstream bytes, replayed
because AAII had begun rate-limiting). Now `fallback:false, source:html, latest 2026-08-13`.

### ▶ Category 7 EXECUTION LOG — 2026-08-18 (session 22)

Method: bundle first, then pass 2 for gate-skipped sections, then the dependency chain last.
All runs `node --env-file=.env scripts/seed-<name>.mjs`. Exit 0 alone is NOT the pass criterion —
`recordCount` + real source lines in the log are.

**`bundle-market-backup`** — exit 0 in 8.6s, `ran:0 skipped:8 deferred:0 failed:0`. All 8 sections
gate-skipped (last seeded 0-585min ago, all inside `intervalMs * 0.8`). The skip timestamps are
themselves evidence that all 8 are alive in production. → pass 2 ran each individually.

**Pass 1 standalone (7, run in parallel — lock check held, no collisions):**
| script | exit | recordCount | notes |
|---|---|---|---|
| `aaii-sentiment` | 0 | 52 | ❌ **BUG #7** — fallback data, see above |
| `cot` | 0 | 9 | real CFTC positioning, date=2026-08-11 |
| `crypto-sectors` | 0 | 8 | clean |
| `market-breadth` | 0 | 9 | Barchart 3/3 readings, history appended |
| `earnings-calendar` | 0 | 100 | **Finnhub key working** — 100 of 1398 entries |
| `fear-greed` | 0 | 1 | all sources live; `AAII bull=34.7` exposed BUG #7 |
| `prediction-markets` | 0 | 75 | kalshi 38 markets, 273 raw → 75 |

**Pass 2 — the 8 bundle sections individually (all exit 0, all real data):**
`crypto-quotes` 10 · `hyperliquid-flow` 14 · `stablecoin-markets` 5 · `token-panels` 10 ·
`gold-etf-flows` 1 · `gold-cb-reserves` 20 (IMF IRFCL, 92 countries) · `etf-flows` 10 ·
`gulf-quotes` 14.

**`market-quotes`** — exit 0, 59 records. Source split: **Yahoo 34 / Finnhub 25 / Infoway 2 / AV 0**.
The new Finnhub key supplies 42% of this panel. Note Infoway, the documented *primary*, returned
only 2 — worth a look later, not investigated this session.

### ⚠️ Alpha Vantage: free tier trips a PER-MINUTE limit, not just the 25/day cap

`gulf-quotes` fired its 8 AV calls back-to-back and got **2 successes then 6 rate-limit rejections**:
`"Please consider spreading out your free API requests more sparingly"`. `_shared-av.mjs` only has
`AV_BATCH_DELAY_MS` *between bulk batches* — the per-symbol loops in `seed-gulf-quotes.mjs:50` and
`seed-commodity-quotes.mjs:167` have **no inter-call delay at all**, so on the free tier they are
guaranteed to trip the limit after ~2 calls.
**Not data loss** — both seeders fall through to Yahoo and reached full coverage (14/14 symbols).
It is wasted quota plus alarming-looking warnings. A `sleep()` in those loops would fix it;
**not applied** — it changes runtime behaviour of two production seeders.

`etf-flows` confirmed the premium-bulk finding live: **zero AV log lines**, because
`REALTIME_BULK_QUOTES` returns its HTTP-200 artificial payload, the field-name mismatch drops every
row, and the empty Map is indistinguishable from "no data". One AV call silently wasted per run.

### ❌ CORRECTION — the "cross-category bonus" was WRONG. `seed-forecasts` does NOT write `news:digest:v1:full:en`

The category-7 pre-analysis claimed running `forecasts` would retroactively unblock category 3's
`recall-benchmark`. **That is false and should not be retried.** Verified this session:
- `scripts/seed-forecasts.mjs:370` is an entry in the array of **input keys to READ**, sitting
  among `news:insights:v1`, `unrest:events:v1`, etc. Line 952 just assigns the parsed value
  (`newsDigest: parsedByKey[...]`). Both are **reads**.
- `scripts/seed-insights.mjs` is *also* only a reader (`readDigestFromRedis`, line 200) — the
  earlier note that it "writes the same key" is wrong too.
- **The only producer is an API route**: `server/worldmonitor/news/v1/list-feed-digest.ts:1047`
  writes it via `cachedFetchJson(digestCacheKey, 900, ...)` — a **request-driven cache with a
  900-second TTL**.

**Consequence**: `news:digest:v1:full:en` only exists for 15 minutes after someone actually requests
the news-digest API with `variant=full&lang=en`. Confirmed `exists = 0` right now, even though
production seeded `forecasts` successfully ~2.5h ago. **Category 3's `recall-benchmark` is
therefore blocked on an ephemeral request-cache, not on any seeder.** To test it, hit the digest
endpoint first and run `recall-benchmark` inside the 15-minute window. That a seeder depends on a
short-lived request cache is itself worth a design look.

### ▶ Category 7 dependency chain — results (run in the mandated order)

| script | exit | outcome |
|---|---|---|
| `commodity-quotes` | 0 | 33/33 commodities. AV: 3 success / 3 rate-limited, Yahoo covered 30. |
| `forecasts` | **75** | **Failed gracefully — network, NOT a bug.** See below. |
| `forecast-resolutions` | 0 | 14 records, `forecast:resolutions:v1` + `scorecard` written. |
| `forecast-bets` | 0 | 18 shadow bets [energy:4, market:10, macro:4]. No `seed_complete` line — expected, it does not call `runSeed`. |

**`forecasts` exit 75 is EX_TEMPFAIL, and the script behaved correctly.** Three full retries of the
fetch phase, each dying on `Reading input data from Redis... aborted due to timeout`, then
`FETCH FAILED: fetch phase exceeded 360000ms deadline` → `Failed gracefully (362725ms)`. It
**refused to publish** and **extended TTL on 4 keys (21600s)** to keep existing data alive.
**Verified not a bug**: `seed-meta:forecast:predictions` shows `fetchedAt` ~2.5h before this run
(`recordCount: 2`, `sourceVersion: detectors+llm-pipeline`) — production seeds it fine. This is the
documented 6-10 KB/s local throttle; `forecasts` reads far more input keys than any other seeder,
so it is the one that cannot fit inside the deadline locally. **Do not "fix" this deadline.**
Downstream still worked because `forecast:predictions:history:v1` already held production's data.

### 📋 Config gaps surfaced by `seed-forecasts` (non-fatal, degrade gracefully)

- **`CLOUDFLARE_R2_BUCKET` / `CLOUDFLARE_R2_TRACE_BUCKET` unset** → `scripts/_r2-storage.mjs:160`
  logs `[R2] Config: accountId=set, bucket=MISSING` and returns `null`, disabling R2 trace storage.
  R2 is **half-configured**: `CLOUDFLARE_R2_ACCOUNT_ID` and `CLOUDFLARE_R2_TOKEN` *are* in `.env`,
  the bucket names are not. Both documented at `.env.example:214-215`. Operator's call.
- **`WM_API_BASE_URL` unset** (documented `.env.example:729`) → `[Chokepoints] Warm-ping skipped`.
  Harmless locally; the warm-ping only matters against a deployed API.

### 🔍 Why the test suite never caught BUG #7 — a coverage-shape lesson

`tests/seed-aaii-sentiment.test.mjs` is **29 passing assertions, all against synthetic fixtures**
that are built to match each parser's own assumptions: `extractSentimentData` gets hand-made rows
with a correct header, `parseHtmlSentiment` gets hand-written "AAII-style HTML", and `parseXlsRows`
is only ever given an **empty buffer** and **non-XLS data**. Nothing asserts the upstream contract —
not which URL is fetched, not that a real AAII `.xls` parses, not that `fallback === true` is a
failure condition. So the unit tests stayed 100% green while the integration was 100% broken.
Same lesson as the session-21 comtrade TTL: **a green suite says the parsers agree with their
fixtures, not that the seeder works.**

### 🐛 BUG #7 — `seed-aaii-sentiment.mjs`: BOTH upstream paths dead, silent fallback (2026-08-18)

**Symptom**: run reports `state: OK`, `recordCount: 52`, "Verified: data present in Redis" — while
serving **hardcoded `FALLBACK_DATA` whose newest week is 2026-04-03**, ~4.5 months stale.

**Two independent defects, either one sufficient to break it** (defect 1 fixed, defect 2 open):

1. **HTML fallback scraped the wrong URL — ✅ FIXED (one line, `scripts/seed-aaii-sentiment.mjs:14`).**
   `AAII_HTML_URL` pointed at `https://www.aaii.com/sentimentsurvey` (the landing page): returns
   HTTP 200 / 93 KB with **zero** `td.tableTxt` cells, so `parseHtmlSentiment()` yielded `[]` and
   fell through silently. The numbers live at `/sentimentsurvey/sent_results` (46 KB, HTTP 200).
   **`scripts/seed-fear-greed.mjs:112` already used the correct URL** — the two scripts disagreed,
   and fear-greed's `AAII bull=34.7` in the same batch is what exposed it.
   Verified after the fix: `HTML scraped: 1 rows` → `{date:2026-08-13, bullish:34.7, neutral:27.4,
   bearish:37.9, spread:-3.2}`. The existing parser needed **no** change — it was already written
   for the sent_results layout.

2. **XLS primary path is broken independent of the network — ❌ NOT FIXED (needs a decision).**
   Proven with the real 1.28 MB file fully downloaded to disk (so throttling is ruled out):
   `parseXlsRows()` returns 391 rows but only 1061 non-null cells of 3910, **all numeric, no
   strings**. `extractSentimentData()` scans the first 20 rows for the literal headers
   "bullish"/"bearish"/"neutral"; no string ever resolves, so `headerIdx = -1` and it returns `[]`.
   Root causes in the hand-rolled BIFF scanner (`seed-aaii-sentiment.mjs:15`):
   - **SST/LABELSST resolution fails** — `strings[sstIdx]` is `undefined`, so every text cell
     becomes `null`. This alone kills the header lookup.
   - **MULRK (`0x00BD`, 2433 records) and MULBLANK (`0x00BE`, 1662) are unhandled** — only single
     NUMBER/RK/LABELSST are parsed, so most numeric cells (including the date column) are missed.
   - The file is an **OLE2 compound document**; the scanner walks raw bytes rather than the
     workbook stream, which is why it half-works.
   **Fix requires a real BIFF reader.** `exceljs@^4.4.0` is already a dependency but reads
   xlsx/csv only, **not legacy .xls** — so this means a new dependency (SheetJS-class). That is a
   `package.json` change and therefore **the operator's call**, same class as the deferred
   `pnpm add resend`.

**Net effect of the fix applied**: the panel is no longer pinned to April data — it now gets a
current weekly reading. But `recordCount` drops 52 → 1, because the HTML page carries only the
latest week; `weeks`, `avg8w` and `extremes` are computed from a single row until the XLS path is
repaired. **This is a real trade-off to be aware of, not a regression** — the 52 rows it replaced
were fabricated.

**⚠️ Method hazard discovered — local runs WRITE TO PRODUCTION Redis.** Seeding from this machine
(6-10 KB/s throttle) can *downgrade* a live key: this session's first `aaii-sentiment` run replaced
the live payload with the stale fallback. Worse, **`seed-meta:market:aaii-sentiment` is stamped
`fetchedAt: <now>` with `recordCount: 52` even on a pure-fallback run** — the freshness gate reads
healthy while the payload is 4.5 months old. Same failure shape as the session-21
`comtrade-bilateral-hs4` bug (zero-record run stamping `status:ok` and arming its own gate).
**Consider making `seed-meta` refuse to arm when `fallback === true`.** Not done — behaviour change.

**AAII is rate-limit sensitive**: after ~6 requests it began returning a 6 KB stub for the XLS and
failing the HTML scrape. Space out probes; a failure right after repeated hits is not a bug.
**Production Redis was left holding fallback data** because the final local run coincided with that
throttling — the next production cron (unthrottled, with the URL fix deployed) will correct it.

**✅ Category 7, Markets & Finance (21 scripts) — DONE 2026-08-18 (session 22).** All 21 exercised:
bundle (8 sections gate-skipped) + 8 individually in pass 2 + 12 standalone. 20 of 21 healthy with
real data; `aaii-sentiment` was the one real bug (BUG #7, half-fixed). `forecasts` exit-75 is the
local network throttle, verified against production `seed-meta` — not a bug.

**Resume point: category 8** — categories 1–7 done (**127 of 156 scripts**). Do not restart from
category 1. Carry forward into category 8:
1. Re-verify repo state first; do not trust these numbers.
2. Read the network caveat — Finnhub and Cloudflare are fast here; nearly everything else is
   6-10 KB/s. Check `seed-meta:<domain>:<resource>` for a recent production success before calling
   any local timeout a bug.
3. Alpha Vantage free tier: **25/day AND a per-minute cap**. ~22 of 25 were spent on 2026-08-18 (≈18 by seeders + 4 manual probes) — a same-day rerun of category 7 will rate-limit.
4. Local runs write to PRODUCTION Redis and can downgrade a live key. See the BUG #7 method hazard.

---

## 🔖 HANDOFF (2026-08-17, twentieth session — consolidated, categories 1–4 of 11 done)

**Repo state**: `main` is **6 commits ahead of `origin/main`, 0 behind** (re-verified via `git
fetch` + `git rev-list --left-right --count` this session — don't trust an older number blindly).
**6 files uncommitted** *(as of session 20 — ALL COMMITTED in session 23, see the top block)*, all from this session, holding for explicit go-ahead per this repo's
standing discipline: `TASKS.md` (this handoff), `scripts/seed-iea-oil-stocks.mjs` +
`tests/seed-extra-key-leak-guard.test.mjs` (fix #1), `scripts/seed-ucdp-events.mjs` (fix #2),
`scripts/seed-defense-patents.mjs` + `scripts/_defense-patents-source.mjs` (fix #3). `.env` and
`.env.example` also changed (several new credential lines in `.env`, gitignored, not part of any
commit; one new documented placeholder in `.env.example` — see below).

**What this session did, in order**: started the 156-seed-source initiative for real (queued three
times across sessions 18–19 before this). Batch-ran categories 1–4 live (58 of 156 scripts) with
operator review after each category, found and fixed 2 real reproducing bugs, then did two rounds
of local-credential setup with the operator (adding real API keys/tokens to `.env` and diagnosing
each one live against its real provider) between categories 4 and 5.

### Category-by-category results (156-script list itself is unchanged, see NEXT INITIATIVE below)

**1. Energy & Fuel (24 scripts) — done.** 20 clean passes, 2 with a transient non-fatal
"verification read returned null" warning (`pipelines-gas`, `storage-facilities` — write itself
succeeded; Upstash read-after-write race, not data loss), 1 real bug fixed (see below), 2 flagged
external blockers: `jodi-oil` (6 straight retries all aborted at 30s against JODI's API — didn't
hammer further, worth one clean retry from a fresh session) and `ember-electricity` (couldn't reach
`storage.googleapis.com` from this machine — 3 full attempts each hung the entire 5-min timeout;
every other category-1 script worked fine over the same window, so this reads as host-specific, not
a general outage — the `local-network-optimizer` skill exists for exactly this shape of problem if
it recurs).

**2. Climate & Environment (11 scripts) — done.** 7 clean passes, 4 fails tracing to 2 independent
root causes, no code bugs: (a) live Open-Meteo 429 rate-limiting blocks `climate-zone-normals`,
which cascades into `bundle-climate` (times out, runs zone-normals as a sub-source) and
`climate-anomalies` (fails fast and correctly — a deliberate dependency guard refusing to compute
anomalies without a baseline, not a bug); retry order when picked up: zone-normals first, then
anomalies, then re-verify bundle-climate. (b) `climate-disasters` blocked by `RELIEFWEB_APPNAME`
(documented, was unset — still is, operator deferred) plus its other source's Redis read timing out
under this session's own heavy concurrent traffic.

**3. Health (5 scripts) — done.** 3 clean passes, 1 real reproducing bug flagged (not fixed —
operator said flag and move on): `vpd-tracker`'s write to `health:vpd-tracker:realtime:v1` (the
single largest real production payload at 3.14 MB, per `tests/seed-extra-key-leak-guard.test.mjs`'s
own comment) times out against the shared write path's flat 15s `AbortSignal.timeout`
(`_seed-utils.mjs:259`) — reproduced twice with zero concurrent Redis traffic, so it's systemic, not
a flake. Worth a real fix (timeout scaled to payload size, or chunking) whenever picked up. Also 1
cross-category dependency block, same shape as climate-anomalies: `recall-benchmark` needs
`news:digest:v1:full:en`, written by category 7's `seed-forecasts.mjs` or category 9's
`seed-insights.mjs`, neither of which has run yet in this sweep.

**4. Military/Conflict/Security (18 scripts) — done, by far the messiest category.** 6 clean passes
(`conflict-intel`, `cyber-threats`, `hormuz`, `military-flights`, `security-advisories`,
`military-cii`), 2 pass-but-degraded (`gdelt-intel` 0 records/graceful; `military-maritime-news`
warm-pings 401 on missing `WORLDMONITOR_RELAY_KEY`, still unset, not pursued), 1 deliberately
disabled (`iran-events` — `IRAN_EVENTS_ENABLED` off, feature sunset 2026-07, not a bug), 4 live
external timeouts/blocks not credential-related (`fatf-listing` 403+503, `sanctions-pressure` 197s,
`submarine-cables` 131s, `thermal-escalation` 81s — none retried further), and originally 6 fails
tracing to missing local `.env` credentials — see the credential-review section below for what
happened to each. **`military-cii`'s initial fail was a pure testing-timing artifact, not a bug**:
it ran alphabetically before `military-flights` in the batch and found no data, but
`military-flights` writes its live key with a deliberately short 600s TTL (correct design for
real-time aircraft positions) which had simply expired by the time the rest of the 18-script batch
finished. Running both back-to-back confirmed clean. Don't trust a `military-cii` fail unless
tested within ~10 min of a real `military-flights` run.

### 3 real bugs found and fixed this session (verified live) — ⚠️ SUPERSEDED LABEL: these were COMMITTED in session 23 (`be399f3`..`c40d855`), ignore "uncommitted" below

1. **`scripts/seed-iea-oil-stocks.mjs`** (found in category 1) — its per-country `extraKey`
   transform (`COUNTRY_EXTRA_KEYS`) returned the raw `parseRecord()` member verbatim, which carries
   a `seededAt` field the canonical index's `publishTransform` deliberately strips. `runSeed`'s
   contract-mode leak guard correctly caught this every run and aborted the entire seed (zero
   country keys written, not even partial). Confirmed `seededAt` is unused by every downstream
   reader. Fixed by destructuring it out of the transform's return value. **Root cause of why this
   shipped undetected**: the existing regression test for this exact guard
   (`tests/seed-extra-key-leak-guard.test.mjs`) used a fixture member without `seededAt` — not what
   `parseRecord()` actually produces — so the test's green result never exercised the real shape.
   Fixed the fixture and added a new test pinning both the bug and the fix. Verified: `node --test`
   (44 tests pass), `tsc --noEmit` clean, live re-run — all 32 country keys + 2 analysis keys wrote
   and verified in Redis.
2. **`scripts/seed-ucdp-events.mjs`** (found only after the operator added `UCDP_ACCESS_TOKEN` —
   see credential review below) — `UCDP_PAGE_SIZE = 1000` combined with a 90s
   `AbortSignal.timeout` on every page fetch; a single `pagesize=1000` page measured ~105s via
   direct `curl`, so every fetch was guaranteed to abort regardless of GED version tried, previously
   masquerading as "UCDP is down" when the real symptom (before the token was added) was 401s.
   Fixed: bumped to a named `UCDP_FETCH_TIMEOUT_MS = 180_000`. Also bumped a second, tighter 5s
   timeout on the post-write verification read-back to 15s (matching the SET call right above it)
   — this one didn't fully resolve on retest (still times out occasionally under this session's own
   40+-seed-runs-in-a-few-hours Redis load, the same benign "write succeeds, read-back races" shape
   seen 3 other times this session), but the actual write is independently confirmed via `Redis SET
   result: OK` before that read-back ever runs, and the script already treats it as non-fatal by
   design (caught, `exit(0)`) — not chased further. Verified: `tsc --noEmit` clean, 2 live end-to-end
   runs — second one wrote 2000 real conflict events to `conflict:ucdp-events-bootstrap:v1`.
3. **`scripts/seed-defense-patents.mjs` + `scripts/_defense-patents-source.mjs`** (found only after
   the operator got a working `USPTO_API_KEY` — see credential review below). Two-part timeout bug,
   same family as the UCDP one but compounded: (a) `_defense-patents-source.mjs`'s per-request
   `AbortSignal.timeout(20_000)` — a single OR-heavy CPC-category query measured ~64s via direct
   `curl` (448KB response; USPTO's own search latency, not a transfer-size issue), so every category
   fetch was guaranteed to abort; (b) `fetchAllPatents` fetches 5 CPC categories **sequentially**
   with a deliberate 3s courtesy delay between each — even after fixing (a), worst case ~5×90s +
   4×3s ≈ 462s exceeds `runSeed`'s own default fetch-phase deadline (~240s, the issue #4786
   backstop), which is a separate ceiling from the per-request timeout, not a duplicate of it. Fixed
   both: bumped the per-request timeout to a named `USPTO_FETCH_TIMEOUT_MS = 90_000`, and passed an
   explicit `fetchPhaseTimeoutMs: 540_000` in the seeder's `runSeed(...)` opts. Verified: `tsc
   --noEmit` clean, `node --test tests/seed-defense-patents.test.mjs` (16 tests pass), live
   end-to-end run — `=== Done (401604ms) ===`, 71 real patents written and verified in Redis across
   4 of 5 categories (F42B individually failed and was gracefully skipped — `fetchAllPatents` only
   hard-fails if *every* category fails, so a single flaky category doesn't block the whole write;
   same graceful-degradation shape as `jodi-gas`/`jodi-oil` in category 1).

### Credential review (between categories 4 and 5) — operator added 5 credentials to `.env`

All confirmed via direct API reproduction (curl against the real provider, not just re-running the
seed script), not guessed:

- **`AVIATIONSTACK_API`** — added, valid and active (confirmed: an unfiltered API call returns real
  data), but `aviation` still can't fully pass: the seeder's per-airport query includes
  `flight_date=<today>` (`scripts/seed-aviation.mjs:421`), and replaying that exact request returns
  AviationStack's own `"function_access_restricted": "Your current subscription plan does not
  support this API function"` — a free-tier plan limit, not fixable without a paid subscription.
  **Operator: not today, stays flagged.** `aviation` still partially succeeds regardless — FAA
  delays (5 alerts) and aviation news (37 articles) write fine independent of this.
- **`CLOUDFLARE_R2_ACCOUNT_ID` + `CLOUDFLARE_R2_TOKEN`** — added; `military-bases` progressed
  through 3 distinct failure states as the operator worked through it live: (1) 403 "Please enable
  R2 through the Cloudflare Dashboard" → operator enabled R2 on the account; (2) 404, `"buckets":[]`
  — the account had zero R2 buckets, meaning `worldmonitor-data` (holding
  `seed-data/military-bases-final.json`) lives in a different, presumably-production Cloudflare
  account → operator created a `worldmonitor-data` bucket in this account; (3) confirmed via direct
  `GET .../objects` that the new bucket exists but is **empty** (`"result":[]`) — creating it was
  necessary but not sufficient, the actual data file still needs to be uploaded into it from
  wherever the real one lives (or dropped locally at `scripts/data/military-bases-final.json`, which
  the script checks *before* ever trying R2). **Still flagged, needs the operator to source the file
  or point at the real production account.**
- **`ACLED_EMAIL` + `ACLED_PASSWORD`** — added (operator logs into ACLED via Google, so used the
  email+password OAuth route rather than the 24h-expiring static-token fallback). OAuth exchange
  against `https://acleddata.com/oauth/token` succeeds every time (valid signed JWT returned), but
  the data endpoint (`https://acleddata.com/api/acled/read`) returns `{"message":"Access denied"}`
  even on the simplest possible request, verified byte-for-byte against ACLED's own docs
  (fetched live: https://acleddata.com/api-documentation/getting-started). Request format is
  provably correct — the block is on the account's own API entitlement, which only someone logged
  into that ACLED account can diagnose further (check account settings for an API-access
  toggle/agreement, or contact their support). **Operator: "still not idea how to make it work, let
  it flag it."**
- **`UCDP_ACCESS_TOKEN`** — added, with the operator supplying the exact (non-standard) auth
  mechanism: a custom `x-ucdp-access-token` header, not Bearer. The script already sent it
  correctly, so this unblocked cleanly — see bug #2 above for what was found once auth started
  working.
- **`USPTO_API_KEY`** — added later in the session (operator got a key after initially deferring it
  for id.me verification). Also fixed the doc gap: added a placeholder line + comment to
  `.env.example` (right after the neighboring `UCDP_ACCESS_TOKEN` entry) since it was confirmed
  missing from there entirely. See bug #3 above for the real timeout bug this surfaced once the key
  worked.
- ✅ **`RELIEFWEB_APPNAME`** — RESOLVED 2026-08-18 (twenty-fifth session). Operator applied for and
  received an approved appname (`kcelectronic_L2cSNzTFKnjW`), added to local `.env`. Also found:
  `RELIEFWEB_ENDPOINTS`' first entry (`api.reliefweb.int/v1/disasters`) is now permanently
  decommissioned by ReliefWeb (confirmed via direct curl: `410 "The API version 'v1' has been
  decommissioned. Please use version 'v2' instead."`) — removed it from
  `scripts/seed-climate-disasters.mjs` so every run doesn't burn a guaranteed-failing request
  before falling through to v2. Verified end-to-end: `node --env-file=.env
  scripts/seed-climate-disasters.mjs` → `[ReliefWeb] 61 disasters from 62 rows`, seed completed
  `state: OK`, data confirmed present in Redis. (Separately, that same run also hit
  `[NaturalEvents] Redis read failed: The operation was aborted due to timeout` — same class of
  local-throughput-ceiling issue diagnosed earlier this session for Upstash/Overpass, not a new
  bug; already gracefully degrades (warns, returns `[]`, doesn't fail the seed) so left untouched.)
- **`PROXY_URL`, `WORLDMONITOR_RELAY_KEY`** — flagged in category 4, not brought up again this
  round, still unset. `PROXY_URL` blocks GDELT inside `unrest-events` plus 3 datacenter-blocked
  sources in category 1's `fuel-prices`; it needs an actual provisioned Railway-side CONNECT proxy,
  not just a value, so there's no quick local fix here regardless.

### Testing-harness lessons (not product bugs, but will bite again if not remembered)

- **Invocation**: `scripts/_seed-utils.mjs`'s `loadEnvFile()` only checks `.env.local` (never plain
  `.env`) plus one hardcoded fallback path that doesn't exist on this machine. This repo only has
  `.env`. **Always run `node --env-file=.env scripts/seed-<name>.mjs`** — the bare form fails every
  script identically with a misleading "Missing UPSTASH_REDIS_REST_URL" error that looks like N/N
  broken sources when it's actually a wrong invocation.
- **Don't SIGKILL a slow-but-legitimate seed script.** Several scripts legitimately run past a naive
  90–240s budget (`ember-electricity` has a 5-*minute* per-attempt fetch timeout with zero console
  output until parsing succeeds; several `bundle-*` scripts chain many sub-fetches). SIGKILL-ing one
  mid-run skips its `finally { releaseLock(...) }` and orphans its Redis concurrency lock
  (`seed-lock:<domain>`, 10–20 min TTL) — every retry within that window then correctly-but-
  confusingly self-skips with "Lock held by another run." **Fix**: switched the batch-runner
  watchdog to SIGTERM-first (10s grace before SIGKILL) starting category 2 — zero new orphaned locks
  since. If one does get orphaned: `PTTL seed-lock:<domain>` against Upstash to confirm it's
  genuinely stale (not a real concurrent run), then `DEL` it directly rather than waiting out the
  TTL blind.
- **This session generated unusually heavy Redis load** (40+ seed runs in a few hours against the
  same Upstash instance) — a pattern normal production cron scheduling never produces. Several
  "verification read timed out / returned null" warnings across categories 1, 2, 3, and the
  ucdp-events fix are almost certainly artifacts of that, not real bugs — each time, the actual
  *write* was independently confirmed successful before the read-back stumbled. Don't over-invest in
  chasing these unless one recurs outside a similarly heavy testing burst.

**Resume point: category 5, Supply Chain/Trade/Ports/Chokepoints (13 scripts)** — see NEXT
INITIATIVE section directly below for the full 156-script list (unchanged, still accurate). Do not
restart from category 1.

---

## 🔖 HANDOFF (2026-08-17, end of nineteenth session) — read this first, before anything below

**Both pieces of work the eighteenth session left uncommitted are now committed** (operator's
explicit go-ahead this session, "let's commit first"):
- `1634654` — the Live News/Live Webcams panel removal + Discord footer widget removal described
  in the eighteenth-session block just below. Verified via a fresh `git stash` A/B before
  committing: typecheck clean; test:data 40 vs 39 baseline failures, and the one delta
  (`readBootstrapTierObject` in `tests/bootstrap-r2-reader.test.mjs`) confirmed pre-existing/flaky
  by reproducing it in isolation on unmodified `main` too — not a regression.
- `754916f` — the "deliberately deferred" backend cleanup below, done as a follow-up in the same
  session (see corrected scope below).

**Correction to the eighteenth-session entry below: `api/webcam/v1/[rpc].js` is NOT dead code.**
That flag was wrong — it conflated the deleted `LiveWebcamsPanel` (TV-style live webcam viewer,
correctly removed) with `PinnedWebcamsPanel` (a separate, still-active "pin a webcam to the map"
feature — the `windy-webcams` panel, still registered in a mission preset, lazy-loaded from
`panel-layout.ts`). **Do not delete `api/webcam/*` or its generated client/server code** — it's
load-bearing. Corrected in Claude memory (`vscode_live_news_debugging_session.md`) this session.

**Actually completed this session (commit `754916f`):**
- Deleted `api/youtube/live.js`, `api/youtube/embed.js` (+ test) — confirmed dead Vercel edge
  routes, nothing in `src/` calls them post-removal. Dropped their `api-route-exceptions.json`
  entries and their generated registrations in `gcp/api/routes.generated.ts` (regenerated via
  `scripts/generate-nitric-routes.mjs`) and `test:sidecar`'s file list.
- Removed the VS Code sidecar's dead `/api/hls-proxy`, `/api/youtube-embed`, `/api/youtube/live`
  route handlers from `local-api-server.mjs` (143 lines) plus matching stale-comment cleanup in
  `sidecarProcess.ts`, `panel.ts`, `vscode-extension/README.md`, and the one now-invalid assertion
  in `local-api-server.test.mjs`.
- Verified independently (not just trusting the doing agent): `tsc --noEmit` clean, sebuf API
  contract lint clean (confirms the exceptions-manifest edit didn't orphan anything), sidecar test
  suite 49/50 (1 failure is a real `EADDRINUSE` from an unrelated sidecar process already running
  on the operator's machine — confirmed via stash A/B, not a regression), biome lint clean on
  touched files (1 pre-existing unrelated warning from an Aug-10 commit, untouched by this diff).

**Still deliberately deferred, now for a real reason (not just "didn't get to it"):**
- `server/worldmonitor/aviation/v1/get-youtube-live-stream-info.ts` + its `.proto` and
  `src/generated/**/aviation/**` code — a genuinely dead sebuf-generated RPC (no frontend caller
  found), discovered this session. Removing it needs `buf`/`sebuf` codegen tooling (`buf` isn't
  installed on this machine — confirmed via `which buf`); hand-editing generated output would
  diverge from what a real regen produces. Low priority (small, harmless, orphaned), pick up only
  if `buf`/`sebuf` tooling is ever set up locally.

**Repo state**: `main` is now **4 commits ahead of `origin/main`** (not pushed — same standing
"hold for explicit go-ahead" discipline; ask before pushing).

**Then the session got redirected a third time** (156-seed-source initiative still not started —
see NEXT INITIATIVE below, unchanged) into live panel-by-panel debugging via the VS Code
extension, operator's own screenshots/devtools/Output-channel logs throughout (same collaborative
method as session 18). Found and fixed 4 real bugs, none of them in the Strategic Posture panel's
own code — all four were sidecar/local-dev-environment plumbing:

1. **`isHealthy()`'s stale-orphan check was too loose** (`sidecarProcess.ts`). It checked
   `resp.status !== 401`, meant to mean "token doesn't match." But an orphan sidecar whose
   `LOCAL_API_TOKEN` was never set at all answers every request with 503 "Service misconfigured"
   — also `!== 401`, so `ensureRunning()`'s self-healing `killStaleOccupant()` never fired and a
   broken orphan could linger forever across reloads, 503ing everything. Fixed: check for exactly
   404 (the one real healthy signature), not merely "not 401."
2. **The sidecar child process never loaded `.env`** (`sidecarProcess.ts`'s `spawn()`) — it only
   inherited `process.env` from however VS Code itself was launched. A terminal-launched VS Code
   (with `.env` already sourced) worked fine; a Dock/Spotlight/Finder launch didn't, so every
   secret-gated route (`wm-session`, `bootstrap`, etc.) failed closed with 503, sidecar-wide, no
   code bug behind any of it. Fixed: added `--env-file-if-exists=.env` to the spawn args — the
   same flag the repo's other local dev processes (`gcp/api/main.ts`) already use.
3. **`local-sync.mjs`'s `SYNC_PREFIXES` mirror whitelist never included `theater-posture:` /
   `theater_posture:`** (two spellings — the live/backup keys use a hyphen, the stale key an
   underscore). Structurally never synced to the local SQLite mirror regardless of credentials —
   this was the actual reason the Strategic Posture panel read empty theaters forever locally.
   Fixed: added both prefixes, ran the sync once live (confirmed 9 real theaters — Iran, Taiwan,
   Baltic, Black Sea, Korea, etc. — now in `local-cache.db`).
4. **A client-side cache-poisoning bug** in `src/services/cached-theater-posture.ts`: both
   `saveToStorage()` and the module-load `breaker.recordSuccess(stored)` priming call wrote/primed
   *unconditionally*, bypassing the same `shouldCache` guard the breaker's own `execute()` already
   respected elsewhere. Once a real empty result got cached (pre-fix-#3), every reload re-primed
   the breaker as "fresh" with zero theaters and skipped the network call entirely for a full
   `cacheTtlMs` window — meaning fix #3 alone wouldn't have been visible without this too. Fixed:
   guarded both call sites on `data.postures.length > 0`, matching the existing predicate.

Also added `/api/military/v1/` to `local-api-server.mjs`'s `cloudPreferredPrefixes` — **harmless
but NOT actually load-bearing for this fix**: the operator's sidecar runs with `cloudFallback:
false` by design (confirmed live in the sidecar's own boot log), so that allowlist never engages
for this setup. Left in since it's still correct/consistent with the 5 existing entries and could
matter for a different `cloudFallback: true` configuration.

**Infrastructure finding, not a code bug — operator already acted on it**: the session's own
Output-channel logs surfaced `ERR max requests limit exceeded. Limit: 500000, Usage: 500000`
repeated across `checkRateLimit`, digest caching, and resilience-ranking's cache-warm job — the
account's Upstash Redis REST quota was fully exhausted, account-wide (same instance backs
production, not just local dev). Not caused by this session (already exhausted before the first
`local-sync` run). **Operator upgraded the Upstash plan mid-session — resolved.**

**Not yet re-verified**: a batch of RSS feed fetches (Guardian, Hill, Euronews, ABC, NBC, PBS, Le
Monde, FT, VentureBeat) failed both direct-fetch and relay-fetch simultaneously in the same
Output-channel log — too broad a spread to be a per-feed issue. Best working theory, unconfirmed:
resource contention from this same Claude Code session running heavy tool calls on the operator's
machine concurrently (the same log window also shows repeated "extension host unresponsive" +
Claude-Code-CPU-usage warnings) — not a product bug. Worth a clean re-check once no heavy agent
work is running alongside the live app, before spending more time on it.

**Genuinely separate, still open**: `WM_SESSION_SECRET` does not exist anywhere in `.env` — the
sidecar's `.env`-loading fix (#2 above) can't produce a value that was never there. `wm-session`
will likely keep 503ing locally until the operator adds it (or confirms local session/login isn't
meant to work at all for the sidecar). Not fabricated a value — that's a security-relevant call
for the operator, not this session.

**Repo state**: this HANDOFF block itself plus all 4 fixes above are the diff about to be
committed this session (on top of the already-committed `1634654`/`754916f`). `main` will be
**5 commits ahead of `origin/main`** after — still not pushed, same standing discipline.

**Next up (STILL not started — now deferred a THIRD time):** the 156-seed-source review, see NEXT
INITIATIVE below, unchanged. Operator wants sources reviewed **in an order they'll specify**, and
still needs to define what "review a source" means (live run / read-only / code audit).

---

## 🔖 HANDOFF (2026-08-17, end of eighteenth session) — read this first, before anything below

**The eighteenth session did NOT start the 156-seed-source initiative** (see that section further
down — still fully accurate, still not started, now deferred to whichever session picks it up next).
Instead the operator redirected mid-session into live collaborative UI testing/debugging via the
real VS Code extension, which led to two separate, unrelated pieces of work:

**1. Cosmetic: footer + "Join the Discord Community" widget removed.** Small, isolated
(`src/app/panel-layout.ts`, `src/app/data-loader.ts`). No follow-up needed.

**2. Live News + Live Webcams panels removed entirely — operator's explicit call** ("bad UX, we
don't need it as our internal tools, easier to just turn on a TV"). This followed real live-debugging
through the VS Code extension that found and fixed 3 genuine bugs in the Live News pipeline first
(sidecar's `/api/youtube/live` always 503ing locally, and the actual root cause — YouTube's
postMessage bridge never completing inside the VS Code webview's nested iframe chain) — full detail
in memory `vscode_live_news_debugging_session.md`. Once those fixes proved the panel *could* work,
the operator decided it wasn't worth keeping anyway and asked for full removal instead.

**Scope of the removal, so the next session doesn't have to rediscover it:** both panel components,
the standalone channel-management popup + its Tauri entry point, 3 dedicated service files, the
"stream quality" and "always keep streams playing" Settings controls, every panel-registry/mission-
preset/command-palette/analytics/freshness/chunk-config reference across ~40 files, and CSS. 7 test
files were updated (not deleted-and-forgotten) to keep their real invariants intact — mission preset
ordering, freshness-source aggregation, CSP file lists, panel chunk-map consistency — verified via
`git stash` A/B against a clean baseline (7 pre-existing unrelated failures before AND after; zero
new regressions). Typecheck, biome lint, and `npm run build` all clean. Full detail, including every
file touched and why, in memory `vscode_live_news_debugging_session.md`.

**Deliberately deferred, not forgotten — flagged for whenever backend cleanup is wanted:**
- Production Vercel routes `api/youtube/live.js`, `api/youtube/embed.js` are now unreachable dead
  code (nothing calls them anymore).
- `api/webcam/v1/[rpc].js` (35,751 lines, sebuf-codegen-generated) plus its generated client/server
  pairs in `src/generated/`. Removing a codegen domain needs the actual generator tooling, not
  hand-edits — didn't attempt this blind.
- VS Code sidecar's now-dead `/api/youtube-embed`, `/api/hls-proxy`, `/api/youtube/live` routes in
  `vscode-extension/sidecar/local-api-server.mjs` — small, self-contained, low-risk, just not done.

**Repo state**: `main` is **2 commits ahead of `origin/main`, 0 behind** (re-verified via
`git fetch` + `git rev-list --left-right --count origin/main...main` this session, don't trust an
older turn's number). **47 files uncommitted** (both pieces of work above, nothing committed or
pushed) — holding for explicit operator go-ahead, same standing discipline as every prior session.

---

## 🔖 HANDOFF (2026-08-15/16, end of seventeenth session) — read this first, before anything below

**Repo state**: `origin/main` was pushed **externally, outside this session** (confirmed via
`git reflog show origin/main` — `update by push` — not this session's doing; this session never ran
`git push`). `origin/main` now sits at `87787be` (the self-hosting-removal commit). `main` is **1
commit ahead of `origin/main`, 0 behind, working tree clean** (`79b2d68`, the `agent.txt` tracking
fix below) — held, not pushed, per explicit operator choice this session (re-verify yourself with
`git status` + `git rev-list --left-right --count origin/main...main`, don't trust this number
blindly). GitHub Actions is **repo-wide disabled** — still true, re-verify via
`gh api repos/powerpro-led/worldmonitor/actions/permissions` before assuming either way.

**Domain-literal/de-branding initiative is CLOSED for this session** (operator: "let's close this
cleanup domain focus task for now"). Summary of the whole session: continuing a "de-brand the
remaining 26 files" ask surfaced that `docker/nginx.conf` was real self-hosting infra, not branding
— operator chose to remove Docker/nginx + npm+Upstash self-hosting entirely (see the ✅ Resolved
entry below `87787be`). A follow-up real-domain test with `APP_DOMAIN=led4signage.com` was tried,
then **explicitly reverted — not the intended domain**, confirm-before-executing worked as intended
here. A proposal to move CSP into dynamic middleware (to eliminate `vercel.json`'s domain literals)
was investigated in real depth — confirmed technically possible via `next()` from `@vercel/functions`
— then **correctly rejected**: it would turn nearly every request into a real Edge Function
invocation instead of a free static header lookup, a permanent per-request cost to avoid a one-time,
rare inconvenience. One real gap found and fixed (`79b2d68`, not pushed): `public/agent.txt` (the
live discovery doc for `api/ask.ts`/`api/a2a.ts`) had a dead link to a deleted agent-skills path and,
despite being as real/load-bearing as the other tracked files, was never added to
`scripts/sync-domain-literals.mjs`'s target list across many sessions — fixed both.

**Still genuinely open on this initiative, unchanged priority, nothing to do until acted on:**

1. Push the 1 held commit — operator's call each time, small and verified.
2. 3 flagged-not-fixed items (2 carried from sixteenth session — `vscode-extension/README.md`
   possibly-superseded build docs, possibly-dead `TAURI_ORIGIN_PATTERNS` — plus 1 new from this
   session: `vscode-extension/sidecar/local-api-server.mjs`'s `mode === 'docker'` branch is now dead
   code, its only feeder deleted this session).
3. **6 files still blocked on a real replacement domain** (`led4signage.com` was NOT it) — see the
   🅿️ READ FIRST section below for the list and the exact procedure. **New finding this session,
   worth remembering if this is ever picked up for real**: the actual migration footprint is bigger
   than "6 files" — every test that reads one of those 6 files' real content directly must move in
   the same commit, or it breaks (correctly, but confusingly). Found 3 more of these this session:
   `tests/widget-builder.test.mjs` (`wm-widget-sandbox.html` origin checks), `tests/variant-meta-
   index-html-drift.test.mts:21` (`index.html` drift guard), and 2 spots in `tests/deploy-
   config.test.mjs` (`.replace('.worldmonitor.app', '')` variant-slug extraction ×2, plus a
   regression-guard regex for `api/mcp/auth.ts`'s `resource_metadata`). None of these were changed —
   the migration itself was reverted — but don't assume "6 tracked files" is the whole checklist next
   time.
4. GitHub Actions re-enable — ask if the "big refactor" justifying it is over.
5. Low priority: `vercel.json`'s CSP is now hand-duplicated across route entries with no nginx
   mirror to sync against anymore (nginx removed this session) — a smaller cleanup than before, not
   required.
6. 2 pre-existing test gaps, confirmed unrelated to this session's work via `git stash` A/B:
   `tests/ci-workflow-coverage.test.mts` (missing `vscode-extension/package-lock.json` in the
   security-audit matrix), `tests/railway-services-registry-coverage.test.mts` (3 `Dockerfile.*`
   workers missing registry entries).

---

## ✅ TESTING SWEEP COMPLETE (**11 of 11 categories, 156 of 156 scripts, as of twenty-fourth session**) — superseded by the FIX MODE handoff at the top of this file; that's the live status

**The testing sweep itself is closed — do not re-run scripts that already came back healthy.**
End-of-session-24, the operator redirected this initiative into fix mode: work the prioritized fix
list in the HANDOFF block at the top of this file until production Upstash Redis is fully
populated, rather than continuing to test already-tested sources. This section below is now purely
historical reference (method, order, full per-category script names). Deferred twice before this
session started it for real: queued for the eighteenth
session (redirected into Live News/Webcams removal — see [[vscode_live_news_debugging_session]]
in memory), queued again for the nineteenth (redirected into VS Code sidecar debugging — see
[[vscode_sidecar_theater_posture_debugging]]). Both blocking questions got resolved at the end of
the nineteenth session, and the twentieth session executed categories 1–4 (58 of 156 scripts) plus
a credential-review round. The twenty-first session executed categories 5 and 6 (48 scripts, 106
of 156 cumulative) — **resume at category 7** (Markets & Finance, 21 scripts), don't
restart from category 1:

- **What "test a source" means**: operator confirmed directly (multiple-choice, nineteenth session)
  — **(a) run it live once, confirm it writes fresh Redis data without error.** Not read-only, not a
  code-only audit.
- **What order to test in**: operator confirmed **grouped by domain/category** (nineteenth session).
  Full grouping below — built from each script's name plus its actual `CANONICAL_KEY`/cache-key
  prefix where the name was ambiguous (spot-checked via grep, not guessed). Treat category
  boundaries as a first pass, not gospel — reassign a script on sight if its real behavior clearly
  belongs elsewhere once you're actually reading it.

**Grounded facts, still accurate:**
- `ls scripts/seed-*.mjs | wc -l` → **156 files**. 17 are `seed-bundle-*.mjs` (aggregate multiple
  sources per script) — testing a bundle exercises all its underlying sources at once, so treat
  bundles as a checkpoint that covers several individual entries below, not a fully separate item.
- `scripts/railway-services.json` has 31 entries wired to `scripts/seed-*` (dedicated
  `Dockerfile.*` or standalone `nixpacks-root-repo` cron services) — the other ~125 run some other
  way, not yet determined per-script.
- No existing local dry-run/test convention (only 2 of 156 mention `--dry-run`/`dryRun`) —
  `scripts/check-seed-freshness.mjs` is a live-production monitor (hits `/api/health?compact=1`),
  not a per-source test harness. "Run it live once, confirm it writes fresh Redis data without
  error" (per the confirmed definition above) means literally executing
  `node --env-file=.env scripts/seed-<name>.mjs` (or whatever its actual invocation is — check each
  script's own header/shebang comment first) and checking it exits clean and the Redis write
  actually landed, not inventing a new dry-run mode that doesn't exist in this codebase.
- The [[vscode_live_news_debugging_session]] "test panels one by one via real VS Code UI rendering"
  method was established for a *different* kind of testing (dashboard panels, not data-source
  scripts) — confirm with the operator whether they want that same live-collaborative style here,
  or a more scripted/batch approach, before assuming it transfers.

### The order (grouped by domain/category, 156 total)

**1. Energy & Fuel (24)** — `bundle-energy-sources`, `co2-monitoring`, `eia-petroleum`,
`electricity-prices`, `ember-electricity`, `energy-crisis-policies`, `energy-disruptions`,
`energy-intelligence`, `energy-spine`, `fossil-electricity-share`, `fuel-prices`, `fuel-shortages`,
`gas-storage-countries`, `gie-gas-storage`, `iea-oil-stocks`, `jodi-gas` (see
[[jodi_seed_source_contracts]] — 2 known URL bugs already fixed, China coverage gate still open),
`jodi-oil` (same), `low-carbon-generation`, `owid-energy-mix`, `pipelines-gas`, `pipelines-oil`,
`power-reliability`, `spr-policies`, `storage-facilities`

**2. Climate & Environment (11)** — `bundle-climate`, `climate-anomalies`, `climate-disasters`,
`climate-news`, `climate-ocean-ice`, `climate-zone-normals`, `weather-alerts`, `fire-detections`,
`natural-events`, `earthquakes`, `radiation-watch`

**3. Health (5)** — `bundle-health`, `disease-outbreaks`, `health-air-quality`, `vpd-tracker`,
`recall-benchmark`

**4. Military, Conflict & Security (18)** — `aviation`, `conflict-intel`, `cyber-threats`,
`defense-patents`, `fatf-listing`, `gdelt-intel`, `hormuz`, `iran-events`, `military-bases`,
`military-cii`, `military-flights`, `military-maritime-news`, `sanctions-pressure`,
`security-advisories`, `submarine-cables`, `thermal-escalation`, `ucdp-events`, `unrest-events`

**5. Supply Chain, Trade & Ports/Chokepoints (13)** — `bundle-portwatch`,
`bundle-portwatch-port-activity`, `portwatch`, `portwatch-chokepoints-ref`, `portwatch-disruptions`,
`portwatch-port-activity`, `chokepoint-baselines`, `chokepoint-flows`, `hs2-chokepoint-exposure`,
`supply-chain-trade`, `global-tenders`, `comtrade-bilateral-hs4`, `trade-flows`

**6. Economic Indicators & Central Banks (35)** — `bis-data`, `bis-extended`, `bis-lbs`,
`bls-series`, `bundle-ecb-eu`, `bundle-imf-extended`, `bundle-macro`, `china-macro`,
`china-release-calendar`, `china-coverage-health`, `consumer-prices`, `ecb-fx-rates`,
`ecb-short-rates`, `economic-calendar`, `economy`, `eurostat-country-data`, `eurostat-gov-debt-q`,
`eurostat-house-prices`, `eurostat-industrial-production`, `fao-food-price-index`, `fsi-eu`,
`fx-rates`, `fx-yoy`, `imf-external`, `imf-growth`, `imf-labor`, `imf-macro`, `national-debt`,
`sovereign-wealth`, `usa-spending`, `wb-external-debt`, `wb-indicators`, `yield-curve-eu`,
`grocery-basket`, `bigmac`

**7. Markets & Finance (21)** — `aaii-sentiment`, `bundle-market-backup`, `commodity-quotes`, `cot`,
`crypto-quotes`, `crypto-sectors`, `earnings-calendar`, `etf-flows`, `fear-greed`,
`gold-cb-reserves`, `gold-etf-flows`, `gulf-quotes`, `hyperliquid-flow`, `market-breadth`,
`market-quotes`, `prediction-markets`, `stablecoin-markets`, `token-panels`, `forecast-bets`,
`forecast-resolutions`, `forecasts`

**8. Resilience & Recovery Scores (12)** — `bundle-resilience`, `bundle-resilience-energy-v2`,
`bundle-resilience-recovery`, `bundle-resilience-validation`, `resilience-scores`,
`resilience-static`, `recovery-external-debt`, `recovery-fiscal-space`, `recovery-fuel-stocks`,
`recovery-import-hhi`, `recovery-reexport-share`, `recovery-reserve-adequacy`

**9. News, Intel & Briefs (7)** — `digest-notifications`, `insights`, `regional-briefs`,
`regional-snapshots`, `regulatory-actions`, `research`, `displacement-summary`

**10. Infrastructure & Misc (7)** — `infra`, `internet-outages`, `service-statuses`, `webcams` (NOT
the removed Live-Webcams-panel — this seeds the still-active Pinned Webcams / `api/webcam`
feature, see [[vscode_live_news_debugging_session]]'s correction), `bundle-regional`,
`bundle-relay-backup`, `bundle-static-ref`

**11. Cross-Cutting / Derived Signals (3)** — `correlation` (aggregates military + escalation +
economic + disaster into one card), `cross-source-signals` (feeds the CII/military risk score —
see `_cii-risk-cache-keys.mjs`), `bundle-derived-signals`. Test these LAST in the whole run, not
first — they read from the other categories' own output, so testing them before their inputs exist
would just confirm "no data yet," not a real pass/fail.

---

## ✅ Resolved 2026-08-15 (seventeenth session) — Docker/nginx + npm+Upstash self-hosting removed entirely

**Not a de-branding pass — a scope decision.** Operator asked to continue de-branding the remaining
26 `worldmonitor.app` files; investigating `docker/nginx.conf` found it was real self-hosting
infrastructure (two separate self-hosted images: a full Docker Compose stack, and a lighter GHCR
image), not a branding leftover. Surfaced this explicitly (nginx CSP allowlists a real security
boundary, not text) and asked before touching anything. Operator's answer, across two rounds of
clarification: drop self-hosting entirely — both the Docker/nginx path AND `INSTALL_GUIDE.md`'s
separate non-Docker npm+Upstash path — including updating `README.md`'s AGPL license table (the
"Self-hosted instance" row is redundant with "Fork and modify," which already covers the AGPL grant;
removed rather than reworded to avoid overclaiming what the license does/doesn't permit).

**Deleted** (verified each has no other consumer before removing — see investigation notes below):
`docker/` (whole directory: `Dockerfile`, `Dockerfile.redis-rest`, `nginx.conf`,
`nginx-security-headers.conf`, `nginx.conf.template`, `entrypoint.sh`, `docker-entrypoint.sh`,
`supervisord.conf`, `redis-rest-proxy.mjs`, `build-handlers.mjs`, `runtime-package.json` +
`runtime-package-lock.json`, `.dockerignore`), root `Dockerfile` (the nginx+Node-API-under-
supervisord self-host image), `docker-compose.yml`, `.github/workflows/docker-publish.yml` (GHCR
publish), `SELF_HOSTING.md`, `INSTALL_GUIDE.md`, `scripts/run-seeders.sh` (only ever referenced from
`SELF_HOSTING.md`), `deploy/nginx/brotli-api-proxy.conf` (an unreferenced example reverse-proxy
config, found during the directory-structure sweep — 0 consumers anywhere in the repo), plus 2 test
files that existed solely to test the deleted surface (`tests/docker-compose-no-default-secrets
.test.mts` — regression coverage for issue #3804, entirely about `docker-compose.yml`; `tests/
redis-rest-proxy-url-masking.test.mjs` — tested `docker/redis-rest-proxy.mjs`'s `maskRedisUrl`
directly).

**One real discovery while investigating, not caused by this removal**: root `Dockerfile` COPY'd
`/app/src-tauri/sidecar/local-api-server.mjs`, but `src-tauri/` was already deleted in an earlier
session's Tauri-desktop-app retirement — **the self-hosted Docker image could no longer build at
all**, independent of this session's decision. Confirms the removal wasn't just a preference call.

**Edited, not deleted** (trimmed the self-host-specific slice, kept everything else):

- `tests/deploy-config.test.mjs` — removed every nginx/Docker CSP-parity test and helper
  (`getNginxHeaderValue*`, the `docker runtime dependency guardrails` and both `self-hosted docker
  nginx` describe blocks, the Docker loop in the corpus-generator test, the Docker-build-context
  `.dockerignore` test). Kept every Vercel-only assertion, simplified multi-surface loops
  (`vercel` + `docker/nginx`) down to `vercel` alone rather than deleting the underlying check.
- `tests/docker-sidecar-auth-config.test.mjs` → renamed `tests/relay-dockerfile-healthcheck.test.mjs`
  — 3 of its 4 tests covered deleted self-host files; the 4th (`Dockerfile.relay` healthcheck, a real
  kept production Railway service) survived, so the file was renamed rather than deleted to stop
  claiming to test "sidecar auth config" it no longer contains.
- `tests/market-quote-refresh.test.mjs` — dropped the `docker-compose.yml` env-var-wiring assertion,
  kept the relay/standalone/`.env.example` assertions.
- `tests/security-audit-baseline.test.mjs` + `.github/scripts/audit-production-dependencies.mjs` +
  `.github/workflows/security-audit.yml` — removed the `docker/runtime-package-lock.json` entry from
  the security-audit baseline map and the `docker-runtime` matrix job (the lockfile it audited no
  longer exists).
- `scripts/sync-domain-literals.mjs` + `scripts/sync-csp-script-hashes.mjs` — both had
  `docker/nginx-security-headers.conf` / `docker/nginx.conf` in their target-file lists; left
  in place they'd throw ENOENT on the next run. Trimmed to the files that still exist.
- `README.md` — removed the "Self-hosted instance" license-table row; simplified the
  ARCHITECTURE.md deployment-options cross-link (was "Vercel, Docker, static").
- `ARCHITECTURE.md` — removed the "Container Image | GHCR" deployment-topology row, `docker/
  Dockerfile` from the topology source-files list, the `docker-publish.yml` workflow-table row, and
  the `docker/` + `deploy/` directory-structure entries.
- `scripts/generated/stats.json` — regenerated via `npm run docs:stats` (auto-generated, not
  hand-edited) to drop the removed `docker-publish.yml` workflow from its cached list.

**Deliberately left alone** (comments citing the deleted self-host proxy as historical rationale for
real, still-live production behavior — same "don't rewrite true history for zero functional gain"
reasoning as CHANGELOG.md / Sentry incident IDs elsewhere in this file): `server/_shared/redis.ts`,
`api/_rate-limit.test.mjs`, `tests/redis-caching.test.mjs`, `tests/rate-limit.test.mts`, `tests/
relay-auth.test.mjs`. Also left alone: every unrelated "self-hosted X" mention that isn't about
*this* app being self-hosted (self-hosted fonts, self-hosted PMTiles/basemap tiles, the self-hosted
Umami analytics collector at `abacus.worldmonitor.app`, self-hosted MCP server config field) — traced
each one individually before excluding it, not pattern-matched away.

**Verified**: `tsc --noEmit` clean; `npm run docs:check` clean (23 doc claims match code);
`npm run sync:domain-literals:check` clean transition (8 blocked files → 6, all still correctly
domain-blocked); `npm run sync:csp-hashes:check` clean (1 file now, was 3); `markdownlint-cli2` on
`README.md`/`ARCHITECTURE.md` clean (pre-existing unrelated `TASKS.md` lint errors, not touched);
full `npm run test:data` (13,792 tests) — same 7 pre-existing failing suites as the unmodified
baseline (confirmed via `git stash` A/B on the ones not already known-pre-existing from earlier
sessions), zero new failures. One stray unrelated `src/main.ts` quote-style reformat surfaced by a
mid-investigation `git stash`/`git stash pop` cycle was caught and reverted before it could get
swept into this diff — not part of this change. Committed, not pushed (see 🔖 HANDOFF above).

---

## ✅ Resolved 2026-08-15 (sixteenth session, fifth pass) — wrong GitHub org (koala73 → powerpro-led)

**Separate bug from the domain-literal initiative below, found as a side effect of reading README.md
in full while investigating it.** This repo's real origin is `github.com/powerpro-led/worldmonitor`
(verified via `git remote -v`) — 18 files across both READMEs plus `INSTALL_GUIDE.md`,
`SELF_HOSTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`,
`.github/ISSUE_TEMPLATE/config.yml`, `.github/workflows/docker-publish.yml`, and `index.html`
hardcoded the wrong org `koala73/worldmonitor` instead — including `git clone` commands in 3 files
that would clone the wrong repository, and `SECURITY.md`'s private-vulnerability-reporting link
pointing at the wrong repo's advisories page. Fixed all of them (2 commits: `c98f986` for the
READMEs, `a4a427d` for the rest). Also removed while there: the README/`index.html` badges and
JSON-LD `sameAs` entries advertising the retired `npm i worldmonitor` CLI package (retired in
`30c89d7`, same as the desktop app) and the `smithery.ai`/`skills.sh` external registry badges (same
"belongs to upstream, not this fork" reasoning the MCP registry entry was removed for in an earlier
session); `.github/ISSUE_TEMPLATE/config.yml`'s dead `docs/DOCUMENTATION.md` link (docs/ deleted) and
its Discussions contact link (confirmed via `gh api repos/powerpro-led/worldmonitor` that GitHub
Discussions is disabled on this repo — would 404 regardless of org); `docker-publish.yml`'s
`ghcr.io/koala73/worldmonitor` image path (confirmed via `gh api .../actions/permissions` that
Actions are repo-wide disabled, so dormant today, but wrong regardless).

**Deliberately left alone — a different, correct use of the same string**: `github.com/koala73`
*bare* (no `/worldmonitor`) is Elie Habib's real personal GitHub profile (confirmed via
`index.html`'s own structured-data `founder.sameAs` and `panel-layout.ts`'s credit link, both
correctly distinct from the repo link) — untouched everywhere. Also left alone: historical GitHub
issue-number citations (`koala73/worldmonitor#3800` etc. in `acled-auth.ts`,
`list-company-signals.ts`, `get-company-enrichment.ts`, `cached-risk-scores.test.mts`,
`seed-bis-extended.mjs`, `e2e/giving-provenance.spec.ts`, `scripts/shared/giving-published-estimate-
claims.json`) — these cite real issues filed on the original pre-fork repo before it had its own
numbering; renumbering the org would point at a different, likely-nonexistent issue on this fork, so
these are accurate history, not bugs (same reasoning as not rewriting `CHANGELOG.md`). One
`.proto` file's `go_package` option pointing at `github.com/koala73/...` also left alone — no
evidence anything in this TS/JS-only stack actually consumes Go codegen from it; flagged, not
verified, worth a closer look if anyone ever touches Go tooling here.

Editing `index.html`'s inline JSON-LD scripts changed their CSP `script-src` hash (the same gotcha
documented in an earlier session for a different `index.html` edit) — caught proactively this time
by running `npm run sync:csp-hashes` immediately after, not by a failing test.

Verified: `docs:check` clean, `markdownlint-cli2` on all touched `.md` files (0 errors), YAML
validity on both touched YAML files, `tsx --test` on the 3 suites touching `index.html`'s CSP hash
and GitHub-org content (`crawlable-corpus`/`deploy-config` clean, `edge-functions`'s 34 "no node:
built-ins" failures confirmed byte-identical via `git stash` A/B against clean HEAD — pre-existing,
unrelated). Committed, **not pushed** — holding per operator request ("push later").

---

## 🆕 2 items flagged during the sixth de-branding pass — NOT fixed, need a dedicated look

**Found while de-branding `vscode-extension/README.md` and `ARCHITECTURE.md` — real, but outside
that pass's safe-mechanical-edit scope, so deliberately left alone rather than guessed at:**

1. **`vscode-extension/README.md` may describe a superseded, pre-live-verification design.** It
   tells contributors to build with `VITE_DESKTOP_RUNTIME=1 npm run build:desktop` — but
   `build:desktop` doesn't exist anymore (removed in the Tauri retirement, `30c89d7`), AND per the
   `local_pipeline_and_vscode_dagu_plan` Claude memory (a *later*, live-verified session), that
   exact `VITE_DESKTOP_RUNTIME=1` flag was found to create a "Tauri IPC bridge gap / silent
   live-cloud-fallback leak" — the memory's own live-tested, correct build is plain `npm run
   build`/`build:full` **without** that flag. This README's whole architecture description (SQLite
   local-sync mirror, `LOCAL_API_MODE=tauri-sidecar`) may predate that later, more authoritative
   session entirely (MEMORY.md describes the final working state as "the sidecar serving `dist/`
   directly, no cache" — a different design). Needs someone to actually reconcile this doc against
   `local_pipeline_and_vscode_dagu_plan.md` and the real current sidecar code, not a text edit.
2. **`shared/domain-config.js`'s `TAURI_ORIGIN_PATTERNS` is still spliced into the live CORS
   allowlist** (`buildAllowedOriginPatterns`) even though the Tauri app itself is fully deleted —
   possibly dead code now, not verified either way (the VS Code webview might use a similar scheme,
   or might not). Worth a real look before touching, since it's CORS/security-relevant.

---

## 🅿️ READ FIRST if picking up "remove hardcoded worldmonitor.app strings" — sixteenth-session update (6 passes)

**Sixteenth session (2026-08-15) re-verified this cold against a raw `grep -rli worldmonitor\.app`
(55 files, 384 hits — matches what a plain editor search shows) after the operator flagged it as
"still many hardcoded strings."** Confirmed `npm run sync:domain-literals:check` still reports
exactly the same tracked files as the fifteenth session, and hand-categorized the other ~47 files:
they're comments/docs/READMEs describing the still-real, still-live `worldmonitor.app` deployment,
or test fixtures pinned to the currently-configured real domain — not overlooked hardcodes. **One
real gap found and closed (tracking only):** `public/.well-known/security.txt` hardcodes a live
contact email + canonical URL — same "needs a real mailbox on the new domain" category as
`shared/hapi-app-identifier.json` below — but was never in this list or in
`scripts/sync-domain-literals.mjs`'s target list. Added below as an 8th tracked file. **Also fixed
this session, no domain decision needed:** that same file's two GitHub security-advisory links
pointed at `github.com/eliehabib/worldmonitor` — a third variant of the recurring wrong-GitHub-org
mismatch (see the `koala73/worldmonitor` fix in `domain_migration_scope.md`) — corrected to the real
origin `github.com/powerpro-led/worldmonitor`.

**Second pass, same session, operator asked to "reduce hardcoding" in the ~47 non-blocked files —
found 2 real runtime hardcodes (not just prose) and fixed both, no domain decision needed:**
`scripts/seed-digest-notifications.mjs` had 3 domain literals actually shipped in production email
content (the `RESEND_FROM_BRIEF`-unset fallback sender address, the plain-text digest's dashboard
footer line, and 2 URLs in the HTML template's logo image + "Open Dashboard"/domain footer links) —
all now derive from `./_domain-config.mjs` (`resolveAppOrigin`/`resolveWwwOrigin`/`normalizeDomain`),
reusing that file's existing import rather than adding a duplicate one from `../shared/domain-config.js`
(caught a `SyntaxError: already declared` on the first attempt — this file already imported
`resolveAppOrigin` from the generated `scripts/_domain-config.mjs` copy for an unrelated feature).
`scripts/seed-regulatory-actions.mjs`'s `SEC_USER_AGENT` (sent as a real header to SEC EDGAR) had its
own separately-hardcoded copy of the contact email instead of reading `shared/hapi-app-identifier.json`
via `loadSharedConfig`, the pattern `scripts/seed-conflict-intel.mjs` already established — switched
it to that, so the two can't drift. Fixing this broke `tests/regulatory-seed-unit.test.mjs` (it
`vm.runInContext`-evaluates the seeder's source with a hand-curated stub global list that didn't
include the newly-needed `loadSharedConfig`) — fixed by adding a faithful stub to that test's context
(reads the real `shared/` JSON, not a fake value). Verified: `node --test` on all digest/regulatory/
Dockerfile-import-closure suites (114 tests) + `sync:domain-config:check` + `sync:domain-literals:check`
all pass/clean. The remaining ~45 files in the original 55-file list were re-confirmed as prose/docs/
test fixtures with no functional coupling to the domain (traced the actual logic under test in each
category, not just grepped) — not further touched.

All of the above committed (`7ac325d`), plus a third small commit (`49bb2a1`, a stale comment in
`Dockerfile.digest-notifications` describing the now-fixed `seed-digest-notifications.mjs` default —
no behavior change) — pushing held per operator request ("push later").

**Third pass, same session — operator asked to "continue" the cleanup again.** Did a deeper re-check
of every one of the ~44 still-remaining files (not a re-grep — traced the actual runtime path for
each, e.g. read `api/latest-brief.ts`'s `publicBaseUrl()` fallback, `oauth-authorization-server.ts`'s
per-request metadata construction) specifically hunting for a repeat of the seed-digest-notifications
pattern (real logic hiding behind a wall of comments). **Found nothing else** — every remaining
occurrence is either inert prose (docs/READMEs/comments truthfully describing the still-real,
still-live `worldmonitor.app` deployment) or a test-fixture URL string the code under test never
actually compares against `APP_DOMAIN` (verified by reading the assertions, not assuming). **This
initiative has no more mechanical/code work left**: what remains is either (a) the 8 files blocked on
an operator-supplied real domain, or (b) rewriting true, accurate prose in docs/READMEs to be less
specific about the current deployment — a content decision, not a bug fix, not done without asking.

**Fourth pass, same session — operator said "no real domain yet, reduce hardcode as much as we can."**
Converted 3 files whose literal was genuinely just inert test-fixture text (`api/_api-key.test.mjs`,
`api/_rate-limit.test.mjs`, `api/security/report.test.mjs`) to the existing `TEST_APP_DOMAIN`
convention (`tests/helpers/domain-config.mjs`, already used by 24+ other test files) — verified via
`node --test` (55 tests, all pass) that none of these actually compared against `APP_DOMAIN`, so this
was pure consistency cleanup, not a bug fix. **Investigated `tests/sentry-beforesend.test.mjs` in
real depth first** (10 remaining literal occurrences, the largest holdout) before deciding to leave
it alone — worth recording why, since a shallower look would have gotten this wrong: the file
reconstructs the real `beforeSend` from `src/bootstrap/sentry-init.ts` and DOES parameterize it by
`APP_DOMAIN`/abacus-hostname (2 of its own fixtures already correctly use `TEST_ABACUS_HOSTNAME` for
that reason) — but the specific literal-`worldmonitor.app` fixtures left are message strings for
tests exercising `THIRD_PARTY_FETCH_HOST_ALLOWLIST.has(host)` (an exact-match Set against ~3 fixed
third-party hosts, `api.`/`pmtiles.` deliberately excluded by design) or the generic
`hasFirstParty`/extension-frame stack heuristics — neither cares what the hostname string actually
is, only stack shape. Traced every one of the 10 occurrences individually against the real filter
logic before concluding this. Also, several of that file's `describe`/comment titles reference real
Sentry incident IDs (`WORLDMONITOR-WH/WJ`, `WORLDMONITOR-P5`, `WORLDMONITOR-RP`) tied to the real
domain — rewriting those would reduce their value as incident documentation for zero functional gain,
same reasoning as not rewriting `CHANGELOG.md`. Left untouched, on purpose, not an oversight.

**What is left after 4 passes, for real this time:** the 8 parked files (need a real domain), 2 "live"
integration tests that intentionally hit real production (`tests/cors-preflight-live.test.mjs`,
`tests/live-api-cache-auth-regression.test.mjs`), 2 tests deliberately pinned to the real
currently-configured domain (`tests/widget-builder.test.mjs`/`tests/deploy-config.test.mjs`'s
"deliberately not migrated" assertions against the real parked files, `tests/variant-meta-index-html-
drift.test.mts`'s real-build drift check), `tests/sentry-beforesend.test.mjs`'s incident-referencing
labels (see above), `data/resilience-snapshots/*.json` (historical data provenance, never touch), and
plain prose (docs/READMEs/comments truthfully describing the still-live deployment). None of this is
mechanical/code work anymore.

**Sixth pass (2026-08-15, same session), operator said "de-brand all of them, none question" after
seeing a fresh 49-file/313-hit editor search.** The "nothing mechanical left" conclusion above turned
out wrong — a closer per-occurrence read (not a re-grep) found ~23 more genuinely-inert comment/docstring/
example mentions across `.env.example`, `CONTRIBUTING.md` (2 more dead docs/* links, same bug as the
READMEs), `.github/{bug_report.yml,pull_request_template.md}` (also dropped stale "Desktop app
(Tauri)" options — that product's retired, replaced with "VS Code extension"), and ~15 pure-comment
files across `api/`/`server/`/`scripts/`/`vite.config.ts`/`docker/Dockerfile`/`vscode-extension/` —
softened to describe the mechanism generically instead of the literal brand, zero behavior change.
Also removed `.env.example`'s entirely dead `SITE_URL` var (referenced deleted `convex/payments/
checkout.ts`; confirmed nothing reads it). File count: 49 → 26, all 26 individually re-confirmed
correct-to-remain (parked files, historical incident citations with real measured data, live
integration tests, tests deliberately pinned to real config, the sync tool's own required constant).
2 new items found and deliberately NOT fixed (need a dedicated look, not a text edit) — see the 🆕
section just above this one. Verified: `tsc --noEmit` clean (root + vscode-extension), sebuf contract
check clean, `docs:check`/`markdownlint` clean, both `sync:*:check` unchanged, 248 tests across every
touched suite pass. Committed (`5b746bc`), not pushed.

**Every `worldmonitor.app` literal that CODE can fix without a real-world decision is fixed,
committed (`3500fe5`, not pushed), and verified — see the ✅ Resolved entry immediately below for
the full writeup.** What's left is **6 files** (updated seventeenth session: `docker/nginx-security-
headers.conf` and `docker/nginx.conf` were on the original 8-file list but no longer exist — the
whole self-hosted Docker/nginx surface was removed, not just unblocked — see this file's newest ✅
Resolved entry, above the sixteenth-session ones), and none of them can be "continued" with more code
work — they're blocked on the operator picking a real replacement domain first. Confirm the current
list before doing anything by running `npm run sync:domain-literals:check` (reports 5 of the 6 —
`security.txt` isn't wired into that tool yet, tracked here by hand) plus a manual check of
`public/.well-known/security.txt`:

- `vercel.json` — CSP `frame-src`/`frame-ancestors`/`form-action` directives and routing config.
- `public/wm-widget-sandbox.html`, `index.html` — static HTML with inline domain references.
- `shared/hapi-app-identifier.json`, `scripts/shared/hapi-app-identifier.json` — contact-email
  identifier (Railway-mirror pair, must stay byte-identical to each other).
- `public/.well-known/security.txt` — contact `mailto:` + `Canonical:` URL; needs a real mailbox on
  the new domain before cutover, same precondition as the hapi-app-identifier pair above.

**Why these specifically can't move without an operator decision**: `scripts/sync-domain-literals.mjs`
is the tool that rewrites the 7 it knows about in one pass, but it does a literal find-and-replace of
the *current* hardcoded domain for a *new* one you supply via `APP_DOMAIN` — there is no "new" domain
to supply yet (and `security.txt` would need adding to its target list whenever that happens). See
the 🅿️ Parked section further down this file (real infra provisioning: new domain name, Vercel
project, Cloudflare zone, live mailbox) for the exact list of what has to happen first, and
`domain_migration_scope.md` (Claude memory) for **two separate documented incidents** where running
this script against a non-real placeholder domain silently corrupted ~46-50 files in ways that
`--check` couldn't detect and a blind `git checkout` couldn't safely undo. **Do not run
`sync-domain-literals` against anything other than a real, operator-confirmed domain.**

If the operator has a real domain to give you, the path is: set `APP_DOMAIN` to it, run
`npm run sync:domain-literals`, hand-fix `security.txt`'s two remaining literals, verify with
`npm run sync:domain-literals:check` (should report clean) plus a manual re-grep of `security.txt`,
then run the full verification bar from the ✅ Resolved entry below before committing. If they don't
have one yet, there's nothing left to do on this initiative except ask.

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

## ✅ Resolved — scope-down to VS Code dashboard + data pipeline only

**Bookkeeping fix, sixteenth session: this section's every checkbox below was already checked and
verified (src-tauri/, cli/, workers/api-cors-preflight/ all confirmed actually deleted on disk;
GitHub Actions confirmed disabled via `gh api`) but the heading was never flipped from 🚧 to ✅ —
fixed. No content below changed.**

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
5. ~~Whether the Tauri desktop app's bundle identifier changes~~ — **MOOT as of the thirteenth
   session (`30c89d7`): the Tauri app (`src-tauri/`) was retired entirely**, along with the
   `TAURI_BUNDLE_ID_BRAND` mechanism this item used to point at. Nothing left to decide here.
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
