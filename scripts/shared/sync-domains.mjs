/**
 * Canonical "does this key belong in the operator local-mirror" classifier.
 *
 * Single source of truth for TWO independent concerns that must never drift
 * apart:
 *   - the READ side: vscode-extension/sidecar/local-sync.mjs's periodic full
 *     rescan, which SCANs the whole keyspace and keeps every key
 *     classifyKey() does not mark 'deny' (then applies keepKey() for the one
 *     user-scoped prefix — see 'mirror-filtered' below).
 *   - the WRITE side: scripts/_seed-utils.mjs's notifyChange() and
 *     server/_shared/sync-notify.ts's notifyKeyChanged() (the fast-path push
 *     nudge fired after a real write lands), both gated on isMirroredKey() so
 *     a key the rescan would never mirror doesn't get pushed either.
 *
 * server/_shared/sync-notify.ts (the RPC-handler write-side twin, used by
 * setCachedJson/runRedisPipeline) is a Vercel Edge-bundled TypeScript file,
 * but it IMPORTS isMirroredKey() from this module directly (esbuild inlines
 * it at build time — same cross-directory pattern server/_shared/llm.ts and
 * simulation-queue.ts already use). An earlier version hand-duplicated the
 * list on the incorrect claim that no such path existed, and it drifted
 * once; the import removed that risk class (2026-08-23).
 *
 * ---------------------------------------------------------------------------
 * DENYLIST, not allowlist (platform pivot, Workstream 4 / PLATFORM_ARCHITECTURE.md P6).
 *
 * This module used to export a ~55-entry SYNC_PREFIXES allowlist. Every new
 * seeded domain had to be added to it by hand, and the failure mode when
 * someone forgot was silent — a panel with live data in the browser and a
 * permanently empty box in the VS Code mirror (the "theater-posture: was
 * never mirrored" class of bug, hit ~20 times). The model is now inverted:
 * a key is mirrored UNLESS it matches a deny rule below, so a fresh data
 * prefix mirrors with zero code change.
 *
 * THREE states, not two:
 *   'deny'            — never mirrored, never pushed. Credentials, live
 *                       worker queues, infra/bookkeeping, probes.
 *   'mirror'          — mirrored wholesale by the rescan; pushed on the
 *                       fast path. The default for anything not denied.
 *   'mirror-filtered' — mirrored by the rescan but only after keepKey()
 *                       scopes it to THIS operator; NEVER pushed on the fast
 *                       path, because sync:notify is one global channel with
 *                       no per-recipient filtering (the session-39 leak fix).
 *                       Only `brief:` (minus the shared `brief:llm:` subtree)
 *                       is in this state.
 * ---------------------------------------------------------------------------
 */

/**
 * Prefixes denied outright. Split into groups purely for the rationale; the
 * check is a flat startsWith() over all of them.
 *
 * Each entry was classified by READING its keys against the real store, not
 * by its name — the block that used to sit at the foot of SYNC_PREFIXES
 * headed "DELIBERATELY EXCLUDED, verified by reading the keys."
 */
const DENY_PREFIXES = [
  // News-dedup + tracking. `story:` alone is ~69% of all keys in the shared
  // store and carries no article content — the single largest bloat item.
  'story:',

  // Notification / eventing / lock bookkeeping.
  'wm:', // notification dedup, an events queue, locks
  'digest:', // notification accumulator + last-run marker
  'baseline:', // internal statistical accumulator state

  // Upstream-fetch scratch (abuseipdb lookups, cyber first-seen markers, ...).
  'cache:',

  // Sync-job bookkeeping written by the seed pipeline itself.
  'seed-meta:',
  'seed-routes:',
  'seed-activated:',
  'seed-lock:',
  'seed-webcams:', // cameras are being removed entirely (P7) — deny regardless

  // The real-time-sync plumbing itself. `sync:changelog` is a live stream
  // key SCAN returns; `sync:notify` is the pub/sub channel; a cursor may be
  // parked here too. Default-allow would mirror the changelog into every
  // operator's cache — this prefix is the clearest example of why the
  // denylist inversion needs an explicit audit rather than just the P6
  // shape patterns.
  'sync:',

  // Infrastructure, health, probes, rate limiting.
  'health:',
  'rate:', // P6 shape pattern — kept even though the live keys use `rl:`
  'rl:', // the ACTUAL @upstash/ratelimit prefix (rl:, rl:ep, rl:scope, rl:apikey:*)
  'llm:', // LLM spend / daily-usage meters (NOTE: the LLM *output* caches
  //          summary:* and classify:* are NOT here — they are the whole
  //          point of a shared mirror and stay 'mirror')
  'relay:',
  'cf:',
  'shared:',
  'ci-sebuf:',
  'wm-smoke-test:',
  'temporal:',

  // Preview/dev-deploy-prefixed keys. Largely moot now that each org has its
  // own Upstash DB, but harmless to keep and correct if a shared DB is ever
  // used again (redis.ts ~line 475 relies on exactly this rejection).
  'preview:',

  // Credential. Its only key is `acled:oauth:token`, also caught by the
  // `:oauth:` shape rule below — listed explicitly so the intent is legible.
  'acled:',

  // Session-pattern shapes as prefixes (the suffix/substring shapes are
  // handled separately below).
  'session:',
  'idempotency:',
  'ratelimit:',
  'lock:',
];

/**
 * Shape patterns — a key is denied if it ENDS WITH any of these, regardless
 * of domain. Catches credentials and pagination/sync bookkeeping that live
 * under an otherwise-mirrored prefix.
 */
const DENY_SUFFIXES = [':token', ':secret', ':cursor'];

/**
 * Shape patterns — a key is denied if it CONTAINS any of these anywhere.
 * `:oauth:` catches `<provider>:oauth:token` / `:oauth:refresh`; `smoke-test:`
 * catches both `wm-smoke-test:` and `wm:smoke-test:` variants.
 */
const DENY_SUBSTRINGS = [':oauth:', 'smoke-test:'];

/**
 * Narrow exclusions WITHIN an otherwise-mirrored prefix — keys that are
 * internal implementation bookkeeping, not display data, but fall under a
 * broad prefix that is legitimately mirrored for other reasons.
 *
 * `forecast:simulation-task*` (server/_shared/_simulation-queue-constants.mjs
 * / scripts/_simulation-queue-constants.mjs's SIMULATION_TASK_KEY_PREFIX +
 * SIMULATION_TASK_QUEUE_KEY) is a live worker task queue — the ZSET the
 * simulation worker ZRANGEs to discover pending runs — not a result an
 * operator dashboard shows. `forecast:` reads as data, so no shape pattern
 * catches it; it was added here 2026-08-23 after prefix reasoning failed on
 * it once already (tests/simulation-queue-parity.test.mts broke). Carry it
 * across the allowlist→denylist inversion verbatim — the inversion does not
 * change the fact that `forecast:` display data IS wanted and this one
 * sub-family is NOT.
 */
const MIRROR_EXCLUDED_PREFIXES = ['forecast:simulation-task'];

/**
 * `brief:` is the one user-scoped prefix. Its keys come in three shapes and
 * exactly one subtree is shared:
 *   brief:llm:description:<hash>  — shared LLM output, safe for everyone
 *   brief:latest:<userId>         — pointer, user-scoped
 *   brief:<userId>:<slot>         — brief content, user-scoped
 * The shared subtree is 'mirror'; everything else under `brief:` is
 * 'mirror-filtered' — the rescan keeps it but only after local-sync.mjs's
 * keepKey() narrows it to the current operator's own userId, and the
 * fast-path push skips it entirely (sync:notify has no per-recipient
 * filtering — a `brief:<otherUser>:*` row pushed there lands in EVERY
 * operator's mirror, which is the session-39 leak this split prevents).
 */
function isSharedBriefKey(key) {
  return key.startsWith('brief:llm:');
}
function isBriefKey(key) {
  return key.startsWith('brief:');
}

/**
 * @param {unknown} key
 * @returns {'deny' | 'mirror' | 'mirror-filtered'}
 */
export function classifyKey(key) {
  if (typeof key !== 'string' || key.length === 0) return 'deny';

  if (DENY_PREFIXES.some((p) => key.startsWith(p))) return 'deny';
  if (DENY_SUFFIXES.some((s) => key.endsWith(s))) return 'deny';
  if (DENY_SUBSTRINGS.some((s) => key.includes(s))) return 'deny';
  if (MIRROR_EXCLUDED_PREFIXES.some((p) => key.startsWith(p))) return 'deny';

  if (isBriefKey(key)) return isSharedBriefKey(key) ? 'mirror' : 'mirror-filtered';

  return 'mirror';
}

/**
 * True only for keys that are safe to push on the fast path — i.e. exactly
 * the 'mirror' state. 'deny' and 'mirror-filtered' both return false: the
 * former is never mirrored at all, the latter reaches the local mirror only
 * via the rescan + keepKey(), never via the global sync:notify channel.
 *
 * This is the gate every write-side notify and the listener's own
 * defense-in-depth check call. Its contract is unchanged from the
 * allowlist era: `brief:llm:*` pushes, `brief:<uid>:*` does not, credentials
 * and bookkeeping do not.
 */
export function isMirroredKey(key) {
  return classifyKey(key) === 'mirror';
}
