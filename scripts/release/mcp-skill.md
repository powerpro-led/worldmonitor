---
name: worldmonitor-mcp-usage
description: Use the local WorldMonitor MCP server well — which of its 40 tools to reach for, the 6 ready-made multi-step prompts, JMESPath projection discipline, and how to tell real data from a degraded/stale response. Trigger whenever a request needs geopolitical, market, supply-chain, energy, or country-risk data and a `worldmonitor-local` (or similarly named WorldMonitor) MCP server is connected.
---

# Using the WorldMonitor MCP server well

This server exposes ~40 read-only tools over WorldMonitor's own data pipeline — geopolitics,
military, finance, climate, cyber, maritime, aviation, trade/supply-chain, and more — running
fully local against your own loopback token. This is not "how do I connect it" (that's in
`INSTALL.md`'s MCP section); it's how to use it well once connected: pick the right tool the
first time, keep responses cheap, and don't quote stale or degraded data as if it were live.

## Before composing raw tool calls: check the 6 ready-made prompts

Issue `prompts/list` (or `prompts/get` directly if you already know the name) before hand-rolling
a multi-tool sequence — these chain the right tools with pre-tuned JMESPath projections already
baked in, so they're both less work and cheaper to run than composing calls yourself:

| Prompt | Args | What it does |
|---|---|---|
| `country-briefing` | `iso2` (required) | CII risk score + component breakdown + travel/sanctions posture, LLM country brief, IMF macro slice — one call per data source, combined into one briefing. |
| `energy-shock-watch` | `country` (optional) | Active energy disruptions, fuel shortages, government crisis policies. Omit `country` for a global view. |
| `market-open-prep` | none | Equity/commodity/crypto movers (symbol + %change only — cheap by design). |
| `conflict-pulse` | `country` (optional) | UCDP conflict events (≥1 fatality) + alert-flagged top news, for one country or globally. |
| `route-risk-check` | `chokepoint` (required, substring match e.g. `"hormuz"`) | Transit volume, week-over-week change, risk level/narrative, incident count for one maritime chokepoint. |
| `freshness-audit` | none | `cached_at`/`stale` only (no payload) across market/energy/chokepoint caches — the cheapest way to sanity-check the pipeline before trusting anything else this session. |

A client that doesn't auto-surface MCP prompts (Codex, some thin clients) needs to be told this
mechanism exists — `prompts/get` with the right `name` + `arguments` still works, it's just not
offered automatically in the UI.

If none of the six fit, compose raw `tools/call`s using the map below.

## Discovery habits that keep this cheap

- **`describe_tool({tool_name})` before calling something unfamiliar.** The default `tools/list`
  ships each tool's description compressed to ≤120 bytes to keep the catalog small; `describe_tool`
  returns the full definition (every argument, every enum). It is quota-exempt — use it freely
  while exploring, don't guess a tool's argument shape from its name.
- **Pass `jmespath` on every call once you know the shape you want.** Every tool accepts an
  optional `jmespath` string, applied server-side after the tool's own filtering — typically an
  80-95% token reduction versus the full payload. See the six prompts above for real examples
  (e.g. `market-open-prep`'s `{symbol: symbol, changePercent: changePercent}` shape). Grammar:
  https://jmespath.org/specification.html. A bad expression soft-fails with
  `{_jmespath_error, original_keys}` so you can self-correct from `original_keys` — but that retry
  still consumes a quota unit on the hosted path, so on a first unfamiliar tool it's often cheaper
  to call once without `jmespath`, read `original_keys`-equivalent structure, then re-call filtered.
- **Cache-tool responses are wrapped** as `{cached_at, stale, data: {<label>: {...}}}` — JMESPath
  into these starts at `data.<label>`, not the label directly (RPC tools return the raw payload,
  no `data.` prefix). Confusing the two is the most common wasted call.

## Tool map by domain

Not a full spec — enough to route the request to the right tool without guessing. Call
`describe_tool` for exact arguments before your first use of anything below marked with a param.

**Geopolitics & conflict** — `get_country_risk` (CII score, no LLM, fast), `get_country_brief`
(LLM-synthesised narrative), `get_world_brief` (global LLM brief, optional `geo_context`),
`get_conflict_events` (UCDP events + unrest), `get_news_intelligence` (classified threat news,
filter by `country`/`category`/`alerts_only`), `get_displacement_data` (UNHCR refugee/IDP counts),
`get_positive_events` (diplomatic/humanitarian good news), `analyze_situation` (free-text LLM
deduction — give it a query and optional geo context, not a fixed lookup).

**Military & security** — `get_military_posture` (theater posture + escalation signals),
`get_cyber_threats` (malware IOCs, CISA KEV, active C2 infra), `get_infrastructure_status`
(Cloudflare Radar / cloud-provider outages).

**Finance & macro** — `get_market_data` (equity/commodity/crypto/FX/sector/ETF-flow quotes),
`get_economic_data` (Fed funds, China macro snapshot, BIS debt-service ratio, property indices),
`get_country_macro` (IMF WEO per-country — growth, fiscal, labor, external; note: export/import
USD *levels* are null post the 2026-04 WEO retraction, use `currentAccountUsd` or volume-%-change
fields instead), `get_consumer_prices` (currently only `ae` seeded), `get_prediction_markets`
(Polymarket), `get_eu_housing_cycle` / `get_eu_industrial_production` / `get_eu_quarterly_gov_debt`
(Eurostat, all 27 EU members + aggregates, sparkline series included).

**Trade & supply chain** — `get_supply_chain_data` (dry-bulk shipping stress, customs revenue,
COMTRADE bilateral flows — filter `commodity` by HS code or substring, `reporter` by name or
numeric code), `get_tariff_trends` (US HTS tariffs, BigMac index, FAO food price index, national
debt — filter by `country` and/or `dataset`), `get_sanctions_data` (OFAC SDN entities + per-country
pressure scores — filter `country`/`entity_type`/`query`), `get_procurement_opportunities` (open
public-procurement listings — `automationFit` is keyword relevance, never bidding eligibility),
`get_commodity_geo` (71 major mining sites — metals/minerals only, not agricultural commodities).

**Energy & maritime chokepoints** — `get_energy_intelligence` (EIA/Ember/GIE supply, prices,
storage, disruptions, crisis policy), `get_chokepoint_status` (Suez/Hormuz/Malacca/Bab-el-Mandeb/
Panama transit volumes + risk narrative — prefer the `route-risk-check` prompt over calling this
raw), `get_maritime_activity` (AIS density, dark-ship events, per-country waters).

**Aviation & travel** — `get_aviation_status` (FAA delays, NOTAM closures, tracked military
aircraft), `get_airspace` (live ADS-B over one country, civilian + identified military),
`search_flights` (Google Flights, one date, IATA codes), `search_flight_prices_by_date`
(date-grid pricing across a range — cheapest day to fly).

**Climate, disasters & health** — `get_climate_data` (temp/precip anomalies vs. WMO normals, CO2,
air quality, Arctic ice, weather alerts), `get_natural_disasters` (USGS earthquakes, NASA FIRMS
wildfires), `get_radiation_data` (monitoring-station levels, anomaly flags), `get_health_signals`
(disease outbreaks + air-quality readings).

**Forecasting & research signals** — `get_forecast_predictions` (pre-computed cache, fast),
`generate_forecasts` (live model call, slower — only reach for this when the cached predictions
don't cover what you need), `get_forecast_scorecard` (calibration/Brier score, how much to trust
the forecasts above), `get_research_signals` (curated emerging-tech feeds), `get_social_velocity`
(Reddit geopolitical engagement/trend signals).

## Telling real data from degraded data

Don't narrate a `cached_at` timestamp or a payload as current without checking these fields first
— they are the server's own admission that a request degraded rather than failing loudly:

- `stale: true` on a cache-tool envelope — the cadence budget for at least one contributing key
  was missed. Say so; don't present the payload as fresh.
- `upstreamUnavailable: true`, `unavailable: true`, `degraded: true`, or `available: false` —
  the underlying source failed and this is a fallback/empty shape, not real data.
- `dataAvailable: false` — used specifically by chokepoint/route data; the `route-risk-check`
  prompt's own instructions call this out explicitly.
- A non-empty `error` string anywhere in the payload — surface it, don't silently drop it.

When in doubt, run the `freshness-audit` prompt first — it's built exactly for this and costs
almost nothing to check.

## Worked playbooks

### Stock / equity researcher — morning routine

1. `freshness-audit` — confirm the pipeline is live before trusting anything below.
2. `market-open-prep` — equity/commodity/crypto movers, spot the names worth digging into.
3. For a name with a country- or sector-specific angle (e.g. China exposure, a Gulf producer,
   an EU industrial name): `country-briefing` with that `iso2` — CII score, sanctions exposure,
   and the LLM brief in one shot.
4. If the angle is a specific counterparty or supplier rather than a country:
   `get_sanctions_data` with `query` set to the entity name — cheap compliance/exposure check.
5. If the name is energy- or commodity-linked: `get_energy_intelligence` (disruptions/prices) and,
   if a shipping lane is in play, the `route-risk-check` prompt for the relevant chokepoint.
6. `get_economic_data` / `get_country_macro` for the macro backdrop (rates, China snapshot, IMF
   WEO growth/fiscal) rather than re-deriving it from news.

### Amazon seller (import-dependent goods, e.g. tea) — sourcing & landed-cost watch

Tea's HS heading is `0902`; use it as the `commodity`/`hsCode` filter below rather than the word
"tea" alone where a tool matches on code.

1. `get_tariff_trends` with `dataset: ["tariffs"]` and `country` set to the destination market —
   check current HTS duty rates before a landed-cost estimate changes underneath you.
2. `get_supply_chain_data` with `commodity: "0902"` — COMTRADE bilateral flow values between the
   sourcing country (China, India, Sri Lanka, Kenya, Vietnam, …) and the destination market, plus
   the dry-bulk shipping-stress index for general freight-cost pressure.
3. Route risk: the `route-risk-check` prompt for whichever chokepoint the shipment transits (e.g.
   `"suez"` or `"malacca"` depending on origin) — flag it if `dataAvailable` is false or the risk
   level/incident count has moved since last check.
4. `get_sanctions_data` with `country` set to the sourcing country — supplier/vessel compliance
   screening before committing to a new lane.
5. `get_climate_data` (`dataset: ["anomalies"]`, `country` set to the growing region) or
   `get_natural_disasters` — a rough leading indicator of crop-yield risk in the origin country,
   not authoritative, but worth a glance before a purchasing decision.
6. `get_news_intelligence` with `country` set to the sourcing country and `category` narrowed if
   relevant — catch a labor strike, port closure, or export-ban story before it shows up as a
   COMTRADE gap two months later.

## For Codex users (no separate Skill mechanism)

Codex has no equivalent of a Claude Code Skill file. Paste everything below this file's YAML
frontmatter (the `---`-delimited block at the very top) directly into your project's `AGENTS.md`
— the content above is written to stand alone either way.
