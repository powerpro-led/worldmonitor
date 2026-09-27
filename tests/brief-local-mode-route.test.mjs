// Local-mode brief magazine route (v2.13.18, wmtest Latest Brief report,
// option 2): in LOCAL_API_MODE=tauri-sidecar the route reads the SQLite
// mirror (no Upstash write token exists on an operator machine) and verifies
// links with the sidecar's PER-MACHINE key, ignoring the cloud
// BRIEF_URL_SIGNING_SECRET even when one is present. Runs under tsx.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signBriefUrl, signBriefToken } from '../server/_shared/brief-url.ts';
import { BRIEF_ENVELOPE_VERSION } from '../shared/brief-envelope.js';

const USER = '11111111-2222-3333-4444-555555555555';
const SLOT = '2026-09-27-1200';
const LOCAL_KEY = 'local-per-machine-key-for-test';
const CLOUD_KEY = 'cloud-shared-key-that-must-be-ignored-locally';

function story(overrides = {}) {
  return {
    category: 'Energy', country: 'IR', threatLevel: 'high',
    headline: 'Test headline.', description: 'Test description.',
    source: 'Wire', sourceUrl: 'https://example.com/x', clusterId: 'cluster-1',
    whyMatters: 'Because it matters.', ...overrides,
  };
}

const ENVELOPE = {
  version: BRIEF_ENVELOPE_VERSION,
  issuedAt: 1_700_000_000_000,
  data: {
    user: { name: 'Op', tz: 'UTC' },
    issue: '27.09', date: '2026-09-27', dateLong: '27 September 2026',
    digest: {
      greeting: 'Good afternoon.', lead: 'Lead.',
      numbers: { clusters: 10, multiSource: 2, surfaced: 2 },
      threads: [{ tag: 'Energy', teaser: 'A.' }, { tag: 'Maritime', teaser: 'B.' }],
      signals: ['S1.'],
    },
    stories: [story(), story({ country: 'US', category: 'Maritime', clusterId: 'cluster-2' })],
  },
};

let tmpDir;
let handler;
const saved = {};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-local-route-'));
  const dbPath = path.join(tmpDir, 'local-cache.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE kv_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, type TEXT NOT NULL, synced_at INTEGER NOT NULL)');
  db.prepare('INSERT INTO kv_cache VALUES (?, ?, ?, ?)').run(`brief:${USER}:${SLOT}`, JSON.stringify(ENVELOPE), 'string', Date.now());
  db.close();
  for (const k of ['LOCAL_API_MODE', 'LOCAL_SQLITE_PATH', 'LOCAL_BRIEF_URL_SIGNING_SECRET', 'BRIEF_URL_SIGNING_SECRET']) saved[k] = process.env[k];
  process.env.LOCAL_API_MODE = 'tauri-sidecar';
  process.env.LOCAL_SQLITE_PATH = dbPath;
  process.env.LOCAL_BRIEF_URL_SIGNING_SECRET = LOCAL_KEY;
  process.env.BRIEF_URL_SIGNING_SECRET = CLOUD_KEY; // present, and must be ignored
  ({ default: handler } = await import('../api/brief/[userId]/[issueDate].ts'));
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const get = (url) => handler(new Request(url));

describe('local-mode brief magazine route', () => {
  it('renders the mirrored brief for a link signed with the per-machine key', async () => {
    const url = await signBriefUrl({ userId: USER, issueDate: SLOT, baseUrl: 'http://127.0.0.1:46123', secret: LOCAL_KEY });
    const res = await get(url);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<section class="page/);
  });

  it('rejects a link signed with the CLOUD key, even though it is present', async () => {
    const t = await signBriefToken(USER, SLOT, CLOUD_KEY);
    const res = await get(`http://127.0.0.1:46123/api/brief/${USER}/${SLOT}?t=${t}`);
    assert.equal(res.status, 403);
  });

  it('rejects a tampered token', async () => {
    const res = await get(`http://127.0.0.1:46123/api/brief/${USER}/${SLOT}?t=${'A'.repeat(43)}`);
    assert.equal(res.status, 403);
  });

  it('is an honest expired-404 for a validly signed slot that is not in the mirror', async () => {
    const url = await signBriefUrl({ userId: USER, issueDate: '2026-09-20-0800', baseUrl: 'http://127.0.0.1:46123', secret: LOCAL_KEY });
    const res = await get(url);
    assert.equal(res.status, 404);
  });
});
