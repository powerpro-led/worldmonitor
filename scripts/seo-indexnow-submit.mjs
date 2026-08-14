#!/usr/bin/env node
/**
 * Submit all APP_DOMAIN URLs to IndexNow after deploy.
 * Run once after deploying the IndexNow key file:
 *   node scripts/seo-indexnow-submit.mjs
 *
 * IndexNow requires all URLs in one request to share the same host.
 * Submits separate batches per subdomain.
 */
import { resolveWwwOrigin, resolveVariantOrigin } from './_domain-config.mjs';

const KEY = 'a7f3e9d1b2c44e8f9a0b1c2d3e4f5a6b';

const wwwOrigin = resolveWwwOrigin(process.env.APP_DOMAIN);
const WWW_URLS = [
  `${wwwOrigin}/`,
];

// NOTE: only 3 of the 5 variant subdomains (not commodity, not energy) — a
// pre-existing scope oddity carried forward as-is rather than silently
// "completed" during the domain sweep; see TASKS.md for the flag.
const BATCHES = [
  {
    host: new URL(wwwOrigin).host,
    urls: WWW_URLS,
  },
  ...['tech', 'finance', 'happy'].map((slug) => {
    const origin = resolveVariantOrigin(process.env.APP_DOMAIN, slug);
    return { host: new URL(origin).host, urls: [`${origin}/`] };
  }),
];

const ENDPOINTS = [
  'https://api.indexnow.org/IndexNow',
  'https://www.bing.com/IndexNow',
  'https://searchadvisor.naver.com/indexnow',
  'https://search.seznam.cz/indexnow',
  'https://yandex.com/indexnow',
];

async function submit(endpoint, host, urlList) {
  const keyLocation = `https://${host}/${KEY}.txt`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': `WorldMonitor-IndexNow/1.0 (+${wwwOrigin})`,
    },
    body: JSON.stringify({ host, key: KEY, keyLocation, urlList }),
  });
  return { endpoint, host, status: res.status, ok: res.ok };
}

for (const { host, urls } of BATCHES) {
  console.log(`\n[${host}] (${urls.length} URLs)`);
  const results = await Promise.allSettled(ENDPOINTS.map(ep => submit(ep, host, urls)));
  for (const r of results) {
    if (r.status === 'fulfilled') {
      console.log(`  ${r.value.ok ? '✓' : '✗'} ${r.value.endpoint.replace('https://', '')} → ${r.value.status}`);
    } else {
      console.log(`  ✗ error: ${r.reason}`);
    }
  }
}
