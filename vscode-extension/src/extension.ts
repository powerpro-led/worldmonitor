import * as vscode from 'vscode';
import { SidecarProcess } from './sidecarProcess';
import { DashboardPanel } from './panel';

let sidecar: SidecarProcess | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // Status Bar item, not an Activity Bar icon — clicking an Activity Bar
  // icon always reveals its view container (a sidebar) first, a VS Code
  // platform constraint with no workaround. A status bar item runs its
  // command directly on click, no intermediate panel.
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(pulse) WorldMonitor';
  statusBarItem.tooltip = 'Open the WorldMonitor dashboard (local data only, no live network)';
  statusBarItem.command = 'worldmonitorLocal.openDashboard';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('worldmonitorLocal.openDashboard', async () => {
      const repoRoot = resolveRepoRoot();
      if (!repoRoot) {
        vscode.window.showErrorMessage(
          'WorldMonitor: open the worldmonitor repo as your VS Code workspace, or set worldmonitorLocal.repoRoot.',
        );
        return;
      }
      if (!sidecar) sidecar = new SidecarProcess(repoRoot, context);
      await DashboardPanel.createOrShow(context, sidecar);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('worldmonitorLocal.signInWithGithub', async () => {
      await DashboardPanel.triggerGithubSignIn();
    }),
  );
}

export function deactivate(): void {
  sidecar?.dispose();
  sidecar = undefined;
}

function resolveRepoRoot(): string | undefined {
  const configured = vscode.workspace.getConfiguration('worldmonitorLocal').get<string>('repoRoot');
  if (configured) return configured;
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
