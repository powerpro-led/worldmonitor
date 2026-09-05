// Reddit "hot" listing fetch — shared by seed-social-velocity.mjs and
// seed-wsb-tickers.mjs.
//
// Ported verbatim from the block that used to live inside scripts/ais-relay.cjs
// ("Reddit data fetch (shared across social-velocity + WSB tickers)") when both
// consumer loops were extracted to standalone crons (P14 Phase 2, session 63 —
// see PLATFORM_ARCHITECTURE.md).
//
// Reddit's Responsible Builder Policy (2026) serves an HTML 403 to the
// unauthenticated www.reddit.com/r/<sub>/hot.json endpoint regardless of exit
// IP or User-Agent (verified 2026-06-05: residential IP, Decodo residential
// proxy, browser UA, and WM UA ALL 403 with the same HTML block page — it is a
// policy block on the endpoint, NOT an IP/UA block, so a proxy does not help)
// AND removed self-serve API-app creation, so a NEW OAuth app cannot be made.
// Both consumers route through fetchRedditHotListing(); see its own comment for
// the ScrapeCreators → OAuth → public path precedence. OAuth (usable only with
// pre-policy app creds) and the public endpoint are kept as fallbacks (the
// public path is today's no-cred default that surfaces SEED_ERROR — no
// regression when no key is set).
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID || '';
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET || '';
const REDDIT_OAUTH_ENABLED = !!(REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET);
// Reddit requires a unique, descriptive UA: "<platform>:<appid>:<version> (by
// /u/<username>)". Set REDDIT_USER_AGENT to include the developer's reddit
// username so requests are attributable per Reddit's API rules.
const REDDIT_USER_AGENT = process.env.REDDIT_USER_AGENT || 'server:app.worldmonitor:1.0 (by /u/worldmonitor)';
const REDDIT_AUTH_COOLDOWN_MS = 5 * 60 * 1000;

// ScrapeCreators — third-party Reddit data vendor (same key /last30days uses).
// PREFERRED path: it's the only one that works now that Reddit 403s the public
// .json endpoint AND removed self-serve API-app creation (Responsible Builder
// Policy 2026). Returns native Reddit fields in a flat `posts` array, so the
// downstream consumers are unchanged. When unset, we fall back to OAuth
// (pre-policy creds only) then the public endpoint — today's behavior, no regression.
// Sanitize: trim whitespace and strip surrounding quotes — straight AND curly
// (U+2018/U+2019/U+201C/U+201D). A smart-quote pasted into the env var makes the
// `x-api-key` header un-encodable ("Cannot convert argument to a ByteString …
// value 8221") which throws on EVERY fetch and silently disables the vendor path
// (observed in prod 2026-06-06). Stripping surrounding quotes makes the common
// paste mistake harmless; a clear warning fires if a non-Latin1 byte survives.
const SCRAPECREATORS_API_KEY = (process.env.SCRAPECREATORS_API_KEY || '')
  .trim()
  .replace(/^[\s"'‘’“”]+|[\s"'‘’“”]+$/g, '');
if (SCRAPECREATORS_API_KEY && /[^ -ÿ]/.test(SCRAPECREATORS_API_KEY)) {
  console.warn('[Reddit] SCRAPECREATORS_API_KEY contains a non-Latin1 character (likely a smart quote or stray Unicode) — the vendor path will fail to build its header. Re-paste the key as plain ASCII.');
}
const SCRAPECREATORS_ENABLED = !!SCRAPECREATORS_API_KEY;
// The SC subreddit endpoint has no `limit` param — only `after` cursor pagination.
// Cap the page walk so a caller asking for `limit` posts can't run away on credits
// (≈25 posts/page → 4 pages covers WSB's limit:50 with headroom).
const SC_MAX_PAGES = 4;

let _redditToken = null;
let _redditTokenExpiry = 0;
let _redditTokenPromise = null;
let _redditAuthCooldownUntil = 0;

async function _fetchRedditToken() {
  const basic = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64');
  const resp = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': REDDIT_USER_AGENT,
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`token HTTP ${resp.status}`);
  const json = await resp.json();
  if (!json.access_token) throw new Error(`no access_token (${json.error || 'unknown'})`);
  return { token: json.access_token, expiresIn: Number(json.expires_in) || 3600 };
}

// Returns a cached userless bearer token, or null when auth is unavailable.
// Single-flight (concurrent callers share one in-flight fetch) with a 5-min
// cooldown after a failure so a broken credential doesn't hammer the auth
// endpoint every seed cycle.
async function getRedditToken() {
  const now = Date.now();
  if (_redditToken && now < _redditTokenExpiry) return _redditToken;
  if (now < _redditAuthCooldownUntil) return null;
  if (_redditTokenPromise) return _redditTokenPromise;
  _redditTokenPromise = (async () => {
    try {
      const { token, expiresIn } = await _fetchRedditToken();
      _redditToken = token;
      _redditTokenExpiry = Date.now() + Math.max(60, expiresIn - 60) * 1000; // refresh 60s early
      console.log(`[Reddit] OAuth token acquired, expires in ${expiresIn}s`);
      return token;
    } catch (e) {
      _redditToken = null;
      _redditTokenExpiry = 0;
      _redditAuthCooldownUntil = Date.now() + REDDIT_AUTH_COOLDOWN_MS;
      console.warn(`[Reddit] OAuth token fetch failed: ${e?.message || e} — cooldown ${REDDIT_AUTH_COOLDOWN_MS / 1000}s`);
      return null;
    } finally {
      _redditTokenPromise = null;
    }
  })();
  return _redditTokenPromise;
}

// Coerce a Reddit timestamp to epoch SECONDS. Native Reddit (and the Reddit
// hosts with raw_json=1) return numeric seconds (~1.7e9); a vendor could hand
// back milliseconds (~1.7e12) or an ISO string. The downstream velocity math
// (ageSec = now/1000 - created_utc) and createdAt (created_utc * 1000) both
// assume seconds, so normalize before the consumers see it.
function _redditEpochSeconds(v) {
  if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n > 1e12 ? Math.floor(n / 1000) : n;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
  }
  return v;
}

// The Reddit hosts pass raw_json=1, which un-escapes &amp; &lt; &gt; in text
// fields. A vendor response may still be HTML-escaped, so decode the few entities
// Reddit emits to keep panel titles identical across paths.
function _decodeRedditEntities(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Normalize a ScrapeCreators post so its shape matches the OAuth/public paths
// exactly (numeric-seconds created_utc, unescaped title/selftext). Other native
// fields (score, upvote_ratio, num_comments, id, permalink, url) pass through.
function _normalizeVendorPost(p) {
  if (!p || typeof p !== 'object') return p;
  return { ...p, created_utc: _redditEpochSeconds(p.created_utc), title: _decodeRedditEntities(p.title), selftext: _decodeRedditEntities(p.selftext) };
}

// Shared "hot" listing fetch for every Reddit consumer. Returns
// { ok, status, posts, source } and never throws on an HTTP status (network/
// timeout errors still bubble to the caller's try/catch). `source` names the
// path that actually ran ('scrapecreators' | 'oauth' | 'public') so the caller's
// SEED_ERROR reason is accurate. Path precedence:
//   1. ScrapeCreators (vendor) when SCRAPECREATORS_API_KEY is set — preferred.
//   2. oauth.reddit.com when REDDIT_CLIENT_ID/SECRET are set (pre-policy app creds).
//   3. public www.reddit.com/.../hot.json (currently 403-walled; correct no-cred default).
// All paths yield the same per-post native field names (score, upvote_ratio,
// num_comments, created_utc, id, title, permalink, url), so downstream consumers
// are unchanged. ScrapeCreators returns a flat `posts` array (normalized via
// _normalizeVendorPost); the Reddit hosts return data.children[].data.
async function fetchRedditHotListing(subreddit, { limit = 25, legacyUserAgent } = {}) {
  // 1. ScrapeCreators (preferred). Cursor-paginate with `after` (the endpoint has
  // NO `limit` param) until we reach `limit` posts or run out of pages, capped at
  // SC_MAX_PAGES to bound credit spend — this preserves the old limit:50 coverage
  // for WSB even if the vendor's first page is smaller. Failure handling honors the
  // ordered-fallback contract: a page-1 HTTP failure (non-2xx) OR page-1 network/
  // timeout/parse throw logs and FALLS THROUGH to OAuth → public; a failure AFTER
  // page 1 keeps the pages already gathered. The loop degrades to first-page-only
  // if the vendor ever omits the `after` cursor.
  if (SCRAPECREATORS_ENABLED) {
    const collected = [];
    let after = '';
    let anyOk = false;
    let lastOkStatus = 0;
    try {
      for (let page = 0; page < SC_MAX_PAGES && collected.length < limit; page++) {
        const scUrl = `https://api.scrapecreators.com/v1/reddit/subreddit?subreddit=${encodeURIComponent(subreddit)}&sort=hot${after ? `&after=${encodeURIComponent(after)}` : ''}`;
        const resp = await fetch(scUrl, {
          headers: { 'x-api-key': SCRAPECREATORS_API_KEY, Accept: 'application/json' },
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) {
          if (collected.length > 0) break; // keep what we already paginated
          console.warn(`[Reddit] ScrapeCreators HTTP ${resp.status} for r/${subreddit} — falling back to OAuth/public`);
          break; // page-1 failure → fall through below
        }
        const data = await resp.json();
        anyOk = true;
        lastOkStatus = resp.status;
        const pagePosts = (Array.isArray(data?.posts) ? data.posts : []).filter(Boolean);
        collected.push(...pagePosts);
        after = typeof data?.after === 'string' ? data.after : '';
        if (!after || pagePosts.length === 0) break; // no more pages
      }
      // anyOk distinguishes "vendor responded (even with 0 posts)" from "page-1
      // failed" — only the latter falls through; a legit empty SC response returns ok.
      if (anyOk) {
        return { ok: true, status: lastOkStatus, posts: collected.slice(0, limit).map(_normalizeVendorPost), source: 'scrapecreators' };
      }
    } catch (e) {
      if (anyOk) {
        console.warn(`[Reddit] ScrapeCreators error after ${collected.length} posts for r/${subreddit}: ${e?.message || e} — using partial ScrapeCreators data`);
        return { ok: true, status: lastOkStatus, posts: collected.slice(0, limit).map(_normalizeVendorPost), source: 'scrapecreators' };
      }
      console.warn(`[Reddit] ScrapeCreators error for r/${subreddit}: ${e?.message || e} — falling back to OAuth/public`);
    }
    // fall through to OAuth → public
  }
  let url;
  let headers;
  let source;
  if (REDDIT_OAUTH_ENABLED) {
    const token = await getRedditToken();
    if (token) {
      url = `https://oauth.reddit.com/r/${subreddit}/hot?limit=${limit}&raw_json=1`;
      headers = { Authorization: `Bearer ${token}`, 'User-Agent': REDDIT_USER_AGENT, Accept: 'application/json' };
      source = 'oauth';
    }
  }
  if (!url) {
    url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}&raw_json=1`;
    headers = { Accept: 'application/json', 'User-Agent': legacyUserAgent || REDDIT_USER_AGENT };
    source = 'public';
  }
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!resp.ok) return { ok: false, status: resp.status, posts: [], source };
  const data = await resp.json();
  return { ok: true, status: resp.status, posts: (data?.data?.children || []).map((c) => c.data).filter(Boolean), source };
}

module.exports = {
  REDDIT_OAUTH_ENABLED,
  REDDIT_USER_AGENT,
  SCRAPECREATORS_ENABLED,
  SC_MAX_PAGES,
  _fetchRedditToken,
  getRedditToken,
  _redditEpochSeconds,
  _decodeRedditEntities,
  _normalizeVendorPost,
  fetchRedditHotListing,
};
