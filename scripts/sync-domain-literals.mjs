#!/usr/bin/env node
// Rewrites the legacy hardcoded `worldmonitor.app` domain literals still
// baked into CSP configs and the live contact address into their
// APP_DOMAIN-derived equivalents, via shared/domain-config.js.
//
// Why literal substitution instead of a templating engine: most target
// files (JSON catalogs, CSP directive strings that mix domain-derived
// origins with static third-party ones) aren't structured enough to
// template cleanly, and don't need to be — each one only ever contains
// the OLD domain as a handful of predictable substrings (an origin URL,
// a bare hostname). Swapping those substrings for their domain-config-
// computed equivalents leaves everything else (prose, third-party CSP
// origins, JSON structure) untouched, byte for byte, which is far more
// auditable than reconstructing whole CSP directives or JSON fields from
// scratch.
//
// This is a true no-op when APP_DOMAIN is unset/still 'worldmonitor.app'
// locally (see .env's APP_DOMAIN, set to match this machine's currently-
// deployed content per the domain-config Stage 1 session) — the computed
// replacement values equal the literals already in these files, so
// String.prototype.replaceAll finds nothing to change. The real migration
// happens the day APP_DOMAIN is set to something else and this script is
// re-run.
//
// Same --check/write convention as scripts/sync-csp-script-hashes.mjs and
// scripts/sync-domain-config.mjs — but unlike those two, this is a ONE-TIME
// migration tool, not a continuous generator: it only detects/fixes the
// original hardcoded LEGACY_DOMAIN literal, not general drift against
// whatever APP_DOMAIN is currently configured. Once a file has been
// migrated to some domain (correct or not), re-running finds no more
// LEGACY_DOMAIN occurrences and reports clean — it cannot tell "already on
// the intended domain" from "on some other stale domain". That's fine for
// its actual job (retiring the old brand, once, when a real domain is
// picked) but means --check is not a substitute for re-running this script
// by hand after any future APP_DOMAIN change.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeDomain,
  resolveAppOrigin,
  resolveWwwOrigin,
  resolveApiOrigin,
  resolveAbacusOrigin,
  resolveVariantOrigin,
  VARIANT_SLUGS,
} from '../shared/domain-config.js';

const CHECK_ONLY = process.argv.includes('--check');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

// The legacy literal this fork shipped with, hardcoded here deliberately —
// this script's entire job is knowing the "from" value so everything else
// (shared/domain-config.js included) never has to.
const LEGACY_DOMAIN = 'worldmonitor.app';

function buildTargetFiles() {
  return [
    // CSP configs — literal domain tokens mixed with static third-party origins.
    'vercel.json',
    'public/wm-widget-sandbox.html',
    'index.html',
    // Live contact address — the bare-hostname rule below turns
    // "monitor@worldmonitor.app" into "monitor@<APP_DOMAIN>" automatically.
    // Both copies included so tests/scripts-shared-mirror.test.mjs's
    // byte-identical requirement (Railway's rootDirectory=scripts can't see
    // repo-root shared/) never desyncs after this script runs. Only the
    // `email` field is domain-derived — `application` deliberately stays
    // brand-free (see seed-conflict-intel.mjs's HDX HAPI 429 comment); this
    // script's substitutions never touch that field since it doesn't
    // contain the literal `worldmonitor.app`.
    'shared/hapi-app-identifier.json',
    'scripts/shared/hapi-app-identifier.json',
  ];
}

function buildSubstitutions(rawDomain) {
  // Order matters: most-specific (scheme + subdomain) first, bare hostname
  // last — once a longer match is replaced, the bare-domain suffix no
  // longer appears in that spot for the final rule to (correctly) skip.
  const pairs = [
    [`https://abacus.${LEGACY_DOMAIN}`, resolveAbacusOrigin(rawDomain)],
    [`https://api.${LEGACY_DOMAIN}`, resolveApiOrigin(rawDomain)],
    [`https://www.${LEGACY_DOMAIN}`, resolveWwwOrigin(rawDomain)],
    ...VARIANT_SLUGS.map((slug) => [`https://${slug}.${LEGACY_DOMAIN}`, resolveVariantOrigin(rawDomain, slug)]),
    [`https://${LEGACY_DOMAIN}`, resolveAppOrigin(rawDomain)],
    // Catches bare (no-scheme) mentions: did:web:worldmonitor.app,
    // urn:air:worldmonitor.app:..., a bare Sitemap: host, etc.
    [LEGACY_DOMAIN, normalizeDomain(rawDomain)],
  ];
  return pairs.filter(([from, to]) => from !== to);
}

function applySubstitutions(source, substitutions) {
  let result = source;
  let changed = false;
  for (const [from, to] of substitutions) {
    if (result.includes(from)) {
      result = result.replaceAll(from, to);
      changed = true;
    }
  }
  return { result, changed };
}

async function main() {
  const rawDomain = process.env.APP_DOMAIN;
  const substitutions = buildSubstitutions(rawDomain);
  const targetFiles = buildTargetFiles();

  const results = [];
  for (const file of targetFiles) {
    const filePath = path.join(repoRoot, file);
    const source = await readFile(filePath, 'utf-8');
    const { result, changed } = applySubstitutions(source, substitutions);
    results.push({ file, result, changed });
  }

  const changedFiles = results.filter((r) => r.changed);

  if (CHECK_ONLY) {
    if (changedFiles.length > 0) {
      console.error('[sync:domain-literals:check] Files still contain stale domain literals:');
      for (const { file } of changedFiles) {
        console.error(`- ${file}`);
      }
      console.error('Run `npm run sync:domain-literals` to fix.');
      process.exit(1);
    }
    console.log(`[sync:domain-literals:check] OK. All ${targetFiles.length} files already reflect APP_DOMAIN.`);
    return;
  }

  if (changedFiles.length === 0) {
    console.log(`[sync:domain-literals] No changes needed. All ${targetFiles.length} files already in sync.`);
    return;
  }

  for (const { file, result } of changedFiles) {
    await writeFile(path.join(repoRoot, file), result, 'utf-8');
  }

  console.log(`[sync:domain-literals] Synced ${changedFiles.length}/${targetFiles.length} files.`);
  for (const { file } of changedFiles) {
    console.log(`- ${file}`);
  }
}

main().catch((error) => {
  console.error(`[sync:domain-literals] Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
