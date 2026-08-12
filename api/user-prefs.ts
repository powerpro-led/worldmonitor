/**
 * User preferences sync endpoint.
 *
 * GET  /api/user-prefs?variant=<variant>  — returns current cloud prefs for signed-in user
 * POST /api/user-prefs                     — saves prefs blob for signed-in user
 *
 * Authentication: Supabase Bearer token in the Authorization header.
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SUPABASE_JWT_SECRET env vars.
 *
 * Stage 2 of the Convex/Clerk -> Supabase migration: this endpoint used to
 * round-trip to Convex (`userPreferences:getPreferences`/`setPreferences`)
 * via `ConvexHttpClient`. It now calls `server/_shared/user-preferences.ts`
 * directly, which talks to `worldmonitor.user_preferences` (Postgres,
 * service-role client) — no second network hop, no Convex-platform-error
 * classification. The wire contract to `src/utils/cloud-prefs-sync.ts` is
 * unchanged.
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
  CURRENT_PREFS_SCHEMA_VERSION,
  getUserPreferences,
  setUserPreferences,
  type CloudPrefsRow,
  type SetPreferencesResult,
} from '../server/_shared/user-preferences';

export const USER_PREFS_WRITE_RATE_SCOPE = 'user-prefs-write';
export const USER_PREFS_WRITE_RATE_LIMIT = 30;
export const USER_PREFS_WRITE_RATE_WINDOW = '60 s';

type SessionValidator = typeof validateBearerToken;
type ScopedRateLimiter = typeof checkScopedRateLimit;

interface UserPrefsDeps {
  validateBearerToken: SessionValidator;
  checkScopedRateLimit: ScopedRateLimiter;
  getUserPreferences: typeof getUserPreferences;
  setUserPreferences: typeof setUserPreferences;
}

function createDefaultUserPrefsDeps(): UserPrefsDeps {
  return {
    validateBearerToken,
    checkScopedRateLimit,
    getUserPreferences,
    setUserPreferences,
  };
}

let userPrefsDeps: UserPrefsDeps = createDefaultUserPrefsDeps();

export function __setUserPrefsDepsForTests(overrides: Partial<UserPrefsDeps> | null): void {
  userPrefsDeps = overrides
    ? { ...createDefaultUserPrefsDeps(), ...overrides }
    : createDefaultUserPrefsDeps();
}

function rateLimitHeaders(
  cors: Record<string, string>,
  limit: number,
  reset: number,
): Record<string, string> {
  const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
  return {
    ...cors,
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': '0',
    'X-RateLimit-Reset': String(reset),
    'Retry-After': String(retryAfter),
  };
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

  const session = await userPrefsDeps.validateBearerToken(token);
  if (!session.valid || !session.userId) {
    return jsonResponse({ error: 'UNAUTHENTICATED' }, 401, cors);
  }

  const idempotencyKey = req.method === 'POST' ? getIdempotencyKey(req) : null;
  if (idempotencyKey) {
    const peek = await peekStandaloneIdempotency({
      request: req,
      pathname: '/api/user-prefs',
      scope: `user:${session.userId}`,
      idempotencyKey,
      corsHeaders: cors,
    });
    if (peek.kind !== 'miss' && peek.kind !== 'disabled') {
      return peek.response;
    }
  }

  if (req.method === 'POST') {
    const scoped = await userPrefsDeps.checkScopedRateLimit(
      USER_PREFS_WRITE_RATE_SCOPE,
      USER_PREFS_WRITE_RATE_LIMIT,
      USER_PREFS_WRITE_RATE_WINDOW,
      session.userId,
    );
    // Redis-degraded scoped limits intentionally fail open for prefs writes:
    // the sync blob is low-stakes, while a limiter outage should not strand a
    // legitimate user's local settings. checkScopedRateLimit logs Redis errors;
    // this warning also surfaces missing-config fail-open windows.
    if (scoped.degraded) {
      console.warn('[user-prefs] POST write rate limit unavailable; failing open');
    } else if (!scoped.allowed) {
      console.warn('[user-prefs] POST write rate limit exceeded');
      return jsonResponse(
        { error: 'RATE_LIMITED' },
        429,
        rateLimitHeaders(cors, scoped.limit, scoped.reset),
      );
    }
  }

  const idempotency = idempotencyKey
    ? await beginStandaloneIdempotency({
      request: req,
      pathname: '/api/user-prefs',
      scope: `user:${session.userId}`,
      idempotencyKey,
      corsHeaders: cors,
    })
    : null;
  if (
    idempotency &&
    idempotency.kind !== 'proceed' &&
    idempotency.kind !== 'disabled'
  ) {
    return idempotency.response;
  }
  const finish = (response: Response): Promise<Response> =>
    completeStandaloneIdempotency(idempotency, response);

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const variant = url.searchParams.get('variant') ?? 'full';

    try {
      const prefs: CloudPrefsRow | null = await userPrefsDeps.getUserPreferences(session.userId, variant);
      return jsonResponse(prefs, 200, cors);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[user-prefs] GET error:', err);
      captureSilentError(err, buildSentryContext(msg, {
        method: 'GET', userId: session.userId, variant, ctx,
      }));
      return jsonResponse({ error: 'Failed to fetch preferences' }, 500, cors);
    }
  }

  // POST — save prefs
  let body: { variant?: unknown; data?: unknown; expectedSyncVersion?: unknown; schemaVersion?: unknown };
  try {
    body = await req.json();
  } catch {
    return finish(jsonResponse({ error: 'Invalid JSON' }, 400, cors));
  }

  if (
    typeof body.variant !== 'string' ||
    body.data === undefined ||
    typeof body.expectedSyncVersion !== 'number'
  ) {
    return finish(jsonResponse({ error: 'MISSING_FIELDS' }, 400, cors));
  }

  const schemaVersion = typeof body.schemaVersion === 'number' ? body.schemaVersion : CURRENT_PREFS_SCHEMA_VERSION;

  try {
    const result: SetPreferencesResult = await userPrefsDeps.setUserPreferences(
      session.userId,
      body.variant,
      body.data,
      body.expectedSyncVersion,
      schemaVersion,
    );

    if (result.ok === false) {
      if (result.reason === 'BLOB_TOO_LARGE') {
        return finish(jsonResponse({ error: 'BLOB_TOO_LARGE' }, 400, cors));
      }
      if (result.reason === 'SERVICE_UNAVAILABLE') {
        console.warn('[user-prefs] POST backend unavailable');
        captureSilentError(new Error('setUserPreferences unavailable'), buildSentryContext(
          'setUserPreferences returned SERVICE_UNAVAILABLE',
          { method: 'POST', userId: session.userId, variant: body.variant, ctx, level: 'warning' },
        ));
        return finish(jsonResponse({ error: 'SERVICE_UNAVAILABLE' }, 503, { ...cors, 'Retry-After': '5' }));
      }
      // CONFLICT — expected outcome of optimistic concurrency (multi-tab /
      // multi-device sync). Captured at level=warning so it stays queryable
      // without paging on-call, same posture as the old Convex-backed path.
      captureSilentError(new Error('setUserPreferences CONFLICT'), buildSentryContext(
        'setUserPreferences returned CONFLICT',
        {
          method: 'POST', userId: session.userId, variant: body.variant, ctx,
          extraTags: { actual_sync_version: result.actualSyncVersion },
          level: 'warning',
        },
      ));
      return finish(jsonResponse(
        { error: 'CONFLICT', actualSyncVersion: result.actualSyncVersion },
        409,
        cors,
      ));
    }
    return finish(jsonResponse({ syncVersion: result.syncVersion }, 200, cors));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[user-prefs] POST error:', err);
    captureSilentError(err, buildSentryContext(msg, {
      method: 'POST', userId: session.userId, variant: body.variant, ctx,
    }));
    return finish(jsonResponse({ error: 'Failed to save preferences' }, 500, cors));
  }
}

/**
 * Build a captureSilentError context. Much simpler than the Convex-backed
 * version's `errorShape` regex classification — that existed to split
 * Convex-platform failure modes (timeouts, 503s, opaque 5xx) into separate
 * Sentry buckets. `worldmonitor.user_preferences` is a direct Postgres call
 * from this same edge function, so there's no second platform's error
 * surface to classify; a stable `route/method` fingerprint is enough.
 */
export function buildSentryContext(
  msg: string,
  opts: {
    method: 'GET' | 'POST';
    userId: string;
    variant?: unknown;
    ctx?: { waitUntil: (p: Promise<unknown>) => void };
    extraTags?: Record<string, string | number>;
    level?: 'warning' | 'info' | 'error' | 'fatal';
  },
): {
  tags: Record<string, string | number>;
  extra: Record<string, unknown>;
  fingerprint: string[];
  ctx?: { waitUntil: (p: Promise<unknown>) => void };
  level?: 'warning' | 'info' | 'error' | 'fatal';
} {
  return {
    tags: {
      route: 'api/user-prefs',
      method: opts.method,
      user_id: opts.userId,
      ...(opts.extraTags ?? {}),
    },
    extra: {
      variant: typeof opts.variant === 'string' ? opts.variant : 'unknown',
      messageHead: msg.slice(0, 300),
    },
    fingerprint: ['api/user-prefs', opts.method],
    ctx: opts.ctx,
    ...(opts.level ? { level: opts.level } : {}),
  };
}
