/**
 * isSidecarBackedRuntime() previously only recognized the Tauri desktop app
 * (window.__TAURI__/__TAURI_INTERNALS__) and the VS Code embed
 * (window.__wmVsCodeApi) — a plain browser tab pointed at the local backend
 * (e.g. the bookmarked http://127.0.0.1:46123/ every operator is told to use
 * per INSTALL.md, and the documented primary way to use this product per
 * PLATFORM_ARCHITECTURE.md's "no Desktop launcher" decision) had neither
 * global set, so every caller of this function silently treated that
 * operator's session as a plain cloud web app instead — traced to a real
 * Windows field report where /api/wm-session kept 503ing in local mode
 * because src/services/wm-session.ts's ensureWmSession() never knew to skip
 * it. Fixed by having the backend inject `window.__WM_RUNTIME_CONFIG.mode`
 * into every document it serves (see local-api-server.mjs's
 * buildRuntimeConfigShim()) and checking it here too.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isSidecarBackedRuntime } from '../src/utils/circuit-breaker';
import { ensureWmSession, __resetWmSessionForTests } from '../src/services/wm-session';

let originalWindow: unknown;

beforeEach(() => {
  originalWindow = (globalThis as { window?: unknown }).window;
});

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
  __resetWmSessionForTests();
});

describe('isSidecarBackedRuntime()', () => {
  it('is false with no window at all (SSR/build-time/plain Node)', () => {
    delete (globalThis as { window?: unknown }).window;
    assert.equal(isSidecarBackedRuntime(), false);
  });

  it('is false for a plain cloud-web-app browser tab (no globals set)', () => {
    (globalThis as { window?: unknown }).window = {};
    assert.equal(isSidecarBackedRuntime(), false);
  });

  it('is true for the Tauri desktop app', () => {
    (globalThis as { window?: unknown }).window = { __TAURI__: {} };
    assert.equal(isSidecarBackedRuntime(), true);
  });

  it('is true for the VS Code embed', () => {
    (globalThis as { window?: unknown }).window = { __wmVsCodeApi: {} };
    assert.equal(isSidecarBackedRuntime(), true);
  });

  it('is true for a plain browser tab served by the local backend (the bug this fixes)', () => {
    (globalThis as { window?: unknown }).window = { __WM_RUNTIME_CONFIG: { mode: 'tauri-sidecar' } };
    assert.equal(isSidecarBackedRuntime(), true);
  });

  it('is false when __WM_RUNTIME_CONFIG is present but mode is something else (e.g. docker dev mode)', () => {
    (globalThis as { window?: unknown }).window = { __WM_RUNTIME_CONFIG: { mode: 'docker' } };
    assert.equal(isSidecarBackedRuntime(), false);
  });
});

describe('ensureWmSession() in sidecar-backed mode', () => {
  it('short-circuits to true without ever calling fetch', async () => {
    (globalThis as { window?: unknown }).window = { __WM_RUNTIME_CONFIG: { mode: 'tauri-sidecar' } };
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalled = true;
      return originalFetch(...args);
    }) as typeof fetch;
    try {
      const ok = await ensureWmSession();
      assert.equal(ok, true);
      assert.equal(fetchCalled, false, 'ensureWmSession() must not call /api/wm-session in sidecar-backed mode');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
