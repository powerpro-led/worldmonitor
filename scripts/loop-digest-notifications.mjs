#!/usr/bin/env node
/**
 * Local-dev-only loop wrapper around seed-digest-notifications.mjs.
 *
 * That script is one-shot by design (main() + process.exit(), no internal
 * loop, per its own docblock) -- its real cadence in production comes from
 * Railway's own Cron Schedule feature re-invoking the container every 30 min
 * (Dockerfile.digest-notifications), a re-invoke primitive `nitric start`'s
 * local services: block doesn't have. Without this, a `nitric start` session
 * runs it exactly once and Latest Brief goes stale (found 2026-08-23).
 *
 * This exists as its own file, matched directly by nitric.yaml (in place of
 * `match: scripts/seed-digest-notifications.mjs` + an inline
 * `sh -c "while true; do ...; done"` start command), because nitric's local
 * start-command parser could not handle that nested quoting -- confirmed
 * live 2026-08-31: it split the quoted -c argument on whitespace instead of
 * passing it through intact, throwing `unexpected EOF while looking for
 * matching "` on every `nitric start`. A plain `node $SERVICE_PATH` pointed
 * at a real file sidesteps the parser entirely, matching every OTHER loop
 * in this same nitric.yaml (e.g. publish-bootstrap-tiers.mjs's own --loop
 * flag) -- none of which route through a shell at all.
 *
 * Production's Dockerfile.digest-notifications is untouched: it still runs
 * scripts/seed-digest-notifications.mjs directly, one-shot, per Railway's
 * cron. This wrapper only exists on the local `nitric start` dev path.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET_SCRIPT = path.join(__dirname, 'seed-digest-notifications.mjs');
// Matches Railway's own Cron Schedule interval (Dockerfile.digest-notifications).
const INTERVAL_MS = 30 * 60_000;

function runOnce() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TARGET_SCRIPT], { stdio: 'inherit', env: process.env });
    child.on('exit', (code) => {
      if (code !== 0) {
        console.error(`[loop-digest-notifications] run exited with code ${code} -- continuing on schedule, not fatal to the loop`);
      }
      resolve();
    });
    child.on('error', (err) => {
      console.error(`[loop-digest-notifications] failed to spawn: ${err.message}`);
      resolve();
    });
  });
}

async function main() {
  console.log(`[loop-digest-notifications] starting -- re-running seed-digest-notifications.mjs every ${INTERVAL_MS / 60_000}min`);
  for (;;) {
    await runOnce();
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

main();
