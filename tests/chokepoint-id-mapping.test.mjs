import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_CHOKEPOINTS,
  relayNameToId,
  portwatchNameToId,
  corridorRiskNameToId,
} from '../server/worldmonitor/supply-chain/v1/_chokepoint-ids.ts';

describe('CANONICAL_CHOKEPOINTS registry', () => {
  it('contains exactly 13 canonical chokepoints', () => {
    assert.equal(CANONICAL_CHOKEPOINTS.length, 13);
  });

  it('has no duplicate IDs', () => {
    const ids = CANONICAL_CHOKEPOINTS.map(c => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('has no duplicate relay names', () => {
    const names = CANONICAL_CHOKEPOINTS.map(c => c.relayName);
    assert.equal(new Set(names).size, names.length);
  });

  it('has no duplicate portwatch names (excluding empty)', () => {
    const names = CANONICAL_CHOKEPOINTS.map(c => c.portwatchName).filter(n => n);
    assert.equal(new Set(names).size, names.length);
  });

  it('Bosphorus has relayName "Bosporus Strait"', () => {
    const bos = CANONICAL_CHOKEPOINTS.find(c => c.id === 'bosphorus');
    assert.equal(bos.relayName, 'Bosporus Strait');
  });
});

describe('relayNameToId', () => {
  it('maps "Strait of Hormuz" to hormuz_strait', () => {
    assert.equal(relayNameToId('Strait of Hormuz'), 'hormuz_strait');
  });

  it('returns undefined for unknown relay name', () => {
    assert.equal(relayNameToId('unknown'), undefined);
  });
});

describe('portwatchNameToId', () => {
  it('maps "Suez Canal" to suez', () => {
    assert.equal(portwatchNameToId('Suez Canal'), 'suez');
  });

  it('maps actual PortWatch feed names correctly', () => {
    assert.equal(portwatchNameToId('Malacca Strait'), 'malacca_strait');
    assert.equal(portwatchNameToId('Bab el-Mandeb Strait'), 'bab_el_mandeb');
    assert.equal(portwatchNameToId('Gibraltar Strait'), 'gibraltar');
    assert.equal(portwatchNameToId('Bosporus Strait'), 'bosphorus');
    assert.equal(portwatchNameToId('Korea Strait'), 'korea_strait');
    assert.equal(portwatchNameToId('Dover Strait'), 'dover_strait');
    assert.equal(portwatchNameToId('Kerch Strait'), 'kerch_strait');
    assert.equal(portwatchNameToId('Lombok Strait'), 'lombok_strait');
  });

  it('returns undefined for empty string', () => {
    assert.equal(portwatchNameToId(''), undefined);
  });

  it('is case-insensitive', () => {
    assert.equal(portwatchNameToId('suez canal'), 'suez');
    assert.equal(portwatchNameToId('MALACCA STRAIT'), 'malacca_strait');
  });
});

import { readFileSync } from 'node:fs';
// CHOKEPOINT_THREAT_LEVELS + RELAY_NAME_TO_ID moved from ais-relay.cjs to
// scripts/seed-transit-summaries.mjs with the TransitSummary merge
// (P14 Phase 2 tail, session 67 — supersedes P16 for the summary half).
const handlerSrc = readFileSync('server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts', 'utf8');
const { CHOKEPOINT_THREAT_LEVELS: SEED_THREAT_LEVELS, RELAY_NAME_TO_ID: SEED_RELAY_NAME_TO_ID } =
  await import('../scripts/seed-transit-summaries.mjs');

describe('seed-transit-summaries CHOKEPOINT_THREAT_LEVELS sync', () => {

  it('has a threat level entry for every canonical chokepoint', () => {
    for (const cp of CANONICAL_CHOKEPOINTS) {
      assert.ok(cp.id in SEED_THREAT_LEVELS, `Missing threat level for ${cp.id}`);
    }
  });

  it('threat levels match the handler CHOKEPOINTS config', () => {
    for (const cp of CANONICAL_CHOKEPOINTS) {
      const seedLevel = SEED_THREAT_LEVELS[cp.id];
      const handlerMatch = handlerSrc.match(new RegExp(`id:\\s*'${cp.id}'[^}]*threatLevel:\\s*'(\\w+)'`));
      if (seedLevel && handlerMatch) {
        assert.equal(seedLevel, handlerMatch[1], `Threat level mismatch for ${cp.id}: seeder=${seedLevel} handler=${handlerMatch[1]}`);
      }
    }
  });

  it('RELAY_NAME_TO_ID covers all canonical chokepoints', () => {
    for (const cp of CANONICAL_CHOKEPOINTS) {
      assert.equal(SEED_RELAY_NAME_TO_ID[cp.relayName], cp.id, `Missing name mapping for ${cp.relayName} -> ${cp.id}`);
    }
  });
});

describe('corridorRiskNameToId', () => {
  it('maps "Hormuz" to hormuz_strait', () => {
    assert.equal(corridorRiskNameToId('Hormuz'), 'hormuz_strait');
  });

  it('returns undefined for unmapped names', () => {
    assert.equal(corridorRiskNameToId('Nonexistent'), undefined);
  });

  it('Gibraltar has null corridorRiskName', () => {
    const gib = CANONICAL_CHOKEPOINTS.find(c => c.id === 'gibraltar');
    assert.equal(gib.corridorRiskName, null);
  });

  it('Bosphorus has null corridorRiskName', () => {
    const bos = CANONICAL_CHOKEPOINTS.find(c => c.id === 'bosphorus');
    assert.equal(bos.corridorRiskName, null);
  });
});
