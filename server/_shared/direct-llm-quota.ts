import { getKeyPrefix } from './redis';
import { DAILY_COUNTER_TTL_SECONDS, secondsUntilUtcMidnight } from './utc-midnight';

/**
 * Daily per-user LLM call budget. Exists to cap real LLM spend on a public
 * SaaS deployment; this fork is an internal-tools fork with no public users,
 * so it is configurable here rather than hardcoded.
 *
 * `DIRECT_LLM_DAILY_QUOTA_LIMIT` env values:
 *   unset            -> 50 (the original SaaS default, unchanged)
 *   a positive int   -> that budget
 *   0 / off / unlimited -> quota disabled entirely (see DIRECT_LLM_QUOTA_DISABLED)
 * A malformed value falls back to 50 rather than to "unlimited", so a typo can
 * never silently uncap spend.
 */
function resolveDirectLlmDailyQuotaLimit(): number {
  const raw = (process.env.DIRECT_LLM_DAILY_QUOTA_LIMIT ?? '').trim().toLowerCase();
  if (!raw) return 50;
  if (raw === '0' || raw === 'off' || raw === 'unlimited') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;
}

export const DIRECT_LLM_DAILY_QUOTA_LIMIT = resolveDirectLlmDailyQuotaLimit();

/** True when the daily LLM quota is switched off entirely. */
export const DIRECT_LLM_QUOTA_DISABLED = DIRECT_LLM_DAILY_QUOTA_LIMIT === 0;
export const DIRECT_LLM_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

export const DIRECT_LLM_GATEWAY_QUOTA_PATHS = new Set<string>([
  '/api/intelligence/v1/classify-event',
  '/api/intelligence/v1/deduct-situation',
  '/api/intelligence/v1/get-country-intel-brief',
  '/api/market/v1/analyze-stock',
  '/api/news/v1/summarize-article',
]);

export const DIRECT_LLM_SELF_METERED_QUOTA_PATHS = new Set<string>([
  '/api/chat-analyst',
]);

export const DIRECT_LLM_QUOTA_PATHS = new Set<string>([
  ...DIRECT_LLM_GATEWAY_QUOTA_PATHS,
  ...DIRECT_LLM_SELF_METERED_QUOTA_PATHS,
]);

export type DirectLlmQuotaReservation =
  | { ok: true; newCount: number; rollback: () => Promise<void> }
  | {
      ok: false;
      reason: 'cap-exceeded' | 'redis-unavailable';
      floor?: number;
      retryAfterSec: number;
    };

export type DirectLlmQuotaPipeline = (
  commands: Array<Array<string | number>>,
) => Promise<Array<{ result?: unknown }>>;

export function directLlmDailyQuotaKey(userId: string, date?: Date): string {
  if (!userId) return '';
  const d = date ?? new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${getKeyPrefix()}llm:direct-usage:${userId}:${yyyy}-${mm}-${dd}`;
}

export async function reserveDirectLlmQuota(opts: {
  userId: string;
  pipeline: DirectLlmQuotaPipeline;
  date?: Date;
}): Promise<DirectLlmQuotaReservation> {
  const retryAfterSec = secondsUntilUtcMidnight(opts.date);
  const key = directLlmDailyQuotaKey(opts.userId, opts.date);
  if (!key) {
    return {
      ok: false,
      reason: 'redis-unavailable',
      retryAfterSec: DIRECT_LLM_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
    };
  }

  let pipeResult: Array<{ result?: unknown }> | null;
  try {
    pipeResult = await opts.pipeline([
      ['INCR', key],
      ['EXPIRE', key, DAILY_COUNTER_TTL_SECONDS],
    ]);
  } catch {
    pipeResult = null;
  }

  if (!pipeResult || !Array.isArray(pipeResult) || pipeResult.length === 0) {
    return {
      ok: false,
      reason: 'redis-unavailable',
      retryAfterSec: DIRECT_LLM_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
    };
  }

  const incrRaw = pipeResult[0]?.result;
  const newCount = typeof incrRaw === 'number' ? incrRaw : Number(incrRaw);
  if (!Number.isFinite(newCount) || newCount < 1) {
    return {
      ok: false,
      reason: 'redis-unavailable',
      retryAfterSec: DIRECT_LLM_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
    };
  }

  let rolledBack = false;
  const rollback = async (): Promise<void> => {
    if (rolledBack) return;
    rolledBack = true;
    try {
      await opts.pipeline([['DECR', key]]);
    } catch {
      // Best-effort: over-counting by one is the cost-protection-correct direction.
    }
  };

  if (newCount > DIRECT_LLM_DAILY_QUOTA_LIMIT) {
    await rollback();
    return {
      ok: false,
      reason: 'cap-exceeded',
      floor: DIRECT_LLM_DAILY_QUOTA_LIMIT,
      retryAfterSec,
    };
  }

  return { ok: true, newCount, rollback };
}
