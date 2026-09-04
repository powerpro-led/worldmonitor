// Unit coverage for scripts/seed-news-digest.mjs — the warm-ping seeder that
// keeps `news:digest:v1:<variant>:<lang>` alive (PLATFORM_ARCHITECTURE.md
// Workstream 7). The module's `_isDirectRun` guard keeps this import from
// firing loadEnvFile() or a live run.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { parseList, buildPairs, digestUrl, run } from '../scripts/seed-news-digest.mjs';

describe('parseList', () => {
  it('falls back verbatim when the env value is unset or blank', () => {
    assert.deepEqual(parseList(undefined, 'full'), ['full']);
    assert.deepEqual(parseList('   ', 'en,zh'), ['en', 'zh']);
  });

  it('splits on commas and whitespace, trims, and dedupes', () => {
    assert.deepEqual(parseList('full, tech  full\nfinance', 'x'), ['full', 'tech', 'finance']);
  });

  it('uses the env value when present', () => {
    assert.deepEqual(parseList('en', 'en,zh'), ['en']);
  });
});

describe('buildPairs', () => {
  it('is the cartesian product of variants x langs', () => {
    const pairs = buildPairs(['full', 'tech'], ['en', 'zh']);
    assert.equal(pairs.length, 4);
    assert.ok(pairs.some((p) => p.variant === 'tech' && p.lang === 'zh'));
  });

  it('orders every en pair before the non-en pairs', () => {
    const pairs = buildPairs(['full', 'tech'], ['zh', 'en', 'fr']);
    const firstNonEn = pairs.findIndex((p) => p.lang !== 'en');
    const lastEn = pairs.map((p) => p.lang).lastIndexOf('en');
    assert.ok(lastEn < firstNonEn, 'all en pairs must precede the first non-en pair');
  });
});

describe('digestUrl', () => {
  it('builds the RPC path with encoded params', () => {
    assert.equal(
      digestUrl('https://api.example.test', 'full', 'en'),
      'https://api.example.test/api/news/v1/list-feed-digest?variant=full&lang=en',
    );
  });
});

describe('run() exit-code policy', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.NEWS_DIGEST_SEED_VARIANTS;
    delete process.env.NEWS_DIGEST_SEED_LANGS;
    delete process.env.API_BASE_URL;
  });

  const okResp = () => ({ ok: true, status: 200, json: async () => ({ categories: { intel: [] } }) });
  const badResp = () => ({ ok: false, status: 503, json: async () => ({}) });

  it('returns 0 when every ping succeeds', async () => {
    process.env.NEWS_DIGEST_SEED_VARIANTS = 'full';
    process.env.NEWS_DIGEST_SEED_LANGS = 'en,zh';
    const seen = [];
    globalThis.fetch = async (url) => { seen.push(url); return okResp(); };
    assert.equal(await run(), 0);
    assert.equal(seen.length, 2);
  });

  it('returns 0 on a partial failure (self-healing next tick)', async () => {
    process.env.NEWS_DIGEST_SEED_VARIANTS = 'full';
    process.env.NEWS_DIGEST_SEED_LANGS = 'en,zh';
    globalThis.fetch = async (url) => (String(url).includes('lang=zh') ? badResp() : okResp());
    assert.equal(await run(), 0);
  });

  it('returns 1 only when every ping fails', async () => {
    process.env.NEWS_DIGEST_SEED_VARIANTS = 'full';
    process.env.NEWS_DIGEST_SEED_LANGS = 'en,zh';
    globalThis.fetch = async () => badResp();
    assert.equal(await run(), 1);
  });

  it('returns 1 when fetch throws for every pair', async () => {
    process.env.NEWS_DIGEST_SEED_LANGS = 'en';
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    assert.equal(await run(), 1);
  });
});
