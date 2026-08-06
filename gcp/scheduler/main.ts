/**
 * worldmonitor's Nitric scheduler entrypoint (Cloud Run, matched by
 * nitric.yaml's `services: - match: gcp/scheduler/main.ts`).
 *
 * Registers one Nitric `schedule()` per `deployMode: "nixpacks-*"` entry in
 * scripts/railway-services.json (the 31 one-off cron scripts — the 5
 * `dockerfile` entries are long-running processes, wired directly as their
 * own Cloud Run services in root nitric.yaml, not here). Driven off that JSON
 * file rather than hand-listing 31 blocks, so this stays in sync with
 * whatever Railway's own registry says without a second source of truth.
 *
 * Each handler spawns the EXISTING script unchanged via child_process — not
 * an in-process import — because scripts/_seed-utils.mjs's `runSeed()` calls
 * `process.exit()` on completion, which would kill this entire long-lived
 * Cloud Run container if imported directly. This mirrors how Railway already
 * runs each one as its own process.
 *
 * Cadence: every entry uses a PLACEHOLDER rate (`DEFAULT_SCAFFOLD_RATE`
 * below). scripts/railway-services.json doesn't carry per-script intervals —
 * real cadences live in each script's header docblock / Railway cron config
 * and need to be filled in individually before this is ever deployed for
 * real. Flagged, not guessed. See docs/architecture/nitric-gcp-scaffold.md.
 *
 * Scaffold-only pass.
 */

import { schedule } from '@nitric/sdk';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** TODO: replace with each script's real cadence before real deploy. */
const DEFAULT_SCAFFOLD_RATE = '30 minutes';

interface RailwayServiceEntry {
  entry: string;
  deployMode: string;
  service: string;
}

const railwayServices = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'scripts', 'railway-services.json'), 'utf8'),
) as RailwayServiceEntry[];

function runScriptOnce(entryRelativePath: string): () => Promise<void> {
  return () =>
    new Promise<void>((resolve, reject) => {
      const child = spawn('node', [entryRelativePath], { cwd: REPO_ROOT, stdio: 'inherit' });
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${entryRelativePath} exited with code ${code}`));
      });
      child.on('error', reject);
    });
}

const nixpacksEntries = railwayServices.filter((svc) => svc.deployMode.startsWith('nixpacks'));

for (const svc of nixpacksEntries) {
  const run = runScriptOnce(svc.entry);
  schedule(svc.service).every(DEFAULT_SCAFFOLD_RATE, async () => {
    await run();
  });
}
