# WorldMonitor Local Dashboard

The real WorldMonitor dashboard — unmodified, same UI, same 166+ panels,
same maps — running inside VS Code, backed only by a locally synced data
cache. No live network dependency for the dashboard's own data domains, no
reinvented UI.

## How it works

1. **The real app is built once** (`VITE_DESKTOP_RUNTIME=1 npm run
   build:desktop` from the repo root) — this produces `dist/`, the exact
   same production bundle the desktop app ships, byte-for-byte.
2. **A local sidecar server** (`vscode-extension/sidecar/local-api-server.mjs`, a
   plain Node script — no Rust/Tauri involved) serves that build's `/api/*`
   calls from a local SQLite mirror of the real data
   (`vscode-extension/sidecar/local-cache.db`), not live Upstash. This extension
   spawns it in `LOCAL_API_MODE=tauri-sidecar` mode and never sets
   `LOCAL_API_CLOUD_FALLBACK=true`, so it structurally never proxies to
   the deployed API domain for the domains this dashboard reads.
3. **The extension loads `dist/index.html` directly into a VS Code
   webview** — the real UI, not a rebuilt subset — with a small
   fetch-rewrite shim (a few lines, not a reimplementation) so the app's
   `/api/*` calls reach the local sidecar instead of resolving against
   nothing under the webview's own origin.

## Prerequisites

Run these from the **repo root**, not this directory:

```sh
# 1. Build the real app in desktop-runtime mode (produces dist/)
VITE_DESKTOP_RUNTIME=1 npm run build:desktop

# 2. Sync real data from Upstash into the local SQLite mirror
#    (needs UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_READONLY_TOKEN in
#    .env.local — see docs/architecture/operator-space.md)
npm run local-sync
```

3. **Set `WORLDMONITOR_VALID_KEYS` in `.env.local`** (an operator-issued
   "enterprise key" — same mechanism the Tauri desktop app uses). Live
   testing surfaced this as a real, separate gate from the sidecar's own
   `LOCAL_API_TOKEN`: `api/_api-key.js`'s app-level entitlement check
   requires a credential on every RPC handler, and neither of its normal
   browser paths are reachable from a VS Code webview (the anonymous-session
   cookie is `HttpOnly`+`SameSite=Lax`, unreadable/unresendable
   cross-origin; the desktop-origin fast path needs an `Origin` header a
   webview can't spoof). The extension reads the first value from
   `WORLDMONITOR_VALID_KEYS` and attaches it automatically — without it,
   RPC endpoints return `{"error":"API key required"}` and the dashboard
   shows empty panels for the synced domains.

Re-run step 2 whenever you want fresher data — the dashboard always
reflects whatever `local-cache.db` last held, not live data. There is no
"sync now" button in the extension itself (matches this project's existing
"no manual sync control in the extension" scope decision).

## Domains covered

`local-sync.mjs` mirrors 11 verified-real, display-worthy Redis prefixes
(resilience, intelligence, energy, supply_chain, market, economic, climate,
portwatch, risk, rss, forecast) — chosen by live-sampling the actual
Upstash store, not guessed. Everything else in the real app's UI still
renders (it's the same UI), but panels outside these domains will show
empty/loading state rather than fabricated data, since their backing keys
aren't in the mirror. `vscode-extension/sidecar/local-sync.mjs`'s header comment
has the full list and the reasoning for what's excluded (internal
bookkeeping keys with zero display value, confirmed by direct inspection).

## What "local cached, not network fetch" does and doesn't cover

The sidecar structurally never calls the live API/Upstash for this
dashboard's data — that's the actual guarantee, and it's enforced by
construction (`LOCAL_API_CLOUD_FALLBACK` unset ⇒ the sidecar's own
cloud-fallback code path never activates), not just by convention. It does
**not** mean the whole page never touches a network: the real app's map
layer streams tile imagery from a separate CDN
(the deployed `maps.` subdomain/Cloudflare R2), and that dependency exists in the
real product regardless of this extension — narrowing the webview's CSP to
block it wouldn't change the underlying app, just make map tiles fail to
load. One additional narrow exception: `/api/youtube/live` always proxies
to the cloud regardless of any fallback flag (YouTube blocks datacenter/
loopback IPs directly) — unrelated to the dashboard's own data domains.

## Usage

Click the **WorldMonitor** status bar item (bottom of the window), or run
**WorldMonitor: Open Local Dashboard** from the Command Palette. First open
starts the local sidecar automatically (shown via a progress notification);
subsequent opens reuse it if already running. Sidecar logs are in the
"WorldMonitor Sidecar" output channel.

## Settings

- `worldmonitorLocal.repoRoot` — absolute path to the worldmonitor repo.
  Defaults to the first open workspace folder; only needed if this
  extension's workspace isn't the repo itself.

## Development

```sh
npm install
npm run watch       # esbuild --watch
npm run typecheck
```

Press F5 in this folder to launch an Extension Development Host. Package
with `npm run package` (produces a `.vsix` via `@vscode/vsce`).

## Verified so far / still open

- `tsc --noEmit` clean (both this extension's config and the main repo's,
  after the `server/_shared/rate-limit.ts` fix below); esbuild bundle
  succeeds.
- `local-sync.mjs` live-run against real Upstash: 1,109/1,109 keys synced
  across all 11 domains, `type` column round-trips correctly
  (string/zset/list all spot-checked).
- **Sidecar verified fully end-to-end, live, standalone** (not just by
  inspection): started `local-api-server.mjs` directly with the same env
  vars this extension sets, hit a real RPC endpoint
  (`/api/resilience/v1/get-resilience-ranking`) and got back real country
  score data — confirmed via the sidecar's own log line
  (`loaded 1109 keys from local mirror`) that it came from
  `sidecar-cache.ts`'s SQLite-mirror path, not live Upstash
  (`cloudFallback=false` in the same log, and no outbound Upstash/cloud
  calls appear anywhere in the process log).
- **Two real gaps found during that live test, not assumed away**:
  1. `local-api-server.mjs`'s global auth gate (`LOCAL_API_TOKEN`) and
     `api/_api-key.js`'s separate app-level entitlement gate
     (`X-WorldMonitor-Key`) both 401'd every request until
     `sidecarProcess.ts`/`panel.ts` were updated to generate/attach them
     — see "Prerequisites" above for the `WORLDMONITOR_VALID_KEYS` half.
  2. `server/_shared/rate-limit.ts` had **zero** `LOCAL_API_MODE` awareness
     (unlike `redis.ts`, which handles `tauri-sidecar` mode throughout) —
     every rate-limited RPC endpoint 503'd with "Rate-limit service
     temporarily unavailable" because it tried to reach Upstash for
     abuse-prevention counters regardless of mode. Fixed at the source
     (`isLocalSidecarMode()` bypass added to `checkRateLimit`/
     `checkEndpointRateLimit`/`checkScopedRateLimit`) rather than routed
     around from the extension — rate limiting protects the shared
     production service from abuse, which doesn't apply to a private
     single-operator local sidecar. Verified no regression: full
     `server/__tests__` suite (240 tests) and the rate-limit-specific
     test files still pass; the one pre-existing failure in
     `tests/rate-limit.test.mts` was confirmed via `git stash` to predate
     this change, not caused by it.
- **Not yet verified**: the actual VS Code Extension Development Host (F5)
  — this was built in an environment with no GUI. The data/auth/network
  path is now proven live via a standalone sidecar run; what's untested is
  the webview layer itself — open the real dashboard and check DevTools'
  Network tab for any failed asset loads (the root-absolute-path rewrite
  in `panel.ts` covers the common case but hasn't been visually confirmed)
  and confirm panels in the synced domains render.
