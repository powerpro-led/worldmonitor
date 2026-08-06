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
import mcpHandler from '../../api/mcp';

const apiGateway = api('api');
registerGeneratedRoutes(apiGateway);

const mcpGateway = api('mcp');
const mcpRoute = mcpGateway.route('/api/mcp');
mcpRoute.get(adaptVercelHandler(mcpHandler));
mcpRoute.post(adaptVercelHandler(mcpHandler));
mcpRoute.options(adaptVercelHandler(mcpHandler));
