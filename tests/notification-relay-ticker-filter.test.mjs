/**
 * Regression test: scripts/notification-relay.cjs's watchlist ticker-scope
 * filter for `watchlist_story_alert` events (#4922 item e / U3).
 *
 * Modeled on tests/notification-relay-country-filter.test.mjs — two surfaces:
 *  1. Source-grep: the filter MUST be wired into the per-rule matching loop
 *     alongside shouldNotify/eventMatchesCountryScope. The former "must still
 *     consult the batch PRO gate" surface was removed in Stage 3 of the
 *     Convex/Clerk -> Supabase migration — see the PRO-gate-removal test
 *     below.
 *  2. Behavioural: re-execute the filter logic against a synthetic
 *     rule × event matrix to lock in the OPT-IN semantics:
 *       - unlike `countries` (empty = unscoped, all events match), an empty
 *         or absent `rule.tickers` means NO delivery for this event type;
 *       - the rule must explicitly list 'watchlist_story_alert' in its
 *         eventTypes (the empty-eventTypes wildcard does NOT cover it);
 *       - a rule whose eventTypes only adds the watchlist opt-in keeps its
 *         wildcard behaviour for broadcast event types (rss_alert etc.).
 *
 * Also locks the tickers forwarding contract through the API layers
 * (api/notification-channels.ts + server/_shared/alert-rules.ts — collapsed
 * from the old two-layer api/notification-channels.ts + convex/http.ts
 * relay in Stage 3), mirroring
 * tests/notification-channels-countries-contract.test.mjs.
 *
 * Run: node --test tests/notification-relay-ticker-filter.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const relaySrc = readFileSync(
  resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'),
  'utf-8',
);
const edgeSrc = readFileSync(resolve(__dirname, '..', 'api', 'notification-channels.ts'), 'utf-8');
const sharedRulesSrc = readFileSync(resolve(__dirname, '..', 'server', '_shared', 'alert-rules.ts'), 'utf-8');

// ── Mirror implementations (kept in sync via the source-grep tests below;
// the relay file is a runtime script with no exports — same pattern as the
// country-filter test). ──────────────────────────────────────────────────────

const WATCHLIST_STORY_EVENT_TYPE = 'watchlist_story_alert';

function ruleMatchesEventType(rule, event) {
  if (event?.eventType === WATCHLIST_STORY_EVENT_TYPE) {
    return rule.eventTypes.includes(WATCHLIST_STORY_EVENT_TYPE);
  }
  const broadcastTypes = rule.eventTypes.filter((t) => t !== WATCHLIST_STORY_EVENT_TYPE);
  return broadcastTypes.length === 0 || broadcastTypes.includes(event.eventType);
}

function eventMatchesTickerScope(event, rule) {
  if (event?.eventType !== WATCHLIST_STORY_EVENT_TYPE) return true;
  if (!Array.isArray(rule.tickers) || rule.tickers.length === 0) return false;
  const eventTickers = Array.isArray(event?.payload?.tickers) ? event.payload.tickers : [];
  if (eventTickers.length === 0) return false;
  const ruleSet = new Set(rule.tickers.map((t) => String(t).toUpperCase()));
  return eventTickers.some((t) => ruleSet.has(String(t).toUpperCase()));
}

// Full matching predicate for a rule (eventTypes gate + ticker scope), so the
// behavioural matrix exercises the same conjunction the relay's filter uses.
function matchesWatchlist(rule, event) {
  return ruleMatchesEventType(rule, event) && eventMatchesTickerScope(event, rule);
}

describe('notification-relay watchlist ticker filter — source-grep contract', () => {
  it('declares eventMatchesTickerScope helper', () => {
    assert.match(
      relaySrc,
      /function\s+eventMatchesTickerScope\s*\(\s*event\s*,\s*rule\s*\)/,
      'relay must declare eventMatchesTickerScope(event, rule)',
    );
  });

  it('non-watchlist events bypass the ticker filter (returns true)', () => {
    assert.match(
      relaySrc,
      /if\s*\(\s*event\?\.eventType\s*!==\s*WATCHLIST_STORY_EVENT_TYPE\s*\)\s*return\s+true/,
      'ticker filter must early-return true for every other event type',
    );
  });

  it('opt-in scoped: empty/absent rule.tickers returns false (asymmetric to countries)', () => {
    assert.match(
      relaySrc,
      /if\s*\(\s*!\s*Array\.isArray\(\s*rule\.tickers\s*\)\s*\|\|\s*rule\.tickers\.length\s*===\s*0\s*\)\s*return\s+false/,
      'empty/absent rule.tickers must early-return false — no tickers = no watchlist delivery',
    );
  });

  it('requires explicit eventTypes opt-in — the empty-eventTypes wildcard does NOT cover watchlist events', () => {
    assert.match(
      relaySrc,
      /function\s+ruleMatchesEventType\s*\(\s*rule\s*,\s*event\s*\)/,
      'relay must declare ruleMatchesEventType(rule, event)',
    );
    assert.match(
      relaySrc,
      /return\s+rule\.eventTypes\.includes\(WATCHLIST_STORY_EVENT_TYPE\)/,
      'watchlist events must require explicit eventTypes inclusion',
    );
    // The legacy inline wildcard must be replaced by the helper in the
    // matching filter — otherwise wildcard rules would silently receive
    // watchlist events they never opted into.
    assert.doesNotMatch(
      relaySrc,
      /\(r\.eventTypes\.length === 0 \|\| r\.eventTypes\.includes\(event\.eventType\)\)/,
      'the raw eventTypes wildcard must be routed through ruleMatchesEventType',
    );
  });

  it('watchlist opt-in does not shrink the broadcast wildcard', () => {
    assert.match(
      relaySrc,
      /const\s+broadcastTypes\s*=\s*rule\.eventTypes\.filter\(\s*\(?t\)?\s*=>\s*t\s*!==\s*WATCHLIST_STORY_EVENT_TYPE\s*\)/,
      'ruleMatchesEventType must exclude the watchlist opt-in when evaluating the broadcast wildcard',
    );
  });

  it('filter is wired into the per-rule matching loop alongside shouldNotify + country scope', () => {
    assert.match(
      relaySrc,
      /ruleMatchesEventType\(r,\s*event\)\s*&&\s*\n?\s*shouldNotify\(r,\s*event\)\s*&&\s*\n?\s*eventMatchesCountryScope\(event,\s*r\)\s*&&\s*\n?\s*eventMatchesTickerScope\(event,\s*r\)/,
      'eventMatchesTickerScope must be in the matching filter alongside shouldNotify/eventMatchesCountryScope',
    );
  });

  it('layer-3 PRO gate was removed, not silently left as dead code (Stage 3 migration)', () => {
    // Convex's `entitlements` table has had nothing writing to it since
    // Stage 1 deleted Dodo billing, so this delivery-time PRO filter had
    // degenerated into "drop every delivery." Stage 3 of the Convex/Clerk ->
    // Supabase migration deleted it outright — every matched rule (including
    // watchlist_story_alert rules) now delivers unconditionally. See memory
    // `supabase-migration-stage1`.
    // Match the call/usage shape, not the bare word — the retirement comment
    // at the top of the file legitimately mentions "isUserPro" by name to
    // document why it's gone.
    assert.doesNotMatch(relaySrc, /isUserPro\(/, 'isUserPro must not be called anywhere in the relay');
    assert.doesNotMatch(relaySrc, /proSet\.has/, 'proSet must not be consulted anywhere in the relay');
  });
});

describe('notification-relay watchlist ticker filter — behavioural', () => {
  const event = (tickers) => ({
    eventType: WATCHLIST_STORY_EVENT_TYPE,
    severity: 'high',
    payload: {
      title: 'Apple unveils new chip',
      link: 'https://example.com/apple',
      source: 'Example Wire',
      tickers,
      importanceScore: 74,
      coalesceKey: 'watchlist:abc123',
    },
  });
  const rule = (tickers, eventTypes = [WATCHLIST_STORY_EVENT_TYPE]) => ({
    eventTypes,
    tickers,
  });

  it('intersection match delivers', () => {
    assert.equal(matchesWatchlist(rule(['AAPL', 'MSFT']), event(['AAPL', 'TSM'])), true);
  });

  it('disjoint tickers filtered', () => {
    assert.equal(matchesWatchlist(rule(['NVDA', 'MSFT']), event(['AAPL', 'TSM'])), false);
  });

  it('rule without tickers not delivered for this event type (opt-in scoped, unlike countries)', () => {
    assert.equal(matchesWatchlist(rule([], [WATCHLIST_STORY_EVENT_TYPE]), event(['AAPL'])), false);
    assert.equal(matchesWatchlist(rule(undefined, [WATCHLIST_STORY_EVENT_TYPE]), event(['AAPL'])), false);
  });

  it('rule without the eventType not delivered — even with matching tickers', () => {
    assert.equal(matchesWatchlist(rule(['AAPL'], []), event(['AAPL'])), false);
    assert.equal(matchesWatchlist(rule(['AAPL'], ['rss_alert']), event(['AAPL'])), false);
  });

  it('event without tickers never delivers to a scoped rule', () => {
    assert.equal(matchesWatchlist(rule(['AAPL']), event([])), false);
    assert.equal(matchesWatchlist(rule(['AAPL']), event(undefined)), false);
  });

  it('intersection is case-insensitive (defensive against unnormalized rows)', () => {
    assert.equal(matchesWatchlist(rule(['aapl']), event(['AAPL'])), true);
  });

  it('non-watchlist events pass the ticker filter untouched', () => {
    const rss = { eventType: 'rss_alert', payload: { title: 'x' } };
    assert.equal(eventMatchesTickerScope(rss, rule([], [])), true);
    assert.equal(eventMatchesTickerScope(rss, {}), true);
  });

  it("wildcard rule (eventTypes: []) still matches broadcast types but NOT watchlist events", () => {
    const rss = { eventType: 'rss_alert', payload: { title: 'x' } };
    assert.equal(ruleMatchesEventType({ eventTypes: [] }, rss), true);
    assert.equal(ruleMatchesEventType({ eventTypes: [] }, event(['AAPL'])), false);
  });

  it("rule with eventTypes ['watchlist_story_alert'] KEEPS the broadcast wildcard (regression: opting in must not silence rss alerts)", () => {
    const rss = { eventType: 'rss_alert', payload: { title: 'x' } };
    const r = { eventTypes: [WATCHLIST_STORY_EVENT_TYPE] };
    assert.equal(ruleMatchesEventType(r, rss), true);
    assert.equal(ruleMatchesEventType(r, event(['AAPL'])), true);
  });

  it("rule with explicit broadcast list + watchlist opt-in restricts broadcast types to the list", () => {
    const r = { eventTypes: ['oref_siren', WATCHLIST_STORY_EVENT_TYPE] };
    assert.equal(ruleMatchesEventType(r, { eventType: 'oref_siren' }), true);
    assert.equal(ruleMatchesEventType(r, { eventType: 'rss_alert' }), false);
    assert.equal(ruleMatchesEventType(r, event(['AAPL'])), true);
  });
});

describe('tickers forwarding contract — API layers (mirror of the countries contract)', () => {
  it('Vercel edge set-alert-rules forwards tickers to setAlertRules', () => {
    assert.match(
      edgeSrc,
      /action === 'set-alert-rules'[\s\S]*?tickers[\s\S]*?setAlertRules\(userId, variant, \{[\s\S]*?tickers/,
      'set-alert-rules must forward tickers to server/_shared/alert-rules.ts',
    );
  });

  it('set-notification-config forwards tickers and rejects non-arrays', () => {
    assert.match(
      edgeSrc,
      /tickers\s*!==\s*undefined\s*&&\s*!Array\.isArray\(tickers\)[\s\S]*?TICKERS_MUST_BE_ARRAY/,
      'Vercel edge route must reject non-array tickers',
    );
    assert.match(
      edgeSrc,
      /action === 'set-notification-config'[\s\S]*?setNotificationConfig\(userId, variant, \{[\s\S]*?tickers/,
      'set-notification-config must forward tickers to server/_shared/alert-rules.ts',
    );
  });

  it('server/_shared/alert-rules.ts normalizes tickers on write (normalizeTickers, TICKERS_MAX=50)', () => {
    assert.match(sharedRulesSrc, /function normalizeTickers\(input: string\[\]\): string\[\]/);
    assert.match(sharedRulesSrc, /const TICKERS_MAX = 50/);
    // Shape must accept every non-index shared/stocks.json symbol
    // (RELIANCE.NS 8-char base, BRK-B, M&M.NS).
    assert.match(sharedRulesSrc, /\^\[A-Z\]\[A-Z0-9&-\]\{0,11\}\(\\\.\[A-Z\]\{1,3\}\)\?\$/);
  });
});
