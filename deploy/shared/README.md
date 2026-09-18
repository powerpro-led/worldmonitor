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
| `../../Dockerfile.relay` | the image this deploy builds and pushes |
| `../../nitric.ais-shared.yaml` | **no longer used to deploy** (see status below); kept as the documented source of the Cloud Run resource settings the workflow mirrors |
| `../../.github/workflows/deploy-ais-shared.yml` | `workflow_dispatch` deploy, GH Environment `ais-shared` |

## AIS ingest — status

**Deploys via `gcloud run deploy`, not Nitric (changed 2026-09-18).** Build
`Dockerfile.relay` → push to Artifact Registry → deploy to Cloud Run.

It used `nitric up --stack ais-shared` until 2026-09-18. The first runs that
actually reached Pulumi showed the model doesn't fit this deploy:

* **A stack cannot opt out of another service's resources.** `nitric up`
  discovers resources by booting EVERY service in `nitric.yaml` and collecting
  what each declares, and that collection phase is **stack-agnostic** — it runs
  once, before any stack-specific logic. So this deploy declared all 83 of
  `gcp/scheduler/main.ts`'s Cloud Scheduler cadences against a shared project
  holding no tenant credentials to run them with.
* **`AIS_SHARED_SCHEDULER` could never have worked.** Added 2026-09-16 to
  suppress exactly that, it was read at collection time — where nitric injects
  **no app env at all** (the container gets 5 `NITRIC_*` vars and nothing
  else). It was inert from the start. The same flaw applies to the
  `DATA_SHARED_SCHEDULER` precedent it was modeled on; `deploy-data-shared.yml`
  still carries that assumption and has never been run.
* **The relay doesn't use Nitric anyway.** `scripts/ais-relay.cjs` imports
  `@nitric/sdk` zero times and declares no nitric resources, so nitric bought
  this deploy nothing while forcing the entire app image on it.

`ais-relay` is still listed in the root `nitric.yaml` — that entry now serves
local `nitric start` (one machine, everything in one process) and per-org
stacks, which leave it at `min-instances: 0`.

**One-time operator step on first creation:** the service needs unauthenticated
Cloud Run ingress, because per-org deploys reach it over the public internet
and authenticate at the application layer with `RELAY_SHARED_SECRET` via the
`x-relay-key` header. Re-deploys preserve the IAM policy, so this is needed
only once (**already done 2026-09-18**):

```
gcloud run services add-iam-policy-binding ais-relay \
  --project=apps-453107 --region=us-central1 \
  --member=allUsers --role=roles/run.invoker
```

**First successful deploy: 2026-09-18** (run 35343188309, 94s).
`https://ais-relay-255128245941.us-central1.run.app`. Verified live: `/health`
returned `status:ok` with `auth.sharedSecretEnabled:true` and Upstash
connected, and after the first `/ais/snapshot` call the upstream came up and
vessel counts started climbing.

**The relay connects to aisstream.io lazily, not at startup** — `connectUpstream()`
is called only from the WS `connection` handler and the `/ais/snapshot` route.
So a freshly deployed instance reports `connected:false, vessels:0` until the
first real consumer arrives; that is expected, not a fault. With
`min-instances=1` the instance then stays up and holds the socket, which is the
whole point of pinning it. A single "Disconnected, reconnecting in 5s" right
after the first connect is normal; it settles on the retry.

## AIS ingest — teardown

Because this deploy no longer goes through Nitric, **nothing here is removed by
`nitric down`** — it is all created directly by
`.github/workflows/deploy-ais-shared.yml` and must be deleted directly too.
Everything lives in `apps-453107` / `us-central1`:

```
gcloud run services delete ais-relay --project=apps-453107 --region=us-central1
gcloud artifacts repositories delete ais-shared --project=apps-453107 --location=us-central1
gcloud iam service-accounts delete ais-relay-run@apps-453107.iam.gserviceaccount.com --project=apps-453107
```

The `allUsers`/`run.invoker` binding is part of the Cloud Run service's own IAM
policy and disappears with it — no separate cleanup.

### Leftovers from the Nitric era

The pre-2026-09-18 deploys left a Pulumi stack behind:
`powerpro-led/worldmonitor/worldmonitor-ais-shared`, ~185 resources, nothing in
this repo points at it any more.

**Do not simply run `nitric down --stack ais-shared` (or `pulumi destroy`) on
it.** `apps-453107` is a SHARED project — `platform` uses it too — and roughly
19 of those resources are project-level API enablements
(`gcp:projects/service:Service`). Destroying the stack would disable APIs other
deploys depend on. The rest (12 service accounts, an Artifact Registry, a Cloud
Tasks queue, 2 API Gateway APIs) are idle and cost effectively nothing, so
there is no urgency.

If it is cleaned up, do it resource by resource, skipping every
`gcp:projects/service:Service`. Inspect the actual contents first — the Pulumi
API works even when local `gcloud` auth has lapsed:

```
curl -s -H "Authorization: token $PULUMI_ACCESS_TOKEN" \
  https://api.pulumi.com/api/stacks/powerpro-led/worldmonitor/worldmonitor-ais-shared/export
```

## AIS ingest — GH Environment `ais-shared` secrets

| Secret / var | What |
|---|---|
| `GCP_CREDENTIALS` | service-account JSON for the shared GCP project |
| `PULUMI_ACCESS_TOKEN` | ~~Nitric's GCP provider deploys via Pulumi~~ — **no longer read** since this deploy dropped Nitric (2026-09-18); still set on the Environment, harmless |
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
