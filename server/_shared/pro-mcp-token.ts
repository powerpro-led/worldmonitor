/**
 * Edge-runtime-safe wrappers around `worldmonitor.mcp_pro_tokens` (Postgres,
 * service-role Supabase client) — Stage 1 of the Convex/Clerk -> Supabase
 * migration replaced the three Convex internal HTTP actions
 * (`internal-issue-pro-mcp-token`, `internal-validate-pro-mcp-token`,
 * `internal-revoke-pro-mcp-token`) with direct Postgres CRUD via
 * `server/_shared/supabase-admin.ts`. Token identity IS the row id (uuid) —
 * no separate hash, mirroring `convex/mcpProTokens.ts`'s design.
 *
 * Per plan U2: every Pro MCP request hits `worldmonitor.mcp_pro_tokens` —
 * positive results are NEVER cached at the edge. Revoke takes effect on
 * the next request, period. A short-lived 60s **negative cache** is kept
 * for already-known-bad bearers (revoked / never-existed tokenIds) so a
 * misbehaving Claude client can't hammer Postgres with a stale bearer.
 * This negative-cache layer is UNCHANGED from the Convex-backed version —
 * it was already independent of Convex/Clerk.
 *
 * Differences from `user-api-key.ts` (the closest sibling pattern):
 *   - That file positive-caches the {userId, keyId, name} payload for
 *     CACHE_TTL_SECONDS via `cachedFetchJson`. We do NOT — revoke must be
 *     authoritative on the next request (R3).
 *   - We still negative-cache for 60s, sharing the same fail-soft posture
 *     on Postgres/network errors (returns null → caller's bearer resolution
 *     returns null → 401). Entitlement gates fail closed; bearer-resolution
 *     failures fail-soft so a transient Postgres blip yields a clean 401
 *     instead of a hung 500.
 */

import { deleteRedisKey } from './redis';
import { getSupabaseAdmin } from './supabase-admin';

/** Maximum number of active (non-revoked) Pro MCP tokens per user. Matches
 *  convex/mcpProTokens.ts::MAX_TOKENS_PER_USER (ported as-is). */
const MAX_TOKENS_PER_USER = 5;

/** Negative-cache TTL: 60s — short enough that a re-issued tokenId (vanishingly
 *  rare given uuid identity) becomes resolvable promptly, long enough to suppress
 *  hammering on a known-bad bearer. Plan U2 default. */
const NEG_TTL_SECONDS = 60;

/** Postgres error code for "invalid input syntax" (e.g. a non-uuid tokenId).
 *  Treated as structurally not-found/revoked, matching the old Convex
 *  contract where a malformed id resolved to `null`, not a transient
 *  failure. */
const POSTGRES_INVALID_TEXT_REPRESENTATION = '22P02';

/** Redis key namespace for the negative-cache sentinel. */
const NEG_CACHE_KEY_PREFIX = 'pro-mcp-token-neg:';

/** Sentinel value (presence check is what matters; value is opaque). */
const NEG_SENTINEL_VALUE = '1';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProMcpValidateResult {
  userId: string;
}

/**
 * Discriminated union returned by `validateProMcpToken`. Distinguishes:
 *   - `valid`: Postgres returned an active row → `{userId}` resolved.
 *   - `revoked`: Postgres authoritatively returned no row (missing,
 *               revoked, or malformed id) → negative-cache sentinel is
 *               written; safe to fail-closed.
 *   - `transient`: Postgres/network error, timeout, or unconfigured backend.
 *                 No neg-cache write — a blip should not mark a legitimate
 *                 token as bad for 60s.
 *
 * Refresh-grant callers (api/oauth/token.ts) need this distinction so a
 * transient Postgres blip does NOT consume the user's refresh token. See
 * F3 in the U7+U8 review pass.
 */
export type ProMcpValidateUnion =
  | { ok: 'valid'; userId: string }
  | { ok: 'revoked' }
  | { ok: 'transient' };

export interface ProMcpIssueResult {
  tokenId: string;
}

/** Discriminated error kinds for `issueProMcpTokenForUser`.
 *
 * `pro-required` is retained for caller-side type compatibility
 * (api/oauth/authorize-pro.ts branches on it) but this module never throws
 * it anymore — every caller of `issueProMcpTokenForUser` already resolves
 * and checks `getEntitlements(userId)` itself before calling in, and post-
 * Stage-1 every verified userId is entitled (no plan gating left to
 * re-check here). */
export type IssueFailedKind =
  | 'pro-required'        // Retained for type compat; never thrown here.
  | 'invalid-user-id'     // Empty/missing userId.
  | 'config'              // Edge env (SUPABASE_URL / service role key) missing.
  | 'network';            // Postgres error, network error, or unexpected shape.

export class ProMcpIssueFailed extends Error {
  readonly kind: IssueFailedKind;
  readonly status?: number;
  constructor(kind: IssueFailedKind, message: string, status?: number) {
    super(message);
    this.name = 'ProMcpIssueFailed';
    this.kind = kind;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Negative-cache helpers — direct Upstash REST so the cache key is exactly
// `pro-mcp-token-neg:<tokenId>` and does NOT inherit env-prefix semantics
// from `redis.ts` (these tokenIds are uuids scoped to this Supabase project
// already; double-prefixing would be redundant). UNCHANGED from the
// Convex-backed version — this layer was already independent of
// Convex/Clerk.
// ---------------------------------------------------------------------------

const REDIS_OP_TIMEOUT_MS = 1_500;

function negCacheKey(tokenId: string): string {
  return `${NEG_CACHE_KEY_PREFIX}${tokenId}`;
}

async function readNegCache(tokenId: string): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent(negCacheKey(tokenId))}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REDIS_OP_TIMEOUT_MS),
    });
    if (!resp.ok) return false;
    const data = (await resp.json()) as { result?: string | null };
    return typeof data.result === 'string' && data.result.length > 0;
  } catch (err) {
    // Fail-open on Redis errors: round-trip Postgres this once; the worst
    // case is one extra Postgres call, which is the safe direction.
    console.warn('[pro-mcp-token] readNegCache failed:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function writeNegCache(tokenId: string): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(
      `${url}/set/${encodeURIComponent(negCacheKey(tokenId))}/${encodeURIComponent(NEG_SENTINEL_VALUE)}/EX/${NEG_TTL_SECONDS}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REDIS_OP_TIMEOUT_MS),
      },
    );
  } catch (err) {
    // Best-effort: if we can't write the sentinel, the next request will
    // re-hit Postgres. Not load-bearing for correctness.
    console.warn('[pro-mcp-token] writeNegCache failed:', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Issue a new Pro MCP token row in `worldmonitor.mcp_pro_tokens`.
 *
 * Called from `/oauth/authorize-pro` (U5) AFTER the caller has already
 * verified entitlement (`getEntitlements(userId)` — tier ≥ 1 + mcpAccess,
 * trivially true for every verified Supabase user post-Stage-1). Throws a
 * typed `ProMcpIssueFailed`:
 *   - `invalid-user-id`: empty/missing userId. U5 returns 400.
 *   - `network`: Postgres error, network error, or unexpected shape. U5
 *     returns 503 (the OAuth flow is replayable — Claude will retry).
 *   - `config`: edge env missing. U5 returns 500.
 *
 * Per-user cap: enforces `MAX_TOKENS_PER_USER` (5) active rows with silent
 * oldest-first rotation — mirrors `convex/mcpProTokens.ts::issueProMcpToken`'s
 * race-tolerant design (revoke every active row beyond `MAX - 1` rather than
 * "exactly one", so a brief concurrent-issue overshoot converges back to the
 * cap on the next call instead of staying stuck above it).
 */
export async function issueProMcpTokenForUser(
  userId: string,
  clientId?: string,
  name?: string,
): Promise<ProMcpIssueResult> {
  if (!userId) {
    throw new ProMcpIssueFailed('invalid-user-id', 'Invalid userId for Pro MCP token issue', 400);
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    throw new ProMcpIssueFailed(
      'config',
      'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured',
    );
  }

  try {
    const { data: active, error: listError } = await supabase
      .from('mcp_pro_tokens')
      .select('id, created_at')
      .eq('user_id', userId)
      .is('revoked_at', null)
      .order('created_at', { ascending: true });

    if (listError) {
      throw new ProMcpIssueFailed('network', `Supabase active-token list failed: ${listError.message}`);
    }

    if (active && active.length >= MAX_TOKENS_PER_USER) {
      const toRevoke = active.slice(0, active.length - (MAX_TOKENS_PER_USER - 1));
      const revokeIds = toRevoke.map((row) => row.id as string);
      if (revokeIds.length > 0) {
        const { error: revokeError } = await supabase
          .from('mcp_pro_tokens')
          .update({ revoked_at: new Date().toISOString() })
          .in('id', revokeIds);
        if (revokeError) {
          // Non-fatal: worst case is a transient cap overshoot that the
          // next issue call's list+revoke pass converges back down.
          console.warn('[pro-mcp-token] oldest-excess rotation failed (non-fatal):', revokeError.message);
        }
      }
    }

    const { data: inserted, error: insertError } = await supabase
      .from('mcp_pro_tokens')
      .insert({ user_id: userId, client_id: clientId, name })
      .select('id')
      .single();

    if (insertError || !inserted) {
      throw new ProMcpIssueFailed(
        'network',
        `Supabase insert failed: ${insertError?.message ?? 'no row returned'}`,
      );
    }

    return { tokenId: inserted.id as string };
  } catch (err) {
    if (err instanceof ProMcpIssueFailed) throw err;
    throw new ProMcpIssueFailed(
      'network',
      `Supabase issue request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Validate a Pro MCP token by tokenId — discriminated-union variant.
 *
 * Returns `{ok:'valid', userId}` if the row exists and is not revoked.
 * Returns `{ok:'revoked'}` if Postgres authoritatively found no matching,
 * non-revoked row (missing, revoked, or malformed id). Returns
 * `{ok:'transient'}` on a Postgres/network error or unconfigured backend —
 * caller can decide whether to fail-closed (per-request validate) or
 * preserve the refresh token (refresh-grant path) instead of consuming it.
 *
 * Caching policy (load-bearing — see plan U2):
 *   1. Read `pro-mcp-token-neg:<tokenId>`. If sentinel is present, return
 *      `{ok:'revoked'}` IMMEDIATELY without hitting Postgres.
 *   2. Otherwise query `worldmonitor.mcp_pro_tokens` directly.
 *   3. If a non-revoked row is found: return `{ok:'valid', userId}`. Do NOT
 *      cache positively (revoke must be authoritative on the next request).
 *   4. If no row / revoked / malformed id: write the negative-cache
 *      sentinel (60s TTL) and return `{ok:'revoked'}`.
 *   5. If the query errors for any other reason, or Postgres is
 *      unconfigured: log + return `{ok:'transient'}`. (Fail-soft. Do NOT
 *      write the sentinel — a blip should not mark a legitimate token as
 *      bad for 60s.)
 *
 * Most callers want the simpler `userId | null` shape (per-request
 * validate, fail-closed on transient is correct because a 401 will retry
 * via the OAuth flow anyway). Use {@link validateProMcpTokenOrNull} for
 * that — it wraps this and maps `revoked|transient → null`.
 */
export async function validateProMcpToken(tokenId: string): Promise<ProMcpValidateUnion> {
  if (!tokenId) return { ok: 'revoked' };

  // Step 1: negative-cache short-circuit.
  if (await readNegCache(tokenId)) return { ok: 'revoked' };

  // Step 2: Postgres round-trip.
  const supabase = getSupabaseAdmin();
  if (!supabase) return { ok: 'transient' };

  let userId: string | null = null;
  try {
    const { data, error } = await supabase
      .from('mcp_pro_tokens')
      .select('user_id')
      .eq('id', tokenId)
      .is('revoked_at', null)
      .maybeSingle();

    if (error) {
      if (error.code === POSTGRES_INVALID_TEXT_REPRESENTATION) {
        // Malformed tokenId (not a uuid) -- structurally not-found, matches
        // the old Convex malformed-id -> null contract. Not transient.
        await writeNegCache(tokenId);
        return { ok: 'revoked' };
      }
      console.warn(`[pro-mcp-token] validateProMcpToken Supabase query failed: ${error.message}`);
      return { ok: 'transient' };
    }

    if (data && typeof data.user_id === 'string' && data.user_id.length > 0) {
      userId = data.user_id;
    }
  } catch (err) {
    console.warn(
      '[pro-mcp-token] validateProMcpToken Supabase fetch failed:',
      err instanceof Error ? err.message : String(err),
    );
    return { ok: 'transient' };
  }

  if (userId) {
    // Step 3: positive — return WITHOUT caching.
    return { ok: 'valid', userId };
  }

  // Step 4: negative — write sentinel and return revoked.
  await writeNegCache(tokenId);
  return { ok: 'revoked' };
}

/**
 * Backward-compatible wrapper that maps the discriminated union to the
 * legacy `{userId} | null` shape. Use this for per-request validate paths
 * where transient and revoked both fail-closed (the caller returns 401 and
 * the client retries via OAuth — no information loss).
 *
 * The refresh-grant path in `api/oauth/token.ts` MUST call
 * `validateProMcpToken` directly to distinguish transient from revoked,
 * otherwise a Postgres blip silently consumes the refresh token.
 */
export async function validateProMcpTokenOrNull(tokenId: string): Promise<ProMcpValidateResult | null> {
  const r = await validateProMcpToken(tokenId);
  if (r.ok === 'valid') return { userId: r.userId };
  return null;
}

/**
 * Revoke a Pro MCP token directly against `worldmonitor.mcp_pro_tokens`
 * (service-role Postgres update, tenancy-checked).
 *
 * Use this from rollback paths (e.g. `/oauth/authorize-pro` U5: after
 * `issueProMcpToken` succeeds but the `oauth:code` SETEX fails) and from
 * the settings-UI revoke endpoint (U9).
 *
 * After a successful revoke, writes the negative-cache sentinel so any
 * already-resolved bearer with this tokenId stops on the next validate.
 *
 * Tenancy gate: the update is scoped to `id = tokenId AND user_id = userId`.
 * A mismatch (wrong owner, or no such row) is reported as `not-found` —
 * never `already-revoked` — so a misbehaving caller cannot use this
 * endpoint to probe whether a tokenId exists or is revoked for another
 * user's account.
 *
 * Returns `{ ok: true }` on success, `{ ok: false, reason }` on logical
 * failures (NOT_FOUND / ALREADY_REVOKED / config / network). Does not
 * throw — rollback callers should not let revoke errors mask the original
 * cause they were rolling back from.
 */
export async function revokeProMcpToken(
  userId: string,
  tokenId: string,
): Promise<{ ok: true } | { ok: false; reason: 'config' | 'not-found' | 'already-revoked' | 'network' }> {
  if (!userId || !tokenId) return { ok: false, reason: 'not-found' };

  const supabase = getSupabaseAdmin();
  if (!supabase) return { ok: false, reason: 'config' };

  try {
    const { data: updated, error: updateError } = await supabase
      .from('mcp_pro_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', tokenId)
      .eq('user_id', userId)
      .is('revoked_at', null)
      .select('id')
      .maybeSingle();

    if (updateError) {
      if (updateError.code === POSTGRES_INVALID_TEXT_REPRESENTATION) {
        return { ok: false, reason: 'not-found' };
      }
      console.warn('[pro-mcp-token] revokeProMcpToken update failed:', updateError.message);
      return { ok: false, reason: 'network' };
    }

    if (updated) {
      // Set the negative-cache sentinel so the next validate short-circuits
      // even if some in-flight bearer has already been resolved.
      await writeNegCache(tokenId);
      return { ok: true };
    }

    // No row updated -- disambiguate the reason WITHOUT leaking existence
    // of another user's token: only report 'already-revoked' when the row
    // is confirmed to belong to this userId; anything else (missing row,
    // owned by someone else) reports 'not-found'.
    const { data: existing, error: selectError } = await supabase
      .from('mcp_pro_tokens')
      .select('user_id, revoked_at')
      .eq('id', tokenId)
      .maybeSingle();

    if (selectError || !existing || existing.user_id !== userId) {
      return { ok: false, reason: 'not-found' };
    }
    return { ok: false, reason: existing.revoked_at ? 'already-revoked' : 'not-found' };
  } catch (err) {
    console.warn(
      '[pro-mcp-token] revokeProMcpToken failed:',
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, reason: 'network' };
  }
}

/**
 * Set the negative-cache sentinel for a tokenId. Public so the U9 settings
 * revoke endpoint can call this after a successful revoke to invalidate any
 * cached bearers.
 *
 * Equivalent to writing `pro-mcp-token-neg:<tokenId>` = "1" with 60s EX.
 */
export async function invalidateProMcpTokenCache(tokenId: string): Promise<void> {
  if (!tokenId) return;
  await writeNegCache(tokenId);
}

/**
 * Test/admin helper: clear the negative-cache sentinel for a tokenId.
 * Used by integration tests; not exercised by production code paths.
 */
export async function clearProMcpTokenNegCache(tokenId: string): Promise<void> {
  if (!tokenId) return;
  await deleteRedisKey(negCacheKey(tokenId), /* raw */ true);
}

// ---------------------------------------------------------------------------
// Daily quota counter — single-source-of-truth key shape
// ---------------------------------------------------------------------------

/**
 * Redis key shape for the Pro daily-quota INCR/DECR counter.
 *
 * U7 (api/mcp.ts) writes via INCR-first reservation on every `tools/call`.
 * U9 (api/user/mcp-quota.ts) reads the same key for the settings UI.
 * BOTH MUST CALL THIS HELPER — drift between writer and reader produces
 * silent UI-vs-enforcement disagreement (the failure mode this helper exists
 * to prevent).
 *
 * Date is UTC YYYY-MM-DD. The fixed UTC midnight rollover is documented in
 * the plan ("Daily window — sliding or fixed? R: Fixed UTC midnight via
 * single Redis INCR counter for predictable reset and clean UI copy.").
 *
 * Env-prefixed: when running on a Vercel preview deploy
 * (VERCEL_ENV=preview, with VERCEL_GIT_COMMIT_SHA), the key is prefixed
 * `<env>:<sha8>:<base>` so preview traffic does NOT collide with
 * production counters in the shared Upstash instance. Production
 * (VERCEL_ENV unset or 'production') uses the bare base key — preserves
 * the historical wire format.
 *
 * Mirrors `server/_shared/redis.ts`'s `prefixKey` convention; replicated
 * here (not imported) because this helper is read by both the API edge
 * runtime and the gateway, and direct Upstash REST callers in this module
 * cannot consume the JSON-helper-specific paths in `redis.ts`.
 *
 * @param userId Supabase auth.users id. Empty / falsy → returns "" (caller
 *               should never reach the INCR path with no userId, but the
 *               empty-key fail-soft mirrors the rest of this module).
 * @param date   Optional Date for test injection; defaults to `new Date()`.
 */
export function dailyCounterKey(userId: string, date?: Date): string {
  if (!userId) return '';
  const d = date ?? new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const base = `mcp:pro-usage:${userId}:${yyyy}-${mm}-${dd}`;
  return `${envPrefix()}${base}`;
}

/**
 * Compute the env-prefix at call time (NOT memoized — tests may mutate
 * VERCEL_ENV between calls; the cost is one trivial string read).
 * Production / unset → empty string. Mirrors `redis.ts::getKeyPrefix`.
 */
function envPrefix(): string {
  const env = process.env.VERCEL_ENV;
  if (!env || env === 'production') return '';
  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || 'dev';
  return `${env}:${sha}:`;
}

/**
 * Seconds remaining until the next UTC midnight — used for the
 * `Retry-After` header on -32029 quota-exceeded responses.
 */
export function secondsUntilUtcMidnight(now?: Date): number {
  const d = now ?? new Date();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0));
  return Math.max(1, Math.ceil((next.getTime() - d.getTime()) / 1000));
}

/** Hard cap per UTC day for Pro MCP `tools/call`s. Plan default. */
export const PRO_DAILY_QUOTA_LIMIT = 50;

/** TTL on the daily counter Redis key. 48h covers UTC-midnight rollover plus
 *  inspection window (operators can poke at yesterday's value through ~midday
 *  the next UTC day before the EXPIRE evicts it). */
export const PRO_DAILY_QUOTA_TTL_SECONDS = 172_800;
