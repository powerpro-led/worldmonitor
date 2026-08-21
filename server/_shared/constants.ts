// Windows platform token, deliberately — NOT cosmetic. Yahoo Finance throttles
// `query1.finance.yahoo.com` per User-Agent, and it 429s the `Macintosh` token
// regardless of Chrome version while serving 200 to the `Windows NT` token from
// the same IP seconds apart (verified 2026-08-20: Mac/131, Mac/139, Mac/141 all
// 429; Win/120, Win/141 all 200; alternating A/B, 5/5 reproducible). This was the
// only Macintosh UA definition in the repo — every other CHROME_UA is already a
// Windows/Linux token, which is why the relay's Yahoo calls got through while
// everything importing THIS constant (analyze-stock, and so the Premium Stock
// Analysis / Backtesting panels) silently returned no data.
//
// NOTE: a per-UA throttle is a rate limit, not an auth wall. If Yahoo request
// volume is the real driver this will decay again — the durable fix is fewer/
// better-cached Yahoo calls, not another UA. See TASKS.md.
export const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

/**
 * Global Yahoo Finance request gate.
 * Ensures minimum spacing between ANY Yahoo requests across all handlers.
 * Multiple handlers calling Yahoo concurrently causes IP-level rate limiting (429).
 */
let yahooLastRequest = 0;
const YAHOO_MIN_GAP_MS = 600;
let yahooQueue: Promise<void> = Promise.resolve();

export function yahooGate(): Promise<void> {
  yahooQueue = yahooQueue.then(async () => {
    const elapsed = Date.now() - yahooLastRequest;
    if (elapsed < YAHOO_MIN_GAP_MS) {
      await new Promise<void>(r => setTimeout(r, YAHOO_MIN_GAP_MS - elapsed));
    }
    yahooLastRequest = Date.now();
  });
  return yahooQueue;
}

/**
 * Global Finnhub request gate.
 * Free-tier Finnhub keys are sensitive to burst concurrency; spacing requests
 * reduces 429 cascades that otherwise spill into Yahoo fallback.
 */
let finnhubLastRequest = 0;
const FINNHUB_MIN_GAP_MS = 350;
let finnhubQueue: Promise<void> = Promise.resolve();

export function finnhubGate(): Promise<void> {
  finnhubQueue = finnhubQueue.then(async () => {
    const elapsed = Date.now() - finnhubLastRequest;
    if (elapsed < FINNHUB_MIN_GAP_MS) {
      await new Promise<void>(r => setTimeout(r, FINNHUB_MIN_GAP_MS - elapsed));
    }
    finnhubLastRequest = Date.now();
  });
  return finnhubQueue;
}
