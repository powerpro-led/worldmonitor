/**
 * Source-grep regression tests for the Workstream 6 (admin panel)
 * cloud-admin gate (PLATFORM_ARCHITECTURE.md P5, corrected S59): connect
 * org -> sign in with GitHub -> app_metadata.wm_admin check, ahead of
 * settings.html's existing category-editing UI.
 *
 * Source-grep rather than a DOM-mounted render, matching this repo's
 * established pattern for inline-HTML-string settings content (see
 * tests/llm-key-settings.test.mjs's own header: no jsdom/vitest is wired
 * into `node:test` here, and these modules pull in i18n + DOM-utils side
 * effects at import time that a plain node runtime can't satisfy).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const settingsMainSrc = readFileSync(resolve(repoRoot, 'src/settings-main.ts'), 'utf-8');
const settingsManagerSrc = readFileSync(resolve(repoRoot, 'src/services/settings-manager.ts'), 'utf-8');
const adminConnSrc = readFileSync(resolve(repoRoot, 'src/services/admin-org-connection.ts'), 'utf-8');

describe('settings-main.ts — VISIBLE_SETTINGS_CATEGORIES excludes ai for non-desktop', () => {
  it('desktop keeps all 5 categories; non-desktop filters out "ai"', () => {
    assert.match(
      settingsMainSrc,
      /const VISIBLE_SETTINGS_CATEGORIES: SettingsCategory\[\] = isDesktopRuntime\(\)\s*\n\s*\?\s*SETTINGS_CATEGORIES\s*\n\s*:\s*SETTINGS_CATEGORIES\.filter\(cat => cat\.id !== 'ai'\);/,
    );
  });

  it('every category render site uses the filtered constant, not the raw one', () => {
    // Bare SETTINGS_CATEGORIES should only ever appear in its own import
    // and in the VISIBLE_SETTINGS_CATEGORIES definition — every render
    // site (sidebar, overview, section lookup, search) must go through
    // the filtered constant instead.
    const bareSites = settingsMainSrc.match(/(?<!VISIBLE_)SETTINGS_CATEGORIES\b/g) ?? [];
    assert.equal(
      bareSites.length,
      3,
      `expected exactly 3 bare SETTINGS_CATEGORIES occurrences (1 import + 2 in the ternary), got ${bareSites.length} — a render site may have regressed to the unfiltered list`,
    );
    assert.equal((settingsMainSrc.match(/VISIBLE_SETTINGS_CATEGORIES/g) ?? []).length, 5, 'expected 1 definition + 4 render-site usages');
  });
});

describe('settings-main.ts — runCloudAdminGate() sequence', () => {
  it('checks connection, then session, then admin flag, then seeds presence, in that order', () => {
    const fnStart = settingsMainSrc.indexOf('async function runCloudAdminGate(');
    assert.ok(fnStart > 0, 'runCloudAdminGate not found');
    const fnEnd = settingsMainSrc.indexOf('\n// ── Init', fnStart);
    assert.ok(fnEnd > fnStart, 'could not bound runCloudAdminGate — Init section marker not found after it');
    const body = settingsMainSrc.slice(fnStart, fnEnd);

    const connIdx = body.indexOf('getStoredOrgConnection()');
    const sessionIdx = body.indexOf('isAdminSignedIn()');
    const adminIdx = body.indexOf('isCurrentUserAdmin()');
    const presenceIdx = body.indexOf('fetchPipelineConfigPresence()');
    const proceedIdx = body.indexOf('proceedPastGate()');

    assert.ok(
      connIdx >= 0 && sessionIdx > connIdx && adminIdx > sessionIdx && presenceIdx > adminIdx && proceedIdx > presenceIdx,
      'gate order must be: connection -> session -> admin -> presence seed -> proceed',
    );
  });

  it('seeds pipeline_config presence into runtime-config, filtered to known secret keys, before proceeding', () => {
    assert.match(
      settingsMainSrc,
      /seedSecretsFromCloudAdmin\(\s*\n\s*Array\.from\(presentKeys\)\.filter\(k => KNOWN_SECRET_KEYS\.has\(k\)\) as RuntimeSecretKey\[\],\s*\n\s*\);/,
    );
    // KNOWN_SECRET_KEYS must be derived from the real secret-key label map,
    // not a hand-maintained duplicate list that can drift.
    assert.match(settingsMainSrc, /const KNOWN_SECRET_KEYS = new Set<string>\(Object\.keys\(HUMAN_LABELS\)\);/);
  });

  it('hides the sidebar and Save button on every gate screen, restores both once the gate passes', () => {
    const calls = settingsMainSrc.match(/setGateChromeVisible\((true|false)\)/g) ?? [];
    const hideCalls = calls.filter(c => c === 'setGateChromeVisible(false)').length;
    const showCalls = calls.filter(c => c === 'setGateChromeVisible(true)').length;
    assert.equal(hideCalls, 3, 'expected one setGateChromeVisible(false) per gate screen (connect / sign-in / access-denied)');
    assert.equal(showCalls, 1, 'expected exactly one setGateChromeVisible(true), once the gate passes');
  });

  it('desktop runtime skips the gate entirely and goes straight to proceedPastGate()', () => {
    assert.match(
      settingsMainSrc,
      /if \(!isDesktopRuntime\(\)\) \{\s*\n\s*const gateArea = document\.getElementById\('contentArea'\);\s*\n\s*if \(gateArea\) \{\s*\n\s*await runCloudAdminGate\(gateArea\);\s*\n\s*return;/,
    );
    assert.match(settingsMainSrc, /\n\s*await proceedPastGate\(\);\s*\n\}/, 'desktop (or a missing #contentArea) must still fall through to proceedPastGate()');
  });
});

describe('settings-main.ts — gate screen actions', () => {
  it('the connect-org form stores the connection then re-runs the gate in-page (no reload)', () => {
    assert.match(settingsMainSrc, /setStoredOrgConnection\(url, key\);\s*\n\s*void runCloudAdminGate\(area\);/);
  });

  it('the sign-in screen triggers real GitHub OAuth — a redirect, not a fetch/poll', () => {
    assert.match(
      settingsMainSrc,
      /area\.querySelector\('\[data-admin-signin\]'\)\?\.addEventListener\('click', \(\) => \{\s*\n\s*void adminSignInWithGithub\(\);\s*\n\s*\}\);/,
    );
  });

  it('the disconnect link on the sign-in screen clears the connection and re-runs the gate', () => {
    assert.match(settingsMainSrc, /clearStoredOrgConnection\(\);\s*\n\s*void runCloudAdminGate\(area\);/);
  });

  it('access-denied offers sign-out, which re-runs the gate afterward', () => {
    assert.match(settingsMainSrc, /await adminSignOut\(\);\s*\n\s*void runCloudAdminGate\(area\);/);
  });
});

describe('settings-manager.ts — commitVerifiedSecrets() cloud-admin branch', () => {
  it('branches on isDesktopRuntime(): desktop keeps setSecretValue(), else commitToPipelineConfig()', () => {
    assert.match(
      settingsManagerSrc,
      /if \(isDesktopRuntime\(\)\) \{\s*\n\s*await setSecretValue\(key, value\);\s*\n\s*\} else \{\s*\n\s*await commitToPipelineConfig\(key, value\);\s*\n\s*\}/,
    );
  });

  it('imports commitToPipelineConfig from the dedicated admin-org-connection module, not ad hoc', () => {
    assert.match(settingsManagerSrc, /import \{ commitToPipelineConfig \} from '\.\/admin-org-connection';/);
  });
});

describe('admin-org-connection.ts — separate client from the dashboard singleton', () => {
  it('uses a distinct auth.storageKey so a signed-in admin session never collides with supabase-client.ts', () => {
    assert.match(adminConnSrc, /const ADMIN_AUTH_STORAGE_KEY = 'wm-admin-auth';/);
    assert.match(adminConnSrc, /storageKey: ADMIN_AUTH_STORAGE_KEY,/);
  });

  it('reads only the key column from pipeline_config for presence — never the plaintext value', () => {
    assert.match(adminConnSrc, /\.from\('pipeline_config'\)\.select\('key'\)/);
    assert.ok(!/select\('key,\s*value'\)/.test(adminConnSrc), 'presence check must not select the value column');
  });

  it('signs in via native Supabase GitHub OAuth, not the VS-Code-token-relay bridge', () => {
    assert.match(adminConnSrc, /signInWithOAuth\(\{ provider: 'github' \}\)/);
    // The bridge is only ever named in the doc comment explaining why it's
    // the wrong fit here — it must never actually be invoked (no ticket
    // exchange, no custom:github-bridge provider).
    assert.ok(!adminConnSrc.includes('custom:github-bridge'), 'must not invoke the identity-bridge OIDC provider');
    assert.ok(!/\/tickets/.test(adminConnSrc), 'must not perform the bridge\'s ticket exchange');
  });

  it('commitPipelineConfigValue() takes the client as an explicit parameter (directly unit-testable)', () => {
    assert.match(adminConnSrc, /export async function commitPipelineConfigValue\(\s*\n\s*supabase: Pick<AdminClient, 'from'>,/);
  });
});
