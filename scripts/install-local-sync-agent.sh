#!/bin/sh
# Install (or reinstall) the launchd agent that keeps the operator's local
# SQLite mirror fresh.
#
# WHY A MACHINE-LEVEL AGENT, not something tied to the VS Code extension:
# the mirror is the operator's own local copy of the data layer, and its
# freshness is a property of the machine, not of whether an editor happens to
# be open. Hanging it off extension start/stop would mean the mirror silently
# rots whenever the editor is closed -- and the failure it exists to prevent
# (the sync being dead for four days with nothing reporting it) is exactly the
# kind that hides in a lifecycle hook nobody watches.
#
# WHICH REDIS IT PULLS FROM IS NOT DECIDED HERE. The agent runs the ordinary
# `local-sync` entry point, which reads UPSTASH_REDIS_REST_URL from the repo's
# .env: hosted Upstash in production, the local Docker Redis in dev. That is
# the standing rule -- the source is env-driven, never branched on in code --
# so this installer deliberately has no notion of "cloud" or "local".
#
# LaunchAgent (user domain), not LaunchDaemon: it writes into the operator's
# own repo and reads their .env, so it must run as the operator. A root
# LaunchDaemon would leave root-owned files in the working tree. This is the
# one place it differs from com.worldmonitor.firms-vpn-bypass, which edits
# system routing and therefore does need root.
#
# Usage:  sh scripts/install-local-sync-agent.sh [interval_seconds]   (default 900)
set -eu

LABEL="com.worldmonitor.local-sync"
INTERVAL="${1:-900}"

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)

# launchd starts jobs with a minimal PATH and no useful working directory, so
# every path in the plist must be absolute -- including node's. Resolved at
# install time rather than hardcoded because node here lives under nvm
# (~/.nvm/versions/node/<version>/bin/node), so the path changes on every node
# upgrade. Re-run this installer after one, or the agent silently stops
# working: launchd will log "No such file or directory" to the log below and
# nothing else will ever mention it.
NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ]; then
  echo "error: node not found on PATH; run this from a shell where \`node -v\` works" >&2
  exit 1
fi

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="/tmp/$LABEL.log"
mkdir -p "$HOME/Library/LaunchAgents"

# --env-file-if-exists (not --env-file) so a missing .env degrades to the
# inherited environment instead of crashing the job, matching how the sidecar
# and the repo's other local processes load it.
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>--env-file-if-exists=$REPO_ROOT/.env</string>
    <string>$REPO_ROOT/vscode-extension/sidecar/local-sync.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_ROOT</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>$INTERVAL</integer>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLIST_EOF

# bootout is expected to fail when nothing is loaded yet -- hence `|| true`.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "installed $LABEL"
echo "  every:   ${INTERVAL}s (also runs immediately at load and at login)"
echo "  runs:    $NODE_BIN --env-file-if-exists=$REPO_ROOT/.env .../local-sync.mjs"
echo "  log:     $LOG"
echo
echo "  status:  launchctl print gui/$(id -u)/$LABEL | head"
echo "  remove:  launchctl bootout gui/$(id -u)/$LABEL && rm $PLIST"
echo
echo "NOTE: a resync does not reach a RUNNING sidecar -- it loads the mirror once"
echo "      per process. Restart the sidecar to pick up fresh data."
