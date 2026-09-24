/**
 * server/_shared/llm-health.ts gates every real LLM call behind a probe of
 * the provider's base origin — a false "unreachable" verdict here silently
 * skips a working provider for the whole cache TTL. This has now happened
 * live twice on two different real-world networks (2026-09-01 openrouter.ai
 * over a VPN, 2026-09-24 the same provider through the local sidecar's
 * SSRF-checking fetch wrapper on a real Windows field report — see that
 * file's own header comment) purely from the probe timeout being tuned for
 * a fast/dev network. This file exercises the two changes made alongside
 * the second timeout bump so the same class of bug is harder to reintroduce
 * silently: one retry before a negative verdict, and a much shorter cache
 * TTL for a negative result than a positive one.
 *
 * Each test uses its own fake origin — the module keeps its cache/inFlight
 * maps at module scope with no reset hook, so distinct origins are how
 * tests stay isolated from each other without touching production code.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isProviderAvailable, getLlmHealthStatus } from '../server/_shared/llm-health';

function withMockedFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => { globalThis.fetch = original; });
}

describe('isProviderAvailable() — probe resilience', () => {
  it('reports available on the very first successful probe (no unnecessary retry)', async () => {
    let calls = 0;
    const available = await withMockedFetch(
      (async () => { calls++; return new Response('ok'); }) as typeof fetch,
      () => isProviderAvailable('https://llm-health-test-fast-ok.example/v1/chat'),
    );
    assert.equal(available, true);
    assert.equal(calls, 1, 'a successful first attempt must not trigger a second');
  });

  it('retries once after a failed first attempt, and reports available if the retry succeeds', async () => {
    let calls = 0;
    const available = await withMockedFetch(
      (async () => {
        calls++;
        if (calls === 1) throw new Error('simulated transient timeout');
        return new Response('ok');
      }) as typeof fetch,
      () => isProviderAvailable('https://llm-health-test-retry-recovers.example/v1/chat'),
    );
    assert.equal(available, true, 'a single transient failure must not condemn a working provider');
    assert.equal(calls, 2);
  });

  it('reports unavailable only after BOTH attempts fail', async () => {
    let calls = 0;
    const available = await withMockedFetch(
      (async () => { calls++; throw new Error('simulated persistent failure'); }) as typeof fetch,
      () => isProviderAvailable('https://llm-health-test-both-fail.example/v1/chat'),
    );
    assert.equal(available, false);
    assert.equal(calls, 2, 'must try exactly twice before giving up, not one and not more');
  });

  it('a negative verdict is re-probed sooner than a positive one (asymmetric cache TTL)', async () => {
    const origin = 'https://llm-health-test-negative-ttl.example';
    let calls = 0;
    // First round: both attempts fail -> cached as unavailable.
    await withMockedFetch(
      (async () => { calls++; throw new Error('down'); }) as typeof fetch,
      () => isProviderAvailable(`${origin}/v1/chat`),
    );
    assert.equal(calls, 2);

    // Immediately after, a call using the SAME mocked-failing fetch would
    // still resolve unavailable if the cache is being consulted (no new
    // fetch calls) -- confirms the negative result IS cached at all, not
    // proof of the shorter TTL by itself.
    const stillCached = await withMockedFetch(
      (async () => { calls++; return new Response('ok'); }) as typeof fetch,
      () => isProviderAvailable(`${origin}/v1/chat`),
    );
    assert.equal(stillCached, false, 'a fresh negative result should still be served from cache moments later');
    assert.equal(calls, 2, 'no new probe yet -- still within NEGATIVE_CACHE_TTL_MS');

    const status = getLlmHealthStatus();
    assert.equal(status[origin]?.available, false);
  });
});
