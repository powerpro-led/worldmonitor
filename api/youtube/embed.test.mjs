import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler from './embed.js';
import { resolveAppOrigin } from '../../shared/domain-config.js';

// embed.js's default/allowed origin is resolveAppOrigin(process.env.APP_DOMAIN)
// (api/_domain-config.js), so assertions must be built against the same
// resolver rather than a hardcoded literal — this test runs under whatever
// APP_DOMAIN the invoking npm script sets (test:sidecar: example.test).
const APP_ORIGIN = resolveAppOrigin(process.env.APP_DOMAIN);

function makeRequest(query = '') {
  return new Request(`${APP_ORIGIN}/api/youtube/embed${query}`);
}

test('rejects missing or invalid video ids', async () => {
  const missing = await handler(makeRequest());
  assert.equal(missing.status, 400);

  const invalid = await handler(makeRequest('?videoId=bad'));
  assert.equal(invalid.status, 400);
});

test('returns embeddable html for valid video id', async () => {
  const response = await handler(makeRequest('?videoId=iEpJwprxDdk&autoplay=0&mute=1'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type')?.includes('text/html'), true);

  const html = await response.text();
  assert.equal(html.includes("videoId:'iEpJwprxDdk'"), true);
  assert.equal(html.includes("host:'https://www.youtube.com'"), true);
  assert.equal(html.includes('autoplay:0'), true);
  assert.equal(html.includes('mute:1'), true);
  assert.equal(html.includes(`origin:${JSON.stringify(APP_ORIGIN)}`), true);
  assert.equal(html.includes('postMessage'), true);
});

test('accepts custom origin parameter', async () => {
  const response = await handler(makeRequest('?videoId=iEpJwprxDdk&origin=http://127.0.0.1:46123'));
  const html = await response.text();
  assert.equal(html.includes('origin:"http://127.0.0.1:46123"'), true);
});

test('uses dedicated parentOrigin for iframe postMessage target', async () => {
  const response = await handler(makeRequest(`?videoId=iEpJwprxDdk&origin=${encodeURIComponent(APP_ORIGIN)}&parentOrigin=https://tauri.localhost`));
  const html = await response.text();
  assert.match(html, new RegExp(`playerVars:\\{[^}]*origin:${JSON.stringify(APP_ORIGIN).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(html, /parentOrigin="https:\/\/tauri\.localhost"/);
  assert.match(html, /if\(allowedOrigin!==['"]\*['"]&&e\.origin!==allowedOrigin\)return/);
});

test('does not accept wildcard parentOrigin query parameter', async () => {
  const response = await handler(makeRequest(`?videoId=iEpJwprxDdk&origin=${encodeURIComponent(APP_ORIGIN)}&parentOrigin=*`));
  const html = await response.text();
  assert.equal(html.includes('parentOrigin="*"'), false);
  assert.match(html, new RegExp(`parentOrigin=${JSON.stringify(APP_ORIGIN).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});
