#!/usr/bin/env node
import { runBundle, MIN, HOUR, DAY } from './_bundle-runner.mjs';

await runBundle('relay-backup', [
  { label: 'Climate-News', script: 'seed-climate-news.mjs', seedMetaKey: 'climate:news-intelligence', canonicalKey: 'climate:news-intelligence:v1', intervalMs: 30 * MIN, timeoutMs: 240_000 },
  { label: 'USA-Spending', script: 'seed-usa-spending.mjs', seedMetaKey: 'economic:spending', canonicalKey: 'economic:spending:v1', intervalMs: HOUR, timeoutMs: 120_000 },
  // 1_050_000ms (17.5min): covers fetchCanadaBuys' true worst case in
  // scripts/seed-global-tenders.mjs — a 6MB CSV at this environment's
  // VPN-bypassed ~14KB/s needs ~439s per attempt, and with maxRetries kept at
  // 1 (preserves the tested fast-fail-transient-retry behavior) the worst
  // case is two full 500s attempts + backoff (~1001s), not one. Was 180_000,
  // which could never fit even a single real attempt. Raised session 37 after
  // confirming this bundle has no live Railway deployment yet (no maxBundleMs
  // budget conflict, no risk of colliding with a real container-kill ceiling)
  // — see TASKS.md. The other 5 parallel sources in this seed are all much
  // faster and were never the bottleneck.
  { label: 'Global-Tenders', script: 'seed-global-tenders.mjs', seedMetaKey: 'economic:global-tenders', canonicalKey: 'economic:global-tenders:v1', intervalMs: HOUR, timeoutMs: 1_050_000 },
  { label: 'UCDP-Events', script: 'seed-ucdp-events.mjs', seedMetaKey: 'conflict:ucdp-events', intervalMs: 6 * HOUR, timeoutMs: 300_000 },
  { label: 'WB-Indicators', script: 'seed-wb-indicators.mjs', seedMetaKey: 'economic:worldbank-techreadiness:v1', intervalMs: DAY, timeoutMs: 300_000 },
]);
