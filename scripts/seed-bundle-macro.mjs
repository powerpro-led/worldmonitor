#!/usr/bin/env node
// biovita GCP cost incident follow-up (2026-09-23): on Railway this bundle
// still runs all 15 sections sequentially in one long-lived container, same
// as always. On GCP, `gcp/scheduler/main.ts` instead registers one Cloud
// Scheduler entry PER SECTION below, each invoking `--section=<Label>` so a
// single Cloud Run request only ever needs to cover ONE section's own
// worst-case timeout, not the sum of every section that happens to be due on
// the same day (the failure mode that made seed-bundle-macro one of the 5
// real 504s found in the post-cpu-idle-fix force-run test — see memory
// biovita_gcp_scheduler_cost_pause_2026_09_21.md). `--section=` is optional
// and backward-compatible: omitted, this runs the full bundle exactly as
// before.
import { runBundle, HOUR, DAY } from './_bundle-runner.mjs';

const ALL_SECTIONS = [
  { label: 'BIS-Data', script: 'seed-bis-data.mjs', seedMetaKey: 'economic:bis', canonicalKey: 'economic:bis:policy:v1', intervalMs: 12 * HOUR, timeoutMs: 300_000 },
  // OECD is capped at 60 downloads/hour. Each China macro run performs two
  // consolidated dataflow requests, and the 36h gate stays far below budget.
  { label: 'China-Macro', script: 'seed-china-macro.mjs', seedMetaKey: 'economic:china-macro', canonicalKey: 'economic:china:macro:v1', intervalMs: 36 * HOUR, timeoutMs: 240_000 },
  { label: 'China-Release-Calendar', script: 'seed-china-release-calendar.mjs', seedMetaKey: 'economic:china-release-calendar', canonicalKey: 'economic:china:release-calendar:v1', intervalMs: 36 * HOUR, timeoutMs: 240_000 },
  { label: 'BIS-Extended', script: 'seed-bis-extended.mjs', seedMetaKey: 'economic:bis-extended', canonicalKey: 'economic:bis:dsr:v1', intervalMs: 12 * HOUR, timeoutMs: 300_000 },
  { label: 'BLS-Series', script: 'seed-bls-series.mjs', seedMetaKey: 'economic:bls-series', canonicalKey: 'bls:series:v1', intervalMs: DAY, timeoutMs: 120_000 },
  { label: 'Eurostat', script: 'seed-eurostat-country-data.mjs', seedMetaKey: 'economic:eurostat-country-data', canonicalKey: 'economic:eurostat-country-data:v1', intervalMs: DAY, timeoutMs: 300_000 },
  { label: 'Eurostat-HousePrices', script: 'seed-eurostat-house-prices.mjs', seedMetaKey: 'economic:eurostat-house-prices', canonicalKey: 'economic:eurostat:house-prices:v1', intervalMs: 7 * DAY, timeoutMs: 300_000 },
  { label: 'Eurostat-GovDebtQ', script: 'seed-eurostat-gov-debt-q.mjs', seedMetaKey: 'economic:eurostat-gov-debt-q', canonicalKey: 'economic:eurostat:gov-debt-q:v1', intervalMs: 2 * DAY, timeoutMs: 300_000 },
  { label: 'Eurostat-IndProd', script: 'seed-eurostat-industrial-production.mjs', seedMetaKey: 'economic:eurostat-industrial-production', canonicalKey: 'economic:eurostat:industrial-production:v1', intervalMs: DAY, timeoutMs: 300_000 },
  { label: 'IMF-Macro', script: 'seed-imf-macro.mjs', seedMetaKey: 'economic:imf-macro', canonicalKey: 'economic:imf:macro:v2', intervalMs: 30 * DAY, timeoutMs: 300_000 },
  { label: 'National-Debt', script: 'seed-national-debt.mjs', seedMetaKey: 'economic:national-debt', canonicalKey: 'economic:national-debt:v1', intervalMs: 30 * DAY, timeoutMs: 300_000 },
  { label: 'FAO-FFPI', script: 'seed-fao-food-price-index.mjs', seedMetaKey: 'economic:fao-ffpi', canonicalKey: 'economic:fao-ffpi:v1', intervalMs: DAY, timeoutMs: 120_000 },
  // plan 2026-04-25-004 Phase 2: financialSystemExposure component seeders.
  // Bundle placement = Option A per Codex R1 #5 (less operational overhead
  // than provisioning a new bundle service). All 3 feed the new dim's
  // fail-closed preflight (RESILIENCE_FIN_SYS_EXPOSURE_ENABLED=true).
  { label: 'WB-External-Debt', script: 'seed-wb-external-debt.mjs', seedMetaKey: 'economic:wb-external-debt', canonicalKey: 'economic:wb-external-debt:v1', intervalMs: 30 * DAY, timeoutMs: 300_000 },
  { label: 'BIS-LBS', script: 'seed-bis-lbs.mjs', seedMetaKey: 'economic:bis-lbs', canonicalKey: 'economic:bis-lbs:v1', intervalMs: 7 * DAY, timeoutMs: 600_000 },
  // FATF fetches 3 URLs (entry sequential, black+grey parallel) through a 6-tier
  // fallback chain (direct → proxy → wayback-cdx-direct → wayback-cdx-proxy →
  // wayback-snap-direct → wayback-snap-proxy, ≤125s/URL). Worst-case ≤250s;
  // 300_000 gives ~50s margin and matches peer sections. Pre-PR-#3415 the section
  // was 120_000 — too tight for the multi-tier fallback, would SIGTERM mid-fetch.
  { label: 'FATF-Listing', script: 'seed-fatf-listing.mjs', seedMetaKey: 'economic:fatf-listing', canonicalKey: 'economic:fatf-listing:v1', intervalMs: 30 * DAY, timeoutMs: 300_000 },
];

const sectionArg = process.argv.find((a) => a.startsWith('--section='))?.slice('--section='.length);
const sections = sectionArg ? ALL_SECTIONS.filter((s) => s.label === sectionArg) : ALL_SECTIONS;

if (sectionArg && sections.length === 0) {
  console.error(
    `seed-bundle-macro: unknown --section=${sectionArg}. Valid labels: ${ALL_SECTIONS.map((s) => s.label).join(', ')}`,
  );
  process.exit(1);
}

await runBundle('macro', sections);
