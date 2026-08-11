import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
// @ts-expect-error — JS module, no declaration file
import { resolveBearerToContext } from '../_oauth-token.js';
// @ts-expect-error — JS module, no declaration file
import { timingSafeIncludes } from '../_crypto.js';
// @ts-expect-error — JS module, no declaration file
import { getClientIp } from '../_client-ip.js';
import { getBillingVerificationDenial } from '../../server/_shared/entitlement-check';
import type { BillingVerificationCode } from './billing-denial';
import { rpcError, withMcpNoStore } from './rpc';
import type {
  AuthResolution,
  AuthResolutionRejected,
  McpAuthContext,
  McpHandlerDeps,
} from './types';
import { emitMcpRateLimitHit } from './telemetry';

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------
//   - Per-key 60/min (env-key bearers): prefix `rl:mcp`, keyed `key:<apiKey>`.
// ---------------------------------------------------------------------------

let mcpRatelimit: Ratelimit | null = null;
// Anonymous MCP discovery limiter (initialize / tools/list without credentials).
// Keyed by client IP so a public discovery surface can't be hammered by an
// unauthenticated caller. Separate prefix from the authed per-key limiter
// above so anon traffic never shares a bucket with a real principal.
let mcpAnonRatelimit: Ratelimit | null = null;

function getMcpRatelimit(): Ratelimit | null {
  if (mcpRatelimit) return mcpRatelimit;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  mcpRatelimit = new Ratelimit({
    redis: new Redis({ url, token, retry: false }),
    limiter: Ratelimit.slidingWindow(60, '60 s'),
    prefix: 'rl:mcp',
    analytics: false,
  });
  return mcpRatelimit;
}

function getMcpAnonRatelimit(): Ratelimit | null {
  if (mcpAnonRatelimit) return mcpAnonRatelimit;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  mcpAnonRatelimit = new Ratelimit({
    redis: new Redis({ url, token, retry: false }),
    limiter: Ratelimit.slidingWindow(60, '60 s'),
    prefix: 'rl:mcp:anon',
    analytics: false,
  });
  return mcpAnonRatelimit;
}

/**
 * Build the Authorization header set for a downstream `_execute` fetch.
 * env_key is the sole credential class: `X-WorldMonitor-Key: <apiKey>`.
 * `method`/`url`/`body` are unused now (they fed the retired internal-HMAC
 * signature) but kept in the signature so the ~13 call sites across
 * registry/rpc-tools.ts don't need touching.
 */
export async function buildAuthHeaders(
  context: McpAuthContext,
  _method: string,
  _url: string,
  _body: BodyInit | null | undefined,
): Promise<Record<string, string>> {
  return { 'X-WorldMonitor-Key': context.apiKey };
}

export const PRODUCTION_DEPS: McpHandlerDeps = {
  resolveBearerToContext,
};

// ---------------------------------------------------------------------------
// Auth + Pro-pre-check helpers (extracted from mcpHandler so the top-level
// handler stays under the cognitive-complexity threshold).
// ---------------------------------------------------------------------------

export function wwwAuthHeader(resourceMetadataUrl: string, errorParam = ''): string {
  const errSegment = errorParam ? `, error="${errorParam}"` : '';
  return `Bearer realm="worldmonitor"${errSegment}, resource_metadata="${resourceMetadataUrl}"`;
}

export function getMcpBillingVerificationDenial(
  entitlements: {
    billingStatus?: BillingVerificationCode;
    retryAfterSeconds?: number;
    // Transient entitlement-lookup failure marker from getEntitlements()
    // (server/_shared/entitlement-check.ts) — mapped to the same retryable
    // envelope as a gateway-synthesized entitlement_verification_unavailable.
    verificationUnavailable?: boolean;
  } | null | undefined,
  corsHeaders: Record<string, string>,
  id: unknown = null,
): Response | null {
  const billingStatus = entitlements?.verificationUnavailable
    ? 'entitlement_verification_unavailable'
    : entitlements?.billingStatus;
  if (billingStatus === 'entitlement_verification_unavailable') {
    // Gateway-synthesized backend-unreachable 503 (server/gateway.ts wm_-key
    // branch). The shared Convex-facing helper doesn't recognize this code, so
    // build the same retryable envelope here; clamp mirrors the shared helper.
    const raw = entitlements?.retryAfterSeconds;
    const retryAfter = Number.isFinite(raw)
      ? Math.max(1, Math.min(60, Math.ceil(raw as number)))
      : 5;
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: id ?? null,
        error: {
          code: -32603,
          message: 'Unable to verify API access. Retry shortly.',
          data: { code: billingStatus },
        },
      }),
      {
        status: 503,
        headers: new Headers({
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Retry-After': String(retryAfter),
          'X-Billing-Verification': billingStatus,
        }),
      },
    );
  }

  // The shared helper owns status, retry normalization, no-store, and billing
  // headers. Its parameter asks only for the billing fields, so both the
  // McpHandlerDeps entitlement shape and dispatch's synthesized
  // BillingDenialError shape are directly assignable.
  const denial = getBillingVerificationDenial(
    billingStatus ? { billingStatus, retryAfterSeconds: entitlements?.retryAfterSeconds } : null,
    corsHeaders,
  );
  if (!denial || !billingStatus) return null;

  const retryable = denial.status === 503;
  const message = {
    subscription_lapsed: 'Subscription lapsed. Re-authenticating will not help — resubscribe to restore access.',
    renewal_verification_pending: 'Renewal verification pending. Retry shortly.',
    renewal_verification_failed: 'Renewal verification failed. Retry shortly.',
  }[billingStatus];
  const headers = new Headers(denial.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Type', 'application/json');

  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: id ?? null,
      error: {
        // -32002 is the confirmed-lapse code (HTTP 403, no WWW-Authenticate).
        // -32001 stays reserved for authentication failures at HTTP 401 per
        // docs/mcp-error-catalog.mdx — reusing it here sent doc-following
        // agents into a pointless OAuth re-auth loop.
        code: retryable ? -32603 : -32002,
        message,
        data: { code: billingStatus },
      },
    }),
    { status: denial.status, headers },
  );
}

export async function resolveAuthContext(
  req: Request,
  deps: McpHandlerDeps,
  resourceMetadataUrl: string,
  corsHeaders: Record<string, string>,
): Promise<AuthResolution | AuthResolutionRejected> {
  const authHeader = req.headers.get('Authorization') ?? '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    let context: McpAuthContext | null;
    try {
      context = await deps.resolveBearerToContext(token);
    } catch {
      return {
        ok: false,
        response: new Response(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Auth service temporarily unavailable. Try again.' } }),
          { status: 503, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'Retry-After': '5', ...corsHeaders }) },
        ),
      };
    }
    if (!context) {
      return {
        ok: false,
        response: new Response(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Invalid or expired OAuth token. Re-authenticate via /oauth/token.' } }),
          { status: 401, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl, 'invalid_token'), ...corsHeaders }) },
        ),
      };
    }
    return { ok: true, context };
  }

  const candidateKey = req.headers.get('X-WorldMonitor-Key') ?? '';
  if (!candidateKey) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Authentication required. Use OAuth (/oauth/token) or pass your API key via X-WorldMonitor-Key header.' } }),
        { status: 401, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl), ...corsHeaders }) },
      ),
    };
  }
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  if (await timingSafeIncludes(candidateKey, validKeys)) {
    return { ok: true, context: { kind: 'env_key', apiKey: candidateKey } };
  }

  return {
    ok: false,
    response: new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Invalid API key' } }),
      { status: 401, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl, 'invalid_token'), ...corsHeaders }) },
    ),
  };
}

/**
 * Kind-dispatched pre-checks for gated (data/quota) methods. env_key is the
 * sole credential class and is operator-owned + intentionally ungated, so
 * this is permanently a no-op — kept as a named entry point (rather than
 * deleting the call sites in handler.ts) so a future context kind can't
 * silently ship without deciding its gate. Signature kept compatible with
 * the pre-retirement call sites so handler.ts doesn't need touching.
 */
export async function runContextPreChecks(
  _context: McpAuthContext,
  _deps: McpHandlerDeps,
  _resourceMetadataUrl: string,
  _corsHeaders: Record<string, string>,
  _ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response | null> {
  return null;
}

/** Per-minute rate limit, keyed per API key. Fail-OPEN on Upstash error
 *  (graceful). Returns null on success or pass-through, a Response on a
 *  real 60/min limit hit. */
export async function applyPerMinuteLimit(context: McpAuthContext, headers: Record<string, string> = {}): Promise<Response | null> {
  const rl = getMcpRatelimit();
  if (!rl) return null;
  try {
    const { success } = await rl.limit(`key:${context.apiKey}`);
    if (!success) {
      emitMcpRateLimitHit(context, {
        dimension: 'mcp_minute_burst',
        limit: 60,
        windowSeconds: 60,
      });
      return rpcError(null, -32029, 'Rate limit exceeded. Max 60 requests per minute per API key.', headers);
    }
  } catch { /* graceful degradation */ }
  return null;
}

/** Per-IP rate limit for the UNAUTHENTICATED discovery path (initialize /
 *  tools/list without credentials — the metadata surface agent scanners probe).
 *  Keyed on the trusted client IP (cf-connecting-ip / x-real-ip; falls back to a
 *  shared bucket so x-forwarded-for spoofing can't rotate identities). Fail-OPEN
 *  on Upstash error, matching `applyPerMinuteLimit` — the discovery response is a
 *  cheap in-memory payload, so availability beats strict enforcement here.
 *  Returns null on success/skip, a Response on a real 60/min limit hit. */
export async function applyAnonDiscoveryLimit(req: Request, headers: Record<string, string> = {}): Promise<Response | null> {
  const rl = getMcpAnonRatelimit();
  if (!rl) return null;
  try {
    const { success } = await rl.limit(`ip:${getClientIp(req)}`);
    if (!success) return rpcError(null, -32029, 'Rate limit exceeded. Max 60 unauthenticated discovery requests per minute per IP.', headers);
  } catch { /* graceful degradation */ }
  return null;
}
