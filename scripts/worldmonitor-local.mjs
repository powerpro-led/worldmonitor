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
 * macOS (launchd LaunchAgent) and Windows (a per-user Scheduled Task at logon,
 * no admin rights) are both supported; the identity commands are pure Node and
 * work anywhere. Mirrors scripts/install-local-sync-agent.sh's idiom; that
 * agent stays as the freshness backstop for when this backend is down.
 */

import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// session.json read/write shared verbatim with the backend (local-api-server.mjs)
// so the CLI login flow and the server's refresh timer can't disagree on the
// file's schema.
import {
  readOperatorSession as readSession,
  operatorSessionFilePath,
} from '../vscode-extension/sidecar/session-file.mjs';
// Config lives in ~/.worldmonitor/config.db, read by both this CLI and the
// backend (local-api-server.mjs). loadConfigIntoEnv() fills process.env for
// keys `.env` didn't set; the `config` subcommand manages the store.
import {
  loadConfigIntoEnv,
  readAllConfig,
  setConfig,
  deleteConfig,
  importFromEnvText,
  getConfigDbPath,
  CONFIG_KEYS,
  SECRET_CONFIG_KEYS,
} from '../vscode-extension/sidecar/config-store.mjs';
// The loopback GitHub OAuth (PKCE) flow, shared verbatim with the backend's
// POST /api/local-login (settings.html "Sign in with GitHub") so the CLI and
// the browser path can't disagree on how session.json is produced.
import { beginGithubLogin } from '../vscode-extension/sidecar/local-login.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_SCRIPT = path.join(REPO_ROOT, 'vscode-extension', 'sidecar', 'local-api-server.mjs');
const SQLITE_PATH = path.join(REPO_ROOT, 'vscode-extension', 'sidecar', 'local-cache.db');
const DOTENV_PATH = path.join(REPO_ROOT, '.env');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const WM_DIR = path.join(os.homedir(), '.worldmonitor');

// The one-command installer (scripts/release/install) fetches a pinned Node
// build into ~/.worldmonitor/runtime/ (D15) so a fresh machine needs no system
// Node. Prefer it for the long-lived service; fall back to whatever node is
// running this CLI when there's no bundled runtime (from-source / dev installs).
const RUNTIME_NODE = IS_WIN
  ? path.join(WM_DIR, 'runtime', 'node.exe')
  : path.join(WM_DIR, 'runtime', 'bin', 'node');
function nodeBin() {
  return existsSync(RUNTIME_NODE) ? RUNTIME_NODE : process.execPath;
}
const TOKEN_FILE = path.join(WM_DIR, 'local-api-token');
const SESSION_FILE = operatorSessionFilePath();

const LABEL = 'com.worldmonitor.local-api';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
// macOS keeps the historical /tmp path (docs + the extension reference it);
// Windows has no /tmp, so its log lives beside the token in ~/.worldmonitor.
const WIN_LOG = path.join(WM_DIR, 'local-api.log');
const LOG = IS_WIN ? WIN_LOG : `/tmp/${LABEL}.log`;

// ── Windows Scheduled Task artefacts (written under ~/.worldmonitor) ──────
const WIN_TASK_NAME = 'WorldMonitorLocal';
const WIN_TASK_XML = path.join(WM_DIR, 'worldmonitor-local-task.xml');
const WIN_RUN_CMD = path.join(WM_DIR, 'worldmonitor-local-run.cmd');
const WIN_RUN_VBS = path.join(WM_DIR, 'worldmonitor-local-run.vbs');

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

function requireServiceOS() {
  if (!IS_MAC && !IS_WIN) {
    die(`service management supports macOS (launchd) and Windows (Scheduled Task) only. Platform: ${process.platform}. Use \`worldmonitor-local run\` to run it in the foreground.`);
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
  const node = nodeBin();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
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

// ── Windows Scheduled Task ───────────────────────────────────────────────
// A per-user logon task (no admin). Task action is `wscript <vbs>`, the vbs
// launches a .cmd wrapper with a hidden window (window style 0), the .cmd sets
// the same env the launchd plist does and runs the backend, appending stdout +
// stderr to LOG. RestartOnFailure in the XML approximates launchd's KeepAlive.
function schtasks(args, { check = true } = {}) {
  try {
    return execFileSync('schtasks', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (check) throw err;
    return null;
  }
}

function winTaskState() {
  const out = schtasks(['/query', '/tn', WIN_TASK_NAME, '/fo', 'LIST'], { check: false });
  if (!out) return 'not installed';
  const m = out.match(/^\s*Status:\s*(.+?)\s*$/mi);
  return m ? m[1] : 'installed';
}

// Kill whatever is LISTENING on `port` (used by restart/uninstall — a detached
// backend child is not owned by the task once wscript returns).
function winKillPort(port) {
  const text = execFileSyncSafe('netstat', ['-ano']) || '';
  const pids = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    if (!new RegExp(`[:.]${port}\\b`).test(line)) continue;
    const pid = line.trim().split(/\s+/).pop();
    if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
  }
  for (const pid of pids) {
    try { execFileSync('taskkill', ['/F', '/PID', pid], { stdio: 'ignore' }); } catch { /* already gone */ }
  }
  return pids.size;
}

function execFileSyncSafe(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}

function writeWinTaskFiles(port) {
  const node = nodeBin();
  // .cmd — the actual launch, env matches writePlist()'s EnvironmentVariables.
  const cmd = [
    '@echo off',
    'setlocal',
    'set "LOCAL_API_MODE=tauri-sidecar"',
    `set "LOCAL_API_PORT=${port}"`,
    `set "LOCAL_API_RESOURCE_DIR=${REPO_ROOT}"`,
    `set "LOCAL_SQLITE_PATH=${SQLITE_PATH}"`,
    `"${node}" "--env-file-if-exists=${DOTENV_PATH}" "${SERVER_SCRIPT}" >> "${LOG}" 2>&1`,
    '',
  ].join('\r\n');
  // .vbs — run the .cmd with no visible window (style 0) and WAIT (True): the
  // wscript process then lives as long as the backend, so Task Scheduler sees
  // the task as Running and RestartOnFailure fires if the backend crashes.
  // Chr(34) for the path quotes — avoids VBScript quote-doubling ambiguity and
  // survives a space in the profile path.
  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    `cmd = "cmd /c " & Chr(34) & "${WIN_RUN_CMD}" & Chr(34)`,
    'sh.Run cmd, 0, True',
    '',
  ].join('\r\n');
  // Task Scheduler definition: logon trigger, hidden, restart 3x/1min.
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>WorldMonitor local backend (127.0.0.1:${port})</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"${WIN_RUN_VBS}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
  ensureWmDir();
  writeFileSync(WIN_RUN_CMD, cmd);
  writeFileSync(WIN_RUN_VBS, vbs);
  // schtasks /create /xml wants UTF-16 with a BOM.
  writeFileSync(WIN_TASK_XML, "\uFEFF" + xml, 'utf16le');
}

// ── .env (for login: Supabase URL + anon key) ────────────────────────────
function loadDotenv() {
  try { process.loadEnvFile(DOTENV_PATH); } catch { /* absent — rely on ambient env */ }
  // Fill any gap from ~/.worldmonitor/config.db (`.env` above still wins).
  loadConfigIntoEnv();
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
  try {
    if (IS_WIN) execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    else if (IS_MAC) execFileSync('open', [url], { stdio: 'ignore' });
    else execFileSync('xdg-open', [url], { stdio: 'ignore' });
  } catch { /* fall back to printed URL */ }
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
  requireServiceOS();
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
    ok('warning: no dist/ build found next to this CLI — the backend still starts');
    ok('         and serves /api/*, but the dashboard page will 404');
  }

  if (IS_WIN) {
    writeWinTaskFiles(port);
    if (flag('dry-run')) {
      ok('');
      ok(`dry run — wrote ${TOKEN_FILE}, ${WIN_TASK_XML} (+ .cmd/.vbs); skipped schtasks.`);
      ok(`  fp ${fingerprint(token)}   port ${port}`);
      return;
    }
    schtasks(['/create', '/tn', WIN_TASK_NAME, '/xml', WIN_TASK_XML, '/f']);
    schtasks(['/run', '/tn', WIN_TASK_NAME], { check: false });
    ok('');
    ok(`installed Scheduled Task "${WIN_TASK_NAME}"`);
    ok(`  backend:  ${nodeBin()} ${SERVER_SCRIPT}`);
    ok(`  port:     127.0.0.1:${port}   (REST for the dashboard, /api/mcp for a local agent)`);
    ok(`  token:    ${TOKEN_FILE}   (fp ${fingerprint(token)})`);
    ok(`  log:      ${LOG}`);
    ok('  starts:   at logon and on failure (LogonTrigger + RestartOnFailure 3x/1min)');
    ok('');
    ok('  status:   worldmonitor-local status');
    ok('  remove:   worldmonitor-local uninstall');
    ok('');
    ok('For user-scoped data (your Latest Brief), also run:  worldmonitor-local login');
    return;
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
  ok(`  backend:  ${nodeBin()} ${SERVER_SCRIPT}`);
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
    nodeBin(),
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

  let flow;
  try {
    flow = await beginGithubLogin({ supabaseUrl: url, supabaseKey: key, callbackPort });
  } catch (e) {
    die(e.message);
  }

  ok('Opening your browser to sign in with GitHub…');
  ok(`  If it doesn't open, visit:\n  ${flow.authUrl}\n`);
  openBrowser(flow.authUrl);

  let saved;
  try {
    saved = await flow.completed;
  } catch (e) {
    ok('');
    ok(`GitHub sign-in did not complete: ${e.message}`);
    ok('If GitHub itself succeeded, your account is likely not in the allow-listed org —');
    ok('ask the operator for an invite (they add you to the GitHub org).');
    process.exit(1);
  }

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
  requireServiceOS();
  const port = Number(opt('port', DEFAULT_PORT));

  if (IS_WIN) {
    if (winTaskState() === 'not installed') die('backend not installed — run `worldmonitor-local install`.');
    // The task's node child is detached once wscript returns, so /end alone
    // won't stop it — kill by listening port, then re-run the task.
    schtasks(['/end', '/tn', WIN_TASK_NAME], { check: false });
    const killed = winKillPort(port);
    schtasks(['/run', '/tn', WIN_TASK_NAME]);
    ok(`backend restarted (killed ${killed} listener${killed === 1 ? '' : 's'} on :${port}, re-ran the task).`);
    return;
  }

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
  const usingRuntime = existsSync(RUNTIME_NODE);
  let nodeVer = '';
  try { nodeVer = execFileSync(nodeBin(), ['-v'], { encoding: 'utf-8' }).trim(); } catch { /* ignore */ }
  ok(`runtime    ${usingRuntime ? 'bundled' : 'system'} node ${nodeVer}  ${nodeBin()}`);
  if (IS_MAC) ok(`launchd    ${launchdState()}  (${LABEL})`);
  if (IS_WIN) ok(`task       ${winTaskState()}  (${WIN_TASK_NAME})`);
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

async function cmdConfig() {
  const args = rest.filter((a) => !a.startsWith('--'));
  const [sub, key, ...valueParts] = args;

  if (!sub || sub === 'list') {
    const stored = readAllConfig();
    ok(`config.db  ${getConfigDbPath()}`);
    for (const k of CONFIG_KEYS) {
      const v = stored[k];
      const shown = v == null
        ? '(unset)'
        : SECRET_CONFIG_KEYS.includes(k) ? 'set' : v;
      ok(`  ${k.padEnd(34)} ${shown}`);
    }
    ok('\n.env and real environment variables override anything stored here.');
    return;
  }
  if (sub === 'set') {
    if (!key || valueParts.length === 0) die('usage: worldmonitor-local config set <KEY> <VALUE>');
    try { setConfig(key, valueParts.join(' ')); } catch (err) { die(err.message); }
    ok(`set ${key}`);
    return;
  }
  if (sub === 'unset') {
    if (!key) die('usage: worldmonitor-local config unset <KEY>');
    deleteConfig(key);
    ok(`unset ${key}`);
    return;
  }
  if (sub === 'import') {
    if (!key) die('usage: worldmonitor-local config import <file>');
    if (!existsSync(key)) die(`file not found: ${key}`);
    let imported;
    try { imported = importFromEnvText(readFileSync(key, 'utf8')); } catch (err) { die(err.message); }
    ok(imported.length ? `imported: ${imported.join(', ')}` : 'nothing imported (no allow-listed keys in that file)');
    return;
  }
  die(`unknown: config ${sub}  (use: list | set | unset | import)`);
}

async function cmdUninstall() {
  requireServiceOS();
  const port = Number(opt('port', DEFAULT_PORT));

  if (IS_WIN) {
    schtasks(['/end', '/tn', WIN_TASK_NAME], { check: false });
    winKillPort(port);
    schtasks(['/delete', '/tn', WIN_TASK_NAME, '/f'], { check: false });
    for (const f of [WIN_TASK_XML, WIN_RUN_CMD, WIN_RUN_VBS]) rmSync(f, { force: true });
    ok(`removed Scheduled Task "${WIN_TASK_NAME}" and its launcher files.`);
    ok(`left ~/.worldmonitor/ intact (token + session). Delete that folder to fully purge.`);
    return;
  }

  try { execFileSync('launchctl', ['bootout', guiTarget()], { stdio: 'ignore' }); } catch { /* already gone */ }
  rmSync(PLIST, { force: true });
  ok(`removed ${LABEL} and its plist.`);
  ok(`left ~/.worldmonitor/ intact (token + session). \`rm -rf ~/.worldmonitor\` to fully purge.`);
}

function usage() {
  const svc = IS_WIN ? 'Scheduled Task' : 'launchd service';
  ok(`worldmonitor-local — manage the standalone local backend
  (macOS: launchd LaunchAgent · Windows: per-user Scheduled Task at logon)

  install [--token <hex>] [--port <n>] [--dry-run]
                                         generate the loopback token + install the ${svc}
  uninstall                              remove the ${svc} (keeps ~/.worldmonitor/)
  run [--token <hex>] [--port <n>]       run the backend in the foreground (no service)
  restart                                restart the installed ${svc}

  login [--callback-port <n>]            GitHub OAuth -> Supabase session -> ~/.worldmonitor/session.json
  logout                                 revoke + delete the stored session
  whoami                                 print the logged-in identity

  status                                 backend / service / token / identity at a glance
  token [--fingerprint]                  print the loopback token (for an MCP client's header)

  config list                            show stored config (~/.worldmonitor/config.db; secrets masked)
  config set <KEY> <VALUE>               store one allow-listed key
  config unset <KEY>                     remove one key
  config import <file>                   seed config.db from an org.env / .env

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
  config: cmdConfig,
  help: async () => usage(),
};

const handler = commands[command];
if (!handler) { usage(); process.exit(command ? 1 : 0); }
handler().catch((err) => die(err?.stack || err?.message || String(err)));
