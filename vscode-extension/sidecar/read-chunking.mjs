/**
 * Byte-aware read planning + cancellable timed requests, shared by both
 * readers of the Upstash mirror: local-sync.mjs's full reconciliation and
 * sync-listener.mjs's changelog catch-up.
 *
 * Why (wmtest field reviews, 2026-09-26/27): Upstash REST doesn't compress,
 * and one key can be over a megabyte (climate:air-quality:v1 ≈ 1.3 MB took
 * 100–112s on a ~12–20 KB/s link). A fixed N-key batch under a fixed
 * timeout can then never succeed and retries the same doomed batch forever.
 * local-sync.mjs got this first (finding D); the listener's catch-up had the
 * same shape — 100 keys per pipeline, no per-request timeout at all, only a
 * 60s stall watchdog — and stalled on a real rig at startup (finding I).
 *
 * This file is in scripts/build-release-bundle.mjs's SIDECAR_FILES — a
 * bundled sidecar file importing an unbundled sibling crashes at startup
 * on every install (guarded by tests/release-bundle-sidecar-imports.test.mjs).
 */

import { Redis } from '@upstash/redis';

/** Max keys per pipeline (Upstash's documented cap is 1000; keep headroom). */
export const PIPELINE_MAX_KEYS = 100;
export const CHUNK_BYTE_BUDGET = 256 * 1024;
export const UNKNOWN_KEY_BYTES = 4 * 1024;
export const BASE_REQUEST_TIMEOUT_MS = 90_000;
export const MIN_THROUGHPUT_BYTES_PER_S = 8 * 1024;

/** Timeout for a request expected to move `bytes`, never below the base. */
export function timeoutForBytes(bytes) {
  return Math.max(BASE_REQUEST_TIMEOUT_MS, Math.ceil((bytes / MIN_THROUGHPUT_BYTES_PER_S) * 1000));
}

/**
 * Packs entries into read chunks of at most PIPELINE_MAX_KEYS keys and
 * (where possible) at most CHUNK_BYTE_BUDGET estimated bytes; a key whose
 * own estimate exceeds the budget is always a chunk of its own.
 * Order-preserving, pure.
 *
 * @template {{key: string}} T
 * @param {T[]} entries
 * @param {(key: string) => number | undefined} sizeOf - known size, or undefined
 * @returns {{entries: T[], bytes: number}[]}
 */
export function planReadChunks(entries, sizeOf) {
  const chunks = [];
  let current = { entries: [], bytes: 0 };
  for (const entry of entries) {
    const bytes = sizeOf(entry.key) ?? UNKNOWN_KEY_BYTES;
    const wouldOverflow = current.entries.length > 0
      && (current.bytes + bytes > CHUNK_BYTE_BUDGET || current.entries.length >= PIPELINE_MAX_KEYS);
    if (wouldOverflow) {
      chunks.push(current);
      current = { entries: [], bytes: 0 };
    }
    current.entries.push(entry);
    current.bytes += bytes;
  }
  if (current.entries.length > 0) chunks.push(current);
  return chunks;
}

/**
 * A read-only client bound to one AbortSignal. `signal` MUST be passed as a
 * FUNCTION: in @upstash/redis's request loop (read in node_modules,
 * 2026-09-26) an aborted function signal rethrows the fetch's real abort
 * error, while a PLAIN AbortSignal makes the SDK fabricate a 200 whose
 * "result" is the abort reason — which would read as data. retry: false —
 * callers own retrying.
 */
export function createAbortableClient(url, token, signal) {
  return new Redis({ url, token, retry: false, signal: () => signal });
}

/**
 * One attempt of `fn(client)` raced against `timeoutMs`. On timeout the
 * attempt's fetch is actually ABORTED (so it stops competing for bandwidth
 * with whatever runs next) and this rejects.
 */
export async function runWithAbortTimeout(url, token, fn, label, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // Reject first so the race settles on the timeout; the aborted
      // fetch's own rejection then lands on an already-settled race.
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      controller.abort(new Error('superseded by timeout'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(createAbortableClient(url, token, controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
