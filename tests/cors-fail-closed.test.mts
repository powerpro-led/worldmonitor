import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { getCorsHeaders, isAllowedOrigin } from '../server/cors.ts';
import { isDisallowedOrigin as isDisallowedOriginJs } from '../api/_cors.js';
import { setTestAppDomain, TEST_APP_DOMAIN } from './helpers/domain-config.mjs';

// Safe even though the above are static imports: server/cors.ts and
// api/_cors.js both read process.env.APP_DOMAIN lazily (per-call, not at
// module load), so setting it here takes effect for every call below.
setTestAppDomain();

// Regression coverage for issue #3705: CORS-header generation errors must
// fail closed rather than fall back to a wildcard ACAO.

// Named for self-documenting failure messages and so a future companion
// guard elsewhere can re-use the same shape.
const WILDCARD_ACAO_LITERAL = /Access-Control-Allow-Origin['"]?\s*:\s*['"]\*['"]/i;

// Strip JS line and block comments so the wildcard-literal guard only
// fires on real code, not on a comment that documents the anti-pattern
// (e.g. a future PR description quoted in JSDoc above the fail-closed
// branch). This keeps the test honest if someone documents the original
// bug verbatim while keeping the fix intact.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('cors helper', () => {
  it('returns headers for a well-formed request', () => {
    const req = new Request(`https://${TEST_APP_DOMAIN}/x`, {
      headers: { Origin: `https://${TEST_APP_DOMAIN}` },
    });
    const headers = getCorsHeaders(req);
    assert.equal(headers['Access-Control-Allow-Origin'], `https://${TEST_APP_DOMAIN}`);
    assert.match(
      headers['Access-Control-Allow-Headers'],
      /(?:^|,\s*)Idempotency-Key(?:,|$)/,
      'browser clients must be allowed to send Idempotency-Key on POST preflights',
    );
    assert.match(
      headers['Access-Control-Expose-Headers'],
      /(?:^|,\s*)Idempotency-Key(?:,|$)/,
      'browser clients must be able to read echoed Idempotency-Key',
    );
    assert.match(
      headers['Access-Control-Expose-Headers'],
      /(?:^|,\s*)Idempotent-Replayed(?:,|$)/,
      'browser clients must be able to read idempotent replay status',
    );
    assert.match(
      headers['Access-Control-Expose-Headers'],
      /(?:^|,\s*)X-RateLimit-Limit(?:,|$)/,
      'browser clients must be able to read rate-limit ceilings',
    );
    assert.match(
      headers['Access-Control-Expose-Headers'],
      /(?:^|,\s*)X-RateLimit-Remaining(?:,|$)/,
      'browser clients must be able to read remaining rate-limit budget',
    );
    assert.match(
      headers['Access-Control-Expose-Headers'],
      /(?:^|,\s*)X-RateLimit-Reset(?:,|$)/,
      'browser clients must be able to read rate-limit reset timestamps',
    );
  });

  it('propagates exceptions (caller must wrap in fail-closed try/catch)', () => {
    const throwingReq = {
      headers: {
        get(): string {
          throw new Error('simulated header failure');
        },
      },
    } as unknown as Request;
    assert.throws(() => getCorsHeaders(throwingReq), /simulated header failure/);
  });
});

// The Vercel project moved from the personal scope (worldmonitor-*-elie-<hash>)
// to the "eliewm" team scope. Browsers send Origin on the POST to
// /api/wm-session, so a stale allowlist 403s every preview deployment and the
// anonymous session can never be minted (dashboard + /welcome teasers stay dark).
describe('isAllowedOrigin — Vercel preview allowlist (eliewm team scope)', () => {
  // Origin for the JS twin (api/_cors.js exports isDisallowedOrigin, not the
  // bare predicate) — same allow/deny outcome proves both files stay in sync.
  const allowedByJsTwin = (origin: string) =>
    !isDisallowedOriginJs(new Request(`https://${TEST_APP_DOMAIN}/x`, { headers: { Origin: origin } }));

  const ALLOWED = [
    ['git-branch alias URL', 'https://worldmonitor-git-feature-eliewm.vercel.app'],
    ['hash deployment URL', 'https://worldmonitor-abc123def456-eliewm.vercel.app'],
    ['apex production origin', `https://${TEST_APP_DOMAIN}`],
    ['production subdomain', `https://tech.${TEST_APP_DOMAIN}`],
  ];

  const REJECTED = [
    ['non-worldmonitor vercel.app origin', 'https://some-other-app-eliewm.vercel.app'],
    ['foreign team scope', 'https://worldmonitor-git-feature-attacker.vercel.app'],
    ['bare worldmonitor vercel.app (no scope segment)', 'https://worldmonitor.vercel.app'],
    ['suffix-spoofed eliewm origin', 'https://worldmonitor-git-feature-eliewm.vercel.app.evil.com'],
    ['dead personal-scope preview (post-migration)', 'https://worldmonitor-feature-elie-abc123.vercel.app'],
  ];

  for (const [label, origin] of ALLOWED) {
    it(`allows ${label}`, () => {
      assert.equal(isAllowedOrigin(origin), true, `server/cors.ts must allow ${origin}`);
      assert.equal(allowedByJsTwin(origin), true, `api/_cors.js must allow ${origin}`);
    });
  }

  for (const [label, origin] of REJECTED) {
    it(`rejects ${label}`, () => {
      assert.equal(isAllowedOrigin(origin), false, `server/cors.ts must reject ${origin}`);
      assert.equal(allowedByJsTwin(origin), false, `api/_cors.js must reject ${origin}`);
    });
  }
});

describe('CORS twin parity — eliewm preview pattern stays tight in both twins', () => {
  // Root cause of the original 403s was twins drifting. These surfaces gate
  // Vercel-preview CORS and must move together; guard each for:
  // (1) the eliewm-scoped preview pattern is present, and
  // (2) no bare *.vercel.app wildcard sneaks in as a "fix".
  // The Cloudflare CORS Worker used to be the third (load-bearing) twin here —
  // retired along with workers/api-cors-preflight/, see TASKS.md.
  const TWINS = [
    '../server/cors.ts',
    '../api/_cors.js',
  ];

  for (const rel of TWINS) {
    it(`${rel} scopes Vercel previews to the eliewm team`, async () => {
      const source = await readFile(new URL(rel, import.meta.url), 'utf8');
      assert.ok(
        source.includes('-eliewm\\.vercel\\.app'),
        `${rel} must allow worldmonitor-*-eliewm.vercel.app previews`,
      );
      assert.ok(
        !source.includes('worldmonitor-[a-z0-9-]+\\.vercel\\.app'),
        `${rel} must not widen to a bare *.vercel.app wildcard (security allowlist)`,
      );
    });
  }
});

// The old "CORS Worker superset invariant — edge allowlist ⊇ function
// allowlist" describe block lived here — workers/api-cors-preflight/ was
// retired along with the Cloudflare CORS Worker deployment it backed (see
// TASKS.md). Nothing left to guard.

describe('gateway CORS error path (issue #3705)', () => {
  it('does not contain a wildcard ACAO fallback in source (comments stripped)', async () => {
    const source = await readFile(
      new URL('../server/gateway.ts', import.meta.url),
      'utf8',
    );
    // The pre-#3705 fallback was:
    //   corsHeaders = { 'Access-Control-Allow-Origin': '*' };
    // After stripping comments, no such literal should remain — that
    // would mean the wildcard widening regressed back into real code.
    assert.ok(
      !WILDCARD_ACAO_LITERAL.test(stripComments(source)),
      'gateway.ts must not emit wildcard ACAO in code — see issue #3705',
    );
  });

  it('routes CORS exceptions through captureSilentError + 500 (no wildcard)', async () => {
    const source = await readFile(
      new URL('../server/gateway.ts', import.meta.url),
      'utf8',
    );
    // The fail-closed branch must log the original error to Sentry AND
    // return a 5xx instead of a permissive CORS response. The gap is
    // bounded so we can tolerate minor refactoring inside the catch
    // (additional tags, intermediate variable names) without losing
    // the structural assertion.
    assert.ok(
      /catch \(err\)[\s\S]{0,500}captureSilentError\(err/.test(source),
      'gateway.ts cors catch must pass the original error to captureSilentError',
    );
    assert.ok(
      /step:\s*['"]cors_headers['"]/.test(source),
      'gateway.ts cors catch must tag Sentry events with step="cors_headers"',
    );
  });

  it('returns a non-cacheable 500 on CORS error so CDNs cannot pin it', async () => {
    const source = await readFile(
      new URL('../server/gateway.ts', import.meta.url),
      'utf8',
    );
    // Find the catch block for cors_headers and assert Cache-Control:
    // no-store appears inside the response headers within it.
    const catchBlock = source.match(/catch \(err\)[\s\S]{0,1500}?\n\s{4}\}/);
    assert.ok(catchBlock, 'expected to find the cors catch block in gateway.ts');
    assert.ok(
      /['"]Cache-Control['"]:\s*['"]no-store['"]/.test(catchBlock![0]),
      'cors fail-closed 500 must set Cache-Control: no-store',
    );
  });
});
