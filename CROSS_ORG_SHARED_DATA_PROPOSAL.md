# Cross-org shared data layer — PILOT REHEARSED LOCALLY, NOT DEPLOYED TO REAL CLOUD

**2026-09-15 (session 5, chat + read-only code audit, no repo behavior
changed except this doc): complication #1 (the full 168-seeder classification
audit) is CLOSED — see the "Full per-seeder classification" section below,
which replaces the old naming-pattern "Read-only inventory" table. Result:
165/168 confirmed shareable (was estimated 166/168), 3/168 confirmed per-org.
One real reclassification found beyond the original 2 known exceptions:
`seed-consumer-prices.mjs` reads a `CONSUMER_PRICES_DEFAULT_MARKET`
choice-env-var against the `consumer-prices-core` microservice — exactly the
shape this audit was checking for — and moves from shareable to per-org.
Nothing else in this doc changes; this was the one item left from the
proposal's original five complications. Next real step (still the
operator's call, not started here): migrate more seeders onto the
`data-shared` pattern the pilot proved, in whatever order/pace the operator
wants.**

**Status: idea captured 2026-09-14, read-only inventory done.
2026-09-15 (session 2, chat-only): the per-org extension point got a name +
operator sign-off, and the bridge mechanism got a real answer on Upstash's
native capabilities. 2026-09-15 (session 3, chat-only): complication
#3 (write-path consolidation) went from "architecturally biggest open piece" to
a concrete design — bridge mechanism, shared-deploy granularity, the migration
flag, and the cutover strategy are all decided (operator sign-off given in
conversation); complication #4 (local broker credentials) turned out to be a
wrong assumption and is fully resolved, not just designed; complication #5
got a spot-check and a picked, operator-confirmed pilot (`comtrade-bilateral-
hs4`). 2026-09-15 (session 4 / PLATFORM_ARCHITECTURE.md Session 72 — real
code, not chat): the picked pilot got BUILT — `scripts/sync-shared-results.mjs`
+ the `data-shared` Nitric/GH Actions triad + the `centralized` flag
mechanism, unit tested and type-checked, but never run against real GCP/
Upstash/Comtrade — same scaffold status `ais-shared` has always carried. See
PLATFORM_ARCHITECTURE.md's Session 72 log for full build detail. **2026-09-15
(Session 73): rehearsed end-to-end against REAL local infrastructure — a
second local Redis pair standing in for `data-shared`, a real Comtrade
public-preview fetch (96/197 countries, no paid quota touched), a real
bridge run verified via full key-scan diff into a real org Redis. Found (via
one wrong diagnosis, corrected in the same session) a real, permanent
design property: a `SHARED_DATA_KEY_PREFIXES` entry that also matches a
`classifyKey()` deny rule (comtrade's own `seed-meta:*` key) can never reach
the bridge's fast path, only its 6h backstop — documented at that constant's
own definition, not a bug to fix. The pilot's actual display data is
unaffected and confirmed working. See PLATFORM_ARCHITECTURE.md's Session 73
log for full detail, including an unrelated safety fix found along the way
(local Supabase CLI was linked to the real `mosiq` project — `unlink`ed).**
Only complication #1 (the full per-seeder audit) remained genuinely undone
from the proposal's original five at the time this paragraph was written —
**now CLOSED, see this doc's very top and the "Full per-seeder
classification" section below.** A real cloud deploy rehearsal (not just local infrastructure)
and PLATFORM_ARCHITECTURE.md's actual release-readiness gap (a real
`provision-org.yml` run against a real org, unrelated to this proposal) are
both still open but were NOT what got handed off — don't start those
unprompted.**
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

## Full per-seeder classification (session 5, 2026-09-15) — complication #1 CLOSED

**Methodology** (per the "Suggested next steps" item 1 plan below, followed
as written): extracted every `process.env.*` read from all 168
`scripts/seed-*.mjs` files (168/168 via grep, not sampled) — 56 files read at
least one env var, 112 read none. Classified all 112 distinct var names by
shape; the ~15 that looked "choice-shaped" (could plausibly encode a region,
market, coverage set, or endpoint rather than a bare credential/infra value)
were traced to their exact read site and read in full surrounding context,
not judged by name alone. The 112 zero-env-var files were also spot-checked
for a country/market baked in as a hardcoded constant instead of an env var
(`seed-bundle-regional.mjs`, `seed-china-macro.mjs`, `seed-gulf-quotes.mjs`,
`seed-grocery-basket.mjs`) — all confirmed genuinely global/multi-country
coverage, nothing org-narrowed. Note: `pipeline_config`/the config-broker
machinery itself has zero direct `seed-*.mjs` callers today (grep-confirmed)
— the risk this audit checked for is *any* env-var-driven content selection,
not literally a `pipeline_config` read.

**Result: 165/168 shareable, 3/168 per-org** (previous estimate was 166/168 —
one reclassification, below).

### The 3 per-org seeders

| Seeder | Why per-org |
|---|---|
| `seed-telegram.mjs` | Own header comment states it: each org polls its own Telegram channel set with its own MTProto session — the credential *and* the content differ per org. (Known since session 1.) |
| `seed-digest-notifications.mjs` | Not a data source — reads each org's own `alert_rules`/`notification_channels` and dispatches personalized digests. Downstream delivery, not upstream fetch. (Known since session 1.) |
| `seed-consumer-prices.mjs` | **New this session.** Reads `CONSUMER_PRICES_DEFAULT_MARKET` (defaults to `'ae'`) and a hardcoded `BASKET = 'essentials-ae'` against the separate `consumer-prices-core` microservice — an env var picking *which market's* basket gets fetched, the exact "choice, not just a credential" shape complication #1 warned about. An org wanting Saudi or Egyptian prices instead overrides the var and gets genuinely different output; centralizing as-is would silently pin every org to UAE data. Consistent with `consumer-prices-core` already being flagged separately (`org-provisioning`'s 2026-09-14 handoff) as a standalone microservice never wired into any shared/cloud fan-out — this audit independently arrives at the same "leave it per-org" conclusion from the data-sharing side. |

**14 other "choice-shaped" var hits, checked and confirmed NOT org-choice** —
global feature flags, staged-rollout gates, and LLM-model/provider knobs.
Same value would behave identically whether set on a shared deploy or on any
single org's own deploy today; none of them change *what content* comes
back, only how/whether it's processed:
`IRAN_EVENTS_ENABLED` (domain-sunset kill switch, `seed-iran-events.mjs`),
`CHAIN_FORECAST_SEED_ON_MILITARY` (internal orchestration trigger,
`seed-military-flights.mjs`), `RESILIENCE_WHO_MEASLES_INDICATOR` (WHO
indicator-code override for API churn, `seed-resilience-static.mjs`),
`NEWS_DIGEST_SEED_VARIANTS`/`_LANGS` (which variant×lang pairs to eagerly
cache-warm — same underlying public digest content either way,
`seed-news-digest.mjs`), `BRIEF_VALIDATOR_MODE` (hallucination-guard
incident-revert switch, `seed-insights.mjs`), `FORECAST_PROMOTE_BET_ENGINE` /
`FORECAST_BETS_ENSEMBLE` (staged feature-gate promotions, one-way rollout
switches, `seed-forecast-resolutions.mjs` / `seed-forecast-bets.mjs`), and
the family of `FORECAST_LLM_*_PROVIDER_ORDER` / `_MODEL_OPENROUTER` /
`_MODEL_GROQ` / `GROQ_MODEL` / `OPENROUTER_MODEL` / `OLLAMA_MODEL` overrides
(`seed-forecasts.mjs`, `seed-forecast-resolutions.mjs`, `seed-classify.mjs`,
`seed-insights.mjs`) — these pick which LLM processes the same public source
data, a deploy-wide ops/cost knob, not a content-scope choice.

### The 165 shareable seeders, by category (real file list, not examples)

Every file below was covered by the audit above — either it had zero
env-var reads (confirmed nothing to differ per org), or its env vars were
all credentials/infra/feature-flags (checked individually above), or it was
one of the 4 hardcoded-constant spot-checks. One shared one-line reason per
category; no individual file needed a different reason since none read an
org-narrowing choice.

**Macro/economic (43)** — public statistical-agency APIs (BIS, IMF, Eurostat,
World Bank, ECB, FATF, national statistics offices), same output for any
caller: `aaii-sentiment`, `bigmac`, `bis-data`, `bis-extended`, `bis-lbs`,
`bls-series`, `bundle-ecb-eu`, `bundle-imf-extended`, `bundle-macro`,
`china-coverage-health`, `china-macro`, `china-release-calendar`,
`correlation`, `cross-source-signals`, `ecb-fx-rates`, `ecb-short-rates`,
`economic-calendar`, `economy`, `eurostat-country-data`,
`eurostat-gov-debt-q`, `eurostat-house-prices`,
`eurostat-industrial-production`, `fatf-listing`, `fsi-eu`, `fx-rates`,
`fx-yoy`, `gscpi`, `imf-external`, `imf-growth`, `imf-labor`, `imf-macro`,
`national-debt`, `recovery-external-debt`, `recovery-fiscal-space`,
`recovery-fuel-stocks`, `recovery-import-hhi`, `recovery-reexport-share`,
`recovery-reserve-adequacy`, `sovereign-wealth`, `usa-spending`,
`wb-external-debt`, `wb-indicators`, `yield-curve-eu`.

**Markets/commodities (19)** — public market-data feeds (quotes, ETF flows,
sentiment indices), identical for every caller regardless of org:
`bundle-market-backup`, `bundle-relay-backup`, `commodity-quotes`, `cot`,
`crypto-quotes`, `crypto-sectors`, `earnings-calendar`, `etf-flows`,
`fear-greed`, `gold-cb-reserves`, `gold-etf-flows`, `gulf-quotes`,
`hyperliquid-flow`, `market-breadth`, `market-quotes`, `prediction-markets`,
`stablecoin-markets`, `token-panels`, `wsb-tickers`.

**Climate/energy (32)** — public climate/energy datasets (satellite, EIA,
JODI, IEA, government energy agencies), no per-org parameter:
`bundle-climate`, `bundle-energy-sources`, `bundle-resilience-energy-v2`,
`climate-anomalies`, `climate-disasters`, `climate-news`,
`climate-ocean-ice`, `climate-zone-normals`, `co2-monitoring`,
`eia-petroleum`, `electricity-prices`, `ember-electricity`,
`energy-crisis-policies`, `energy-disruptions`, `energy-intelligence`,
`energy-spine`, `fossil-electricity-share`, `fuel-prices`, `fuel-shortages`,
`gas-storage-countries`, `gie-gas-storage`, `iea-oil-stocks`, `jodi-gas`,
`jodi-oil`, `low-carbon-generation`, `owid-energy-mix`, `pipelines-gas`,
`pipelines-oil`, `spr-policies`, `storage-facilities`, `vpd-tracker`,
`weather-alerts`.

**Conflict/security (19)** — public conflict/security trackers (UCDP,
sanctions lists, satellite/ADS-B feeds), global coverage by design:
`conflict-intel`, `cyber-threats`, `defense-patents`, `internet-outages`,
`iran-events`, `military-bases`, `military-cii`, `military-flights`,
`military-maritime-news`, `pizzint`, `radiation-watch`, `regulatory-actions`,
`sanctions-pressure`, `satellites`, `security-advisories`,
`thermal-escalation`, `ucdp-events`, `unrest-events`, `usni-fleet`.

**Supply chain/shipping (17)** — public shipping/trade trackers (IMF
PortWatch, chokepoint AIS baselines, UN Comtrade), same for every caller:
`bundle-portwatch-port-activity`, `bundle-portwatch`, `chokepoint-baselines`,
`chokepoint-flows`, `comtrade-bilateral-hs4` (the pilot, already migrating),
`corridor-risk`, `global-tenders`, `hormuz`, `hs2-chokepoint-exposure`,
`portwatch-chokepoints-ref`, `portwatch-disruptions`, `portwatch-port-activity`,
`portwatch`, `shipping-stress`, `submarine-cables`, `supply-chain-trade`,
`transit-summaries`.

**Resilience/health/derived/other (35)** — public health/disaster data (WHO,
USGS, NASA FIRMS) plus in-repo derived/synthesis layers (forecasts, briefs,
classification) that process shared public inputs, no org-specific input of
their own: `aviation`, `bundle-derived-signals`, `bundle-health`,
`bundle-regional`, `bundle-resilience-recovery`,
`bundle-resilience-validation`, `bundle-resilience`, `bundle-static-ref`,
`classify`, `disease-outbreaks`, `displacement-summary`, `earthquakes`,
`fao-food-price-index`, `fire-detections`, `forecast-bets`,
`forecast-resolutions`, `forecasts`, `grocery-basket`, `health-air-quality`,
`insights`, `natural-events`, `news-digest`, `positive-events`,
`power-reliability`, `recall-benchmark`, `regional-briefs`,
`regional-snapshots`, `research`, `resilience-scores`, `resilience-static`,
`rpc-warmpings`, `sector-summary`, `service-statuses`, `social-velocity`,
`trade-flows`.

**2 named future org-specific verticals** (operator's plan, not built):
mosiq's China stock market data, biovita's Amazon intelligence data. These
fit the per-org bucket naturally and need no architecture change to build —
flagging here only so whoever builds them doesn't accidentally route them
through the new shared layer once it exists. (`seed-consumer-prices.mjs`,
above, is a third, already-built example of the same shape — worth keeping
in mind as the pattern to recognize, not a coincidence.)

## Real complications to resolve before building anything (not yet designed)

1. ~~**The classification rule needs to survive contact with real edge
   cases, not just the 168 filenames.**~~ — **CLOSED, session 5: see "Full
   per-seeder classification" above.** All 168 files' env-var reads checked
   individually, not sampled; found exactly one case of the warned-about
   shape (`seed-consumer-prices.mjs` reading a market-choice env var), the
   other 14 "choice-shaped" hits were confirmed global flags/knobs, not
   content selection.
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

1. ~~**HANDED OFF 2026-09-15 (session 73 → next session), operator's
   explicit direction: "continue for the rest of the seeders."**~~ —
   **DONE, session 5 (2026-09-15): see "Full per-seeder classification"
   above.** Every one of the 168 files' env-var reads checked (not sampled),
   producing a real shareable/per-org list with justification — 165
   shareable, 3 per-org (the 2 known exceptions + `seed-consumer-prices.mjs`,
   newly reclassified). This was the ONE complication out of the proposal's
   original five that was still undone; nothing is now.

   **What's already settled — do NOT re-litigate:** the write-path design
   (session 3: changelog+cursor bridge, one `data-shared` stack, the
   `centralized` flag mechanism), the pilot pick (`comtrade-bilateral-hs4`),
   and the pilot's real-infrastructure rehearsal (session 73: `scripts/
   sync-shared-results.mjs` + the `data-shared` deploy triad all verified
   against real local Redis, see `PLATFORM_ARCHITECTURE.md`'s Session 72/73
   logs). The audit's job is picking the NEXT seeders to migrate with the
   same discipline the pilot used, not redesigning the mechanism.

   **What this audit does NOT require:** no real cloud deploy, no GCP
   credentials, no new infrastructure — it's a read-only code-classification
   pass, same as session 1's original inventory, just exhaustive instead of
   sampled. The real-cloud-deploy rehearsal and the separate, higher-priority
   `provision-org.yml`-against-a-real-org gap (release readiness,
   `PLATFORM_ARCHITECTURE.md`'s own top Status entry) are both still open
   but are NOT what the operator asked to hand off here — don't start those
   unprompted.
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
5. ~~**Pick ONE pilot source, ship it end-to-end**~~ — **BUILT, not deployed
   (session 4 / PLATFORM_ARCHITECTURE.md Session 72): `comtrade-bilateral-
   hs4`.** `scripts/sync-shared-results.mjs` + the `data-shared` Nitric/GH
   Actions triad + the `centralized` flag mechanism are real code, unit
   tested, type-checked — but never run against real GCP/Upstash/Comtrade,
   same scaffold status `ais-shared` has always carried. A real deploy
   rehearsal is the next gate before generalizing past this one source — see
   PLATFORM_ARCHITECTURE.md's Session 72 log for the full build detail
   including one real bug (non-string type flattening) caught and fixed
   mid-build. Same incremental discipline the AIS migration itself used
   (S61–S67, extracted 26 loops one at a time, not in one shot) — don't
   attempt all 166 in one PR regardless of how this one pilot's rehearsal
   goes.

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
