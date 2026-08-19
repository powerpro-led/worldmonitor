import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function readScript(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf-8');
}

describe('warm-ping seed scripts', () => {
  it('sends the app Origin header for infrastructure warm-pings', () => {
    // seed-infra.mjs retired 2026-08-19 (session 26) -- its one non-redundant
    // target (list-temporal-anomalies) folded into ais-relay.cjs's own
    // warm-ping loop, see TASKS.md's "orphaned crons" item 5.
    const src = readScript('scripts/ais-relay.cjs');
    assert.match(src, /Origin:\s*resolveAppOrigin\(process\.env\.APP_DOMAIN\)/);
    assert.match(src, /method:\s*'POST'/);
    assert.match(src, /\/api\/infrastructure\/v1\/list-temporal-anomalies/);
  });

  it('sends the app Origin header for military/maritime warm-pings', () => {
    const src = readScript('scripts/seed-military-maritime-news.mjs');
    assert.match(src, /Origin:\s*resolveAppOrigin\(process\.env\.APP_DOMAIN\)/);
    assert.match(src, /method:\s*'POST'/);
  });

  // A warm-ping seeder is a best-effort cache warmer: it owns no Redis keys to
  // extend, so a missed ping loses no data and must NOT hard-crash Railway.
  // The fleet convention (see seed-service-statuses.mjs) is exit(0) + a
  // grep-able WARN marker for log-alerting, NOT a non-zero exit on total
  // failure. seed-infra.mjs dropped from this list 2026-08-19 (session 26,
  // retired -- see the test above) -- its warm-ping now lives inside
  // ais-relay.cjs, a long-running relay process that doesn't call
  // process.exit() at all, so this convention doesn't apply to it.
  for (const script of ['scripts/seed-military-maritime-news.mjs']) {
    it(`${script} exits 0 (best-effort) and never hard-crashes on total warm-ping failure`, () => {
      const src = readScript(script);
      assert.match(
        src,
        /WARN: all warm-pings failed/,
        'must emit a grep-able WARN marker so persistent breakage is caught via log alert, not exit code',
      );
      // Durable invariant: the script must call process.exit, and EVERY call
      // must be exit(0). Extracting the literal arg catches exit(1), the old
      // `exit(ok > 0 ? 0 : 1)` ternary, exit(143), etc. — not just one spelling —
      // so no refactor can quietly re-introduce a hard crash on total failure.
      const exitArgs = [...src.matchAll(/process\.exit\(([^)]*)\)/g)].map((m) => m[1].trim());
      assert.ok(exitArgs.length > 0, 'must call process.exit');
      for (const arg of exitArgs) {
        assert.equal(
          arg,
          '0',
          `warm-ping seeders must never exit non-zero (best-effort cache warmer — a missed ping loses no data); found process.exit(${arg})`,
        );
      }
    });
  }
});
