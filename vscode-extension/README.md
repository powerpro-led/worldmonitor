# WorldMonitor Local Dashboard

The real WorldMonitor dashboard — unmodified, same UI, same 166+ panels,
same maps — running inside VS Code, backed only by a locally synced data
cache. No live network dependency for the dashboard's own data domains, no
reinvented UI.

As of the backend split, this extension is a **thin client**. The data layer
is a standalone background service (`worldmonitor-local`), owned by launchd,
shared with any local MCP agent, and independent of whether an editor is
open. The extension only connects to it.

## Architecture

```
  ┌─────────────────────────┐        ┌──────────────────────────────────┐
  │ VS Code extension        │  HTTP  │ worldmonitor-local backend        │
  │ (src/backendClient.ts)   │───────▶│ 127.0.0.1:46123                  │
  │ • health-check           │        │ • /api/*   REST (SQLite mirror)  │
  │ • read loopback token    │        │ • /api/mcp local MCP surface     │
  │ • launchctl kickstart    │        │ • in-process sync listener       │
  └─────────────────────────┘        │ launchd: RunAtLoad + KeepAlive   │
             ▲                        └──────────────────────────────────┘
             │ HTTP (same origin)                     ▲
  ┌──────────┴───────────┐                            │ HTTP + token
  │ dashboard <iframe>    │              ┌─────────────┴─────────────┐
  │ dist/ served by the   │              │ local MCP agent            │
  │ backend over real HTTP │              │ (Claude Code, etc.)        │
  └──────────────────────┘              └───────────────────────────┘
```

- **The backend** is `vscode-extension/sidecar/local-api-server.mjs`, run as
  a plain Node process by a launchd LaunchAgent (`com.worldmonitor.local-api`).
  It serves the app's `/api/*` calls from a local SQLite mirror of the real
  data (`vscode-extension/sidecar/local-cache.db`), never live Upstash
  (`LOCAL_API_MODE=tauri-sidecar`, `LOCAL_API_CLOUD_FALLBACK` unset). It also
  serves `/api/mcp`, the same production MCP handler with a local-only deps
  object.
- **The extension** loads a tiny `<iframe>` wrapper pointed at the backend's
  own HTTP origin (`http://localhost:46123/dashboard.html?embed=vscode`).
  The backend injects a small fetch-shim into that page so the app's `/api/*`
  calls carry the loopback token.
- **Auth** is two independent things: a per-machine **loopback token**
  (`~/.worldmonitor/local-api-token`, guards the port) and the **operator
  identity** (`~/.worldmonitor/session.json`, a GitHub→Supabase session that
  scopes the per-user `brief:` mirror). The `worldmonitor-local` CLI owns
  both. Once you've run `worldmonitor-local login`, the backend serves that
  session from the loopback-token-gated `/api/operator-session` and the
  dashboard iframe adopts it on load — no second in-page sign-in. The
  iframe's own GitHub button stays as the fallback for a machine that hasn't
  run `login`.

## First run

Run from the **repo root**:

```sh
# 1. Build the real app (produces dist/, incl. dist/dashboard.html — the page
#    the extension iframe loads; a VITE_DESKTOP_RUNTIME=1 build does NOT emit
#    it, and the embed path resolves its API base at runtime anyway, so a
#    plain build is what's wanted here)
npm run build

# 2. Install the background backend (writes the loopback token, installs the
#    LaunchAgent, starts it at login and on crash)
node scripts/worldmonitor-local.mjs install
#    …or, if you `npm link` / install globally:  worldmonitor-local install

# 3. Sign in (GitHub → Supabase; invite = membership in the allow-listed org)
worldmonitor-local login

# 4. In VS Code: click the "WorldMonitor" status-bar item, or run
#    "WorldMonitor: Open Local Dashboard" from the Command Palette.
```

Steps 2 and 3 are independent and order-free. Without `login` the backend
still runs and serves cached data — user-scoped routes (your Latest Brief)
just 401 until you do.

`worldmonitor-local status` shows the whole picture at a glance:

```
backend    up   127.0.0.1:46123  (mode tauri-sidecar)
launchd    running  (com.worldmonitor.local-api)
token      set   fp 1a2b3c4d5e6f   /Users/you/.worldmonitor/local-api-token
identity   you@example.com  (expires in 47h)
mcp        http://127.0.0.1:46123/api/mcp   header  x-worldmonitor-local-token: <worldmonitor-local token>
```

### One-time operator setup

`worldmonitor-local login` uses a loopback OAuth redirect. Add
`http://127.0.0.1:46124/callback` to the Supabase project's **Auth → URL
Configuration → Redirect URLs** once, so the flow's callback is accepted.
The invite gate itself is the existing `worldmonitor-org-gate` Auth Hook —
to invite someone, add their GitHub account to the allow-listed org.

## The `worldmonitor-local` CLI

| Command | What it does |
|---|---|
| `install [--token <hex>] [--port <n>] [--dry-run]` | Generate the loopback token, write + bootstrap the LaunchAgent. `--dry-run` writes the files and skips `launchctl`. |
| `uninstall` | Remove the LaunchAgent + plist. Leaves `~/.worldmonitor/` intact. |
| `run [--token <hex>] [--port <n>]` | Run the backend in the foreground (no launchd) — for debugging. |
| `restart` | `launchctl kickstart -k` the installed service. |
| `login [--callback-port <n>]` | GitHub → Supabase session → `~/.worldmonitor/session.json` (0600). |
| `logout` | Revoke server-side + delete the stored session. |
| `whoami` | Print the logged-in identity. |
| `status` | Backend / launchd / token / identity at a glance. |
| `token [--fingerprint]` | Print the loopback token (for an MCP client's header). |

macOS only (launchd). The separate `com.worldmonitor.local-sync` LaunchAgent
(`scripts/install-local-sync-agent.sh`) is complementary: when the backend
is up its in-process listener keeps the mirror fresh; the sync agent is the
backstop for when the backend is down.

## Using the backend from an MCP client

Point any MCP client at the backend's local endpoint:

```jsonc
{
  "mcpServers": {
    "worldmonitor-local": {
      "url": "http://127.0.0.1:46123/api/mcp",
      "headers": { "x-worldmonitor-local-token": "<paste `worldmonitor-local token`>" }
    }
  }
}
```

No Convex, no Upstash ratelimit, no Pro quota — it's the real
`api/mcp/handler.ts` with a local-only deps object.

## Domains covered

`local-sync.mjs` mirrors 11 verified-real, display-worthy Redis prefixes
(resilience, intelligence, energy, supply_chain, market, economic, climate,
portwatch, risk, rss, forecast) — chosen by live-sampling the actual Upstash
store, not guessed. Everything else in the real app's UI still renders (it's
the same UI), but panels outside these domains show empty/loading state
rather than fabricated data, since their backing keys aren't in the mirror.
`vscode-extension/sidecar/local-sync.mjs`'s header comment has the full list
and the reasoning for what's excluded.

## What "local cached, not network fetch" does and doesn't cover

The backend structurally never calls the live API/Upstash for this
dashboard's data — enforced by construction (`LOCAL_API_CLOUD_FALLBACK`
unset ⇒ the cloud-fallback code path never activates), not by convention. It
does **not** mean the whole page never touches a network: the real app's map
layer streams tile imagery from a separate CDN (the deployed `maps.`
subdomain / Cloudflare R2), and that dependency exists in the real product
regardless of this extension.

## Development

```sh
cd vscode-extension
npm install
npm run watch       # esbuild --watch
npm run typecheck
```

Press F5 in this folder to launch an Extension Development Host. Package with
`npm run package` (produces a `.vsix` via `@vscode/vsce`). The `.vsix` no
longer bundles `sidecar/` — the backend ships and runs via
`worldmonitor-local`, not inside the extension.

## Verified

- `worldmonitor-local run` live end-to-end: backend launched with **no
  `LOCAL_API_TOKEN` in its environment** reads the token from
  `~/.worldmonitor/local-api-token`, gates every route on it (200 health /
  404 good token / 401 bad token), and the `?embed=vscode` shim carries it
  into the iframe. In-process sync listener starts in `tauri-sidecar` mode.
- `scripts/worldmonitor-local.test.mjs` — token generation + permissions,
  token-free plist, idempotency, `status`/`token`/`whoami` exit codes.
- Extension: `tsc --noEmit` clean, esbuild bundle succeeds, `sidecarProcess.ts`
  removed (replaced by `src/backendClient.ts`).
- Sidecar server suite (`npm run test:sidecar`): the one pre-existing failure
  (`service-status … EADDRINUSE`) is an environmental port conflict with a
  running backend, confirmed via `git stash` to predate this change.

## Still open

- The actual VS Code Extension Development Host (F5) webview layer is
  unverified in a GUI — open the real dashboard, check DevTools' Network tab
  for failed asset loads, confirm synced-domain panels render, and exercise
  the "Start backend" notification path when the LaunchAgent is stopped.
- The dashboard iframe still runs its own in-page GitHub sign-in
  (`panel.ts` → `auth-provider.ts`). Unifying it with `worldmonitor-local
  login` (backend hands the session to the iframe) is a follow-up.
