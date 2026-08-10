import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { APP_API_KEY_HEADER, LOCAL_API_TRANSPORT_HEADER, type SidecarProcess } from './sidecarProcess';
import { handleInvoke } from './tauriBridgeHost';
import { signInWithGithubViaVsCode } from './githubAuthBridge';

/**
 * The nonce the real app's own build (vite.config.ts's STATIC_SCRIPT_NONCE)
 * bakes into every inline/module <script> tag in dist/index.html. It's a
 * fixed, hardcoded token (not per-request random), confirmed by reading the
 * built output directly — so our injected shim script can reuse the exact
 * same nonce and be trusted by the same CSP policy as the app's own
 * scripts, with no need to rewrite the real bundle's own tags.
 */
const APP_SCRIPT_NONCE = 'wm-static-bootstrap';

/**
 * The real app's CSP is delivered via Vercel response headers
 * (vercel.json), not an HTML <meta> tag — confirmed by inspecting the built
 * dist/index.html directly (no CSP meta tag present). Since `webview.html =`
 * has no HTTP response at all, VS Code's own very restrictive default CSP
 * would otherwise apply. This mirrors vercel.json's production policy
 * closely (same nonce, same 'strict-dynamic' script-src so the module
 * graph's dynamic imports inherit trust) with two deliberate differences:
 * adds `http://127.0.0.1:*` to connect-src (required for the sidecar) and
 * drops the Clerk/Dodo/Stripe-specific frame-src/form-action entries (those
 * integrations were removed from this fork during the Supabase migration).
 * connect-src otherwise stays as permissive as production (https:/wss:) —
 * this dashboard's "local cached, not network fetch" guarantee is
 * structural on the sidecar's side (LOCAL_API_CLOUD_FALLBACK unset, see
 * sidecarProcess.ts), not a network-wide firewall; the map layer's tile
 * imagery is a separate, always-remote CDN dependency the real app already
 * has regardless of this extension, not something narrowing connect-src
 * here would meaningfully change.
 */
function buildCsp(webviewCspSource: string): string {
  return [
    `default-src 'self'`,
    `connect-src 'self' https: wss: blob: data: http://127.0.0.1:*`,
    `img-src 'self' data: blob: https: ${webviewCspSource}`,
    `style-src 'self' 'unsafe-inline' ${webviewCspSource}`,
    `script-src 'self' 'strict-dynamic' 'nonce-${APP_SCRIPT_NONCE}' 'wasm-unsafe-eval' ${webviewCspSource}`,
    `worker-src 'self' blob:`,
    `font-src 'self' data: https:`,
    `media-src 'self' data: blob: https:`,
    `frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://webcams.windy.com`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `form-action 'self'`,
  ].join('; ');
}

/**
 * Rewrites the built HTML's root-absolute asset references (Vite's default
 * output shape: src="/assets/....js", href="/favico/...") into
 * document-relative form and adds a <base> tag pointing at the dist/
 * folder's real asWebviewUri root, so they resolve correctly under VS
 * Code's vscode-webview:// origin instead of 404ing against it. Doesn't
 * touch protocol-relative ("//host/...") or absolute ("https://...") refs.
 * Vite's own module-chunk-to-chunk resolution is import.meta.url-relative
 * at runtime (how it supports arbitrary deploy subpaths), so this one
 * top-level rewrite is expected to cover the graph, not just the entry
 * script — confirmed by design, not by running the real webview host (this
 * environment has no GUI; see the extension's README verification steps).
 */
function rewriteRootAbsolutePaths(html: string): string {
  return html.replace(/(src|href)="\/(?!\/)([^"]*)"/g, '$1="$2"');
}

function injectHead(
  html: string,
  distWebviewUriBase: string,
  sidecarBaseUrl: string,
  sidecarToken: string,
  enterpriseKey: string | undefined,
): string {
  const shim = `
    <base href="${distWebviewUriBase}/">
    <meta http-equiv="Content-Security-Policy" content="REPLACED_BELOW">
    <script nonce="${APP_SCRIPT_NONCE}">
      // Thin adapter around the real app's own code — not a reimplementation.
      // Three things every request to the sidecar needs that a relative
      // fetch('/api/...') under this document's real origin
      // (vscode-webview://...) won't get for free:
      //   1. src/services/runtime.ts's getApiBaseUrl() already redirects the
      //      ~4 "desktop-aware" call sites to an absolute
      //      http://127.0.0.1:<port> URL once VITE_DESKTOP_RUNTIME=1 was
      //      baked in at build time (it was — see the extension README).
      //      This patch covers the remaining ~27 files that call
      //      fetch('/api/...') with a bare relative path instead — those
      //      would otherwise resolve to nothing under this origin.
      //   2. EVERY request to the sidecar (relative-rewritten or already
      //      absolute) needs the local auth token — local-api-server.mjs's
      //      global auth gate default-denies any request missing it, same
      //      as it would for the real Tauri desktop app.
      //   3. Past that gate, api/_api-key.js's own app-level entitlement
      //      check ALSO requires a credential on RPC handlers. Confirmed
      //      live neither of its normal browser paths reach us here: the
      //      anonymous-session cookie is HttpOnly + SameSite=Lax (can't be
      //      read or resent cross-origin by a webview's fetch), and Origin
      //      is a forbidden header we can't spoof to the desktop-origin
      //      fast path. The operator-issued enterprise key
      //      (WORLDMONITOR_VALID_KEYS, read from .env.local by
      //      sidecarProcess.ts) is the one origin-independent path, so we
      //      attach it the same way the real Tauri desktop app would.
      (function () {
        var SIDECAR_BASE = ${JSON.stringify(sidecarBaseUrl)};
        var SIDECAR_TOKEN = ${JSON.stringify(sidecarToken)};
        var TOKEN_HEADER = ${JSON.stringify(LOCAL_API_TRANSPORT_HEADER)};
        var ENTERPRISE_KEY = ${JSON.stringify(enterpriseKey ?? '')};
        var APP_KEY_HEADER = ${JSON.stringify(APP_API_KEY_HEADER)};
        var realFetch = window.fetch.bind(window);
        window.fetch = function (input, init) {
          try {
            var isRequestObj = typeof Request !== 'undefined' && input instanceof Request;
            var url = typeof input === 'string' ? input : (isRequestObj ? input.url : (input && input.url) || '');
            var targetsSidecar = false;
            if (url.indexOf('/api/') === 0) {
              url = SIDECAR_BASE + url;
              targetsSidecar = true;
            } else if (url.indexOf(SIDECAR_BASE) === 0) {
              targetsSidecar = true;
            }
            if (targetsSidecar) {
              var headers = new Headers((init && init.headers) || (isRequestObj ? input.headers : undefined));
              headers.set(TOKEN_HEADER, SIDECAR_TOKEN);
              if (ENTERPRISE_KEY && !headers.has(APP_KEY_HEADER)) headers.set(APP_KEY_HEADER, ENTERPRISE_KEY);
              return realFetch(url, Object.assign({}, init, { headers: headers }));
            }
          } catch (e) { /* fall through to the real, unmodified call */ }
          return realFetch(input, init);
        };
      })();
      // Chromium refuses to construct a Worker whose script lives on a
      // different origin than the document — a hard browser restriction
      // that persists even with a permissive CSP (unlike a plain
      // <script src>, which is a normal cross-origin resource fetch, not
      // subject to this rule). VS Code's webview has two distinct origins:
      // the document (vscode-webview://<uuid>) and its asWebviewUri file
      // resources (vscode-resource.vscode-cdn.net) — so
      // new Worker(absoluteAssetUrl) (ml.worker.js, analysis.worker.js)
      // fails outright. Wrap the real script in a same-origin blob: URL, which
      // Worker construction does accept; the worker's own importScripts()/
      // import of the real (cross-origin) script is not subject to this
      // restriction — only construction is.
      (function () {
        var RealWorker = window.Worker;
        if (!RealWorker) return;
        var PatchedWorker = function (scriptUrl, options) {
          try {
            var absUrl = new URL(String(scriptUrl), location.href).href;
            var isModule = options && options.type === 'module';
            var blobSrc = isModule ? 'import ' + JSON.stringify(absUrl) + ';' : 'importScripts(' + JSON.stringify(absUrl) + ');';
            var blobUrl = URL.createObjectURL(new Blob([blobSrc], { type: 'application/javascript' }));
            return new RealWorker(blobUrl, options);
          } catch (e) {
            return new RealWorker(scriptUrl, options);
          }
        };
        PatchedWorker.prototype = RealWorker.prototype;
        window.Worker = PatchedWorker;
      })();
      // OAuth sign-in (and anything else) does a real top-level
      // window.location.assign() to an external URL — confirmed directly in
      // @supabase/auth-js's GoTrueClient.js, not guessed — which a VS Code
      // webview can't navigate to; the attempt just blanks the page. Two
      // cases: a GitHub sign-in attempt (Supabase's /auth/v1/authorize with
      // provider=github) is redirected to the VS Code-native GitHub bridge
      // flow (githubAuthBridge.ts) instead — no browser involved at all.
      // Everything else external still goes to the system browser via the
      // same open_url command tauriBridgeHost.ts implements for the real
      // Tauri app. Installed before the app bundle runs, same as the
      // fetch/Tauri shims above.
      (function () {
        function isExternal(url) {
          try { return new URL(url, location.href).origin !== location.origin; } catch (e) { return false; }
        }
        function isGithubSignIn(url) {
          try {
            var u = new URL(url, location.href);
            return u.pathname === '/auth/v1/authorize' && u.searchParams.get('provider') === 'github';
          } catch (e) { return false; }
        }
        function openExternal(url) {
          var api = window.__wmVsCodeApi;
          if (!api) return;
          try { api.postMessage({ type: 'wm-invoke', id: -1, command: 'open_url', payload: { url: url } }); } catch (e) {}
        }
        function startGithubSignIn() {
          var api = window.__wmVsCodeApi;
          if (!api) return;
          try { api.postMessage({ type: 'wm-github-signin' }); } catch (e) {}
        }
        function handleExternalNav(url) {
          if (isGithubSignIn(url)) { startGithubSignIn(); return; }
          openExternal(url);
        }
        try {
          var realAssign = window.location.assign.bind(window.location);
          window.location.assign = function (url) {
            if (isExternal(url)) { handleExternalNav(url); return; }
            return realAssign(url);
          };
        } catch (e) {}
        try {
          var realReplace = window.location.replace.bind(window.location);
          window.location.replace = function (url) {
            if (isExternal(url)) { handleExternalNav(url); return; }
            return realReplace(url);
          };
        } catch (e) {}
        try {
          var realOpen = window.open.bind(window);
          window.open = function (url, target, features) {
            if (url && isExternal(String(url))) { handleExternalNav(String(url)); return null; }
            return realOpen(url, target, features);
          };
        } catch (e) {}
      })();
      // Tauri IPC bridge. dist/ is built with VITE_DESKTOP_RUNTIME=1, so
      // runtime.ts routes every /api/* call through this invoke() rather
      // than through fetch (see tauriBridgeHost.ts for the full rationale).
      // Installed BEFORE the app bundle runs so resolveInvokeBridge() finds
      // it on first call — the app caches nothing here, but its very first
      // requests fire during module init.
      (function () {
        var api;
        try { api = acquireVsCodeApi(); } catch (e) { return; }
        window.__wmVsCodeApi = api;
        var seq = 0;
        var pending = Object.create(null);
        window.addEventListener('message', function (event) {
          var msg = event.data;
          if (!msg || msg.type !== 'wm-invoke-result') return;
          var entry = pending[msg.id];
          if (!entry) return;
          delete pending[msg.id];
          if (msg.ok) entry.resolve(msg.value);
          else entry.reject(new Error(msg.error || 'Tauri command failed'));
        });
        var invoke = function (command, payload) {
          return new Promise(function (resolve, reject) {
            var id = ++seq;
            pending[id] = { resolve: resolve, reject: reject };
            try {
              api.postMessage({ type: 'wm-invoke', id: id, command: command, payload: payload });
            } catch (e) {
              delete pending[id];
              reject(e);
            }
          });
        };
        // Both shapes, because tauri-bridge.ts's resolveInvokeBridge() checks
        // __TAURI__.core.invoke first and __TAURI_INTERNALS__.invoke second.
        window.__TAURI_INTERNALS__ = { invoke: invoke };
        window.__TAURI__ = { core: { invoke: invoke } };
      })();
      // Diagnostics. The real app is a large bundle (globe.gl/deck.gl) loaded
      // into a webview whose devtools are several menus deep, so without this
      // a boot failure is indistinguishable from a blank panel — which is
      // exactly the state this was added to diagnose. Everything here is
      // report-only; it never suppresses an error or alters app behaviour.
      (function () {
        // Reuse the handle the bridge above already acquired —
        // acquireVsCodeApi() throws on a second call in the same document.
        var api = window.__wmVsCodeApi;
        if (!api) return;
        var send = function (level, text) {
          try { api.postMessage({ type: 'wm-diag', level: level, text: String(text).slice(0, 2000) }); } catch (e) {}
        };
        // Capture phase so failed <script>/<img>/<link> loads are caught too —
        // those do not bubble and never reach window.onerror.
        window.addEventListener('error', function (e) {
          if (e.target && e.target !== window && e.target.tagName) {
            send('error', 'resource failed to load: <' + e.target.tagName.toLowerCase() + '> ' + (e.target.src || e.target.href || ''));
          } else {
            send('error', 'uncaught: ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0));
          }
        }, true);
        window.addEventListener('unhandledrejection', function (e) {
          var r = e.reason;
          send('error', 'unhandled rejection: ' + ((r && (r.stack || r.message)) || r));
        });
        var realError = console.error.bind(console);
        console.error = function () {
          send('console', Array.prototype.join.call(arguments, ' '));
          return realError.apply(null, arguments);
        };
        send('info', 'shim installed, readyState=' + document.readyState);
        document.addEventListener('DOMContentLoaded', function () { send('info', 'DOMContentLoaded'); });
        window.addEventListener('load', function () {
          // #app staying empty after load is the precise signature of "the
          // bundle ran but the app never mounted" vs "the bundle never ran".
          // (The mount point is #app, not Vite's default #root — confirmed
          // against the real dist/index.html.)
          var root = document.getElementById('app');
          send('info', 'load fired; #app ' + (root ? 'children=' + root.children.length : 'MISSING'));
          setTimeout(function () {
            var r = document.getElementById('app');
            send('info', 'T+5s; #app ' + (r ? 'children=' + r.children.length : 'MISSING'));
          }, 5000);
        });
      })();
    </script>`;
  return html.replace('<head>', `<head>${shim}`);
}

export class DashboardPanel {
  private static current: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly loggedInvokeErrors = new Set<string>();

  /** For the standalone Command Palette entry (worldmonitorLocal.signInWithGithub) —
   * same flow the webview's own Login button now triggers automatically. */
  static async triggerGithubSignIn(): Promise<void> {
    if (!DashboardPanel.current) {
      void vscode.window.showInformationMessage('WorldMonitor: open the dashboard first.');
      return;
    }
    await DashboardPanel.current.handleGithubSignIn();
  }

  static async createOrShow(context: vscode.ExtensionContext, repoRoot: string, sidecar: SidecarProcess): Promise<void> {
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
        // document every time the panel tab loses focus — the real app has
        // its own live map/panel state (globe.gl, deck.gl) that would
        // otherwise reset on every tab switch.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(repoRoot, 'dist'))],
      },
    );

    const instance = new DashboardPanel(panel, sidecar, repoRoot);
    DashboardPanel.current = instance;
    context.subscriptions.push(panel);

    // Assign real content immediately rather than leaving the webview an
    // unassigned blank document for however long the sidecar takes to come
    // up. Also means a panel that stays visually empty is now a reportable
    // state ("stuck on Starting…") instead of ambiguous.
    panel.webview.html = instance.loadingHtml();

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'WorldMonitor: starting local sidecar…' },
        () => sidecar.ensureRunning(),
      );
      sidecar.log('[panel] sidecar ready, rendering dashboard');
      instance.render(repoRoot, sidecar.baseUrl, sidecar.token, sidecar.enterpriseKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sidecar.log(`[panel] startup failed: ${message}`);
      panel.webview.html = instance.errorHtml(message);
    }
  }

  private constructor(panel: vscode.WebviewPanel, private readonly sidecar: SidecarProcess, private readonly repoRoot: string) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg?.type === 'wm-diag') {
          this.sidecar.log(`[webview:${msg.level}] ${msg.text}`);
          return;
        }
        if (msg?.type === 'wm-invoke') void this.handleInvokeMessage(msg);
        if (msg?.type === 'wm-github-signin') void this.handleGithubSignIn();
      },
      null,
      this.disposables,
    );
  }

  private async handleGithubSignIn(): Promise<void> {
    try {
      const { accessToken, refreshToken } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'WorldMonitor: signing in with GitHub…' },
        () => signInWithGithubViaVsCode(this.repoRoot),
      );
      this.sidecar.log('[auth] github sign-in succeeded, applying session to webview');
      void this.panel.webview.postMessage({ type: 'wm-external-session', accessToken, refreshToken });
    } catch (err) {
      this.sidecar.log(`[auth] github sign-in failed: ${describeErrorWithCause(err)}`);
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`WorldMonitor sign-in failed: ${message}`);
    }
  }

  private async handleInvokeMessage(msg: { id: number; command: string; payload?: Record<string, unknown> }): Promise<void> {
    try {
      const value = await handleInvoke(msg.command, msg.payload, this.sidecar);
      void this.panel.webview.postMessage({ type: 'wm-invoke-result', id: msg.id, ok: true, value });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // Logged once per distinct command: an unsupported command is a real
      // gap worth seeing, but a failing data route would otherwise repeat
      // on every refresh tick and drown the channel.
      if (!this.loggedInvokeErrors.has(msg.command)) {
        this.loggedInvokeErrors.add(msg.command);
        this.sidecar.log(`[bridge] ${msg.command} failed: ${error}`);
      }
      void this.panel.webview.postMessage({ type: 'wm-invoke-result', id: msg.id, ok: false, error });
    }
  }

  /** Deliberately dependency-free and inline — it must render before the
   * sidecar exists and before any dist/ asset has been resolved. */
  loadingHtml(): string {
    return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family,sans-serif);padding:2rem;color:var(--vscode-foreground);">
      <h2>WorldMonitor</h2>
      <p>Starting local sidecar…</p>
      <p style="opacity:.7;font-size:.9em;">Local cached data only — no live network fetch.</p>
    </body></html>`;
  }

  private render(repoRoot: string, sidecarBaseUrl: string, sidecarToken: string, enterpriseKey: string | undefined): void {
    const distDir = path.join(repoRoot, 'dist');
    const indexPath = path.join(distDir, 'index.html');
    if (!fs.existsSync(indexPath)) {
      this.panel.webview.html = this.errorHtml(
        `Real app build not found at ${indexPath}. Run "VITE_DESKTOP_RUNTIME=1 npm run build:desktop" in the worldmonitor repo first.`,
      );
      return;
    }

    const raw = fs.readFileSync(indexPath, 'utf-8');
    const distWebviewUriBase = this.panel.webview.asWebviewUri(vscode.Uri.file(distDir)).toString();
    const csp = buildCsp(this.panel.webview.cspSource);

    let html = rewriteRootAbsolutePaths(raw);
    html = injectHead(html, distWebviewUriBase, sidecarBaseUrl, sidecarToken, enterpriseKey);
    html = html.replace('content="REPLACED_BELOW"', `content="${csp}"`);

    this.panel.webview.html = html;
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
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Node's fetch throws a generic "fetch failed" TypeError wrapping the real
 * reason (DNS, TLS, connection refused, ...) in `.cause` — logging just
 * err.message hides exactly the detail needed to diagnose a network
 * failure. Walks the whole cause chain, not just one level. */
function describeErrorWithCause(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(' <- caused by: ');
}
