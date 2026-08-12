import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { collectQueryParamContractViolations } from '../scripts/lib/sebuf-query-param-contract.mjs';

// The two tests that used to live here asserted no-op/implemented query-param
// disclosure against the generated OpenAPI docs (docs/api/*.openapi.json).
// That public API docs pipeline was retired (private fork, no public docs);
// the remaining tests below exercise collectQueryParamContractViolations
// directly against proto/handler fixtures, which is real, surviving behavior
// (still wired into `npm run lint:api-contract`).

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wm-sebuf-query-'));
  mkdirSync(join(root, 'proto/worldmonitor/demo/v1'), { recursive: true });
  mkdirSync(join(root, 'server/worldmonitor/demo/v1'), { recursive: true });
  return root;
}

function writeProto(root, fieldSource) {
  writeFileSync(join(root, 'proto/worldmonitor/demo/v1/list_things.proto'), [
    'syntax = "proto3";',
    '',
    'package worldmonitor.demo.v1;',
    '',
    'import "sebuf/http/annotations.proto";',
    '',
    'message ListThingsRequest {',
    fieldSource,
    '}',
  ].join('\n'));
}

function writeHandler(root, body) {
  writeFileSync(join(root, 'server/worldmonitor/demo/v1/list-things.ts'), body);
}

describe('sebuf query-param implementation contract', () => {

  it('flags unannotated query params that handlers do not reference', () => {
    const root = fixture();
    writeProto(root, [
      '  // Optional search query.',
      '  string query = 1 [(sebuf.http.query) = { name: "query" }];',
    ].join('\n'));
    writeHandler(root, 'export async function listThings(_ctx, _req) { return {}; }\n');

    const { violations } = collectQueryParamContractViolations(root, { scopedProtoFiles: new Set(['worldmonitor/demo/v1/list_things.proto']), forcedNoopQueryParams: new Set() });
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /declared but not referenced/);
  });

  it('accepts active query params referenced through generated camelCase request properties', () => {
    const root = fixture();
    writeProto(root, [
      '  // Maximum items per page.',
      '  int32 page_size = 1 [(sebuf.http.query) = { name: "page_size" }];',
    ].join('\n'));
    writeHandler(root, 'export async function listThings(_ctx, req) { return { limit: req.pageSize }; }\n');

    const { violations } = collectQueryParamContractViolations(root, { scopedProtoFiles: new Set(['worldmonitor/demo/v1/list_things.proto']), forcedNoopQueryParams: new Set() });
    assert.deepEqual(violations, []);
  });

  it('does not accept unrelated objects with matching property names as query param usage', () => {
    const root = fixture();
    writeProto(root, [
      '  // Maximum items per page.',
      '  int32 page_size = 1 [(sebuf.http.query) = { name: "page_size" }];',
    ].join('\n'));
    writeHandler(root, [
      'export async function listThings(_ctx, _req) {',
      '  const cacheMeta = { pageSize: 25 };',
      '  return { limit: cacheMeta.pageSize };',
      '}',
      '',
    ].join('\n'));

    const { violations } = collectQueryParamContractViolations(root, { scopedProtoFiles: new Set(['worldmonitor/demo/v1/list_things.proto']), forcedNoopQueryParams: new Set() });
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /declared but not referenced/);
  });

  it('allows documented no-op query params marked with the proto field option', () => {
    const root = fixture();
    writeProto(root, [
      '  // Accepted but currently ignored; no-op until the seed-cache handler supports this filter.',
      '  string cursor = 1 [(sebuf.http.query) = { name: "cursor" }, (sebuf.http.unimplemented) = true];',
    ].join('\n'));
    writeHandler(root, 'export async function listThings(_ctx, _req) { return {}; }\n');

    const { violations, stats } = collectQueryParamContractViolations(root, { scopedProtoFiles: new Set(['worldmonitor/demo/v1/list_things.proto']), forcedNoopQueryParams: new Set() });
    assert.deepEqual(violations, []);
    assert.equal(stats.unimplementedFields, 1);
  });

  it('flags forced no-op registry entries missing the proto field option', () => {
    const root = fixture();
    writeProto(root, [
      '  // Accepted but currently ignored; no-op until the seed-cache handler supports this filter.',
      '  string cursor = 1 [(sebuf.http.query) = { name: "cursor" }];',
    ].join('\n'));
    writeHandler(root, 'export async function listThings(_ctx, req) { return { cursor: req.cursor }; }\n');

    const { violations } = collectQueryParamContractViolations(root, {
      scopedProtoFiles: new Set(['worldmonitor/demo/v1/list_things.proto']),
      forcedNoopQueryParams: new Set(['worldmonitor/demo/v1/list_things.proto:cursor']),
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /no-op registry but is not marked unimplemented/);
  });

  it('requires no-op annotations to be visible in generated OpenAPI comments', () => {
    const root = fixture();
    writeProto(root, [
      '  // Cursor for next page.',
      '  string cursor = 1 [(sebuf.http.query) = { name: "cursor" }, (sebuf.http.unimplemented) = true];',
    ].join('\n'));
    writeHandler(root, 'export async function listThings(_ctx, _req) { return {}; }\n');

    const { violations } = collectQueryParamContractViolations(root, { scopedProtoFiles: new Set(['worldmonitor/demo/v1/list_things.proto']), forcedNoopQueryParams: new Set() });
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /does not disclose/);
  });
});
