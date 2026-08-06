/**
 * Regression tests for the quiet-hours rollout flag paths.
 *
 * Covers two invariants reviewers flagged as untested:
 *   1. VITE_QUIET_HOURS_BATCH_ENABLED gates the batch_on_wake option in the UI.
 *   2. quietHoursTimezone is validated through setQuietHours.
 *
 * Stage 3 of the Convex/Clerk -> Supabase migration collapsed Convex's
 * public `setQuietHours` mutation + internal `setQuietHoursForUser` mutation
 * (two code paths, both independently required to validate
 * quietHoursTimezone so the edge-relay path couldn't bypass validation) into
 * a single `setQuietHours` function in `server/_shared/alert-rules.ts` —
 * there's only one caller (`api/notification-channels.ts`) and no
 * public/internal split in Postgres, so there's only one path left to check.
 *
 * Run: node --test tests/quiet-hours-rollout-flags.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prefSrc = readFileSync(
  resolve(__dirname, '../src/services/notifications-settings.ts'),
  'utf-8',
);
const alertRulesSrc = readFileSync(
  resolve(__dirname, '../server/_shared/alert-rules.ts'),
  'utf-8',
);

// ── UI rollout flag ───────────────────────────────────────────────────────────

describe('VITE_QUIET_HOURS_BATCH_ENABLED gates batch_on_wake UI', () => {
  it('defines QUIET_HOURS_BATCH_ENABLED from VITE_QUIET_HOURS_BATCH_ENABLED env var', () => {
    assert.ok(
      prefSrc.includes("import.meta.env.VITE_QUIET_HOURS_BATCH_ENABLED !== '0'"),
      'QUIET_HOURS_BATCH_ENABLED must be derived from VITE_QUIET_HOURS_BATCH_ENABLED',
    );
  });

  it('batch_on_wake option is conditionally rendered behind the flag', () => {
    assert.ok(
      prefSrc.includes('QUIET_HOURS_BATCH_ENABLED') && prefSrc.includes('batch_on_wake'),
      'batch_on_wake option must reference QUIET_HOURS_BATCH_ENABLED',
    );
    // The option must appear inside a QUIET_HOURS_BATCH_ENABLED conditional
    const gateIdx = prefSrc.indexOf('QUIET_HOURS_BATCH_ENABLED ?');
    const batchIdx = prefSrc.indexOf('<option value="batch_on_wake"');
    assert.ok(
      gateIdx !== -1 && batchIdx > gateIdx,
      'batch_on_wake option must appear after the QUIET_HOURS_BATCH_ENABLED gate',
    );
  });

  it('critical_only override option is always rendered (baseline when batch is disabled)', () => {
    assert.ok(
      prefSrc.includes('<option value="critical_only"'),
      'critical_only must always be present as the safe baseline override',
    );
    const criticalIdx = prefSrc.indexOf('<option value="critical_only"');
    const gateIdx = prefSrc.indexOf('QUIET_HOURS_BATCH_ENABLED ?');
    // critical_only must appear before (outside) the batch gate
    assert.ok(
      criticalIdx !== -1 && (gateIdx === -1 || criticalIdx < gateIdx),
      'critical_only option must appear before (outside) the QUIET_HOURS_BATCH_ENABLED gate',
    );
  });
});

// ── setQuietHours timezone validation ─────────────────────────────────────────

describe('setQuietHours validates quietHoursTimezone', () => {
  const start = alertRulesSrc.indexOf('export async function setQuietHours');
  const nextExport = alertRulesSrc.indexOf('\nexport async function ', start + 1);
  const body = alertRulesSrc.slice(start, nextExport === -1 ? undefined : nextExport);

  it('setQuietHours exists', () => {
    assert.ok(start !== -1, 'setQuietHours must exist in server/_shared/alert-rules.ts');
  });

  it('validates quietHoursTimezone via validateQuietHours (Intl.DateTimeFormat)', () => {
    assert.ok(
      body.includes('validateQuietHours(args)'),
      'setQuietHours must validate quietHoursTimezone via validateQuietHours',
    );
    assert.ok(
      alertRulesSrc.includes('Intl.DateTimeFormat') && alertRulesSrc.includes('quietHoursTimezone'),
      'validateQuietHours must use Intl.DateTimeFormat',
    );
  });

  it('throws AlertRulesError(INVALID_INPUT) for invalid timezone', () => {
    assert.match(
      alertRulesSrc,
      /function validateTimezone[\s\S]*?throw new AlertRulesError\('INVALID_INPUT'/,
      'validateTimezone (called from validateQuietHours) must throw AlertRulesError(INVALID_INPUT)',
    );
  });
});
