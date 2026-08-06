/**
 * Adapts worldmonitor's existing Vercel Edge handlers (`export const config =
 * { runtime: 'edge' }`, plain Web `Request → Response`) into Nitric
 * `HttpContext` middleware — no business-logic rewrite per route.
 *
 * Every one of the ~50 routable files under api/ (34 sebuf domain gateways +
 * api/mcp.ts + the standalone handlers) already speaks the Fetch API
 * (`Request`/`Response`), because that's what the Vercel Edge Runtime is.
 * Nitric's Node-based HttpContext is a different shape (ctx.req/ctx.res,
 * headers as `Record<string, string[]>`, no global `Request`/`Response`
 * objects on the wire) — this is the one translation layer every generated
 * route registration in routes.generated.ts goes through.
 *
 * Scaffold-only: this has been exercised by `nitric build`/`tsc`, not by a
 * live request against a deployed Cloud Run instance. See
 * docs/architecture/nitric-gcp-scaffold.md.
 */

import type { HttpContext } from '@nitric/sdk';

/** Matches Vercel Edge's runtime signature — some handlers accept the optional
 * second `{ waitUntil }` context arg (background-work extension point), most don't. */
export type VercelEdgeHandler = (
  req: Request,
  ctx: { waitUntil: (promise: Promise<unknown>) => void },
) => Response | Promise<Response>;

// Nitric has no native equivalent of Vercel's waitUntil (defer background work past
// the response). Fire-and-forget is the closest honest behavior in a long-lived Cloud
// Run container. Real callers of ctx.waitUntil today: api/notification-channels.ts
// (publishing a welcome notification after channel creation), api/bootstrap.js
// (cache persistence/probes) — all already async, best-effort, and not awaited by the
// caller before the next request, so fire-and-forget preserves current behavior. Not
// verified against a deployed instance — flagged for the real port, not this scaffold.
function fireAndForgetWaitUntil(promise: Promise<unknown>): void {
  promise.catch(() => {});
}

// Nitric's HttpRequest.path carries the real incoming request path (worldmonitor's
// own server/router.ts already re-derives routing from `new URL(req.url).pathname`
// rather than trusting Vercel's single-segment `[rpc]` param), so reconstructing a
// same-origin Request from ctx.req.path + query is sufficient — no dependency on the
// deployed hostname.
const INTERNAL_BASE_URL = 'https://nitric.internal';

function buildRequestHeaders(nitricHeaders: Record<string, string[] | string> | undefined): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nitricHeaders ?? {})) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v !== undefined) headers.append(key, v);
    }
  }
  return headers;
}

function buildResponseHeaders(webHeaders: Headers): Record<string, string[]> {
  const headers: Record<string, string[]> = {};
  webHeaders.forEach((value, key) => {
    headers[key] = [...(headers[key] ?? []), value];
  });
  return headers;
}

/**
 * Wraps a Vercel Edge handler as Nitric HttpMiddleware. Register with:
 *   api.post('/api/user-prefs', adaptVercelHandler(userPrefsHandler))
 */
export function adaptVercelHandler(handler: VercelEdgeHandler) {
  return async (ctx: HttpContext): Promise<HttpContext> => {
    const { req } = ctx;

    const url = new URL(req.path, INTERNAL_BASE_URL);
    for (const [key, values] of Object.entries(req.query ?? {})) {
      for (const value of values) url.searchParams.append(key, value);
    }

    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const webRequest = new Request(url, {
      method: req.method,
      headers: buildRequestHeaders(req.headers),
      // Cast: req.data is `string | Uint8Array`, both valid runtime BodyInit values —
      // the structural mismatch here is Node's fetch types vs. this Uint8Array's
      // ArrayBufferLike generic parameter, not an actual incompatibility.
      body: hasBody ? (req.data as BodyInit) : undefined,
    });

    const webResponse = await handler(webRequest, { waitUntil: fireAndForgetWaitUntil });

    ctx.res.status = webResponse.status;
    ctx.res.headers = buildResponseHeaders(webResponse.headers);
    ctx.res.body = new Uint8Array(await webResponse.arrayBuffer());

    return ctx;
  };
}
