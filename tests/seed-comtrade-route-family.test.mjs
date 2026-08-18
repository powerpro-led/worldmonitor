// Regression test for seed-comtrade-bilateral-hs4's UN Comtrade URL path segment.
//
// Discovered 2026-08-17 while live-testing category 6 of the 156-seed-source sweep,
// immediately after a valid COMTRADE_API_KEYS was added. The seeder interpolated the
// product metadata's CLASSIFICATION REVISION ('H6' = HS2022) into the URL path, where
// Comtrade expects its API ROUTE FAMILY ('HS'). Verified live against the real API with
// an otherwise-identical query (reporterCode=156, cmdCode=<10 HS4 codes>, flowCode=M):
//
//   .../data/v1/get/C/A/H6  -> HTTP 500  {"count":-1,"error":{...}}   every request
//   .../data/v1/get/C/A/HS  -> HTTP 200  count=25158
//
// So with H6 the seeder 500s on every authenticated call no matter how valid the key is.
// seed-trade-flows.mjs:14 already documents the distinction ("API route family; metadata
// tracks the active H6/HS2022 revision separately") — this file had not adopted it.
//
// The two namespaces must stay SEPARATE: the fix is the URL path, NOT editing
// comtrade-strategic-products.json, whose H6 revision is correct and meaningful.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMTRADE_FETCH_URL,
  COMTRADE_ROUTE_FAMILY,
  COMTRADE_CLASSIFICATION_CODE,
} from '../scripts/seed-comtrade-bilateral-hs4.mjs';

test('route family is HS — the value the Comtrade API actually accepts in the path', () => {
  assert.equal(COMTRADE_ROUTE_FAMILY, 'HS');
});

test('fetch URL uses the HS route family, never the H6 revision code', () => {
  assert.ok(
    COMTRADE_FETCH_URL.includes('/C/A/HS'),
    `fetch URL must target the HS route family, got: ${COMTRADE_FETCH_URL}`,
  );
  assert.ok(
    !COMTRADE_FETCH_URL.includes('/C/A/H6'),
    `H6 in the path makes every authenticated request 500; got: ${COMTRADE_FETCH_URL}`,
  );
});

test('fetch URL targets one of the two known Comtrade endpoints', () => {
  assert.match(
    COMTRADE_FETCH_URL,
    /^https:\/\/comtradeapi\.un\.org\/(public\/v1\/preview|data\/v1\/get)\/C\/A\/HS$/,
    `unexpected Comtrade endpoint shape: ${COMTRADE_FETCH_URL}`,
  );
});

test('classification revision is still tracked separately and still H6', () => {
  // Guards the other direction: the bug must NOT be "fixed" by rewriting the product
  // metadata to HS. The curated product list really is against HS2022, and that fact
  // is used for provenance — it just does not belong in the URL path.
  assert.equal(
    COMTRADE_CLASSIFICATION_CODE,
    'H6',
    'comtrade-strategic-products.json must keep tracking the HS2022 revision as H6',
  );
  assert.notEqual(
    COMTRADE_CLASSIFICATION_CODE,
    COMTRADE_ROUTE_FAMILY,
    'route family and classification revision are distinct namespaces — do not collapse them',
  );
});
