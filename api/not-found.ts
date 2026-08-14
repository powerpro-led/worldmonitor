// Structured JSON 404 for unmatched `/api/*` paths.
//
// Vercel serves its native `text/plain` "NOT_FOUND" body for any `/api/...`
// path that doesn't resolve to a function. Agents (and agent-readiness
// scanners) can't parse an HTML/plain error page, so this handler returns a
// machine-readable JSON error with a code, a message, and a resolution hint.
//
// It is mounted as the filesystem catch-all `api/[...notfound].ts`, which
// re-exports this handler. A root-level catch-all (`[...slug]`) has the LOWEST
// dynamic-route precedence, so concrete functions AND nested dynamic gateways
// (`api/<service>/v1/[rpc].ts`) resolve first — a live endpoint is never
// shadowed. It was previously wired via a `/api/:path*` rewrite, an afterFiles
// rewrite that Vercel applied BEFORE dynamic routes, which shadowed every
// `[rpc].ts` gateway and 404'd the whole versioned REST surface (#4724).

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getPublicCorsHeaders } from './_cors.js';
import { resolveAppOrigin } from '../shared/domain-config.js';

export default function handler(req: Request): Response {
  const corsHeaders = getPublicCorsHeaders('GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const pathname = (() => {
    try {
      return new URL(req.url).pathname;
    } catch {
      return req.url;
    }
  })();

  const openapiUrl = `${resolveAppOrigin(process.env.APP_DOMAIN)}/openapi.yaml`;
  const body = {
    error: {
      code: 'not_found',
      message: `No API endpoint matches ${pathname}.`,
      // No public API-reference doc page exists on this private fork (the
      // Mintlify docs site is gone) — the OpenAPI spec is the sole surviving
      // machine-readable reference.
      hint: `Check the endpoint path against the OpenAPI spec at ${openapiUrl}.`,
    },
    documentation: openapiUrl,
  };

  return new Response(JSON.stringify(body), {
    status: 404,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // The body echoes the requested pathname (JSON-escaped, so no injection);
      // nosniff stops a client from content-type-sniffing it to HTML anyway.
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      ...corsHeaders,
    },
  });
}
