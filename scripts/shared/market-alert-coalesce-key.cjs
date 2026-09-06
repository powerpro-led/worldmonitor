'use strict';

/**
 * Hidden coalesce-family key for `market_alert` notifications.
 *
 * Market alerts fire on a rounded percent move ("NVDA: +7% surge"), so deduping
 * on the title would let +7% and +8% of the same surge notify twice. The
 * publisher instead sets `payload.coalesceKey` to this asset-class / instrument
 * / direction / severity-band tuple, and the dedup SETNX keys on that — one
 * notification per (instrument, direction, band) inside the dedup TTL.
 *
 * Extracted verbatim from ais-relay.cjs when its inline Market seed loop was
 * decomposed into standalone crons (P14 Phase 2, session 63 — see
 * PLATFORM_ARCHITECTURE.md); now shared by seed-market-quotes.mjs /
 * seed-commodity-quotes.mjs / seed-crypto-quotes.mjs.
 */
function marketAlertCoalesceKey(assetClass, identifier, direction, severity) {
  const stableIdentifier = String(identifier || 'unknown').trim().toLowerCase();
  return `market:${assetClass}:${stableIdentifier}:${direction}:${severity}`;
}

module.exports = { marketAlertCoalesceKey };
