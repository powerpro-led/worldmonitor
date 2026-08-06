/**
 * Shared by both api/ adapters (adapt-vercel-handler.ts, adapt-node-handler.ts).
 *
 * Nitric's `HttpContext.req.query` is TYPED as `Record<string, string[]>`
 * (node_modules/@nitric/sdk/lib/index.d.ts), but a live `nitric start` local
 * dev membrane was observed (2026-08-06, while wiring api/og-story.js /
 * api/story.js) actually delivering plain STRINGS for single-valued query
 * params, e.g. `{ c: "US" }` rather than `{ c: ["US"] }`. Naively iterating
 * `for (const value of values)` when `values` is a bare string iterates its
 * individual CHARACTERS — confirmed with `?testparam=multichar123` producing
 * `testparam=m&testparam=u&testparam=l&...` once reconstructed, silently
 * truncating every multi-character GET query param to its first character.
 * This affected `adapt-vercel-handler.ts` (and therefore all 105 routes in
 * routes.generated.ts) before this fix — not something introduced by this
 * pass, but found and fixed here since the bug was in code this pass depends
 * on. See docs/architecture/nitric-gcp-scaffold.md.
 *
 * Handles both shapes defensively rather than trusting either the type or
 * the one observed runtime — `nitric start`'s local membrane and the real
 * GCP-deployed one are not guaranteed to agree, and this hasn't been
 * verified against a live Cloud Run deploy.
 */
export function appendQueryParams(target: URLSearchParams, query: Record<string, string[] | string> | undefined): void {
  for (const [key, values] of Object.entries(query ?? {})) {
    const valueList = Array.isArray(values) ? values : [values];
    for (const value of valueList) {
      if (value !== undefined) target.append(key, value);
    }
  }
}
