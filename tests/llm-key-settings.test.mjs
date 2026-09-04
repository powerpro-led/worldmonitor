/**
 * Source-grep regression tests for the per-operator LLM-key settings tab
 * (PLATFORM_ARCHITECTURE.md Workstream 3 Parts B/C).
 *
 * Source-grep rather than a DOM-mounted render, matching this repo's
 * established pattern for inline-HTML-string settings content (see
 * tests/notifications-settings-ui-invariants.test.mjs's own header: no
 * jsdom/vitest is wired into `node:test` here, and these modules pull in
 * i18n + DOM-utils side effects at import time that a plain node runtime
 * can't satisfy).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const llmKeySrc = readFileSync(resolve(repoRoot, 'src/services/llm-key-settings.ts'), 'utf-8');
const unifiedSettingsSrc = readFileSync(resolve(repoRoot, 'src/components/UnifiedSettings.ts'), 'utf-8');
const settingsTypesSrc = readFileSync(resolve(repoRoot, 'src/components/settings-types.ts'), 'utf-8');
const indicatorSrc = readFileSync(resolve(repoRoot, 'src/components/LlmStatusIndicator.ts'), 'utf-8');
const eventHandlersSrc = readFileSync(resolve(repoRoot, 'src/app/event-handlers.ts'), 'utf-8');

describe('llm-key-settings.ts — field contract', () => {
  it('declares all four operator LLM keys, matching config-store.mjs OPERATOR_LLM_CONFIG_KEYS', () => {
    for (const key of ['OPENROUTER_API_KEY', 'GROQ_API_KEY', 'OLLAMA_API_URL', 'OLLAMA_MODEL']) {
      assert.ok(llmKeySrc.includes(`key: '${key}'`), `missing field def for ${key}`);
    }
  });

  it('the two API-key fields are password inputs; Ollama fields are not', () => {
    const openrouterIdx = llmKeySrc.indexOf("key: 'OPENROUTER_API_KEY'");
    const groqIdx = llmKeySrc.indexOf("key: 'GROQ_API_KEY'");
    const ollamaUrlIdx = llmKeySrc.indexOf("key: 'OLLAMA_API_URL'");
    const ollamaModelIdx = llmKeySrc.indexOf("key: 'OLLAMA_MODEL'");
    const nextFieldStart = (idx) => {
      const rest = llmKeySrc.slice(idx);
      const nextKey = rest.slice(1).search(/key: '/);
      return nextKey === -1 ? llmKeySrc.length : idx + 1 + nextKey;
    };
    const block = (idx) => llmKeySrc.slice(idx, nextFieldStart(idx));
    assert.match(block(openrouterIdx), /secret: true/);
    assert.match(block(openrouterIdx), /inputType: 'password'/);
    assert.match(block(groqIdx), /secret: true/);
    assert.match(block(groqIdx), /inputType: 'password'/);
    assert.match(block(ollamaUrlIdx), /secret: false/);
    assert.match(block(ollamaModelIdx), /secret: false/);
  });

  it('never seeds a secret input from the GET response value — GET never carries one', () => {
    assert.match(llmKeySrc, /input\.value = f\.secret \? '' : \(status\.value \?\? ''\)/);
  });

  it('a secret field only clears via the explicit Clear button, never on empty input', () => {
    assert.match(
      llmKeySrc,
      /if \(value\.length > 0\) dirty\.set\(key, \{ mode: 'value' \}\);\s*\n\s*else dirty\.delete\(key\);/,
    );
    // The clear affordance is the ONLY writer of mode:'clear'.
    const clearModeSites = llmKeySrc.match(/mode: 'clear'/g) ?? [];
    assert.equal(clearModeSites.length, 1, "exactly one site should set mode:'clear' — the Clear button handler");
    const onClearIdx = llmKeySrc.indexOf('const onClear');
    const clearModeIdx = llmKeySrc.indexOf("mode: 'clear'");
    assert.ok(onClearIdx > 0 && clearModeIdx > onClearIdx, "mode:'clear' must be set inside onClear()");
  });

  it('only Clear buttons are wired for secret fields (non-secret fields get none)', () => {
    assert.match(llmKeySrc, /f\.secret\s*\n\s*\? `<button type="button" class="us-llmkey-clear"/);
  });

  it('save() only submits dirty keys (a partial PUT, not a full snapshot)', () => {
    assert.match(llmKeySrc, /if \(dirty\.size === 0\) return;/);
    assert.match(llmKeySrc, /for \(const \[key, \{ mode \}\] of dirty\)/);
  });

  it('PUTs to /api/local-llm-config and notifies listeners on a successful save', () => {
    assert.match(llmKeySrc, /fetch\('\/api\/local-llm-config', \{\s*\n\s*method: 'PUT'/);
    assert.match(llmKeySrc, /new CustomEvent\('wm:llm-config-changed'\)/);
  });

  it('GETs on attach with no manual auth header (same-origin sidecar fetch, like LlmStatusIndicator)', () => {
    assert.match(llmKeySrc, /fetch\('\/api\/local-llm-config', \{ signal: AbortSignal\.timeout/);
    assert.ok(!/Authorization/.test(llmKeySrc), 'must not hand-roll an auth header — the runtime fetch patch covers it');
  });

  it('attach() returns a cleanup that removes every listener it added', () => {
    assert.match(llmKeySrc, /const attach = \(container: HTMLElement\): \(\(\) => void\) => \{/);
    assert.match(llmKeySrc, /destroyed = true;/);
    assert.match(llmKeySrc, /input\.removeEventListener\('input', handler\)/);
    assert.match(llmKeySrc, /btn\.removeEventListener\('click', handler\)/);
    assert.match(llmKeySrc, /saveBtn\?\.removeEventListener\('click', onSave\)/);
  });
});

describe('UnifiedSettings.ts — AI tab wiring', () => {
  it('gates the ai tab on isVsCodeEmbedRuntime(), not the broader isSidecarBackedRuntime()', () => {
    assert.match(unifiedSettingsSrc, /const showAiTab = isVsCodeEmbedRuntime\(\);/);
    assert.ok(!unifiedSettingsSrc.includes('isSidecarBackedRuntime'), 'must not use the Tauri+embed union — Tauri has its own AI settings path');
  });

  it('cleans up the llm-key attach handle in render(), teardownSettings(), and destroy()', () => {
    const sites = unifiedSettingsSrc.match(/this\.llmKeyCleanup\?\.\(\);/g) ?? [];
    assert.equal(sites.length, 3, 'expected one cleanup call each in render(), teardownSettings(), and destroy()');
  });

  it("attaches llm-key content only when the tab was actually rendered", () => {
    assert.match(unifiedSettingsSrc, /if \(llmKeys\) \{\s*\n\s*const aiPanel = this\.overlay\.querySelector\('#us-tab-panel-ai'\);/);
  });
});

describe('settings-types.ts', () => {
  it("adds 'ai' to the tab-id union", () => {
    assert.match(settingsTypesSrc, /\|\s*'ai'/);
  });
});

describe('LlmStatusIndicator.ts — Part C wiring', () => {
  it('accepts an optional onClick and only attaches a listener when supplied', () => {
    assert.match(indicatorSrc, /constructor\(onClick\?: \(\) => void\)/);
    assert.match(indicatorSrc, /if \(this\.onClick\) \{/);
  });

  it('distinguishes "no provider configured" from "offline" in the tooltip', () => {
    assert.match(indicatorSrc, /No LLM provider configured — AI features disabled/);
    assert.match(indicatorSrc, /const noneConfigured = data\.providers\.length === 0;/);
  });

  it('removes the click listener and the config-changed listener on destroy()', () => {
    assert.match(indicatorSrc, /this\.element\.removeEventListener\('click', this\.clickHandler\)/);
    assert.match(indicatorSrc, /window\.removeEventListener\('wm:llm-config-changed', this\.onConfigChanged\)/);
  });

  it('re-polls immediately on wm:llm-config-changed rather than waiting out the interval', () => {
    assert.match(indicatorSrc, /window\.addEventListener\('wm:llm-config-changed', this\.onConfigChanged\)/);
  });
});

describe('event-handlers.ts — setupLlmStatusIndicator widened gate', () => {
  it('mounts in the VS Code embed too, not just Tauri', () => {
    const fnStart = eventHandlersSrc.indexOf('setupLlmStatusIndicator(): void {');
    assert.ok(fnStart > 0, 'setupLlmStatusIndicator not found');
    const fnBody = eventHandlersSrc.slice(fnStart, eventHandlersSrc.indexOf('\n  }', fnStart));
    assert.match(fnBody, /if \(!isDesktopRuntime\(\) && !isEmbed\) return;/);
  });

  it('only wires the click-to-settings shortcut in the embed (Tauri keeps prior non-interactive behavior)', () => {
    const fnStart = eventHandlersSrc.indexOf('setupLlmStatusIndicator(): void {');
    const fnBody = eventHandlersSrc.slice(fnStart, eventHandlersSrc.indexOf('\n  }', fnStart));
    assert.match(fnBody, /new LlmStatusIndicator\(\s*\n\s*isEmbed \? \(\) => this\.ctx\.unifiedSettings\?\.open\('ai'\) : undefined,/);
  });
});
