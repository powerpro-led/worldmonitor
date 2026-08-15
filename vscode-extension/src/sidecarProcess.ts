import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';

/** Matches local-api-server.mjs's own LOCAL_API_TRANSPORT_HEADER constant. */
export const LOCAL_API_TRANSPORT_HEADER = 'x-worldmonitor-local-token';

/** Matches src/services/runtime.ts's own DEFAULT_LOCAL_API_PORT — the real
 * built app already knows to call this port when VITE_DESKTOP_RUNTIME=1 was
 * baked in at build time, so no extra wiring is needed on the app side. */
const PORT = 46123;

/**
 * Spawns and health-checks `local-api-server.mjs` — a plain Node script (no
 * Rust/Tauri involved) — in `LOCAL_API_MODE=tauri-sidecar` mode, which
 * makes every server/_shared/redis.ts read resolve through
 * server/_shared/sidecar-cache.ts's local SQLite mirror instead of live
 * Upstash. `LOCAL_API_CLOUD_FALLBACK` is deliberately left unset (its
 * default is false) — the sidecar's own cloud-fallback proxy path only
 * activates when that env var is explicitly 'true', so this process
 * structurally never calls out to the deployed API domain for the domains
 * this dashboard reads, matching the "local cached, not network fetch"
 * requirement by construction, not just by convention.
 */
export class SidecarProcess {
  private proc: ChildProcess | undefined;
  private readonly outputChannel: vscode.OutputChannel;
  readonly port = PORT;
  /**
   * A per-session shared secret, generated fresh on each activation and
   * never persisted. local-api-server.mjs's global auth gate default-denies
   * every request unless LOCAL_API_TOKEN is set AND the caller echoes it
   * back — this is exactly that token; the real Tauri desktop app does the
   * same thing via its own Rust-side IPC, this extension just does it in
   * plain TypeScript instead.
   */
  readonly token = randomBytes(24).toString('hex');

  constructor(private readonly repoRoot: string, context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('WorldMonitor Sidecar');
    context.subscriptions.push(this.outputChannel);
    context.subscriptions.push({ dispose: () => this.dispose() });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Shared with DashboardPanel so webview-side diagnostics land in the same
   * channel as the sidecar's own output — the two halves of a failed startup
   * are only readable next to each other.
   */
  log(message: string): void {
    this.outputChannel.appendLine(message);
  }

  async ensureRunning(): Promise<void> {
    // Gate on `this.proc`, not on a bare health probe: `this.token` is
    // generated fresh per instance, so on a first activation there is by
    // definition no listener that already knows it, and the probe below can
    // only ever describe someone else's process.
    if (this.proc && (await this.isHealthy())) return;
    // Not healthy against OUR token doesn't mean nothing is listening —
    // reinstalling/reloading this extension restarts the extension host
    // (observed live: VS Code does this silently on `--force` reinstall,
    // no explicit window reload needed), which hands out a fresh
    // SidecarProcess with a fresh random token while the PREVIOUS
    // activation's child process is often still alive and still holding
    // port 46123. That orphan answers real HTTP requests (so a plain
    // curl looks "healthy") but will never accept our new token, and
    // our own respawn attempt would just fall back to a random port
    // nothing else queries. Proactively clear the port first so this is
    // self-healing across reloads instead of accumulating orphans.
    await this.killStaleOccupant();
    this.start();
    await this.waitUntilHealthy();
  }

  /**
   * Best-effort, POSIX-only (macOS/Linux — this operator's platform;
   * Windows just risks a stuck port here, surfaced via the timeout error
   * + output channel rather than silently mishandled). No-ops cleanly
   * when nothing is listening (lsof exits non-zero with empty output).
   */
  private async killStaleOccupant(): Promise<void> {
    if (process.platform === 'win32') return;
    try {
      const { execSync } = await import('node:child_process');
      const pids = execSync(`lsof -ti:${this.port}`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
      if (!pids) return;
      for (const pid of pids.split('\n')) {
        if (pid) execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
      }
      this.outputChannel.appendLine(`[sidecar] cleared stale process(es) on port ${this.port}: ${pids.replace(/\n/g, ', ')}`);
    } catch {
      // lsof exits non-zero when nothing matches on the port — expected.
    }
  }

  private start(): void {
    if (this.proc) return;
    const sidecarScript = path.join(this.repoRoot, 'vscode-extension', 'sidecar', 'local-api-server.mjs');
    const sqlitePath = path.join(this.repoRoot, 'vscode-extension', 'sidecar', 'local-cache.db');
    this.outputChannel.appendLine(`[sidecar] starting: node ${sidecarScript}`);
    this.outputChannel.appendLine(`[sidecar] LOCAL_SQLITE_PATH=${sqlitePath}`);

    this.proc = spawn(
      process.execPath,
      [sidecarScript],
      {
        cwd: this.repoRoot,
        env: {
          ...process.env,
          LOCAL_API_MODE: 'tauri-sidecar',
          LOCAL_API_PORT: String(this.port),
          LOCAL_API_RESOURCE_DIR: this.repoRoot,
          LOCAL_SQLITE_PATH: sqlitePath,
          LOCAL_API_TOKEN: this.token,
          // No WORLDMONITOR_VALID_KEYS wiring needed — api/_api-key.js's
          // app-level entitlement gate is unconditionally bypassed for
          // LOCAL_API_MODE=tauri-sidecar requests (see server/gateway.ts's
          // isLocalSidecarMode), same as the real Tauri desktop app.
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.proc.stdout?.on('data', (chunk: Buffer) => this.outputChannel.append(chunk.toString()));
    this.proc.stderr?.on('data', (chunk: Buffer) => this.outputChannel.append(chunk.toString()));
    this.proc.on('exit', (code) => {
      this.outputChannel.appendLine(`[sidecar] exited with code ${code}`);
      this.proc = undefined;
    });
    this.proc.on('error', (err) => {
      this.outputChannel.appendLine(`[sidecar] failed to start: ${err.message}`);
      this.proc = undefined;
    });
  }

  /**
   * Deliberately NOT /api/version. That route (api/version.js) is a live
   * GitHub Releases lookup via fetchLatestRelease() — measured locally at
   * 0.6s–2.2s per call, straddling this probe's own timeout, and it answers
   * 502 outright once GitHub rate-limits the unauthenticated caller (60
   * req/hr, and a single 45s activation at 300ms intervals burns ~30 of
   * them). So the probe reported "not healthy" while the sidecar was up and
   * serving — exactly the failure this replaces. /api/sidecar-health is the
   * server's documented liveness contract: auth-exempt, dependency-free, no
   * cloud/Redis/SQLite access, and it answers in ~1ms.
   */
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
   * Liveness alone can't tell our sidecar from an orphan of a previous
   * activation still holding the port (see ensureRunning) — /api/sidecar-health
   * is auth-exempt, so an orphan answers it happily and then 401s every real
   * request. Any unrouted /api path is enough to settle it: the global auth
   * gate runs before routing, so a wrong/absent token gives 401 and a matching
   * one falls through to a plain 404. Also ~1ms, and it reaches no data source.
   */
  private async isHealthy(): Promise<boolean> {
    if (!(await this.isAlive())) return false;
    try {
      const resp = await fetch(`${this.baseUrl}/api/__sidecar_token_probe`, {
        headers: { [LOCAL_API_TRANSPORT_HEADER]: this.token },
        signal: AbortSignal.timeout(2000),
      });
      return resp.status !== 401;
    } catch {
      return false;
    }
  }

  private async waitUntilHealthy(timeoutMs = 45_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let sawLiveness = false;
    while (Date.now() < deadline) {
      if (await this.isHealthy()) return;
      // Tracked so the failure message can separate "the process never came
      // up" from "something is up on this port but rejects our token", which
      // point at completely different fixes.
      sawLiveness ||= await this.isAlive();
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(
      sawLiveness
        ? `Something is listening on port ${this.port} but rejected this session's token — ` +
          'likely an orphaned sidecar from a previous activation that could not be cleared. ' +
          `Run \`lsof -ti:${this.port} | xargs kill -9\` and reload the window.`
        : 'WorldMonitor sidecar did not become healthy in time — check the "WorldMonitor Sidecar" output channel for errors.',
    );
  }

  dispose(): void {
    this.proc?.kill();
    this.proc = undefined;
  }
}
