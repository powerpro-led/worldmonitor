/**
 * Coverage guardrail for scripts/railway-services.json — the single source
 * of truth for every script that runs as a Railway service. This test fails
 * if a deployment artifact in the repo (Dockerfile.* CMD line, runbook
 * "Start command:" entry, or standalone-service row) references a script not
 * present in the registry.
 *
 * Two BFS-style tests derive their entry lists from the registry:
 *   - tests/scripts-railway-nixpacks-no-escape-import.test.mts (nixpacks)
 *   - tests/dockerfile-digest-notifications-imports.test.mjs (Dockerfile)
 *
 * Without this coverage test, the registry would drift the same way the
 * old hardcoded `ENTRY_POINTS` array did (PR #3836 retrospective): a new
 * Railway service ships and nothing reminds the author to register it.
 *
 * Pattern source: test-ci-gotchas/reference/static-grep-audit-test-
 * undertested-by-only-matching-one-shape — the self-fixture below tests
 * the regex against both Dockerfile `CMD [...]` shape AND the runbook
 * `Start command:` table-cell shape so a future regex simplification
 * cannot silently stop matching one of them.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

interface RailwayServiceEntry {
  entry: string;
  deployMode: 'nixpacks-root-scripts' | 'nixpacks-root-repo' | 'dockerfile';
  dockerfile?: string;
  service: string;
  startCommand?: string;
  requiredEnv?: string[];
  watchPatterns?: string[];
  cronSchedule?: string | null;
  documentedAt: string;
}

const registry = JSON.parse(
  readFileSync(resolve(repoRoot, 'scripts/railway-services.json'), 'utf8'),
) as RailwayServiceEntry[];

const registryEntries = new Set(registry.map((r) => r.entry));
const dockerfileMap = new Map(
  registry
    .filter((r) => r.deployMode === 'dockerfile' && r.dockerfile)
    .map((r) => [r.dockerfile!, r.entry]),
);

// Match `CMD ["node", "scripts/<file>", ...]`. Captures the script path and
// permits fixed script arguments such as the publisher's required `--loop`.
const DOCKERFILE_CMD_RE = /^\s*CMD\s+\[\s*"node"\s*,\s*"(scripts\/[^"]+)"(?:\s*,\s*"[^"]*")*\s*\]/m;

// Match runbook lines like `| **Start command** | \`node scripts/foo.mjs\` |`
// (table-cell shape — multiple spaces, backtick quoting around the command).
// Also tolerates `node` paths without backticks in case the runbook drifts.
const RUNBOOK_START_RE = /\|\s*\*\*Start command\*\*\s*\|\s*`?node\s+(scripts\/\S+?\.(?:mjs|cjs|js))`?\s*\|/g;

// Match standalone-service rows like:
//   | seed-fake | `node scripts/seed-fake.mjs` | hourly | Domain |
const RUNBOOK_SERVICE_ROW_RE = /^\|\s*seed-[a-z0-9-]+\s*\|\s*`node\s+(scripts\/[^`]+\.(?:mjs|cjs|js))`\s*\|/gm;

// Match script headers that document a manually provisioned Railway service:
//   - Service name: seed-bundle-foo
// The script filename itself is the start command source for this shape.
const SCRIPT_HEADER_SERVICE_RE = /^\s*\/\/\s*-\s*Service name:\s*([a-z0-9-]+)\s*$/m;

describe('Railway service registry coverage', () => {
  it('pins the bootstrap publisher deployment contract', () => {
    const publisher = registry.find(
      (entry) => entry.entry === 'scripts/publish-bootstrap-tiers.mjs',
    );

    assert.ok(publisher, 'bootstrap publisher must be registered as a Railway service');
    assert.equal(publisher.deployMode, 'dockerfile');
    assert.equal(publisher.dockerfile, 'Dockerfile.publish-bootstrap-tiers');
    const publisherDockerfile = readFileSync(
      resolve(repoRoot, publisher.dockerfile),
      'utf8',
    );
    assert.match(publisherDockerfile, /^COPY scripts\/ \.\/scripts\/$/m);
    assert.match(publisherDockerfile, /^COPY shared\/ \.\/shared\/$/m);
    assert.match(
      publisherDockerfile,
      /^CMD \["node", "scripts\/publish-bootstrap-tiers\.mjs", "--loop"\]$/m,
    );
    assert.equal(publisher.service, 'publish-bootstrap-tiers');
    assert.equal(publisher.startCommand, 'node scripts/publish-bootstrap-tiers.mjs --loop');
    assert.deepEqual(publisher.requiredEnv, [
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN',
      'IRAN_EVENTS_ENABLED',
      'R2_ACCOUNT_ID',
      'R2_BOOTSTRAP_BUCKET',
      'R2_BOOTSTRAP_ACCESS_KEY_ID',
      'R2_BOOTSTRAP_SECRET_ACCESS_KEY',
    ]);
    assert.deepEqual(publisher.watchPatterns, ['scripts/**', 'shared/**']);
    assert.equal(publisher.cronSchedule, null, 'publisher must be always-on, never a Railway cron');
  });

  it('required environment declarations use canonical unique variable names', () => {
    for (const entry of registry) {
      if (entry.requiredEnv == null) continue;
      assert.ok(Array.isArray(entry.requiredEnv), `${entry.service}.requiredEnv must be an array`);
      assert.ok(entry.requiredEnv.length > 0, `${entry.service}.requiredEnv must not be empty`);
      assert.equal(
        new Set(entry.requiredEnv).size,
        entry.requiredEnv.length,
        `${entry.service}.requiredEnv must not contain duplicates`,
      );
      for (const name of entry.requiredEnv) {
        assert.match(name, /^[A-Z][A-Z0-9_]*$/, `${entry.service} has invalid requiredEnv name`);
      }
    }
  });

  it('every Dockerfile.* CMD has a matching registry entry', () => {
    const dockerfiles = readdirSync(repoRoot)
      .filter((f) => f.startsWith('Dockerfile.'))
      .sort();

    const missing: string[] = [];
    for (const df of dockerfiles) {
      const src = readFileSync(resolve(repoRoot, df), 'utf8');
      const m = src.match(DOCKERFILE_CMD_RE);
      if (!m) continue; // Dockerfile without a scripts/ CMD (e.g., relay multi-stage doesn't apply)
      const entry = m[1]!;
      const registered = dockerfileMap.get(df);
      if (registered !== entry) {
        missing.push(
          `${df} runs '${entry}' but registry has ` +
            (registered ? `'${registered}' for ${df}` : `no entry for ${df}`),
        );
      }
    }

    if (missing.length > 0) {
      assert.fail(
        `Dockerfile CMD lines drift from scripts/railway-services.json:\n` +
          missing.map((m) => `  - ${m}`).join('\n') +
          `\n\nEither add the missing entry to the registry (deployMode: ` +
          `"dockerfile", dockerfile: "<Dockerfile.*>") or update the CMD ` +
          `to match the registered script.`,
      );
    }
  });

  it('every script header-documented Railway service is registered', () => {
    const missing: string[] = [];
    const scriptFiles = readdirSync(resolve(repoRoot, 'scripts'))
      .filter((f) => /\.(?:mjs|cjs|js)$/.test(f))
      .sort();

    for (const file of scriptFiles) {
      const entry = `scripts/${file}`;
      const src = readFileSync(resolve(repoRoot, entry), 'utf8');
      const m = src.match(SCRIPT_HEADER_SERVICE_RE);
      if (!m) continue;

      const service = m[1]!;
      const registered = registry.find((r) => r.entry === entry);
      if (!registered) {
        missing.push(`${entry} documents Railway service '${service}' but registry has no matching entry`);
        continue;
      }
      if (registered.service !== service) {
        missing.push(
          `${entry} documents Railway service '${service}' but registry service is '${registered.service}'`,
        );
      }
    }

    if (missing.length > 0) {
      assert.fail(
        `Script header-documented Railway services drift from scripts/railway-services.json:\n` +
          missing.map((s) => `  - ${s}`).join('\n') +
          `\n\nAdd the missing entry to the registry or update the documented service header.`,
      );
    }
  });

  // Self-fixture: prove BOTH regex shapes match what they're supposed to.
  // Without this, a future "simplification" of either regex could silently
  // stop matching one shape, and the audit above would pass coincidentally
  // because today's repo happens to lack a violation. Pinned synthetic
  // input ensures the audit stays load-bearing.
  it('DOCKERFILE_CMD_RE matches the documented Dockerfile CMD shape', () => {
    const sample = 'FROM node:22-alpine\nWORKDIR /app\nCMD ["node", "scripts/seed-fake.mjs"]\n';
    const m = sample.match(DOCKERFILE_CMD_RE);
    assert.ok(m, 'DOCKERFILE_CMD_RE failed to match canonical CMD shape');
    assert.equal(m![1], 'scripts/seed-fake.mjs');
  });

  it('DOCKERFILE_CMD_RE accepts fixed script arguments', () => {
    const sample = 'CMD ["node", "scripts/publish-bootstrap-tiers.mjs", "--loop"]\n';
    const m = sample.match(DOCKERFILE_CMD_RE);
    assert.ok(m, 'DOCKERFILE_CMD_RE failed to match CMD with a fixed argument');
    assert.equal(m![1], 'scripts/publish-bootstrap-tiers.mjs');
  });

  it('RUNBOOK_START_RE matches the documented runbook Start command shape', () => {
    const sample = '| **Start command** | `node scripts/seed-fake.mjs` |\n';
    RUNBOOK_START_RE.lastIndex = 0;
    const m = RUNBOOK_START_RE.exec(sample);
    assert.ok(m, 'RUNBOOK_START_RE failed to match canonical Start command shape');
    assert.equal(m![1], 'scripts/seed-fake.mjs');
  });

  it('RUNBOOK_SERVICE_ROW_RE matches the documented standalone-service shape', () => {
    const sample = '| seed-fake | `node scripts/seed-fake.mjs` | hourly | Fake data |\n';
    RUNBOOK_SERVICE_ROW_RE.lastIndex = 0;
    const m = RUNBOOK_SERVICE_ROW_RE.exec(sample);
    assert.ok(m, 'RUNBOOK_SERVICE_ROW_RE failed to match canonical standalone-service shape');
    assert.equal(m![1], 'scripts/seed-fake.mjs');
  });

  // ── Session-32 widening ────────────────────────────────────────────────
  // The checks above only catch a script that a DEPLOYMENT ARTIFACT already
  // references (a Dockerfile CMD, a runbook row, a `Service name:` header).
  // That is backwards for the failure mode that actually bit: a seeder that
  // no artifact mentions at all is invisible to every one of them. Only 7 of
  // 155 seed scripts carried the header shape, so 30 orphans sat unrun until
  // the 2026-08-21 sweep and /api/health showed 43 EMPTY checks whose names
  // mapped one-to-one onto them.
  //
  // This test inverts the direction: enumerate scripts/seed-*.mjs from DISK
  // and require each one to be reachable by something that can actually run
  // it, or to be listed below with a reason. Adding a seeder now forces a
  // conscious choice rather than silent non-execution.
  const DELIBERATELY_UNSCHEDULED = new Map<string, string>([
    ['seed-recall-benchmark', 'runs in .github/workflows/feed-validation.yml — its header says "no Railway slot"'],
    ['seed-consumer-prices', 'header: "MANUAL FALLBACK script only. Do NOT configure as a Railway cron" — consumer-prices-core publish.ts is the authoritative writer'],
    ['seed-iran-events', 'header: "Iran-events domain sunset (war ended 2026-07). Default OFF" — manually re-seeded'],
  ]);

  it('every scripts/seed-*.mjs is scheduled somewhere or explicitly excused', () => {
    const seeders = readdirSync(resolve(repoRoot, 'scripts'))
      .filter((f) => /^seed-.*\.mjs$/.test(f))
      .map((f) => f.replace(/\.mjs$/, ''))
      .sort();

    // Everything that can actually cause a seeder to run.
    const reachable = new Set<string>();
    const harvest = (text: string) => {
      for (const m of text.match(/seed-[a-z0-9-]+/g) ?? []) reachable.add(m);
    };
    for (const entry of registry) harvest(entry.entry);
    harvest(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
    harvest(readFileSync(resolve(repoRoot, 'gcp/scheduler/main.ts'), 'utf8'));
    for (const f of readdirSync(resolve(repoRoot, 'scripts'))) {
      if (/^seed-bundle-.*\.mjs$/.test(f)) harvest(readFileSync(resolve(repoRoot, 'scripts', f), 'utf8'));
    }
    for (const f of readdirSync(resolve(repoRoot, '.github/workflows'))) {
      harvest(readFileSync(resolve(repoRoot, '.github/workflows', f), 'utf8'));
    }
    // Long-running services spawn seeders too: scripts/ais-relay.cjs runs
    // seed-chokepoint-flows.mjs via execFile. Omitting registry entry scripts
    // from this sweep is what made the first pass of the session-32 audit
    // report seed-chokepoint-flows as an orphan and briefly register it a
    // second time. Dockerfiles are included for the same reason.
    for (const entry of registry) {
      const abs = resolve(repoRoot, entry.entry);
      if (existsSync(abs)) harvest(readFileSync(abs, 'utf8'));
    }
    for (const f of readdirSync(repoRoot)) {
      if (f.startsWith('Dockerfile.')) harvest(readFileSync(resolve(repoRoot, f), 'utf8'));
    }

    const orphans = seeders.filter((s) => !reachable.has(s) && !DELIBERATELY_UNSCHEDULED.has(s));
    assert.deepEqual(
      orphans,
      [],
      `orphaned seeder(s) — nothing in the repo can run these. Either register them in ` +
        `scripts/railway-services.json (plus a cadence in gcp/scheduler/main.ts), or add them to ` +
        `DELIBERATELY_UNSCHEDULED in this test with the reason from the script's own header:\n  ` +
        orphans.join('\n  '),
    );
  });

  it('DELIBERATELY_UNSCHEDULED only lists scripts that exist and are genuinely unscheduled', () => {
    // Guards the allowlist itself: a stale entry would silently re-open the
    // hole it was created to document.
    const onDisk = new Set(
      readdirSync(resolve(repoRoot, 'scripts'))
        .filter((f) => /^seed-.*\.mjs$/.test(f))
        .map((f) => f.replace(/\.mjs$/, '')),
    );
    for (const [name, reason] of DELIBERATELY_UNSCHEDULED) {
      assert.ok(onDisk.has(name), `DELIBERATELY_UNSCHEDULED lists ${name}, which no longer exists in scripts/`);
      assert.ok(reason.length > 20, `DELIBERATELY_UNSCHEDULED[${name}] needs a real reason, not a placeholder`);
      assert.ok(
        !registry.some((e) => e.service === name),
        `${name} is in DELIBERATELY_UNSCHEDULED but IS registered in railway-services.json — pick one`,
      );
    }
  });

  it('SCRIPT_HEADER_SERVICE_RE matches the documented script service header shape', () => {
    const sample = [
      '// Railway service config (set up manually via Railway dashboard or',
      '// `railway service`):',
      '//   - Service name: seed-bundle-fake',
    ].join('\n');
    const m = sample.match(SCRIPT_HEADER_SERVICE_RE);
    assert.ok(m, 'SCRIPT_HEADER_SERVICE_RE failed to match canonical service header shape');
    assert.equal(m![1], 'seed-bundle-fake');
  });
});
