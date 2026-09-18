#!/usr/bin/env bash
# Runs `nitric up --ci --stack <name>` and watches its combined output for a
# stall. If nothing is written for $STALL_SECS, sends SIGQUIT to the process:
# Go's default runtime behavior on SIGQUIT (when the target doesn't install
# its own handler for it) is to dump every goroutine's stack trace and exit —
# real diagnostic payoff for a hang `nitric --verbose` can't produce (that
# flag is dead code in the CLI as of 2026-09-17's investigation).
#
# Built 2026-09-18 after two real dispatches (biovita 2026-09-17, ais-shared
# 2026-09-18) both hung silently after the build phase completed, with zero
# GCP resources ever created and the `nitric` process still alive (not a
# crashed/orphaned child) when the job's own timeout-minutes killed it.
#
# Usage: nitric-up-stall-dump.sh <stack-name>
set -uo pipefail

stack_name="$1"
stall_secs="${STALL_SECS:-600}"
poll_secs=30
log_file="$(mktemp)"

nitric up --ci --stack "$stack_name" >"$log_file" 2>&1 &
pid=$!

last_size=0
stalled_for=0
while kill -0 "$pid" 2>/dev/null; do
  sleep "$poll_secs"
  size=$(wc -c <"$log_file")
  if [ "$size" != "$last_size" ]; then
    last_size=$size
    stalled_for=0
  else
    stalled_for=$((stalled_for + poll_secs))
    echo "::debug::no new nitric output for ${stalled_for}s"
    if [ "$stalled_for" -ge "$stall_secs" ]; then
      echo "::warning::no output for ${stall_secs}s — sending SIGQUIT to nitric (pid $pid) for a goroutine dump"
      kill -QUIT "$pid" 2>/dev/null || true
      sleep 10
      break
    fi
  fi
done

wait "$pid"
status=$?

echo "::group::nitric up output"
cat "$log_file"
echo "::endgroup::"
rm -f "$log_file"

exit "$status"
