// Tier-4 — MCP↔API parity helpers.
//
// This used to also run a live parity check ("every public OpenAPI operation
// in `docs/api/*.openapi.json` is covered by an MCP tool or excluded with a
// reason") against the generated OpenAPI spec directory. That spec directory
// (docs/api/) was retired along with the rest of the public API docs product
// (private fork, no public API docs) — see the removed build:openapi script —
// so the live assertions and the EXCLUDED_FROM_MCP_PARITY inventory they
// checked were removed too. What remains below are the meta-tests for the
// predicate helpers themselves (collectApiOperations, findUncoveredApiOps,
// etc.), which run against synthetic fixtures and stay valid independent of
// any live OpenAPI directory.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { __testing__ as mcpTesting } from '../api/mcp.ts';

const { TOOL_REGISTRY } = mcpTesting;

// Valid category prefixes — every EXCLUDED_FROM_MCP_PARITY reason must start
// with one of these followed by a colon. Enforced by findEmptyOrUnprefixedReasons.
const VALID_PREFIXES = [
  'mutating',
  'llm-passthrough',
  'fetch-on-miss',
  'admin',
  'manual-mapping',
  'deferred-to-future-tool',
];

// Closed allowlist of valid secondary signals for `fetch-on-miss:` reasons.
// `already-covered-by-rpc-tool` is structurally FORBIDDEN — covered ops belong
// in a tool's _apiPaths, not in this exclusion map (Codex round 2).
const VALID_FETCH_ON_MISS_SECONDARIES = [
  'high-cardinality-input',
  'paid-upstream',
  'llm-cost',
];
const FORBIDDEN_FETCH_ON_MISS_SECONDARIES = [
  'already-covered-by-rpc-tool',
];

// -----------------------------------------------------------------------------
// HTTP-method allowlist — used by the OpenAPI walker to skip path-level siblings
// (`parameters`, `summary`, `description`, etc.) that share the methods object.
// -----------------------------------------------------------------------------
const HTTP_METHODS = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace',
]);




// -----------------------------------------------------------------------------
// Pure predicate helpers (no module-state coupling) — used by both the live
// assertions and the fixture-based meta-tests that prove each predicate
// actually fires on synthetic invalid inputs.
//
// Module-local declarations (NOT exported) per biome `noExportsInTest`. The
// describe blocks below call them directly.
// -----------------------------------------------------------------------------

/**
 * Walk every `*.openapi.json` under `specsDir` and collect operations as
 * canonical `"METHOD path"` strings. Path is the literal OpenAPI path key
 * (treated opaquely — works for `/api/<svc>/v1/<op>`, `/api/v2/<svc>/<op>`,
 * or any future shape). Method is uppercased.
 *
 * Defensive: skips malformed specs (missing/non-object `.paths`) silently
 * with a `console.warn`. Filters path-object keys through HTTP_METHODS so
 * OpenAPI siblings like `parameters` don't inflate the count.
 */
function collectApiOperations(specsDir) {
  const ops = new Set();
  let files;
  try {
    files = readdirSync(specsDir).filter((f) => f.endsWith('.openapi.json'));
  } catch {
    return ops;
  }
  for (const f of files) {
    let spec;
    try {
      spec = JSON.parse(readFileSync(join(specsDir, f), 'utf8'));
    } catch (err) {
      console.warn(`[mcp-api-parity] skipping malformed spec ${f}: ${err.message}`);
      continue;
    }
    const paths = spec?.paths;
    if (!paths || typeof paths !== 'object') continue;
    for (const path of Object.keys(paths)) {
      const pathObj = paths[path];
      if (!pathObj || typeof pathObj !== 'object') continue;
      for (const key of Object.keys(pathObj)) {
        if (HTTP_METHODS.has(key.toLowerCase())) {
          ops.add(`${key.toUpperCase()} ${path}`);
        }
      }
    }
  }
  return ops;
}

/** Aggregate every tool's `_apiPaths` into one Set<string>. */
function collectDeclaredApiPaths(toolRegistry) {
  const declared = new Set();
  for (const tool of toolRegistry) {
    if (Array.isArray(tool._apiPaths)) {
      for (const p of tool._apiPaths) declared.add(p);
    }
  }
  return declared;
}

/** API ops that are neither covered by a tool nor in the exclusion map. */
function findUncoveredApiOps({ apiOps, declaredPaths, excludedMap }) {
  const uncovered = [];
  for (const op of apiOps) {
    if (declaredPaths.has(op)) continue;
    if (excludedMap.has(op)) continue;
    uncovered.push(op);
  }
  return uncovered;
}

/** Excluded entries whose reason is empty/whitespace OR doesn't start with one of validPrefixes. */
function findEmptyOrUnprefixedReasons(excludedMap, validPrefixes) {
  const offenders = [];
  for (const [op, reason] of excludedMap) {
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      offenders.push(op);
      continue;
    }
    const hasValid = validPrefixes.some((p) => reason.startsWith(`${p}:`));
    if (!hasValid) offenders.push(op);
  }
  return offenders;
}

/** Excluded ops not present in the live OpenAPI inventory (stale exclusions). */
function findDeadExclusions({ excludedMap, apiOps }) {
  const dead = [];
  for (const op of excludedMap.keys()) {
    if (!apiOps.has(op)) dead.push(op);
  }
  return dead;
}

/** Declared `_apiPaths` entries not present in the live OpenAPI inventory (stale tool metadata). */
function findDeadApiPaths({ declaredPaths, apiOps }) {
  const dead = [];
  for (const p of declaredPaths) {
    if (!apiOps.has(p)) dead.push(p);
  }
  return dead;
}

/** `fetch-on-miss:` entries without a valid secondary signal (bare or unknown secondary). */
function findBareFetchOnMissReasons(excludedMap) {
  const offenders = [];
  for (const [op, reason] of excludedMap) {
    if (!reason.startsWith('fetch-on-miss:')) continue;
    const secondary = reason.slice('fetch-on-miss:'.length).trim();
    if (secondary.length === 0) { offenders.push(op); continue; }
    const hasValid = VALID_FETCH_ON_MISS_SECONDARIES.some(
      (sig) => secondary === sig || secondary.startsWith(`${sig} `) || secondary.startsWith(`${sig}—`),
    );
    if (!hasValid) offenders.push(op);
  }
  return offenders;
}

/** Ops declared in some tool's `_apiPaths` AND listed in the exclusion map (forbidden double-coverage).
 *  An op should be EITHER covered (in _apiPaths) OR excluded (in the map), never both. */
function findDoubleCoveredOps({ declaredPaths, excludedMap }) {
  const doubles = [];
  for (const op of declaredPaths) {
    if (excludedMap.has(op)) doubles.push(op);
  }
  return doubles;
}

/** `fetch-on-miss:` entries naming a FORBIDDEN secondary (the loophole-blocker). */
function findForbiddenFetchOnMissSecondaries(excludedMap) {
  const offenders = [];
  for (const [op, reason] of excludedMap) {
    if (!reason.startsWith('fetch-on-miss:')) continue;
    for (const forbidden of FORBIDDEN_FETCH_ON_MISS_SECONDARIES) {
      if (reason.includes(forbidden)) { offenders.push(op); break; }
    }
  }
  return offenders;
}

/** Overview category bullets include sample REST-only ops; keep those examples honest. */
function collectDocumentedExclusionExamples(markdown) {
  const examples = [];
  for (const line of markdown.split("\n")) {
    const category = line.match(/^- \*\*`([^`]+)`\*\*/)?.[1];
    if (!category || !VALID_PREFIXES.includes(category)) continue;
    const exampleText = line.split(";")[0];
    const opMatches = exampleText.matchAll(/`((?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD) \/api\/[^`]+)`/g);
    for (const match of opMatches) {
      examples.push({ category, op: match[1] });
    }
  }
  return examples;
}

// -----------------------------------------------------------------------------
// Meta-tests — verify the predicate helpers fire on synthetic invalid fixtures.
// Without these, a regression that makes a predicate a no-op (early return,
// off-by-one filter, predicate inversion) would ship undetected silently.
// -----------------------------------------------------------------------------

describe('Tier-4 meta-tests — predicates fire on synthetic invalid inputs', () => {
  // --- collectApiOperations ---
  it('collectApiOperations: empty Set for a non-existent directory', () => {
    const ops = collectApiOperations('/tmp/definitely-not-a-real-dir-mcp-parity');
    assert.equal(ops.size, 0);
  });

  it('collectApiOperations: filters non-HTTP-method path siblings (parameters, summary, description)', (t) => {
    const tmpDir = mkSpecFixture({
      paths: {
        '/api/fixture/v1/get-foo': {
          get: { operationId: 'getFoo' },
          parameters: [{ name: 'q', in: 'query' }],
          summary: 'Fixture path-level summary',
        },
        '/api/fixture/v1/multi': {
          get: { operationId: 'getMulti' },
          post: { operationId: 'postMulti' },
        },
      },
    }, t);
    const ops = collectApiOperations(tmpDir);
    assert.deepEqual([...ops].sort(), [
      'GET /api/fixture/v1/get-foo',
      'GET /api/fixture/v1/multi',
      'POST /api/fixture/v1/multi',
    ]);
  });

  it('collectApiOperations: skips malformed specs without throwing', (t) => {
    const tmpDir = mkSpecFixture('not-valid-json{{{', t);
    const ops = collectApiOperations(tmpDir);
    assert.equal(ops.size, 0);
  });

  it('collectApiOperations: skips specs with missing/null/non-object paths', (t) => {
    // Three malformed shapes that all hit the line ~70 guard. Each fixture
    // is a separate spec file so we exercise all three branches in one run.
    const cases = [
      { openapi: '3.1.0' },              // missing paths entirely
      { openapi: '3.1.0', paths: null }, // paths: null
      { openapi: '3.1.0', paths: 'oh no' }, // paths: primitive
    ];
    for (const spec of cases) {
      const tmpDir = mkSpecFixture(spec, t);
      assert.equal(collectApiOperations(tmpDir).size, 0,
        `expected empty Set for malformed paths shape ${JSON.stringify(spec.paths)}`);
    }
  });

  // --- collectDeclaredApiPaths ---
  it('collectDeclaredApiPaths: aggregates _apiPaths across cache-tool + RPC-tool registry entries', () => {
    const fakeRegistry = [
      { name: 'cache_tool', _cacheKeys: ['a:v1'], _apiPaths: ['GET /api/a/v1/x', 'GET /api/a/v1/y'] },
      { name: 'rpc_tool', _execute: () => {}, _apiPaths: ['POST /api/b/v1/z'] },
      { name: 'no_paths', _cacheKeys: ['c:v1'], _apiPaths: [] },
    ];
    const declared = collectDeclaredApiPaths(fakeRegistry);
    assert.deepEqual([...declared].sort(), ['GET /api/a/v1/x', 'GET /api/a/v1/y', 'POST /api/b/v1/z']);
  });

  // --- findUncoveredApiOps ---
  it('findUncoveredApiOps: returns the synthetic uncovered op', () => {
    const apiOps = new Set(['GET /covered', 'GET /excluded', 'GET /ghost']);
    const declaredPaths = new Set(['GET /covered']);
    const excludedMap = new Map([['GET /excluded', 'mutating: state write']]);
    const result = findUncoveredApiOps({ apiOps, declaredPaths, excludedMap });
    assert.deepEqual(result, ['GET /ghost']);
  });

  it('findUncoveredApiOps: returns empty when every op is covered or excluded', () => {
    const apiOps = new Set(['GET /covered', 'GET /excluded']);
    const declaredPaths = new Set(['GET /covered']);
    const excludedMap = new Map([['GET /excluded', 'mutating: state write']]);
    assert.deepEqual(findUncoveredApiOps({ apiOps, declaredPaths, excludedMap }), []);
  });

  // --- findEmptyOrUnprefixedReasons ---
  it('findEmptyOrUnprefixedReasons: catches empty, whitespace, and unprefixed reasons', () => {
    const excludedMap = new Map([
      ['GET /valid', 'mutating: writes state'],
      ['GET /empty', ''],
      ['GET /whitespace', '   '],
      ['GET /unprefixed', 'some bare reason without prefix'],
    ]);
    const offenders = findEmptyOrUnprefixedReasons(excludedMap, VALID_PREFIXES);
    assert.deepEqual(offenders.sort(), ['GET /empty', 'GET /unprefixed', 'GET /whitespace']);
  });

  // --- findDeadExclusions ---
  it('findDeadExclusions: catches excluded ops absent from the OpenAPI inventory', () => {
    const apiOps = new Set(['GET /live']);
    const excludedMap = new Map([
      ['GET /live', 'mutating: write'],
      ['GET /ghost', 'mutating: write'],
    ]);
    assert.deepEqual(findDeadExclusions({ excludedMap, apiOps }), ['GET /ghost']);
  });

  // --- findDeadApiPaths ---
  it('findDeadApiPaths: catches declared _apiPaths entries pointing at non-existent OpenAPI ops', () => {
    const apiOps = new Set(['GET /live']);
    const declaredPaths = new Set(['GET /live', 'GET /vanished']);
    assert.deepEqual(findDeadApiPaths({ declaredPaths, apiOps }), ['GET /vanished']);
  });

  // --- findBareFetchOnMissReasons ---
  it('findBareFetchOnMissReasons: catches bare AND unknown-secondary entries, accepts valid ones', () => {
    const excludedMap = new Map([
      ['GET /good',     'fetch-on-miss: paid-upstream — external feed'],
      ['GET /good2',    'fetch-on-miss: high-cardinality-input — arbitrary query param'],
      ['GET /bare',     'fetch-on-miss:'],
      ['GET /unknown',  'fetch-on-miss: invented-secondary — not in allowlist'],
      ['GET /other',    'mutating: write'], // not fetch-on-miss, should not be flagged
    ]);
    const offenders = findBareFetchOnMissReasons(excludedMap);
    assert.deepEqual(offenders.sort(), ['GET /bare', 'GET /unknown']);
  });

  // --- findForbiddenFetchOnMissSecondaries ---
  it('findForbiddenFetchOnMissSecondaries: catches the already-covered-by-rpc-tool loophole', () => {
    const excludedMap = new Map([
      ['GET /loophole', 'fetch-on-miss: already-covered-by-rpc-tool — by get_country_risk'],
      ['GET /ok',       'fetch-on-miss: paid-upstream'],
    ]);
    assert.deepEqual(findForbiddenFetchOnMissSecondaries(excludedMap), ['GET /loophole']);
  });

  it('findDoubleCoveredOps: catches ops in both _apiPaths and the exclusion map', () => {
    const declaredPaths = new Set(['GET /covered', 'GET /double']);
    const excludedMap = new Map([
      ['GET /excluded-only', 'mutating: writes state'],
      ['GET /double', 'mutating: should not coexist with _apiPaths'],
    ]);
    assert.deepEqual(findDoubleCoveredOps({ declaredPaths, excludedMap }), ['GET /double']);
  });
  it("collectDocumentedExclusionExamples: extracts category-scoped method/path examples", () => {
    const markdown = [
      "- **`mutating`** — Example: `GET /api/example/v1/write`.",
      "- **`fetch-on-miss`** — Examples: `GET /api/example/v1/live` and `POST /api/example/v1/batch`; sibling tool declares only `GET /api/example/v1/covered`.",
      "- **Other** — Tool `get_market_data` is not an API example.",
    ].join("\n");
    assert.deepEqual(collectDocumentedExclusionExamples(markdown), [
      { category: "mutating", op: "GET /api/example/v1/write" },
      { category: "fetch-on-miss", op: "GET /api/example/v1/live" },
      { category: "fetch-on-miss", op: "POST /api/example/v1/batch" },
    ]);
  });

});

// -----------------------------------------------------------------------------
// Fixture helpers (test-local; do not export)
// -----------------------------------------------------------------------------

function mkSpecFixture(content, t) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-parity-fixture-'));
  const body = typeof content === 'string' ? content : JSON.stringify(content);
  writeFileSync(join(dir, 'Fixture.openapi.json'), body);
  // Best-effort cleanup. node:test's TestContext.after fires post-test;
  // failure is non-fatal (CI runners typically clean /tmp anyway).
  if (t && typeof t.after === 'function') {
    t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  }
  return dir;
}
