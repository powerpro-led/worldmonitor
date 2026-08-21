/**
 * Tests for the U11 brief source-link stamping.
 *
 * `server/_shared/brief-render.js` stamps every story source-link with
 * `data-thread-open / data-country / data-severity / data-followed`. The
 * interesting logic is `data-followed`: it reflects whether the story's
 * country (or ANY ISO-2 token in a composite country field) appears in the
 * recipient's watchlist, and it is deliberately suppressed in public mode
 * where there is no recipient identity.
 *
 * The analytics backend that once consumed these attributes has been removed
 * (see src/services/analytics.ts), so what remains under test is the renderer
 * itself — a pure HTML producer, fully testable from Node without jsdom.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderBriefMagazine } from '../server/_shared/brief-render.js';
import { BRIEF_ENVELOPE_VERSION } from '../shared/brief-envelope.js';

// ---------------------------------------------------------------------------
// Envelope fixture (mirrors brief-magazine-render.test.mjs)
// ---------------------------------------------------------------------------

function story(overrides = {}) {
  return {
    clusterId: 'cluster-test-default',
    category: 'Energy',
    country: 'IR',
    threatLevel: 'high',
    headline: 'Iran declares Strait of Hormuz open. Oil drops more than 9%.',
    description: 'Tehran publicly reopened the Strait of Hormuz to commercial shipping today.',
    source: 'Multiple wires',
    sourceUrl: 'https://example.com/hormuz-open',
    whyMatters: 'Hormuz is roughly a fifth of global seaborne oil — a 9% move is a repricing.',
    ...overrides,
  };
}

function envelope(overrides = {}) {
  const data = {
    user: { name: 'Elie', tz: 'UTC' },
    issue: '17.04',
    date: '2026-04-17',
    dateLong: '17 April 2026',
    digest: {
      greeting: 'Good evening.',
      lead: 'The most impactful development today is the reopening of the Strait of Hormuz.',
      numbers: { clusters: 278, multiSource: 21, surfaced: 4 },
      threads: [
        { tag: 'Energy', teaser: 'Iran reopens the Strait of Hormuz.' },
        { tag: 'Diplomacy', teaser: 'Israel–Lebanon ceasefire takes effect.' },
        { tag: 'Maritime', teaser: 'US military expands posture against Iran-linked shipping.' },
        { tag: 'Humanitarian', teaser: 'A record year at sea for Rohingya refugees.' },
      ],
      signals: [
        'Adherence to the Israel–Lebanon ceasefire in the first 72 hours.',
        'Long-term stability of commercial shipping through Hormuz.',
      ],
    },
    stories: [
      story(),
      story({ country: 'IL', category: 'Diplomacy' }),
      story({ country: 'US', category: 'Maritime', threatLevel: 'critical' }),
      story({ country: 'MM', category: 'Humanitarian' }),
    ],
    ...overrides,
  };
  return {
    version: BRIEF_ENVELOPE_VERSION,
    issuedAt: 1_700_000_000_000,
    data,
  };
}

// ---------------------------------------------------------------------------
// Magazine: data-attribute stamping
// ---------------------------------------------------------------------------

/** Pull every source-link anchor and parse its data-* attributes. */
function extractSourceLinks(html) {
  const anchors = [];
  const re = /<a class="source-link"[^>]*?>[^<]*<\/a>/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const tag = match[0];
    const attrs = {};
    for (const m of tag.matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
      attrs[m[1]] = m[2];
    }
    anchors.push(attrs);
  }
  return anchors;
}

describe('brief-render — U11 source-link stamping', () => {
  it('every source-link carries data-thread-open / data-country / data-severity / data-followed', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { followedCountries: [] });
    const links = extractSourceLinks(html);
    assert.equal(links.length, env.data.stories.length, 'one anchor per story');
    for (const link of links) {
      assert.equal(link['thread-open'], '1');
      assert.ok(link['country'], 'data-country present (single ISO-2 stories)');
      assert.match(link['severity'], /^(critical|high|medium|low)$/);
      assert.match(link['followed'], /^[01]$/);
    }
  });

  it('followedCountries=[] → every story stamps data-followed="0"', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { followedCountries: [] });
    const links = extractSourceLinks(html);
    for (const link of links) {
      assert.equal(link['followed'], '0', `country ${link['country']} should be unfollowed`);
    }
  });

  it('followedCountries match flips data-followed="1" only for the matching country', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { followedCountries: ['US'] });
    const links = extractSourceLinks(html);
    const us = links.find((l) => l['country'] === 'US');
    const ir = links.find((l) => l['country'] === 'IR');
    assert.equal(us['followed'], '1');
    assert.equal(ir['followed'], '0');
  });

  it('followedCountries lookup is case-insensitive (lowercase input matches uppercase story.country)', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { followedCountries: ['us', 'il'] });
    const links = extractSourceLinks(html);
    assert.equal(links.find((l) => l['country'] === 'US')['followed'], '1');
    assert.equal(links.find((l) => l['country'] === 'IL')['followed'], '1');
    assert.equal(links.find((l) => l['country'] === 'IR')['followed'], '0');
  });

  it('composite country "IL / LB": data-followed="1" when any token is followed', () => {
    const env = envelope({
      stories: [
        story({ country: 'IL / LB' }),
        story({ country: 'IL/LB' }),
        story({ country: 'FR / DE' }),
      ],
      digest: {
        ...envelope().data.digest,
        numbers: { clusters: 1, multiSource: 1, surfaced: 3 },
      },
    });
    const html = renderBriefMagazine(env, { followedCountries: ['LB'] });
    const links = extractSourceLinks(html);
    assert.equal(links.length, 3);
    // First two stories tokenize to ['IL', 'LB'] — matched.
    assert.equal(links[0]['followed'], '1');
    assert.equal(links[1]['followed'], '1');
    // Third story tokenizes to ['FR', 'DE'] — not followed.
    assert.equal(links[2]['followed'], '0');
  });

  it('publicMode ignores followedCountries (no recipient identity in the public mirror)', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, { publicMode: true, followedCountries: ['US', 'IR', 'IL', 'MM'] });
    const links = extractSourceLinks(html);
    for (const link of links) {
      assert.equal(link['followed'], '0', 'public mirror must always render followed=0');
    }
  });

  it('renderer rejects non-array followedCountries by treating it as empty (defensive parse)', () => {
    const env = envelope();
    // @ts-expect-error — testing the runtime guard
    const html = renderBriefMagazine(env, { followedCountries: 'US' });
    const links = extractSourceLinks(html);
    for (const link of links) {
      assert.equal(link['followed'], '0');
    }
  });

  it('renderer filters non-string entries from followedCountries', () => {
    const env = envelope();
    const html = renderBriefMagazine(env, {
      // @ts-expect-error — testing the runtime guard
      followedCountries: ['US', null, undefined, 42, '', 'IR'],
    });
    const links = extractSourceLinks(html);
    assert.equal(links.find((l) => l['country'] === 'US')['followed'], '1');
    assert.equal(links.find((l) => l['country'] === 'IR')['followed'], '1');
    assert.equal(links.find((l) => l['country'] === 'IL')['followed'], '0');
  });

  it('story.country with no ISO-2 token (free-form text) omits data-country and stays unfollowed', () => {
    const env = envelope({
      stories: [
        story({ country: 'European Union' }),
      ],
      digest: {
        ...envelope().data.digest,
        numbers: { clusters: 1, multiSource: 1, surfaced: 1 },
      },
    });
    const html = renderBriefMagazine(env, { followedCountries: ['US', 'EU'] });
    const links = extractSourceLinks(html);
    assert.equal(links.length, 1);
    assert.equal(links[0]['country'], undefined, 'free-form country yields no ISO-2 token');
    assert.equal(links[0]['followed'], '0');
  });

});
