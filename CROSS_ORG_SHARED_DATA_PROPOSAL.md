# Cross-org shared data layer — PROPOSAL, NOT STARTED

**Status: idea captured 2026-09-14, read-only inventory done, zero code changed.
2026-09-15 (session 2, chat-only): the per-org extension point got a name +
operator sign-off, and the bridge mechanism got a real answer on Upstash's
native capabilities. 2026-09-15 (session 3, chat-only — see below): complication
#3 (write-path consolidation) went from "architecturally biggest open piece" to
a concrete design — bridge mechanism, shared-deploy granularity, the migration
flag, and the cutover strategy are all decided (operator sign-off given in
conversation); complication #4 (local broker credentials) turned out to be a
wrong assumption and is fully resolved, not just designed; complication #5
got a spot-check and a picked, operator-confirmed pilot (`comtrade-bilateral-
hs4`). Still nothing built, still zero repo code changed except this doc +
`PLATFORM_ARCHITECTURE.md`. Only complication #1 (the full per-seeder audit)
remains genuinely undone.**
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

5. **Complication #4 below was wrong, not just unresolved — corrected, not
   just designed.** It assumed local-config would need to hand out a second
   read-only credential pair "the same way `AIS_RESULTS_UPSTASH_*` sits
   alongside `WM_UPSTASH_*` today." Reading `supabase/functions/
   local-config/index.ts` in full shows that assumption doesn't hold: the
   function returns exactly `upstashUrl`/`upstashReadonlyToken` (from
   `WM_UPSTASH_REST_URL`/`WM_UPSTASH_READONLY_TOKEN`) + `appDomain` — no
   `AIS_RESULTS_*` field exists there at all, and it never has. That
   credential pair is injected only into the org's own cloud deploy's `.env`
   (`.github/workflows/deploy-org.reusable.yml` lines 281-282), consumed
   solely by `sync-ais-results.mjs` running server-side inside that deploy.
   The operator's local machine never sees the shared store's credentials —
   it only ever reads the org's own (already-bridged-into) Upstash, same as
   every other seeded key. Generalized, this means the `data-shared`
   equivalent needs a new `DATA_SHARED_UPSTASH_REST_URL`/`_READONLY_TOKEN`
   pair added to each org's GH Environment (alongside `AIS_RESULTS_UPSTASH_*`),
   consumed only by the generalized bridge script — **zero changes needed to
   `local-config/index.ts` or `local-config-broker.mjs`.** Complication #4 is
   resolved, not just scoped down.

6. **Complication #5 spot-checked (not exhaustive) and a pilot picked:
   `comtrade-bilateral-hs4`, operator-confirmed.** Full detail + the other
   candidates considered (SAM.gov, GDELT fallback, ArcGIS/Decodo) are under
   complication #5's own entry below. All five real complications the
   proposal originally listed now have an answer of some kind — #1 (full
   per-seeder audit) is the one still genuinely undone, not spot-checked.

**Nothing left open from the proposal's own "Suggested next steps" list
except item 1 (the full per-seeder audit) and actually shipping the pilot.**

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
4. ~~**Local operator installs need a second read-only credential pair**~~ —
   **RESOLVED, session 3 addendum above: this was a wrong assumption, not
   a real requirement.** `supabase/functions/local-config/index.ts` never
   hands `AIS_RESULTS_UPSTASH_*` to the operator's machine today — that pair
   is a per-org deploy-time secret consumed only by `sync-ais-results.mjs`
   running server-side. Generalized: a new `DATA_SHARED_UPSTASH_*` pair goes
   in each org's GH Environment for the bridge script alone. **Zero changes
   to `local-config/index.ts` or `local-config-broker.mjs`.**
5. ~~**Rate-limit-sensitive sources are the highest-value pilot
   candidates**~~ — **PILOT PICKED, session 3 addendum: `comtrade-bilateral-
   hs4`, operator-confirmed.** Not a full per-seeder ranking (42 files touch
   rate-limit-related keywords; not all read in depth), but enough of a
   spot-check across the ones with genuinely hard-coded quotas — not just
   generic 429-retry handling — to be confident this is the strongest single
   candidate, not just the one that happened to look slow:
   - **`comtrade-bilateral-hs4`** — the real ceiling, read from its own
     header comment: UN Comtrade's free tier is 500 calls/month **per key**;
     one run burns ~394-396 calls; with 2-key rotation that's 2 runs/month,
     hard. A dedicated freshness-gate + seed-meta-TTL formula + lock domain
     exist purely to survive this — the most infrastructure any single
     seeder in the repo carries just to stay inside its quota, which is
     itself the signal this is the highest-value migration, not only the
     slowest-observed one.
   - `seed-global-tenders.mjs` (SAM.gov, 10 req/day/key) — a real historical
     429 lockout (`#5444`) but **already self-mitigated per-org**
     (`SAM_MIN_FETCH_INTERVAL_MS` spreads it to ~9.6/day) — centralizing
     buys "new orgs don't need their own key," not "stops an active fire."
   - `seed-conflict-intel.mjs`'s GDELT fallback — confirmed still live
     (`#5140` brownout incident, real sweep-budget/throttle-streak logic),
     **not** the same thing session 40 removed (that was the `实时情报`
     UI panel + `search-gdelt-documents` RPC, a display-layer removal; this
     is a still-live backend data fetch). Not picked as the pilot because
     it only fires per-org when that org has no ACLED credentials — a
     conditional fallback is exactly the edge case complication #1 (the
     classification rule surviving contact with real cases) warns about,
     not a clean first case to prove the pattern on.
   - `seed-portwatch*` (ArcGIS/Decodo) — rate-limited **per egress IP**, not
     per key — a genuinely different flavor (centralizing changes which IP
     gets throttled, not obviously better or worse without testing) flagged
     for whoever tackles it, not chosen as the pilot.

## Suggested next steps, in order (not a mandate)

1. **Full audit pass, not just filenames** — open every one of the 168
   seeders (or at least sample each group), confirm what each actually
   reads (pure public API + shared key vs org-chosen parameter), producing
   a definitive shareable/per-org list with one-line justification each —
   this session's table above is a starting point, not the final word.
2. ~~**Rank the shareable list by rate-limit/cost pain**~~ — **spot-checked,
   session 3 addendum above, not exhaustive.** Enough of a look at the
   sources with genuinely hard-coded quotas (vs generic 429-retry handling)
   to pick a pilot with confidence; still not the full per-seeder pass item
   1 below calls for.
3. ~~**Design the shared-deploy write path**~~ — **DONE, session 3 addendum
   above** (one `data-shared` stack, changelog+cursor bridge, `centralized`
   flag on `railway-services.json`, hard-cutover policy). Not built.
4. ~~**Design the local broker's second read-only credential pair**~~ —
   **RESOLVED, session 3 addendum above: not needed at all.** `local-config`
   never touches the shared credential; a per-org GH Environment secret for
   the bridge script is enough. `local-config`/`local-config-broker.mjs`
   need no changes.
5. ~~**Pick ONE pilot source**~~ — **PICKED, session 3 addendum above:
   `comtrade-bilateral-hs4`, operator-confirmed.** Still need to ship it
   end-to-end before deciding whether to generalize — same incremental
   discipline the AIS migration itself used (S61–S67, extracted 26 loops
   one at a time, not in one shot).
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
