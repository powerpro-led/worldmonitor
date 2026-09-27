// Regression (found live 2026-09-27): api/latest-brief.ts's publicBaseUrl()
// pinned magazineUrl to WORLDMONITOR_PUBLIC_BASE_URL even in local sidecar
// mode. That var is scoped to the cloud digest-notification composer
// (scripts/seed-digest-notifications.mjs, .env.example's own comment) — a
// leftover value from unrelated local `nitric start` testing (:9001) broke
// every "Open brief" link on a real local install with nothing listening
// there, even though the sidecar itself (46123) was healthy.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BRIEF_ENVELOPE_VERSION } from '../shared/brief-envelope.js';

const USER = '11111111-2222-3333-4444-555555555555';
const SLOT = '2026-09-27-1200';
const STALE_CLOUD_PIN = 'http://localhost:9001'; // the exact value found live

let tmpDir;
let handler;
const saved = {};
const originalFetch = globalThis.fetch;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latest-brief-baseurl-'));
  const dbPath = path.join(tmpDir, 'local-cache.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE kv_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, type TEXT NOT NULL, synced_at INTEGER NOT NULL)');
  // Minimal valid v4 envelope — assertBriefEnvelope() (reused by
  // readBriefPreview) requires clusterId + the full story shape, or the
  // route treats it as a composer bug and reports 'composing' instead of
  // 'ready', which would hide the actual thing under test.
  const story = {
    category: 'Energy', country: 'IR', threatLevel: 'high',
    headline: 'H.', description: 'D.', source: 'W', sourceUrl: 'https://example.com/x',
    clusterId: 'cluster-1', whyMatters: 'W.',
  };
  const envelope = {
    version: BRIEF_ENVELOPE_VERSION,
    issuedAt: 1,
    data: {
      user: { name: 'Op', tz: 'UTC' },
      issue: '27.09', date: '2026-09-27', dateLong: '27 September 2026',
      digest: {
        greeting: 'Hi.', lead: 'L.',
        numbers: { clusters: 1, multiSource: 1, surfaced: 1 },
        threads: [{ tag: 'Energy', teaser: 'A.' }],
        signals: ['S.'],
      },
      stories: [story],
    },
  };
  db.prepare('INSERT INTO kv_cache VALUES (?, ?, ?, ?)').run(`brief:latest:${USER}`, JSON.stringify({ issueSlot: SLOT }), 'string', Date.now());
  db.prepare('INSERT INTO kv_cache VALUES (?, ?, ?, ?)').run(`brief:${USER}:${SLOT}`, JSON.stringify(envelope), 'string', Date.now());
  db.close();

  for (const k of [
    'LOCAL_API_MODE', 'LOCAL_SQLITE_PATH', 'LOCAL_BRIEF_URL_SIGNING_SECRET',
    'WORLDMONITOR_PUBLIC_BASE_URL', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY',
    'BRIEF_URL_SIGNING_SECRET',
  ]) saved[k] = process.env[k];
  process.env.LOCAL_API_MODE = 'tauri-sidecar';
  process.env.LOCAL_SQLITE_PATH = dbPath;
  process.env.LOCAL_BRIEF_URL_SIGNING_SECRET = 'local-test-key';
  // Also set on the pre-fix code path's own gate (a cloud secret, which
  // that code reads unconditionally) so a run against the OLD publicBaseUrl()
  // reaches 'ready' too — isolating THIS regression from the separate,
  // already-covered resolveBriefSigningSecrets() fix.
  process.env.BRIEF_URL_SIGNING_SECRET = 'cloud-test-key-irrelevant-locally';
  // The exact shape of the real bug: a stale cloud-scoped override left in
  // the environment while running as the local sidecar.
  process.env.WORLDMONITOR_PUBLIC_BASE_URL = STALE_CLOUD_PIN;
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'anon-key';

  // server/auth-session.ts's validateViaGoTrue() — the local-sidecar JWT path
  // when no Supabase public key is configured — does a GoTrue /auth/v1/user
  // fetch. Stub it so the handler reaches its 'ready' branch without a real
  // Supabase project.
  globalThis.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) {
      return new Response(JSON.stringify({ id: USER, aud: 'authenticated' }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };

  ({ default: handler } = await import(`../api/latest-brief.ts?t=${Date.now()}`));
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('publicBaseUrl in local sidecar mode', () => {
  it('builds magazineUrl from the real request origin, never the stale cloud pin', async () => {
    const req = new Request('http://127.0.0.1:46123/api/latest-brief', {
      headers: { Authorization: 'Bearer test-token' },
    });
    const res = await handler(req);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ready');
    assert.ok(body.magazineUrl, 'expected a magazineUrl');
    const origin = new URL(body.magazineUrl).origin;
    assert.equal(origin, 'http://127.0.0.1:46123');
    assert.notEqual(origin, STALE_CLOUD_PIN);
  });
});
