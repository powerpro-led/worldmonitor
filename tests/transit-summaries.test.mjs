import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectTrafficAnomaly } from '../server/worldmonitor/supply-chain/v1/_scoring.mjs';
import {
  CANONICAL_CHOKEPOINTS,
  corridorRiskNameToId,
} from '../server/worldmonitor/supply-chain/v1/_chokepoint-ids.ts';
import {
  detectTrafficAnomaly as seedDetectTrafficAnomaly,
  buildSummaryRow,
  RELAY_NAME_TO_ID as SEED_RELAY_NAME_TO_ID,
  ID_TO_RELAY_NAME as SEED_ID_TO_RELAY_NAME,
  CHOKEPOINT_THREAT_LEVELS as SEED_THREAT_LEVELS,
} from '../scripts/seed-transit-summaries.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const relaySrc = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf-8');
// P14 Phase 2 (session 63): CorridorRisk seeding → scripts/seed-corridor-risk.mjs.
// P14 Phase 2 tail (session 67): the TransitSummary merge → the per-org
// scripts/seed-transit-summaries.mjs (supersedes P16's "relay-local forever" for
// the summary half — the merge's portwatch + corridor-risk inputs are per-org,
// not in the now-shared relay's store). seedChokepointTransits (pure-AIS counts)
// stays in ais-relay.cjs. So: transit-summary assertions read transitSummarySrc;
// corridor-risk fetch/shape/name-map assertions read corridorSrc; OREF + the
// envelopeRead helper still read relaySrc.
const corridorSrc = readFileSync(resolve(root, 'scripts/seed-corridor-risk.mjs'), 'utf-8');
const transitSummarySrc = readFileSync(resolve(root, 'scripts/seed-transit-summaries.mjs'), 'utf-8');
const handlerSrc = readFileSync(resolve(root, 'server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts'), 'utf-8');

function makeDays(count, dailyTotal, startOffset) {
  const days = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.now() - (startOffset + i) * 86400000);
    days.push({
      date: d.toISOString().slice(0, 10),
      tanker: 0,
      cargo: dailyTotal,
      other: 0,
      total: dailyTotal,
    });
  }
  return days;
}

// ---------------------------------------------------------------------------
// 1. seed-transit-summaries.mjs — the per-org merge cron (P14 Phase 2 tail)
// ---------------------------------------------------------------------------
describe('seed-transit-summaries.mjs source invariants', () => {
  it('writes the compact summary key + seed-meta', () => {
    assert.match(transitSummarySrc, /supply_chain:transit-summaries:v1/);
    assert.match(transitSummarySrc, /seed-meta:supply_chain:transit-summaries/);
  });

  it('reads the bridged pure-AIS counts key (not an in-process Map)', () => {
    assert.match(transitSummarySrc, /const CHOKEPOINT_TRANSIT_KEY = 'supply_chain:chokepoint_transits:v1'/);
    assert.match(transitSummarySrc, /readCanonicalValue\(CHOKEPOINT_TRANSIT_KEY\)/);
    // no live reference to the in-process Map (a comment mentions it by name)
    assert.doesNotMatch(transitSummarySrc, /chokepointCrossings\.(get|set|has)\(/);
  });

  it('reads portwatch + corridor-risk from the ORG Upstash via readCanonicalValue', () => {
    assert.match(transitSummarySrc, /readCanonicalValue\(PORTWATCH_REDIS_KEY\)/);
    assert.match(transitSummarySrc, /readCanonicalValue\(CORRIDOR_RISK_REDIS_KEY\)/);
  });

  it('iterates the canonical chokepoint ID set, not Object.entries(pw)', () => {
    assert.match(transitSummarySrc, /CANONICAL_IDS\s*=\s*Object\.keys\(CHOKEPOINT_THREAT_LEVELS\)/);
    assert.match(transitSummarySrc, /for \(const cpId of CANONICAL_IDS\)/);
    assert.doesNotMatch(transitSummarySrc, /for \(const \[cpId[^\]]*\] of Object\.entries\(pw\)\)/);
  });

  it('records actual portwatch coverage (pwCovered) in seed-meta + envelope', () => {
    assert.match(transitSummarySrc, /let pwCovered = 0/);
    assert.match(transitSummarySrc, /if \(cpData\) pwCovered\+\+/);
    assert.match(transitSummarySrc, /recordCount: pwCovered/);
    assert.match(transitSummarySrc, /coverage shortfall/);
  });

  it('writes one per-id history key per canonical chokepoint via writeExtraKey', () => {
    assert.match(transitSummarySrc, /const TRANSIT_SUMMARY_HISTORY_KEY_PREFIX = 'supply_chain:transit-summaries:history:v1:'/);
    assert.match(transitSummarySrc, /await writeExtraKey\(\s*`\$\{TRANSIT_SUMMARY_HISTORY_KEY_PREFIX\}\$\{cpId\}`/);
    assert.match(transitSummarySrc, /chokepointId: cpId, history, fetchedAt: now/);
  });

  it('empty-portwatch early return is non-silent (logs key + reason)', () => {
    const mainBody = transitSummarySrc.match(/export async function main\(\)\s*\{([\s\S]*?)\nif \(process\.argv/)?.[1] || '';
    assert.doesNotMatch(mainBody, /Object\.keys\(pw\)\.length === 0\) \{\s*return;/);
    assert.match(mainBody, /console\.warn\(`\[TransitSummary\] Skipped — \$\{PORTWATCH_REDIS_KEY\} empty or absent/);
  });

  it('does not advance seed-meta on a failed canonical write', () => {
    const mainBody = transitSummarySrc.match(/export async function main\(\)\s*\{([\s\S]*?)\nif \(process\.argv/)?.[1] || '';
    assert.match(mainBody, /if \(!published\) \{[\s\S]*throw new Error\('transit-summaries canonical write failed'\)/);
    assert.match(mainBody, /await writeSeedMeta\(TRANSIT_SUMMARY_REDIS_KEY, pwCovered/);
  });

  it('runs on a 10-minute cadence with a TTL that clears the 30-min health gate', () => {
    // gcp/scheduler/main.ts CADENCES: seed-transit-summaries every 10 minutes.
    // TTL 3600 > maxStaleMin 30 * 60 (1800) strictly — seed-ttl-outlives-staleness-fleet.
    assert.match(transitSummarySrc, /const TRANSIT_SUMMARY_TTL = 3600/);
    const scheduler = readFileSync(resolve(root, 'gcp/scheduler/main.ts'), 'utf-8');
    assert.match(scheduler, /'seed-transit-summaries':\s*\{\s*kind:\s*'every',\s*rate:\s*'10 minutes'\s*\}/);
  });
});

describe('buildSummaryRow — the AIS × portwatch × corridor-risk merge', () => {
  it('passes the bridged AIS counts straight through when total > 0', () => {
    const row = buildSummaryRow('hormuz_strait', { history: [], wowChangePct: 3 }, { tanker: 4, cargo: 2, other: 1, total: 7 }, undefined);
    assert.equal(row.todayTotal, 7);
    assert.equal(row.todayTanker, 4);
    assert.equal(row.todayCargo, 2);
    assert.equal(row.todayOther, 1);
    assert.equal(row.wowChangePct, 3);
  });

  it('treats a zero-total AIS entry as no data (todayTotal 0)', () => {
    const row = buildSummaryRow('suez', { history: [] }, { tanker: 0, cargo: 0, other: 0, total: 0 }, undefined);
    assert.equal(row.todayTotal, 0);
  });

  it('zero-state fills every field when portwatch is missing this chokepoint', () => {
    const row = buildSummaryRow('panama', undefined, null, undefined);
    assert.equal(row.dataAvailable, false);
    assert.equal(row.todayTotal, 0);
    assert.equal(row.wowChangePct, 0);
    assert.equal(row.riskLevel, '');
    assert.deepEqual(row.anomaly, { dropPct: 0, signal: false });
  });

  it('dataAvailable is true whenever the portwatch entry exists, even with 0 traffic', () => {
    const row = buildSummaryRow('suez', { history: [] }, null, undefined);
    assert.equal(row.dataAvailable, true);
    assert.equal(row.todayTotal, 0);
  });

  it('maps corridor-risk fields (riskLevel / incidentCount7d / disruptionPct / summaries)', () => {
    const row = buildSummaryRow('bab_el_mandeb', { history: [] }, null, {
      riskLevel: 'critical', incidentCount7d: 9, disruptionPct: 40,
      riskSummary: 'Houthi attacks ongoing', riskReportAction: 'reroute',
    });
    assert.equal(row.riskLevel, 'critical');
    assert.equal(row.incidentCount7d, 9);
    assert.equal(row.disruptionPct, 40);
    assert.equal(row.riskSummary, 'Houthi attacks ongoing');
    assert.equal(row.riskReportAction, 'reroute');
  });

  it('runs detectTrafficAnomaly on the portwatch history for war_zone chokepoints', () => {
    const history = [...makeDays(7, 5, 0), ...makeDays(30, 100, 7)]; // ~95% drop
    const row = buildSummaryRow('hormuz_strait', { history }, null, undefined); // hormuz = war_zone
    assert.equal(row.anomaly.signal, true);
    assert.ok(row.anomaly.dropPct >= 90);
  });

  it('the compact row never inlines the history array (payload-split guard)', () => {
    const row = buildSummaryRow('suez', { history: makeDays(40, 10, 0) }, null, undefined);
    assert.equal('history' in row, false);
  });
});

describe('seed-transit-summaries.mjs id/name maps', () => {
  it('RELAY_NAME_TO_ID covers every canonical chokepoint', () => {
    const mapped = new Set(Object.values(SEED_RELAY_NAME_TO_ID).filter(Boolean));
    for (const cp of CANONICAL_CHOKEPOINTS) {
      assert.ok(mapped.has(cp.id), `RELAY_NAME_TO_ID missing canonical id ${cp.id}`);
    }
  });

  it('ID_TO_RELAY_NAME is the inverse of the non-null RELAY_NAME_TO_ID entries', () => {
    for (const [name, id] of Object.entries(SEED_RELAY_NAME_TO_ID)) {
      if (id == null) continue;
      assert.equal(SEED_ID_TO_RELAY_NAME[id], name);
    }
  });

  it('CHOKEPOINT_THREAT_LEVELS keys == the canonical id set', () => {
    assert.deepEqual(
      Object.keys(SEED_THREAT_LEVELS).sort(),
      CANONICAL_CHOKEPOINTS.map((c) => c.id).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. CORRIDOR_RISK_NAME_MAP and seedCorridorRisk — now scripts/seed-corridor-risk.mjs
// ---------------------------------------------------------------------------
describe('CORRIDOR_RISK_NAME_MAP (seed-corridor-risk)', () => {
  it('defines CORRIDOR_RISK_NAME_MAP array', () => {
    assert.match(corridorSrc, /const CORRIDOR_RISK_NAME_MAP\s*=\s*\[/);
  });

  it('maps hormuz to hormuz_strait', () => {
    assert.match(corridorSrc, /pattern:\s*'hormuz'.*id:\s*'hormuz_strait'/);
  });

  it('maps bab-el-mandeb to bab_el_mandeb', () => {
    assert.match(corridorSrc, /pattern:\s*'bab-el-mandeb'.*id:\s*'bab_el_mandeb'/);
  });

  it('maps red sea to bab_el_mandeb', () => {
    assert.match(corridorSrc, /pattern:\s*'red sea'.*id:\s*'bab_el_mandeb'/);
  });

  it('maps suez to suez', () => {
    assert.match(corridorSrc, /pattern:\s*'suez'.*id:\s*'suez'/);
  });

  it('maps south china sea to taiwan_strait', () => {
    assert.match(corridorSrc, /pattern:\s*'south china sea'.*id:\s*'taiwan_strait'/);
  });

  it('maps black sea to bosphorus', () => {
    assert.match(corridorSrc, /pattern:\s*'black sea'.*id:\s*'bosphorus'/);
  });

  it('has exactly 6 mapping entries', () => {
    const mapBlock = corridorSrc.match(/CORRIDOR_RISK_NAME_MAP\s*=\s*\[([\s\S]*?)\];/);
    assert.ok(mapBlock, 'CORRIDOR_RISK_NAME_MAP block not found');
    const patterns = [...mapBlock[1].matchAll(/pattern:\s*'/g)];
    assert.equal(patterns.length, 6);
  });
});

describe('seedCorridorRisk risk level derivation', () => {
  // Extract the risk-level derivation logic from the seed source to test boundaries
  const riskLevelLine = corridorSrc.match(/const riskLevel = score >= 70 \? 'critical' : score >= 50 \? 'high' : score >= 30 \? 'elevated' : 'normal'/);
  assert.ok(riskLevelLine, 'risk level derivation logic not found in scripts/seed-corridor-risk.mjs');

  // Re-implement for direct boundary testing
  function deriveRiskLevel(score) {
    return score >= 70 ? 'critical' : score >= 50 ? 'high' : score >= 30 ? 'elevated' : 'normal';
  }

  it('score >= 70 is critical', () => {
    assert.equal(deriveRiskLevel(70), 'critical');
    assert.equal(deriveRiskLevel(100), 'critical');
  });

  it('score 50-69 is high', () => {
    assert.equal(deriveRiskLevel(50), 'high');
    assert.equal(deriveRiskLevel(69), 'high');
  });

  it('score 30-49 is elevated', () => {
    assert.equal(deriveRiskLevel(30), 'elevated');
    assert.equal(deriveRiskLevel(49), 'elevated');
  });

  it('score < 30 is normal', () => {
    assert.equal(deriveRiskLevel(0), 'normal');
    assert.equal(deriveRiskLevel(29), 'normal');
  });

  it('boundary: score 69 is high (not critical)', () => {
    assert.equal(deriveRiskLevel(69), 'high');
  });

  it('boundary: score 49 is elevated (not high)', () => {
    assert.equal(deriveRiskLevel(49), 'elevated');
  });

  it('boundary: score 29 is normal (not elevated)', () => {
    assert.equal(deriveRiskLevel(29), 'normal');
  });
});

describe('seedCorridorRisk output fields', () => {
  it('writes riskLevel to result', () => {
    assert.match(corridorSrc, /riskLevel,/);
  });

  it('writes riskScore', () => {
    assert.match(corridorSrc, /riskScore:\s*score/);
  });

  it('writes incidentCount7d from incident_count_7d', () => {
    assert.match(corridorSrc, /incidentCount7d:\s*Number\(corridor\.incident_count_7d/);
  });

  it('writes disruptionPct from disruption_pct', () => {
    assert.match(corridorSrc, /disruptionPct:\s*Number\(corridor\.disruption_pct/);
  });

  it('writes eventCount7d from event_count_7d', () => {
    assert.match(corridorSrc, /eventCount7d:\s*Number\(corridor\.event_count_7d/);
  });

  it('writes vesselCount from vessel_count', () => {
    assert.match(corridorSrc, /vesselCount:\s*Number\(corridor\.vessel_count/);
  });

  it('truncates riskSummary to 200 chars', () => {
    assert.match(corridorSrc, /\.slice\(0,\s*200\)/);
  });

  it('returns the per-chokepoint keyed result for canonical publish', () => {
    // Pre-S63 the relay assigned `latestCorridorRiskData = result` here; that
    // in-process copy now lives only in ais-relay.cjs, hydrated from Redis by
    // TransitSummary. The standalone seed just returns the keyed object and
    // runSeed's contract path publishes it.
    assert.match(corridorSrc, /return result;/);
    assert.match(corridorSrc, /result\[mapping\.id\]\s*=\s*\{/);
  });

  it('writes to corridor risk Redis key', () => {
    assert.match(corridorSrc, /supply_chain:corridorrisk:v1/);
  });

  it('writes seed-meta for corridor risk (via runSeed domain/resource)', () => {
    assert.match(corridorSrc, /runSeed\('supply_chain',\s*'corridorrisk'/);
  });
});

// ---------------------------------------------------------------------------
// 3. Vercel handler consuming pre-built summaries
// ---------------------------------------------------------------------------
describe('get-chokepoint-status handler (source analysis)', () => {
  it('defines TRANSIT_SUMMARIES_KEY pointing to transit-summaries:v1', () => {
    assert.match(handlerSrc, /TRANSIT_SUMMARIES_KEY\s*=\s*'supply_chain:transit-summaries:v1'/);
  });

  it('reads transit summaries via getCachedJson', () => {
    assert.match(handlerSrc, /getCachedJson\(TRANSIT_SUMMARIES_KEY/);
  });

  it('does NOT import PortWatchData or CANONICAL_CHOKEPOINTS (fallback path removed)', () => {
    // Fallback against raw 500KB portwatch/corridorrisk keys was removed —
    // the compact transit-summaries key is authoritative; missing key now
    // surfaces as upstreamUnavailable=true rather than triggering a large
    // secondary read that times out at the 1.5s Redis budget.
    assert.doesNotMatch(handlerSrc, /import.*PortWatchData/);
    assert.doesNotMatch(handlerSrc, /import\s*\{\s*CANONICAL_CHOKEPOINTS\s*\}/);
  });

  it('does NOT import portwatchNameToId or corridorRiskNameToId', () => {
    assert.doesNotMatch(handlerSrc, /import.*portwatchNameToId/);
    assert.doesNotMatch(handlerSrc, /import.*corridorRiskNameToId/);
  });

  it('treats missing transit-summaries as upstreamUnavailable (silent-cache regression guard)', () => {
    // Regression guard for the silent zero-state cache bug: before this fix,
    // a null transit-summaries read produced 13 zero-state chokepoints that
    // were cached for 5 min (REDIS_CACHE_TTL). Now we mark upstreamUnavailable
    // so cachedFetchJson writes NEG_SENTINEL (120s) and retries on next poll.
    assert.match(handlerSrc, /transitSummariesMissing/);
    assert.match(handlerSrc, /const upstreamUnavailable\s*=\s*transitSummariesMissing/);
  });

  it('omits history from the transit summary response (lazy-loaded via GetChokepointHistory)', () => {
    // Main status response no longer carries 180-day history per chokepoint —
    // clients lazy-fetch via GetChokepointHistory on card expand. Field stays
    // declared for proto compat but is always empty in this RPC.
    assert.match(handlerSrc, /history:\s*\[\],\s*\n\s*riskLevel:\s*ts\.riskLevel/);
  });

  it('defines PreBuiltTransitSummary interface with all required fields', () => {
    assert.match(handlerSrc, /interface PreBuiltTransitSummary/);
    assert.match(handlerSrc, /todayTotal:\s*number/);
    assert.match(handlerSrc, /todayTanker:\s*number/);
    assert.match(handlerSrc, /todayCargo:\s*number/);
    assert.match(handlerSrc, /todayOther:\s*number/);
    assert.match(handlerSrc, /wowChangePct:\s*number/);
    assert.match(handlerSrc, /riskLevel:\s*string/);
    assert.match(handlerSrc, /incidentCount7d:\s*number/);
    assert.match(handlerSrc, /disruptionPct:\s*number/);
    assert.match(handlerSrc, /anomaly:\s*\{\s*dropPct:\s*number;\s*signal:\s*boolean\s*\}/);
  });

  it('defines TransitSummariesPayload with summaries record and fetchedAt', () => {
    assert.match(handlerSrc, /interface TransitSummariesPayload/);
    assert.match(handlerSrc, /summaries:\s*Record<string,\s*PreBuiltTransitSummary>/);
    assert.match(handlerSrc, /fetchedAt:\s*number/);
  });

  it('maps transit summary data into ChokepointInfo.transitSummary', () => {
    assert.match(handlerSrc, /transitSummary:\s*ts\s*\?/);
  });

  it('provides zero-value fallback when no transit summary exists', () => {
    assert.match(handlerSrc, /todayTotal:\s*0,\s*todayTanker:\s*0/);
  });

  it('uses anomaly.signal for bonus scoring', () => {
    assert.match(handlerSrc, /anomalyBonus\s*=\s*anomaly\.signal\s*\?\s*10\s*:\s*0/);
  });

  it('includes anomaly drop description when signal is true', () => {
    assert.match(handlerSrc, /Traffic down.*dropPct.*baseline/);
  });
});

// ---------------------------------------------------------------------------
// 4. CORRIDOR_RISK_NAME_MAP alignment with _chokepoint-ids
// ---------------------------------------------------------------------------
describe('corridor risk name map alignment with canonical IDs', () => {
  const mapBlock = corridorSrc.match(/CORRIDOR_RISK_NAME_MAP\s*=\s*\[([\s\S]*?)\];/);
  const entries = [...mapBlock[1].matchAll(/\{\s*pattern:\s*'([^']+)',\s*id:\s*'([^']+)'\s*\}/g)];

  it('all mapped IDs are valid canonical chokepoint IDs', () => {
    const canonicalIds = new Set(CANONICAL_CHOKEPOINTS.map(c => c.id));
    for (const [, , id] of entries) {
      assert.ok(canonicalIds.has(id), `${id} is not a canonical chokepoint ID`);
    }
  });

  it('corridorRiskNameToId covers chokepoints with non-null corridorRiskName', () => {
    const withCr = CANONICAL_CHOKEPOINTS.filter(c => c.corridorRiskName !== null);
    for (const cp of withCr) {
      assert.equal(corridorRiskNameToId(cp.corridorRiskName), cp.id,
        `corridorRiskNameToId('${cp.corridorRiskName}') should return '${cp.id}'`);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. seed-transit-summaries.mjs's detectTrafficAnomaly stays in sync with
//    server/.../_scoring.mjs (the CJS→ESM duplicate the loop carried moved
//    with it out of ais-relay.cjs).
// ---------------------------------------------------------------------------
describe('detectTrafficAnomaly (seed-transit-summaries) sync with _scoring.mjs', () => {
  const relayFn = seedDetectTrafficAnomaly;

  it('matches _scoring.mjs for war_zone with large drop', () => {
    const history = [...makeDays(7, 5, 0), ...makeDays(30, 100, 7)];
    const scoringResult = detectTrafficAnomaly(history, 'war_zone');
    const relayResult = relayFn(history, 'war_zone');
    assert.deepEqual(relayResult, scoringResult);
  });

  it('matches _scoring.mjs for normal threat level', () => {
    const history = [...makeDays(7, 5, 0), ...makeDays(30, 100, 7)];
    const scoringResult = detectTrafficAnomaly(history, 'normal');
    const relayResult = relayFn(history, 'normal');
    assert.deepEqual(relayResult, scoringResult);
  });

  it('matches _scoring.mjs for insufficient history', () => {
    const history = makeDays(20, 100, 0);
    const scoringResult = detectTrafficAnomaly(history, 'war_zone');
    const relayResult = relayFn(history, 'war_zone');
    assert.deepEqual(relayResult, scoringResult);
  });

  it('matches _scoring.mjs for low baseline', () => {
    const history = [...makeDays(7, 0, 0), ...makeDays(30, 1, 7)];
    const scoringResult = detectTrafficAnomaly(history, 'war_zone');
    const relayResult = relayFn(history, 'war_zone');
    assert.deepEqual(relayResult, scoringResult);
  });

  it('matches _scoring.mjs for critical threat level', () => {
    const history = [...makeDays(7, 10, 0), ...makeDays(30, 100, 7)];
    const scoringResult = detectTrafficAnomaly(history, 'critical');
    const relayResult = relayFn(history, 'critical');
    assert.deepEqual(relayResult, scoringResult);
  });
});

// ---------------------------------------------------------------------------
// 6. detectTrafficAnomaly (_scoring.mjs) edge cases
// ---------------------------------------------------------------------------
describe('detectTrafficAnomaly edge cases (_scoring.mjs)', () => {
  it('null history returns no signal', () => {
    const result = detectTrafficAnomaly(null, 'war_zone');
    assert.deepEqual(result, { dropPct: 0, signal: false });
  });

  it('empty array returns no signal', () => {
    const result = detectTrafficAnomaly([], 'war_zone');
    assert.deepEqual(result, { dropPct: 0, signal: false });
  });

  it('exactly 37 days is sufficient', () => {
    const history = [...makeDays(7, 5, 0), ...makeDays(30, 100, 7)];
    assert.equal(history.length, 37);
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.ok(result.signal, 'should detect anomaly with exactly 37 days');
    assert.ok(result.dropPct >= 90);
  });

  it('36 days is insufficient', () => {
    const history = [...makeDays(7, 5, 0), ...makeDays(29, 100, 7)];
    assert.equal(history.length, 36);
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.equal(result.signal, false);
    assert.equal(result.dropPct, 0);
  });

  it('equal traffic recent vs baseline yields dropPct 0, no signal', () => {
    const history = [...makeDays(7, 100, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.equal(result.dropPct, 0);
    assert.equal(result.signal, false);
  });

  it('increased traffic yields negative dropPct, no signal', () => {
    const history = [...makeDays(7, 200, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.ok(result.dropPct < 0, `expected negative dropPct, got ${result.dropPct}`);
    assert.equal(result.signal, false);
  });

  it('exactly 50% drop in war_zone triggers signal', () => {
    const history = [...makeDays(7, 50, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.equal(result.dropPct, 50);
    assert.equal(result.signal, true);
  });

  it('49% drop in war_zone does NOT trigger signal', () => {
    const history = [...makeDays(7, 51, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.ok(result.dropPct < 50);
    assert.equal(result.signal, false);
  });

  it('elevated threat level does not trigger signal even with large drop', () => {
    const history = [...makeDays(7, 5, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'elevated');
    assert.equal(result.signal, false);
    assert.ok(result.dropPct >= 90);
  });

  it('high threat level does not trigger signal even with large drop', () => {
    const history = [...makeDays(7, 5, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'high');
    assert.equal(result.signal, false);
  });

  it('unsorted history is handled correctly (sorted internally)', () => {
    const history = [...makeDays(30, 100, 7), ...makeDays(7, 5, 0)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.ok(result.signal);
    assert.ok(result.dropPct >= 90);
  });

  it('baseline < 2 vessels/day avg (< 14 total over 7 days) returns no signal', () => {
    // baseline30 of 1/day -> baselineAvg7 = (30*1/30)*7 = 7 < 14
    const history = [...makeDays(7, 0, 0), ...makeDays(30, 1, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.equal(result.signal, false);
    assert.equal(result.dropPct, 0);
  });

  it('baseline of exactly 2 vessels/day (14/week) is accepted', () => {
    const history = [...makeDays(7, 0, 0), ...makeDays(30, 2, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.ok(result.dropPct > 0, 'should compute dropPct when baseline is 14/week');
  });
});

// ---------------------------------------------------------------------------
// 7. CHOKEPOINT_THREAT_LEVELS sync between relay and handler
// ---------------------------------------------------------------------------
describe('CHOKEPOINT_THREAT_LEVELS seeder-handler sync', () => {
  // CHOKEPOINT_THREAT_LEVELS moved from ais-relay.cjs to
  // scripts/seed-transit-summaries.mjs with the TransitSummary merge (P14
  // Phase 2 tail). Assert against the seeder's exported map now.
  it('seeder defines threat levels for all 13 canonical chokepoints', () => {
    for (const cp of CANONICAL_CHOKEPOINTS) {
      assert.ok(cp.id in SEED_THREAT_LEVELS, `Missing threat level for ${cp.id} in seed-transit-summaries.mjs`);
    }
  });

  it('seeder threat levels match the handler CHOKEPOINTS config', () => {
    for (const cp of CANONICAL_CHOKEPOINTS) {
      const seedLevel = SEED_THREAT_LEVELS[cp.id];
      const handlerMatch = handlerSrc.match(new RegExp(`id:\\s*'${cp.id}'[^}]*threatLevel:\\s*'(\\w+)'`));
      if (seedLevel && handlerMatch) {
        assert.equal(seedLevel, handlerMatch[1],
          `Threat level mismatch for ${cp.id}: seeder=${seedLevel} handler=${handlerMatch[1]}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Handler reads ONLY the compact transit-summaries key (no fallback)
// ---------------------------------------------------------------------------
describe('handler transit data strategy', () => {
  it('reads TRANSIT_SUMMARIES_KEY as the only transit source', () => {
    assert.match(handlerSrc, /TRANSIT_SUMMARIES_KEY/);
  });

  it('does NOT reference removed fallback keys (portwatch / corridorrisk / chokepoint_transits)', () => {
    // Previously each of these was a ~500KB secondary read that stacked on
    // top of the 1.5s Redis read budget and timed out. Removed in payload-split PR.
    assert.doesNotMatch(handlerSrc, /PORTWATCH_FALLBACK_KEY/);
    assert.doesNotMatch(handlerSrc, /CORRIDORRISK_FALLBACK_KEY/);
    assert.doesNotMatch(handlerSrc, /TRANSIT_COUNTS_FALLBACK_KEY/);
    assert.doesNotMatch(handlerSrc, /buildFallbackSummaries/);
  });

  it('does NOT call getPortWatchTransits or fetchCorridorRisk (no upstream fetch)', () => {
    assert.doesNotMatch(handlerSrc, /getPortWatchTransits/);
    assert.doesNotMatch(handlerSrc, /fetchCorridorRisk/);
  });
});

describe('seed-transit-summaries.mjs Redis reads', () => {
  it('reads portwatch first, before the early-return guard', () => {
    const mainBody = transitSummarySrc.match(/export async function main\(\)\s*\{([\s\S]*?)\nif \(process\.argv/)?.[1] || '';
    const readPos = mainBody.indexOf('readCanonicalValue(PORTWATCH_REDIS_KEY)');
    const earlyReturnPos = mainBody.indexOf('Object.keys(pw).length === 0');
    assert.ok(readPos > 0, 'portwatch read not found in main()');
    assert.ok(earlyReturnPos > 0, 'portwatch early-return guard not found');
    assert.ok(readPos < earlyReturnPos, 'portwatch read must come before the early return');
  });

  it('reads all three inputs through the shared envelope-aware reader (readCanonicalValue), never a raw GET', () => {
    // Regression guard: PR #3097 migrated producers to {_seed, data}. A raw GET
    // iterates those wrapper keys as chokepoint IDs and silently zeroes the
    // transit chart. readCanonicalValue unwraps.
    assert.match(transitSummarySrc, /readCanonicalValue\(PORTWATCH_REDIS_KEY\)/);
    assert.match(transitSummarySrc, /readCanonicalValue\(CORRIDOR_RISK_REDIS_KEY\)/);
    assert.match(transitSummarySrc, /readCanonicalValue\(CHOKEPOINT_TRANSIT_KEY\)/);
    assert.doesNotMatch(transitSummarySrc, /upstashGet\(/);
  });

  it('has no in-process cache guard — every run re-reads portwatch and corridor-risk fresh', () => {
    // The relay loop cached corridor-risk in a module `latestCorridorRiskData`
    // and only re-read on null. A --once cron has no cross-tick memory, so the
    // guard is gone.
    assert.doesNotMatch(transitSummarySrc, /latestCorridorRiskData/);
    assert.doesNotMatch(transitSummarySrc, /if \(!latest/);
  });
});

describe('ais-relay.cjs OREF Redis reads (still relay-local)', () => {
  it('OREF bootstrap reads OREF_REDIS_KEY via envelopeRead (parity with orefPersistHistory)', () => {
    // Regression guard (Greptile review PR #3139): orefPersistHistory() writes via
    // envelopeWrite. Reading raw left cached.history undefined, so OREF history
    // was never restored across relay restarts — every cold start hit the
    // upstream API unnecessarily. Oref stayed in ais-relay.cjs (P14 Phase 2 tail).
    assert.match(relaySrc, /const cached = await envelopeRead\(OREF_REDIS_KEY\)/);
    assert.doesNotMatch(relaySrc, /const cached = await upstashGet\(OREF_REDIS_KEY\)/);
  });
});

// ---------------------------------------------------------------------------
// envelopeRead helper — runtime behavior (regression guard for PR #3097 drift)
// ---------------------------------------------------------------------------
describe('envelopeRead helper', () => {
  // Extract and eval the helper — it is pure aside from upstashGet, which we stub.
  const helperSrc = relaySrc.match(/async function envelopeRead\([\s\S]*?\n\}/)?.[0];

  it('is defined in ais-relay.cjs next to envelopeWrite', () => {
    assert.ok(helperSrc, 'envelopeRead not found in ais-relay.cjs');
  });

  function buildEnvelopeRead(stub) {
    // eslint-disable-next-line no-new-func
    return new Function('upstashGet', `${helperSrc}\nreturn envelopeRead;`)(stub);
  }

  it('unwraps contract-mode envelope {_seed, data} -> data', async () => {
    const stub = async () => ({ _seed: { fetchedAt: 1 }, data: { hormuz_strait: { history: [1, 2, 3] } } });
    const read = buildEnvelopeRead(stub);
    const out = await read('supply_chain:portwatch:v1');
    assert.deepEqual(out, { hormuz_strait: { history: [1, 2, 3] } });
  });

  it('passes legacy raw shape through unchanged', async () => {
    const stub = async () => ({ hormuz_strait: { history: [1] }, suez: { history: [] } });
    const read = buildEnvelopeRead(stub);
    const out = await read('legacy:key');
    assert.deepEqual(out, { hormuz_strait: { history: [1] }, suez: { history: [] } });
  });

  it('returns null when Redis returns null', async () => {
    const stub = async () => null;
    const read = buildEnvelopeRead(stub);
    assert.equal(await read('missing:key'), null);
  });

  it('does NOT unwrap arrays that happen to have _seed/data indices', async () => {
    const stub = async () => [1, 2, 3];
    const read = buildEnvelopeRead(stub);
    assert.deepEqual(await read('array:key'), [1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Upstash Redis client selection — runtime behavior for the insecure-http
// opt-in (regression guard for the incident where the https-only gate
// silently no-oped every seed loop against http://redis-rest:80 for 4+ days).
// UPSTASH_ALLOW_INSECURE_HTTP + UPSTASH_HTTP_MODULE decide both whether
// Redis writes are enabled at all and which Node client (http vs https)
// upstashGet/Set/etc. use. The source-scan tests above only assert the
// scheduler shape; these actually eval the init block + upstashGet in a
// sandbox with mocked http/https clients (no network, no real Upstash) so a
// future edit that regresses the opt-in gate fails a test, not silence.
// ---------------------------------------------------------------------------
describe('Upstash Redis client selection (insecure-http opt-in)', () => {
  // The relay can't be require()'d directly in a test — it process.exit(1)s
  // without AISSTREAM_API_KEY and otherwise boots a live server on import.
  // Slice the init block (UPSTASH_REDIS_REST_URL ... end of upstashGet)
  // straight out of the relay source and eval it in a sandbox instead.
  const initStart = relaySrc.indexOf("const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || '';");
  const initEnd = relaySrc.indexOf('function upstashSet(key, value, ttlSeconds) {');
  assert.ok(initStart > 0 && initEnd > initStart, 'Upstash init block (through upstashGet) not found');
  const initAndGetSrc = relaySrc.slice(initStart, initEnd);

  function makeMockClient(name) {
    return {
      name,
      requestCalls: [],
      request(url, opts) {
        this.requestCalls.push({ url, opts });
        // No response callback is ever invoked — these tests only assert
        // which client received the call, so the resulting (intentionally
        // never-settling) promise must not be awaited.
        return { on() {}, end() {} };
      },
    };
  }

  function buildUpstashInit(env, httpClient, httpsClient) {
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      'process', 'http', 'https',
      `${initAndGetSrc}\nreturn { UPSTASH_ALLOW_INSECURE_HTTP, UPSTASH_ENABLED, UPSTASH_HTTP_MODULE, upstashGet };`,
    );
    return fn({ env }, httpClient, httpsClient);
  }

  it('https:// URL enables Upstash and routes upstashGet through the https client', () => {
    const httpClient = makeMockClient('http');
    const httpsClient = makeMockClient('https');
    const { UPSTASH_ENABLED, UPSTASH_HTTP_MODULE, upstashGet } = buildUpstashInit(
      { UPSTASH_REDIS_REST_URL: 'https://real-upstash.io', UPSTASH_REDIS_REST_TOKEN: 'tok' },
      httpClient, httpsClient,
    );
    assert.equal(UPSTASH_ENABLED, true);
    assert.equal(UPSTASH_HTTP_MODULE, httpsClient);
    upstashGet('some:key');
    assert.equal(httpsClient.requestCalls.length, 1);
    assert.equal(httpClient.requestCalls.length, 0);
  });

  it('http:// URL WITHOUT UPSTASH_ALLOW_INSECURE_HTTP disables Upstash entirely (never calls Redis) — the regressed state that silently disabled every seed loop for 4+ days', async () => {
    const httpClient = makeMockClient('http');
    const httpsClient = makeMockClient('https');
    const { UPSTASH_ALLOW_INSECURE_HTTP, UPSTASH_ENABLED, upstashGet } = buildUpstashInit(
      { UPSTASH_REDIS_REST_URL: 'http://redis-rest:80', UPSTASH_REDIS_REST_TOKEN: 'tok' },
      httpClient, httpsClient,
    );
    assert.equal(UPSTASH_ALLOW_INSECURE_HTTP, false);
    assert.equal(UPSTASH_ENABLED, false);
    // Resolves null synchronously via the !UPSTASH_ENABLED guard — safe to
    // await, and proves no request is ever attempted on either client.
    assert.equal(await upstashGet('some:key'), null);
    assert.equal(httpClient.requestCalls.length, 0);
    assert.equal(httpsClient.requestCalls.length, 0);
  });

  it('http:// URL WITH UPSTASH_ALLOW_INSECURE_HTTP=true enables Upstash and routes upstashGet through the http client (the scheduler fix)', () => {
    const httpClient = makeMockClient('http');
    const httpsClient = makeMockClient('https');
    const { UPSTASH_ALLOW_INSECURE_HTTP, UPSTASH_ENABLED, UPSTASH_HTTP_MODULE, upstashGet } = buildUpstashInit(
      { UPSTASH_REDIS_REST_URL: 'http://redis-rest:80', UPSTASH_REDIS_REST_TOKEN: 'tok', UPSTASH_ALLOW_INSECURE_HTTP: 'true' },
      httpClient, httpsClient,
    );
    assert.equal(UPSTASH_ALLOW_INSECURE_HTTP, true);
    assert.equal(UPSTASH_ENABLED, true);
    assert.equal(UPSTASH_HTTP_MODULE, httpClient);
    upstashGet('some:key');
    assert.equal(httpClient.requestCalls.length, 1);
    assert.equal(httpsClient.requestCalls.length, 0);
  });

  it('UPSTASH_ALLOW_INSECURE_HTTP is a strict "true" match — "TRUE"/"1" do not opt in', () => {
    const httpClient = makeMockClient('http');
    const httpsClient = makeMockClient('https');
    const { UPSTASH_ALLOW_INSECURE_HTTP, UPSTASH_ENABLED } = buildUpstashInit(
      { UPSTASH_REDIS_REST_URL: 'http://redis-rest:80', UPSTASH_REDIS_REST_TOKEN: 'tok', UPSTASH_ALLOW_INSECURE_HTTP: 'TRUE' },
      httpClient, httpsClient,
    );
    assert.equal(UPSTASH_ALLOW_INSECURE_HTTP, false);
    assert.equal(UPSTASH_ENABLED, false);
  });

  it('missing UPSTASH_REDIS_REST_TOKEN disables Upstash even over https', () => {
    const httpClient = makeMockClient('http');
    const httpsClient = makeMockClient('https');
    const { UPSTASH_ENABLED } = buildUpstashInit(
      { UPSTASH_REDIS_REST_URL: 'https://real-upstash.io' },
      httpClient, httpsClient,
    );
    assert.equal(UPSTASH_ENABLED, false);
  });
});
