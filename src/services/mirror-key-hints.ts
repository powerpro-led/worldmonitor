/**
 * Client half of the per-panel "not synced yet → Refresh from cloud" affordance.
 *
 * The sidecar stamps every RPC response with `X-WM-Mirror-Keys` — the
 * mirror-backed cache key(s) the handler actually read (see
 * server/_shared/redis.ts `recordMirrorKeyRead` + the sidecar's response
 * header stamp). The generated RPC clients throw the `Response` away and hand
 * callers a parsed body, so we skim the header off at the shared fetch layer
 * (`premiumFetch`) into a small per-path map. A panel that renders an empty /
 * "unavailable" state then looks up the key(s) its RPC last touched and offers
 * a button that calls `POST /api/local-sync-refresh` to pull just those keys
 * from Upstash into the local SQLite mirror — not a full reconciliation.
 *
 * Everything here is a no-op outside a sidecar-backed runtime (the header is
 * never present there, and there is no local endpoint to call).
 */

import { isSidecarBackedRuntime } from '@/utils/circuit-breaker';
import { toApiUrl } from '@/services/runtime';

const HEADER = 'x-wm-mirror-keys';
/** Drop hints older than this — a stale key set is worse than none. */
const HINT_TTL_MS = 10 * 60_000;
/** Bound the map so a long session can't accumulate every path ever hit. */
const MAX_HINTS = 200;

interface Hint {
  keys: string[];
  ts: number;
}

const hints = new Map<string, Hint>();

function pathnameOf(input: RequestInfo | URL): string | null {
  try {
    const raw = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    // Relative ("/api/...") or absolute — resolve against a dummy base so both parse.
    return new URL(raw, 'http://x').pathname;
  } catch {
    return null;
  }
}

function evictIfNeeded(): void {
  if (hints.size <= MAX_HINTS) return;
  // Oldest-first: Map preserves insertion order and we re-set on every hit,
  // so the first key is the least recently recorded.
  const oldest = hints.keys().next().value;
  if (oldest !== undefined) hints.delete(oldest);
}

/**
 * Skim `X-WM-Mirror-Keys` off an RPC response. Safe to call on every fetch —
 * cheap, guarded, never throws. `res` may be any `Response`; a missing header
 * or non-sidecar runtime simply records nothing.
 */
export function recordMirrorKeyHint(input: RequestInfo | URL, res: Response): void {
  if (!isSidecarBackedRuntime()) return;
  let header: string | null = null;
  try {
    header = res.headers.get(HEADER);
  } catch {
    return;
  }
  if (!header) return;
  const pathname = pathnameOf(input);
  if (!pathname) return;
  const keys = header.split(',').map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) return;
  hints.delete(pathname); // re-insert at the end for LRU-ish eviction order
  hints.set(pathname, { keys, ts: Date.now() });
  evictIfNeeded();
}

/**
 * The mirror key(s) the RPC at `pathname` (e.g. `/api/economic/v1/get-macro-signals`)
 * last read, or `null` if none was seen recently. A panel passes the same path
 * its RPC client hits.
 */
export function getMirrorKeyHint(pathname: string): string[] | null {
  const hit = hints.get(pathname);
  if (!hit) return null;
  if (Date.now() - hit.ts > HINT_TTL_MS) {
    hints.delete(pathname);
    return null;
  }
  return hit.keys.slice();
}

export interface MirrorRefreshResult {
  refreshed: string[];
  skipped: Array<{ key: string; reason: string }>;
}

/**
 * Ask the sidecar to pull `keys` from Upstash into the local mirror now.
 * Resolves with the server's per-key outcome, or `null` if the runtime has no
 * sidecar / the call failed. Never throws.
 */
export async function refreshMirrorKeys(keys: string[]): Promise<MirrorRefreshResult | null> {
  if (!isSidecarBackedRuntime()) return null;
  const unique = [...new Set(keys.filter((k) => typeof k === 'string' && k.length > 0))].slice(0, 16);
  if (unique.length === 0) return null;
  try {
    const res = await fetch(toApiUrl('/api/local-sync-refresh'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys: unique }),
    });
    if (!res.ok) return null;
    const body = await res.json() as Partial<MirrorRefreshResult>;
    return {
      refreshed: Array.isArray(body.refreshed) ? body.refreshed : [],
      skipped: Array.isArray(body.skipped) ? body.skipped : [],
    };
  } catch {
    return null;
  }
}

/** Test seam. */
export function __clearMirrorKeyHintsForTests(): void {
  hints.clear();
}
