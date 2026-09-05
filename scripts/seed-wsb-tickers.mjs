#!/usr/bin/env node

/**
 * WSB Ticker Scanner seed — scans r/wallstreetbets + r/stocks + r/investing
 * "hot" posts for stock-ticker mentions, scores them by mention count ×
 * log(total score), and stores the top 50 under intelligence:wsb-tickers:v1 so
 * the existing GetWsbTickers RPC serves them without changes.
 *
 * Ported from the startWsbTickersSeedLoop() that used to live inside
 * scripts/ais-relay.cjs (P14 Phase 2 loop-extraction pass — see
 * PLATFORM_ARCHITECTURE.md). Reddit fetching (ScrapeCreators → OAuth → public
 * precedence, token cache, vendor-post normalization) moved verbatim to the
 * shared scripts/_reddit-hot.cjs. The 500 ms inter-subreddit spacing is kept.
 * No @notification-source tag — this loop never called publishNotificationEvent.
 */

import { createRequire } from 'node:module';
import { loadEnvFile, CHROME_UA, runSeed, readCanonicalValue } from './_seed-utils.mjs';

const require = createRequire(import.meta.url);
const { fetchRedditHotListing } = require('./_reddit-hot.cjs');

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:wsb-tickers:v1';
// 12h — STRICTLY > api/health.js's SEED_META.wsbTickers.maxStaleMin (540min /
// 9h) so a late seeder surfaces STALE_SEED before the key expires to EMPTY.
// Same value the relay loop used (WSB_TICKERS_TTL); already clears the gate.
const CACHE_TTL = 43_200;
const BOOTSTRAP_KEY = 'market:stocks-bootstrap:v1';
const WSB_SUBREDDITS = ['wallstreetbets', 'stocks', 'investing'];

// $-prefixed: case-insensitive ($nvda, $NVDA, $BRK.B). Bare: uppercase only (NVDA, BRK.B).
// $-prefixed tickers skip whitelist validation (strong signal). Bare uppercase validated against known set.
const DOLLAR_TICKER_REGEX = /\$([a-zA-Z]{1,5}(?:[.-][a-zA-Z]{1,2})?)\b/g;
const BARE_TICKER_REGEX = /\b([A-Z]{1,5}(?:[.-][A-Z]{1,2})?)\b/g;
const TICKER_BLACKLIST = new Set([
  'I', 'A', 'ALL', 'FOR', 'THE', 'CEO', 'GDP', 'IPO', 'SEC', 'FDA', 'IMF', 'ETF', 'ATH',
  'DD', 'YOLO', 'FOMO', 'FUD', 'HODL', 'WSB', 'USA', 'EU', 'UK', 'AI', 'EV', 'IT', 'OR',
  'AM', 'PM', 'ON', 'BE', 'SO', 'GO', 'AT', 'TO', 'UP', 'NO', 'IF', 'AS', 'BY', 'AN', 'DO',
  'IN', 'OF', 'IS', 'HAS', 'NEW', 'CFO', 'CTO', 'IRS', 'FBI', 'CIA', 'UN', 'WHO',
  'IMO', 'PSA', 'FYI', 'TL', 'DR', 'OP', 'OC', 'US', 'ER', 'RE', 'VS',
]);

async function loadWsbTickerSet() {
  try {
    const data = await readCanonicalValue(BOOTSTRAP_KEY);
    if (data && Array.isArray(data.quotes)) {
      return new Set(data.quotes.map((s) => s.symbol?.toUpperCase()).filter(Boolean));
    }
  } catch { /* fall through to empty set */ }
  return new Set();
}

async function fetchWsbRedditHot(subreddit) {
  const { ok, status, posts, source } = await fetchRedditHotListing(subreddit, { limit: 50, legacyUserAgent: CHROME_UA });
  if (!ok) { console.warn(`  Reddit r/${subreddit} HTTP ${status} (${source})`); return []; }
  return posts;
}

function normalizeTicker(raw) {
  // BRK.B → BRK-B (Yahoo Finance uses dash, Reddit uses dot)
  return raw.toUpperCase().replace(/\./g, '-');
}

function extractTickers(text, knownTickers) {
  const found = new Set();
  if (!text) return found;
  let m;

  // $-prefixed tickers: strong signal, skip whitelist validation (only blacklist)
  DOLLAR_TICKER_REGEX.lastIndex = 0;
  while ((m = DOLLAR_TICKER_REGEX.exec(text)) !== null) {
    const sym = normalizeTicker(m[1] || '');
    if (!sym || sym.length < 1) continue;
    if (TICKER_BLACKLIST.has(sym)) continue;
    found.add(sym);
  }

  // Bare uppercase: high false-positive risk, REQUIRE known ticker set
  // When knownTickers is empty (bootstrap unavailable), skip bare matching entirely
  if (knownTickers.size > 0) {
    BARE_TICKER_REGEX.lastIndex = 0;
    while ((m = BARE_TICKER_REGEX.exec(text)) !== null) {
      const sym = normalizeTicker(m[1] || '');
      if (!sym || sym.length < 1) continue;
      if (TICKER_BLACKLIST.has(sym)) continue;
      if (!knownTickers.has(sym)) continue;
      found.add(sym);
    }
  }

  return found;
}

async function fetchWsbTickers() {
  const knownTickers = await loadWsbTickerSet();
  if (knownTickers.size === 0) {
    console.warn('  Known ticker set empty (bootstrap unavailable). $-prefixed tickers will still be extracted; bare uppercase validation disabled.');
  }
  const tickerMap = new Map();
  let postsScanned = 0;

  for (const sub of WSB_SUBREDDITS) {
    await new Promise((r) => setTimeout(r, 500));
    const posts = await fetchWsbRedditHot(sub);
    for (const p of posts) {
      postsScanned++;
      const text = `${p.title || ''} ${p.selftext || ''}`;
      const tickers = extractTickers(text, knownTickers);
      for (const sym of tickers) {
        let entry = tickerMap.get(sym);
        if (!entry) {
          entry = {
            symbol: sym,
            mentionCount: 0,
            postIds: new Set(),
            totalScore: 0,
            upvoteRatioSum: 0,
            topPost: null,
            subreddits: new Set(),
          };
          tickerMap.set(sym, entry);
        }
        entry.mentionCount++;
        entry.postIds.add(p.id);
        entry.totalScore += (p.score || 0);
        entry.upvoteRatioSum += (p.upvote_ratio || 0);
        entry.subreddits.add(sub);
        if (!entry.topPost || (p.score || 0) > entry.topPost.score) {
          entry.topPost = {
            title: String(p.title || '').slice(0, 300),
            url: `https://reddit.com${p.permalink || ''}`,
            score: p.score || 0,
            subreddit: sub,
          };
        }
      }
    }
  }

  const tickers = [];
  for (const [, entry] of tickerMap) {
    const uniquePosts = entry.postIds.size;
    const avgUpvoteRatio = uniquePosts > 0 ? Math.round((entry.upvoteRatioSum / uniquePosts) * 100) / 100 : 0;
    const ageFactor = 1; // all posts are "hot" (recent)
    const velocityScore = Math.round(Math.log1p(entry.totalScore) * entry.mentionCount * ageFactor * 10) / 10;
    tickers.push({
      symbol: entry.symbol,
      mentionCount: entry.mentionCount,
      uniquePosts,
      totalScore: entry.totalScore,
      avgUpvoteRatio,
      topPost: entry.topPost,
      subreddits: [...entry.subreddits],
      velocityScore,
    });
  }

  tickers.sort((a, b) => b.velocityScore - a.velocityScore);
  const top = tickers.slice(0, 50);
  console.log(`  ${top.length} tickers from ${postsScanned} posts across ${WSB_SUBREDDITS.length} subreddits`);
  return { tickers: top, fetchedAt: Date.now(), subredditsScanned: WSB_SUBREDDITS.length, postsScanned };
}

function validate(data) {
  // Matches the relay loop: an empty tickerMap (no tickers OR every Reddit
  // fetch failed) takes the RETRY path — last-good TTL extended, nothing
  // overwritten.
  return !!data && Array.isArray(data.tickers) && data.tickers.length > 0;
}

export function declareRecords(data) {
  return Array.isArray(data?.tickers) ? data.tickers.length : 0;
}

runSeed('intelligence', 'wsb-tickers', CANONICAL_KEY, fetchWsbTickers, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'wsb-tickers',

  declareRecords,
  schemaVersion: 1,
  // 540min — matches api/health.js's SEED_META.wsbTickers.maxStaleMin (relay
  // loop every 3h; 540 = 3x interval). CACHE_TTL (720min) is strictly greater.
  maxStaleMin: 540,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
