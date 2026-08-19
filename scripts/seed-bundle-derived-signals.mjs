#!/usr/bin/env node
import { runBundle, MIN, HOUR } from './_bundle-runner.mjs';

await runBundle('derived-signals', [
  { label: 'Correlation', script: 'seed-correlation.mjs', seedMetaKey: 'correlation:cards', canonicalKey: 'correlation:cards-bootstrap:v1', intervalMs: 5 * MIN, timeoutMs: 60_000 },
  { label: 'Cross-Source-Signals', script: 'seed-cross-source-signals.mjs', seedMetaKey: 'intelligence:cross-source-signals', canonicalKey: 'intelligence:cross-source-signals:v1', intervalMs: 15 * MIN, timeoutMs: 120_000 },
  { label: 'Regional-Snapshots', script: 'seed-regional-snapshots.mjs', seedMetaKey: 'intelligence:regional-snapshots', intervalMs: 6 * HOUR, timeoutMs: 180_000 },
  // Added 2026-08-19 (session 26) -- was a standalone script registered in
  // zero Railway services and zero bundles (TASKS.md's "orphaned crons" item
  // 5), so api/health.js's 360min alarm on seed-meta:regulatory:actions was
  // silently unmeetable. Folded in here rather than given its own schedule:
  // reuses this bundle's existing 5min outer cron, 6 RSS feeds at 15s/feed
  // (scripts/seed-regulatory-actions.mjs's FEED_TIMEOUT_MS) comfortably fits
  // the interval-gated 2h cadence health.js already expects.
  { label: 'Regulatory-Actions', script: 'seed-regulatory-actions.mjs', seedMetaKey: 'regulatory:actions', canonicalKey: 'regulatory:actions:v1', intervalMs: 2 * HOUR, timeoutMs: 120_000 },
  // Added 2026-08-19 (session 26): another "orphaned crons" item 5 fix --
  // same shape as Regulatory-Actions above. intervalMs matches the script's
  // own CACHE_TTL comment ("6x the 30 min cron interval"); 5 lightweight
  // Cloudflare Radar calls, ~8s observed runtime, well inside this bundle's
  // 5min outer cadence.
  { label: 'Internet-Outages', script: 'seed-internet-outages.mjs', seedMetaKey: 'infra:outages', canonicalKey: 'infra:outages:v1', intervalMs: 30 * MIN, timeoutMs: 60_000 },
]);
