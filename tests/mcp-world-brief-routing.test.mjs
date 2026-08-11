import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  MCP_DOWNSTREAM_TELEMETRY_KEYS,
  mcpHandler,
} from '../api/mcp.ts';
import { createMcpToolExecutionContext } from '../api/mcp/downstream.ts';
import { callBody } from './helpers/mcp-pro-deps.mjs';

const CANONICAL_API_ORIGIN = 'https://api.worldmonitor.app';
const ENV_KEY = 'operator_test_key_world_brief';
const SECRET_QUERY = 'SECRET_QUERY_SENTINEL_5514';
const SECRET_COOKIE = 'SECRET_COOKIE_SENTINEL_5514';
const SECRET_GEO_CONTEXT = 'SECRET_GEO_CONTEXT_SENTINEL_5514';
const SECRET_RESPONSE_DETAIL = 'SECRET_RESPONSE_DETAIL_SENTINEL_5514';

const HOSTS = [
  { url: 'https://worldmonitor.app/mcp', hostClass: 'apex' },
  { url: 'https://www.worldmonitor.app/mcp', hostClass: 'www' },
  { url: 'https://api.worldmonitor.app/api/mcp', hostClass: 'canonical_api' },
  { url: 'https://tech.worldmonitor.app/mcp', hostClass: 'variant' },
  { url: 'https://finance.worldmonitor.app/mcp', hostClass: 'variant' },
  { url: 'https://commodity.worldmonitor.app/mcp', hostClass: 'variant' },
  { url: 'https://happy.worldmonitor.app/mcp', hostClass: 'variant' },
  { url: 'https://energy.worldmonitor.app/mcp', hostClass: 'variant' },
];

// env_key is the sole MCP credential class now — the historical user_key/pro
// auth kinds (and the internal-MCP HMAC signature they drove on downstream
// fetches) were deleted along with the Convex-backed Pro/API-key tiers.
const AUTH_CASE = {
  kind: 'env_key',
  headers: { 'X-WorldMonitor-Key': ENV_KEY },
};

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

function makeDeps() {
  return {
    // No bearer tokens exercised in this suite — env_key auth never calls
    // resolveBearerToContext, but PRODUCTION_DEPS's shape still requires it.
    resolveBearerToContext: async () => null,
  };
}

function requestFor(url, headers, id = 1) {
  const target = new URL(url);
  target.searchParams.set('sensitive', SECRET_QUERY);
  return new Request(target, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `wm_session=${SECRET_COOKIE}`,
      ...headers,
    },
    body: JSON.stringify(callBody('get_world_brief', {
      geo_context: SECRET_GEO_CONTEXT,
    }, id)),
  });
}

function digestResponse() {
  return new Response(JSON.stringify({
    categories: {
      world: {
        items: [{
          title: 'World brief routing regression headline',
          snippet: 'Grounding body for the issue 5514 regression.',
          source: 'Example Wire',
          link: 'https://example.com/world-brief-routing',
          publishedAt: '2026-07-23T00:00:00.000Z',
        }],
      },
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function downstreamEvents(captured) {
  return captured.filter((line) => (
    line
    && typeof line === 'object'
    && !Array.isArray(line)
    && line.tag === 'mcp.downstream'
  ));
}

beforeEach(() => {
  process.env.WORLDMONITOR_VALID_KEYS = ENV_KEY;
  process.env.MCP_TELEMETRY = 'true';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
});

describe('get_world_brief canonical sibling routing', () => {
  it('preserves non-production origins without exposing them in telemetry tags', () => {
    const cases = [
      {
        url: 'http://localhost:4173/mcp',
        hostClass: 'local',
        origin: 'http://localhost:4173',
      },
      {
        url: 'https://worldmonitor-feature.vercel.app/mcp',
        hostClass: 'vercel_preview',
        origin: 'https://worldmonitor-feature.vercel.app',
      },
      {
        url: 'https://self-hosted.example/mcp',
        hostClass: 'other',
        origin: 'https://self-hosted.example',
      },
    ];

    for (const testCase of cases) {
      const execution = createMcpToolExecutionContext(testCase.url);
      assert.equal(execution.inboundHostClass, testCase.hostClass);
      assert.equal(execution.downstreamOrigin, testCase.origin);
      assert.equal(execution.downstreamOriginTag, testCase.hostClass);
    }
  });

  it('uses the canonical API origin for every supported production host', async () => {
    const captured = [];
    const fetchCalls = [];
    console.log = (line) => captured.push(line);

    globalThis.fetch = async (input, init = {}) => {
      const call = {
        url: String(input),
        method: init.method ?? 'GET',
        headers: new Headers(init.headers),
        body: typeof init.body === 'string' ? init.body : '',
      };
      fetchCalls.push(call);
      const { pathname } = new URL(call.url);
      if (pathname === '/api/news/v1/list-feed-digest') return digestResponse();
      if (pathname === '/api/news/v1/summarize-article') {
        return new Response(JSON.stringify({ summary: 'Canonical world brief.' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected downstream URL: ${call.url}`);
    };

    const deps = makeDeps();
    let id = 100;
    for (const host of HOSTS) {
      const beforeFetch = fetchCalls.length;
      const beforeTelemetry = downstreamEvents(captured).length;
      const response = await mcpHandler(requestFor(host.url, AUTH_CASE.headers, id++), deps);
      assert.equal(response.status, 200, `${host.url}: transport status`);
      const rpc = await response.json();
      assert.equal(
        JSON.parse(rpc.result.content[0].text).summary,
        'Canonical world brief.',
        `${host.url}: valid caller receives a brief`,
      );

      const calls = fetchCalls.slice(beforeFetch);
      assert.equal(calls.length, 2, `${host.url}: digest + summarize`);
      for (const call of calls) {
        assert.equal(new URL(call.url).origin, CANONICAL_API_ORIGIN);
        assert.equal(call.headers.get('x-worldmonitor-key'), ENV_KEY);
      }

      const events = downstreamEvents(captured).slice(beforeTelemetry);
      assert.equal(events.length, 2, `${host.url}: one event per downstream call`);
      assert.deepEqual(
        events.map((event) => event.downstream_operation),
        ['list-feed-digest', 'summarize-article'],
      );
      for (const event of events) {
        assert.equal(event.auth_kind, AUTH_CASE.kind);
        assert.equal(event.inbound_host_class, host.hostClass);
        assert.equal(event.downstream_origin, CANONICAL_API_ORIGIN);
        assert.equal(event.status, 200);
        assert.equal(event.ok, true);
        assert.equal(event.error_code, null);
        assert.equal(event.response_marker, 'json');
        const offending = Object.keys(event).filter(
          (key) => !MCP_DOWNSTREAM_TELEMETRY_KEYS.includes(key),
        );
        assert.deepEqual(offending, [], `unauthorized mcp.downstream keys: ${offending}`);
      }
    }

    const serialized = JSON.stringify(captured);
    for (const secret of [ENV_KEY, SECRET_QUERY, SECRET_COOKIE, SECRET_GEO_CONTEXT]) {
      assert.doesNotMatch(serialized, new RegExp(secret), `telemetry must not leak ${secret}`);
    }
  });

  it('classifies reproduced 401/405 responses without logging response bodies', async () => {
    const scenarios = [
      {
        name: 'invalid raw API key',
        response: () => new Response(JSON.stringify({
          error: 'Invalid API key',
          detail: SECRET_RESPONSE_DETAIL,
        }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
        errorCode: 'invalid_api_key',
        marker: 'json_error',
        status: 401,
      },
      {
        name: 'other gateway entitlement outcome',
        response: () => new Response(JSON.stringify({
          error: 'insufficient_entitlement',
          detail: SECRET_RESPONSE_DETAIL,
        }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
        errorCode: 'insufficient_entitlement',
        marker: 'json_error',
        status: 401,
      },
      {
        name: 'method mismatch route',
        response: () => new Response(
          `<html><body>Method not allowed ${SECRET_RESPONSE_DETAIL}</body></html>`,
          {
            status: 405,
            headers: { 'Content-Type': 'text/html', Allow: 'GET' },
          },
        ),
        errorCode: 'method_not_allowed',
        marker: 'method_not_allowed',
        status: 405,
      },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const captured = [];
      console.log = (line) => captured.push(line);
      console.warn = () => {};
      console.error = () => {};
      globalThis.fetch = async (input) => {
        const { pathname } = new URL(String(input));
        if (pathname === '/api/news/v1/list-feed-digest') return digestResponse();
        if (pathname === '/api/news/v1/summarize-article') return scenario.response();
        throw new Error(`Unexpected downstream URL: ${input}`);
      };

      const response = await mcpHandler(
        requestFor('https://tech.worldmonitor.app/mcp', AUTH_CASE.headers, 200 + index),
        makeDeps(),
      );
      assert.equal(response.status, 200, `${scenario.name}: JSON-RPC tool failure status`);
      const rpc = await response.json();
      assert.equal(rpc.error?.code, -32603, `${scenario.name}: internal tool failure contract`);

      const event = downstreamEvents(captured).find(
        (candidate) => candidate.downstream_operation === 'summarize-article',
      );
      assert.ok(event, `${scenario.name}: summarize telemetry`);
      assert.equal(event.auth_kind, AUTH_CASE.kind);
      assert.equal(event.inbound_host_class, 'variant');
      assert.equal(event.downstream_origin, CANONICAL_API_ORIGIN);
      assert.equal(event.status, scenario.status);
      assert.equal(event.ok, false);
      assert.equal(event.error_code, scenario.errorCode);
      assert.equal(event.response_marker, scenario.marker);

      const serialized = JSON.stringify(captured);
      assert.doesNotMatch(serialized, new RegExp(SECRET_RESPONSE_DETAIL));
      assert.doesNotMatch(serialized, new RegExp(SECRET_QUERY));
      assert.doesNotMatch(serialized, new RegExp(SECRET_COOKIE));
      assert.doesNotMatch(serialized, new RegExp(SECRET_GEO_CONTEXT));
    }
  });

  // FIXME(stage1-supabase-migration): "preserves a genuine billing denial as
  // a typed actionable response" was removed here. It simulated a downstream
  // gateway fetch returning 503 + X-Billing-Verification: renewal_verification_pending
  // and asserted api/mcp.ts's mid-call BillingDenialError passthrough
  // (api/mcp/dispatch.ts -> getMcpBillingVerificationDenial in api/mcp/auth.ts)
  // preserves that as a typed 503 instead of flattening to a generic -32603.
  //
  // That passthrough now silently degrades: getMcpBillingVerificationDenial()
  // delegates non-'entitlement_verification_unavailable' codes (including
  // 'renewal_verification_pending'/'renewal_verification_failed'/
  // 'subscription_lapsed') to server/_shared/entitlement-check.ts's
  // getBillingVerificationDenial(), which Stage 1 turned into a PERMANENT
  // NO-OP (always returns null -- see that module's header comment). So if
  // this scenario were ever hit for real, dispatch.ts's `if (denial) return
  // denial;` would fall through and return the generic -32603 "Internal
  // error: data fetch failed" instead of the 503 + Retry-After +
  // X-Billing-Verification contract the #4770 fix this test guarded was
  // built for.
  //
  // Believed harmless in practice: no code path in this codebase produces a
  // downstream response carrying X-Billing-Verification:
  // renewal_verification_pending/renewal_verification_failed/
  // subscription_lapsed anymore (Dodo billing/checkout.ts is deleted, and
  // entitlement-check.ts's getEntitlements() never sets `billingStatus` on
  // any entitlement it synthesizes) -- so this is dead code guarding an
  // unreachable state, not a live regression. Flagging because the
  // dead-but-still-wired-up passthrough machinery in api/mcp/dispatch.ts,
  // api/mcp/auth.ts, and api/mcp/billing-denial.ts (BillingDenialError,
  // getMcpBillingVerificationDenial, throwIfBillingDenial) was NOT verified
  // to still do the right thing end-to-end, only that its downstream call
  // site (getBillingVerificationDenial) is now inert by design. A future
  // cleanup pass should either delete this now-dead machinery or restore its
  // correctness if some future non-Dodo billing state ever needs it again.
});
