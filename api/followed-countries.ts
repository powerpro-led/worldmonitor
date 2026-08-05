/**
 * Followed-countries watchlist sync endpoint.
 *
 * GET  /api/followed-countries                                — list the signed-in user's watchlist
 * POST /api/followed-countries {action:'follow', country}     — follow one country
 * POST /api/followed-countries {action:'unfollow', country}   — unfollow one country
 * POST /api/followed-countries {action:'merge', countries}    — sign-in merge of anonymous localStorage list
 *
 * Authentication: Supabase Bearer token in the Authorization header. New
 * endpoint for Stage 2 of the Convex/Clerk -> Supabase migration — replaces
 * `src/services/followed-countries.ts`'s direct Convex client
 * mutation/query calls (`api.followedCountries.*`) with an HTTP relay,
 * matching `api/user-prefs.ts`'s existing shape. No live push (Convex's
 * `client.onUpdate` reactive subscription isn't ported); the frontend
 * refetches on mount and on focus/visibilitychange instead.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from './_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from './_sentry-edge.js';
import {
  beginStandaloneIdempotency,
  completeStandaloneIdempotency,
  getIdempotencyKey,
  peekStandaloneIdempotency,
} from './_idempotency.js';
import { validateBearerToken } from '../server/auth-session';
import { checkScopedRateLimit } from '../server/_shared/rate-limit';
import {
  FollowedCountriesError,
  followCountry,
  listFollowed,
  mergeAnonymousLocal,
  unfollowCountry,
  type FollowMutationResult,
  type MergeAnonymousLocalResult,
} from '../server/_shared/followed-countries';

export const FOLLOWED_COUNTRIES_WRITE_RATE_SCOPE = 'followed-countries-write';
export const FOLLOWED_COUNTRIES_WRITE_RATE_LIMIT = 30;
export const FOLLOWED_COUNTRIES_WRITE_RATE_WINDOW = '60 s';

type SessionValidator = typeof validateBearerToken;
type ScopedRateLimiter = typeof checkScopedRateLimit;

interface FollowedCountriesDeps {
  validateBearerToken: SessionValidator;
  checkScopedRateLimit: ScopedRateLimiter;
  listFollowed: typeof listFollowed;
  followCountry: typeof followCountry;
  unfollowCountry: typeof unfollowCountry;
  mergeAnonymousLocal: typeof mergeAnonymousLocal;
}

function createDefaultDeps(): FollowedCountriesDeps {
  return {
    validateBearerToken,
    checkScopedRateLimit,
    listFollowed,
    followCountry,
    unfollowCountry,
    mergeAnonymousLocal,
  };
}

let deps: FollowedCountriesDeps = createDefaultDeps();

export function __setFollowedCountriesDepsForTests(overrides: Partial<FollowedCountriesDeps> | null): void {
  deps = overrides ? { ...createDefaultDeps(), ...overrides } : createDefaultDeps();
}

function errorStatus(err: FollowedCountriesError): number {
  switch (err.kind) {
    case 'INVALID_COUNTRY':
    case 'EMPTY_INPUT':
    case 'INPUT_TOO_LARGE':
      return 400;
    case 'CONFIG':
    case 'NETWORK':
      return 503;
  }
}

export default async function handler(
  req: Request,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  if (isDisallowedOrigin(req)) {
    return jsonResponse({ error: 'Origin not allowed' }, 403);
  }

  const cors = getCorsHeaders(req, 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    return jsonResponse({ error: 'UNAUTHENTICATED' }, 401, cors);
  }

  const session = await deps.validateBearerToken(token);
  if (!session.valid || !session.userId) {
    return jsonResponse({ error: 'UNAUTHENTICATED' }, 401, cors);
  }

  if (req.method === 'GET') {
    try {
      const countries = await deps.listFollowed(session.userId);
      return jsonResponse({ countries }, 200, cors);
    } catch (err) {
      return handleError(err, 'GET', session.userId, cors, ctx);
    }
  }

  // POST — follow / unfollow / merge
  const idempotencyKey = getIdempotencyKey(req);
  if (idempotencyKey) {
    const peek = await peekStandaloneIdempotency({
      request: req,
      pathname: '/api/followed-countries',
      scope: `user:${session.userId}`,
      idempotencyKey,
      corsHeaders: cors,
    });
    if (peek.kind !== 'miss' && peek.kind !== 'disabled') {
      return peek.response;
    }
  }

  const scoped = await deps.checkScopedRateLimit(
    FOLLOWED_COUNTRIES_WRITE_RATE_SCOPE,
    FOLLOWED_COUNTRIES_WRITE_RATE_LIMIT,
    FOLLOWED_COUNTRIES_WRITE_RATE_WINDOW,
    session.userId,
  );
  if (scoped.degraded) {
    console.warn('[followed-countries] POST write rate limit unavailable; failing open');
  } else if (!scoped.allowed) {
    const retryAfter = Math.max(1, Math.ceil((scoped.reset - Date.now()) / 1000));
    console.warn('[followed-countries] POST write rate limit exceeded');
    return jsonResponse(
      { error: 'RATE_LIMITED' },
      429,
      {
        ...cors,
        'X-RateLimit-Limit': String(scoped.limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(scoped.reset),
        'Retry-After': String(retryAfter),
      },
    );
  }

  const idempotency = idempotencyKey
    ? await beginStandaloneIdempotency({
      request: req,
      pathname: '/api/followed-countries',
      scope: `user:${session.userId}`,
      idempotencyKey,
      corsHeaders: cors,
    })
    : null;
  if (idempotency && idempotency.kind !== 'proceed' && idempotency.kind !== 'disabled') {
    return idempotency.response;
  }
  const finish = (response: Response): Promise<Response> =>
    completeStandaloneIdempotency(idempotency, response);

  let body: { action?: unknown; country?: unknown; countries?: unknown };
  try {
    body = await req.json();
  } catch {
    return finish(jsonResponse({ error: 'Invalid JSON' }, 400, cors));
  }

  try {
    if (body.action === 'follow' || body.action === 'unfollow') {
      if (typeof body.country !== 'string') {
        return finish(jsonResponse({ error: 'MISSING_FIELDS' }, 400, cors));
      }
      const result: FollowMutationResult = body.action === 'follow'
        ? await deps.followCountry(session.userId, body.country)
        : await deps.unfollowCountry(session.userId, body.country);
      return finish(jsonResponse(result, 200, cors));
    }
    if (body.action === 'merge') {
      if (!Array.isArray(body.countries) || !body.countries.every((c) => typeof c === 'string')) {
        return finish(jsonResponse({ error: 'MISSING_FIELDS' }, 400, cors));
      }
      const result: MergeAnonymousLocalResult = await deps.mergeAnonymousLocal(session.userId, body.countries);
      return finish(jsonResponse(result, 200, cors));
    }
    return finish(jsonResponse({ error: 'INVALID_ACTION' }, 400, cors));
  } catch (err) {
    return finish(await handleError(err, 'POST', session.userId, cors, ctx));
  }
}

async function handleError(
  err: unknown,
  method: 'GET' | 'POST',
  userId: string,
  cors: Record<string, string>,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  if (err instanceof FollowedCountriesError) {
    if (err.kind === 'INVALID_COUNTRY') return jsonResponse({ error: 'INVALID_COUNTRY' }, 400, cors);
    if (err.kind === 'EMPTY_INPUT') return jsonResponse({ error: 'EMPTY_INPUT' }, 400, cors);
    if (err.kind === 'INPUT_TOO_LARGE') return jsonResponse({ error: 'INPUT_TOO_LARGE' }, 400, cors);
    // CONFIG / NETWORK — backend unavailable, transient.
    console.warn(`[followed-countries] ${method} backend unavailable:`, err.message);
    captureSilentError(err, {
      tags: { route: 'api/followed-countries', method, user_id: userId, kind: err.kind },
      fingerprint: ['api/followed-countries', method, err.kind],
      ctx,
      level: 'warning',
    });
    return jsonResponse({ error: 'SERVICE_UNAVAILABLE' }, errorStatus(err), { ...cors, 'Retry-After': '5' });
  }
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[followed-countries] ${method} error:`, err);
  captureSilentError(err, {
    tags: { route: 'api/followed-countries', method, user_id: userId },
    extra: { messageHead: msg.slice(0, 300) },
    fingerprint: ['api/followed-countries', method],
    ctx,
  });
  return jsonResponse({ error: 'Internal error' }, 500, cors);
}
