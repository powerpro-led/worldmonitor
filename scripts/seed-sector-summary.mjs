#!/usr/bin/env node

/**
 * Sector Summary seed — S&P sector ETF day-change + valuation snapshot for the
 * markets sector panel. Writes `market:sectors:v2` (read by the
 * GetSectorSummary RPC) plus the `market:quotes:v1:<sorted sector symbols>`
 * companion key the GetMarketQuotes RPC serves when called with the sector
 * basket.
 *
 * Ported from the `seedSectorSummary()` sub-seed of `ais-relay.cjs`'s
 * `seedAllMarketData` loop — P14 Phase 2 loop-extraction pass (see
 * PLATFORM_ARCHITECTURE.md). This was the ONE sub-seed of that 9-way bundle
 * with no standalone replacement anywhere (the other 8 are covered by
 * seed-market-quotes.mjs / seed-commodity-quotes.mjs / seed-crypto-sectors.mjs
 * and seed-bundle-market-backup.mjs); extracting it unblocks deleting the whole
 * relay Market loop.
 *
 * Verbatim from the relay: SECTOR_SYMBOLS, the Finnhub-then-Yahoo-chart change%
 * cascade, the Yahoo `/v10/finance/quoteSummary` crumb-session valuation fetch,
 * `parseSectorValuation`, and the 150ms inter-request spacing. Two deliberate
 * deviations, both matching the earlier ports in this pass:
 *   1. Yahoo *chart* fetches (the change% fallback) go through the shared
 *      scripts/_yahoo-fetch.mjs (direct → curl-proxy + retry) instead of the
 *      relay's ais-relay-local fetchYahooChartDirect.
 *   2. The quoteSummary valuation fetch keeps its crumb-session + 401-refresh
 *      but drops the relay's curl-proxy fallback + 5-failure cooldown — that
 *      machinery earned its keep in a process pinging every 5min; a 15-min
 *      one-shot cron publishing *best-effort* valuations (the relay already
 *      writes the key with valCount:0) does not need it.
 */

import { loadEnvFile, CHROME_UA, runSeed, sleep, parseYahooChart, writeExtraKey } from './_seed-utils.mjs';
import { fetchYahooJson } from './_yahoo-fetch.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:sectors:v2';
// 2h — matches the relay's MARKET_SEED_TTL. Comfortably above the 30-min
// (1800s) health staleness gate (tests/seed-ttl-outlives-staleness-fleet.test.mjs)
// so a merely-late seeder escalates STALE_SEED→EMPTY in order.
const CACHE_TTL = 7200;

const SECTOR_SYMBOLS = ['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLI', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC', 'SMH'];
// The GetMarketQuotes RPC cache key for the sector basket — same
// `market:quotes:v1:<sorted symbols>` convention seed-market-quotes.mjs and
// seed-commodity-quotes.mjs use for their own baskets.
const QUOTES_KEY = `market:quotes:v1:${[...SECTOR_SYMBOLS].sort().join(',')}`;

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

// ─── Change% sources ────────────────────────────────────────────────────────

async function fetchFinnhubQuote(symbol, apiKey) {
  try {
    const resp = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json', 'X-Finnhub-Token': apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.c === 0 && data.h === 0 && data.l === 0) return null;
    return { price: data.c, changePercent: data.dp };
  } catch {
    return null;
  }
}

async function fetchYahooChange(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const chart = await fetchYahooJson(url, { label: symbol });
    const parsed = parseYahooChart(chart, symbol);
    return parsed ? parsed.change : null;
  } catch (err) {
    console.warn(`  [Yahoo] ${symbol} chart error: ${err.message}`);
    return null;
  }
}

// ─── Yahoo quoteSummary crumb session (valuations — best-effort) ─────────────

const YAHOO_CRUMB_TTL_MS = 30 * 60 * 1000;
let _crumbSession = null;
let _crumbInFlight = null;

async function loadCrumbSession() {
  try {
    // fc.yahoo.com answers 404 by design; the Set-Cookie header is the payload.
    const seed = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': CHROME_UA } });
    const cookie = seed.headers.getSetCookie().map((c) => c.split(';')[0]).filter(Boolean).join('; ');
    if (!cookie) return null;
    const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': CHROME_UA, Cookie: cookie },
    });
    if (!crumbRes.ok) return null;
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.length > 64 || crumb.includes('<')) return null;
    return { cookie, crumb, fetchedAt: Date.now() };
  } catch {
    return null;
  }
}

function getCrumbSession(forceRefresh) {
  if (forceRefresh) { _crumbSession = null; _crumbInFlight = null; }
  const cached = _crumbSession;
  if (cached && Date.now() - cached.fetchedAt < YAHOO_CRUMB_TTL_MS) return Promise.resolve(cached);
  if (!_crumbInFlight) {
    _crumbInFlight = loadCrumbSession().then((session) => {
      _crumbSession = session;
      _crumbInFlight = null;
      return session;
    });
  }
  return _crumbInFlight;
}

async function fetchQuoteSummary(symbol, isCrumbRetry) {
  const session = await getCrumbSession(false);
  const cookie = session ? session.cookie : '';
  const modules = 'summaryDetail,defaultKeyStatistics';
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`
    + (session ? `&crumb=${encodeURIComponent(session.crumb)}` : '');
  try {
    const resp = await fetch(url, {
      headers: Object.assign({ 'User-Agent': CHROME_UA, Accept: 'application/json' }, cookie ? { Cookie: cookie } : {}),
      signal: AbortSignal.timeout(12_000),
    });
    // A crumb can expire server-side without warning — refresh once, then retry.
    if (resp.status === 401 && !isCrumbRetry) {
      await getCrumbSession(true);
      return fetchQuoteSummary(symbol, true);
    }
    if (!resp.ok) return null;
    const data = await resp.json();
    const result = data?.quoteSummary?.result?.[0];
    if (!result) return null;
    const sd = result.summaryDetail || {};
    const ks = result.defaultKeyStatistics || {};
    const raw = (obj) => (typeof obj === 'object' && obj !== null ? (obj.raw ?? obj.fmt ?? null) : (typeof obj === 'number' ? obj : null));
    return {
      trailingPE: raw(sd.trailingPE),
      forwardPE: raw(sd.forwardPE),
      beta: raw(sd.beta) ?? raw(ks.beta3Year),
      ytdReturn: raw(ks.ytdReturn),
      threeYearReturn: raw(ks.threeYearAverageReturn),
      fiveYearReturn: raw(ks.fiveYearAverageReturn),
    };
  } catch {
    return null;
  }
}

function parseSectorValuation(raw) {
  if (!raw) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const tpe = num(typeof raw.trailingPE === 'string' ? parseFloat(raw.trailingPE) : raw.trailingPE);
  const fpe = num(typeof raw.forwardPE === 'string' ? parseFloat(raw.forwardPE) : raw.forwardPE);
  const beta = num(typeof raw.beta === 'string' ? parseFloat(raw.beta) : raw.beta);
  const ytd = num(typeof raw.ytdReturn === 'string' ? parseFloat(raw.ytdReturn) : raw.ytdReturn);
  const y3 = num(typeof raw.threeYearReturn === 'string' ? parseFloat(raw.threeYearReturn) : raw.threeYearReturn);
  const y5 = num(typeof raw.fiveYearReturn === 'string' ? parseFloat(raw.fiveYearReturn) : raw.fiveYearReturn);
  if (tpe === null && fpe === null) return null;
  return { trailingPE: tpe, forwardPE: fpe, beta, ytdReturn: ytd, threeYearReturn: y3, fiveYearReturn: y5 };
}

// ─── Seed ──────────────────────────────────────────────────────────────────

async function fetchSectorSummary() {
  const sectors = [];

  if (FINNHUB_API_KEY) {
    const results = await Promise.all(SECTOR_SYMBOLS.map((s) => fetchFinnhubQuote(s, FINNHUB_API_KEY)));
    for (let i = 0; i < SECTOR_SYMBOLS.length; i++) {
      const r = results[i];
      if (r) sectors.push({ symbol: SECTOR_SYMBOLS[i], name: SECTOR_SYMBOLS[i], change: r.changePercent });
    }
  }

  if (sectors.length === 0) {
    for (const s of SECTOR_SYMBOLS) {
      const change = await fetchYahooChange(s);
      if (change != null) sectors.push({ symbol: s, name: s, change });
      await sleep(150);
    }
  }

  if (sectors.length === 0) {
    // declareRecords → 0 → runSeed RETRY: last-good preserved, TTL extended,
    // next 15-min tick retries. Mirrors the relay loop's "No sector data
    // fetched — skipping Redis write" branch.
    throw new Error('[Sector] No sector data fetched from Finnhub or Yahoo');
  }

  const valuations = {};
  let valCount = 0;
  for (const s of SECTOR_SYMBOLS) {
    const raw = await fetchQuoteSummary(s);
    const parsed = parseSectorValuation(raw);
    if (parsed) { valuations[s] = parsed; valCount++; }
    await sleep(150);
  }

  console.log(`  ${sectors.length}/${SECTOR_SYMBOLS.length} sectors, ${valCount} valuations`);
  return { sectors, valuations };
}

function validate(data) {
  return !!data && Array.isArray(data.sectors) && data.sectors.length >= 1;
}

export function declareRecords(data) {
  return Array.isArray(data?.sectors) ? data.sectors.length : 0;
}

// afterPublish: write the sector-basket GetMarketQuotes cache companion, the
// same shape the relay's seedSectorSummary wrote alongside market:sectors:v2.
// Best-effort — a failure here must not fail the canonical publish.
async function writeQuotesCompanion(data) {
  const sectorQuotes = data.sectors.map((s) => ({
    symbol: s.symbol, name: s.name, display: s.name,
    price: 0, change: s.change, sparkline: [],
  }));
  const quotesPayload = { quotes: sectorQuotes, finnhubSkipped: false, skipReason: '', rateLimited: false };
  try {
    await writeExtraKey(QUOTES_KEY, quotesPayload, CACHE_TTL);
    console.log(`  Wrote ${QUOTES_KEY}: ${sectorQuotes.length} quotes`);
  } catch (e) {
    console.warn(`  Quotes-companion write failed: ${e.message} — canonical key is published`);
  }
}

runSeed('market', 'sectors', CANONICAL_KEY, fetchSectorSummary, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'market-sectors',

  declareRecords,
  schemaVersion: 1,
  // 30min — matches api/health.js's SEED_META.sectors.maxStaleMin (cron every
  // 15min; 30 = 2x). That entry predates this script.
  maxStaleMin: 30,
  afterPublish: writeQuotesCompanion,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
