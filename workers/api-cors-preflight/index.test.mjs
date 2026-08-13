// Unit tests for the api-cors-preflight Cloudflare Worker.
//
// These run against the Worker module directly with Node's Fetch primitives —
// the Worker only uses standard Request/Response/Headers which Node 22+ has
// natively. No miniflare / wrangler test harness required.
//
// What we pin here:
//   - OPTIONS preflight returns 204 + Access-Control-Allow-Credentials: true
//     (the load-bearing assertion — the 2026-05-27 outage was a missing ACAC).
//   - Allowed origins are echoed verbatim into ACAO.
//   - Disallowed origins fall back to the canonical configured-domain origin
//     (so browsers reject the request rather than the Worker serving an open
//     wildcard).
//   - Non-/api/ paths pass through to fetch() unmodified.
//   - The allow-headers list matches api/_cors.js (drift would silently
//     break preflight for any header the function expects but the Worker
//     forgets).
//
// If you add a new origin pattern, allow-header, or trusted method to
// api/_cors.js, you MUST mirror it here and the assertion will catch the
// gap — that's the point.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import worker, { isAllowedOrigin, buildCorsHeaders, hasPublicCorsPolicy } from './src/index.js';
import { TEST_APP_DOMAIN } from '../../tests/helpers/domain-config.mjs';

function makeRequest(method, url, headers = {}) {
  return new Request(url, { method, headers });
}

// isAllowedOrigin/buildCorsHeaders take the configured domain as an explicit
// parameter (Workers have no process.env — see src/index.js) — TEST_APP_DOMAIN
// is passed at every direct call site below, and TEST_ENV mirrors the
// wrangler.toml [vars] shape for every worker.fetch(req, env) call.
const CANONICAL_FALLBACK = `https://${TEST_APP_DOMAIN}`;
const KNOWN_GOOD = `https://www.${TEST_APP_DOMAIN}`;
const TEST_ENV = { APP_DOMAIN: TEST_APP_DOMAIN };
const ACAH_EXPECTED = 'Content-Type, Authorization, X-WorldMonitor-Key, X-Api-Key, X-Widget-Key, X-Pro-Key, X-WorldMonitor-Desktop-Timestamp, X-WorldMonitor-Desktop-Signature, Idempotency-Key, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID';
const ACEH_EXPECTED = 'Mcp-Session-Id, WWW-Authenticate, Retry-After, Idempotency-Key, Idempotent-Replayed, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-WorldMonitor-Bbox, X-WorldMonitor-Bbox-Missing, X-WorldMonitor-Bbox-Invalid, X-Military-Bbox';
// Must be a superset of every method any api/* route advertises. DELETE was
// originally listed for api/product-catalog.js's purge endpoint; that route
// is gone (retired 2026-08-13) and a full re-audit the same day (hand-written
// api/*.ts routes, server/gateway.ts's sebuf RPC dispatch, and every
// server/worldmonitor/**/*.proto) found nothing else needs it, so it was
// dropped — see src/index.js's own comment. Regression this guards: Worker
// omits a method some route needs → that route's authenticated requests
// silently fail preflight in prod.
const ACAM_EXPECTED = 'GET, POST, HEAD, OPTIONS';

// --- allowlist coverage ---------------------------------------------------

test('isAllowedOrigin accepts apex domain and subdomains', () => {
  assert.equal(isAllowedOrigin(`https://${TEST_APP_DOMAIN}`, TEST_APP_DOMAIN), true);
  assert.equal(isAllowedOrigin(`https://www.${TEST_APP_DOMAIN}`, TEST_APP_DOMAIN), true);
  assert.equal(isAllowedOrigin(`https://tech.${TEST_APP_DOMAIN}`, TEST_APP_DOMAIN), true);
  assert.equal(isAllowedOrigin(`https://commodity.${TEST_APP_DOMAIN}`, TEST_APP_DOMAIN), true);
});

test('isAllowedOrigin accepts Vercel preview deploys under the eliewm team scope (mirrors api/_cors.js)', () => {
  // The project deploys previews under the "eliewm" Vercel team scope, so URLs
  // end in `-eliewm.vercel.app` (git-branch alias AND hash deployment forms).
  // This pattern is a Vercel team-scope identifier, not a domain brand, so it
  // stays hardcoded regardless of the configured APP_DOMAIN (mirrors
  // api/_cors.js). The Worker MUST mirror api/_cors.js exactly — if it stays
  // narrower, eliewm preview preflights echo the canonical fallback origin
  // and the browser blocks them before the request ever reaches Vercel.
  assert.equal(isAllowedOrigin('https://worldmonitor-git-feat-x-eliewm.vercel.app', TEST_APP_DOMAIN), true);
  assert.equal(isAllowedOrigin('https://worldmonitor-r6q9o-eliewm.vercel.app', TEST_APP_DOMAIN), true);
  // Tight allowlist: a foreign team scope, a non-worldmonitor app, and the
  // retired personal scope (worldmonitor-*-elie-<hash>, migration complete)
  // must all stay rejected. Never a bare *.vercel.app.
  assert.equal(isAllowedOrigin('https://worldmonitor-feat-x-attacker.vercel.app', TEST_APP_DOMAIN), false);
  assert.equal(isAllowedOrigin('https://some-other-app-eliewm.vercel.app', TEST_APP_DOMAIN), false);
  assert.equal(isAllowedOrigin('https://worldmonitor-abc-elie-habib.vercel.app', TEST_APP_DOMAIN), false);
});

test('isAllowedOrigin accepts Tauri desktop runtime origins', () => {
  assert.equal(isAllowedOrigin('tauri://localhost', TEST_APP_DOMAIN), true);
  assert.equal(isAllowedOrigin('asset://localhost', TEST_APP_DOMAIN), true);
  assert.equal(isAllowedOrigin('http://tauri.localhost', TEST_APP_DOMAIN), true);
  assert.equal(isAllowedOrigin('https://tauri.localhost:1420', TEST_APP_DOMAIN), true);
  assert.equal(isAllowedOrigin('http://app.tauri.localhost', TEST_APP_DOMAIN), true);
});

test('isAllowedOrigin rejects unrelated origins', () => {
  assert.equal(isAllowedOrigin('https://evil.com', TEST_APP_DOMAIN), false);
  assert.equal(isAllowedOrigin(`https://${TEST_APP_DOMAIN}.evil.com`, TEST_APP_DOMAIN), false);
  assert.equal(isAllowedOrigin(`https://not${TEST_APP_DOMAIN}`, TEST_APP_DOMAIN), false);
  assert.equal(isAllowedOrigin('', TEST_APP_DOMAIN), false);
});

// --- CORS header shape ----------------------------------------------------

test('buildCorsHeaders echoes allowed origin and includes credentials flag', () => {
  const h = buildCorsHeaders(KNOWN_GOOD, TEST_APP_DOMAIN);
  assert.equal(h['Access-Control-Allow-Origin'], KNOWN_GOOD);
  assert.equal(h['Access-Control-Allow-Credentials'], 'true');
  assert.equal(h['Vary'], 'Origin');
});

test('buildCorsHeaders falls back to canonical origin for disallowed origins', () => {
  const h = buildCorsHeaders('https://evil.com', TEST_APP_DOMAIN);
  assert.equal(h['Access-Control-Allow-Origin'], CANONICAL_FALLBACK);
  // Still must set ACAC: true; missing it would 'work' for opaque requests
  // but the browser CORS gate compares the echoed origin to the request
  // origin and rejects the mismatch — which is the correct disposition.
  assert.equal(h['Access-Control-Allow-Credentials'], 'true');
});

test('buildCorsHeaders Access-Control-Allow-Headers matches api/_cors.js', () => {
  const h = buildCorsHeaders(KNOWN_GOOD, TEST_APP_DOMAIN);
  assert.equal(h['Access-Control-Allow-Headers'], ACAH_EXPECTED);
});

test('buildCorsHeaders Access-Control-Expose-Headers matches api/_cors.js', () => {
  const h = buildCorsHeaders(KNOWN_GOOD, TEST_APP_DOMAIN);
  assert.equal(h['Access-Control-Expose-Headers'], ACEH_EXPECTED);
});

// --- preflight short-circuit (the load-bearing branch) --------------------

test('OPTIONS preflight returns 204 with Access-Control-Allow-Credentials: true', async () => {
  const req = makeRequest('OPTIONS', `https://api.${TEST_APP_DOMAIN}/api/bootstrap?tier=fast`, {
    Origin: KNOWN_GOOD,
    'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'content-type',
  });
  const resp = await worker.fetch(req, TEST_ENV);
  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get('access-control-allow-origin'), KNOWN_GOOD);
  assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(resp.headers.get('access-control-allow-methods'), ACAM_EXPECTED);
  assert.equal(resp.headers.get('access-control-allow-headers'), ACAH_EXPECTED);
  assert.equal(resp.headers.get('access-control-expose-headers'), ACEH_EXPECTED);
  assert.equal(resp.headers.get('vary'), 'Origin');
});

test('OPTIONS preflight from disallowed origin still sets ACAC but echoes fallback origin', async () => {
  const req = makeRequest('OPTIONS', `https://api.${TEST_APP_DOMAIN}/api/bootstrap`, {
    Origin: 'https://evil.com',
  });
  const resp = await worker.fetch(req, TEST_ENV);
  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get('access-control-allow-origin'), CANONICAL_FALLBACK);
  // Browser sees fallback origin != evil.com → rejects. ACAC: true is still
  // set because it must be a paired invariant with origin-specific ACAO.
  assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
});

// --- pass-through for non-/api/ paths -------------------------------------

test('non-/api/ paths bypass CORS injection and call fetch directly', async () => {
  // The Worker's first-line guard returns fetch(request) for any path outside
  // /api/. We can't run a live fetch here, but we can confirm the branch is
  // taken by stubbing globalThis.fetch.
  const original = globalThis.fetch;
  let received;
  globalThis.fetch = async (req) => {
    received = req;
    return new Response('ok', { status: 200 });
  };
  try {
    const req = makeRequest('GET', `https://api.${TEST_APP_DOMAIN}/health-check`, {
      Origin: KNOWN_GOOD,
    });
    const resp = await worker.fetch(req, TEST_ENV);
    assert.equal(resp.status, 200);
    // CORS headers should NOT be injected on pass-through, because the
    // Worker treats non-/api/ paths as out of scope.
    assert.equal(resp.headers.get('access-control-allow-credentials'), null);
    assert.equal(received instanceof Request, true);
  } finally {
    globalThis.fetch = original;
  }
});

// --- non-OPTIONS response injection ---------------------------------------

test('GET response from origin has CORS headers stamped by the Worker', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Simulate Vercel function setting its own (older) ACAO. The Worker
      // should override with the canonical Worker-computed value so there's
      // ONE source of truth.
      'Access-Control-Allow-Origin': 'https://stale-origin.example.com',
    },
  });
  try {
    const req = makeRequest('GET', `https://api.${TEST_APP_DOMAIN}/api/health`, {
      Origin: KNOWN_GOOD,
    });
    const resp = await worker.fetch(req, TEST_ENV);
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('access-control-allow-origin'), KNOWN_GOOD);
    assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(resp.headers.get('access-control-expose-headers'), ACEH_EXPECTED);
    assert.equal(resp.headers.get('content-type'), 'application/json');
  } finally {
    globalThis.fetch = original;
  }
});

test('GET response preserves function-specific exposed headers (bootstrap U3a regression)', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Expose-Headers': [
        'Server-Timing',
        'X-WorldMonitor-Bootstrap-Redis-Duration',
        'Age',
        'X-Vercel-Cache',
        'CF-Cache-Status',
        // A baseline name must not be duplicated when the lists are merged.
        'Retry-After',
      ].join(', '),
    },
  });
  try {
    const req = makeRequest('GET', `https://api.${TEST_APP_DOMAIN}/api/bootstrap?tier=slow&public=1`, {
      Origin: KNOWN_GOOD,
    });
    const resp = await worker.fetch(req, TEST_ENV);
    assert.equal(
      resp.headers.get('access-control-expose-headers'),
      `${ACEH_EXPECTED}, Server-Timing, X-WorldMonitor-Bootstrap-Redis-Duration, Age, X-Vercel-Cache, CF-Cache-Status`,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('GET response does not preserve function-specific exposed headers outside bootstrap', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Expose-Headers': 'X-Internal-Diagnostic',
    },
  });
  try {
    const req = makeRequest('GET', `https://api.${TEST_APP_DOMAIN}/api/health`, {
      Origin: KNOWN_GOOD,
    });
    const resp = await worker.fetch(req, TEST_ENV);
    assert.equal(resp.headers.get('access-control-expose-headers'), ACEH_EXPECTED);
  } finally {
    globalThis.fetch = original;
  }
});

// --- public-CORS path bypass (MCP / OAuth / discovery / public utilities) ----

test('hasPublicCorsPolicy: exact-match paths', () => {
  assert.equal(hasPublicCorsPolicy('/api/mcp'), true);
  assert.equal(hasPublicCorsPolicy('/api/oauth-protected-resource'), true);
  assert.equal(hasPublicCorsPolicy('/api/security/report'), true);
  assert.equal(hasPublicCorsPolicy('/api/geo'), true);
  assert.equal(hasPublicCorsPolicy('/api/version'), true);
});

test('hasPublicCorsPolicy: prefix paths for nested OAuth + MCP routes', () => {
  // OAuth flows
  assert.equal(hasPublicCorsPolicy('/api/oauth/register'), true);
  assert.equal(hasPublicCorsPolicy('/api/oauth/token'), true);
  assert.equal(hasPublicCorsPolicy('/api/oauth/authorize'), true);
  assert.equal(hasPublicCorsPolicy('/api/oauth/authorize-pro'), true);
  // MCP nested handlers
  assert.equal(hasPublicCorsPolicy('/api/mcp/handler'), true);
  assert.equal(hasPublicCorsPolicy('/api/mcp/anything'), true);
});

test('hasPublicCorsPolicy: rejects WM-app routes (so credentialed flow keeps Worker policy)', () => {
  assert.equal(hasPublicCorsPolicy('/api/health'), false);
  assert.equal(hasPublicCorsPolicy('/api/bootstrap'), false);
  assert.equal(hasPublicCorsPolicy('/api/wm-session'), false);
  assert.equal(hasPublicCorsPolicy('/api/news/v1/list-articles'), false);
  // Tricky prefix collisions that must NOT bypass:
  assert.equal(hasPublicCorsPolicy('/api/mcps'), false); // not the same as /api/mcp/
  assert.equal(hasPublicCorsPolicy('/api/oauth-anything-else'), false); // not /api/oauth/...
  assert.equal(hasPublicCorsPolicy('/api/geographic-data'), false); // not /api/geo
});

test('OPTIONS preflight to /api/mcp from https://claude.ai passes through to Vercel (Worker does NOT short-circuit)', async () => {
  // Regression: PR review caught that the Worker was short-circuiting MCP
  // preflights with the canonical configured-domain fallback origin echo,
  // which blocked claude.ai / claude.com MCP clients. Pin the bypass.
  const original = globalThis.fetch;
  let received;
  globalThis.fetch = async (req) => {
    received = req;
    return new Response(null, {
      status: 204,
      headers: {
        // Simulate Vercel function returning ACAO: * (getPublicCorsHeaders).
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-WorldMonitor-Key',
      },
    });
  };
  try {
    const req = makeRequest('OPTIONS', `https://api.${TEST_APP_DOMAIN}/api/mcp`, {
      Origin: 'https://claude.ai',
      'Access-Control-Request-Method': 'POST',
    });
    const resp = await worker.fetch(req, TEST_ENV);
    assert.ok(received instanceof Request, 'request should have been forwarded to fetch()');
    assert.equal(received.url, `https://api.${TEST_APP_DOMAIN}/api/mcp`);
    assert.equal(resp.status, 204);
    // Vercel's ACAO: * passes through unchanged (Worker did NOT stamp).
    assert.equal(resp.headers.get('access-control-allow-origin'), '*');
    // Worker did NOT inject its own ACAC: true.
    assert.equal(resp.headers.get('access-control-allow-credentials'), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('OPTIONS preflight to /api/oauth/register from https://claude.com passes through (OAuth DCR)', async () => {
  const original = globalThis.fetch;
  let received;
  globalThis.fetch = async (req) => {
    received = req;
    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  };
  try {
    const req = makeRequest('OPTIONS', `https://api.${TEST_APP_DOMAIN}/api/oauth/register`, {
      Origin: 'https://claude.com',
      'Access-Control-Request-Method': 'POST',
    });
    const resp = await worker.fetch(req, TEST_ENV);
    assert.ok(received instanceof Request);
    assert.equal(resp.headers.get('access-control-allow-origin'), '*');
    assert.equal(resp.headers.get('access-control-allow-credentials'), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('GET to /api/oauth/token from https://claude.ai passes Vercel headers through unchanged', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'fake' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Vercel function's ACAO: * MUST survive — Worker must not override.
      'Access-Control-Allow-Origin': '*',
    },
  });
  try {
    const req = makeRequest('POST', `https://api.${TEST_APP_DOMAIN}/api/oauth/token`, {
      Origin: 'https://claude.ai',
      'Content-Type': 'application/json',
    });
    const resp = await worker.fetch(req, TEST_ENV);
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('access-control-allow-origin'), '*');
    assert.equal(resp.headers.get('access-control-allow-credentials'), null);
  } finally {
    globalThis.fetch = original;
  }
});

// --- end public-CORS bypass tests ---------------------------------------------

test('502 fallback when origin throws still includes CORS headers', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('origin down'); };
  try {
    const req = makeRequest('GET', `https://api.${TEST_APP_DOMAIN}/api/health`, {
      Origin: KNOWN_GOOD,
    });
    const resp = await worker.fetch(req, TEST_ENV);
    assert.equal(resp.status, 502);
    assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(resp.headers.get('access-control-allow-origin'), KNOWN_GOOD);
    const body = await resp.json();
    assert.equal(body.error, 'Origin unavailable');
  } finally {
    globalThis.fetch = original;
  }
});
