import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { discoverVersion as discoverStandaloneUcdpVersion } from '../scripts/seed-ucdp-events.mjs';

// ais-relay.cjs's UCDP writer (seedUcdpEvents/startUcdpSeedLoop) moved to the
// standalone scripts/seed-ucdp-events.mjs in P14 Phase 2 (session 62 — see
// PLATFORM_ARCHITECTURE.md). `src` is kept only for ucdpRelayDiscoverVersion —
// the separate on-demand /ucdp-events HTTP-proxy reader, which still lives in
// ais-relay.cjs and was NOT touched by that move (it doesn't write to Redis).
const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
const standaloneSrc = readFileSync('scripts/seed-ucdp-events.mjs', 'utf8');
const UCDP_REDIS_KEY = 'conflict:ucdp-events:v1';
const EXPECTED_UCDP_WRITER_PATHS = [
  'scripts/seed-ucdp-events.mjs',
];
const SOURCE_SCAN_IGNORED_DIRS = new Set([
  '.git',
  '.vercel',
  'coverage',
  'dist',
  'node_modules',
  'src/generated',
]);

function shouldScanSourceDir(path) {
  return !SOURCE_SCAN_IGNORED_DIRS.has(path);
}

function sourceFilesContaining(rootDir, needle) {
  const matches = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      // The parallel test runner churns short-lived fixtures under scripts/
      // (bundle-runner, seed-utils-sigterm-cleanup), so a file readdirSync
      // just listed can vanish before we stat/read it. Such files are never
      // real source — skip them rather than letting a transient ENOENT crash
      // the whole audit (flaky under --test-concurrency); re-throw anything
      // else so a genuine fs error still surfaces.
      let stat;
      try {
        stat = statSync(path);
      } catch (err) {
        if (err?.code === 'ENOENT') continue;
        throw err;
      }
      if (stat.isDirectory()) {
        if (!shouldScanSourceDir(path)) continue;
        stack.push(path);
        continue;
      }
      if (!/\.(?:cjs|mjs|js|mts|ts)$/.test(path)) continue;
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') continue;
        throw err;
      }
      if (text.includes(needle)) matches.push(path);
    }
  }
  return matches.sort();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ucdpRedisWriterPaths() {
  return sourceFilesContaining('.', UCDP_REDIS_KEY)
    .filter((path) => !path.endsWith('.test.mjs') && !path.endsWith('.test.mts'))
    .filter((path) => {
      const text = readFileSync(path, 'utf8');
      if (new RegExp(`(?:envelopeWrite|upstashSet)\\(\\s*['"]${escapeRegExp(UCDP_REDIS_KEY)}['"]`).test(text)) {
        return true;
      }
      if (new RegExp(`\\[\\s*['"]SET['"]\\s*,\\s*['"]${escapeRegExp(UCDP_REDIS_KEY)}['"]`).test(text)) {
        return true;
      }
      const keyVars = Array.from(
        text.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*['"]${escapeRegExp(UCDP_REDIS_KEY)}['"]`, 'g')),
        (match) => match[1],
      );
      return keyVars.some((keyVar) => (
        new RegExp(`(?:envelopeWrite|upstashSet)\\(\\s*${keyVar}\\b`).test(text)
          || new RegExp(`\\[\\s*['"]SET['"]\\s*,\\s*${keyVar}\\b`).test(text)
      ));
    })
    .map((path) => path.replace(/\\/g, '/'))
    .sort();
}

// Extract just main()'s body — the sole UCDP writer now that ais-relay.cjs's
// seedUcdpEvents() moved out (P14 Phase 2, session 62 — see
// PLATFORM_ARCHITECTURE.md) — for targeted assertions.
const mainFnStart = standaloneSrc.indexOf('async function main() {');
const mainFnBody = standaloneSrc.slice(mainFnStart);

describe('UCDP seed resilience branches (scripts/seed-ucdp-events.mjs)', () => {
  it('logs error details on page fetch failures instead of silently swallowing', () => {
    // The .catch must include console.warn with the page number and error
    assert.match(
      mainFnBody,
      /\.catch\(\(err\)\s*=>\s*\{[^}]*console\.warn\(`\s*\[UCDP\] page/,
      'Page fetch .catch should log error with page number',
    );
  });

  it('does NOT use page 0 as fallback data (would overwrite good cache with stale)', () => {
    // There must be no code path that pushes page0.Result into allEvents
    assert.ok(
      !mainFnBody.includes('page0.Result'),
      'main() must not push page0 data into allEvents (would overwrite last known good cache)',
    );
  });

  it('extends existing key TTL when nothing survives processing, instead of overwriting', () => {
    // Unlike ais-relay's two separate guards (allEvents.length === 0 &&
    // failedPages > 0 / mapped.length === 0), the standalone script collapses
    // both into one: capped.length === 0 covers an all-pages-failed run too,
    // since an empty allEvents/filtered set also yields an empty capped set.
    assert.match(
      mainFnBody,
      /if\s*\(capped\.length === 0\)\s*\{/,
      'Should check for the empty-after-processing condition',
    );
    assert.match(
      mainFnBody,
      /\['EXPIRE',\s*REDIS_KEY,\s*86400\]/,
      'Should EXPIRE the existing canonical key to extend its TTL',
    );
  });

  it('does NOT write fresh seed-meta inside the empty-after-processing branch (would make health lie)', () => {
    const guardStart = mainFnBody.indexOf('if (capped.length === 0)');
    const emptyBranch = mainFnBody.slice(guardStart, mainFnBody.indexOf('process.exit(0);', guardStart) + 20);
    assert.ok(
      !emptyBranch.includes("'SET'"),
      'Empty-after-processing branch must only EXPIRE seed-meta, never SET it with a fresh fetchedAt/recordCount',
    );
    assert.match(
      emptyBranch,
      /\['EXPIRE',\s*'seed-meta:conflict:ucdp-events',\s*604800\]/,
      'Should extend the seed-meta key TTL alongside the canonical key',
    );
  });

  it('only writes seed-meta on successful publish with actual events', () => {
    const publishSection = mainFnBody.slice(mainFnBody.indexOf('const payload = {'));
    assert.match(
      publishSection,
      /\['SET',\s*REDIS_KEY,\s*JSON\.stringify\(payload\)/,
      'Should write payload to UCDP key',
    );
    assert.match(
      publishSection,
      /\['SET',\s*metaKey,\s*JSON\.stringify\(meta\)/,
      'Should write seed-meta after successful publish',
    );
  });
});

describe('UCDP version selection prefers the newest release', () => {
  // ais-relay.cjs's writer-side ucdpDiscoverVersion() — which probed all
  // candidates in PARALLEL (Promise.allSettled) and ranked them with
  // ucdpVersionNewer() to avoid an older-but-faster release winning — moved
  // out with the rest of the writer (P14 Phase 2, session 62). Its
  // replacement, scripts/seed-ucdp-events.mjs's discoverVersion(), sidesteps
  // that failure mode structurally instead of guarding against it: it tries
  // pre-sorted (newest-first) candidates SEQUENTIALLY and returns the first
  // one with a non-empty Result, so an older release never gets a chance to
  // "win a race" — there is no race. That property is verified behaviorally
  // below ('standalone cron discovery...'), so the two source-grep checks
  // this comment used to introduce (Promise.any-avoidance, ucdpVersionNewer
  // usage) and the standalone 'ucdpVersionNewer ranks GED versions
  // newest-first' unit test that used to follow are gone along with the
  // parallel-race algorithm and the ucdpVersionRank/ucdpVersionNewer
  // functions they exercised — neither exists anywhere in the codebase
  // anymore (grep scripts/ais-relay.cjs and scripts/seed-ucdp-events.mjs to
  // confirm before ever reintroducing them).

  it('on-demand relay discovery requires a non-empty Result (no empty newer wins)', () => {
    const relayDiscover = src.slice(
      src.indexOf('async function ucdpRelayDiscoverVersion()'),
      src.indexOf('async function ucdpFetchAllEvents()'),
    );
    assert.match(relayDiscover, /Array\.isArray\(page0\?\.Result\) && page0\.Result\.length > 0/);
  });

  it('all UCDP Redis writers are covered by this guard', () => {
    assert.deepEqual(ucdpRedisWriterPaths(), EXPECTED_UCDP_WRITER_PATHS);
  });

  it('standalone cron discovery also requires non-empty Result for the same Redis key', async () => {
    assert.match(standaloneSrc, /const REDIS_KEY = 'conflict:ucdp-events:v1'/);
    const standaloneDiscover = standaloneSrc.slice(
      standaloneSrc.indexOf('async function discoverVersion('),
      standaloneSrc.indexOf('function parseDateMs('),
    );
    assert.match(
      standaloneDiscover,
      /!Array\.isArray\(page0\?\.Result\) \|\| page0\.Result\.length === 0/,
      'standalone UCDP seeder must not let an empty newer GED release win',
    );

    const pages = new Map([
      ['26.1', { Result: [], TotalPages: 1 }],
      ['25.1', { Result: [{ id: 'older-populated' }], TotalPages: 1 }],
    ]);
    const originalLog = console.log;
    console.log = () => {};
    try {
      const selected = await discoverStandaloneUcdpVersion(
        '',
        async (version) => pages.get(version),
        ['26.1', '25.1'],
      );
      assert.equal(selected.version, '25.1');
      assert.deepEqual(selected.page0.Result, [{ id: 'older-populated' }]);
    } finally {
      console.log = originalLog;
    }
  });
});
