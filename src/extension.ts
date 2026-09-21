import * as vscode from 'vscode';
import { DashboardProvider } from './dashboardProvider';
import { registerProjectAutostartRunTool } from './lmTool';
import { AutostartService, RUNBOOK_FILENAME, type TrackedProcess } from './service';

const TRACKED_KEY = 'projectAutostart.trackedProcesses';

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function createService(context: vscode.ExtensionContext): AutostartService | undefined {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('Smart Project Autostart needs an open workspace folder.');
    return undefined;
  }
  return new AutostartService(
    root,
    () => context.workspaceState.get<TrackedProcess[]>(TRACKED_KEY, []),
    (procs) => {
      void context.workspaceState.update(TRACKED_KEY, procs);
    }
  );
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Smart Project Autostart');
  context.subscriptions.push(output);

  const dashboard = new DashboardProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('smart-project-autostartView', dashboard)
  );

  const log = (serviceId: string, line: string) => {
    output.appendLine(`[${serviceId}] ${line}`);
    dashboard.appendLog(serviceId, line);
  };

  const onStatus = (serviceId: string, status: string, detail?: string) => {
    dashboard.setServiceStatus(serviceId, status, detail);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('projectAutostart.scan', async () => {
      const service = createService(context);
      if (!service) {
        return;
      }
      dashboard.setSummary('Scanning workspace…');
      try {
        const result = service.scan();
        dashboard.showScanResult(result);
        dashboard.setSummary(service.formatScanReport(result).split('\n')[0]);
        vscode.window.showInformationMessage(
          `Smart Project Autostart: ${result.runbook.services.length} service(s) planned.`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dashboard.setSummary(`Scan failed: ${msg}`);
        vscode.window.showErrorMessage(`Smart Project Autostart scan failed: ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('projectAutostart.start', async () => {
      const service = createService(context);
      if (!service) {
        return;
      }
      output.show(true);
      dashboard.setSummary('Starting project…');
      try {
        const result = await service.start(log, onStatus);
        if (result.failed) {
          dashboard.setSummary(`Failed at ${result.failed.serviceId}: ${result.failed.reason}`);
          vscode.window.showErrorMessage(result.failed.reason);
        } else {
          dashboard.setSummary(`Started ${result.started.length} service(s).`);
          vscode.window.showInformationMessage(
            `Smart Project Autostart: started ${result.started.join(', ') || 'nothing'}.`
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dashboard.setSummary(`Start failed: ${msg}`);
        vscode.window.showErrorMessage(`Smart Project Autostart start failed: ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('projectAutostart.stop', async () => {
      const service = createService(context);
      if (!service) {
        return;
      }
      output.show(true);
      dashboard.setSummary('Stopping project…');
      try {
        const result = await service.stop(log, onStatus);
        dashboard.setSummary(`Stopped ${result.stopped.length} service(s).`);
        vscode.window.showInformationMessage(
          `Smart Project Autostart: stopped ${result.stopped.join(', ') || 'nothing'}.`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dashboard.setSummary(`Stop failed: ${msg}`);
        vscode.window.showErrorMessage(`Smart Project Autostart stop failed: ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('projectAutostart.viewLogs', () => {
      output.show(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('projectAutostart.editRunbook', async () => {
      const root = workspaceRoot();
      if (!root) {
        vscode.window.showErrorMessage('Smart Project Autostart needs an open workspace folder.');
        return;
      }
      const uri = vscode.Uri.file(`${root}/${RUNBOOK_FILENAME}`);
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        vscode.window.showWarningMessage(
          'No .runbook.json yet — run Scan & Generate Plan first.'
        );
        return;
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
    })
  );

  registerProjectAutostartRunTool(context, () => createService(context), log, onStatus, dashboard);
}

export function deactivate() {}
