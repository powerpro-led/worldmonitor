import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// P14 Phase 1 (PLATFORM_ARCHITECTURE.md Workstream 5): scenario-worker.mjs
// previously had no `{ once }` support at all — runWorker() looped forever.
// scripts/queue-worker.mjs needs a call that processes at most one dequeue
// attempt and returns, matching seed-forecasts.mjs's
// runSimulationWorker/runDeepForecastWorker `{ once }` contract. These tests
// mock the Upstash REST calls (all routed through global fetch) so no live
// Redis is needed.

process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const { runWorker } = await import('../scripts/scenario-worker.mjs');

let originalFetch;
let calls;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * scenario-worker.mjs's redisCmd() POSTs a JSON command array to the base
 * REST URL; its redisGet() instead does a plain GET against `<url>/get/<key>`
 * with no body — two different shapes both routed through global fetch.
 * @param {(cmd: string, args: unknown[]) => unknown} onCommand
 */
function installFetchMock(onCommand) {
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/get/')) {
      const key = decodeURIComponent(String(url).split('/get/')[1]);
      calls.push('GET');
      const result = onCommand('GET', [key]);
      return { ok: true, json: async () => ({ result }), text: async () => '' };
    }
    const body = JSON.parse(opts.body);
    const [cmd, ...args] = body;
    calls.push(cmd);
    const result = onCommand(cmd, args);
    return {
      ok: true,
      json: async () => ({ result }),
      text: async () => '',
    };
  };
}

describe('runWorker({ once: true })', () => {
  it('makes exactly one BLMOVE attempt on an empty queue, then returns', async () => {
    installFetchMock((cmd) => {
      if (cmd === 'LMOVE') return null; // requeueOrphanedJobs: nothing to requeue
      if (cmd === 'BLMOVE') return null; // empty queue
      throw new Error(`unexpected command in this test: ${cmd}`);
    });

    await runWorker({ once: true });

    const blmoveCalls = calls.filter((c) => c === 'BLMOVE');
    assert.equal(blmoveCalls.length, 1, 'should attempt exactly one dequeue, not loop');
  });

  it('processing an unparseable job still returns after one iteration (no infinite loop)', async () => {
    installFetchMock((cmd) => {
      if (cmd === 'LMOVE') return null;
      if (cmd === 'BLMOVE') return 'not-json{{{';
      if (cmd === 'LREM') return 1;
      throw new Error(`unexpected command in this test: ${cmd}`);
    });

    await runWorker({ once: true });

    assert.equal(calls.filter((c) => c === 'BLMOVE').length, 1);
    assert.ok(calls.includes('LREM'), 'discards the unparseable payload from the processing list');
  });

  it('a job already marked done is skipped and the call still returns after one iteration', async () => {
    const job = JSON.stringify({
      jobId: 'scenario:1234567890123:abcd1234',
      scenarioId: 'taiwan-strait-full-closure',
      iso2: null,
    });
    installFetchMock((cmd) => {
      if (cmd === 'LMOVE') return null;
      if (cmd === 'BLMOVE') return job;
      if (cmd === 'GET') return JSON.stringify({ status: 'done' }); // already processed
      if (cmd === 'LREM') return 1;
      throw new Error(`unexpected command in this test: ${cmd}`);
    });

    await runWorker({ once: true });

    assert.equal(calls.filter((c) => c === 'BLMOVE').length, 1);
    assert.ok(calls.includes('GET'));
  });
});
