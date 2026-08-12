/**
 * Curated list of sandbox operations that public/sandbox/*.json fixtures
 * exist for.
 *
 * This used to be an executable generator that rebuilt the fixtures from the
 * generated OpenAPI service specs (docs/api/<Service>.openapi.json) so the
 * sandbox could never drift from the published API contract — see
 * tests/sandbox-fixtures.test.mjs, which byte-diffed the output. The OpenAPI
 * generation pipeline (docs/api/) was retired along with the rest of the
 * public API docs product (private fork, no public API docs), so that
 * generator has no source to regenerate from anymore and has been removed.
 *
 * SANDBOX_OPERATIONS is kept as the list of operations the already-committed
 * public/sandbox/*.json fixtures cover; tests/sandbox-fixtures.test.mjs
 * imports it to validate those fixtures are still internally consistent.
 */
export const SANDBOX_OPERATIONS = [
  '/api/resilience/v1/get-resilience-score',
  '/api/resilience/v1/get-resilience-ranking',
  '/api/intelligence/v1/get-country-risk',
  '/api/intelligence/v1/get-country-intel-brief',
  '/api/market/v1/list-market-quotes',
  '/api/conflict/v1/list-acled-events',
  '/api/supply-chain/v1/get-chokepoint-status',
  '/api/forecast/v1/get-forecasts',
];
