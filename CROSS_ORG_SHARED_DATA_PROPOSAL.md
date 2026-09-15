# Cross-org shared data layer — PROPOSAL, NOT STARTED

**Status: idea captured 2026-09-14, read-only inventory done, zero code changed.
2026-09-15 (session 2, chat-only — see below): the per-org extension point got
a name + operator sign-off, and the bridge mechanism got a real answer on
Upstash's native capabilities. Still zero repo code changed.**
Not authorized to build yet — this is a plan for a future session to pick up,
not a mandate. Read `PLATFORM_ARCHITECTURE.md`'s Status section first for the
platform's current state (per-org GitHub Environments, per-org Upstash, the
`deploy-org.reusable.yml` secret set) — this proposal builds directly on top
of that, doesn't replace it.

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
3. **Write-path consolidation is the big one.** (**Session 2 addendum above:**
   confirmed Upstash has no native fix for this — it has to be a hand-rolled
   bridge either way — but the *existing* bridge's poll-and-copy mechanism
   likely needs to become push+changelog+backstop, not stay a plain timer,
   once it's not just AIS's 2 keys.) AIS could centralize
   cheaply because it's inherently one persistent WebSocket connection.
   Most of the 166 shareable seeders are simple polling crons running
   inside each org's own `nitric`-deployed stack today
   (`deploy-org.reusable.yml` → `generate-nitric-org-stack.mjs`,
   `PINNED_SERVICES: {}`). Centralizing them means either: (a) one new
   shared deploy (a second `ais-shared`-style GH Environment + Nitric
   stack) that owns fetching for all 166, with each org's
   `sync-*.mjs` mirroring in — the AIS pattern, generalized; or (b) some
   hybrid. This is the architecturally biggest piece — it touches the
   per-org deploy pipeline this session's `GCP_CREDENTIALS` work just
   got working for the first time, so sequence carefully, don't fight it.
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
3. **Design the shared-deploy write path** (new `*-shared` GH Environment +
   Nitric stack, or fold into `ais-shared` if that's cleaner) — a real
   design decision, needs the operator's sign-off before building, same as
   `ais-shared` presumably had one.
4. **Design the local broker's second read-only credential pair** —
   smaller, mechanical once step 3's shape is settled.
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
