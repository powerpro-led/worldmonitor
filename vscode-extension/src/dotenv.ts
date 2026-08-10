import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Reads a single KEY=VALUE out of the repo's own .env.local — VS Code's
 * extension host process does not source it automatically (that's an
 * app-level dotenv convention, not an OS environment variable). Minimal
 * hand-rolled parser (matches the pattern already used elsewhere in this
 * repo's own scripts) — no need for a dotenv dependency for a couple of
 * lookups.
 */
export function readDotenvValue(repoRoot: string, key: string): string | undefined {
  const envPath = path.join(repoRoot, '.env.local');
  if (!fs.existsSync(envPath)) return undefined;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const lineKey = line.slice(0, eq).trim();
    if (lineKey !== key) continue;
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    return value || undefined;
  }
  return undefined;
}
