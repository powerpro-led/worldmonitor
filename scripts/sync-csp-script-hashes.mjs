#!/usr/bin/env node
// Derives the CSP script-src sha256 hash allowlist from the un-nonced inline
// <script> bodies actually shipped in the HTML entry points, then writes that
// exact set into the 3 files that must stay in byte-identical sync:
// vercel.json, docker/nginx-security-headers.conf, docker/nginx.conf.
//
// Why this exists: those 3 files used to be hand-edited independently.
// Editing any inline <script> in index.html (including JSON-LD
// <script type="application/ld+json"> blocks) changes that script's hash,
// and it's easy to update one file, run the no-op `npm test` path, and ship
// a CSP mismatch that only tests/deploy-config.test.mjs catches. See
// TASKS.md's "CSP script-src hash allowlist" entry for the regression this
// tooling replaces.
//
// The HTML file list and hash-extraction logic here must stay in sync with
// GLOBAL_CSP_INLINE_SCRIPT_HTML_FILES / getInlineScriptHashTokens in
// tests/deploy-config.test.mjs — that test is the source of truth for
// correctness; this script is the source of truth for not having to do it
// by hand.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK_ONLY = process.argv.includes('--check');

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const GLOBAL_CSP_INLINE_SCRIPT_HTML_FILES = [
  'index.html',
  'settings.html',
  'live-channels.html',
  'public/offline.html',
];

const STATIC_SCRIPT_NONCE = 'wm-static-bootstrap';

const TARGET_FILES = [
  { file: 'vercel.json', label: 'vercel.json' },
  { file: 'docker/nginx-security-headers.conf', label: 'docker/nginx-security-headers.conf' },
  { file: 'docker/nginx.conf', label: 'docker/nginx.conf' },
];

const hasTrustedStaticNonce = (attributes) => (
  new RegExp(`\\bnonce=["']${STATIC_SCRIPT_NONCE}["']`).test(attributes)
);

function getInlineScriptHashTokens(htmlSource) {
  return [...htmlSource.matchAll(/<script\b(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !hasTrustedStaticNonce(match[1]))
    .map((match) => match[2])
    .filter((body) => body.trim().length > 0)
    .map((body) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`);
}

// Replaces the contiguous run of 'sha256-...' tokens inside each script-src
// directive with the new set. Token order carries no CSP meaning, so this
// is a true no-op (byte-identical output) when the set of hashes is already
// correct, regardless of order — it only rewrites the segment when the set
// actually changed, and even then preserves each file's existing order for
// hashes that are still valid, only dropping stale ones and appending new
// ones at the end. That keeps a real hash update's diff minimal instead of
// reshuffling the whole allowlist on every run. Leaves every other token
// ('self', 'strict-dynamic', the nonce, 'wasm-unsafe-eval', ...) untouched.
// Only touches script-src directives that already carry hash tokens (some
// docker/nginx.conf location blocks intentionally ship a bare `script-src
// 'self'` with no inline scripts to allow — those are left alone).
function replaceHashesInCsp(source, newHashTokens) {
  const newHashSet = new Set(newHashTokens);
  let changed = false;
  const updated = source.replace(
    /(script-src(?:[^;"]*?))((?:'sha256-[^']+'\s*)+)/g,
    (full, prefix, hashSegment) => {
      const existingTokens = hashSegment.trim().split(/\s+/);
      const existingSet = new Set(existingTokens);
      const setsMatch = existingSet.size === newHashSet.size
        && existingTokens.every((token) => newHashSet.has(token));
      if (setsMatch) return full;

      changed = true;
      const kept = existingTokens.filter((token) => newHashSet.has(token));
      const added = newHashTokens.filter((token) => !existingSet.has(token));
      return `${prefix}${[...kept, ...added].join(' ')} `;
    }
  );
  return { updated, changed };
}

async function main() {
  // Dedup via Set (which preserves first-seen order) rather than sorting —
  // CSP token order has no semantic meaning, but keeping first-seen order
  // means a re-run that finds no actual script changes produces a byte-
  // identical file instead of needlessly reordering the allowlist. The test
  // suite (tests/deploy-config.test.mjs) sorts both sides before comparing,
  // so it doesn't care which order this script picks.
  const orderedHtmlHashes = [];
  for (const file of GLOBAL_CSP_INLINE_SCRIPT_HTML_FILES) {
    const html = await readFile(path.join(repoRoot, file), 'utf-8');
    orderedHtmlHashes.push(...getInlineScriptHashTokens(html));
  }
  const inlineHashTokens = [...new Set(orderedHtmlHashes)];

  if (inlineHashTokens.length === 0) {
    throw new Error('Expected at least one inline script hash across ' + GLOBAL_CSP_INLINE_SCRIPT_HTML_FILES.join(', '));
  }

  const results = [];
  for (const { file, label } of TARGET_FILES) {
    const filePath = path.join(repoRoot, file);
    const source = await readFile(filePath, 'utf-8');
    const { updated, changed } = replaceHashesInCsp(source, inlineHashTokens);
    results.push({ file, label, updated, changed });
  }

  const changedFiles = results.filter((r) => r.changed);

  if (CHECK_ONLY) {
    if (changedFiles.length > 0) {
      console.error('[sync:csp-hashes:check] CSP script-src hashes are out of sync:');
      for (const { label } of changedFiles) {
        console.error(`- ${label}`);
      }
      console.error('Run `npm run sync:csp-hashes` to fix.');
      process.exit(1);
    }
    console.log(`[sync:csp-hashes:check] OK. All ${TARGET_FILES.length} files match the ${inlineHashTokens.length} inline script hashes.`);
    return;
  }

  if (changedFiles.length === 0) {
    console.log(`[sync:csp-hashes] No changes needed. All ${TARGET_FILES.length} files already in sync.`);
    return;
  }

  for (const { file, updated } of changedFiles) {
    await writeFile(path.join(repoRoot, file), updated, 'utf-8');
  }

  console.log(`[sync:csp-hashes] Synced CSP script-src hashes (${inlineHashTokens.length} hashes).`);
  for (const { label } of changedFiles) {
    console.log(`- ${label}`);
  }
}

main().catch((error) => {
  console.error(`[sync:csp-hashes] Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
