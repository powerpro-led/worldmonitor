# World Monitor — By the time it's news, you already knew.

Real-time global intelligence dashboard. World Monitor streams the world's raw signals — ships, jets, sirens, cables, markets — onto one live map, with AI that flags when they converge into something that matters.

This is a private, self-hosted fork — not the official worldmonitor.app product, no public signup or self-service access. Open-source (AGPL-3.0). Runs as a web app, installable PWA, and native desktop app for macOS, Windows, and Linux.

## What you get

- Real-time global map with 56 data layers and 500+ curated news feeds
- CII v8 for 31 Tier-1 countries, 196-country resilience scores, and global live conflict tracking
- Market quotes, sector heatmaps, and macro indicators
- 13 shipping chokepoints with live AIS vessel-transit intelligence
- Satellite tracking, GPS jamming zones, submarine cables, AI datacenters
- Daily AI brief, Scenario Engine, custom monitors and breaking alerts
- 41-tool MCP server so AI agents can query everything above

## For AI agents

- **MCP server:** `https://worldmonitor.app/mcp` (Streamable HTTP) — server card at [/.well-known/mcp](https://worldmonitor.app/.well-known/mcp)
- **A2A:** agent card at [/.well-known/agent-card.json](https://worldmonitor.app/.well-known/agent-card.json) — JSON-RPC endpoint at `https://www.worldmonitor.app/a2a`
- **REST API:** base `https://api.worldmonitor.app` — OpenAPI spec at [/openapi.json](https://worldmonitor.app/openapi.json)
- **Agent skills:** [/.well-known/agent-skills/index.json](https://worldmonitor.app/.well-known/agent-skills/index.json)

Access is operator-issued only (`X-WorldMonitor-Key`) or OAuth 2.1 for accounts that have already cleared sign-in — there is no self-service key issuance or public onboarding path.
