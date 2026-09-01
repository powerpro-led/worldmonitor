import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { BackendClient, BackendUnreachableError } from './backendClient';

/**
 * This fork's own Supabase project (VITE_SUPABASE_URL in .env.local) — the
 * backend for src/services/auth-provider.ts's GitHub sign-in. Needed here
 * only so the wrapper's CSP can allow the dashboard iframe to navigate
 * through it during the GitHub sign-in OAuth redirect chain (see
 * handleGithubSignIn below). Not a secret — the same value is already baked
 * into the app's own public build.
 */
const SUPABASE_ORIGIN = 'https://ixuezudybhjptisexgxx.supabase.co';

/**
 * Dagu-style architecture: the wrapper page's ENTIRE content is a plain
 * <iframe> pointed at the sidecar's own real HTTP origin (see
 * local-api-server.mjs's tryServeStaticAsset), not an injected/rewritten
 * copy of dist/dashboard.html. That's what lets this CSP stay this small —
 * the wrapper itself loads no remote resources and runs no app code, only a
 * few lines of postMessage relay (see render() below). frame-src must allow
 * BOTH the sidecar's own loopback origin (the base iframe) and Supabase's
 * origin (the GitHub sign-in redirect chain re-navigates that SAME iframe
 * through Supabase mid-flight) — frame-src governs every navigation of a
 * frame, not just its initial src.
 */
function buildCsp(nonce: string): string {
  return [
    `default-src 'self'`,
    `script-src 'nonce-${nonce}'`,
    `style-src 'unsafe-inline'`,
    // Both loopback forms allowed: the iframe navigates via 'localhost'
    // (see sidecarProcess.ts's baseUrl for why), but 127.0.0.1 stays
    // allowlisted too since nothing depends on excluding it.
    `frame-src http://127.0.0.1:* http://localhost:* ${SUPABASE_ORIGIN}`,
  ].join('; ');
}

export class DashboardPanel {
  private static current: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  /** For the standalone Command Palette entry (worldmonitorLocal.signInWithGithub) —
   * same flow the dashboard's own Login button triggers via postMessage. */
  static async triggerGithubSignIn(): Promise<void> {
    if (!DashboardPanel.current) {
      void vscode.window.showInformationMessage('WorldMonitor: open the dashboard first.');
      return;
    }
    await DashboardPanel.current.handleGithubSignIn();
  }

  static async createOrShow(context: vscode.ExtensionContext, backend: BackendClient): Promise<void> {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'worldmonitorLocal.dashboard',
      'WorldMonitor',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        // Critical: without this, VS Code destroys/reloads the webview's
        // document (and with it, the nested iframe) every time the panel
        // tab loses focus — the real app has its own live map/panel state
        // (globe.gl, deck.gl) that would otherwise reset on every switch.
        retainContextWhenHidden: true,
        // No localResourceRoots / asWebviewUri needed — unlike the prior
        // (superseded) design, nothing here loads local files into the
        // webview. The iframe is a real HTTP page served by the sidecar
        // over its own loopback origin.
      },
    );

    const instance = new DashboardPanel(panel, backend);
    DashboardPanel.current = instance;
    context.subscriptions.push(panel);

    // Assign real content immediately rather than leaving the webview an
    // unassigned blank document for however long the backend takes to
    // answer. Also means a panel that stays visually empty is now a
    // reportable state ("stuck on Connecting…") instead of ambiguous.
    panel.webview.html = instance.loadingHtml();

    try {
      await instance.connect();
      backend.log('[panel] backend reachable, rendering dashboard');
      instance.render();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      backend.log(`[panel] could not reach backend: ${message}`);
      panel.webview.html = instance.errorHtml(message);
    }
  }

  /**
   * Reach the backend, and if it isn't up, offer to start it — but never
   * spawn it ourselves. `worldmonitor-local install` put it under launchd;
   * the most this extension does is ask launchd to kickstart it.
   */
  private async connect(): Promise<void> {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'WorldMonitor: connecting to local backend…' },
        () => this.backend.ensureReachable(),
      );
      return;
    } catch (err) {
      if (!(err instanceof BackendUnreachableError)) throw err;

      const choice = await vscode.window.showErrorMessage(
        err.tokenMissing
          ? 'WorldMonitor local backend isn\'t installed. Run `worldmonitor-local install` in the repo, then reopen.'
          : 'WorldMonitor local backend isn\'t running.',
        ...(err.tokenMissing ? [] : ['Start backend']),
      );
      if (choice !== 'Start backend') throw err;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'WorldMonitor: starting local backend…' },
        async () => {
          await this.backend.startBackend();
          // Cold start also boots the in-process sync listener; give it room.
          await this.backend.ensureReachable(15_000);
        },
      );
    }
  }

  private constructor(panel: vscode.WebviewPanel, private readonly backend: BackendClient) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        // Relayed up from the iframe's own window.__wmVsCodeApi.postMessage
        // (set by the sidecar's embed shim only when ?embed=vscode is on
        // the URL — see local-api-server.mjs's buildVsCodeEmbedShim), via
        // this wrapper's own render()-injected relay script.
        if (msg?.type === 'wm-github-signin') void this.handleGithubSignIn();
        if (msg?.type === 'wm-open-external' && typeof msg.url === 'string') void this.handleOpenExternal(msg.url);
      },
      null,
      this.disposables,
    );
  }

  /**
   * Gets a GitHub token VS Code already holds (its own native auth
   * provider — no custom consent UI needed here; a popup appears only if no
   * session exists yet, silently reused otherwise) and posts it into the
   * dashboard iframe's OWN existing window (relayed by render()'s inline
   * script, straight into frame.contentWindow — NOT via re-navigating
   * frame.src with a new URL fragment: a URL differing only in its
   * fragment from the one already loaded is a same-document, no-reload
   * navigation, so the page's own boot code would never see it — confirmed
   * the hard way).
   *
   * From there, src/services/auth-provider.ts's message listener
   * (installVsCodeGithubTokenListener) takes over entirely in-browser:
   * mints a ticket against the already-deployed github-identity-bridge
   * Supabase Edge Function, then lets supabase-js do a REAL navigation
   * through the OAuth redirect chain (Supabase -> bridge -> Supabase ->
   * back to this same iframe). This works under this architecture
   * specifically because the dashboard runs in an ordinary nested
   * <iframe>, not the webview's own top-level document —
   * window.location.assign()'s [LegacyUnforgeable] restriction (confirmed
   * the hard way in a prior, superseded webview-injection attempt) only
   * blocks that top-level document, not a nested frame; independently
   * corroborated by the platform repo's own shipped, tested implementation
   * of this same client contract.
   */
  private async handleGithubSignIn(): Promise<void> {
    try {
      const session = await vscode.authentication.getSession('github', ['read:user', 'user:email'], { createIfNone: true });
      if (!session) return;
      this.backend.log('[auth] got a VS Code GitHub session, handing off to the dashboard iframe');
      void this.panel.webview.postMessage({ type: 'wm-vscode-github-token', token: session.accessToken });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.backend.log(`[auth] vscode.authentication.getSession failed: ${message}`);
      void vscode.window.showErrorMessage(`WorldMonitor sign-in failed: ${message}`);
    }
  }

  /**
   * VS Code's webview architecture blocks window.open()/target="_blank"
   * navigation from webview content by design — an <a target="_blank">
   * click inside the dashboard iframe silently does nothing (found live via
   * the Latest Brief panel's cover-card link; ~40 dashboard components use
   * target="_blank", all equally affected). src/main.ts's click interceptor
   * (isVsCodeEmbedRuntime()-gated) relays the URL up through this same
   * postMessage bridge as GitHub sign-in; this is the receiving end,
   * opening it in the user's real default browser instead.
   *
   * Only http(s) is allowed through — vscode.env.openExternal() accepts
   * arbitrary URI schemes, and this handler's input is a URL string chosen
   * by whatever page loaded inside the iframe, not a value this extension
   * controls end-to-end.
   */
  private async handleOpenExternal(url: string): Promise<void> {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        this.backend.log(`[panel] refused to open non-http(s) external URL: ${url}`);
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.backend.log(`[panel] openExternal failed: ${message}`);
    }
  }

  /** Deliberately dependency-free and inline — it must render before the
   * sidecar exists. */
  loadingHtml(): string {
    return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family,sans-serif);padding:2rem;color:var(--vscode-foreground);">
      <h2>WorldMonitor</h2>
      <p>Connecting to local backend…</p>
      <p style="opacity:.7;font-size:.9em;">Local cached data only — no live network fetch.</p>
    </body></html>`;
  }

  /**
   * The entire dashboard is this one <iframe> — no HTML rewriting, no CSP
   * meta-tag juggling for the app bundle itself, no Worker/Location
   * patching, no Tauri IPC bridge. All of that existed only because the
   * prior (superseded) design injected a rewritten copy of dist/index.html
   * directly into webview.html=; here the app is a real HTTP page the
   * sidecar serves at its own origin, so none of those failure classes
   * apply by construction (see the plan's architecture table). Debugging a
   * blank panel now works the normal way too: "Developer: Open Webview
   * Developer Tools" inspects this document AND the nested iframe.
   */
  private render(): void {
    const nonce = randomBytes(16).toString('base64');
    const csp = buildCsp(nonce);
    const src = `${this.backend.baseUrl}/dashboard.html?embed=vscode`;
    this.panel.webview.html = `<!DOCTYPE html><html><head>
      <meta http-equiv="Content-Security-Policy" content="${csp}">
      <style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;}iframe{border:0;width:100%;height:100%;display:block;}</style>
    </head><body>
      <iframe id="wm-frame" src="${escapeHtmlAttr(src)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen; storage-access"></iframe>
      <script nonce="${nonce}">
        (function () {
          var vscodeApi = acquireVsCodeApi();
          var frame = document.getElementById('wm-frame');
          var frameOrigin = new URL(${JSON.stringify(src)}).origin;
          window.addEventListener('message', function (event) {
            var msg = event.data;
            if (!msg || typeof msg !== 'object') return;
            if (msg.type === 'wm-github-signin' && event.source === frame.contentWindow) {
              vscodeApi.postMessage(msg);
              return;
            }
            if (msg.type === 'wm-open-external' && event.source === frame.contentWindow) {
              vscodeApi.postMessage(msg);
              return;
            }
            if (msg.type === 'wm-vscode-github-token' && msg.token && frame.contentWindow) {
              // Posted straight into the iframe's OWN existing window,
              // deliberately NOT via re-navigating frame.src with a new
              // fragment: a URL differing only in its fragment from the
              // one already loaded is treated as a same-document
              // in-page navigation by the browser (no reload), so the
              // page's own boot code never re-runs and never sees the
              // new token — confirmed the hard way, see auth-provider.ts's
              // message listener for the receiving side.
              frame.contentWindow.postMessage(msg, frameOrigin);
            }
          });
        })();
      </script>
    </body></html>`;
  }

  private errorHtml(message: string): string {
    return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem;">
      <h2>WorldMonitor dashboard couldn't start</h2>
      <p>${escapeHtml(message)}</p>
    </body></html>`;
  }

  private dispose(): void {
    DashboardPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function escapeHtmlAttr(s: string): string {
  return escapeHtml(s);
}
