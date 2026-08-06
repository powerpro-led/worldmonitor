/**
 * Adapts worldmonitor's 2 hand-written Vercel Node.js serverless handlers
 * (`api/og-story.js`, `api/story.js` — no `runtime: 'edge'` config, so they
 * get Vercel's Node.js `(req, res)` calling convention, not the Fetch API
 * `Request → Response` shape `adapt-vercel-handler.ts` wraps) into Nitric
 * `HttpContext` middleware.
 *
 * Deliberately NOT a general Node `http.IncomingMessage`/`ServerResponse`
 * polyfill — scoped to exactly the subset both handlers actually call
 * (`req.url`, `req.headers[...]`, `res.setHeader`, `res.status().send()`,
 * `res.writeHead()`, `res.end()`), matching this repo's existing
 * `adapt-vercel-handler.ts` in staying a thin translation layer, not a
 * reimplementation of Vercel's runtime. If a future handler under `api/`
 * needs a Node API this doesn't cover, extend `NodeLikeResponse` rather than
 * reaching for a full polyfill package.
 *
 * Scaffold-only: exercised by `nitric build`/`tsc` + a live `nitric start`
 * request, not a deployed Cloud Run instance. See
 * docs/architecture/nitric-gcp-scaffold.md.
 */

import type { HttpContext } from '@nitric/sdk';
import { appendQueryParams } from './query-params';

export interface NodeLikeRequest {
  url: string;
  method: string;
  headers: Record<string, string | undefined>;
}

export interface NodeLikeResponse {
  setHeader(name: string, value: string): void;
  status(code: number): NodeLikeResponse;
  send(body: string): void;
  writeHead(statusCode: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

export type VercelNodeHandler = (req: NodeLikeRequest, res: NodeLikeResponse) => void | Promise<void>;

function buildNodeRequest(req: HttpContext['req']): NodeLikeRequest {
  const query = new URLSearchParams();
  appendQueryParams(query, req.query);
  const qs = query.toString();

  // Both consuming handlers only read single-valued headers (user-agent) —
  // first value wins, matching Node's http.IncomingMessage behavior for
  // non-cookie headers.
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers ?? {})) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }

  return {
    url: qs ? `${req.path}?${qs}` : req.path,
    method: req.method,
    headers,
  };
}

/**
 * Wraps a Vercel Node.js handler as Nitric HttpMiddleware. Register with:
 *   api.get('/api/og-story', adaptNodeHandler(ogStoryHandler))
 */
export function adaptNodeHandler(handler: VercelNodeHandler) {
  return async (ctx: HttpContext): Promise<HttpContext> => {
    let statusCode = 200;
    const headers: Record<string, string[]> = {};
    let body = '';
    let finished = false;

    const setHeader = (name: string, value: string): void => {
      headers[name] = [value];
    };

    const res: NodeLikeResponse = {
      setHeader,
      status(code: number) {
        statusCode = code;
        return res;
      },
      send(sendBody: string) {
        body = sendBody;
        finished = true;
      },
      writeHead(code: number, writeHeadHeaders?: Record<string, string>) {
        statusCode = code;
        for (const [name, value] of Object.entries(writeHeadHeaders ?? {})) setHeader(name, value);
      },
      end(endBody?: string) {
        if (endBody !== undefined) body = endBody;
        finished = true;
      },
    };

    await handler(buildNodeRequest(ctx.req), res);

    // Both known handlers (og-story.js, story.js) finalize synchronously
    // before returning — this guards against a future handler that forgets
    // to call send()/end(), rather than silently returning an empty 200.
    if (!finished) {
      throw new Error('adaptNodeHandler: handler returned without calling res.send()/res.end()');
    }

    ctx.res.status = statusCode;
    ctx.res.headers = headers;
    ctx.res.body = new TextEncoder().encode(body);

    return ctx;
  };
}
