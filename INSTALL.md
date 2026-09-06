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
4. drops a **WorldMonitor** launcher on your Desktop that opens the local
   dashboard (`http://127.0.0.1:46123/`) in your browser.

### Options

```sh
curl -fsSL …/install | sh -s -- --config /path/to/org.env      # pre-seed org config
curl -fsSL …/install | sh -s -- --app-version 2.13.0            # pin a specific release
```

`--config <org.env>` takes a `KEY=value` file with `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY` (both public) — that is the whole bootstrap.
Everything else (this org's Upstash read-only credential, `APP_DOMAIN`) is
handed to the backend by the `local-config` broker after you sign in. See
[`org.env.example`](scripts/release/org.env.example). Without `--config`, the
installer prompts for the two Supabase values.

**Offline / air-gapped:** point `WM_NODE_TARBALL` / `WM_APP_TARBALL`
(`WM_APP_ZIP` on Windows) at local files and nothing is downloaded.

## First run — sign in

The installer already wrote the two Supabase values to `.env` (from `--config`
or the prompt). The only first-run step is to sign in:

```sh
node ~/.worldmonitor/app/scripts/worldmonitor-local.mjs login
```

This runs a loopback GitHub OAuth flow in your browser, writes the session to
`~/.worldmonitor/session.json`, and immediately asks this org's `local-config`
broker for its Upstash **read-only** credential — so the local cache starts
refreshing without you ever handling a token. Removing your account from the
org revokes it within the hour (the backend re-checks the broker hourly and
drops the credential on a `401`/`403`).

One-time operator setup: the Supabase project must allowlist
`http://127.0.0.1:46124/callback` under **Auth → URL Configuration → Redirect
URLs**. Your GitHub account must be in the allow-listed org (org membership is
the invite).

Then either open **`http://127.0.0.1:46123/`** in a browser (or the Desktop
launcher), or, in VS Code, run **WorldMonitor: Open Local Dashboard**.

**AI summary panels** need a personal LLM key — set `OPENROUTER_API_KEY` (or
Groq / Ollama) in the dashboard's **Settings → AI** tab inside VS Code, or add
it to `.env`. It is per-operator; the org's ~26 shared data-source keys stay in
the cloud and never reach an operator machine.

## Managing the backend

```sh
cd ~/.worldmonitor/app
node scripts/worldmonitor-local.mjs status      # backend / runtime / service / token / identity
node scripts/worldmonitor-local.mjs restart     # kick the service (after an upgrade)
node scripts/worldmonitor-local.mjs config list # stored config (~/.worldmonitor/config.db)
node scripts/worldmonitor-local.mjs logout      # drop the stored session
node scripts/worldmonitor-local.mjs uninstall   # remove the service (keeps ~/.worldmonitor/)
```

`.env` (in `~/.worldmonitor/app/`) holds the values you set — the service loads
it with `node --env-file`. `config.db` is the same allow-listed key set in a
store the `config` subcommand edits and the `local-config` broker writes to;
for the **brokered** keys (the Upstash read-only URL + token, `APP_DOMAIN`) the
broker's copy wins over `.env` so a stale token can't shadow a revocation.
After changing `.env` or a non-brokered `config` value, `restart`.

The service listens on `127.0.0.1:46123` — REST + `dist/` for the dashboard and
`/api/mcp` for a local MCP agent. Log: `~/.worldmonitor/local-api.log`
(`%USERPROFILE%\.worldmonitor\local-api.log` on Windows).

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
| Dashboard panels stay empty | `status` shows `backend up`? The cache only refreshes once you have an Upstash read-only credential — normally the `local-config` broker supplies it at `login` (its output says so, or `config list` shows the token as set). If your org doesn't run the broker, set `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_READONLY_TOKEN` in `.env` and `restart`. |
| Freshness badges say "unknown" | Expected until the cache has synced once. `/api/health` is computed locally and never needs a Redis write credential. |
| "Brief service unavailable" | You haven't signed in, or the session expired — run `worldmonitor-local login` again. |
| Extension iframe blank | Reload the VS Code window; the backend serves `dist/` over HTTP and must be up first. |
| `login` fails after GitHub consent | Your account isn't in the allow-listed org, or `127.0.0.1:46124/callback` isn't allowlisted in Supabase. |
| Windows: `status` shows `task Ready` but `backend DOWN` | The task ran but node exited — check `%USERPROFILE%\.worldmonitor\local-api.log`, then `restart`. |
| Bootstrap can't reach nodejs.org / GitHub | Use the offline vars (`WM_NODE_TARBALL` / `WM_APP_TARBALL`) or the manual `setup.sh` path. |
