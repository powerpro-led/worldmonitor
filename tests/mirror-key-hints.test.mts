/**
 * Unit tests for src/services/mirror-key-hints.ts — the client half of the
 * per-panel "not synced yet → Refresh from cloud" affordance.
 */

import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach, mock } from 'node:test';

// isSidecarBackedRuntime() reads window.__wmVsCodeApi — present it before the
// module (and its transitive imports) load. `location` is touched by
// src/config/variant.ts once `window` is defined but non-Tauri.
(globalThis as { location?: unknown }).location = { hostname: 'localhost' };
(globalThis as { window?: unknown }).window = { __wmVsCodeApi: {}, location: { hostname: 'localhost' } };

const {
  recordMirrorKeyHint,
  getMirrorKeyHint,
  getRecentMirrorKeyHints,
  refreshMirrorKeys,
  __clearMirrorKeyHintsForTests,
} = await import('@/services/mirror-key-hints');

function resWith(headerValue: string | null): Response {
  const headers = new Headers();
  if (headerValue !== null) headers.set('X-WM-Mirror-Keys', headerValue);
  return new Response('{}', { status: 200, headers });
}

describe('mirror-key-hints', () => {
  beforeEach(() => __clearMirrorKeyHintsForTests());

  describe('recordMirrorKeyHint / getMirrorKeyHint', () => {
    it('captures the header keyed by request pathname', () => {
      recordMirrorKeyHint('/api/economic/v1/get-macro-signals', resWith('economic:macro-signals:v1'));
      assert.deepEqual(
        getMirrorKeyHint('/api/economic/v1/get-macro-signals'),
        ['economic:macro-signals:v1'],
      );
    });

    it('parses a comma-separated multi-key header and trims', () => {
      recordMirrorKeyHint(
        'https://api.example.test/api/military/v1/list-military-flights?bbox=1',
        resWith(' military:flights:v1 , military:flights:stale:v1 '),
      );
      assert.deepEqual(
        getMirrorKeyHint('/api/military/v1/list-military-flights'),
        ['military:flights:v1', 'military:flights:stale:v1'],
      );
    });

    it('returns null for an unseen path', () => {
      assert.equal(getMirrorKeyHint('/api/nope/v1/get-nothing'), null);
    });

    it('ignores a response with no header', () => {
      recordMirrorKeyHint('/api/x/v1/y', resWith(null));
      assert.equal(getMirrorKeyHint('/api/x/v1/y'), null);
    });

    it('ignores an empty header value', () => {
      recordMirrorKeyHint('/api/x/v1/y', resWith('   ,  '));
      assert.equal(getMirrorKeyHint('/api/x/v1/y'), null);
    });

    it('the latest response for a path wins', () => {
      recordMirrorKeyHint('/api/x/v1/y', resWith('x:v1'));
      recordMirrorKeyHint('/api/x/v1/y', resWith('x:v2'));
      assert.deepEqual(getMirrorKeyHint('/api/x/v1/y'), ['x:v2']);
    });

    it('returns a copy — the caller cannot mutate the store', () => {
      recordMirrorKeyHint('/api/x/v1/y', resWith('x:v1'));
      getMirrorKeyHint('/api/x/v1/y')!.push('injected');
      assert.deepEqual(getMirrorKeyHint('/api/x/v1/y'), ['x:v1']);
    });
  });

  describe('getRecentMirrorKeyHints', () => {
    it('unions keys across every live hint, freshest path first', () => {
      recordMirrorKeyHint('/api/a/v1/x', resWith('a:1'));
      recordMirrorKeyHint('/api/b/v1/y', resWith('b:1, b:2'));
      assert.deepEqual(getRecentMirrorKeyHints(), ['b:1', 'b:2', 'a:1']);
    });

    it('dedupes a key recorded on more than one path', () => {
      recordMirrorKeyHint('/api/a/v1/x', resWith('shared:1'));
      recordMirrorKeyHint('/api/b/v1/y', resWith('shared:1, b:2'));
      assert.deepEqual(getRecentMirrorKeyHints(), ['shared:1', 'b:2']);
    });

    it('filters to a pathPrefix', () => {
      recordMirrorKeyHint('/api/economic/v1/get-macro', resWith('economic:1'));
      recordMirrorKeyHint('/api/market/v1/get-quote', resWith('market:1'));
      assert.deepEqual(
        getRecentMirrorKeyHints({ pathPrefix: '/api/economic/v1/' }),
        ['economic:1'],
      );
    });

    it('excludes hints older than maxAgeMs', async () => {
      recordMirrorKeyHint('/api/a/v1/x', resWith('a:1'));
      await new Promise((r) => setTimeout(r, 5));
      assert.deepEqual(getRecentMirrorKeyHints({ maxAgeMs: 1 }), []);
    });

    it('caps the union at 16 keys', () => {
      for (let i = 0; i < 30; i++) {
        recordMirrorKeyHint(`/api/a/v1/x${i}`, resWith(`k:${i}`));
      }
      assert.equal(getRecentMirrorKeyHints().length, 16);
    });

    it('returns a fresh array each call', () => {
      recordMirrorKeyHint('/api/a/v1/x', resWith('a:1'));
      const first = getRecentMirrorKeyHints();
      first.push('injected');
      assert.deepEqual(getRecentMirrorKeyHints(), ['a:1']);
    });
  });

  describe('refreshMirrorKeys', () => {
    let fetchMock: ReturnType<typeof mock.method<typeof globalThis, 'fetch'>>;
    before(() => {
      fetchMock = mock.method(globalThis, 'fetch', () =>
        Promise.resolve(new Response(JSON.stringify({ refreshed: ['a:v1'], skipped: [] }), { status: 200 })));
    });
    after(() => fetchMock.mock.restore());
    beforeEach(() => fetchMock.mock.resetCalls());

    it('POSTs the deduped, capped key list to /api/local-sync-refresh', async () => {
      const out = await refreshMirrorKeys(['a:v1', 'a:v1', 'b:v1']);
      assert.equal(fetchMock.mock.calls.length, 1);
      const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
      assert.ok(String(url).endsWith('/api/local-sync-refresh'));
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(String(init.body)), { keys: ['a:v1', 'b:v1'] });
      assert.deepEqual(out, { refreshed: ['a:v1'], skipped: [] });
    });

    it('caps at 16 keys', async () => {
      await refreshMirrorKeys(Array.from({ length: 30 }, (_, i) => `k:v${i}`));
      const body = JSON.parse(String((fetchMock.mock.calls[0].arguments as [string, RequestInit])[1].body));
      assert.equal(body.keys.length, 16);
    });

    it('returns null on no usable keys without calling fetch', async () => {
      assert.equal(await refreshMirrorKeys([]), null);
      assert.equal(fetchMock.mock.calls.length, 0);
    });

    it('returns null (never throws) when the endpoint errors', async () => {
      fetchMock.mock.mockImplementationOnce(() => Promise.resolve(new Response('nope', { status: 500 })));
      assert.equal(await refreshMirrorKeys(['a:v1']), null);
    });
  });
});

describe('mirror-key-hints — not a sidecar runtime', () => {
  before(() => { delete (globalThis as { window?: unknown }).window; });
  after(() => { (globalThis as { window?: unknown }).window = { __wmVsCodeApi: {} }; });

  it('records nothing and refresh is a no-op', async () => {
    __clearMirrorKeyHintsForTests();
    recordMirrorKeyHint('/api/x/v1/y', resWith('x:v1'));
    assert.equal(getMirrorKeyHint('/api/x/v1/y'), null);
    assert.deepEqual(getRecentMirrorKeyHints(), []);
    assert.equal(await refreshMirrorKeys(['x:v1']), null);
  });
});
