import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const src = readFileSync(resolve(root, 'server/worldmonitor/supply-chain/v1/_corridorrisk-upstream.ts'), 'utf-8');
// The corridor-risk fetch loop was extracted from ais-relay.cjs to this
// standalone cron in P14 Phase 2 (session 63 — see PLATFORM_ARCHITECTURE.md).
const corridorSrc = readFileSync(resolve(root, 'scripts/seed-corridor-risk.mjs'), 'utf-8');

describe('CorridorRisk type exports', () => {
  it('exports CorridorRiskEntry interface', () => {
    assert.match(src, /export\s+interface\s+CorridorRiskEntry/);
  });

  it('exports CorridorRiskData interface', () => {
    assert.match(src, /export\s+interface\s+CorridorRiskData/);
  });

  it('does not contain fetch logic (moved to relay)', () => {
    assert.doesNotMatch(src, /cachedFetchJson/);
    assert.doesNotMatch(src, /getCorridorRiskData/);
    assert.doesNotMatch(src, /fetchCorridorRiskData/);
  });
});

describe('CorridorRisk seed cron (scripts/seed-corridor-risk.mjs)', () => {
  it('uses corridorrisk.io open beta API (no auth required)', () => {
    assert.match(corridorSrc, /corridorrisk\.io\/api\/corridors/);
  });

  it('does not require API key (open beta)', () => {
    assert.doesNotMatch(corridorSrc, /CORRIDOR_RISK_API_KEY/);
  });

  it('writes to supply_chain:corridorrisk:v1 Redis key', () => {
    assert.match(corridorSrc, /supply_chain:corridorrisk:v1/);
  });

  it('writes seed-meta for corridorrisk (via runSeed domain/resource)', () => {
    assert.match(corridorSrc, /runSeed\('supply_chain',\s*'corridorrisk'/);
  });

  it('runs on the runSeed contract (declareRecords + afterPublish notifications)', () => {
    assert.match(corridorSrc, /declareRecords/);
    assert.match(corridorSrc, /afterPublish:\s*dispatchCorridorRiskNotifications/);
  });

  it('uses 15s timeout', () => {
    assert.match(corridorSrc, /AbortSignal\.timeout\(15000\)/);
  });

  it('logs only status code on HTTP error', () => {
    assert.match(corridorSrc, /\[CorridorRisk\] HTTP \$\{resp\.status\}/);
  });

  it('derives riskLevel from score (not from API field)', () => {
    assert.match(corridorSrc, /score >= 70.*critical/);
    assert.match(corridorSrc, /score >= 50.*high/);
    assert.match(corridorSrc, /score >= 30.*elevated/);
  });

  it('stores riskSummary truncated to 200 chars', () => {
    assert.match(corridorSrc, /risk_summary.*\.slice\(0,\s*200\)/);
  });

  it('stores riskReportAction truncated to 500 chars', () => {
    assert.match(corridorSrc, /risk_report\?\.action.*\.slice\(0,\s*500\)/);
  });

  it('publishes a corridor_risk notification for scores >= 50', () => {
    assert.match(corridorSrc, /if \(c\.riskScore < 50\) continue/);
    assert.match(corridorSrc, /eventType:\s*'corridor_risk'/);
  });
});
