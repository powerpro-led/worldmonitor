# Release bundle — testing guide

How to verify a `worldmonitor-local-<version>` bundle before (or just after)
cutting the GitHub release. Reusable across releases — substitute `<version>`.

The bundle is built by `node scripts/build-release-bundle.mjs`, which produces
`release/worldmonitor-local-<version>.tar.gz` (macOS/Linux),
`release/worldmonitor-local-<version>.zip` (Windows), each with a `.sha256`, and
copies a fresh `.vsix` from `vscode-extension/`.

---

## Test tiers

| Tier | Isolation | Effort | Use when |
| --- | --- | --- | --- |
| **A. Clean-dir extract** | a throwaway directory, reuses your Node | ~2 min + npm ci | every build, always |
| **B. Fresh macOS user account** | separate `$HOME`, own launchd domain, own Node | ~20 min | before sharing a release link; when `worldmonitor-local.mjs` / `setup.sh` changed |
| **C. Windows** | fresh account or machine | ~20 min | when the `IS_WIN` branch / `setup.ps1` changed |
| **D. VM** | full guest OS | 30–60 min | new OS/arch support, or first external hand-off |

Tier A is the baseline gate. Tier B/C/D add fidelity for the parts A can't
reach: the real service manager, first-ever `.env`/token/`login` from zero, the
`.vsix` install, and Gatekeeper/SmartScreen.

---

## Tier A — clean-dir extract (macOS/Linux)

Proves: `npm ci --omit=dev` yields a working tree, the backend boots and serves
REST + `/dashboard.html` + `/api/mcp`, `local-sync` pulls from Upstash. Does NOT
touch the service manager, the installer prompts, or `login`.

```sh
SB=$(mktemp -d)
tar -xzf release/worldmonitor-local-<version>.tar.gz -C "$SB"
cd "$SB/worldmonitor-local-<version>"

# minimal .env (pull the real values from the repo's .env)
grep -E '^(VITE_SUPABASE_URL|SUPABASE_URL|VITE_SUPABASE_PUBLISHABLE_KEY|UPSTASH_REDIS_REST_URL|UPSTASH_REDIS_REST_TOKEN|UPSTASH_REDIS_REST_READONLY_TOKEN)=' \
  /path/to/worldmonitor/.env > .env
echo 'LOCAL_API_MODE=tauri-sidecar' >> .env

npm ci --omit=dev --ignore-scripts        # ~700 pkgs; the bundle ships no node_modules

TOK=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
LOCAL_API_PORT=46202 LOCAL_API_TOKEN="$TOK" \
  LOCAL_API_RESOURCE_DIR="$PWD" \
  LOCAL_SQLITE_PATH="$PWD/vscode-extension/sidecar/local-cache.db" \
  node --env-file-if-exists=.env vscode-extension/sidecar/local-api-server.mjs &

sleep 10
H() { printf '%-24s ' "$1"; curl -s -m10 -o /dev/null -w 'HTTP %{http_code}\n' \
  -H "x-worldmonitor-local-token: $TOK" "http://127.0.0.1:46202$1"; }
H /api/sidecar-health          # expect 200
H /api/health                  # expect 200 (503 REDIS_DOWN only if no UPSTASH_REDIS_REST_TOKEN, or a cold <10s ping)
H /dashboard.html              # expect 200

# MCP handshake
curl -s -m15 -X POST http://127.0.0.1:46202/api/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "x-worldmonitor-local-token: $TOK" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | grep -o '"name":"[a-z_]*"' | wc -l   # expect ~41

kill %1; cd -; rm -rf "$SB"
```

Watch the backend log for `ERR_MODULE_NOT_FOUND` — that means a repo file the
sidecar imports was left out of the bundle (this is how the missing
`scripts/shared/sync-domains.mjs` was caught).

---

## Tier B — fresh macOS user account

Highest fidelity without a VM. Two gotchas:

1. **launchd bootstrap needs a real GUI session.** `launchctl bootstrap
   gui/<uid> …` only works when `<uid>` has its own active Aqua login.
   `sudo -u <user> ./setup.sh` does the `npm ci` + `.env` but the
   `worldmonitor-local install` step fails with *"Could not find domain for
   gui/<uid>"*. You must actually **log into the account** — Fast User Switching
   is enough (both sessions stay live).
2. **Port 46123 is machine-wide.** With both sessions live, the second backend
   to bind :46123 gets `EADDRINUSE`. Stop your dev one for the test window.

Your `node` is likely nvm-scoped (`~/.nvm/...`), invisible to a new user — the
test account needs its own Node.

### One-time setup (admin account)

```sh
sudo sysadminctl -addUser wmtest -fullName "WM Test" -password -   # prompts for a password

# Node for all users: install the official macOS .pkg (LTS >= 22.5) from https://nodejs.org
sudo installer -pkg ~/Downloads/node-v22.*.pkg -target /

cp release/worldmonitor-local-<version>.tar.gz /Users/Shared/
cp scripts/release/TESTING.md                  /Users/Shared/   # so the wmtest session has this guide
```

> This guide (`TESTING.md`) ships in the bundle root from the release *after* it
> was added, and is always readable on GitHub at
> `scripts/release/TESTING.md`. The `cp` above covers older bundles that predate it.

### Test run

```sh
# YOUR session: free port 46123
launchctl bootout gui/$(id -u)/com.worldmonitor.local-api
```

Switch to `wmtest` (Control Center → Fast User Switching). In a Terminal **in
that session**:

```sh
mkdir -p ~/Applications
tar -xzf /Users/Shared/worldmonitor-local-<version>.tar.gz -C ~/Applications
cd ~/Applications/worldmonitor-local-<version>
xattr -dr com.apple.quarantine .          # clear Gatekeeper quarantine if the copy carried it
./setup.sh                               # answer the Supabase + Upstash prompts
node scripts/worldmonitor-local.mjs login  # GitHub OAuth; needs 127.0.0.1:46124/callback allowlisted in Supabase
```

In that session's VS Code:
`code --install-extension ~/Applications/worldmonitor-local-<version>/worldmonitor-local-dashboard-*.vsix`
then run **WorldMonitor: Open Local Dashboard**.

### Cleanup

```sh
# as wmtest
node scripts/worldmonitor-local.mjs uninstall

# back in the admin account — restore your dev backend
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.worldmonitor.local-api.plist
sudo sysadminctl -deleteUser wmtest -secure    # or keep the account for next time
rm /Users/Shared/worldmonitor-local-<version>.tar.gz
```

---

## Tier C — Windows (fresh account or machine)

The Windows service is a per-user Scheduled Task (`WorldMonitorLocal`,
LogonTrigger, no admin). No GUI-session caveat like launchd — `schtasks` works
from any of the user's sessions — but still use a fresh Windows user or machine
so `$env:USERPROFILE\.worldmonitor\` and PATH are clean.

1. Install Node LTS ≥ 22.5 from <https://nodejs.org> (`node -v`).
2. Download `worldmonitor-local-<version>.zip`, extract to a **permanent** folder
   (e.g. `%USERPROFILE%\worldmonitor\`).
3. PowerShell, inside that folder:
   ```powershell
   .\setup.ps1
   # if blocked:  powershell -ExecutionPolicy Bypass -File .\setup.ps1
   ```
4. `node scripts/worldmonitor-local.mjs login`
5. VS Code → **WorldMonitor: Open Local Dashboard**.

### Windows-specific checks

- `node scripts/worldmonitor-local.mjs status` → `backend up` **and** `task Ready`
- Backend survives a **reboot** (LogonTrigger)
- `restart` works (`node scripts/worldmonitor-local.mjs restart`)
- **No console window flashes** on logon — if one does, the `.vbs` `windowStyle 0`
  isn't taking; inspect `%USERPROFILE%\.worldmonitor\worldmonitor-local-run.vbs`
- `schtasks /create /xml` didn't reject the task — if it did, the XML encoding is
  the usual culprit (must be UTF-16LE + BOM); inspect
  `%USERPROFILE%\.worldmonitor\worldmonitor-local-task.xml`
- Log: `%USERPROFILE%\.worldmonitor\local-api.log`
- `uninstall` removes the task and the `.xml`/`.cmd`/`.vbs`

---

## Post-publish integrity check

Confirms the uploaded archives match the build:

```sh
mkdir /tmp/relcheck && cd /tmp/relcheck
gh release download v<version> -R powerpro-led/worldmonitor -p '*.sha256' -p '*.tar.gz' -p '*.zip'
shasum -a 256 -c worldmonitor-local-<version>.tar.gz.sha256 worldmonitor-local-<version>.zip.sha256
cd - && rm -rf /tmp/relcheck
```

---

## Full checklist

| Check | Tier | Pass = |
| --- | --- | --- |
| `npm ci --omit=dev --ignore-scripts` succeeds | A | exit 0, no build step needed |
| `/api/sidecar-health` | A | 200 |
| `/api/health` | A | 200 with full Upstash token |
| `/dashboard.html` | A | 200 |
| `/api/mcp` `tools/list` | A | ~41 tools |
| backend log | A | no `ERR_MODULE_NOT_FOUND` |
| `local-sync` | A | "N keys synced" for every prefix |
| `setup.sh` / `setup.ps1` prompt flow | B / C | writes a valid `.env`, no crash |
| service registration | B / C | `status` shows service + backend up |
| `login` from zero | B / C | `whoami` shows the GitHub identity |
| survives logout/reboot | B / C | backend back up on its own |
| `.vsix` install + dashboard opens | B / C | panels render |
| `restart` / `uninstall` | B / C | clean |
| published `.sha256` | post | `shasum -c` OK for both archives |
