import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSentryContext } from '../api/user-prefs.ts';

// ---------------------------------------------------------------------------
// buildSentryContext — Sentry tag/extra/fingerprint shape for /api/user-prefs
//
// Stage 2 of the Convex/Clerk -> Supabase migration simplified this builder
// significantly: `worldmonitor.user_preferences` is a direct Postgres call
// from this same edge function, so there's no second platform's error
// surface (Convex timeouts/503s/opaque 5xx) left to classify via message
// pattern-matching. `errorShapeOverride`/`convexFn` are gone; the signature
// dropped the raw `err` param (callers already extract the message string).
// ---------------------------------------------------------------------------

const baseOpts = {
  method: 'POST' as const,
  userId: 'user_2x8K3StringFormFromSupabase',
  variant: 'full',
};

describe('buildSentryContext — shape', () => {
  it('tags route/method/user_id; fingerprint is [route, method]', () => {
    const ctx = buildSentryContext('some failure', baseOpts);
    assert.equal(ctx.tags.route, 'api/user-prefs');
    assert.equal(ctx.tags.method, 'POST');
    assert.equal(typeof ctx.tags.user_id, 'string');
    assert.equal(ctx.tags.user_id, baseOpts.userId);
    assert.deepEqual(ctx.fingerprint, ['api/user-prefs', 'POST']);
  });

  it('extra carries variant + a truncated messageHead', () => {
    const longMsg = 'x'.repeat(500);
    const ctx = buildSentryContext(longMsg, baseOpts);
    assert.equal(ctx.extra.variant, 'full');
    assert.equal(typeof ctx.extra.messageHead, 'string');
    assert.equal((ctx.extra.messageHead as string).length, 300);
  });

  it('variant defaults to "unknown" in extra when not a string', () => {
    const ctx = buildSentryContext('msg', { ...baseOpts, variant: undefined });
    assert.equal(ctx.extra.variant, 'unknown');
  });
});

describe('buildSentryContext — extraTags', () => {
  it('merges extraTags into tags alongside built-in tags', () => {
    const ctx = buildSentryContext('CONFLICT', {
      ...baseOpts,
      extraTags: { actual_sync_version: 72 },
    });
    assert.equal(ctx.tags.actual_sync_version, 72);
    assert.equal(ctx.tags.route, 'api/user-prefs');
    assert.equal(ctx.tags.user_id, baseOpts.userId);
  });

  it('omits extraTags when not provided (no undefined keys leak)', () => {
    const ctx = buildSentryContext('msg', baseOpts);
    assert.equal('actual_sync_version' in ctx.tags, false);
  });

  it('extraTags can supply numeric values, including zero', () => {
    const ctx = buildSentryContext('msg', { ...baseOpts, extraTags: { actual_sync_version: 0 } });
    assert.equal(ctx.tags.actual_sync_version, 0);
  });
});

describe('buildSentryContext — level', () => {
  it('omits level field by default (envelope falls back to error)', () => {
    const ctx = buildSentryContext('msg', baseOpts);
    assert.equal('level' in ctx, false);
  });

  it('passes through level: warning for expected-but-trackable conditions (CONFLICT/SERVICE_UNAVAILABLE)', () => {
    const ctx = buildSentryContext('CONFLICT', { ...baseOpts, level: 'warning' });
    assert.equal(ctx.level, 'warning');
  });
});
