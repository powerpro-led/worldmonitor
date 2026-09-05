import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The Social Velocity seed loop moved out of scripts/ais-relay.cjs into the
// hand-rolled scripts/seed-social-velocity.mjs (P14 Phase 2, session 63 — see
// PLATFORM_ARCHITECTURE.md). It stayed hand-rolled precisely to keep the
// behaviour these tests pin: a bespoke seed-meta shape (status: 'ok' | 'error'
// + errorReason) that api/health.js's classifyKey reads to raise SEED_ERROR
// immediately on a Reddit fetch failure, and a healthy-meta write that only
// lands AFTER the canonical write succeeds.
const here = dirname(fileURLToPath(import.meta.url));
const seedSource = readFileSync(resolve(here, '../scripts/seed-social-velocity.mjs'), 'utf8');

function sourceBetween(start, end) {
  const startIndex = seedSource.indexOf(start);
  const endIndex = seedSource.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return seedSource.slice(startIndex, endIndex);
}

test('social velocity writes explicit error seed-meta on Reddit fetch failures', () => {
  assert.match(seedSource, /const SEED_META_KEY = 'seed-meta:intelligence:social-reddit'/);
  assert.match(seedSource, /async function writeFailureMeta\(reason\)/);
  assert.match(seedSource, /function socialVelocityMetaErrorReason\(reason\)/);
  assert.match(seedSource, /status: 'error',/);
  assert.match(seedSource, /errorReason: socialVelocityMetaErrorReason\(reason\)/);
  // empty-Reddit-response path carries the per-subreddit failure list
  assert.match(seedSource, /`empty_reddit_response: \$\{fetchFailures\.join\('; '\)\}`/);
  // top-level catch path
  assert.match(seedSource, /await writeFailureMeta\(`seed_error: \$\{e\?\.message \|\| e\}`\)/);
});

test('social velocity only advances healthy seed-meta after the canonical write succeeds', () => {
  const mainRegion = sourceBetween('export async function main()', 'if (process.argv[1]');
  const healthyMetaRegion = sourceBetween(
    'async function writeHealthyMeta(recordCount)',
    'async function fetchRedditHot',
  );

  // `published` is set from atomicPublish's result and gates the healthy write.
  assert.match(mainRegion, /published = !result\?\.skipped;/);
  assert.match(mainRegion, /if \(published\) \{\s+await writeHealthyMeta\(top\.length\);/);
  assert.match(mainRegion, /\} else \{[\s\S]*writeFailureMeta\('canonical_write_failed'\)/);
  // the healthy meta must never be written unconditionally before publish
  assert.doesNotMatch(mainRegion, /await writeHealthyMeta\([^)]*\);\s*\n\s*(?:const|let)\s+result\s*=\s*await atomicPublish/);

  assert.match(healthyMetaRegion, /try \{/);
  assert.match(healthyMetaRegion, /status: 'ok',/);
  assert.match(healthyMetaRegion, /recordCount,/);
  assert.match(healthyMetaRegion, /catch \(e\) \{/);
  assert.match(healthyMetaRegion, /return false;/);
});

test('a failed canonical write does not leave the run looking healthy', () => {
  const mainRegion = sourceBetween('export async function main()', 'if (process.argv[1]');
  // failed publish → extend last-good TTL, mark seed-meta error, then rethrow
  assert.match(mainRegion, /await extendExistingTtl\(\[CANONICAL_KEY\], CACHE_TTL\);[\s\S]*writeFailureMeta\('canonical_write_failed'\);[\s\S]*throw new Error\('canonical write failed'\)/);
});
