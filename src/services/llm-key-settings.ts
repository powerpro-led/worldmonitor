/**
 * Per-operator LLM-key settings tab content (PLATFORM_ARCHITECTURE.md
 * Workstream 3 Parts B/C, OQ-P4/P5). Only meaningful in the VS Code embed —
 * the sidecar-backed operator local backend — where the Tauri desktop app's
 * `runtime-config`/`settingsManager` (keychain-backed) path does not apply.
 * `UnifiedSettings` gates this tab's visibility on `isVsCodeEmbedRuntime()`.
 *
 * Talks to the sidecar's own `GET/PUT /api/local-llm-config`
 * (vscode-extension/sidecar/local-api-server.mjs) with a plain relative
 * fetch — no manual auth header, matching LlmStatusIndicator's
 * `/api/llm-health` call: the embed's fetch is already same-origin against
 * the sidecar, which authenticates the transport hop itself.
 *
 * Secrets are never round-tripped: GET reports only `{ set: boolean }` for
 * OPENROUTER_API_KEY / GROQ_API_KEY, so a field left untouched must NOT be
 * resubmitted (there is nothing to resubmit) and an explicit "Clear" is the
 * only way to unset one — see FIELDS / attach() below.
 */
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';

export interface LlmKeySettingsResult {
  html: string;
  attach: (container: HTMLElement) => () => void;
}

type LlmConfigKey = 'OPENROUTER_API_KEY' | 'GROQ_API_KEY' | 'OLLAMA_API_URL' | 'OLLAMA_MODEL';

interface LlmConfigKeyStatus {
  set: boolean;
  value?: string;
}

interface LlmConfigResponse {
  keys: Record<LlmConfigKey, LlmConfigKeyStatus>;
  anyProviderConfigured: boolean;
}

interface FieldDef {
  key: LlmConfigKey;
  secret: boolean;
  inputType: 'password' | 'text' | 'url';
  labelKey: string;
  labelFallback: string;
  descKey: string;
  descFallback: string;
  placeholder: string;
}

const FIELDS: readonly FieldDef[] = [
  {
    key: 'OPENROUTER_API_KEY',
    secret: true,
    inputType: 'password',
    labelKey: 'settings.llmKeys.openrouterLabel',
    labelFallback: 'OpenRouter API key',
    descKey: 'settings.llmKeys.openrouterDesc',
    descFallback: 'Primary fallback provider for AI summaries and chat.',
    placeholder: 'sk-or-…',
  },
  {
    key: 'GROQ_API_KEY',
    secret: true,
    inputType: 'password',
    labelKey: 'settings.llmKeys.groqLabel',
    labelFallback: 'Groq API key',
    descKey: 'settings.llmKeys.groqDesc',
    descFallback: 'Fast primary provider for AI summaries and chat.',
    placeholder: 'gsk_…',
  },
  {
    key: 'OLLAMA_API_URL',
    secret: false,
    inputType: 'url',
    labelKey: 'settings.llmKeys.ollamaUrlLabel',
    labelFallback: 'Ollama / LM Studio URL',
    descKey: 'settings.llmKeys.ollamaUrlDesc',
    descFallback: 'A local OpenAI-compatible endpoint — no key leaves this machine.',
    placeholder: 'http://127.0.0.1:11434',
  },
  {
    key: 'OLLAMA_MODEL',
    secret: false,
    inputType: 'text',
    labelKey: 'settings.llmKeys.ollamaModelLabel',
    labelFallback: 'Ollama model',
    descKey: 'settings.llmKeys.ollamaModelDesc',
    descFallback: 'Defaults to llama3.1:8b if left blank.',
    placeholder: 'llama3.1:8b',
  },
];

function fieldRowHtml(f: FieldDef): string {
  const clearBtn = f.secret
    ? `<button type="button" class="us-llmkey-clear" data-llmkey-clear="${f.key}" title="${escapeHtml(t('common.clear', { defaultValue: 'Clear' }))}">${escapeHtml(t('common.clear', { defaultValue: 'Clear' }))}</button>`
    : '';
  return `
    <div class="ai-flow-toggle-row us-llmkey-row" data-llmkey-row="${f.key}">
      <div class="ai-flow-toggle-label-wrap">
        <div class="ai-flow-toggle-label">${escapeHtml(t(f.labelKey, { defaultValue: f.labelFallback }))}
          <span class="us-llmkey-badge" data-llmkey-badge="${f.key}"></span>
        </div>
        <div class="ai-flow-toggle-desc">${escapeHtml(t(f.descKey, { defaultValue: f.descFallback }))}</div>
        <div class="us-llmkey-input-row">
          <input
            type="${f.inputType}"
            class="unified-settings-input"
            data-llmkey-input="${f.key}"
            placeholder="${escapeHtml(f.placeholder)}"
            autocomplete="off"
            spellcheck="false"
            style="flex:1"
          >
          ${clearBtn}
        </div>
      </div>
    </div>`;
}

export function renderLlmKeySettings(): LlmKeySettingsResult {
  const html = `
    <div class="wm-pref-group-content us-llmkey-content">
      <div class="ai-flow-toggle-desc" style="margin-bottom:10px">
        ${escapeHtml(t('settings.llmKeys.intro', {
          defaultValue: 'Set at least one provider to enable AI chat and summaries. Stored only on this machine — never sent anywhere but the provider you configure.',
        }))}
      </div>
      <div class="us-llmkey-status" data-llmkey-status aria-live="polite"></div>
      ${FIELDS.map(fieldRowHtml).join('')}
      <div class="panels-footer">
        <span class="panels-status" data-llmkey-save-status aria-live="polite"></span>
        <button class="panels-save-layout" data-llmkey-save>${escapeHtml(t('common.save', { defaultValue: 'Save' }))}</button>
      </div>
    </div>`;

  const attach = (container: HTMLElement): (() => void) => {
    const statusEl = container.querySelector<HTMLElement>('[data-llmkey-status]');
    const saveStatusEl = container.querySelector<HTMLElement>('[data-llmkey-save-status]');
    const saveBtn = container.querySelector<HTMLButtonElement>('[data-llmkey-save]');
    const inputs = new Map<LlmConfigKey, HTMLInputElement>();
    for (const f of FIELDS) {
      const el = container.querySelector<HTMLInputElement>(`[data-llmkey-input="${f.key}"]`);
      if (el) inputs.set(f.key, el);
    }
    // Dirty state per field — what save() actually submits. Secrets start
    // with no dirty entry (an untouched password field means "leave it");
    // typing arms 'value', the Clear button arms 'clear' explicitly so a
    // user can never nuke a working key by tabbing through an empty field.
    const dirty = new Map<LlmConfigKey, { mode: 'value' | 'clear' }>();
    let destroyed = false;
    let lastSnapshot: LlmConfigResponse | null = null;

    const setBadge = (key: LlmConfigKey, configured: boolean) => {
      const badge = container.querySelector<HTMLElement>(`[data-llmkey-badge="${key}"]`);
      if (!badge) return;
      badge.textContent = configured
        ? t('settings.llmKeys.configured', { defaultValue: '● configured' })
        : '';
      badge.classList.toggle('us-llmkey-badge-on', configured);
    };

    const applySnapshot = (data: LlmConfigResponse) => {
      lastSnapshot = data;
      dirty.clear();
      for (const f of FIELDS) {
        const input = inputs.get(f.key);
        const status = data.keys[f.key];
        if (!input || !status) continue;
        input.value = f.secret ? '' : (status.value ?? '');
        input.placeholder = f.secret && status.set
          ? t('settings.llmKeys.setPlaceholder', { defaultValue: '•••••••• (configured — leave blank to keep)' })
          : f.placeholder;
        setBadge(f.key, status.set);
      }
      if (statusEl) {
        statusEl.textContent = data.anyProviderConfigured
          ? t('settings.llmKeys.oneConfigured', { defaultValue: 'AI chat and summaries are enabled.' })
          : t('settings.llmKeys.noneConfigured', { defaultValue: 'No provider configured yet — AI chat and summaries are disabled.' });
        statusEl.classList.toggle('us-llmkey-status-ok', data.anyProviderConfigured);
        statusEl.classList.toggle('us-llmkey-status-warn', !data.anyProviderConfigured);
      }
    };

    const load = async () => {
      if (statusEl) statusEl.textContent = t('common.loading', { defaultValue: 'Loading…' });
      try {
        const res = await fetch('/api/local-llm-config', { signal: AbortSignal.timeout(8_000) });
        if (destroyed) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        applySnapshot(await res.json() as LlmConfigResponse);
      } catch {
        if (destroyed) return;
        if (statusEl) {
          statusEl.textContent = t('settings.llmKeys.loadFailed', { defaultValue: 'Could not reach the local backend to load AI settings.' });
          statusEl.classList.add('us-llmkey-status-warn');
        }
      }
    };

    const onInput = (key: LlmConfigKey) => (e: Event) => {
      const value = (e.target as HTMLInputElement).value;
      const f = FIELDS.find(x => x.key === key)!;
      if (f.secret) {
        // Any keystroke in a secret field is "I'm setting a new value" —
        // clearing is ONLY via the explicit Clear button below, never by
        // emptying-then-blurring, so a stray click can't drop a live key.
        if (value.length > 0) dirty.set(key, { mode: 'value' });
        else dirty.delete(key);
      } else {
        const original = lastSnapshot?.keys[key]?.value ?? '';
        if (value !== original) dirty.set(key, { mode: 'value' });
        else dirty.delete(key);
      }
    };

    const onClear = (key: LlmConfigKey) => () => {
      const input = inputs.get(key);
      if (input) input.value = '';
      dirty.set(key, { mode: 'clear' });
      setBadge(key, false);
    };

    const inputHandlers: Array<[HTMLInputElement, (e: Event) => void]> = [];
    for (const f of FIELDS) {
      const input = inputs.get(f.key);
      if (!input) continue;
      const handler = onInput(f.key);
      input.addEventListener('input', handler);
      inputHandlers.push([input, handler]);
    }
    const clearButtons: Array<[HTMLButtonElement, () => void]> = [];
    for (const f of FIELDS) {
      if (!f.secret) continue;
      const btn = container.querySelector<HTMLButtonElement>(`[data-llmkey-clear="${f.key}"]`);
      if (!btn) continue;
      const handler = onClear(f.key);
      btn.addEventListener('click', handler);
      clearButtons.push([btn, handler]);
    }

    const onSave = async () => {
      if (dirty.size === 0) return;
      if (saveBtn) saveBtn.disabled = true;
      if (saveStatusEl) saveStatusEl.textContent = t('common.saving', { defaultValue: 'Saving…' });
      const body: Partial<Record<LlmConfigKey, string>> = {};
      for (const [key, { mode }] of dirty) {
        body[key] = mode === 'clear' ? '' : (inputs.get(key)?.value.trim() ?? '');
      }
      try {
        const res = await fetch('/api/local-llm-config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        applySnapshot(await res.json() as LlmConfigResponse);
        if (saveStatusEl) saveStatusEl.textContent = t('common.saved', { defaultValue: 'Saved' });
        // Lets anything gating on provider availability (e.g. the AI status
        // indicator) re-check without a full reload.
        window.dispatchEvent(new CustomEvent('wm:llm-config-changed'));
      } catch {
        if (saveStatusEl) saveStatusEl.textContent = t('settings.llmKeys.saveFailed', { defaultValue: 'Save failed — try again.' });
      } finally {
        if (saveBtn) saveBtn.disabled = false;
        if (saveStatusEl) setTimeout(() => { if (!destroyed) saveStatusEl.textContent = ''; }, 4000);
      }
    };
    saveBtn?.addEventListener('click', onSave);

    void load();

    return () => {
      destroyed = true;
      for (const [input, handler] of inputHandlers) input.removeEventListener('input', handler);
      for (const [btn, handler] of clearButtons) btn.removeEventListener('click', handler);
      saveBtn?.removeEventListener('click', onSave);
    };
  };

  return { html, attach };
}
