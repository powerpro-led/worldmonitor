// server/_shared/llm-health.ts
// Lightweight LLM provider health gate.
// Probes provider URLs with a fast request, caches results.
// All LLM call sites check this before attempting expensive fetch calls.

// 2026-09-01: was 2_000ms, causing false "unreachable" verdicts against
// openrouter.ai — measured round trips of 2.1s-3.8s from this network (VPN
// path, see vpn_destination_throttling pattern) blew straight through it.
// A false negative here doesn't just log a warning: isProviderAvailable()
// gates the real LLM call (llm.ts, summarize-article.ts), so a too-tight
// timeout silently skips a working provider for the full CACHE_TTL_MS below
// and dumps traffic onto whatever provider is next in the fallback chain.
//
// 2026-09-24: 5_000ms turned out to be the SAME bug recurring on a different
// network. A real Windows field report measured this exact probe (through
// local-api-server.mjs's ipv4Fetch wrapper — an SSRF-check DNS lookup plus a
// fixed-IPv4 connect plus the MAX_CONCURRENT_UPSTREAM queue, all of which the
// timeout budget has to cover, not just the request itself) taking
// 1.7s-9.1s across four consecutive real calls, three of the four over 5s,
// while every single one eventually returned HTTP 200 — OpenRouter was never
// actually unreachable. Bumped again, plus two changes so a future tuning
// pass isn't needed for every new slow network: one retry before a verdict
// of "unreachable" (a single slow/dropped attempt no longer condemns a
// working provider), and an asymmetric cache TTL (a negative result is kept
// only briefly, so a transient miss doesn't black out a working provider for
// the same minute a confirmed-good result earns).
const PROBE_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60_000; // re-probe every 60s once confirmed reachable
const NEGATIVE_CACHE_TTL_MS = 10_000; // re-probe soon after an "unreachable" verdict

interface HealthEntry {
  available: boolean;
  checkedAt: number;
}

const cache = new Map<string, HealthEntry>();
const inFlight = new Map<string, Promise<boolean>>();

async function probeOnce(origin: string): Promise<boolean> {
  try {
    await fetch(origin, {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe a provider URL to check if it's reachable.
 * Uses a lightweight GET to the base origin (most OpenAI-compat servers
 * return 200 or 404 on root, either confirms reachability). One retry
 * before a negative verdict — a single slow/dropped attempt on a real,
 * working provider shouldn't be enough to gate every LLM call site off it
 * for the next CACHE_TTL_MS.
 */
async function probe(url: string): Promise<boolean> {
  const origin = new URL(url).origin;
  if (await probeOnce(origin)) return true;
  return probeOnce(origin);
}

/**
 * Check if an LLM provider endpoint is available.
 * Returns cached result if fresh (< CACHE_TTL_MS for a reachable provider,
 * the much shorter NEGATIVE_CACHE_TTL_MS for an unreachable one — see this
 * file's own header comment for why a negative verdict shouldn't stick
 * around as long as a positive one).
 * Otherwise probes and caches the result.
 */
export async function isProviderAvailable(apiUrl: string): Promise<boolean> {
  const origin = new URL(apiUrl).origin;
  const cached = cache.get(origin);
  if (cached) {
    const ttl = cached.available ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
    if (Date.now() - cached.checkedAt < ttl) return cached.available;
  }

  // Coalesce concurrent probes to the same origin
  const existing = inFlight.get(origin);
  if (existing) return existing;

  const promise = probe(apiUrl).then(available => {
    cache.set(origin, { available, checkedAt: Date.now() });
    inFlight.delete(origin);
    if (!available) {
      console.warn(`[llm-health] Provider unreachable: ${origin}`);
    }
    return available;
  });
  inFlight.set(origin, promise);
  return promise;
}

/**
 * Get current health status for all probed providers.
 * Used by /api/health to expose LLM status.
 */
export function getLlmHealthStatus(): Record<string, { available: boolean; checkedAt: number }> {
  const status: Record<string, { available: boolean; checkedAt: number }> = {};
  for (const [origin, entry] of cache) {
    status[origin] = { available: entry.available, checkedAt: entry.checkedAt };
  }
  return status;
}

/**
 * Force a re-probe of all cached providers.
 * Called on startup or when a provider comes back online.
 */
export async function reprobeAll(): Promise<void> {
  const origins = [...cache.keys()];
  await Promise.all(origins.map(async (origin) => {
    const available = await probe(origin);
    cache.set(origin, { available, checkedAt: Date.now() });
  }));
}

/**
 * Warm the health cache on startup by probing configured providers.
 * Fire-and-forget — does not block the caller.
 */
export function warmHealthCache(): void {
  const providerUrls: string[] = [];

  const ollamaUrl = typeof process !== 'undefined'
    ? (process.env?.OLLAMA_API_URL || process.env?.LLM_API_URL)
    : undefined;
  if (ollamaUrl) providerUrls.push(ollamaUrl);

  if (typeof process !== 'undefined' && process.env?.GROQ_API_KEY) {
    providerUrls.push('https://api.groq.com/openai/v1/chat/completions');
  }
  if (typeof process !== 'undefined' && process.env?.OPENROUTER_API_KEY) {
    providerUrls.push('https://openrouter.ai/api/v1/chat/completions');
  }

  for (const url of providerUrls) {
    void isProviderAvailable(url);
  }
}
