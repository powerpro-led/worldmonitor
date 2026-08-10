# JODI source contracts (oil + gas)

**Date:** 2026-08-08
**Scripts:** `scripts/seed-jodi-oil.mjs`, `scripts/seed-jodi-gas.mjs`
**Bundle:** `seed-bundle-energy-sources` (`30 7 * * *`, 35d interval gate on both members)

Both JODI seeders publish only when a China coverage gate passes, and both fetch
from URLs whose shape is not stable over time. This document records the verified
upstream behaviour so the next person does not have to re-derive it.

---

## Upstream cadence (verified live 2026-08-08)

| source | real cadence | evidence |
|---|---|---|
| JODI oil | monthly | `primaryyear2026.csv` last-modified 2026-08-04 |
| JODI gas | monthly, ~3rd week | release ids 15→Jan 21, 16→Feb 18, 17→Mar 16, 18→Apr 20, 19→May 18, 20→Jun 22, 24→Jul 19 |
| IEA oil stocks | monthly | `api.iea.org/netimports/latest` → `{"year":"2026","month":"04"}` |
| OWID energy mix | **irregular, ~annual** | `owid-energy-data.csv` last-modified 2026-04-27 |

Monthly is the right shape for JODI (both) and IEA. OWID is not monthly — its
35d interval is over-polling kept as insurance so the annual refresh is never
missed by a year. Note this means OWID's `seed-meta` freshness is *fetch*
freshness, not content freshness: `energy:mix:v1:*` currently carries `year: 2025`
regardless of how recently the seeder ran. A conditional GET on
`Last-Modified`/`ETag` would skip the 15.9MB download on unchanged content.

There is no global higher-frequency substitute for JODI — it *is* the monthly
global standard for country-level oil/gas flows. Higher-frequency coverage is
necessarily regional, and the same bundle already carries it: EIA petroleum
(weekly, `PET.*.W`, US), GIE AGSI+ gas storage (daily, EU), and ENTSO-E/EIA RTO
electricity prices (hourly).

---

## URL contracts (both were wrong; fixed 2026-08-08)

### Oil — the current year's file has a different name

JODI names closed years and the in-progress year differently:

```
closed year   annual-csv/primary/2025.csv                 200
current year  annual-csv/primary/primaryyear2026.csv      200
              annual-csv/primary/2026.csv                 404   ← what we fetched
```

Same for `secondary/secondaryyear<year>.csv`. The file is renamed to the plain
`<year>.csv` form at year rollover, which is why fetching only `<year>.csv`
appears healthy every January and then silently degrades to prior-year-only data
for the rest of the year. Both current-year fetches were `.catch`-swallowed to
`''`, and `mergeSourceRows` only requires *one* secondary file — the prior year
satisfied it — so the seeder reported a successful fetch while seeing nothing
newer than the prior December.

`jodiCsvCandidates(dataset, year, isCurrentYear)` now tries the likelier shape
first and keeps the other as a fallback, so the rollover window works from either
side.

### Gas — the ZIP path segment is a release counter, not "latest"

`https://www.jodidata.org/jodi-publisher/gas/<n>/GAS_world_NewFormat.zip`

`<n>` increments per publication. It is **not** one-per-month: ids 21, 22 and 23
all landed 22–24 Jun 2026, so `lastKnown + 1` per month is unsafe. The downloads
page injects its links via JS, so there is nothing to scrape.

The seeder was pinned to id 17 (16 Mar 2026). Measured contents:

| release | max `TIME_PERIOD` | China (TJ) max |
|---|---|---|
| 17 (pinned) | 2026-01 | 2025-11 |
| 24 (current) | 2026-06 | 2026-05 |

`resolveLatestGasRelease()` now HEAD-probes upward from `KNOWN_GAS_RELEASE_ID`,
tolerating a single gap, walking back down if the floor is ever pruned, and
falling back to the floor when probing is inconclusive so a network blip degrades
to the previous behaviour rather than failing the seed.

**Maintenance:** `KNOWN_GAS_RELEASE_ID` is a floor, not a pin. Only ever raise it,
and only to an id verified to resolve. Leaving it stale costs extra HEAD probes,
nothing more.

---

## OPEN: the China gate blocks the global product

Both seeders treat missing China coverage as fatal to the entire dataset:

- gas — `enforceChinaGasCoverage` throws with `nonRetryable = true`
- oil — `COVERAGE GATE FAILED` → TTL extension on last-good keys, no publish

China can never satisfy that gate. Every Chinese row JODI publishes carries
`ASSESSMENT_CODE = 3`, in every unit:

```
gas/24  CN → KTONS 3, M3 3, TJ 3
oil     CN → KBD 3, KBBL 3, KTONS 3, KL 3, CONVBBL 3
```

Both parsers keep only codes 1 and 2 (`seed-jodi-gas.mjs` ~L106,
`seed-jodi-oil.mjs` ~L107), so China is dropped before assessment and the gate
returns `china-missing`. Verified by running the real parser over both gas/17 and
gas/24: identical `china-missing` result, so the release id is irrelevant to this
failure.

Consequence: one unavailable country blocks all 63. After the URL fixes the oil
seeder clears its *global* gate with current data (40 countries from current-year
files alone, `dataMonth` 2026-02…2026-05) but still will not publish.

Meanwhile `scripts/china-coverage-manifest.mjs` already declares both sources
`launchStatus: 'blocked'` with reason `CHINA_UPSTREAM_ROW_UNAVAILABLE` — the
manifest knows China is unavailable, but the seeders still treat its absence as
fatal to the global product.

Decoupling these (publish the global dataset; keep China reported as unavailable
per the manifest) is a policy decision about what `launchStatus: 'blocked'` means
operationally, not a bug fix. **Not actioned — needs an explicit decision.** Until
it is, the two URL fixes above are necessary but not sufficient: neither seeder
publishes.
