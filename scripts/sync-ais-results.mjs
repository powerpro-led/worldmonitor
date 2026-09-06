#!/usr/bin/env node

/**
 * AIS-results bridge — per-org `--once` job (P14 Phase 2 tail / decision P17).
 *
 * The AIS WebSocket ingest (scripts/ais-relay.cjs) runs as ONE shared deploy
 * across all orgs — the vessel feed is public and identical per tenant, and a
 * single persistent socket is the one genuinely long-running piece of the
 * stack. It writes its pure-AIS output (chokepoint transit counts) into a
 * shared "AIS results" Upstash. It holds only its OWN credentials — it never
 * writes into a tenant DB (that would put every tenant's write token in one
 * process, the largest deviation from P10's per-GH-Environment isolation).
 *
 * This job bridges that shared output into THIS org's Upstash, so
 * scripts/seed-transit-summaries.mjs (per-org) and get-chokepoint-status (via
 * the operator mirror) read it locally like any other seeded key. It costs one
 * extra hop + the ~30-60s staleness the P8 streaming path already accepts.
 *
 * Env:
 *   AIS_RESULTS_UPSTASH_REST_URL            — the shared "AIS results" DB (read)
 *   AIS_RESULTS_UPSTASH_READONLY_TOKEN      — read-only token for it
 *   UPSTASH_REDIS_REST_URL / _TOKEN         — THIS org's DB (write) — already
 *                                             present for every per-org deploy
 *
 * Not runSeed / not a seeder: it computes nothing, it copies bytes. Exit 0
 * when the canonical key was bridged; exit 1 when it could not be read (the
 * shared ingest is down or misconfigured — surface it, don't mask it as an
 * empty success).
 */

import { createRequire } from 'node:module';
import { loadEnvFile, getRedisCredentials, notifyChange } from './_seed-utils.mjs';

const require = createRequire(import.meta.url);
const { AIS_RESULTS_KEYS } = require('./shared/sync-domains.mjs');

loadEnvFile(import.meta.url);

// Re-applied TTLs on the org side. Match ais-relay.cjs's own writes:
// CHOKEPOINT_TRANSIT_TTL (3600) for the canonical, 604800 for the seed-meta.
const TTL_BY_KEY = {
  'supply_chain:chokepoint_transits:v1': 3600,
  'seed-meta:supply_chain:chokepoint_transits': 604_800,
};
const DEFAULT_TTL = 3600;
const CANONICAL_KEY = 'supply_chain:chokepoint_transits:v1';

function sharedCreds() {
  const url = process.env.AIS_RESULTS_UPSTASH_REST_URL;
  const token = process.env.AIS_RESULTS_UPSTASH_READONLY_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

/** Raw GET — returns the stored string verbatim (no parse, no envelope unwrap). */
async function rawGet(creds, key) {
  const resp = await fetch(`${creds.url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${creds.token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`AIS-results GET ${key}: HTTP ${resp.status}`);
  const data = await resp.json();
  return data.result ?? null; // null = genuine miss
}

async function rawSet(url, token, key, value, ttlSeconds) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', key, value, 'EX', ttlSeconds]),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`org SET ${key}: HTTP ${resp.status}`);
}

export async function main() {
  const shared = sharedCreds();
  if (!shared) {
    console.log('[sync-ais-results] AIS_RESULTS_UPSTASH_REST_URL/READONLY_TOKEN not set — nothing to bridge (no-op)');
    return;
  }
  const org = getRedisCredentials(); // throws if this org's creds are missing

  let canonicalBridged = false;
  let bridged = 0;
  for (const key of AIS_RESULTS_KEYS) {
    let value;
    try {
      value = await rawGet(shared, key);
    } catch (e) {
      console.warn(`[sync-ais-results] read failed for ${key}: ${e?.message || e}`);
      continue;
    }
    if (value == null) {
      console.warn(`[sync-ais-results] ${key} absent in the shared store — skipping`);
      continue;
    }
    try {
      const ttl = TTL_BY_KEY[key] ?? DEFAULT_TTL;
      await rawSet(org.url, org.token, key, value, ttl);
      // Fast-path push nudge so operator mirrors pick it up without a full
      // rescan (same pattern as _seed-utils.mjs writeExtraKey).
      notifyChange(org.url, org.token, key, value).catch((err) => {
        console.warn(`  [sync-notify] ${key}: best-effort push failed (non-fatal): ${err.message}`);
      });
      bridged++;
      if (key === CANONICAL_KEY) canonicalBridged = true;
    } catch (e) {
      console.warn(`[sync-ais-results] write failed for ${key}: ${e?.message || e}`);
    }
  }

  console.log(`[sync-ais-results] bridged ${bridged}/${AIS_RESULTS_KEYS.length} keys shared → org`);
  if (!canonicalBridged) {
    throw new Error(`${CANONICAL_KEY} was not bridged — shared AIS ingest down or misconfigured`);
  }
}

if (process.argv[1]?.endsWith('sync-ais-results.mjs')) {
  main().catch((err) => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}
