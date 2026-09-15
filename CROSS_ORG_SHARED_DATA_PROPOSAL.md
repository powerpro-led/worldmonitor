# Cross-org shared data layer — PROPOSAL, NOT STARTED

**Status: idea captured 2026-09-14, read-only inventory done, zero code changed.
2026-09-15 (session 2, chat-only): the per-org extension point got a name +
operator sign-off, and the bridge mechanism got a real answer on Upstash's
native capabilities. 2026-09-15 (session 3, chat-only — see below): complication
#3 (write-path consolidation) went from "architecturally biggest open piece" to
a concrete design — bridge mechanism, shared-deploy granularity, the migration
flag, and the cutover strategy are all decided (operator sign-off given in
conversation), though still nothing built. Still zero repo code changed except
this doc + `PLATFORM_ARCHITECTURE.md`.**
Not authorized to build yet — this is a plan for a future session to pick up,
not a mandate. Read `PLATFORM_ARCHITECTURE.md`'s Status section first for the
platform's current state (per-org GitHub Environments, per-org Upstash, the
`deploy-org.reusable.yml` secret set) — this proposal builds directly on top
of that, doesn't replace it.

## Session 3 addendum (2026-09-15) — write-path design (complication #3)

Chat-only session (no repo files touched except this doc), picked up directly
from session 2's flagged risk ("the existing bridge's poll-and-copy mechanism
likely needs to become push+changelog+backstop... before it generalizes past
AIS"). Read the actual code this time before proposing anything — `scripts/
sync-ais-results.mjs`, `nitric.ais-shared.yaml` + `deploy/shared/ais-ingest.yml`
+ `.github/workflows/deploy-ais-shared.yml` (the existing AIS-shared deploy),
`server/_shared/sync-notify.ts` + `vscode-extension/sidecar/sync-listener.mjs`
(the push+changelog mechanism already proven one hop downstream), and `gcp/
scheduler/main.ts` + `scripts/railway-services.json` (how per-org seeders are
actually scheduled today). Four decisions, each proposed with reasoning then
confirmed by the operator — all still design-only, nothing built:

1. **Bridge mechanism: changelog + cursor, not blind poll.** `sync-listener.mjs`
   already has a `catchUp()` that does `XRANGE sync:changelog` from a
   persisted cursor and applies only what changed — today it's used only as
   the reconnect-recovery path (the steady-state path is a live SSE
   subscription). The org-side bridge is structurally different: it's an
   ephemeral `--once` cron with no persistent process to hold a subscription
   open between ticks, so it can't have a "steady-state" push path the way
   `sync-listener.mjs` does. The design promotes `catchUp()`'s mechanism from
   "recovery path" to "the only path": each tick does one `XRANGE` against the
   shared store's changelog (cursor persisted as a key in the org's own
   Upstash, not a local file — the bridge is stateless between invocations),
   fetches only the keys that actually changed, writes them into the org's
   own Upstash via the existing `notifyChange()` helper (so the org's own
   downstream `sync-listener.mjs` fan-out picks it up immediately, same as
   today). Cost per tick becomes proportional to what changed, not to the
   number of shareable sources. A low-frequency full-rescan stays as the
   correctness backstop, mirroring `local-sync.mjs`'s relationship to
   `sync-listener.mjs` one hop downstream.
2. **Deployment granularity: one shared stack, not domain-split.** The
   read-only inventory's grouping table (macro/markets/climate/conflict/
   supply-chain/other) could map to 5-6 independent `*-shared` GH
   Environments + Nitric stacks, but the reasoning for splitting (failure
   isolation) is weak here: every migrated seeder already runs as its own
   spawned child process under `gcp/scheduler/main.ts` (see point 3), so one
   script failing doesn't take others down regardless of how many stacks
   they're grouped into. One `data-shared` stack + one shared read-only
   Upstash (literally the `ais-shared` shape, generalized) avoids multiplying
   GH Environments and avoids the local-config broker having to hand out
   5-6 read-only token pairs instead of 1. Split later only if a concrete
   operational reason shows up (e.g. wanting independent on/off toggles or
   wildly different deploy cadences per domain) — not preemptively.
3. **Migration mechanism: reuse `gcp/scheduler/main.ts` unchanged, add a
   `centralized` flag to `scripts/railway-services.json`.** That file already
   drives every org's scheduler (87 entries today, fields: `entry`,
   `deployMode`, `service`, `cronSchedule`, `requiredEnv`, `watchPatterns`,
   `documentedAt`, `startCommand`, `dockerfile` — no centralization concept
   yet). Add `centralized: true` per migrated entry; the same scheduler code
   runs in two contexts — an org's own deploy filters OUT `centralized`
   entries, the `data-shared` deploy filters IN only `centralized` entries —
   so there is exactly one source of truth for "which script runs where,"
   not two registries that can drift apart. No new deploy primitive needed:
   this is the same mechanism `ais-relay.cjs` already uses for the one
   persistent-connection case, applied to ordinary cron entries.
4. **Cutover strategy: hard switch per seeder, operator's explicit call.**
   Considered a parallel-run verification window (shared layer writes first,
   org's own seeder keeps running, flip `centralized` only after confirming
   the bridge mirrors correctly) versus flipping `centralized` and disabling
   the org-side entry in the same deploy. **Operator chose hard cutover** —
   simpler operationally, but the tradeoff is real and stays on record: a
   parallel-run window is what would have caught `sync-ais-results.mjs`'s own
   need to re-apply per-key TTLs by hand (its header comment: "Re-applied
   TTLs on the org side. Match ais-relay.cjs's own writes") *before* it hit
   an org's live data instead of after. With a hard cutover, any such mismatch
   for a newly-migrated seeder surfaces in production, so pre-deploy manual
   testing has to be the thing that catches it — the design does not provide
   a safety net for this itself.

**Net effect on complication #3 below:** it moves from "architecturally
biggest open piece" to "designed, not built" — the two "(a) / (b) hybrid"
options it posed are resolved in favor of (a), generalized, with the specific
mechanism spelled out above.

Still open, not touched this session: complication #5 (ranking seeders by
rate-limit pain to pick a pilot) and complication #4 (the local broker's
second read-only credential pair) — next natural threads, per the "Suggested
next steps" list below.

## Session 2 addendum (2026-09-15) — naming + bridge-mechanism research

Chat-only session (no repo files touched except this doc) spent working
through the shape of the upstream half with the operator. Two real
conclusions, both still proposal-status:

1. **`org_specific_seeders` is the per-org extension point — operator
   confirmed.** The shared half is NOT a subscription list — every org gets
   it automatically, no opt-in/opt-out, the same way every org already gets
   AIS data with no toggle for it (operator's own words: "let world shared be
   for every org without choose need"). The only real per-org choice lives on
   the org-specific side, and it already has a natural home: a new
   `org_specific_seeders` field (name proposed, not yet added) on each org's
   `org-provisioning/orgs/<org>.yml` entry, listing that org's own extra
   scripts (mosiq's `seed-china-stocks.mjs`, biovita's
   `seed-ecommerce-intel.mjs` — both still just named ideas, neither built).
   Mechanically this is identical to how `seed-telegram.mjs` already works
   today — no new abstraction, no shared-layer involvement at all for this
   half.
2. **Upstash has no native cross-database/cross-account replication —
   checked against current docs, not assumed.** `upstash.com/docs/redis/
   features/replication` describes only intra-database multi-region
   replicas (primary + read replicas, same account, same credential) —
   nothing for mirroring one Upstash database into a separate one under
   different credentials. This isn't just a missing feature: native Redis
   replication protocols (Upstash's own, and Redis Enterprise's
   Active-Active/CRDB) assume the replica side trusts the primary enough to
   see its full replication stream, which is exactly the opposite of what
   this platform needs (the shared store's write credential must never
   reach an org's deploy; each org's bridge writes with its *own* credential
   into its *own* store). A hand-rolled bridge cron isn't a workaround for a
   missing Upstash feature — it's the right shape for a requirement native
   replication isn't built to express at all.
3. **But the existing bridge cron's mechanism (not its existence) needs a
   second look before generalizing — extends complication #3 below.**
   `scripts/sync-ais-results.mjs` is a plain `every 2min` poll that does a
   blind `GET` on 2 hardcoded key names and re-`SET`s them — no pub/sub, no
   changelog, no incremental diff. Fine for AIS's 2-key case. Doesn't
   obviously scale to ~166 sources' worth of keys × every org without
   inheriting the same full-rescan cost profile `local-sync.mjs` already
   carries one hop downstream (where it's accepted *because* it's a
   backstop, not the primary path). If this generalizes, the bridge should
   probably adopt the same push+changelog-replay+low-frequency-backstop
   shape `sync-listener.mjs`/`sync-notify.ts`/`sync:changelog` already prove
   out one hop down, rather than reinventing a simpler-but-less-scalable
   poll per domain group. Ties directly into the open "bridge granularity"
   question in complication #3.

Visual reference (external, not in this repo): the "WorldMonitor Sync
Pipeline" artifact was updated this session to diagram the shared-vs-per-org
split end to end, with explicit live/proposed labels per node —
<https://claude.ai/code/artifact/76d476c8-f6b7-44b7-8214-3864212e4e1d>.

---

## Origin

Surfaced while filling `mosiq`'s GitHub Environment secrets (same session —
see `PLATFORM_ARCHITECTURE.md`'s 2026-09-14 entries). Explaining why there
are 3 different `*UPSTASH*` secret names (`UPSTASH_REDIS_REST_URL`,
`WM_UPSTASH_REST_URL`, `AIS_RESULTS_UPSTASH_REST_URL`) led to describing the
existing AIS precedent: AIS ingest used to run once per org, now runs as
**one shared deploy** that every org's `sync-ais-results.mjs` cron mirrors
from (S67, `PLATFORM_ARCHITECTURE.md`). The operator's question: why stop at
AIS? Most of worldmonitor's data is equally public and identical across
tenants — generalize the pattern, and reserve per-org Upstash instances for
data that's *genuinely* org-specific (their two named future examples:
mosiq-specific China stock market data, biovita-specific Amazon
intelligence data — **both unbuilt, "next plan todo," not existing sources**).

## The rule (proposed, not yet stress-tested against every edge case)

A data source is **shareable** (one fetch, mirrored read-only into every
org's Upstash, à la AIS) if its output would be byte-identical regardless of
which org's credential fetched it — i.e. it answers "what is true in the
world," not "what does this org care about."

A data source stays **per-org** if either the org chooses *what* it covers
(which channels, which region, which vertical) or the output is
inherently personalized per user/org (delivery, not data).

## Read-only inventory (this session, `scripts/seed-*.mjs`, 168 files)

**166 of 168 are shareable by the rule above.** Rough grouping (not an
exhaustive per-file audit — see "Next steps" for that):

| Group | Examples | Count (approx) |
|---|---|---|
| Macro/economic | `bis-*`, `imf-*`, `eurostat-*`, `wb-*`, `fx-rates`, `yield-curve-eu`, `national-debt` | 30+ |
| Markets/commodities | `market-quotes`, `crypto-*`, `commodity-quotes`, `gold-*`, `fear-greed`, `etf-flows` | 20+ |
| Climate/energy | `climate-*`, `energy-*`, `jodi-*`, `eia-petroleum`, `gas-storage-*` | 25+ |
| Conflict/security | `ucdp-events`, `conflict-intel`, `military-*`, `cyber-threats`, `unrest-events` | 15+ |
| Supply chain/shipping | `portwatch-*`, `chokepoint-*`, `hormuz`, `corridor-risk`, `shipping-stress` | 15+ |
| Everything else (health, social, prediction markets, sanctions, trade…) | | 60+ |

**2 confirmed exceptions today**, both **already correctly per-org**, no
change needed:
- `seed-telegram.mjs` — the script's own header comment already states why:
  "Telegram creds are not public data and each org polls its own channel
  set with its own MTProto session." Content itself differs per org, not
  just the credential.
- `seed-digest-notifications.mjs` — not a data *source* at all; it reads
  each org's own `alert_rules` and dispatches personalized digests to that
  org's configured channels. Downstream delivery, not upstream fetch.

**2 named future org-specific verticals** (operator's plan, not built):
mosiq's China stock market data, biovita's Amazon intelligence data. These
fit the per-org bucket naturally and need no architecture change to build —
flagging here only so whoever builds them doesn't accidentally route them
through the new shared layer once it exists.

## Real complications to resolve before building anything (not yet designed)

1. **The classification rule needs to survive contact with real edge cases,
   not just the 168 filenames.** A pass that actually opens each seeder
   (or at least each *group*) and checks what it reads/writes is needed —
   this session's inventory was a naming-pattern + spot-check pass, not a
   full audit. Specifically worth checking: anything that reads
   `pipeline_config`-hydrated env for a *choice* (a region, an endpoint,
   a coverage set) rather than just a shared credential — that would make
   the OUTPUT org-specific even though it looks like a generic data source
   from the filename.
2. **Per-org Upstash isolation is a security boundary today, not just a
   freshness boundary** — see `PLATFORM_ARCHITECTURE.md`'s repeated
   emphasis on per-org secrets, no shared write credentials to operators,
   RLS-scoped tables. Introducing a cross-org shared Redis means being
   certain nothing org-specific (PII, user prefs, anything not genuinely
   public) ever lands in it — same trust model AIS already uses
   (`AIS_RESULTS_UPSTASH_READONLY_TOKEN` is read-only precisely for this
   reason), but needs re-confirming per shared data domain, not assumed.
3. **Write-path consolidation was the big one — now DESIGNED, not built,
   see "Session 3 addendum" above.** (Session 2: confirmed Upstash has no
   native fix for this, has to be a hand-rolled bridge either way, existing
   bridge's poll-and-copy mechanism wouldn't scale past AIS's 2 keys.
   Session 3: resolved option (a) — one new shared `data-shared` deploy,
   generalized from `ais-shared` — over a domain-split (b), with the bridge
   itself redesigned around `sync-listener.mjs`'s changelog+cursor mechanism
   instead of blind polling, migration tracked via a `centralized` flag on
   `scripts/railway-services.json` shared by both scheduler contexts, and a
   hard-cutover-per-seeder policy the operator explicitly chose over a
   parallel-run verification window.) Still touches the per-org deploy
   pipeline this session's `GCP_CREDENTIALS` work just got working for the
   first time, so sequence carefully when building, don't fight it.
4. **Local operator installs need a second read-only credential pair**,
   the same way `AIS_RESULTS_UPSTASH_*` sits alongside `WM_UPSTASH_*`
   today — the local-config broker (`supabase/functions/local-config`)
   would hand out both the org's own read-only token AND the new shared
   layer's read-only token. Not a big lift, but is a real change to that
   function + `local-config-broker.mjs`'s cache shape.
5. **Rate-limit-sensitive sources are the highest-value pilot candidates**,
   not a random first pick. Confirmed today: `comtrade-bilateral-hs4` is
   real (per-key quota, ~197-country run took 10+ minutes for ONE org this
   session). Worth a first pass specifically ranking seeders by known
   rate-limit pain before picking a pilot — this session didn't do that
   ranking, only spotted the one already visibly slow. Memory mentions
   ACLED (403s, session 37) and a GDELT-specific distributed rate gate
   (session 35, `acquireGdeltRateSlot`) as other historically rate-limited
   sources, worth re-checking whether they're still live sources post the
   session-40 GDELT-surface removal before assuming they're still relevant.

## Suggested next steps, in order (not a mandate)

1. **Full audit pass, not just filenames** — open every one of the 168
   seeders (or at least sample each group), confirm what each actually
   reads (pure public API + shared key vs org-chosen parameter), producing
   a definitive shareable/per-org list with one-line justification each —
   this session's table above is a starting point, not the final word.
2. **Rank the shareable list by rate-limit/cost pain** — this determines
   pilot order. `comtrade-bilateral-hs4` is a confirmed strong candidate;
   don't assume it's the only one without checking.
3. ~~**Design the shared-deploy write path**~~ — **DONE, session 3 addendum
   above** (one `data-shared` stack, changelog+cursor bridge, `centralized`
   flag on `railway-services.json`, hard-cutover policy). Not built.
4. **Design the local broker's second read-only credential pair** —
   smaller, mechanical, next natural step now that step 3's shape is settled.
5. **Pick ONE pilot source, ship it end-to-end, THEN decide whether to
   generalize** — same incremental discipline the AIS migration itself
   used (S61–S67, extracted 26 loops one at a time, not in one shot).
   Don't attempt all 166 in one PR.

## What NOT to do

- Don't build mosiq's China-stock-data or biovita's Amazon-intel sources
  through this shared layer — they're the textbook per-org case, build them
  the normal way (that org's own Upstash) regardless of whether this
  proposal ever ships.
- Don't touch `deploy-org.reusable.yml`'s per-org secret model to
  "simplify" it in anticipation of this — the per-org secrets (Supabase,
  session secret, GCP creds) stay per-org regardless of whether the *data*
  layer centralizes. This proposal is additive, not a replacement for
  per-org identity/config isolation.
