import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SYNC_PREFIXES, isMirroredKey } from '../scripts/shared/sync-domains.mjs';

describe('isMirroredKey', () => {
  it('matches an ordinary mirrored-domain key', () => {
    assert.equal(isMirroredKey('resilience:scores:v1:US'), true);
    assert.equal(isMirroredKey('market:quote:v1:AAPL'), true);
  });

  it('rejects a key with no matching prefix', () => {
    assert.equal(isMirroredKey('story:alias:abc123'), false);
    assert.equal(isMirroredKey('seed-meta:resilience'), false);
  });

  it('rejects a credential key even though it is not in SYNC_PREFIXES at all', () => {
    assert.equal(isMirroredKey('acled:oauth:token'), false);
  });

  it('rejects non-string input', () => {
    assert.equal(isMirroredKey(null), false);
    assert.equal(isMirroredKey(undefined), false);
  });

  // Regression: a real bug found via a multi-agent code review of this
  // feature — the write-side notify and the listener's applyChange() both
  // only checked the broad `brief:` prefix, with no per-user scoping. Since
  // sync:notify is one global channel every operator's sidecar subscribes
  // to identically, that meant ANY user's brief content would be pushed and
  // written into EVERY operator's local mirror — exactly the leak
  // local-sync.mjs's own keepKey() exists to prevent during the full
  // rescan. Fixed by excluding user-scoped brief: keys from the real-time
  // push entirely (see isMirroredKey's own comment) — they still reach the
  // local mirror correctly via the full rescan + keepKey().
  describe('brief: user-scoping (regression)', () => {
    it('rejects a per-user brief key — must never be pushed over the real-time path', () => {
      assert.equal(isMirroredKey('brief:11111111-2222-3333-4444-555555555555:latest'), false);
      assert.equal(isMirroredKey('brief:latest:11111111-2222-3333-4444-555555555555'), false);
    });

    it('still allows the shared, non-user-scoped brief:llm: prefix', () => {
      assert.equal(isMirroredKey('brief:llm:description:abcdef'), true);
    });
  });

  // Regression: forecast:simulation-task* (a live worker queue) was
  // accidentally swept into the broad `forecast:` prefix — found via a
  // parity test breaking (tests/simulation-queue-parity.test.mts), not by
  // design. Fixed via a narrow exclusion rather than touching the broader
  // prefix, which is still needed for real forecast display data.
  describe('forecast:simulation-task exclusion (regression)', () => {
    it('rejects the internal worker task queue key', () => {
      assert.equal(isMirroredKey('forecast:simulation-task:v1:1734567890123-abc'), false);
      assert.equal(isMirroredKey('forecast:simulation-task-queue:v1'), false);
    });

    it('still mirrors ordinary forecast: display data', () => {
      assert.equal(isMirroredKey('forecast:predictions:v1'), true);
    });
  });

  // Regression: `supply-chain:exposure:` (HYPHEN) has a scheduled batch
  // seeder (seed-hs2-chokepoint-exposure.mjs) but was mirrored nowhere
  // because SYNC_PREFIXES only had the underscored `supply_chain:`.
  describe('supply-chain:exposure: (hyphen) — seeded, must mirror', () => {
    it('mirrors the hyphen-spelled chokepoint-exposure seed rows', () => {
      assert.equal(isMirroredKey('supply-chain:exposure:US:27:v1'), true);
    });

    it('still does NOT mirror the request-varying auth-gated hyphen families', () => {
      assert.equal(isMirroredKey('supply-chain:cost-shock:US:hormuz:v1'), false);
      assert.equal(isMirroredKey('supply-chain:sector-dep:US:27:v1'), false);
      assert.equal(isMirroredKey('supply-chain:route-impact:US:CN:27:v1'), false);
      assert.equal(isMirroredKey('supply-chain:route-explorer-lane:US:CN:27:dry:v1'), false);
    });
  });

  it('SYNC_PREFIXES has no accidental duplicate entries', () => {
    assert.equal(new Set(SYNC_PREFIXES).size, SYNC_PREFIXES.length);
  });
});
