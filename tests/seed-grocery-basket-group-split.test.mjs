import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mergeCarriedOverCountries, countryGroup, GROUP_COUNT } from '../scripts/seed-grocery-basket.mjs';

// biovita cost-incident follow-up (2026-09-23): seed-grocery-basket.mjs's
// --group= flag lets gcp/scheduler/main.ts run GROUP_COUNT independent
// Cloud Scheduler entries instead of one 24-country sequential sweep (real
// worst case ~600s, per the script's own lockTtlMs comment — well past even
// the 360s scheduler-service Cloud Run timeout). These two functions are the
// pure core of that split; the rest of the script performs a real
// Exa/Firecrawl scrape as a top-level await, so it can't be safely imported
// in a test — this is what's covered instead.

describe('countryGroup: partitions every configured country exactly once', () => {
  it('every group index covers a disjoint, non-empty slice, and all groups together cover every country', () => {
    const seen = new Set();
    for (let i = 0; i < GROUP_COUNT; i++) {
      const group = countryGroup(i);
      assert.ok(group.length > 0, `group ${i} must not be empty`);
      for (const country of group) {
        assert.ok(!seen.has(country.code), `country ${country.code} must appear in exactly one group (duplicate in group ${i})`);
        seen.add(country.code);
      }
    }
    // Total across all groups must equal the full configured country count —
    // this is what catches an off-by-one in the slice math dropping a country.
    const configCountries = countryGroup(0).concat(
      ...Array.from({ length: GROUP_COUNT - 1 }, (_, i) => countryGroup(i + 1)),
    );
    assert.equal(seen.size, configCountries.length);
  });

  it('an out-of-range index does not silently return an empty or wrapped slice', () => {
    const lastGroup = countryGroup(GROUP_COUNT - 1);
    const pastEnd = countryGroup(GROUP_COUNT);
    assert.notDeepEqual(pastEnd, lastGroup, 'past-the-end index must not alias the last real group');
  });
});

describe('mergeCarriedOverCountries: preserves non-fresh countries without duplicating fresh ones', () => {
  it('appends prevCountries not in freshCodes, in their prevCountries order, after the fresh results', () => {
    const fresh = [{ code: 'US', totalUsd: 42 }, { code: 'GB', totalUsd: 30 }];
    const prev = [
      { code: 'US', totalUsd: 41 }, // stale value for a fresh country — must NOT override the fresh one
      { code: 'DE', totalUsd: 55, wowPct: 1.2 },
      { code: 'FR', totalUsd: 60, wowPct: -0.5 },
    ];
    const freshCodes = new Set(['US', 'GB']);

    const merged = mergeCarriedOverCountries(fresh, prev, freshCodes);

    assert.deepEqual(merged.map(c => c.code), ['US', 'GB', 'DE', 'FR']);
    assert.equal(merged.find(c => c.code === 'US').totalUsd, 42, 'fresh US entry must win over the stale prev one, not be overwritten');
    assert.equal(merged.find(c => c.code === 'DE').wowPct, 1.2, 'carried-over country keeps its own last-known wowPct');
  });

  it('returns the fresh array unchanged when prevCountries is missing (first-ever run, no snapshot yet)', () => {
    const fresh = [{ code: 'US', totalUsd: 42 }];
    const merged = mergeCarriedOverCountries(fresh, undefined, new Set(['US']));
    assert.deepEqual(merged, fresh);
  });

  it('carries over every country when freshCodes is empty (defensive — should not happen in practice)', () => {
    const prev = [{ code: 'US', totalUsd: 41 }, { code: 'DE', totalUsd: 55 }];
    const merged = mergeCarriedOverCountries([], prev, new Set());
    assert.deepEqual(merged.map(c => c.code), ['US', 'DE']);
  });
});
