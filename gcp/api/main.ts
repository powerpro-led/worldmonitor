/**
 * worldmonitor's Nitric API gateway entrypoint (Cloud Run, matched by
 * nitric.yaml's `services: - match: gcp/api/main.ts`).
 *
 * Two gateways, mirroring platform/backend's per-concern split of
 * `dataApi`/`workflowsApi`:
 *   - `api`  — everything under api/ that routes.generated.ts could pick up
 *              mechanically (105 routes as of the last regeneration — see
 *              that file's header for the current count and skip list).
 *   - `mcp`  — api/mcp.ts alone. Kept separate because operator-space.md
 *              calls this out as worldmonitor's most-finished, most
 *              agent-facing surface (already-shipped OAuth + `wm_…` key
 *              auth, 41 tools) — worth its own timeout/scaling config later
 *              rather than inheriting the general API gateway's defaults.
 *
 * Scaffold-only pass — see docs/architecture/nitric-gcp-scaffold.md.
 */

import { api } from '@nitric/sdk';
import { registerGeneratedRoutes } from './routes.generated';
import { adaptVercelHandler } from './adapt-vercel-handler';
import { adaptNodeHandler } from './adapt-node-handler';
import mcpHandler from '../../api/mcp';
// @ts-expect-error — JS module, no declaration file
import ogStoryHandler from '../../api/og-story.js';
// @ts-expect-error — JS module, no declaration file
import storyHandler from '../../api/story.js';

const apiGateway = api('api');
registerGeneratedRoutes(apiGateway);

const mcpGateway = api('mcp');
const mcpRoute = mcpGateway.route('/api/mcp');
mcpRoute.get(adaptVercelHandler(mcpHandler));
mcpRoute.post(adaptVercelHandler(mcpHandler));
mcpRoute.options(adaptVercelHandler(mcpHandler));

// api/og-story.js + api/story.js: Vercel Node.js serverless functions (no
// `runtime: 'edge'` config), skipped by generate-nitric-routes.mjs — see that
// script's header. Hand-wired here via adapt-node-handler.ts instead of
// adapt-vercel-handler.ts. GET only: both are fetched via <img>/<meta> tag
// navigation or direct crawler requests, never any other verb, and neither
// handler branches on req.method.
apiGateway.route('/api/og-story').get(adaptNodeHandler(ogStoryHandler));
apiGateway.route('/api/story').get(adaptNodeHandler(storyHandler));

// api/[...notfound].ts — NOT wired here. Confirmed 2026-08-06 (empirically,
// against a live `nitric start`, not guessed from docs which say nothing
// either way): Nitric's route matcher has no wildcard/multi-segment syntax
// at all. `:path*`, `*`, and `*catchall` were each tried on a dedicated test
// route and none matched anything beyond one literal segment — every one
// left a deeper/unmatched sub-path 500ing with "no worker registered for Api
// api on route" (Nitric's own local-dev error, not the structured JSON 404
// api/not-found.ts produces). This is a genuine Nitric platform limitation,
// not a gap in generate-nitric-routes.mjs — there is currently no way to
// register this handler for arbitrary unmatched paths. Whether GCP's actual
// deployed ingress (once a real `nitric up` happens) returns something less
// raw than the local membrane's 500 is unverified — check that for real
// before assuming either way. See docs/architecture/nitric-gcp-scaffold.md.
