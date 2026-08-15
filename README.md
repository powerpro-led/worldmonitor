# World Monitor

[简体中文](README.zh-CN.md)

**Real-time global intelligence dashboard** — AI-powered news aggregation, geopolitical monitoring, and infrastructure tracking in a unified situational awareness interface.

[![GitHub stars](https://img.shields.io/github/stars/powerpro-led/worldmonitor?style=social)](https://github.com/powerpro-led/worldmonitor/stargazers)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?style=flat&logo=discord&logoColor=white)](https://discord.gg/re63kWKxaz)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Last commit](https://img.shields.io/github/last-commit/powerpro-led/worldmonitor)](https://github.com/powerpro-led/worldmonitor/commits/main)
[![Latest release](https://img.shields.io/github/v/release/powerpro-led/worldmonitor?style=flat)](https://github.com/powerpro-led/worldmonitor/releases/latest)

Live deployment: [worldmonitor.app](https://www.worldmonitor.app) · [tech](https://tech.worldmonitor.app) · [finance](https://finance.worldmonitor.app) · [commodity](https://commodity.worldmonitor.app) · [happy](https://happy.worldmonitor.app) · [energy](https://energy.worldmonitor.app)

<p align="center">
  <a href="./ARCHITECTURE.md"><strong>Architecture</strong></a> &nbsp;·&nbsp;
  <a href="https://github.com/powerpro-led/worldmonitor/releases/latest"><strong>Releases</strong></a> &nbsp;·&nbsp;
  <a href="./CONTRIBUTING.md"><strong>Contributing</strong></a>
</p>

---

## What It Does

- **500+ curated news feeds** across 15 categories, AI-synthesized into briefs
- **Dual map engine** — 3D globe (globe.gl) and WebGL flat map (deck.gl) with 56 map layer types
- **Cross-stream correlation** — military, economic, disaster, and escalation signal convergence
- **Country Instability Index (CII)** — server-authoritative CII v8 stress scoring for 31 Tier-1 countries
- **Finance radar** — 29 stock exchanges, commodities, crypto, and 7-signal market composite
- **Local AI** — run everything with Ollama, no API keys required
- **6 site variants** from a single codebase (world, tech, finance, commodity, happy, energy)
- **25 languages** with native-language feeds and RTL support

For the full feature list, architecture, data sources, and algorithms, see **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

---

## Support Status

All site variants are built from a single codebase and ship from the same release process. The table below clarifies maintenance status so you know which surfaces are safe to depend on.

| Surface | Status | Notes |
|---------|--------|-------|
| `worldmonitor.app`, `tech.`, `finance.`, `commodity.`, `happy.`, `energy.` | Stable | Public deployments built from this repo, actively maintained |

Issues filed against any of the above are triaged from the same backlog — see the [issues board](https://github.com/powerpro-led/worldmonitor/issues) for currently-open work.

---

## Quick Start

```bash
git clone https://github.com/powerpro-led/worldmonitor.git
cd worldmonitor
npm install
npm run dev
```

Open [localhost:3000](http://localhost:3000) (override the port with `DEV_PORT` in `.env.local`). The app runs with no environment variables.

Feature-specific data sources may require credentials. See `.env.example` for the full list.

For variant-specific development:

```bash
npm run dev:tech       # tech variant
npm run dev:finance    # finance variant
npm run dev:commodity  # commodity variant
npm run dev:happy      # happy variant
npm run dev:energy     # energy variant
```

See **[ARCHITECTURE.md](./ARCHITECTURE.md#2-deployment-topology)** for deployment options (Vercel, Docker, static).

---

## Tech Stack

| Category | Technologies |
|----------|-------------|
| **Frontend** | Vanilla TypeScript, Vite, globe.gl + Three.js, deck.gl + MapLibre GL |
| **AI/ML** | Ollama / Groq / OpenRouter, Transformers.js (browser-side) |
| **API Contracts** | Protocol Buffers (278 protos, 34 services), sebuf HTTP annotations |
| **Deployment** | Vercel Edge Functions (60+), Railway relay, PWA |
| **Caching** | Redis (Upstash), 3-tier cache, CDN, service worker |

Full stack details in **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

---

## Programmatic Access

World Monitor is built for agents and scripts as well as browsers:

- **MCP server** — `https://worldmonitor.app/mcp` (Streamable HTTP). Public `tools/list`; `tools/call` authenticates with a `X-WorldMonitor-Key` header or OAuth.
- **REST API** — base `https://api.worldmonitor.app`, described by the [OpenAPI spec](https://worldmonitor.app/openapi.yaml).

---

## Flight Data

Flight data provided graciously by [Wingbits](https://wingbits.com?utm_source=worldmonitor&utm_medium=referral&utm_campaign=worldmonitor), the most advanced ADS-B flight data solution.

---

## Data Sources

WorldMonitor aggregates 65+ external providers and APIs across geopolitics, finance, energy, climate, aviation, cyber, military, infrastructure, and news intelligence — surfaced through 500+ curated feeds and tracked by a freshness monitor covering 35 source groups. See **[ARCHITECTURE.md](./ARCHITECTURE.md#6-data-pipeline)** for providers, feed tiers, and collection methods.

---

## Contributing

Contributions welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

```bash
npm run typecheck        # Type checking
npm run build:full       # Production build
```

---

## License

**AGPL-3.0-only** for the source code. Commercial use is permitted under the AGPL when you comply with its copyleft and source-availability terms.

| Use Case | Allowed? |
|----------|----------|
| Personal / research / educational | Yes, under AGPL-3.0-only |
| Self-hosted instance | Yes, under AGPL-3.0-only |
| Fork and modify | Yes, share source under AGPL-3.0-only when required |
| Commercial use / SaaS | Yes, under AGPL-3.0-only when you comply with AGPL obligations |
| Private-source proprietary use or official branding rights | Separate commercial or trademark permission needed |

See [LICENSE](LICENSE) for the full code license. Commercial licensing is available as an alternative option for teams that need non-AGPL terms.

Copyright (C) 2024-2026 Elie Habib. All rights reserved.

---

## Author

**Elie Habib** — [GitHub](https://github.com/koala73)

## Contributors

<a href="https://github.com/powerpro-led/worldmonitor/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=powerpro-led/worldmonitor" />
</a>

## Security Acknowledgments

We thank the following researchers for responsibly disclosing security issues:

- **Cody Richard** — Disclosed three security findings covering IPC command exposure, renderer-to-sidecar trust boundary analysis, and fetch patch credential injection architecture (2026)

See our [Security Policy](./SECURITY.md) for responsible disclosure guidelines.

---

<p align="center">
  <a href="https://www.worldmonitor.app">worldmonitor.app</a> &nbsp;·&nbsp;
  <a href="https://finance.worldmonitor.app">finance</a> &nbsp;·&nbsp;
  <a href="https://commodity.worldmonitor.app">commodity</a>
</p>

## Star History

<a href="https://api.star-history.com/svg?repos=powerpro-led/worldmonitor&type=Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=powerpro-led/worldmonitor&type=Date&theme=dark" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=powerpro-led/worldmonitor&type=Date" />
 </picture>
</a>
