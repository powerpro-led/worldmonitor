import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Matches local-api-server.mjs's own LOCAL_API_TRANSPORT_HEADER constant. */
export const LOCAL_API_TRANSPORT_HEADER = 'x-worldmonitor-local-token';

/** Matches src/services/runtime.ts's DEFAULT_LOCAL_API_PORT and the port the
 * `worldmonitor-local` CLI installs the LaunchAgent on. */
const PORT = 46123;

/** launchd label + plist path written by `worldmonitor-local install` (macOS). */
const LAUNCHD_LABEL = 'com.worldmonitor.local-api';
const LAUNCHD_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);

/** Scheduled Task name `worldmonitor-local install` registers on Windows. */
const WIN_TASK_NAME = 'WorldMonitorLocal';
const IS_WIN = process.platform === 'win32';

/** The loopback transport secret `worldmonitor-local install` writes. Same
 * path resolveLocalApiToken() reads on the backend side. */
const TOKEN_FILE = path.join(os.homedir(), '.worldmonitor', 'local-api-token');

/**
 * A thin client for the standalone local backend.
 *
 * The backend (`vscode-extension/sidecar/local-api-server.mjs`) is owned by
 * launchd, not by this extension — installed once with `worldmonitor-local
 * install`, it runs at login and restarts on crash, independent of whether
 * an editor is open, and is shared with any local MCP agent. This class only
 * ever *connects*: it health-checks the backend, reads the token the CLI
 * persisted, and (at most) asks launchd to restart the service. It never
 * spawns or kills a backend process — the previous SidecarProcess did both,
 * which is exactly what tied the data layer's freshness to the editor's
 * lifecycle and made two VS Code windows fight over port 46123.
 */
export class BackendClient {
  private readonly outputChannel: vscode.OutputChannel;
  readonly port = PORT;

  constructor(context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('WorldMonitor Backend');
    context.subscriptions.push(this.outputChannel);
  }

  get baseUrl(): string {
    // 'localhost', not the bare IP — the dashboard iframe navigates via this
    // origin and nothing depends on switching back to 127.0.0.1 (see the
    // prior sidecarProcess.ts note; the YouTube-embed reason it originally
    // mattered is long gone).
    return `http://localhost:${this.port}`;
  }

  log(message: string): void {
    this.outputChannel.appendLine(message);
  }

  /** Read fresh every call — `worldmonitor-local install` may run after this
   * extension has already activated. */
  private readToken(): string | undefined {
    try {
      const token = readFileSync(TOKEN_FILE, 'utf-8').trim();
      return token || undefined;
    } catch {
      return undefined;
    }
  }

  private async isAlive(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/sidecar-health`, {
        signal: AbortSignal.timeout(2000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * Alive, and — if a token file exists — the backend accepts it. A 404 on an
   * unrouted /api path means the global auth gate passed (a bad token gives
   * 401, an unconfigured backend gives 503). With no token file we can only
   * assert liveness; the dashboard iframe will still 401 until `worldmonitor-
   * local install` has run, which the panel surfaces separately.
   */
  private async isHealthy(): Promise<boolean> {
    if (!(await this.isAlive())) return false;
    const token = this.readToken();
    if (!token) return true;
    try {
      const resp = await fetch(`${this.baseUrl}/api/__sidecar_token_probe`, {
        headers: { [LOCAL_API_TRANSPORT_HEADER]: token },
        signal: AbortSignal.timeout(2000),
      });
      return resp.status === 404;
    } catch {
      return false;
    }
  }

  /** Poll briefly for a backend that should already be running (no spawn to
   * wait on). Longer waits are only warranted right after startBackend(). */
  async ensureReachable(timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isHealthy()) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new BackendUnreachableError(this.port, this.readToken() === undefined);
  }

  /**
   * Ask launchd to (re)start the installed service. Deliberately never a
   * spawn: launchd owns the process, this extension only nudges it.
   *
   * `kickstart -k` handles the common case (job loaded but wedged / crashed
   * past KeepAlive / `launchctl stop`). If the job was booted out entirely —
   * a manual `launchctl bootout`, a logout/login race, `worldmonitor-local
   * uninstall` — kickstart 502s and the plist has to be bootstrapped again
   * (its RunAtLoad then starts the process). Throws only when there is no
   * plist at all, i.e. `worldmonitor-local install` was never run.
   */
  async startBackend(): Promise<void> {
    if (IS_WIN) {
      // The CLI owns the Scheduled Task; this only nudges it. `schtasks /run`
      // forces an immediate start regardless of the logon trigger.
      this.log(`[backend] schtasks /run /tn ${WIN_TASK_NAME}`);
      try {
        await execFileAsync('schtasks', ['/run', '/tn', WIN_TASK_NAME]);
        return;
      } catch {
        throw new Error(
          'backend not installed — run `worldmonitor-local install` (or install.ps1) first',
        );
      }
    }

    const uid = process.getuid?.() ?? 0;
    const target = `gui/${uid}/${LAUNCHD_LABEL}`;
    try {
      this.log(`[backend] launchctl kickstart -k ${target}`);
      await execFileAsync('launchctl', ['kickstart', '-k', target]);
      return;
    } catch {
      this.log('[backend] kickstart failed (job not loaded) — bootstrapping from the plist');
    }
    if (!existsSync(LAUNCHD_PLIST)) {
      throw new Error('backend not installed — run `worldmonitor-local install` first');
    }
    await execFileAsync('launchctl', ['bootout', `gui/${uid}`, LAUNCHD_PLIST]).catch(() => {});
    await execFileAsync('launchctl', ['bootstrap', `gui/${uid}`, LAUNCHD_PLIST]);
  }

  dispose(): void {
    this.outputChannel.dispose();
  }
}

export class BackendUnreachableError extends Error {
  constructor(readonly port: number, readonly tokenMissing: boolean) {
    super(`WorldMonitor local backend is not reachable on 127.0.0.1:${port}.`);
    this.name = 'BackendUnreachableError';
  }
}
