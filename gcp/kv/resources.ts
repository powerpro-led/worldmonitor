/**
 * Nitric-managed kv() resource declaration — the eventual Upstash Redis
 * replacement per docs/architecture/operator-space.md.
 *
 * NOT wired into anything this pass. `server/_shared/redis.ts` (the
 * existing Upstash client, ~101 call sites across api/scripts/server) keeps
 * talking to Upstash unchanged. Swapping its implementation to call this kv()
 * resource instead is real behavioral work — different command shape
 * (ioredis/Upstash REST commands vs. Nitric's get/set/delete/scan) — and is
 * deliberately deferred to a follow-up stage, not attempted in this
 * scaffold-only pass. Declared here only so `nitric build` has a concrete
 * resource to validate against and the shape is visible for that follow-up.
 *
 * operator-space.md's "cap/rolling-window discipline" note applies here:
 * every collection-shaped key ported to this store needs to carry over its
 * existing MAX_* cap (UCDP_MAX_EVENTS, OREF_PERSIST_MAX_WAVES, etc.) — that's
 * convention, not automatic, and is a checklist item for the real port, not
 * this scaffold.
 */

import { kv } from '@nitric/sdk';

export const appKv = kv('worldmonitor-store').allow('get', 'set', 'delete');
