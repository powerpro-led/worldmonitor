// Shared APP_DOMAIN test fixture for anything exercising shared/domain-config.js
// (directly, or via api/_cors.js, server/cors.ts, workers/api-cors-preflight,
// or scripts/build-content-corpus-sitemap.mjs).
//
// Deliberately neither the real (legacy, not-operator-controlled) brand nor
// the module's own localhost:3000 default, so an assertion using this value
// can't accidentally pass against either "the old brand" or "the fallback" —
// only against an explicit, intentional test configuration.
export const TEST_APP_DOMAIN = 'example.test';

export function setTestAppDomain(domain = TEST_APP_DOMAIN) {
  process.env.APP_DOMAIN = domain;
}
