# `deploy/shared/` — the ONE shared AIS-ingest deploy

Everything under `deploy/orgs/` is per-tenant. This directory is the single
**shared** deploy that every org's per-org deploy depends on but does not run
itself: the AIS WebSocket ingest (`scripts/ais-relay.cjs`).

## Why it's shared, not per-org (P14 / P16 / P17)

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

## How each org connects to it (P17)

The shared deploy holds **only its own credentials** — it never writes into a
tenant DB. It writes `supply_chain:chokepoint_transits:v1` (+ seed-meta) into a
shared **"AIS results" Upstash**. Each org's per-org deploy runs
`scripts/sync-ais-results.mjs` (a `--once` cron, every 2 min) which copies
those keys into that org's own Upstash. Each org's `deploy-org.reusable.yml` also sets
`WS_RELAY_URL` to this shared deploy's URL so the per-org RPC handlers
(`get-vessel-snapshot`, `list-oref-alerts`, the market/RSS relay fallbacks)
reach it directly for the HTTP-pull surfaces.

## Files

| File | Purpose |
|---|---|
| `ais-ingest.yml` | non-secret config (region, gcp project, domain) — safe to commit |
| `../../nitric.ais-shared.yaml` | the Nitric stack file — pins `ais-relay` at `min-instances: 1`, everything else `0` |
| `../../.github/workflows/deploy-ais-shared.yml` | `workflow_dispatch` deploy, GH Environment `ais-shared` |

## Status

**Scaffold — never deployed.** Like the rest of the Nitric/GCP target
(`docs/architecture/nitric-gcp-scaffold.md`), `nitric up` has not been run
against this. The code it deploys (`scripts/ais-relay.cjs` minus Telegram
minus the TransitSummary merge) is real and covered by tests; the deploy
plumbing here is parity scaffold pending a first real run.

## GH Environment `ais-shared` — secrets

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
