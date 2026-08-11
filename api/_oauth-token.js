// @ts-expect-error — JS module, no declaration file
import { keyFingerprint, sha256Hex } from './_crypto.js';
// @ts-expect-error — JS module, no declaration file
import { getRedisCredentials } from './_upstash-json.js';

/**
 * Bearer-to-context resolver for the OAuth + MCP edge.
 *
 * The Clerk-grant "Pro" MCP flow (`/oauth/authorize-pro`, the
 * `{kind:'pro', userId, mcpTokenId}` Redis shape) was retired along with
 * billing — `oauth:token:<uuid>` now stores exactly one shape: a bare
 * JSON-string holding either a 64-hex SHA-256 of a `wm_*` key
 * (authorization_code / refresh) or a 16-char key-fingerprint
 * (client_credentials).
 *     stored = "abc123..."           // typeof === 'string'
 *
 * Authorization-code / refresh-token issued access tokens also get
 * `oauth:tokenfam:<uuid>`; when `oauth:famrev:<family_id>` exists, the
 * resolver rejects that bearer so refresh-token reuse containment applies
 * to already-issued access tokens too.
 *
 * Public surface:
 *   - `resolveBearerToContext(token)` — preferred. Returns the
 *     `McpAuthContext` (`{kind:'env_key', apiKey}`), or null on miss /
 *     malformed / unknown shape.
 *   - `resolveApiKeyFromBearer(token)` — thin wrapper returning the
 *     cleartext `wm_*` key directly.
 */

async function fetchOAuthValue(key) {
  const creds = getRedisCredentials();
  if (!creds) return null;

  const resp = await fetch(`${creds.url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${creds.token}` },
    signal: AbortSignal.timeout(3_000),
  });
  // Throw on HTTP error so callers can distinguish Redis failure (→ 503) from missing token (→ 401).
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);

  const data = await resp.json();
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}

async function fetchOAuthToken(uuid) {
  return fetchOAuthValue(`oauth:token:${uuid}`);
}

async function fetchAccessTokenFamily(uuid) {
  return fetchOAuthValue(`oauth:tokenfam:${uuid}`);
}

async function isRefreshFamilyRevoked(familyId) {
  return (await fetchOAuthValue(`oauth:famrev:${familyId}`)) != null;
}

// Legacy: 16-char fingerprint for client_credentials tokens (backward compat)
export async function resolveApiKeyFromFingerprint(fingerprint) {
  if (typeof fingerprint !== 'string' || !fingerprint) return null;
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  for (const k of validKeys) {
    if (await keyFingerprint(k) === fingerprint) return k;
  }
  return null;
}

// New: full SHA-256 (64 hex chars) for authorization_code / refresh_token issued tokens
export async function resolveApiKeyFromHash(fullHash) {
  if (typeof fullHash !== 'string' || fullHash.length !== 64) return null;
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  for (const k of validKeys) {
    if (await sha256Hex(k) === fullHash) return k;
  }
  return null;
}

/**
 * Resolve a bearer token to the `McpAuthContext` (`{kind:'env_key', apiKey}`
 * or null).
 *
 * Branch logic:
 *   - typeof raw === 'string' → bare-string. Length-dispatches to
 *     `resolveApiKeyFromHash` (64) or `resolveApiKeyFromFingerprint` (16).
 *   - Anything else (bad length, object shape, missing fields, unknown
 *     shape) → null. Defensive: a future shape must explicitly opt in
 *     here, not implicitly leak through as a falsy/undefined branch.
 *
 * Throws on Redis HTTP failure (mirrors `fetchOAuthToken`) — callers map
 * that to 503. Returns null on Redis miss + JSON-parse failure (existing
 * behavior preserved; both indistinguishable from "bad bearer" upstream).
 */
export async function resolveBearerToContext(token) {
  if (!token || typeof token !== 'string') return null;
  const raw = await fetchOAuthToken(token);
  if (raw == null) return null;

  const familyId = await fetchAccessTokenFamily(token);
  if (typeof familyId === 'string' && familyId && await isRefreshFamilyRevoked(familyId)) {
    return null;
  }

  if (typeof raw !== 'string' || !raw) return null;
  let apiKey = null;
  if (raw.length === 64) apiKey = await resolveApiKeyFromHash(raw);
  else if (raw.length === 16) apiKey = await resolveApiKeyFromFingerprint(raw);
  return apiKey ? { kind: 'env_key', apiKey } : null;
}

/** Returns the cleartext `wm_*` API key, or null. */
export async function resolveApiKeyFromBearer(token) {
  const ctx = await resolveBearerToContext(token);
  return ctx ? ctx.apiKey : null;
}
