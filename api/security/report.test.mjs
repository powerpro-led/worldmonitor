import { strict as assert } from 'node:assert';
import test from 'node:test';

import handler from './report.js';
import { TEST_APP_DOMAIN } from '../../tests/helpers/domain-config.mjs';

// Pre-escaped for embedding in a regex (new RegExp(...), not a /.../ literal
// — forward slashes need no escaping there, only the dot does).
const ESCAPED_TEST_APP_DOMAIN = TEST_APP_DOMAIN.replace(/\./g, '\\.');

function makeReportRequest({ body, contentType = 'application/reports+json' } = {}) {
  return new Request(`https://${TEST_APP_DOMAIN}/api/security/report`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: body ?? JSON.stringify([]),
  });
}

test('security report endpoint accepts Reporting API batches and redacts URLs in logs', async (t) => {
  const logs = [];
  const originalInfo = console.info;
  console.info = (...args) => logs.push(args.join(' '));
  t.after(() => {
    console.info = originalInfo;
  });

  const response = await handler(makeReportRequest({
    body: JSON.stringify([
      {
        type: 'coep',
        age: 10,
        url: `https://tech.${TEST_APP_DOMAIN}/panel?token=secret`,
        body: {
          type: 'corp-not-same-origin',
          disposition: 'reporting',
          effectivePolicy: 'require-corp',
          blockedURL: 'https://cdn.example.test/asset.js?private=true',
          destination: 'script',
        },
      },
    ]),
  }));

  assert.equal(response.status, 204);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /\[security\/report\]/);
  assert.match(logs[0], new RegExp(`"urlOrigin":"https://tech\\.${ESCAPED_TEST_APP_DOMAIN}"`));
  assert.match(logs[0], /"blockedURLOrigin":"https:\/\/cdn\.example\.test"/);
  assert.doesNotMatch(logs[0], /token=secret|private=true/);
});

test('security report endpoint accepts Reporting API single-report content type', async () => {
  const response = await handler(makeReportRequest({
    body: JSON.stringify({ type: 'coop', body: { disposition: 'reporting' } }),
    contentType: 'application/report+json; charset=utf-8',
  }));
  assert.equal(response.status, 204);
});

test('security report endpoint rejects unsupported methods', async () => {
  const response = await handler(new Request(`https://${TEST_APP_DOMAIN}/api/security/report`));
  assert.equal(response.status, 405);
});

test('security report endpoint rejects unsupported media types', async () => {
  const response = await handler(makeReportRequest({ contentType: 'text/plain' }));
  assert.equal(response.status, 415);
});

test('security report endpoint rejects oversized report bodies', async () => {
  const oversized = JSON.stringify([{ body: { blockedURL: `https://cdn.example.test/${'x'.repeat(33 * 1024)}` } }]);
  const response = await handler(makeReportRequest({ body: oversized }));
  assert.equal(response.status, 413);
});
