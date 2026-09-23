import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  wtoFetch,
  deriveWtoSeverityStatus,
  fetchTariffTrends,
  fetchTradeFlows,
  _setAllReportersForTesting,
} from '../scripts/seed-supply-chain-trade.mjs';

const ORIG_FETCH = globalThis.fetch;
const ORIG_WTO_KEY = process.env.WTO_API_KEY;
const ORIG_FRED_KEY = process.env.FRED_API_KEY;

beforeEach(() => {
  process.env.WTO_API_KEY = 'test-key';
  // Hermetic: keep fetchEffectiveTariffRateFromFred from making real FRED
  // calls. fredFetchJson uses curl-via-proxy which bypasses globalThis.fetch
  // stubs. Unsetting the key short-circuits to `return null` at line 309.
  delete process.env.FRED_API_KEY;
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  if (ORIG_WTO_KEY === undefined) delete process.env.WTO_API_KEY;
  else process.env.WTO_API_KEY = ORIG_WTO_KEY;
  if (ORIG_FRED_KEY !== undefined) process.env.FRED_API_KEY = ORIG_FRED_KEY;
});

describe('wtoFetch: resilience contract — returns null on every failure mode', () => {
  it('returns null when fetch rejects with AbortError (timeout)', async () => {
    globalThis.fetch = async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    };
    const result = await wtoFetch('/data', { i: 'TP_A_0010', r: '840,124,156' });
    assert.equal(result, null, 'timeout must produce null, not throw');
  });

  it('returns null when fetch rejects with a network error', async () => {
    globalThis.fetch = async () => {
      const err = new Error('fetch failed');
      err.cause = { code: 'ECONNRESET' };
      throw err;
    };
    const result = await wtoFetch('/data', { i: 'TP_A_0010', r: '840' });
    assert.equal(result, null, 'network error must produce null, not throw');
  });

  it('returns null on HTTP 5xx', async () => {
    globalThis.fetch = async () => new Response('upstream down', { status: 503 });
    const result = await wtoFetch('/data', { i: 'TP_A_0010', r: '840' });
    assert.equal(result, null);
  });

  it('returns null on HTTP 401 (auth) — stays graceful, does not crash the bundle', async () => {
    globalThis.fetch = async () => new Response('{"statusCode":401}', { status: 401 });
    const result = await wtoFetch('/data', { i: 'TP_A_0010', r: '840' });
    assert.equal(result, null);
  });

  it('returns {Dataset: []} on HTTP 204 (no content for the query)', async () => {
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const result = await wtoFetch('/data', { i: 'TP_A_0010', r: '999' });
    assert.deepEqual(result, { Dataset: [] });
  });

  it('returns parsed JSON on 200', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ Dataset: [{ ReportingEconomyCode: '840', Year: 2025, Value: 3.4 }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    const result = await wtoFetch('/data', { i: 'TP_A_0010', r: '840' });
    assert.equal(Array.isArray(result?.Dataset), true);
    assert.equal(result.Dataset[0].ReportingEconomyCode, '840');
  });

  it('returns null when JSON parse fails (truncated response)', async () => {
    globalThis.fetch = async () => new Response('{"Dataset":[{"R', { status: 200 });
    const result = await wtoFetch('/data', { i: 'TP_A_0010', r: '840' });
    assert.equal(result, null);
  });

  it('returns null when WTO_API_KEY is unset', async () => {
    delete process.env.WTO_API_KEY;
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return new Response('{}', { status: 200 }); };
    const result = await wtoFetch('/data', { i: 'TP_A_0010', r: '840' });
    assert.equal(result, null);
    assert.equal(fetchCalled, false, 'must short-circuit before fetch when key is missing');
  });
});

describe('fetchTariffTrends: per-batch isolation under timeout', () => {
  // Direct regression test for the 2026-05-01 06:08 UTC incident.
  // Calls the real `fetchTariffTrends` (not a copy of its loop) so a future
  // refactor that drops the `if (!data) continue` guard, removes the
  // wtoFetch null contract, or reverts the wtoFetch try/catch will fail
  // here regardless of which line went wrong.
  //
  // Setup:
  //   - 60 reporters → BATCH_SIZE=30 → 2 sequential batches.
  //   - Stub fetch:
  //       - FRED URLs (fetchEffectiveTariffRateFromFred): respond 404 so
  //         it returns null without blocking; tariffs proceeds either way.
  //       - WTO /data batch 1: throw TimeoutError (the 06:08 condition).
  //       - WTO /data batch 2: return one valid datapoint for reporter 840.
  //   - Pre-fix expected behavior: fetchTariffTrends rejects, batch 2's
  //     reporter 840 never makes it to `trends`.
  //   - Post-fix expected behavior: batch 1's null is skipped, batch 2's
  //     data lands in `trends` keyed by `trade:tariffs:v1:840:all:10`.
  it('one batch timing out yields the surviving batches\' data instead of rejecting', async () => {
    // Two batches × BATCH_SIZE=30 reporters; reporter 840 is in batch 2 so
    // the timed-out first batch must not prevent the USA write.
    const batch1 = Array.from({ length: 30 }, (_, i) => String(100 + i));
    const batch2 = ['840', '124', '156', ...Array.from({ length: 27 }, (_, i) => String(200 + i))];
    _setAllReportersForTesting([...batch1, ...batch2]);

    let wtoDataCallCount = 0;
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.url;

      // FRED is short-circuited by the missing FRED_API_KEY (see beforeEach),
      // so the only fetch traffic that reaches here is WTO /data.
      if (url.includes('api.wto.org/timeseries/v1/data')) {
        wtoDataCallCount++;
        if (wtoDataCallCount === 1) {
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'TimeoutError';
          throw err;
        }
        return new Response(JSON.stringify({
          Dataset: [{
            ReportingEconomyCode: '840',
            ReportingEconomy: 'United States',
            Year: 2025,
            Value: 3.4,
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      throw new Error(`Unexpected fetch URL in test: ${url}`);
    };

    // Must not reject. Pre-fix this would throw.
    const trends = await fetchTariffTrends();

    assert.equal(wtoDataCallCount, 2, 'both batches must be attempted (timeout in batch 1 must not skip batch 2)');
    assert.equal(typeof trends, 'object', 'must return the trends object, not reject');
    assert.ok(trends['trade:tariffs:v1:840:all:10'], 'USA reporter from batch 2 must be present in trends');
    assert.equal(
      trends['trade:tariffs:v1:840:all:10'].datapoints[0].tariffRate,
      3.4,
      'datapoint from the surviving batch must be intact',
    );
  });
});

describe('fetchTradeFlows: batches reporters instead of one request per reporter', () => {
  // biovita cost-incident follow-up (2026-09-23): the old loop fired one
  // fetchFlowPair call (2 wtoFetch requests) per ALL_REPORTERS entry plus a
  // 500ms sleep, hitting Cloud Run's 120s request timeout on a real
  // ~239-reporter fallback list before any fetch latency was even counted.
  // This is a direct regression test for that incident, not just the
  // batching mechanism in the abstract: it fails if a future edit reverts
  // fetchTradeFlowsWorld back to a per-reporter loop.
  it('groups a 65-reporter world sweep into 3 batches, not 65 individual requests', async () => {
    const reporters = Array.from({ length: 65 }, (_, i) => String(100 + i));
    _setAllReportersForTesting(reporters);

    let worldCallCount = 0;
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.includes('api.wto.org/timeseries/v1/data')) {
        throw new Error(`Unexpected fetch URL in test: ${url}`);
      }
      const parsed = new URL(url);
      const rParam = parsed.searchParams.get('r');
      const reporterCodes = rParam.split(',');
      if (reporterCodes.length > 1) worldCallCount++; // world batch (comma-joined r)
      return new Response(JSON.stringify({
        Dataset: reporterCodes.map((code) => ({
          ReportingEconomyCode: code,
          ReportingEconomy: `Reporter ${code}`,
          Year: 2025,
          Value: Number(code), // distinct per reporter so cross-contamination would be caught
        })),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const flows = await fetchTradeFlows();

    // 65 reporters / BATCH=30 = 3 batches × 2 indicators (exports+imports) = 6 world calls,
    // vs. the old 65 × 2 = 130. The exact assertion (6, not <65*2) is what catches a
    // regression back to the per-reporter loop.
    assert.equal(worldCallCount, 6, 'world sweep must batch into 3 groups of <=30 reporters, not one call per reporter');

    // Disaggregation correctness: each reporter's own value lands under its own key,
    // not merged/overwritten by a batch-mate.
    assert.equal(flows['trade:flows:v1:100:000:10'].flows[0].exportValueUsd, 100);
    assert.equal(flows['trade:flows:v1:164:000:10'].flows[0].exportValueUsd, 164);
  });
});

describe('WTO trade-policy severity contract', () => {
  it('derives high/moderate/low bands from the seeded WTO values', () => {
    assert.equal(deriveWtoSeverityStatus(12), 'high');
    assert.equal(deriveWtoSeverityStatus(7), 'moderate');
    assert.equal(deriveWtoSeverityStatus(3), 'low');
  });
});
