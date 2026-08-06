/**
 * Regression tests for the digest-mode rollout flag paths.
 *
 * Covers two invariants reviewers flagged as untested:
 *   1. VITE_DIGEST_CRON_ENABLED gates digest-mode options in the settings UI.
 *   2. digestTimezone is validated through setDigestSettings.
 *
 * Stage 3 of the Convex/Clerk -> Supabase migration collapsed Convex's
 * public `setDigestSettings` mutation + internal `setDigestSettingsForUser`
 * mutation (two code paths, both independently required to validate
 * digestTimezone so the edge-relay path couldn't bypass validation) into a
 * single `setDigestSettings` function in `server/_shared/alert-rules.ts` —
 * there's only one caller (`api/notification-channels.ts`) and no
 * public/internal split in Postgres, so there's only one path left to check.
 *
 * Run: node --test tests/digest-rollout-flags.test.mjs
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

describe('VITE_DIGEST_CRON_ENABLED gates digest UI', () => {
  it('defines DIGEST_CRON_ENABLED from VITE_DIGEST_CRON_ENABLED env var', () => {
    assert.ok(
      prefSrc.includes("import.meta.env.VITE_DIGEST_CRON_ENABLED !== '0'"),
      'DIGEST_CRON_ENABLED must be derived from VITE_DIGEST_CRON_ENABLED',
    );
  });

  it('daily/twice_daily/weekly options are rendered only when flag is on', () => {
    assert.ok(
      prefSrc.includes("DIGEST_CRON_ENABLED ? `<option value=\"daily\""),
      'daily option must be gated behind DIGEST_CRON_ENABLED',
    );
    assert.ok(
      prefSrc.includes(`<option value="twice_daily"`),
      'twice_daily option must exist in the template',
    );
    assert.ok(
      prefSrc.includes(`<option value="weekly"`),
      'weekly option must exist in the template',
    );
    // All three non-realtime options are inside the DIGEST_CRON_ENABLED ternary block
    const gateIdx = prefSrc.indexOf('DIGEST_CRON_ENABLED ? `<option value="daily"');
    const dailyIdx = prefSrc.indexOf('<option value="daily"');
    const twiceIdx = prefSrc.indexOf('<option value="twice_daily"');
    const weeklyIdx = prefSrc.indexOf('<option value="weekly"');
    assert.ok(
      gateIdx !== -1 && dailyIdx > gateIdx && twiceIdx > gateIdx && weeklyIdx > gateIdx,
      'non-realtime options must appear after the DIGEST_CRON_ENABLED gate',
    );
  });

  it('usDigestDetails visibility is tied to DIGEST_CRON_ENABLED', () => {
    assert.ok(
      prefSrc.includes('!DIGEST_CRON_ENABLED || digestMode === \'realtime\''),
      'usDigestDetails must be hidden when DIGEST_CRON_ENABLED is false',
    );
  });

  it('realtime option is always rendered (fallback when cron is disabled)', () => {
    assert.ok(
      prefSrc.includes('<option value="realtime"'),
      'realtime option must always be present in the select',
    );
    // It must NOT be inside the DIGEST_CRON_ENABLED conditional block
    const realtimeIdx = prefSrc.indexOf('<option value="realtime"');
    const gateIdx = prefSrc.indexOf('DIGEST_CRON_ENABLED ? `<option value="daily"');
    assert.ok(
      realtimeIdx < gateIdx || gateIdx === -1,
      'realtime option must appear before (outside) the DIGEST_CRON_ENABLED gate',
    );
  });
});

// ── setDigestSettings timezone validation ─────────────────────────────────────

describe('setDigestSettings validates digestTimezone', () => {
  const start = alertRulesSrc.indexOf('export async function setDigestSettings');
  const nextExport = alertRulesSrc.indexOf('\nexport async function ', start + 1);
  const body = alertRulesSrc.slice(start, nextExport === -1 ? undefined : nextExport);

  it('setDigestSettings exists', () => {
    assert.ok(start !== -1, 'setDigestSettings must exist in server/_shared/alert-rules.ts');
  });

  it('validates digestTimezone via validateTimezone (Intl.DateTimeFormat)', () => {
    assert.ok(
      body.includes('validateTimezone(args.digestTimezone)'),
      'setDigestSettings must validate digestTimezone via validateTimezone',
    );
    assert.ok(
      alertRulesSrc.includes('Intl.DateTimeFormat') && alertRulesSrc.includes('digestTimezone'),
      'validateTimezone must use Intl.DateTimeFormat',
    );
  });

  it('throws AlertRulesError(INVALID_INPUT) for invalid timezone', () => {
    assert.match(
      alertRulesSrc,
      /function validateTimezone[\s\S]*?throw new AlertRulesError\('INVALID_INPUT'/,
      'validateTimezone must throw AlertRulesError(INVALID_INPUT) on invalid digestTimezone',
    );
  });
});
