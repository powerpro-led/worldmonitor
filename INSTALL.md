# Installing WorldMonitor Local

This is the **download-and-install** path: a release bundle carries the built
dashboard, the standalone backend, and the VS Code extension. You do **not**
need the monorepo or a build toolchain — just Node and npm.

For the from-source developer setup, see [`vscode-extension/README.md`](vscode-extension/README.md).

## Requirements

- **macOS** (background service = launchd LaunchAgent) or **Windows 10/11**
  (background service = per-user Scheduled Task at logon, no admin rights)
- Node.js **>= 22.5.0** and npm — the backend uses the built-in `node:sqlite`,
  stable since 22.5.0 (`node -v` to check; install from <https://nodejs.org>)
- VS Code (to view the dashboard)
- The Supabase URL + publishable key for the WorldMonitor project. Ask the
  operator.
- For a self-refreshing dashboard: the Upstash Redis REST URL plus **two**
  tokens — the **read-only** token (local cache sync) and the **full** token
  (`/api/health` freshness badges; read-only is not sufficient for that route).
  Both are optional; without them the backend serves whatever is already cached.

## Install — macOS

1. Download `worldmonitor-local-<version>.tar.gz` from the
   [Releases page](https://github.com/powerpro-led/worldmonitor/releases).

2. (Optional) verify it against the published `.sha256`:

   ```sh
   shasum -a 256 -c worldmonitor-local-<version>.tar.gz.sha256
   ```

3. Extract it somewhere permanent (`~/Applications/`, `~/worldmonitor/`, …).
   **The extracted folder is the install location — don't move it afterwards.**

   ```sh
   mkdir -p ~/Applications && tar -xzf worldmonitor-local-<version>.tar.gz -C ~/Applications
   cd ~/Applications/worldmonitor-local-<version>
   ```

4. Run the installer and answer its prompts:

   ```sh
   ./install.sh
   ```

   It runs `npm ci --omit=dev --ignore-scripts`, writes a minimal `.env` (0600)
   from your answers, registers the `com.worldmonitor.local-api` launchd service
   (starts at login, restarts on crash), and installs the `.vsix` if the `code`
   CLI is on your PATH.

5. Sign in (step below, same on both platforms).

## Install — Windows

1. Download `worldmonitor-local-<version>.zip` from the
   [Releases page](https://github.com/powerpro-led/worldmonitor/releases).

2. (Optional) verify it in PowerShell:

   ```powershell
   (Get-FileHash worldmonitor-local-<version>.zip -Algorithm SHA256).Hash.ToLower()
   # compare against worldmonitor-local-<version>.zip.sha256
   ```

3. Extract it somewhere permanent (e.g. `%USERPROFILE%\worldmonitor\`).
   **The extracted folder is the install location — don't move it afterwards.**

4. In PowerShell, from inside the extracted folder:

   ```powershell
   .\install.ps1
   # if PowerShell blocks it:
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

   It runs `npm ci --omit=dev --ignore-scripts`, writes a minimal `.env` from
   your answers, registers the **`WorldMonitorLocal`** Scheduled Task (starts at
   logon, restarts on failure), and installs the `.vsix` if `code` is on PATH.

5. Sign in (below).

## Sign in (both platforms)

```sh
node scripts/worldmonitor-local.mjs login
```

One-time operator setup: the Supabase project must allowlist
`http://127.0.0.1:46124/callback` under **Auth → URL Configuration → Redirect
URLs**. Your GitHub account must be in the allow-listed org (org membership is
the invite).

Then, in VS Code, run **WorldMonitor: Open Local Dashboard** from the command
palette.

## Managing the backend

```sh
node scripts/worldmonitor-local.mjs status      # backend / service / token / identity
node scripts/worldmonitor-local.mjs restart     # kick the service (after an upgrade)
node scripts/worldmonitor-local.mjs logout      # drop the stored session
node scripts/worldmonitor-local.mjs uninstall   # remove the service (keeps ~/.worldmonitor/)
```

The service listens on `127.0.0.1:46123` — REST for the dashboard and
`/api/mcp` for a local MCP agent. Logs: `/tmp/com.worldmonitor.local-api.log`
(macOS) or `%USERPROFILE%\.worldmonitor\local-api.log` (Windows).

## Upgrading

1. Extract the new bundle to a **new** folder next to the old one.
2. `cd` into it and run the installer (`./install.sh` or `.\install.ps1`) — it
   re-points the service at the new folder and reuses your existing
   `~/.worldmonitor/` token and session. Copy your old `.env` over to skip the
   prompts.
3. `node scripts/worldmonitor-local.mjs restart`
4. Once the dashboard looks healthy, delete the old folder.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Dashboard panels stay empty | `status` shows `backend up`? Without Upstash keys nothing refreshes the cache — add them to `.env` and `restart`. |
| `/api/health` 503 `REDIS_DOWN` / freshness badges blank | `UPSTASH_REDIS_REST_TOKEN` (the **full** token, not the read-only one) missing from `.env`. |
| "Brief service unavailable" | You haven't run `login`, or the session expired — run `login` again. |
| Extension iframe blank | Reload the VS Code window; the backend serves `dist/` over HTTP and needs to be up first. |
| `login` fails after GitHub consent | Your account isn't in the allow-listed org, or the `127.0.0.1:46124/callback` redirect URL isn't allowlisted in Supabase. |
| Windows: `status` shows `task  Ready` but `backend DOWN` | The task ran but node exited — check `%USERPROFILE%\.worldmonitor\local-api.log`, then `restart`. |
| Windows: `install.ps1` won't run | `powershell -ExecutionPolicy Bypass -File .\install.ps1` |
