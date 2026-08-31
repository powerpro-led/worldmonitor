/**
 * Regression test for the HAPI per-country shared-breaker anti-pattern (PR #879),
 * caught in the same audit pass as the World Bank breaker bug (PR #877):
 *
 *   hapiBreaker — single shared breaker used in a Promise.allSettled loop over
 *   20 countries. 2 failures in any country tripped the breaker for ALL countries,
 *   and the last country's result overwrote the cache for every other country.
 *   Fix: getHapiBreaker(iso2) Map — one breaker per ISO2 country code.
 *
 * This file used to also cover a second instance of the same anti-pattern —
 * gdeltBreaker shared between fetchGdeltArticles and fetchPositiveGdeltArticles —
 * but the entire src/services/gdelt-intel.ts module (GdeltIntelPanel/"实时情报",
 * MapPopup hotspot context, AND the Good News Explorer positive-topic path) was
 * removed 2026-08-31: redundant with the RSS-backed Intel Feed panel, GDELT's
 * DOC API blocked/rate-limited across sessions 35-37 and again that session, and
 * the positive-topic path had never actually worked (queried unseeded topics).
 * No GDELT breaker remains to isolate against — see TASKS.md's FORTIETH-session
 * HANDOFF for the removal record.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const readSrc = (relPath) => readFileSync(resolve(root, relPath), 'utf-8');

// ============================================================
// 1. Static analysis: conflict/index.ts — per-country HAPI breakers
// ============================================================

describe('conflict/index.ts — per-country HAPI circuit breakers', () => {
  const src = readSrc('src/services/conflict/index.ts');

  // Scoped slices to avoid false positives from comments or unrelated code
  const breakerSection = src.slice(src.indexOf('hapiBreakers'), src.indexOf('hapiBreakers') + 400);
  const fnStart = src.indexOf('export async function fetchHapiSummary');
  assert.ok(fnStart !== -1, 'fetchHapiSummary not found in conflict/index.ts — was it renamed?');
  const fnBody = src.slice(fnStart, src.indexOf('\nexport ', fnStart + 1));

  it('does NOT have a single shared hapiBreaker', () => {
    assert.doesNotMatch(
      src,
      /\bconst\s+hapiBreaker\s*=/,
      'Single shared hapiBreaker must not exist — use getHapiBreaker(iso2) instead',
    );
  });

  it('has a hapiBreakers Map for per-country instances', () => {
    assert.match(
      breakerSection,
      /new\s+Map/,
      'hapiBreakers Map must exist to store per-country circuit breakers',
    );
  });

  it('has a getHapiBreaker(iso2) factory function', () => {
    assert.match(
      src,
      /function\s+getHapiBreaker\s*\(\s*iso2/,
      'getHapiBreaker(iso2) factory function must exist',
    );
  });

  it('fetchHapiSummary calls getHapiBreaker(iso2).execute not a shared breaker', () => {
    assert.match(
      fnBody,
      /getHapiBreaker\s*\(\s*iso2\s*\)\s*\.execute/,
      'fetchHapiSummary must use getHapiBreaker(iso2).execute, not a shared hapiBreaker',
    );
  });

  it('per-country breaker names embed iso2', () => {
    assert.match(
      breakerSection,
      /name\s*:\s*`HDX HAPI:\$\{iso2\}`/,
      'Breaker name must embed iso2 (e.g. "HDX HAPI:US") for unique IndexedDB persistence per country',
    );
  });
});

// ============================================================
// 2. Behavioral: circuit breaker isolation
// ============================================================

describe('CircuitBreaker isolation — HAPI per-country independence', () => {
  const CIRCUIT_BREAKER_URL = pathToFileURL(
    resolve(root, 'src/utils/circuit-breaker.ts'),
  ).href;

  it('HAPI: failure in one country does not trip another', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const breakerUS = createCircuitBreaker({ name: 'HDX HAPI:US', cacheTtlMs: 30 * 60 * 1000 });
      const breakerRU = createCircuitBreaker({ name: 'HDX HAPI:RU', cacheTtlMs: 30 * 60 * 1000 });

      const fallback = { summary: null };
      const alwaysFail = () => { throw new Error('HDX HAPI unavailable'); };

      // Force breakerUS into cooldown (2 failures = maxFailures)
      await breakerUS.execute(alwaysFail, fallback); // failure 1
      await breakerUS.execute(alwaysFail, fallback); // failure 2 → cooldown
      assert.equal(breakerUS.isOnCooldown(), true, 'breakerUS should be on cooldown after 2 failures');

      // breakerRU must NOT be affected
      assert.equal(breakerRU.isOnCooldown(), false, 'breakerRU must not be on cooldown when breakerUS fails');

      // breakerRU should still call through successfully
      const goodData = { summary: { countryCode: 'RU', conflictEvents: 12, displacedPersons: 5000 } };
      const result = await breakerRU.execute(async () => goodData, fallback);
      assert.deepEqual(result, goodData, 'breakerRU should return live data unaffected by breakerUS cooldown');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('HAPI: different countries cache independently (no cross-country poisoning)', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const breakerUS = createCircuitBreaker({ name: 'HDX HAPI:US', cacheTtlMs: 30 * 60 * 1000 });
      const breakerRU = createCircuitBreaker({ name: 'HDX HAPI:RU', cacheTtlMs: 30 * 60 * 1000 });

      const fallback = { summary: null };
      const usData = { summary: { countryCode: 'US', conflictEvents: 3, displacedPersons: 100 } };
      const ruData = { summary: { countryCode: 'RU', conflictEvents: 47, displacedPersons: 120000 } };

      // Populate both caches with different data
      await breakerUS.execute(async () => usData, fallback);
      await breakerRU.execute(async () => ruData, fallback);

      // Each must return its own cached value; pass a fallback fn that would return wrong data
      const cachedUS = await breakerUS.execute(async () => fallback, fallback);
      const cachedRU = await breakerRU.execute(async () => fallback, fallback);

      assert.equal(cachedUS.summary?.countryCode, 'US',
        'breakerUS cache must return US data, not RU data');
      assert.equal(cachedRU.summary?.countryCode, 'RU',
        'breakerRU cache must return RU data, not US data');
      assert.notEqual(cachedUS.summary?.conflictEvents, cachedRU.summary?.conflictEvents,
        'Cached conflict event counts must be independent per country');
    } finally {
      clearAllCircuitBreakers();
    }
  });
});
