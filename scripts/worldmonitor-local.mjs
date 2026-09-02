#!/usr/bin/env node
/**
 * worldmonitor-local — manage the standalone local backend that both the
 * VS Code dashboard extension and a local MCP agent consume.
 *
 * Two concerns, deliberately separate (run in any order):
 *
 *   install / uninstall / run — the machine plumbing. Generates the loopback
 *     transport secret (~/.worldmonitor/local-api-token, 0600) that guards
 *     127.0.0.1:<port>, and installs a launchd LaunchAgent
 *     (com.worldmonitor.local-api, RunAtLoad + KeepAlive) that runs
 *     vscode-extension/sidecar/local-api-server.mjs independent of any editor.
 *     No identity involved.
 *
 *   login / logout / whoami — the operator identity. A loopback GitHub OAuth
 *     flow through this fork's existing Supabase project: GitHub consent →
 *     the `worldmonitor-org-gate` before-user-created Auth Hook (org
 *     membership IS the invite) → a Supabase session persisted to
 *     ~/.worldmonitor/session.json (0600). local-sync.mjs reads it to scope
 *     the per-user `brief:` mirror; nothing new is deployed for any of this.
 *
 * macOS only (launchd). Mirrors scripts/install-local-sync-agent.sh's idiom;
 * that agent stays as the freshness backstop for when this backend is down.
 */

import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync,
} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// session.json read/write shared verbatim with the backend (local-api-server.mjs)
// so the CLI login flow and the server's refresh timer can't disagree on the
// file's schema.
import {
  readOperatorSession as readSession,
  writeOperatorSession as writeSession,
  operatorSessionFilePath,
} from '../vscode-extension/sidecar/session-file.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_SCRIPT = path.join(REPO_ROOT, 'vscode-extension', 'sidecar', 'local-api-server.mjs');
const SQLITE_PATH = path.join(REPO_ROOT, 'vscode-extension', 'sidecar', 'local-cache.db');
const DOTENV_PATH = path.join(REPO_ROOT, '.env');

const WM_DIR = path.join(os.homedir(), '.worldmonitor');
const TOKEN_FILE = path.join(WM_DIR, 'local-api-token');
const SESSION_FILE = operatorSessionFilePath();

const LABEL = 'com.worldmonitor.local-api';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = `/tmp/${LABEL}.log`;

const DEFAULT_PORT = 46123;
// Pinned (not ephemeral) so the operator allowlists exactly ONE redirect URL
// in the Supabase project — see `login`'s SETUP note. Override with
// --callback-port only if 46124 is taken during the ~60s of the flow.
const DEFAULT_CALLBACK_PORT = 46124;

// ── arg parsing ────────────────────────────────────────────────────────────
const [, , command, ...rest] = process.argv;
const flag = (name) => rest.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i !== -1 && rest[i + 1] ? rest[i + 1] : fallback;
};

const die = (msg) => { console.error(`error: ${msg}`); process.exit(1); };
const ok = (msg) => console.log(msg);

function requireDarwin() {
  if (process.platform !== 'darwin') {
    die(`this command is macOS-only (launchd). Platform: ${process.platform}.`);
  }
}

function ensureWmDir() {
  mkdirSync(WM_DIR, { recursive: true, mode: 0o700 });
}

function fingerprint(secret) {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

// ── token (loopback transport secret) ─────────────────────────────────────
function readToken() {
  try {
    const t = readFileSync(TOKEN_FILE, 'utf-8').trim();
    return t || null;
  } catch {
    return null;
  }
}

function ensureToken() {
  const existing = readToken();
  if (existing) return existing;
  ensureWmDir();
  const token = randomBytes(24).toString('hex');
  writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600); // writeFileSync honours mode only on create
  return token;
}

// ── launchd ──────────────────────────────────────────────────────────────
function guiTarget() {
  return `gui/${process.getuid()}/${LABEL}`;
}

function launchdState() {
  try {
    const out = execFileSync('launchctl', ['print', guiTarget()], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/state\s*=\s*(\S+)/);
    return m ? m[1] : 'loaded';
  } catch {
    return 'not loaded';
  }
}

function writePlist(port) {
  const nodeBin = process.execPath;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>--env-file-if-exists=${DOTENV_PATH}</string>
    <string>${SERVER_SCRIPT}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LOCAL_API_MODE</key><string>tauri-sidecar</string>
    <key>LOCAL_API_PORT</key><string>${port}</string>
    <key>LOCAL_API_RESOURCE_DIR</key><string>${REPO_ROOT}</string>
    <key>LOCAL_SQLITE_PATH</key><string>${SQLITE_PATH}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${REPO_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG}</string>
  <key>StandardErrorPath</key>
  <string>${LOG}</string>
</dict>
</plist>
`;
  mkdirSync(path.dirname(PLIST), { recursive: true });
  writeFileSync(PLIST, plist);
}

function bootstrap() {
  try { execFileSync('launchctl', ['bootout', guiTarget()], { stdio: 'ignore' }); } catch { /* not loaded yet */ }
  execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, PLIST], { stdio: 'inherit' });
}

// ── .env (for login: Supabase URL + anon key) ────────────────────────────
function loadDotenv() {
  try { process.loadEnvFile(DOTENV_PATH); } catch { /* absent — rely on ambient env */ }
}

function supabaseConfig() {
  loadDotenv();
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    die('VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY not found in .env — cannot run the login flow.');
  }
  return { url, key };
}

function openBrowser(url) {
  try { execFileSync('open', [url], { stdio: 'ignore' }); } catch { /* fall back to printed URL */ }
}

// ── session.json ── read/write imported from the shared sidecar module above.
function describeExpiry(expiresAt) {
  if (!expiresAt) return 'unknown expiry';
  const deltaMs = expiresAt * 1000 - Date.now();
  if (deltaMs <= 0) return 'EXPIRED — run `worldmonitor-local login`';
  const mins = Math.round(deltaMs / 60000);
  return mins < 60 ? `expires in ${mins}m` : `expires in ${Math.round(mins / 60)}h`;
}

// ── commands ─────────────────────────────────────────────────────────────
async function cmdInstall() {
  requireDarwin();
  const port = Number(opt('port', DEFAULT_PORT));
  const explicitToken = opt('token', null);

  ensureWmDir();
  if (explicitToken) {
    writeFileSync(TOKEN_FILE, `${explicitToken.trim()}\n`, { mode: 0o600 });
    chmodSync(TOKEN_FILE, 0o600);
  }
  const token = ensureToken();

  // The backend serves dist/index.html for /dashboard.html when the latter is
  // absent (a VITE_DESKTOP_RUNTIME=1 build emits only index.html), so either
  // file is fine — warn only when neither exists.
  if (!existsSync(path.join(REPO_ROOT, 'dist', 'dashboard.html'))
      && !existsSync(path.join(REPO_ROOT, 'dist', 'index.html'))) {
    ok('warning: no dist/ build found — run `npm run build` from the repo root');
    ok('         (the backend still starts and serves /api/*, but the dashboard page will 404)');
  }

  writePlist(port);
  if (flag('dry-run')) {
    ok('');
    ok(`dry run — wrote ${TOKEN_FILE} and ${PLIST}, skipped launchctl bootstrap.`);
    ok(`  fp ${fingerprint(token)}   port ${port}`);
    return;
  }
  bootstrap();

  ok('');
  ok(`installed ${LABEL}`);
  ok(`  backend:  ${process.execPath} ${SERVER_SCRIPT}`);
  ok(`  port:     127.0.0.1:${port}   (REST for the dashboard, /api/mcp for a local agent)`);
  ok(`  token:    ${TOKEN_FILE}   (fp ${fingerprint(token)})`);
  ok(`  log:      ${LOG}`);
  ok(`  starts:   at login and on crash (RunAtLoad + KeepAlive)`);
  ok('');
  ok('  status:   worldmonitor-local status');
  ok('  remove:   worldmonitor-local uninstall');
  ok('');
  ok('For user-scoped data (your Latest Brief), also run:  worldmonitor-local login');
}

async function cmdRun() {
  const port = Number(opt('port', DEFAULT_PORT));
  const explicitToken = opt('token', null);
  if (explicitToken) {
    ensureWmDir();
    writeFileSync(TOKEN_FILE, `${explicitToken.trim()}\n`, { mode: 0o600 });
    chmodSync(TOKEN_FILE, 0o600);
  }
  if (!readToken()) {
    die('no transport token — run `worldmonitor-local install` first, or pass --token <hex>.');
  }

  const child = spawn(
    process.execPath,
    [`--env-file-if-exists=${DOTENV_PATH}`, SERVER_SCRIPT],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        LOCAL_API_MODE: 'tauri-sidecar',
        LOCAL_API_PORT: String(port),
        LOCAL_API_RESOURCE_DIR: REPO_ROOT,
        LOCAL_SQLITE_PATH: SQLITE_PATH,
      },
    },
  );
  const forward = (sig) => { if (!child.killed) child.kill(sig); };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}

async function cmdLogin() {
  const { url, key } = supabaseConfig();
  const callbackPort = Number(opt('callback-port', DEFAULT_CALLBACK_PORT));
  const redirectTo = `http://127.0.0.1:${callbackPort}/callback`;

  const { createClient } = await import('@supabase/supabase-js');
  const memStore = new Map();
  const supabase = createClient(url, key, {
    auth: {
      flowType: 'pkce',
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: {
        getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
        setItem: (k, v) => memStore.set(k, v),
        removeItem: (k) => memStore.delete(k),
      },
    },
  });

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: { redirectTo, skipBrowserRedirect: true, scopes: 'read:user user:email' },
  });
  if (error || !data?.url) die(`could not start GitHub OAuth: ${error?.message || 'no URL returned'}`);

  const outcome = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, redirectTo);
      if (reqUrl.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const code = reqUrl.searchParams.get('code');
      const errParam = reqUrl.searchParams.get('error_description') || reqUrl.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><meta charset=utf-8><body style="font:14px system-ui;padding:3rem">
        <h2>WorldMonitor CLI</h2><p>${code ? 'Sign-in complete — you can close this tab.' : 'Sign-in failed — check the terminal.'}</p>`);
      server.close();
      resolve({ code, errParam });
    });
    server.on('error', (e) => {
      die(e.code === 'EADDRINUSE'
        ? `callback port ${callbackPort} is busy — retry with --callback-port <n> (and allowlist that URL in Supabase).`
        : `callback server failed: ${e.message}`);
    });
    server.listen(callbackPort, '127.0.0.1', () => {
      ok(`Opening your browser to sign in with GitHub…`);
      ok(`  If it doesn't open, visit:\n  ${data.url}\n`);
      openBrowser(data.url);
    });
    setTimeout(() => { server.close(); resolve({ timedOut: true }); }, 180_000);
  });

  if (outcome.timedOut) die('timed out waiting for the browser callback (3 min).');
  if (outcome.errParam || !outcome.code) {
    ok('');
    ok(`GitHub sign-in did not complete: ${outcome.errParam || 'no authorization code returned'}`);
    ok('If GitHub itself succeeded, your account is likely not in the allow-listed org —');
    ok('ask the operator for an invite (they add you to the GitHub org).');
    process.exit(1);
  }

  const { data: exchanged, error: exErr } = await supabase.auth.exchangeCodeForSession(outcome.code);
  if (exErr || !exchanged?.session) die(`code exchange failed: ${exErr?.message || 'no session'}`);

  const saved = writeSession(exchanged.session);
  ok('');
  ok(`Logged in as ${saved.user.email || saved.user.id}`);
  ok(`  session:  ${SESSION_FILE}   (${describeExpiry(saved.expires_at)})`);
  ok('  The backend keeps this token refreshed while it runs; re-run `login` only if it sits idle for weeks.');
  ok('  Restart the backend to pick it up now:  worldmonitor-local restart');
}

async function cmdLogout() {
  const session = readSession();
  if (!session) { ok('not logged in — nothing to do.'); return; }
  try {
    const { url, key } = supabaseConfig();
    await fetch(`${url}/auth/v1/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: key },
    });
  } catch { /* best-effort server-side revoke */ }
  rmSync(SESSION_FILE, { force: true });
  ok('Logged out — removed ~/.worldmonitor/session.json.');
  ok('The backend keeps running; user-scoped routes will 401 until you log in again.');
}

async function cmdRestart() {
  requireDarwin();
  // `kickstart -k` only works while the job is still loaded (crashed past
  // KeepAlive, `launchctl stop`, or just wedged). If it was booted out
  // entirely — `uninstall`, a manual `launchctl bootout`, a logout/login
  // race — kickstart 502s and the job has to be bootstrapped from the plist
  // again (RunAtLoad then starts it).
  try {
    execFileSync('launchctl', ['kickstart', '-k', guiTarget()], { stdio: ['ignore', 'ignore', 'pipe'] });
    ok('backend restarted (kickstart).');
    return;
  } catch { /* not loaded — fall through to bootstrap */ }
  if (!existsSync(PLIST)) die('backend not installed — run `worldmonitor-local install`.');
  try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}`, PLIST], { stdio: 'ignore' }); } catch { /* wasn't loaded */ }
  execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, PLIST], { stdio: 'inherit' });
  ok('backend restarted (re-bootstrapped from the plist).');
}

async function cmdStatus() {
  const port = Number(opt('port', DEFAULT_PORT));
  const token = readToken();
  const session = readSession();

  let health = null;
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/sidecar-health`, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) health = await resp.json();
  } catch { /* down */ }

  ok(`backend    ${health ? `up   127.0.0.1:${port}  (mode ${health.mode})` : `DOWN 127.0.0.1:${port}`}`);
  if (process.platform === 'darwin') ok(`launchd    ${launchdState()}  (${LABEL})`);
  ok(`token      ${token ? `set   fp ${fingerprint(token)}   ${TOKEN_FILE}` : 'MISSING — run `worldmonitor-local install`'}`);
  ok(`identity   ${session ? `${session.user?.email || session.user?.id}  (${describeExpiry(session.expires_at)})` : 'not logged in — run `worldmonitor-local login`'}`);
  if (health && token) ok(`mcp        http://127.0.0.1:${port}/api/mcp   header  x-worldmonitor-local-token: <worldmonitor-local token>`);
}

async function cmdWhoami() {
  const session = readSession();
  if (!session) { ok('not logged in — run `worldmonitor-local login`.'); process.exit(1); }
  ok(`${session.user?.email || '(no email)'}`);
  ok(`  user id:  ${session.user?.id}`);
  ok(`  session:  ${describeExpiry(session.expires_at)}`);
}

async function cmdToken() {
  const token = readToken();
  if (!token) { console.error('no token yet — run `worldmonitor-local install`.'); process.exit(1); }
  ok(flag('fingerprint') ? fingerprint(token) : token);
}

async function cmdUninstall() {
  requireDarwin();
  try { execFileSync('launchctl', ['bootout', guiTarget()], { stdio: 'ignore' }); } catch { /* already gone */ }
  rmSync(PLIST, { force: true });
  ok(`removed ${LABEL} and its plist.`);
  ok(`left ~/.worldmonitor/ intact (token + session). \`rm -rf ~/.worldmonitor\` to fully purge.`);
}

function usage() {
  ok(`worldmonitor-local — manage the standalone local backend

  install [--token <hex>] [--port <n>] [--dry-run]
                                         generate the loopback token + install the launchd service
  uninstall                              remove the launchd service (keeps ~/.worldmonitor/)
  run [--token <hex>] [--port <n>]       run the backend in the foreground (no launchd)
  restart                                launchctl kickstart -k the installed service

  login [--callback-port <n>]            GitHub OAuth -> Supabase session -> ~/.worldmonitor/session.json
  logout                                 revoke + delete the stored session
  whoami                                 print the logged-in identity

  status                                 backend / launchd / token / identity at a glance
  token [--fingerprint]                  print the loopback token (for an MCP client's header)

SETUP (one-time, operator): add  http://127.0.0.1:${DEFAULT_CALLBACK_PORT}/callback  to the Supabase
project's Auth -> URL Configuration -> Redirect URLs, so \`login\`'s loopback is accepted.`);
}

const commands = {
  install: cmdInstall,
  uninstall: cmdUninstall,
  run: cmdRun,
  restart: cmdRestart,
  login: cmdLogin,
  logout: cmdLogout,
  whoami: cmdWhoami,
  status: cmdStatus,
  token: cmdToken,
  help: async () => usage(),
};

const handler = commands[command];
if (!handler) { usage(); process.exit(command ? 1 : 0); }
handler().catch((err) => die(err?.stack || err?.message || String(err)));
