/**
 * Shared UTC-midnight reset helper for daily quota/rate-limit counters.
 *
 * Extracted from the retired Pro-MCP-token module (which used to be the
 * sole owner of this logic) so `direct-llm-quota.ts` and
 * `api-key-rate-limit.ts` don't depend on a billing-specific module for a
 * generic time calculation.
 */
export function secondsUntilUtcMidnight(now?: Date): number {
  const d = now ?? new Date();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0));
  return Math.max(1, Math.ceil((next.getTime() - d.getTime()) / 1000));
}

/** TTL on a daily counter Redis key. 48h covers UTC-midnight rollover plus
 *  an inspection window (operators can poke at yesterday's value through
 *  ~midday the next UTC day before the EXPIRE evicts it). */
export const DAILY_COUNTER_TTL_SECONDS = 172_800;
