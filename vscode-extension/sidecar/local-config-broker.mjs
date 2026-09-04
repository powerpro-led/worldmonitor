/**
 * local-config-broker — the client half of the per-org config broker (P4).
 *
 * The operator's local backend ships with no Upstash credential. It gets one by
 * calling this org's `local-config` Supabase Edge Function with the Supabase
 * session that `worldmonitor-local login` wrote, then caches the answer in
 * ~/.worldmonitor/config.db and re-fetches hourly. Withdrawing someone's access
 * (banning or deleting their Supabase user) therefore stops their mirror within
 * the hour — see supabase/functions/local-config/index.ts for why a liveness
 * check there is what makes the re-fetch mean anything.
 *
 * FAILURE POLICY, which is the whole design:
 *
 *   401 / 403  -> DROP the cache. The session is dead or access was revoked;
 *                 keeping a working mirror on a laptop that is no longer
 *                 entitled to one is the exact failure this broker exists to
 *                 prevent.
 *   network / 5xx / timeout -> KEEP the cache and retry on the next tick. A
 *                 Supabase or network outage must not wipe every operator's
 *                 mirror simultaneously; the cache is stale-but-authorised,
 *                 which is strictly better than empty.
 *   no session -> do nothing. The operator simply hasn't run `login` yet; that
 *                 is a normal first-run state, not a failure.
 */
import {
  BROKERED_CONFIG_KEYS,
  BROKER_REFRESH_INTERVAL_MS,
  RESTART_REQUIRED_CONFIG_KEYS,
  clearBrokeredConfig,
  isBrokerCacheStale,
  loadConfigIntoEnv,
  writeBrokeredConfig,
} from './config-store.mjs';
import { readOperatorSession } from './session-file.mjs';

const BROKER_TIMEOUT_MS = 10_000;

/** Silent by default so importing this module never writes to a caller's stdout. */
const NOOP_LOGGER = { log() {}, warn() {}, error() {} };

/**
 * Map the edge function's JSON onto config keys. Kept in one place so the wire
 * shape and the store's key names can evolve independently — the function
 * speaks camelCase, `process.env` speaks SCREAMING_SNAKE.
 */
function brokerResponseToConfig(body) {
  return {
    UPSTASH_REDIS_REST_URL: body?.upstashUrl,
    UPSTASH_REDIS_REST_READONLY_TOKEN: body?.upstashReadonlyToken,
    APP_DOMAIN: body?.appDomain,
  };
}

/**
 * One HTTP call to the broker. Returns a discriminated result rather than
 * throwing on an HTTP status, so the caller's policy above reads as a switch
 * instead of a try/catch that has to re-derive what went wrong.
 *
 * @returns {Promise<{outcome: 'ok', values: object} | {outcome: 'revoked', status: number} | {outcome: 'unavailable', reason: string}>}
 */
export async function fetchBrokerConfig({
  supabaseUrl,
  accessToken,
  fetchImpl = fetch,
  timeoutMs = BROKER_TIMEOUT_MS,
}) {
  const url = `${String(supabaseUrl).replace(/\/+$/, '')}/functions/v1/local-config`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { outcome: 'unavailable', reason: err?.message || String(err) };
  }

  if (response.status === 401 || response.status === 403) {
    return { outcome: 'revoked', status: response.status };
  }
  if (!response.ok) {
    return { outcome: 'unavailable', reason: `HTTP ${response.status}` };
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    return { outcome: 'unavailable', reason: `malformed JSON: ${err?.message || err}` };
  }

  const values = brokerResponseToConfig(body);
  // A 200 that is missing a field is a broken deployment, not an authorisation
  // decision — treat it as unavailable so the existing cache survives.
  const missing = BROKERED_CONFIG_KEYS.filter((k) => !values[k]);
  if (missing.length) {
    return { outcome: 'unavailable', reason: `response missing ${missing.join(', ')}` };
  }
  return { outcome: 'ok', values };
}

/**
 * Fetch and apply, honouring the cache TTL unless `force` is set (used right
 * after a fresh login, where waiting an hour for a first mirror would be
 * absurd). Updates both config.db and `env`, since `process.env` is what the
 * api/ handlers actually read.
 *
 * @returns {Promise<{status: string, changed?: string[], reason?: string}>}
 */
export async function refreshBrokeredConfig({
  env = process.env,
  logger = NOOP_LOGGER,
  force = false,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  if (!force && !isBrokerCacheStale(now)) return { status: 'fresh' };

  const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
  if (!supabaseUrl) return { status: 'unconfigured' };

  const session = readOperatorSession();
  if (!session?.access_token) return { status: 'signed-out' };

  const result = await fetchBrokerConfig({
    supabaseUrl,
    accessToken: session.access_token,
    fetchImpl,
  });

  if (result.outcome === 'revoked') {
    clearBrokeredConfig(env);
    logger.warn(
      `[local-config] broker returned ${result.status} — access revoked or session dead. `
      + 'Cleared the cached Upstash credential; the mirror will stop updating. '
      + 'Run `worldmonitor-local login` to sign in again.',
    );
    return { status: 'revoked' };
  }

  if (result.outcome === 'unavailable') {
    // Deliberately not clearing — see the failure policy in the file header.
    logger.warn(`[local-config] broker unavailable (${result.reason}); keeping the cached config.`);
    return { status: 'unavailable', reason: result.reason };
  }

  const changed = writeBrokeredConfig(result.values);
  // Re-run the loader so the brokered values land in process.env under the
  // "brokered beats .env" rule, rather than duplicating that precedence here.
  loadConfigIntoEnv(env);

  if (changed.length === 0) {
    logger.log('[local-config] broker config refreshed (unchanged).');
    return { status: 'ok', changed };
  }

  logger.log(`[local-config] broker config refreshed; updated: ${changed.join(', ')}`);
  const needsRestart = changed.filter((k) => RESTART_REQUIRED_CONFIG_KEYS.includes(k));
  if (needsRestart.length) {
    // NOT auto-restarting: spawning `worldmonitor-local restart` from inside
    // the server is exactly the control-plane machinery Workstream R removed.
    // The token — the value that actually matters for revocation — is read from
    // process.env on every Redis call and so takes effect immediately; only the
    // origin allowlists built at module load are stale.
    logger.warn(
      `[local-config] ${needsRestart.join(', ')} changed — the CORS/SSRF allowlists are `
      + 'captured at startup, so run `worldmonitor-local restart` to pick them up.',
    );
  }
  return { status: 'ok', changed };
}

/**
 * Refresh once at startup, then on an interval. Mirrors
 * startSessionRefreshLoop()'s contract in local-api-server.mjs: returns a stop
 * function, never throws, never blocks startup.
 *
 * The interval is deliberately shorter than the TTL — refreshBrokeredConfig()
 * no-ops when the cache is still fresh, so a tick that fires early is cheap,
 * whereas a tick that fires late leaves a revoked operator running past the
 * hour P4 promises. A laptop that sleeps through a tick gets caught by the next
 * one, and the startup call covers a resume-from-cold.
 */
export function startBrokerRefreshLoop(context = {}) {
  const logger = context.logger || NOOP_LOGGER;
  const intervalMs = context.brokerRefreshIntervalMs ?? Math.floor(BROKER_REFRESH_INTERVAL_MS / 4);

  const tick = (force = false) => {
    refreshBrokeredConfig({ logger, force }).catch((err) => {
      logger.warn(`[local-config] refresh failed: ${err?.message || err}`);
    });
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  return () => clearInterval(timer);
}
