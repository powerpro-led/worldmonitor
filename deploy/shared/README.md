# `deploy/shared/` — the shared deploys

Everything under `deploy/orgs/` is per-tenant. This directory holds **shared**
deploys that every org's per-org deploy depends on but does not run itself.
There are two:

1. **AIS ingest** (`scripts/ais-relay.cjs`) — the AIS WebSocket, one
   persistent connection. See below.
2. **Centralized seeders** (`data-shared`) — ordinary polling/batch crons
   flagged `"centralized": true` in `scripts/railway-services.json`, run once
   instead of once per org. See "The `data-shared` deploy" further down.

Both follow the same shape: hold only their own credentials, write into a
shared read-only Upstash, and each org's own deploy bridges that output in
via a `--once` cron. `data-shared` is the generalization of the AIS pattern
(CROSS_ORG_SHARED_DATA_PROPOSAL.md session 3) — read the AIS section first,
it's the precedent the newer one is modeled on.

## AIS ingest — why it's shared, not per-org (P14 / P16 / P17)

`wss://stream.aisstream.io` is the one genuinely persistent connection in the
stack, and the vessel feed is **public and identical for every tenant**. Under
P14 Phase 2 the relay's 28 seed/warm-ping loops all became standalone crons
(`gcp/scheduler/main.ts` `CADENCES`); Telegram and the TransitSummary merge
became per-org `--once` jobs. What's left in `ais-relay.cjs` is:

- the AIS WebSocket core + `buildSnapshot()` + `GET /ais/snapshot`
- `seedChokepointTransits` (pure-AIS crossing counts — reads the in-process Map)
- the Oref siren poller (`GET /oref/alerts` — one residential-proxy secret)
- the public-data HTTP proxy routes (`/rss`, `/opensky`, `/worldbank`,
  `/polymarket`, `/yahoo-chart`, `/aviationstack`, `/notam`, `/youtube-live`,
  `/google-flights/*`, `/widget-agent`)

All of that is public data or a public feed. Running it once, shared, replaces
N redundant WebSocket connections to the same upstream.

## AIS ingest — how each org connects to it (P17)

The shared deploy holds **only its own credentials** — it never writes into a
tenant DB. It writes `supply_chain:chokepoint_transits:v1` (+ seed-meta) into a
shared **"AIS results" Upstash**. Each org's per-org deploy runs
`scripts/sync-ais-results.mjs` (a `--once` cron, every 2 min) which copies
those keys into that org's own Upstash. Each org's `deploy-org.reusable.yml` also sets
`WS_RELAY_URL` to this shared deploy's URL so the per-org RPC handlers
(`get-vessel-snapshot`, `list-oref-alerts`, the market/RSS relay fallbacks)
reach it directly for the HTTP-pull surfaces.

## AIS ingest — files

| File | Purpose |
|---|---|
| `ais-ingest.yml` | non-secret config (region, gcp project, domain) — safe to commit |
| `../../nitric.ais-shared.yaml` | the Nitric stack file — pins `ais-relay` at `min-instances: 1`, everything else `0` |
| `../../.github/workflows/deploy-ais-shared.yml` | `workflow_dispatch` deploy, GH Environment `ais-shared` |

## AIS ingest — status

**First real `nitric up` run: 2026-09-16.** Was scaffold/never-deployed until
then. The code it deploys (`scripts/ais-relay.cjs` minus Telegram minus the
TransitSummary merge) is real and covered by tests.

Found on that first run: `nitric.ais-shared.yaml` deploys the SAME app image
as any per-org stack (Nitric has no per-stack service selection), which
includes `gcp/scheduler/main.ts` — and that file's `DATA_SHARED_SCHEDULER`
filter (see its header comment) has no third state for "run nothing." Left
as-is, the `ais-shared` deploy would have registered real Cloud Scheduler
triggers for every ordinary per-org cadence (fetch-gpsjam, seed bundles, …)
against a project with zero tenant credentials — real recurring cost +
guaranteed failures, not the harmless min-instances:0 idle it looked like.
Fixed by adding `AIS_SHARED_SCHEDULER=true` (hardcoded into
`deploy-ais-shared.yml`'s own `.env` step, not a GH secret/var — this deploy
never needs it to vary) — `gcp/scheduler/main.ts` now skips every
nixpacks-* cadence entirely in that context. `ais-relay`'s own Cloud Run
service (wired directly in root `nitric.yaml`, not through this filter) is
unaffected.

## AIS ingest — GH Environment `ais-shared` secrets

| Secret / var | What |
|---|---|
| `GCP_CREDENTIALS` | service-account JSON for the shared GCP project |
| `PULUMI_ACCESS_TOKEN` | Nitric's GCP provider deploys via Pulumi |
| `AISSTREAM_API_KEY` | the shared aisstream.io key |
| `AIS_RESULTS_UPSTASH_REST_URL` / `AIS_RESULTS_UPSTASH_REST_TOKEN` | the shared "AIS results" Upstash — **write** side (the read-only token is what each org's Environment gets) |
| `OREF_PROXY_URL` (+ auth) | residential proxy with an Israel exit, for the Oref siren poller |
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | OpenSky OAuth for the `/opensky` proxy route |
| `RELAY_SHARED_SECRET` | the `x-relay-key` every per-org deploy sends on relay calls |
| `WIDGET_AGENT_*` LLM key | for the `/widget-agent` route (optional) |
| `vars.APP_DOMAIN` | CORS allow-list derivation |

`deploy/shared/ais-ingest.yml` carries only the non-secret region / project / domain.

---

## The `data-shared` deploy (CROSS_ORG_SHARED_DATA_PROPOSAL.md session 3)

Generalizes the AIS pattern above from "one persistent-connection source" to
"any ordinary polling/batch cron worth running once instead of once per org."
A `scripts/railway-services.json` entry flagged `"centralized": true` runs
HERE — on this shared deploy's own `gcp/scheduler/main.ts` instance — instead
of on every org's own deploy (see that file's header comment for the
`DATA_SHARED_SCHEDULER` env flag that makes the SAME scheduler code filter
differently in each context; one script registry, not two that could drift).

**Pilot: `seed-comtrade-bilateral-hs4` only.** UN Comtrade's free tier is 500
calls/month per key — every org previously needed (or was meant to need; see
below) its own key and burned most of a month's quota on one run. Centralized,
one org's worth of quota serves everyone.

Unlike AIS, this deploy holds no persistent connection — everything here is a
normal scheduled cron, so nothing needs a `min-instances: 1` pin
(`nitric.data-shared.yaml` leaves everything at the default `0`).

### How each org connects to it

Same shape as AIS, different mechanism on purpose (session 2 found AIS's own
bridge — a blind poll on 2 hardcoded keys every 2 minutes — wouldn't scale
past AIS's 2-key case). Each org's own deploy runs
`scripts/sync-shared-results.mjs` (a `--once` cron, every 5 min): it reads
this deploy's `sync:changelog` stream from a cursor persisted in the ORG's own
Upstash, pulls only the keys that actually changed, and writes them into that
org's Upstash with the same TTL + fast-path-notify treatment any other seeded
key gets — see that script's own header for the full mechanism, including its
low-frequency full-reconciliation backstop.

### Files

| File | Purpose |
|---|---|
| `data-shared.yml` | non-secret config (region, gcp project) — safe to commit |
| `../../nitric.data-shared.yaml` | the Nitric stack file — no pinned instances, unlike `ais-shared` |
| `../../.github/workflows/deploy-data-shared.yml` | `workflow_dispatch` deploy, GH Environment `data-shared` |
| `../../scripts/sync-shared-results.mjs` | the per-org bridge (runs in every org's OWN deploy, not here) |
| `../../scripts/shared/sync-domains.mjs` | `SHARED_DATA_KEY_PREFIXES` — the up-to-date list of what's actually centralized |

### Status

**Scaffold — never deployed**, same status as `ais-shared`. Nothing built
here has run against real GCP infrastructure; `scripts/seed-comtrade-bilateral-hs4.mjs`
itself is real, tested, and already runs today (per-org, pre-migration) —
only the shared-deploy plumbing and the `centralized` flag are new.

### GH Environment `data-shared` secrets

| Secret / var | What |
|---|---|
| `GCP_CREDENTIALS` | service-account JSON for the shared GCP project (same project as `ais-shared`) |
| `PULUMI_ACCESS_TOKEN` | Nitric's GCP provider deploys via Pulumi |
| `DATA_SHARED_UPSTASH_REST_URL` / `DATA_SHARED_UPSTASH_REST_TOKEN` | the shared "data-shared" Upstash — **write** side (the read-only token is what each org's Environment gets, alongside `AIS_RESULTS_UPSTASH_*`) |
| `COMTRADE_API_KEYS` | pilot only — the Comtrade key(s), moved here from each org's own `pipeline_config`. Add each future centralized seeder's own data-source secret here as it migrates. |
| `vars.APP_DOMAIN` | CORS allow-list derivation |
