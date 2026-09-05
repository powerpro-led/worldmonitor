import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyKey, isMirroredKey } from '../scripts/shared/sync-domains.mjs';

// Workstream 4 (PLATFORM_ARCHITECTURE.md P6): the old SYNC_PREFIXES allowlist
// is gone. classifyKey() is default-allow with three states; isMirroredKey()
// is the fast-path push gate == `classifyKey(key) === 'mirror'`.

describe('classifyKey — denylist model', () => {
  it('mirrors an ordinary data key', () => {
    assert.equal(classifyKey('resilience:scores:v1:US'), 'mirror');
    assert.equal(classifyKey('market:quote:v1:AAPL'), 'mirror');
    assert.equal(classifyKey('theater-posture:sebuf:v1'), 'mirror');
  });

  // The whole point of the inversion: a domain nobody has touched this file
  // for still reaches the mirror. Under the old allowlist this returned
  // false until someone remembered to add the prefix by hand.
  it('mirrors a brand-new data prefix with no code change here', () => {
    assert.equal(classifyKey('some-brand-new-domain:widget:v1'), 'mirror');
    assert.equal(isMirroredKey('some-brand-new-domain:widget:v1'), true);
  });

  it('rejects non-string / empty input', () => {
    assert.equal(classifyKey(null), 'deny');
    assert.equal(classifyKey(undefined), 'deny');
    assert.equal(classifyKey(42), 'deny');
    assert.equal(classifyKey(''), 'deny');
  });

  describe('denied prefixes (internal bookkeeping / infra / probes)', () => {
    for (const key of [
      'story:alias:abc123',
      'wm:notif:dedup:x',
      'cache:abuseipdb:1.2.3.4',
      'digest:notifications:last-run',
      'baseline:unrest:US',
      'seed-meta:resilience',
      'seed-routes:v1',
      'seed-activated:economic',
      'seed-lock:seed-forecasts',
      'health:acled',
      'rl:ep:api/news',
      'rl:apikey:day:u1:2026-09-04',
      'rate:global',
      'llm:direct-usage:u1:2026-09-04',
      'relay:ais:window',
      'cf:cache:purge',
      'shared:config:v1',
      'ci-sebuf:probe',
      'wm-smoke-test:ping',
      'temporal:workflow:x',
      'preview:deadbeef:market:quote:v1',
      'sync:changelog',
      'session:abc',
      'idempotency:xyz',
      'ratelimit:foo',
      'lock:seed',
    ]) {
      it(`denies ${key}`, () => {
        assert.equal(classifyKey(key), 'deny');
        assert.equal(isMirroredKey(key), false);
      });
    }
  });

  describe('denied by shape, regardless of domain', () => {
    it('denies a credential key even under a data-looking prefix', () => {
      assert.equal(classifyKey('acled:oauth:token'), 'deny');
      assert.equal(classifyKey('finnhub:api:secret'), 'deny');
      assert.equal(classifyKey('som-provider:oauth:refresh'), 'deny');
    });
    it('denies a pagination/sync cursor key', () => {
      assert.equal(classifyKey('news:ingest:cursor'), 'deny');
    });
    it('denies a smoke-test key under any variant', () => {
      assert.equal(classifyKey('wm:smoke-test:ping'), 'deny');
    });
  });

  // Regression: forecast:simulation-task* is a LIVE worker queue (a ZSET the
  // simulation worker ZRANGEs) sitting under the otherwise-mirrored
  // `forecast:` prefix. No shape pattern catches it — carried verbatim
  // across the allowlist→denylist inversion. (Originally found via
  // tests/simulation-queue-parity.test.mts breaking, not by design.)
  describe('forecast:simulation-task exclusion (regression)', () => {
    it('denies the internal worker task queue key', () => {
      assert.equal(classifyKey('forecast:simulation-task:v1:1734567890123-abc'), 'deny');
      assert.equal(classifyKey('forecast:simulation-task-queue:v1'), 'deny');
    });
    it('still mirrors ordinary forecast: display data', () => {
      assert.equal(classifyKey('forecast:predictions:v1'), 'mirror');
    });
  });

  // brief: is the one user-scoped prefix. The shared brief:llm:* subtree is
  // 'mirror' (safe to push to everyone); every other brief: key is
  // 'mirror-filtered' — the rescan keeps it after keepKey() scopes it to the
  // current operator, and the fast-path push NEVER carries it (sync:notify is
  // one global channel; a brief:<other-uid>:* row pushed there would land in
  // every operator's mirror — the session-39 leak this split prevents).
  describe('brief: three-state split', () => {
    it('marks a per-user brief key mirror-filtered — never pushed on the fast path', () => {
      assert.equal(classifyKey('brief:11111111-2222-3333-4444-555555555555:latest'), 'mirror-filtered');
      assert.equal(classifyKey('brief:latest:11111111-2222-3333-4444-555555555555'), 'mirror-filtered');
      assert.equal(isMirroredKey('brief:11111111-2222-3333-4444-555555555555:latest'), false);
    });
    it('marks the shared brief:llm: subtree plain mirror', () => {
      assert.equal(classifyKey('brief:llm:description:abcdef'), 'mirror');
      assert.equal(isMirroredKey('brief:llm:description:abcdef'), true);
    });
  });

  // Regression: `supply-chain:exposure:` (HYPHEN, distinct from the
  // underscored `supply_chain:`) has a scheduled batch seeder but was
  // mirrored nowhere under the old allowlist. Under the denylist it just
  // works — as does every other hyphen supply-chain family. (The old
  // allowlist deliberately excluded cost-shock / sector-dep / route-* as
  // request-varying read-through caches; with per-org DBs and a denylist
  // that distinction is no longer enforced here — accepted.)
  it('mirrors the hyphen-spelled supply-chain families', () => {
    assert.equal(classifyKey('supply-chain:exposure:US:27:v1'), 'mirror');
    assert.equal(classifyKey('supply-chain:cost-shock:US:hormuz:v1'), 'mirror');
  });
});
