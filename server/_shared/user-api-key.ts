/**
 * Validates user-owned API keys by hashing the provided key and looking up
 * the hash directly in `worldmonitor.api_keys` (Postgres, service-role
 * client) -- Stage 1 of the Convex/Clerk -> Supabase migration replaced the
 * old Convex internal HTTP action with a direct query.
 *
 * Uses cachedFetchJson for Redis caching with in-flight coalescing and
 * environment-partitioned keys (no raw=true — keys are prefixed by deploy).
 */

import { cachedFetchJson, deleteRedisKey } from './redis';
import { getSupabaseAdmin } from './supabase-admin';

interface UserKeyResult {
  userId: string;
  /**
   * Only `userId` is guaranteed. No caller reads keyId/name (they read only
   * `.userId`), so the runtime guard below requires only `userId`.
   */
  keyId?: string;
  name?: string;
}

/**
 * Canonical user API key: `wm_` + 40 lowercase hex (20 random bytes). This is
 * the only shape `generateKey()` in src/services/api-keys.ts ever mints.
 *
 * Deliberately DUPLICATED from `USER_API_KEY_RE` in api/_user-api-key.js rather
 * than imported: that module evaluates env at load and pulls in redisPipeline +
 * client-ip, none of which belong in the edge gateway bundle for one regex.
 * server/__tests__/user-api-key-validation.test.ts asserts the two literals stay
 * byte-identical, so drift fails CI instead of silently splitting the contract.
 */
const USER_API_KEY_RE = /^wm_[a-f0-9]{40}$/;

const CACHE_TTL_SECONDS = 60; // 1 min — short to limit staleness on revocation
const NEG_TTL_SECONDS = 60;   // negative cache: avoid hammering Postgres with invalid keys
const CACHE_KEY_PREFIX = 'user-api-key:';

// Debounce window for the last_used_at touch — mirrors the old Convex
// touchKeyLastUsed's 5-min debounce so an actively-used key doesn't write
// on every cache-miss lookup.
const LAST_USED_DEBOUNCE_MS = 5 * 60 * 1_000;

/**
 * Runtime shape guard for whatever comes back from the cache or Postgres.
 * `cachedFetchJson<UserKeyResult>` only CASTS its payload, so a poisoned cache
 * entry or an upstream shape drift (e.g. `{}`) would otherwise reach callers as
 * a truthy "authenticated principal" whose `.userId` reads as undefined.
 */
function isUserKeyResult(value: unknown): value is UserKeyResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  // OWN property only: a polluted Object.prototype.userId would otherwise let
  // a bare `{}` authenticate through the prototype chain.
  if (!Object.prototype.hasOwnProperty.call(value, 'userId')) return false;
  const userId = (value as { userId?: unknown }).userId;
  return typeof userId === 'string' && userId.length > 0;
}

/** SHA-256 hex digest (Web Crypto API — works in Edge Runtime). */
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate a user-owned API key.
 *
 * Returns the userId and key metadata if valid, or null if invalid/revoked.
 * Uses cachedFetchJson for Redis caching with request coalescing and
 * standard NEG_SENTINEL for negative results.
 */
export async function validateUserApiKey(key: string): Promise<UserKeyResult | null> {
  // Reject malformed keys BEFORE hashing. `startsWith('wm_')` alone let `wm_x`
  // burn a SHA-256, a Redis round-trip and a Postgres lookup per attempt, turning
  // an unauthenticated caller into a backend amplifier.
  if (!USER_API_KEY_RE.test(key ?? '')) return null;

  const keyHash = await sha256Hex(key);
  const cacheKey = `${CACHE_KEY_PREFIX}${keyHash}`;

  try {
    const result = await cachedFetchJson<UserKeyResult>(
      cacheKey,
      CACHE_TTL_SECONDS,
      () => fetchFromSupabase(keyHash),
      NEG_TTL_SECONDS,
    );
    // null is the legitimate negative-cache / unknown-key answer — pass it
    // through untouched. Anything non-null must prove it carries an identity.
    if (result === null) return null;
    if (!isUserKeyResult(result)) {
      // Log the type only: the payload and the key hash are credential material.
      console.warn(`[user-api-key] discarding non-conforming validation payload (type=${Array.isArray(result) ? 'array' : typeof result})`);
      return null;
    }
    return result;
  } catch (err) {
    // Fail-soft: transient Postgres/network errors degrade to unauthorized
    // rather than bubbling a 500 through the gateway or isCallerPremium.
    console.warn('[user-api-key] validateUserApiKey failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Fetch key validation directly from `worldmonitor.api_keys` (service-role). */
async function fetchFromSupabase(keyHash: string): Promise<UserKeyResult | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('api_keys')
    .select('id, user_id, name, last_used_at')
    .eq('key_hash', keyHash)
    .is('revoked_at', null)
    .maybeSingle();

  if (error) {
    console.warn('[user-api-key] Supabase lookup failed:', error.message);
    return null;
  }
  if (!data) return null;

  // Best-effort, debounced last_used_at touch. Not awaited — this is a
  // fire-and-forget freshness update, not load-bearing for the validation
  // result itself, mirroring the old Convex touchKeyLastUsed debounce.
  touchLastUsedFireAndForget(data.id as string, data.last_used_at as string | null);

  return {
    userId: data.user_id as string,
    keyId: data.id as string,
    name: (data.name as string | null) ?? undefined,
  };
}

/**
 * Fire-and-forget `last_used_at` touch, debounced against the row's
 * previously-read value so an actively-polled key doesn't write on every
 * cache-miss lookup. Errors are logged, never thrown — this must never
 * fail the validation it rides along with.
 */
function touchLastUsedFireAndForget(keyId: string, lastUsedAt: string | null): void {
  const lastUsedMs = lastUsedAt ? Date.parse(lastUsedAt) : NaN;
  if (Number.isFinite(lastUsedMs) && Date.now() - lastUsedMs < LAST_USED_DEBOUNCE_MS) return;

  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  void supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', keyId)
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) {
        console.warn('[user-api-key] last_used_at touch failed:', error.message);
      }
    });
}

/**
 * Delete the Redis cache entry for a specific API key hash.
 * Called after revocation to ensure the key cannot be used during the TTL window.
 * Uses prefixed keys (no raw=true) matching the cache writes above.
 */
export async function invalidateApiKeyCache(keyHash: string): Promise<void> {
  await deleteRedisKey(`${CACHE_KEY_PREFIX}${keyHash}`);
}
