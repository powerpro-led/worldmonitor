/**
 * Source contract for country-scope forwarding through the notification
 * channels API layer.
 *
 * Stage 3 of the Convex/Clerk -> Supabase migration collapsed the old
 * two-layer contract (api/notification-channels.ts -> Convex relay ->
 * convex/http.ts -> convex/alertRules.ts internal mutations) into one layer:
 * api/notification-channels.ts calls server/_shared/alert-rules.ts directly.
 * AlertRulesError (COUNTRIES_LIMIT_EXCEEDED / TICKERS_LIMIT_EXCEEDED /
 * INCOMPATIBLE_DELIVERY) is caught by the single shared `handleBackendError`
 * in api/notification-channels.ts and mapped to a 400 with the code intact —
 * there's no longer a second layer's try/catch to keep in sync.
 *
 * Run: node --test tests/notification-channels-countries-contract.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const edgeSrc = readFileSync(resolve(__dirname, '..', 'api', 'notification-channels.ts'), 'utf-8');
const sharedRulesSrc = readFileSync(resolve(__dirname, '..', 'server', '_shared', 'alert-rules.ts'), 'utf-8');

describe('notification country-scope forwarding contract', () => {
  it('quiet-hours and digest edge saves forward countries to server/_shared/alert-rules.ts', () => {
    assert.match(
      edgeSrc,
      /action === 'set-quiet-hours'[\s\S]*?countries[\s\S]*?setQuietHours\(userId, variant, \{[\s\S]*?countries/,
      'set-quiet-hours must forward countries',
    );
    assert.match(
      edgeSrc,
      /action === 'set-digest-settings'[\s\S]*?countries[\s\S]*?setDigestSettings\(userId, variant, \{[\s\S]*?countries/,
      'set-digest-settings must forward countries',
    );
  });

  it('set-notification-config forwards countries to setNotificationConfig', () => {
    assert.match(
      edgeSrc,
      /action === 'set-notification-config'[\s\S]*?setNotificationConfig\(userId, variant, \{[\s\S]*?countries/,
      'set-notification-config must forward countries',
    );
  });

  it('set-quiet-hours / set-digest-settings / set-notification-config reject non-array countries', () => {
    const occurrences = edgeSrc.match(/countries\s*!==\s*undefined\s*&&\s*!Array\.isArray\(countries\)/g) ?? [];
    assert.ok(
      occurrences.length >= 1,
      'at least one action must guard countries with a non-array check before forwarding',
    );
    assert.match(edgeSrc, /COUNTRIES_MUST_BE_ARRAY/, 'edge route must reject non-array countries');
  });

  it('setDigestSettings and setQuietHours accept and normalize optional countries', () => {
    assert.match(
      sharedRulesSrc,
      /export async function setDigestSettings\(userId: string, variant: string, args: \{[\s\S]*?countries\?: string\[\][\s\S]*?normalizeCountries\(args\.countries\)/,
      'setDigestSettings must accept and normalize countries',
    );
    assert.match(
      sharedRulesSrc,
      /export async function setQuietHours\(userId: string, variant: string, args: \{[\s\S]*?countries\?: string\[\][\s\S]*?normalizeCountries\(args\.countries\)/,
      'setQuietHours must accept and normalize countries',
    );
  });

  // #4922 U3: normalizeTickers/normalizeCountries throw AlertRulesError with a
  // structured *_LIMIT_EXCEEDED kind on a >50-entry cap. handleBackendError
  // (the single shared error mapper) must translate that to a 400 with the
  // code intact, for every action — not just the ones that happen to have
  // their own try/catch, since there's only one catch site now.
  it('handleBackendError translates AlertRulesError cap-exceeded kinds to a 400', () => {
    assert.match(
      edgeSrc,
      /err\.kind === 'INCOMPATIBLE_DELIVERY' \|\|[\s\S]*?err\.kind === 'TICKERS_LIMIT_EXCEEDED' \|\|[\s\S]*?err\.kind === 'COUNTRIES_LIMIT_EXCEEDED'[\s\S]*?400/,
      'handleBackendError must map COUNTRIES_LIMIT_EXCEEDED/TICKERS_LIMIT_EXCEEDED/INCOMPATIBLE_DELIVERY to 400',
    );
  });

  it('server/_shared/alert-rules.ts throws structured AlertRulesError on cap violations', () => {
    assert.match(
      sharedRulesSrc,
      /throw new AlertRulesError\('COUNTRIES_LIMIT_EXCEEDED'/,
      'normalizeCountries must throw AlertRulesError(COUNTRIES_LIMIT_EXCEEDED)',
    );
    assert.match(
      sharedRulesSrc,
      /throw new AlertRulesError\('TICKERS_LIMIT_EXCEEDED'/,
      'normalizeTickers must throw AlertRulesError(TICKERS_LIMIT_EXCEEDED)',
    );
  });
});
