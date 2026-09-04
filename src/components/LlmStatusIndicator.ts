// Small header indicator showing LLM provider reachability.
// Polls /api/llm-health every 60s. Shows green dot when available, red when offline.

import { h } from '@/utils/dom-utils';

const POLL_INTERVAL_MS = 60_000;

interface LlmHealthResponse {
  available: boolean;
  providers: Array<{ name: string; url: string; available: boolean }>;
  checkedAt: number;
}

export class LlmStatusIndicator {
  private element: HTMLElement;
  private dot: HTMLElement;
  private label: HTMLElement;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onClick: (() => void) | null;
  private clickHandler: (() => void) | null = null;

  /**
   * `onClick`, when supplied, makes the indicator a shortcut into the AI
   * settings tab — meaningful only where that tab exists (the VS Code
   * operator backend; PLATFORM_ARCHITECTURE.md Workstream 3 Part C). Leave
   * unset elsewhere to keep this indicator's prior non-interactive behavior.
   */
  constructor(onClick?: () => void) {
    this.onClick = onClick ?? null;
    this.dot = h('span', {
      style: 'display:inline-block;width:6px;height:6px;border-radius:50%;background:#ff4444;margin-right:4px;',
    });
    this.label = h('span', {
      style: 'font-size:9px;letter-spacing:0.5px;opacity:0.7;',
    }, 'LLM');
    this.element = h('div', {
      className: 'llm-status-indicator',
      title: 'LLM provider status — checking...',
      style: `display:flex;align-items:center;padding:0 6px;user-select:none;${this.onClick ? 'cursor:pointer;' : 'cursor:default;'}`,
    }, this.dot, this.label);

    if (this.onClick) {
      this.clickHandler = this.onClick;
      this.element.addEventListener('click', this.clickHandler);
    }

    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);

    // Re-poll immediately after a save in the AI settings tab so the dot
    // doesn't sit on stale "offline" for up to POLL_INTERVAL_MS after the
    // operator just fixed it.
    window.addEventListener('wm:llm-config-changed', this.onConfigChanged);
  }

  private onConfigChanged = (): void => { void this.poll(); };

  private async poll(): Promise<void> {
    try {
      const resp = await fetch('/api/llm-health', {
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.status === 404) {
        // Endpoint only exists in sidecar/Docker — hide indicator on Vercel
        this.element.style.display = 'none';
        this.destroy();
        return;
      }
      if (!resp.ok) {
        this.setStatus(false, 'LLM', 'Health endpoint error');
        return;
      }
      const data: LlmHealthResponse = await resp.json();
      const active = data.providers.filter(p => p.available);
      // Show the active provider name in the label (first available wins the chain)
      const activeName = active.length > 0 ? active[0]!.name.toUpperCase() : '';
      const tooltipLines: string[] = [];
      for (const p of data.providers) {
        tooltipLines.push(`${p.available ? '●' : '○'} ${p.name} — ${p.available ? 'online' : 'offline'}`);
      }
      // Zero providers (nothing configured) reads differently from "configured
      // but unreachable" — the former needs a key, not a network fix. Only the
      // click-to-settings build (the operator backend) can act on this
      // distinction, but the tooltip copy is accurate everywhere.
      const noneConfigured = data.providers.length === 0;
      const clickHint = this.onClick ? '\nClick to open AI settings' : '';
      this.setStatus(
        data.available,
        activeName || 'LLM',
        data.available
          ? `LLM via ${activeName}\n${tooltipLines.join('\n')}`
          : noneConfigured
            ? `No LLM provider configured — AI features disabled${clickHint}`
            : `LLM offline — AI features unavailable\n${tooltipLines.join('\n')}${clickHint}`,
      );
    } catch {
      this.setStatus(false, 'LLM', 'LLM health check failed');
    }
  }

  private setStatus(available: boolean, labelText: string, tooltip: string): void {
    this.dot.style.background = available ? '#44ff88' : '#ff4444';
    this.label.textContent = labelText;
    this.element.title = tooltip;
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.clickHandler) {
      this.element.removeEventListener('click', this.clickHandler);
      this.clickHandler = null;
    }
    window.removeEventListener('wm:llm-config-changed', this.onConfigChanged);
  }
}
