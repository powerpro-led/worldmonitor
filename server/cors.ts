/**
 * CORS header generation -- TypeScript port of api/_cors.js.
 *
 * Identical allowed-origin logic, with methods set to 'GET, POST, OPTIONS'
 * (sebuf routes support GET and POST).
 */

import { buildAllowedOriginPatterns, resolveAppOrigin } from '../shared/domain-config.js';

// Vercel preview deployments under the "eliewm" team scope, e.g.
//   worldmonitor-git-<branch>-eliewm.vercel.app  (git-branch alias)
//   worldmonitor-<hash>-eliewm.vercel.app        (deployment URL)
// Tight on purpose: never a bare *.vercel.app (this is a security allowlist).
// This is a Vercel team-scope identifier, not a domain brand, so it stays
// hardcoded here rather than living in the domain-agnostic shared config.
const ELIEWM_PREVIEW_PATTERN = /^https:\/\/worldmonitor-[a-z0-9-]+-eliewm\.vercel\.app$/;

// Recomputed per call (not cached at module load) so APP_DOMAIN/NODE_ENV
// changes — including a test file setting process.env.APP_DOMAIN before
// calling into this module — always take effect. See shared/domain-config.js
// for what's derived from APP_DOMAIN (unset = local dev, never a brand default).
function getAllowedOriginPatterns(): RegExp[] {
  return buildAllowedOriginPatterns(process.env.APP_DOMAIN, {
    includeDevPatterns: process.env.NODE_ENV !== 'production',
    extraPatterns: [ELIEWM_PREVIEW_PATTERN],
  });
}

const ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-WorldMonitor-Key',
  'X-Api-Key',
  'X-Widget-Key',
  'X-Pro-Key',
  'X-WorldMonitor-Desktop-Timestamp',
  'X-WorldMonitor-Desktop-Signature',
  'Idempotency-Key',
  'Mcp-Session-Id',
  'MCP-Protocol-Version',
  'Last-Event-ID',
].join(', ');

const EXPOSED_HEADERS = [
  'Mcp-Session-Id',
  'WWW-Authenticate',
  'Retry-After',
  'Idempotency-Key',
  'Idempotent-Replayed',
  'Location',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
  'X-WorldMonitor-Bbox',
  'X-WorldMonitor-Bbox-Missing',
  'X-WorldMonitor-Bbox-Invalid',
  'X-Military-Bbox',
].join(', ');

export function isAllowedOrigin(origin: string): boolean {
  return Boolean(origin) && getAllowedOriginPatterns().some((pattern) => pattern.test(origin));
}

export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = isAllowedOrigin(origin) ? origin : resolveAppOrigin(process.env.APP_DOMAIN);
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Expose-Headers': EXPOSED_HEADERS,
    'Access-Control-Max-Age': '3600',
    'Vary': 'Origin',
  };
}

export function isDisallowedOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  return !isAllowedOrigin(origin);
}
