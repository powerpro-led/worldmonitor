/**
 * Canonical "this key belongs to the operator local-mirror" allowlist.
 *
 * Single source of truth for TWO independent concerns that must never drift
 * apart:
 *   - the READ side: vscode-extension/sidecar/local-sync.mjs's periodic full
 *     rescan, which imports SYNC_PREFIXES from here instead of defining its
 *     own copy (moved here 2026-08-23 — this is the exact list, with its
 *     exact original commentary, that used to live inline in that file).
 *   - the WRITE side: scripts/_seed-utils.mjs's notifyChange() (the fast-path
 *     push nudge fired after a real write lands), gated on the same list so
 *     a key the rescan would never mirror doesn't get pushed either.
 *
 * server/_shared/sync-notify.ts (the RPC-handler write-side twin, used by
 * setCachedJson/runRedisPipeline) is a Vercel Edge-bundled TypeScript file,
 * but it IMPORTS isMirroredKey() from this module directly (esbuild inlines
 * it at build time — same cross-directory pattern server/_shared/llm.ts and
 * simulation-queue.ts already use). An earlier version hand-duplicated the
 * list on the incorrect claim that no such path existed, and it drifted
 * once; the import removed that risk class (2026-08-23).
 */

/** Domain scope — see the per-prefix comments below for how this list was chosen. */
export const SYNC_PREFIXES = [
  'resilience:',
  'intelligence:',
  'energy:',
  'supply_chain:',
  'market:',
  'economic:',
  'climate:',
  'portwatch:',
  'risk:',
  'rss:',
  'forecast:',
  // Both spellings needed — get-theater-posture.ts's own live/backup keys
  // use a hyphen ('theater-posture:sebuf:v1'/':backup:v1') but its stale
  // key uses an underscore ('theater_posture:sebuf:stale:v1'). Missing
  // from this list entirely until found live: the Strategic Posture panel
  // read empty theaters forever in the VS Code sidecar, no error, because
  // the key it needs was never mirrored down from Upstash to begin with —
  // not a bug in the panel or the RPC handler, just an absent prefix here.
  'theater-posture:',
  'theater_posture:',
  // LLM OUTPUT — the most expensive rows in the store to regenerate, and the
  // whole point of a shared cache: both are keyed by a CONTENT hash (see
  // src/utils/summary-cache-key.ts, "the canonical cache-key builder shared by
  // both client and server"), so two operators reading the same article derive
  // the same key and ONE model call can serve everyone. Omitted until
  // 2026-08-20, which meant every operator silently re-paid for identical
  // summaries and classifications — same failure mode as the theater-posture:
  // note above, but costing money rather than showing a blank panel.
  'summary:',
  // Was listed as an exclusion above ("ML/log metadata"). That was wrong:
  // classify:sebuf:v6:<hash> holds the cached LLM verdict itself
  // ({level, category, timestamp}, CLASSIFY_CACHE_TTL = 86400), which drives
  // panel alert levels — and /api/intelligence/v1/classify-event is one of the
  // LLM-spend-quota'd paths, so a miss costs a real model call.
  'classify:',

  // ---------------------------------------------------------------------
  // Added 2026-08-21 after auditing EVERY prefix in Redis against every
  // server/worldmonitor/*/v1/*.ts handler, rather than adding prefixes one
  // panel-complaint at a time. 19 domains were reading at least one prefix
  // that was never mirrored, so those panels had data in the browser (live
  // Redis) and nothing in the VS Code sidecar (mirror only) — the same
  // silent failure as the theater-posture: note above, 19 times over.
  //
  // Each prefix below was classified by READING its keys, not by its name.
  // That distinction is load-bearing: `acled:` looks like a data prefix and
  // is deliberately absent, because its only key is `acled:oauth:token` — a
  // credential, which mirroring would copy onto the operator's laptop and
  // defeat the read-only-token rationale in assertEnv(). See the exclusion
  // list at the bottom of this comment block.
  // ---------------------------------------------------------------------

  // Trade + customs. `trade:flows:v1:*` (256) and `trade:tariffs:v1:*` (159)
  // are per-country composed keys; the singular `trade:restrictions:v1`,
  // `trade:barriers:v1` and `trade:customs-revenue:v1` back the tariff and
  // trade-policy panels. `comtrade:` holds bilateral flows and is read by
  // BOTH the trade and supply-chain domains — which is why supply-chain was
  // partially populated rather than blank: its own `supply_chain:` keys were
  // already mirrored, only its comtrade half was missing.
  'trade:',
  'comtrade:',
  // `supply-chain:exposure:{iso2}:{hs2}:v1` (HYPHEN — distinct from the
  // underscored `supply_chain:` prefix above) is the ONE hyphen-spelled
  // supply-chain family that has a scheduled batch seeder
  // (seed-hs2-chokepoint-exposure.mjs) pre-warming ~174×N per-country/HS2
  // rows. Absent here it was mirrored nowhere, so the premium Country
  // Chokepoint Index panel had to recompute every cell from `comtrade:` on
  // first open in the sidecar. The other hyphen `supply-chain:*` families
  // (cost-shock, sector-dep, route-explorer-lane, route-impact) are
  // deliberately NOT included — they are request-varying, auth-gated,
  // per-selection read-through caches with no seeder, same class as the
  // excluded `cache:`/`story:` prefixes below.
  'supply-chain:exposure:',

  // Security / conflict / defence.
  'conflict:',
  'unrest:',
  'displacement:',
  'military:',
  'usni-fleet:',
  'patents:',
  'cyber:',

  // Physical world + hazards.
  'natural:',
  'seismology:',
  'radiation:',
  'thermal:',
  'weather:',
  'aviation:',
  'infra:',

  // Economic / markets not already covered by economic: and market:.
  'bls:',
  'insider:',
  'regulatory:',

  // Analysis, research and editorial output.
  'correlation:',
  'research:',
  'news:',
  'intel:',
  'prediction:',

  // Both spellings exist, exactly like theater-posture:/theater_posture:
  // above. Confirmed live in Redis, one key each — do not "tidy" one away.
  'positive-events:',
  'positive_events:',

  // The ONLY user-scoped prefix here, and therefore the only one that is
  // filtered rather than mirrored wholesale — see local-sync.mjs's keepKey().
  // Blanket `brief:*` would copy every user's brief content onto one laptop,
  // which contradicts the read-only-token rationale in assertEnv().
  'brief:',

  // DELIBERATELY EXCLUDED, verified by reading the keys:
  //   acled:        -> `acled:oauth:token`, a CREDENTIAL.
  //   wm:           -> notification dedup, an events queue and locks.
  //   story:        -> ~18.4k news-dedup tracking keys, no article content.
  //   cache:        -> upstream fetch scratch (abuseipdb, cyber first-seen).
  //   digest:       -> notification accumulator + last-run marker.
  //   baseline:     -> internal statistical accumulator state.
  //   seed-meta:, seed-routes:, seed-activated:  -> sync-job bookkeeping.
  //   health:, rate:, llm:, relay:, cf:, shared:, ci-sebuf:, *smoke-test:
  //                 -> infrastructure and probes.
];

/**
 * Narrow exclusions WITHIN an otherwise-mirrored prefix — for keys that are
 * internal implementation bookkeeping, not display data, but happen to fall
 * under a broad prefix that's legitimately mirrored for other reasons.
 *
 * `forecast:simulation-task*` (server/_shared/_simulation-queue-constants.mjs
 * / scripts/_simulation-queue-constants.mjs's SIMULATION_TASK_KEY_PREFIX +
 * SIMULATION_TASK_QUEUE_KEY) is a live worker task queue — the ZSET the
 * simulation worker ZRANGEs to discover pending runs — not a result an
 * operator dashboard shows. Same class as already-excluded `seed-lock:`.
 * Found 2026-08-23 via tests/simulation-queue-parity.test.mts: the write-side
 * notify hook (this list's WRITE-side consumer) would have fired for these
 * keys because `forecast:` is broad, but only from the TS write path
 * (runRedisPipeline), not the .mjs seeder's raw redisCommand() calls for the
 * exact same key — a real behavioral asymmetry the notify instrumentation
 * surfaced that a plain full-rescan SCAN never would have (it would have
 * silently mirrored live queue state onto every operator's laptop either
 * way, just never asymmetrically).
 */
const MIRROR_EXCLUDED_PREFIXES = ['forecast:simulation-task'];

/**
 * `brief:` is the one user-scoped prefix in SYNC_PREFIXES (see local-sync.mjs's
 * keepKey(), which filters it to the current operator's own userId during the
 * full rescan — the ONLY reason that prefix is safe to mirror at all). The
 * real-time push has no equivalent per-recipient filtering: `sync:notify` is
 * one global Redis Pub/Sub channel every operator's sidecar subscribes to
 * identically, so there is no publish-time way to say "only User A's laptop
 * should get this." A `brief:<userId>:<slot>` key must therefore NEVER be
 * pushed this way — real-time freshness for that one narrow case is
 * sacrificed in favor of correctness, and it falls back to the full rescan
 * (which DOES apply keepKey() correctly) instead. `brief:llm:*` is shared,
 * non-user-scoped LLM output (see shouldEnvelopeKey's own bare/enveloped
 * split in _seed-utils.mjs) and stays safe to push to everyone.
 *
 * Found via a multi-agent code review after the initial implementation —
 * isMirroredKey() previously only checked the broad `brief:` prefix, which
 * is true for every user's key, not just the reader's own. Fixed here
 * rather than in the listener, so both write-side gates (this file's own
 * notifyChange() and server/_shared/sync-notify.ts's notifyKeyChanged())
 * refuse to publish it in the first place — the listener's own isMirroredKey
 * check is real, but only defense in depth, not the primary control.
 */
function isUserScopedBriefKey(key) {
  return key.startsWith('brief:') && !key.startsWith('brief:llm:');
}

/** True if `key` falls under any mirrored prefix — the shared write/read gate. */
export function isMirroredKey(key) {
  if (typeof key !== 'string') return false;
  if (isUserScopedBriefKey(key)) return false;
  if (MIRROR_EXCLUDED_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;
  return SYNC_PREFIXES.some((prefix) => key.startsWith(prefix));
}
