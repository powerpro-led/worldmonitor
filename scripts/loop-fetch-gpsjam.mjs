#!/usr/bin/env node
/**
 * Local-dev-only loop wrapper around fetch-gpsjam.mjs.
 *
 * fetch-gpsjam.mjs is one-shot by design (top-level main(), no internal loop,
 * per its own docblock: "Cadence: daily"). In production its cadence comes
 * from gcp/scheduler/main.ts's CADENCES entry ('fetch-gpsjam', every 1 day),
 * which `nitric start` DOES load locally as the `scheduler` service -- but a
 * Nitric `schedule().every()` fires only AFTER the first interval elapses,
 * never on registration (session-32 lesson). So on a fresh `nitric start`,
 * or after any local Redis reset, `intelligence:gpsjam:v2` stays empty and
 * /api/gpsjam 503s for up to 24h until the first scheduled tick.
 *
 * This wrapper closes that gap: it runs fetch-gpsjam.mjs once immediately
 * (self-heals the key on startup), then re-runs it daily to match the
 * production cadence for long-lived dev sessions.
 *
 * Its own nitric.yaml service entry uses a plain `node $SERVICE_PATH` (not an
 * inline `sh -c "while ..."`, which nitric's local start-command parser
 * mangles -- see scripts/loop-digest-notifications.mjs's header for that
 * story). Production is unaffected: fetch-gpsjam.mjs is scheduled directly
 * by gcp/scheduler/main.ts, one child run per tick, and never touches this
 * file.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET_SCRIPT = path.join(__dirname, 'fetch-gpsjam.mjs');
// Matches gcp/scheduler/main.ts's CADENCES entry ('fetch-gpsjam': every 1 day)
// and fetch-gpsjam.mjs's own "Cadence: daily" header.
const INTERVAL_MS = 24 * 60 * 60_000;

function runOnce() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TARGET_SCRIPT], { stdio: 'inherit', env: process.env });
    child.on('exit', (code) => {
      if (code !== 0) {
        console.error(`[loop-fetch-gpsjam] run exited with code ${code} -- continuing on schedule, not fatal to the loop`);
      }
      resolve();
    });
    child.on('error', (err) => {
      console.error(`[loop-fetch-gpsjam] failed to spawn: ${err.message}`);
      resolve();
    });
  });
}

async function main() {
  console.log(`[loop-fetch-gpsjam] starting -- re-running fetch-gpsjam.mjs every ${INTERVAL_MS / 60 / 60_000}h (immediate first run)`);
  for (;;) {
    await runOnce();
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

main();
