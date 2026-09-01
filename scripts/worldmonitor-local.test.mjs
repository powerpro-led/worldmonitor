import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worldmonitor-local.mjs');

/** Run the CLI with an isolated $HOME so nothing touches the real
 * ~/.worldmonitor or ~/Library/LaunchAgents. Returns { status, stdout, stderr }. */
function run(args, home) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function withHome(fn) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wm-local-cli-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('install --dry-run writes a 0600 token and a token-free plist', () => {
  withHome((home) => {
    const res = run(['install', '--dry-run'], home);
    assert.equal(res.status, 0, res.stderr);

    const tokenFile = path.join(home, '.worldmonitor', 'local-api-token');
    const token = readFileSync(tokenFile, 'utf-8').trim();
    assert.match(token, /^[0-9a-f]{48}$/, 'token is 24 random bytes as hex');
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600, 'token file is 0600');

    const plist = readFileSync(
      path.join(home, 'Library', 'LaunchAgents', 'com.worldmonitor.local-api.plist'),
      'utf-8',
    );
    assert.match(plist, /com\.worldmonitor\.local-api/);
    assert.match(plist, /local-api-server\.mjs/);
    assert.match(plist, /<key>LOCAL_API_MODE<\/key><string>tauri-sidecar<\/string>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.doesNotMatch(plist, /LOCAL_API_TOKEN/, 'the secret never goes into the plist');
    assert.doesNotMatch(plist, new RegExp(token), 'the token value never goes into the plist');
  });
});

test('install respects an explicit --token and is idempotent', () => {
  withHome((home) => {
    const explicit = 'a'.repeat(48);
    run(['install', '--dry-run', '--token', explicit], home);
    const tokenFile = path.join(home, '.worldmonitor', 'local-api-token');
    assert.equal(readFileSync(tokenFile, 'utf-8').trim(), explicit);

    // A second plain install must not regenerate the existing token.
    run(['install', '--dry-run'], home);
    assert.equal(readFileSync(tokenFile, 'utf-8').trim(), explicit);
  });
});

test('token prints the secret, --fingerprint prints a 12-hex digest', () => {
  withHome((home) => {
    run(['install', '--dry-run'], home);
    const token = run(['token'], home).stdout.trim();
    assert.match(token, /^[0-9a-f]{48}$/);

    const fp = run(['token', '--fingerprint'], home).stdout.trim();
    assert.match(fp, /^[0-9a-f]{12}$/);
  });
});

test('token before install exits non-zero', () => {
  withHome((home) => {
    const res = run(['token'], home);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /install/);
  });
});

test('whoami with no session exits non-zero', () => {
  withHome((home) => {
    const res = run(['whoami'], home);
    assert.equal(res.status, 1);
    assert.match(res.stdout + res.stderr, /not logged in/);
  });
});

test('status reports DOWN for an unused port and MISSING before install', () => {
  withHome((home) => {
    const res = run(['status', '--port', '59273'], home);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /backend\s+DOWN/);
    assert.match(res.stdout, /token\s+MISSING/);
    assert.match(res.stdout, /identity\s+not logged in/);
  });
});

test('unknown command prints usage and exits 1; bare invocation exits 0', () => {
  withHome((home) => {
    const bad = run(['frobnicate'], home);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /worldmonitor-local —/);

    const bare = run([], home);
    assert.equal(bare.status, 0);
    assert.match(bare.stdout, /SETUP \(one-time, operator\)/);
  });
});
