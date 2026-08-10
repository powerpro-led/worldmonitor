import * as vscode from 'vscode';
import { APP_API_KEY_HEADER, LOCAL_API_TRANSPORT_HEADER, type SidecarProcess } from './sidecarProcess';

/**
 * Host-side implementation of the Tauri `invoke` commands the real desktop
 * app expects.
 *
 * Why this exists: dist/ is built with VITE_DESKTOP_RUNTIME=1, so
 * src/services/runtime.ts's installRuntimeFetchPatch() routes EVERY
 * `/api/*` call through src/services/tauri-bridge.ts's
 * proxyLocalApiRequest() — a Tauri IPC command — rather than through
 * `fetch`. In a VS Code webview there is no Tauri, so all of those threw
 * "Tauri invoke bridge unavailable", and the patch then fell through to its
 * cloud fallback (`https://api.worldmonitor.app/...`), which is both the
 * observed "TypeError: Failed to fetch" spam AND a silent violation of this
 * extension's local-only guarantee. Answering the IPC here fixes both at
 * once: data comes from the sidecar, and cloud fallback is never reached
 * because the local call now succeeds.
 *
 * Running the request from the extension host (Node) rather than from the
 * webview is deliberate, and mirrors what the Rust side does:
 *   - No CORS. The sidecar's SIDECAR_ALLOWED_ORIGINS does not include
 *     `vscode-webview://…` (it falls back to `tauri://localhost`, which the
 *     browser then rejects) and its Access-Control-Allow-Headers lists
 *     neither of the two custom headers we must send — so a direct webview
 *     fetch to 127.0.0.1 is blocked twice over, before it is even sent.
 *     Node applies none of that.
 *   - The token stays host-side, exactly as tauri-bridge.ts's own comment
 *     describes ("the native process owns the local bearer token").
 */

/** Mirrors Rust's LocalApiProxyResponse — the shape tauri-bridge.ts decodes. */
interface LocalApiProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: number[];
}

/** Matches src-tauri/src/main.rs's MAX_LOCAL_API_PROXY_BYTES guard, so an
 * oversized response fails the same way here as it does on the real desktop
 * app instead of trying to serialise tens of MB through postMessage. */
const MAX_PROXY_BYTES = 32 * 1024 * 1024;

/**
 * Mirrors src-tauri/src/main.rs's normalized_local_api_proxy_path_is_allowed.
 * The `/api/local-*` namespace is the sidecar's own configuration control
 * plane (env mutation, secret validation); the real desktop app refuses to
 * proxy it on behalf of page content, and so must we, or this bridge would
 * be a strictly weaker boundary than the one it stands in for.
 */
function isProxyableRoute(route: string): boolean {
  if (!route.startsWith('/api/') || route.startsWith('//')) return false;
  if (route === '/api/local-env-update' || route === '/api/local-env-update-batch' || route === '/api/local-validate-secret') {
    return false;
  }
  if (route.startsWith('/api/local-')) {
    return route === '/api/local-debug-toggle' || route === '/api/local-traffic-log';
  }
  return true;
}

export async function handleInvoke(
  command: string,
  payload: Record<string, unknown> | undefined,
  sidecar: SidecarProcess,
): Promise<unknown> {
  switch (command) {
    case 'proxy_local_api_request':
      return proxyLocalApiRequest(payload, sidecar);

    case 'get_local_api_port':
      return sidecar.port;

    case 'get_desktop_runtime_info':
      return { os: process.platform, arch: process.arch, local_api_port: sidecar.port };

    case 'open_url': {
      const url = typeof payload?.url === 'string' ? payload.url : undefined;
      if (!url) throw new Error('open_url requires a url');
      // Hand off to VS Code rather than opening anything in the webview —
      // the webview has no navigation affordance and its CSP forbids
      // top-level navigation anyway.
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return null;
    }

    // Deliberately NOT implemented, and rejected rather than left to hang:
    //   - read/write/delete_cache_entry: persistent-cache.ts already falls
    //     back to IndexedDB on throw, which is the natural storage for a
    //     webview. Reimplementing Rust's on-disk cache here would add a
    //     second source of truth for no gain.
    //   - set_secret / delete_secret / list_configured_secret_keys /
    //     validate_secret_with_sidecar: those belong to the desktop app's
    //     separate settings window, which this extension does not host.
    default:
      throw new Error(`Unsupported Tauri command in the VS Code host: ${command}`);
  }
}

async function proxyLocalApiRequest(
  payload: Record<string, unknown> | undefined,
  sidecar: SidecarProcess,
): Promise<LocalApiProxyResponse> {
  const request = payload?.request as
    | { method?: string; path?: string; headers?: Record<string, string>; body?: number[] }
    | undefined;
  const rawPath = request?.path;
  if (!rawPath) throw new Error('Refusing to proxy request with no path');
  // Normalise the same way Rust does — resolve the path against a fixed
  // local origin so `..` segments and fragments can't smuggle a route past
  // the allowlist below.
  let path: string;
  try {
    const parsed = new URL(`http://127.0.0.1${rawPath}`);
    if (parsed.hash) throw new Error('fragment');
    path = parsed.pathname + parsed.search;
  } catch {
    throw new Error('Invalid local API path');
  }
  const route = path.split('?')[0];
  if (!isProxyableRoute(route)) {
    throw new Error(`Local API route is not proxyable: ${route}`);
  }

  const headers: Record<string, string> = { ...(request?.headers ?? {}) };
  // Strip anything the page might try to smuggle in under our credentials'
  // names before we attach the real ones.
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (lower === LOCAL_API_TRANSPORT_HEADER || lower === APP_API_KEY_HEADER.toLowerCase() || lower === 'authorization') {
      delete headers[key];
    }
  }
  headers[LOCAL_API_TRANSPORT_HEADER] = sidecar.token;
  if (sidecar.enterpriseKey) headers[APP_API_KEY_HEADER] = sidecar.enterpriseKey;

  const method = request?.method ?? 'GET';
  const resp = await fetch(`${sidecar.baseUrl}${path}`, {
    method,
    headers,
    body:
      method === 'GET' || method === 'HEAD' || !request?.body
        ? undefined
        : Uint8Array.from(request.body),
  });

  const buffer = new Uint8Array(await resp.arrayBuffer());
  if (buffer.byteLength > MAX_PROXY_BYTES) {
    throw new Error('Local API response exceeds the proxy limit');
  }

  return {
    status: resp.status,
    headers: Object.fromEntries(resp.headers.entries()),
    body: Array.from(buffer),
  };
}
