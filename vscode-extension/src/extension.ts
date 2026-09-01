import * as vscode from 'vscode';
import { BackendClient } from './backendClient';
import { DashboardPanel } from './panel';

let backend: BackendClient | undefined;

function getBackend(context: vscode.ExtensionContext): BackendClient {
  if (!backend) backend = new BackendClient(context);
  return backend;
}

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
      // No repo root needed anymore: the backend is a standalone launchd
      // service (`worldmonitor-local install`), and this extension is a pure
      // client that only talks to 127.0.0.1:46123.
      await DashboardPanel.createOrShow(context, getBackend(context));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('worldmonitorLocal.startBackend', async () => {
      try {
        await getBackend(context).startBackend();
        void vscode.window.showInformationMessage('WorldMonitor: backend restart requested via launchd.');
      } catch {
        void vscode.window.showErrorMessage(
          'WorldMonitor: could not start the backend. Run `worldmonitor-local install` in the repo first.',
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('worldmonitorLocal.signInWithGithub', async () => {
      await DashboardPanel.triggerGithubSignIn();
    }),
  );
}

export function deactivate(): void {
  // Nothing to tear down: the backend is owned by launchd and outlives this
  // extension by design. The output channel is already registered in
  // context.subscriptions, so VS Code disposes it for us.
  backend = undefined;
}
