// @vitest-environment node

/**
 * Workstream 5 (PLATFORM_ARCHITECTURE.md, OQ-P7) — the worker-side mirror of
 * the LOCAL backend's `loadConfigIntoEnv()` (vscode-extension/sidecar/config-store.mjs):
 * periodically copies `pipeline_config` rows into `process.env` so a live
 * admin-panel edit reaches a running worker within 5 minutes without a
 * restart, and — the whole point of OQ-P7 — a revoked/rotated key is never
 * shadowed by a stale value.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const getSupabaseAdmin = vi.fn();
vi.mock('../_shared/supabase-admin', () => ({
  getSupabaseAdmin: (...a: unknown[]) => getSupabaseAdmin(...a),
}));

import {
  hydratePipelineConfig,
  startPipelineConfigHydration,
  HYDRATION_INTERVAL_MS,
  __resetPipelineConfigHydrationForTests,
} from '../_shared/pipeline-config-hydration';

beforeEach(() => {
  getSupabaseAdmin.mockReset();
  __resetPipelineConfigHydrationForTests();
});

describe('hydratePipelineConfig', () => {
  test('is a no-op when Supabase is unconfigured', async () => {
    getSupabaseAdmin.mockReturnValue(null);
    const env: NodeJS.ProcessEnv = { ACLED_EMAIL: 'kept@example.com' };
    const changed = await hydratePipelineConfig(env);
    expect(changed).toEqual([]);
    expect(env.ACLED_EMAIL).toBe('kept@example.com');
  });

  test('is a no-op on a query error, without throwing', async () => {
    const select = vi.fn(async () => ({ data: null, error: { message: 'boom' } }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ select })) });
    const env: NodeJS.ProcessEnv = {};
    await expect(hydratePipelineConfig(env)).resolves.toEqual([]);
  });

  test('writes every row into env and reports the changed keys', async () => {
    const select = vi.fn(async () => ({
      data: [
        { key: 'FRED_API_KEY', value: 'fred-123' },
        { key: 'ACLED_EMAIL', value: 'org@example.com' },
      ],
      error: null,
    }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ select })) });

    const env: NodeJS.ProcessEnv = {};
    const changed = await hydratePipelineConfig(env);
    expect(changed.sort()).toEqual(['ACLED_EMAIL', 'FRED_API_KEY']);
    expect(env.FRED_API_KEY).toBe('fred-123');
    expect(env.ACLED_EMAIL).toBe('org@example.com');
  });

  test('pipeline_config ALWAYS wins over an existing env value — the core OQ-P7 contract', async () => {
    // A revoked/rotated key must never be shadowed by a stale process.env
    // value — unlike the LOCAL backend's operator-supplied-.env-wins branch,
    // there is no such branch here: every row is brokered by definition.
    const select = vi.fn(async () => ({
      data: [{ key: 'FRED_API_KEY', value: 'new-rotated-key' }],
      error: null,
    }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ select })) });

    const env: NodeJS.ProcessEnv = { FRED_API_KEY: 'stale-key-from-somewhere' };
    const changed = await hydratePipelineConfig(env);
    expect(changed).toEqual(['FRED_API_KEY']);
    expect(env.FRED_API_KEY).toBe('new-rotated-key');
  });

  test('an unchanged value is not reported as changed', async () => {
    const select = vi.fn(async () => ({
      data: [{ key: 'FRED_API_KEY', value: 'same-value' }],
      error: null,
    }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ select })) });

    const env: NodeJS.ProcessEnv = { FRED_API_KEY: 'same-value' };
    const changed = await hydratePipelineConfig(env);
    expect(changed).toEqual([]);
  });

  test('skips malformed rows without throwing', async () => {
    const select = vi.fn(async () => ({
      data: [{ key: '', value: 'x' }, { key: 'OK_KEY', value: 42 }, { key: 'GOOD_KEY', value: 'ok' }],
      error: null,
    }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ select })) });

    const env: NodeJS.ProcessEnv = {};
    const changed = await hydratePipelineConfig(env);
    expect(changed).toEqual(['GOOD_KEY']);
  });
});

describe('startPipelineConfigHydration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('hydrates immediately, then again every HYDRATION_INTERVAL_MS', async () => {
    const select = vi.fn(async () => ({ data: [{ key: 'K', value: 'v1' }], error: null }));
    getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => ({ select })) });

    const env: NodeJS.ProcessEnv = {};
    const handle = await startPipelineConfigHydration(env);
    try {
      expect(env.K).toBe('v1');

      select.mockResolvedValue({ data: [{ key: 'K', value: 'v2' }], error: null });
      await vi.advanceTimersByTimeAsync(HYDRATION_INTERVAL_MS);
      expect(env.K).toBe('v2');
    } finally {
      clearInterval(handle);
    }
  });
});
