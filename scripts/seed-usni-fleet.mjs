#!/usr/bin/env node

/**
 * USNI Fleet Tracker seed — parses the latest USNI News "Fleet and Marine
 * Tracker" WordPress post into structured carrier / strike-group / vessel
 * data and stores it under usni-fleet:sebuf:v1 (12h TTL) plus a 7-day
 * usni-fleet:sebuf:stale:v1 fallback, so the existing GetUsniFleet RPC serves
 * it without changes.
 *
 * Ported from the startUsniFleetSeedLoop() that used to live inside
 * scripts/ais-relay.cjs (P14 Phase 2 loop-extraction pass — see
 * PLATFORM_ARCHITECTURE.md). HTML parsing is delegated verbatim to
 * scripts/lib/usni-fleet-parser.cjs (already standalone CJS, test-covered by
 * tests/usni-fleet-parser.test.mjs). The relay's ad-hoc ytFetchViaProxy
 * fallback is replaced with the _proxy-utils.cjs resolveProxyConfig/proxyFetch
 * idiom the other extracted loops use (seed-gscpi.mjs). No @notification-source
 * tag — this loop never called publishNotificationEvent.
 */

import { createRequire } from 'node:module';
import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

const require = createRequire(import.meta.url);
const { usniStripHtml, usniParseArticle } = require('./lib/usni-fleet-parser.cjs');

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'usni-fleet:sebuf:v1';
const STALE_KEY = 'usni-fleet:sebuf:stale:v1';
const CACHE_TTL = 43_200; // 12h — must outlive the 6h cron interval (2x)
const STALE_TTL = 604_800; // 7 days
const USNI_URL = 'https://news.usni.org/wp-json/wp/v2/posts?categories=4137&per_page=1';

async function fetchUsniFleet() {
  let wpData;
  try {
    const res = await fetch(USNI_URL, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    wpData = await res.json();
  } catch (directErr) {
    const { resolveProxyConfig, proxyFetch } = require('./_proxy-utils.cjs');
    const proxy = resolveProxyConfig();
    if (!proxy) throw directErr;
    console.warn(`  Direct failed (${directErr.message}) — retrying via proxy`);
    const result = await proxyFetch(USNI_URL, proxy, {
      accept: 'application/json',
      headers: { 'User-Agent': CHROME_UA },
      timeoutMs: 15_000,
    });
    if (!result.ok) throw new Error(`Proxy HTTP ${result.status}`);
    wpData = JSON.parse(result.buffer.toString('utf8'));
  }

  if (!Array.isArray(wpData) || !wpData.length) throw new Error('No fleet tracker articles');

  const post = wpData[0];
  const articleUrl = post.link || `https://news.usni.org/?p=${post.id}`;
  const articleDate = post.date || new Date().toISOString();
  const articleTitle = usniStripHtml(post.title?.rendered || 'USNI Fleet Tracker');
  const htmlContent = post.content?.rendered || '';
  if (!htmlContent) throw new Error('Empty article content');

  const report = usniParseArticle(htmlContent, articleUrl, articleDate, articleTitle);
  console.log(
    `  ${report.vessels.length} vessels, ${report.strikeGroups.length} CSGs, ${report.regions.length} regions`
    + (report.parsingWarnings.length ? ` — warnings: ${report.parsingWarnings.join('; ')}` : ''),
  );
  return report;
}

function validate(data) {
  return Array.isArray(data?.vessels) && data.vessels.length > 0;
}

export function declareRecords(data) {
  return Array.isArray(data?.vessels) ? data.vessels.length : 0;
}

runSeed('military', 'usni-fleet', CANONICAL_KEY, fetchUsniFleet, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'usni-fleet',

  // 7-day fallback copy — same payload, longer TTL, no separate seed-meta
  // (mirrors the relay loop's second envelopeWrite). Auto-added to runSeed's
  // last-good preservation set, so a failed fetch extends its TTL too.
  extraKeys: [{ key: STALE_KEY, transform: (d) => d, ttl: STALE_TTL, declareRecords }],

  declareRecords,
  schemaVersion: 1,
  // 720min — matches api/health.js's SEED_META.usniFleet.maxStaleMin (relay
  // loop every 6h; 720 = 2x interval). That entry predates this script.
  maxStaleMin: 720,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
