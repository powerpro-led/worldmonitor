// Declaration file for sync-domains.mjs so TS callers (server/_shared/sync-notify.ts)
// don't need `// @ts-expect-error`. Kept hand-written (no .d.ts.map) because
// the shim is a flat const/function export module — same pattern as
// scripts/_simulation-queue-constants.d.mts.

export const SYNC_PREFIXES: readonly string[];
export function isMirroredKey(key: string): boolean;
