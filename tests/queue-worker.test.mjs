import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Set fake Upstash creds before the module-scope imports resolve —
// scripts/queue-worker.mjs imports scenario-worker.mjs, whose
// getRedisCredentials() calls process.exit(1) if these are unset (even
// though this test's own run() calls never touch Redis directly, since it
// injects a fake worker list — importing the module still needs them set).
process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const { run } = await import('../scripts/queue-worker.mjs');

// P14 Phase 1 (PLATFORM_ARCHITECTURE.md Workstream 5): queue-worker.mjs
// merges 3 independent queue consumers into one scheduled `--once` tick.
// One consumer throwing must not prevent the other two from running, and the
// exit code (what gcp/scheduler/main.ts's spawn() sees) must only go
// non-zero when ALL THREE fail — mirrors seed-news-digest.mjs's W7
// partial-failure contract. Uses run()'s injectable worker list so none of
// this touches real Redis or the real forecast/scenario workers.

describe('queue-worker run()', () => {
  it('exits 0 when every worker succeeds', async () => {
    const workers = [
      { name: 'a', run: async () => ({ status: 'done' }) },
      { name: 'b', run: async () => ({ status: 'idle' }) },
      { name: 'c', run: async () => ({ status: 'done' }) },
    ];
    assert.equal(await run(workers), 0);
  });

  it('exits 0 when only some workers succeed (self-heals next tick)', async () => {
    const workers = [
      { name: 'a', run: async () => ({ status: 'done' }) },
      { name: 'b', run: async () => { throw new Error('transient'); } },
      { name: 'c', run: async () => ({ status: 'idle' }) },
    ];
    assert.equal(await run(workers), 0);
  });

  it('exits 1 only when every worker fails', async () => {
    const workers = [
      { name: 'a', run: async () => { throw new Error('boom-a'); } },
      { name: 'b', run: async () => { throw new Error('boom-b'); } },
      { name: 'c', run: async () => { throw new Error('boom-c'); } },
    ];
    assert.equal(await run(workers), 1);
  });

  it('runs all workers concurrently, not sequentially gated on the first', async () => {
    const order = [];
    const workers = [
      {
        name: 'slow',
        run: async () => {
          await new Promise((r) => setTimeout(r, 20));
          order.push('slow');
          return { status: 'done' };
        },
      },
      {
        name: 'fast',
        run: async () => {
          order.push('fast');
          return { status: 'done' };
        },
      },
    ];
    await run(workers);
    assert.deepEqual(order, ['fast', 'slow'], 'fast worker should finish before slow one — Promise.allSettled, not sequential awaits');
  });
});
