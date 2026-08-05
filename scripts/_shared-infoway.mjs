// @ts-check
/**
 * Shared Infoway API fetch helpers for seed scripts.
 * Docs: https://docs.infoway.io/en-docs/readme/u.s.-stock-market-data-api
 */

import { CHROME_UA, sleep } from './_seed-utils.mjs';

const INFOWAY_BATCH = 100;
const INFOWAY_BATCH_DELAY_MS = 500;
const INFOWAY_TIMEOUT_MS = 15_000;
const INFOWAY_SPARKLINE_POINTS = 30;
// klineType=8 is Infoway's daily-candle interval code.
const KLINE_TYPE_DAILY = 8;

async function infowayFetch(url, body, apiKey, label) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) await sleep(1000);
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': CHROME_UA,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(INFOWAY_TIMEOUT_MS),
      });
      if (!resp.ok) {
        console.warn(`  [Infoway] ${label} HTTP ${resp.status}`);
        if (attempt === 0) continue;
        return null;
      }
      return resp;
    } catch (err) {
      console.warn(`  [Infoway] ${label} error: ${err.message}`);
      if (attempt === 0) continue;
      return null;
    }
  }
  return null;
}

/**
 * Fetch daily-candle bulk quotes from Infoway. Batches up to 100 symbols per call.
 * `symbols` must be bare US tickers (e.g. "AAPL") — this function appends ".US".
 * Returns a Map of bare symbol → { price, change, sparkline }.
 *
 * @param {string[]} symbols
 * @param {string} apiKey
 * @returns {Promise<Map<string, { price: number; change: number; sparkline: number[] }>>}
 */
export async function fetchInfowayBulkQuotes(symbols, apiKey) {
  if (symbols.length === 0) return new Map();
  const results = new Map();
  const url = 'https://data.infoway.io/stock/v2/batch_kline';

  for (let i = 0; i < symbols.length; i += INFOWAY_BATCH) {
    if (i > 0) await sleep(INFOWAY_BATCH_DELAY_MS);
    const chunk = symbols.slice(i, i + INFOWAY_BATCH);
    const codes = chunk.map((s) => `${s}.US`).join(',');
    const body = {
      klineType: KLINE_TYPE_DAILY,
      klineNum: INFOWAY_SPARKLINE_POINTS,
      codes,
      timestamp: Math.floor(Date.now() / 1000),
    };
    const resp = await infowayFetch(url, body, apiKey, 'batch_kline');
    if (!resp) continue;
    try {
      const json = await resp.json();
      if (json.ret !== 200) {
        console.warn(`  [Infoway] batch_kline non-200 ret: ${json.ret} ${json.msg || ''}`.trim());
        continue;
      }
      if (!Array.isArray(json.data)) {
        console.warn('  [Infoway] Unexpected response:', JSON.stringify(json).slice(0, 200));
        continue;
      }
      for (const item of json.data) {
        const symbol = String(item.s || '').replace(/\.US$/, '');
        const respList = Array.isArray(item.respList) ? item.respList : [];
        if (!symbol || respList.length === 0) continue;
        // respList[0] is the most recent candle (newest-first).
        const latest = respList[0];
        const price = parseFloat(latest.c);
        if (!Number.isFinite(price) || price <= 0) continue;
        const change = parseFloat(String(latest.pc || '0').replace('%', ''));
        const sparkline = respList
          .slice()
          .reverse()
          .map((r) => parseFloat(r.c))
          .filter(Number.isFinite);
        results.set(symbol, { price, change: Number.isFinite(change) ? change : 0, sparkline });
      }
    } catch (err) {
      console.warn(`  [Infoway] batch_kline parse error: ${err.message}`);
    }
  }

  return results;
}
