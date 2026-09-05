import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The positive-events GDELT seed loop moved out of scripts/ais-relay.cjs into
// scripts/seed-positive-events.mjs (P14 Phase 2, session 63 — see
// PLATFORM_ARCHITECTURE.md). These tests still guard the same invariant they
// always did: a FAILED GDELT call must never be mistaken for a successful empty
// response, or a 429 storm silently overwrites the panel with "0 events"
// instead of serving last-good. They now assert against the standalone script.
const seedSrc = readFileSync(resolve('scripts/seed-positive-events.mjs'), 'utf8');

describe('positive-events GDELT seed failure semantics', () => {
  it('routes GDELT fetches through _gdelt-fetch.mjs (shared rate gate + proxy fallback)', () => {
    assert.match(seedSrc, /import \{ fetchGdeltJson \} from '\.\/_gdelt-fetch\.mjs'/);
    // per-query call — the 5.5s spacing is now the shared cross-process gate
    // fetchGdeltJson claims internally, not a local setTimeout.
    assert.match(seedSrc, /await fetchGdeltJson\(\s*`https:\/\/api\.gdeltproject\.org\/api\/v1\/gkg_geojson\?QUERY=\$\{encodeURIComponent\(query\)\}&MAXROWS=500`/);
    assert.doesNotMatch(seedSrc, /setTimeout\([^,]*,\s*5_?500\)/);
  });

  it('does not count a failed GDELT call as a successful empty response', () => {
    const fetchStart = seedSrc.indexOf('async function fetchPositiveEvents()');
    assert.notEqual(fetchStart, -1, 'fetchPositiveEvents must exist');
    const fetchBlock = seedSrc.slice(fetchStart, seedSrc.indexOf('function validate('));

    // anyQuerySucceeded flips true ONLY on the line immediately after a
    // non-throwing fetchGdeltJson await — never in the catch.
    assert.match(fetchBlock, /data = await fetchGdeltJson\([\s\S]*?\);\s*\n\s*\} catch \(err\) \{\s*\n\s*console\.warn[\s\S]*?\n\s*continue; \/\/ individual query failure is non-fatal\s*\n\s*\}\s*\n\s*anyQuerySucceeded = true;/);
    // a per-query failure is a `continue`, not a silent success
    assert.match(fetchBlock, /continue; \/\/ individual query failure is non-fatal/);
  });

  it('preserves last-good cache when every query failed (throws → runSeed graceful path)', () => {
    const fetchStart = seedSrc.indexOf('async function fetchPositiveEvents()');
    const fetchBlock = seedSrc.slice(fetchStart, seedSrc.indexOf('function validate('));
    // total failure surfaces as a thrown fetch error; runSeed then extends the
    // existing canonical + extraKey TTLs instead of publishing an empty payload.
    assert.match(fetchBlock, /if \(!anyQuerySucceeded\) throw new Error\('all GDELT theme queries failed'\);/);
  });

  it('a genuinely-empty successful fetch still publishes (zeroIsValid)', () => {
    // Matches the relay loop's "any query succeeded → write, even 0 events".
    assert.match(seedSrc, /zeroIsValid: true/);
    // both keys written with the same payload/TTL (RPC + bootstrap)
    assert.match(seedSrc, /const BOOTSTRAP_KEY = 'positive_events:geo-bootstrap:v1'/);
    assert.match(seedSrc, /extraKeys: \[\{ key: BOOTSTRAP_KEY, transform: \(d\) => d, ttl: CACHE_TTL, declareRecords \}\]/);
  });
});
