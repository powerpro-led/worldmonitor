# Operator-space: worldmonitor's half

Continuity doc for the `operator-space` concept, written from `worldmonitor` after the
concept moved out of any single repo. Companion docs live in the sibling `platform` repo
(paths below are relative to the shared parent directory the three repos live under, e.g.
`~/Documents/CODE/`):

- `platform/docs/plans/2026-07-30-workos-mcp.md` — platform's agent-facing MCP server (`workos_query`, shipped).
- `platform/docs/plans/2026-08-03-workos-vscode-local-data-layer.md` — platform's local-first VS Code data layer for `workos-vscode`.

## What changed

`operator-space` was a repo that tried to be one unifying VS Code extension + hub in front
of three sibling backends (`worldmonitor`, `platform`/WorkOS, Dagu). It was retired
2026-08-01: no single hub repo anymore. Instead, each sibling owns its own agent-facing
surface and its own standalone VS Code extension:

| Sibling | MCP server | VS Code package | Skills |
|---|---|---|---|
| Dagu | built-in, `http://localhost:8080/mcp` (`dagu_read`/`dagu_change`/`dagu_execute`) | `dagu-vscode` (standalone repo) | — |
| `platform` (WorkOS) | `workos-mcp` at `backend/data` → `/mcp` (`workos_query` shipped; `workos_mutate`/`workos_schema` deferred) | `apps/workos-vscode-web` + `apps/workos-vscode-server` (scaffolded, unwired — see local-data-layer doc) | via `db-designer`/skill materialized into `~/.claude/skills/` |
| **worldmonitor** (this repo) | **already shipped** — `https://worldmonitor.app/mcp`, hand-rolled protocol impl at [api/mcp.ts](../../api/mcp.ts), public `tools/list`, authenticated `tools/call`, OAuth + `wm_…` key auth | **not started** | **already shipped** — 25-skill public catalog at `/.well-known/agent-skills/index.json`, served via [api/skills/fetch-agentskills.ts](../../api/skills/fetch-agentskills.ts), cataloged in [docs/agent-skills.mdx](../agent-skills.mdx) |

worldmonitor is the most-finished sibling on the "agent can act on me" side (see
[docs/mcp-overview.mdx](../mcp-overview.mdx) for the full 41-tool surface, OAuth flow, and
protocol negotiation) precisely because it's a public multi-tenant SaaS API — the
hand-rolled protocol implementation, quota/rate-limiting, and telemetry that `workos-mcp`
explicitly chose *not* to replicate (per its doc, §"How") only exist here because this repo
needed them anyway for the product itself, not because of the operator-space concept.

## 2026-08-04: this fork is not `worldmonitor.app` — full self-host redesign

**Decided direction.** This fork does not run against `worldmonitor.app` and doesn't need
its SaaS concerns (billing tiers, Pro entitlements). The target persona is a sole operator
(market researcher, Amazon seller — same persona `workos-vscode`'s local-data-layer doc was
written for) who installs a **VS Code extension** as the frontend and talks to **one
managed backend you run on GCP**, chosen over Vercel/Railway because most data vendors
(FRED, EIA, NASA FIRMS, ACLED, Finnhub, INFOWAY) are US-based — same `us-central1` region
`platform` already deploys to, for the same reason.

### Full picture

**2026-08-06 update:** the KV row below was re-checked against Nitric's actual `kv()`
API (Context7 docs, not assumption) during the redis.ts port stage. It's a plain
get/set/delete/keys(prefix) document store — no TTL, no atomic increment, no sorted
sets, no geo queries, no scripting. `server/_shared/redis.ts`'s ~101 call sites use a
full Redis command surface (sorted sets, lists, sets, hashes, `GEOSEARCH`, a Lua `EVAL`
compare-and-delete, `SET NX EX` distributed locks) that a plain KV store can't support
without reimplementing large parts of Redis by hand — a correctness risk on the
distributed-lock and ranking code paths, not attempted. **Decided: Upstash stays** as
the shared store, unchanged, called the same way (REST API) from GCP Cloud Run as it is
from Vercel Edge today. "Replaces Upstash" is dropped as a goal. Real Memorystore for
Redis (true wire-compatible Redis, reachable via VPC connector) remains a future option
if Upstash ever becomes the actual bottleneck, but requires a custom Nitric Pulumi
provider (Go) since Memorystore isn't a stock `nitric.yaml` resource — not undertaken
without a concrete reason. See
[nitric-gcp-scaffold.md](nitric-gcp-scaffold.md#whats-explicitly-stubbed--deferred)
for the scaffold-side record of this decision.

```
seed scripts (Cloud Scheduler, GCP us-central1)
        │  ~156 scripts/seed-*.mjs pulling FRED/EIA/NASA FIRMS/ACLED/Finnhub/INFOWAY/AISSTREAM/…
        ▼
shared Upstash Redis (unchanged) — same instance, same REST API, called from GCP Cloud Run
instead of Vercel Edge; still the single source of truth
        │
        ▼
Nitric API + MCP server (Cloud Run, GCP us-central1)
        │  wraps KV reads into REST + the existing /mcp tool surface (ports api/*.ts + api/mcp.ts
        │  off Vercel Edge, same lift platform/backend/data already did — see its
        │  docs/architecture/cicd-deployment-handover.md for the Prisma/tsx/ESM lessons learned)
        │
        │  one-way, periodic pull — NOT a live stream (see "Sync, not replication" below)
        ▼
local SQLite cache (each operator's machine)
        │  served locally by src-tauri/sidecar/local-api-server.mjs, repointed at the local
        │  SQLite cache instead of proxying to remote Redis/Upstash
        ├──────────────► VS Code extension (webview, thin client — new, not started)
        └──────────────► local Agent (MCP over localhost)
```

### Component mapping — what moves, what's reused as-is

| Today | Runs on | Becomes |
|---|---|---|
| `api/*.ts` (Vercel Edge handlers) + [api/mcp.ts](../../api/mcp.ts) | Vercel | Nitric API service on Cloud Run |
| AIS relay, digest-notifications, seed crons (91 of 156 seed scripts) | Railway (`scripts/railway-services.json`) | Nitric services / GCP Cloud Scheduler jobs |
| Redis (Upstash) | Upstash cloud | **Unchanged** — GCP Cloud Run calls the same Upstash REST API; `redis.ts` needs zero code change (2026-08-06 decision, see "Full picture" note above) |
| Frontend SPA (`src/`, Vite/React) | Vercel static + Tauri desktop | VS Code webview extension (new — mirrors `apps/workos-vscode-web`) |
| Tauri sidecar ([src-tauri/sidecar/local-api-server.mjs](../../src-tauri/sidecar/local-api-server.mjs)) | operator's machine, proxies to live Redis | Repointed at the local SQLite sync cache — becomes the local read API for both the VS Code extension and the local Agent |
| Convex (`apiKeys`, `entitlements`, `mcpProTokens`, Clerk auth, Pro-tier billing) | Convex/Clerk | Likely cut entirely — this is SaaS billing/entitlement machinery for a public product this fork doesn't run. Confirm before deleting, don't port by default. |

### Sync, not replication

Considered "shared KV → operator's local Nitric KV, kept in sync" and rejected the
literal reading of that: even setting aside the 2026-08-06 decision to keep Upstash
rather than move to Nitric's `kv()`, that resource **wouldn't have provided
cross-environment sync anyway** — it's a get/set/delete/scan abstraction over one
provider's store per deployment, and running Nitric locally is a dev-time emulator, not
a production replication target. Two separate `kv()` declarations (GCP + local) would
have been two unrelated stores with nothing to keep them consistent.

What's actually needed, and simpler than real replication: a **one-way, periodic pull**
from the shared store (Upstash) into a local SQLite file — shaped exactly like the seed scripts
themselves (pull from a source, write to a local store), just one hop further downstream.
This works because the data is:

- **Read-only from the operator's side** — no writes flow back, so there's no conflict
  resolution to design, which is the genuinely hard part of real replication.
- **Tolerant of minutes-to-hours staleness** — country briefs, resilience scores, and
  market quotes update on that cadence server-side already; "synced 5 minutes ago" is a
  fine answer for a dashboard or an agent tool call.

**No live pass-through path is needed**, checked against the actual persona
(stock/market researcher). Everything in [scripts/ais-relay.cjs](../../scripts/ais-relay.cjs) that
matters to that persona is already interval/poll-based server-side, not a true push
stream — the market-data loop (Finnhub/Yahoo) runs on `MARKET_SEED_INTERVAL_MS`, same as
UCDP conflict events, cyber threats, satellite TLEs, and Telegram polling. AIS ship
tracking matters to this persona only as an **aggregate signal** (chokepoint congestion,
shipping volume trend — a supply-chain/commodity leading indicator), which the shared
backend already computes periodically; raw individual ship positions don't need to reach
the local Agent. The one truly real-time feed in that relay — OREF/Tzeva Adom missile-siren
alerts — is a personal-safety feature unrelated to stock research, and is the clearest
candidate to simply exclude from the local sync scope rather than build a live path for.

## Performance & cost

Checked against the actual codebase rather than assumed — two questions matter here:
does the data grow unbounded, and where does the money actually go.

### Data growth: bounded, not runaway

worldmonitor already enforces a cap/rolling-window discipline on every collection-shaped
Redis key — **10 explicit `MAX_*` constants** found across the seed scripts
(`UCDP_MAX_EVENTS = 2000`, `OREF_PERSIST_MAX_WAVES = 200`,
`GDELT_ROLLING_WINDOW_MAX_EVENTS = 5_000`, `RSS_CACHE_MAX_ENTRIES = 200`, etc. — see
[scripts/ais-relay.cjs](../../scripts/ais-relay.cjs)). Most keys are **snapshot-replace**,
not append-forever: a seed run overwrites the key with the current window. Even the one
constant that looks alarming, `COMTRADE_MAX_RECORDS = 250_000`
([scripts/seed-recovery-import-hhi.mjs](../../scripts/seed-recovery-import-hhi.mjs)), is
just an upstream API page-size guard — the aggregated data that actually lands in Redis is
~800 rows per reporter. The only thing that grows is the **number of distinct keys** as
feature coverage expands (new countries, new panel types) — slow, roughly linear with
product growth, not a runaway-data problem.

**Implication:** this discipline has to be carried into the Nitric KV port deliberately —
it's convention, not automatic. Worth a review checklist item when porting each seed
script: every new collection key needs an explicit cap.

### The one genuinely large dataset — already solved, keep it separate

Per [docs/maps-and-geocoding.mdx](../maps-and-geocoding.mdx): **~80 GB of PMTiles** (vector
map tiles) live on **Cloudflare R2** (`maps.worldmonitor.app`), not Redis, not Vercel —
specifically because Cloudflare bandwidth is free while Vercel charges per GB at scale.
This is already outside the seed → KV → sync pipeline.

**Implication:** keep it that way. The VS Code extension fetches map tiles directly from
the R2 CDN URL, same as the web app does today — **never** route them through the shared
KV or the local-sync pipeline. Offline map tiles (if ever needed) are a separate, explicit
decision (e.g. a bounded region subset), not something the sync design should absorb by
default.

### Cost and performance, by layer

**Shared GCP backend:**

- **Cloud Run** — scale-to-zero (`min-instances: 0`, matching `platform`'s own
  `nitric.gcp.yaml`), pay only for actual request time. For a small self-hosted fleet (not
  public-SaaS traffic) this stays cheap; cold start after idle is the only real latency
  cost, and it's tolerable for a periodic-sync workload rather than interactive
  request/response.
- **Cloud Scheduler + seed jobs** — the real cost lever is job *count*, not data volume.
  `platform` hit this exact problem on Railway and solved it by bundling ~30
  individually-scheduled scripts into ~10 combined services
  ([docs/railway-seed-consolidation-runbook.md](../railway-seed-consolidation-runbook.md)).
  Do the same on GCP from day one — bundle seed scripts by cadence into a handful of
  Cloud Scheduler → Cloud Run jobs, not 156 separate triggers.
- **Upstash Redis** — unchanged from today (2026-08-06 decision: kept, not replaced by
  Nitric `kv()`). Priced per read/write op + storage, not flat. Since writes overwrite
  capped keys rather than accumulate, storage stays roughly flat; write *frequency* (156
  scripts × their intervals) is the actual cost driver — same shape as today, no change
  from moving compute to GCP.
- **Egress for sync pulls** — the one cost dimension that scales with adoption:
  `operator count × sync frequency × snapshot size`. Worth watching as a real metric once
  there's more than a couple of operators; not worth pre-optimizing (delta sync) before
  it's a measured problem.

**Local (operator machine):**

- SQLite cache mirrors the KV dataset *minus* the 80 GB of map tiles — low, bounded
  footprint given the caps above.
- Compute is trivial: sidecar HTTP server + SQLite reads, no meaningful CPU/RAM cost.
- Network only happens during the periodic sync window, not continuously — this is the
  direct fix for "network problem is awful," not incidental.

### Strategy, summarized

1. ~~Port the existing cap/rolling-window discipline into the Nitric KV writes~~ — moot:
   Upstash stays, `redis.ts` and its cap discipline (`UCDP_MAX_EVENTS`, etc.) are
   untouched (2026-08-06 decision).
2. Never let large static/binary assets (map tiles, imagery) into the KV/sync pipeline —
   CDN, direct fetch, unchanged.
3. Bundle seed jobs into scheduled groups on GCP the same way `platform` already did on
   Railway — don't reintroduce the 1-script-1-service cost problem in a new environment.
4. Start the shared→local sync as full periodic snapshot (already agreed); move to
   delta/cursor-based only once `operators × snapshot size × syncs/day` is a measured cost,
   not a hypothetical one.
5. Track key count + approximate KV size as an ongoing signal (cheap to add to the seed
   pipeline itself) so growth is visible before it's a surprise bill.

## Open items

- ~~Auth model for the shared backend~~ — **decided 2026-08-06**: keep worldmonitor's
  existing `X-WorldMonitor-Key`/OAuth scheme as-is. Its billing-tier/quota logic was
  already dead weight, not live complexity — Stage 1 (see
  [[supabase-migration-stage1]]) had already collapsed entitlements to "signed in = full
  access," so this scheme costs zero new code and is already shipped/tested. Switching to
  `platform`'s dual-token model would mean writing new auth code for no functional
  difference now that neither fork enforces per-tier quota. The local sync pipeline
  authenticates against this scheme.
- ~~Confirm Convex/Clerk get cut, not ported~~ — done, see [[supabase-migration-stage1]]
  Stages 1–3 (Convex fully retired for all app-data tables as of 2026-08-06; Convex still
  hosts unrelated Dodo billing/broadcast email, out of scope here).
- **Sync cadence and delta vs. full-snapshot** for the shared-Upstash → local-SQLite pull —
  still open. Start with periodic full snapshot (simplest) and only move to delta sync if
  snapshot size/cost becomes a real problem.
- ~~Confirm scope of the VS Code extension~~ — **decided 2026-08-06**: read-only dashboard
  webview over the local SQLite-backed read API only. No auth-token storage or manual
  "sync now" control in the extension itself for this pass — background periodic sync is
  the only data path. Revisit if that proves too unresponsive for the persona once built.
- The sketch this doc is derived from also has a "CCAM" section — daily agent loop items
  (OKR check-in, effort, collaboration/spawn-task, pickup, implementation) — not yet tied to
  any concrete repo or doc. Needs a follow-up conversation before it becomes actionable here.
