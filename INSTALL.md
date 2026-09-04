# Installing WorldMonitor Local

The **standalone backend** (data layer + REST + local MCP) that the VS Code
dashboard extension talks to on `127.0.0.1:46123`. One command installs it,
including its own private copy of Node — you do **not** need the monorepo, a
build toolchain, or a system Node.

For the from-source developer setup, see [`vscode-extension/README.md`](vscode-extension/README.md).

## One-command install

**macOS / Linux**

```sh
curl -fsSL https://github.com/powerpro-led/worldmonitor/releases/latest/download/install | sh
```

**Windows** (PowerShell)

```powershell
irm https://github.com/powerpro-led/worldmonitor/releases/latest/download/install.ps1 | iex
```

That script:

1. fetches a pinned Node build from nodejs.org into `~/.worldmonitor/runtime/`,
   verified against the official `SHASUMS256.txt`;
2. downloads + checksum-verifies the release bundle into `~/.worldmonitor/app/`
   (an existing `.env` is kept across upgrades);
3. installs the ~40 backend npm packages, writes `.env`, seeds
   `~/.worldmonitor/config.db`, registers the background service
   (launchd `LaunchAgent` on macOS · per-user Scheduled Task on Windows, no
   admin rights), and installs the `.vsix` if the `code` CLI is on `PATH`;
4. drops a **WorldMonitor** launcher on your Desktop that opens the control
   panel.

### Options

```sh
curl -fsSL …/install | sh -s -- --config /path/to/org.env      # pre-seed org config
curl -fsSL …/install | sh -s -- --app-version 2.13.0            # pin a specific release
```

`--config <org.env>` takes a `KEY=value` file with at least `VITE_SUPABASE_URL`
and `VITE_SUPABASE_PUBLISHABLE_KEY` (both public), plus optionally the Upstash
REST URL and **read-only** token for a self-refreshing cache. See
[`org.env.example`](scripts/release/org.env.example). Without it — and without a
browser to use the control panel — the manual path below prompts for the two
Supabase values.

**Offline / air-gapped:** point `WM_NODE_TARBALL` / `WM_APP_TARBALL`
(`WM_APP_ZIP` on Windows) at local files and nothing is downloaded.

## First run — configure & sign in

Open the control panel at **`http://127.0.0.1:46123/settings.html`** (or
double-click the Desktop launcher), go to the **Backend** section:

- paste the Supabase URL + publishable key (skip if an `org.env` pre-seeded
  them), add the OpenRouter key for AI summary panels and the Upstash
  read-only URL/token for a self-refreshing cache — **Save** restarts the
  backend for you;
- click **Sign in with GitHub** for your personalised Latest Brief.

A fresh install with no Supabase configured redirects the dashboard here on
first open.

**Headless / no browser:** sign in from the terminal instead —

```sh
node ~/.worldmonitor/app/scripts/worldmonitor-local.mjs login
```

One-time operator setup: the Supabase project must allowlist
`http://127.0.0.1:46124/callback` under **Auth → URL Configuration → Redirect
URLs**. Your GitHub account must be in the allow-listed org (org membership is
the invite).

Then, in VS Code, run **WorldMonitor: Open Local Dashboard**.

## Managing the backend

```sh
cd ~/.worldmonitor/app
node scripts/worldmonitor-local.mjs status      # backend / runtime / service / token / identity
node scripts/worldmonitor-local.mjs restart     # kick the service (after an upgrade)
node scripts/worldmonitor-local.mjs config list # stored config (~/.worldmonitor/config.db)
node scripts/worldmonitor-local.mjs logout      # drop the stored session
node scripts/worldmonitor-local.mjs uninstall   # remove the service (keeps ~/.worldmonitor/)
```

`.env` (in `~/.worldmonitor/app/`) stays authoritative — the service loads it
with `node --env-file`; `config.db` holds the same allow-listed values in a
store the control panel can edit. After changing either, `restart`.

The service listens on `127.0.0.1:46123` — REST for the dashboard, the control
panel at `/settings.html`, and `/api/mcp` for a local MCP agent. Logs:
`/tmp/com.worldmonitor.local-api.log` (macOS) or
`%USERPROFILE%\.worldmonitor\local-api.log` (Windows).

## Upgrading

Re-run the one-command installer. It re-fetches the bundle into
`~/.worldmonitor/app/`, keeps your `.env`, re-points the service, and skips the
Node download if the pinned version is already in `~/.worldmonitor/runtime/`.
Then `node ~/.worldmonitor/app/scripts/worldmonitor-local.mjs restart`.

## Manual / offline install (no bootstrap)

Download `worldmonitor-local-<version>.tar.gz` (or `.zip`) from the
[Releases page](https://github.com/powerpro-led/worldmonitor/releases), verify
it against the published `.sha256`, extract it somewhere permanent, then from
inside the extracted folder:

```sh
./setup.sh                       # macOS/Linux   (or: ./setup.sh --config /path/to/org.env)
.\setup.ps1                      # Windows
```

This needs a system Node **≥ 22.5.0** on `PATH` (it uses
`~/.worldmonitor/runtime/` if the bootstrap put one there, otherwise system
Node). It does everything the bootstrap's step 3 does. Set `WM_SKIP_SERVICE=1`
to install deps + `.env` only and wire your own supervisor.

See [`SECURITY.md`](scripts/release/SECURITY.md) for what lands in `.env` and
why it's safe.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Dashboard panels stay empty | `status` shows `backend up`? Without the Upstash URL + read-only token nothing refreshes the cache — set them in the control panel and it restarts for you. |
| Freshness badges say "unknown" | Expected until the cache has synced once. `/api/health` is computed locally and never needs a Redis write credential. |
| "Brief service unavailable" | You haven't signed in, or the session expired — sign in again (control panel or `login`). |
| Extension iframe blank | Reload the VS Code window; the backend serves `dist/` over HTTP and must be up first. |
| `login` fails after GitHub consent | Your account isn't in the allow-listed org, or `127.0.0.1:46124/callback` isn't allowlisted in Supabase. |
| Windows: `status` shows `task Ready` but `backend DOWN` | The task ran but node exited — check `%USERPROFILE%\.worldmonitor\local-api.log`, then `restart`. |
| Bootstrap can't reach nodejs.org / GitHub | Use the offline vars (`WM_NODE_TARBALL` / `WM_APP_TARBALL`) or the manual `setup.sh` path. |
