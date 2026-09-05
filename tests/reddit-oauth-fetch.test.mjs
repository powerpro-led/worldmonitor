// Reddit OAuth fetch — source-structure regression tests.
//
// The Reddit "hot" listing fetch (ScrapeCreators → OAuth → public precedence,
// userless client_credentials token with single-flight + cooldown, vendor-post
// normalization) moved out of scripts/ais-relay.cjs into the shared
// scripts/_reddit-hot.cjs when both consumer loops (Social Velocity, WSB
// Tickers) were extracted to standalone crons (P14 Phase 2, session 63 — see
// PLATFORM_ARCHITECTURE.md). These tests assert against that module's source
// text plus the two consumer scripts, pinning the same contract they always did.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const redditSource = readFileSync(resolve(here, '../scripts/_reddit-hot.cjs'), 'utf8');
const socialVelocitySource = readFileSync(resolve(here, '../scripts/seed-social-velocity.mjs'), 'utf8');
const wsbTickersSource = readFileSync(resolve(here, '../scripts/seed-wsb-tickers.mjs'), 'utf8');
const schedulerSource = readFileSync(resolve(here, '../gcp/scheduler/main.ts'), 'utf8');

function fnBody(src, name, approxLen = 1200) {
  const start = src.indexOf(name);
  assert.notEqual(start, -1, `missing function: ${name}`);
  return src.slice(start, start + approxLen);
}

test('reddit oauth is gated on BOTH client id and secret (absent → fallback, no regression)', () => {
  assert.match(redditSource, /const REDDIT_CLIENT_ID = process\.env\.REDDIT_CLIENT_ID \|\| ''/);
  assert.match(redditSource, /const REDDIT_CLIENT_SECRET = process\.env\.REDDIT_CLIENT_SECRET \|\| ''/);
  assert.match(redditSource, /const REDDIT_OAUTH_ENABLED = !!\(REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET\)/);
});

test('token uses userless client_credentials grant with HTTP Basic auth on www.reddit.com', () => {
  const body = fnBody(redditSource, 'async function _fetchRedditToken()');
  assert.match(body, /https:\/\/www\.reddit\.com\/api\/v1\/access_token/);
  assert.match(body, /method: 'POST'/);
  assert.match(body, /Authorization: `Basic \$\{basic\}`/);
  assert.match(body, /body: 'grant_type=client_credentials'/);
  // Reddit requires a descriptive, attributable User-Agent.
  assert.match(redditSource, /const REDDIT_USER_AGENT = process\.env\.REDDIT_USER_AGENT/);
});

test('token is cached single-flight with early refresh and a post-failure cooldown', () => {
  const body = fnBody(redditSource, 'async function getRedditToken()', 900);
  assert.match(body, /if \(_redditToken && now < _redditTokenExpiry\) return _redditToken/);
  assert.match(body, /if \(now < _redditAuthCooldownUntil\) return null/);
  assert.match(body, /if \(_redditTokenPromise\) return _redditTokenPromise/);
  assert.match(body, /_redditTokenExpiry = Date\.now\(\) \+ Math\.max\(60, expiresIn - 60\) \* 1000/);
  assert.match(body, /_redditAuthCooldownUntil = Date\.now\(\) \+ REDDIT_AUTH_COOLDOWN_MS/);
});

test('shared helper prefers oauth.reddit.com and falls back to the public endpoint', () => {
  const body = fnBody(redditSource, 'async function fetchRedditHotListing(subreddit', 5200);
  assert.match(body, /if \(REDDIT_OAUTH_ENABLED\) \{/);
  assert.match(body, /https:\/\/oauth\.reddit\.com\/r\/\$\{subreddit\}\/hot\?limit=\$\{limit\}/);
  assert.match(body, /https:\/\/www\.reddit\.com\/r\/\$\{subreddit\}\/hot\.json\?limit=\$\{limit\}/);
  // never throws on HTTP status — returns a typed result (with source) the callers branch on
  assert.match(body, /if \(!resp\.ok\) return \{ ok: false, status: resp\.status, posts: \[\], source \}/);
});

test('ScrapeCreators is the gated, preferred path with bounded cursor pagination (no limit param)', () => {
  assert.match(
    redditSource,
    /const SCRAPECREATORS_API_KEY = \(process\.env\.SCRAPECREATORS_API_KEY \|\| ''\)\r?\n\s+\.trim\(\)\r?\n\s+\.replace\(\/\^\[\\s"'‘’“”\]\+\|\[\\s"'‘’“”\]\+\$\/g, ''\);\r?\nif \(SCRAPECREATORS_API_KEY && [^\n]+\) \{\r?\n\s+console\.warn\('[^']*non-Latin1 character/,
  );
  assert.match(redditSource, /const SCRAPECREATORS_ENABLED = !!SCRAPECREATORS_API_KEY/);
  assert.match(redditSource, /const SC_MAX_PAGES = 4/);
  const body = fnBody(redditSource, 'async function fetchRedditHotListing(subreddit', 5200);
  assert.match(body, /if \(SCRAPECREATORS_ENABLED\) \{/);
  // subreddit posts endpoint, sort=hot, x-api-key — and NO &limit (endpoint has no such param)
  assert.match(body, /https:\/\/api\.scrapecreators\.com\/v1\/reddit\/subreddit\?subreddit=\$\{encodeURIComponent\(subreddit\)\}&sort=hot/);
  assert.doesNotMatch(body, /scrapecreators\.com[^`]*&limit=/);
  assert.match(body, /'x-api-key': SCRAPECREATORS_API_KEY/);
  // cursor pagination bounded by SC_MAX_PAGES and the requested limit
  assert.match(body, /for \(let page = 0; page < SC_MAX_PAGES && collected\.length < limit; page\+\+\)/);
  assert.match(body, /\$\{after \? `&after=\$\{encodeURIComponent\(after\)\}` : ''\}/);
  assert.match(body, /after = typeof data\?\.after === 'string' \? data\.after : ''/);
  // normalized + capped to limit on success, tagged with source
  assert.match(body, /return \{ ok: true, status: lastOkStatus, posts: collected\.slice\(0, limit\)\.map\(_normalizeVendorPost\), source: 'scrapecreators' \}/);
});

test('ScrapeCreators failure falls through to OAuth/public (page-1 non-2xx OR throw); later-page failure keeps data', () => {
  const body = fnBody(redditSource, 'async function fetchRedditHotListing(subreddit', 5200);
  assert.match(body, /try \{/);
  // a later-page failure keeps the pages already gathered; a page-1 failure logs + falls through
  assert.match(body, /if \(collected\.length > 0\) break;/);
  assert.match(body, /ScrapeCreators HTTP \$\{resp\.status\}/);
  assert.match(body, /catch \(e\) \{/);
  assert.match(body, /if \(anyOk\) \{/);
  assert.match(body, /using partial ScrapeCreators data/);
  assert.match(body, /return \{ ok: true, status: lastOkStatus, posts: collected\.slice\(0, limit\)\.map\(_normalizeVendorPost\), source: 'scrapecreators' \}/);
  assert.match(body, /ScrapeCreators error for r\/\$\{subreddit\}/);
  assert.match(body, /falling back to OAuth\/public/);
  // only a vendor page that parsed successfully (anyOk) returns from the SC branch; else fall through
  assert.doesNotMatch(body, /return \{ ok: false[^}]*source: 'scrapecreators'/);
  assert.doesNotMatch(body, /status: lastStatus/);
});

test('path precedence is ScrapeCreators -> OAuth -> public (ordered in source)', () => {
  const body = fnBody(redditSource, 'async function fetchRedditHotListing(subreddit', 5200);
  const sc = body.indexOf('if (SCRAPECREATORS_ENABLED)');
  const oauth = body.indexOf('if (REDDIT_OAUTH_ENABLED)');
  const pub = body.indexOf('www.reddit.com/r/${subreddit}/hot.json');
  assert.ok(sc !== -1 && oauth !== -1 && pub !== -1, 'all three branches present');
  assert.ok(sc < oauth && oauth < pub, `expected ScrapeCreators < OAuth < public, got ${sc}/${oauth}/${pub}`);
});

test('cadence is 3h and data-key TTL STRICTLY exceeds health maxStaleMin (real STALE_SEED window)', () => {
  assert.match(schedulerSource, /'seed-social-velocity': \{ kind: 'every', rate: '3 hours' \}/);
  assert.match(schedulerSource, /'seed-wsb-tickers': \{ kind: 'every', rate: '3 hours' \}/);
  assert.match(socialVelocitySource, /const CACHE_TTL = 43_200;/);
  assert.match(wsbTickersSource, /const CACHE_TTL = 43_200;/);
  // TTL minutes (43200/60 = 720) must be > health maxStaleMin (540) so a dead
  // cron shows STALE_SEED before the key expires to EMPTY. TTL==maxStaleMin defeats this.
  assert.ok(43200 / 60 > 540, 'data-key TTL minutes must exceed maxStaleMin=540');
});

// Staleness budget is mirrored across THREE surfaces — api/health.js SEED_META,
// the resilience _standalone-source-thresholds.ts, and api/seed-health.js (which
// marks stale at intervalMin * 2). This pins all three to the same 540min budget
// for the Reddit keys so a future cadence edit can't drift one surface silently.
test('seed-health.js Reddit budget (intervalMin*2) matches api/health.js maxStaleMin=540', () => {
  const seedHealth = readFileSync(resolve(here, '../api/seed-health.js'), 'utf8');
  const health = readFileSync(resolve(here, '../api/health.js'), 'utf8');
  for (const key of ['social-reddit', 'wsb-tickers']) {
    const m = seedHealth.match(new RegExp(`intelligence:${key}'[^}]*intervalMin:\\s*(\\d+)`));
    assert.ok(m, `seed-health.js must define intelligence:${key} intervalMin`);
    assert.equal(Number(m[1]) * 2, 540, `seed-health ${key} intervalMin*2 must equal 540`);
  }
  // api/health.js side of the mirror
  assert.match(health, /socialVelocity:.*maxStaleMin: 540/);
  assert.match(health, /wsbTickers:.*maxStaleMin: 540/);
});

test('both reddit consumers route through fetchRedditHotListing and label failures with the real source', () => {
  const social = fnBody(socialVelocitySource, 'async function fetchRedditHot(subreddit, failures', 600);
  assert.match(social, /const \{ ok, status, posts, source \} = await fetchRedditHotListing\(subreddit, \{/);
  // failure label names the path that actually ran (not a hardcoded "(oauth)")
  assert.match(social, /r\/\$\{subreddit\} HTTP \$\{status\} \(\$\{source\}\)/);
  const wsb = fnBody(wsbTickersSource, 'async function fetchWsbRedditHot(subreddit)', 400);
  assert.match(wsb, /const \{ ok, status, posts, source \} = await fetchRedditHotListing\(subreddit, \{ limit: 50/);
  assert.match(wsb, /HTTP \$\{status\} \(\$\{source\}\)/);
  // both consumers pull the helper from the shared module, not a local copy
  assert.match(socialVelocitySource, /require\('\.\/_reddit-hot\.cjs'\)/);
  assert.match(wsbTickersSource, /require\('\.\/_reddit-hot\.cjs'\)/);
  // The old unauthenticated direct fetches inside these two fetchers are gone.
  assert.doesNotMatch(social, /www\.reddit\.com\/r\/\$\{subreddit\}\/hot\.json/);
  assert.doesNotMatch(wsb, /www\.reddit\.com\/r\/\$\{subreddit\}\/hot\.json/);
});

test('helper tags each path with a source for accurate SEED_ERROR reasons', () => {
  const body = fnBody(redditSource, 'async function fetchRedditHotListing(subreddit', 5200);
  assert.match(body, /source: 'scrapecreators'/);
  assert.match(body, /source = 'oauth'/);
  assert.match(body, /source = 'public'/);
});

test('ScrapeCreators posts are normalized to the OAuth/public shape (seconds + unescaped)', () => {
  // created_utc coerced to epoch seconds (ms → s at the 1e12 threshold)
  assert.match(redditSource, /function _redditEpochSeconds\(v\)/);
  assert.match(redditSource, /v > 1e12 \? Math\.floor\(v \/ 1000\) : v/);
  // HTML entities decoded (raw_json=1 equivalent for the vendor path)
  assert.match(redditSource, /function _decodeRedditEntities\(s\)/);
  assert.match(redditSource, /\.replace\(\/&amp;\/g, '&'\)/);
  // normalizer maps the timestamp + text fields, passes the rest through
  assert.match(redditSource, /function _normalizeVendorPost\(p\)/);
  assert.match(redditSource, /created_utc: _redditEpochSeconds\(p\.created_utc\)/);
  assert.match(redditSource, /title: _decodeRedditEntities\(p\.title\)/);
});
