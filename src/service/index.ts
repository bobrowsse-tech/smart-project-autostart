export type {
  HealthCheck,
  Runbook,
  RunbookService,
  ScanResult,
  ServiceCandidate,
  ServiceRuntimeStatus,
  StartResult,
  StatusSnapshot,
  StopResult,
  TrackedProcess,
} from './types';

export { fingerprintRepo } from './fingerprint';
export { orderServices } from './order';
export {
  RUNBOOK_FILENAME,
  buildRunbook,
  mergeRunbook,
  readRunbook,
  runbookPath,
  scanAndPersist,
  writeRunbook,
} from './runbook';
export {
  clearLiveChildren,
  composeStopCommand,
  killProcessGroup,
  startRunbook,
  stopRunbook,
} from './executor';
export { isPortInUse, waitForHealth } from './health';

import { fingerprintRepo } from './fingerprint';
import { scanAndPersist, readRunbook } from './runbook';
import { startRunbook, stopRunbook } from './executor';
import type {
  ScanResult,
  StartResult,
  StopResult,
  StatusSnapshot,
  TrackedProcess,
  ServiceRuntimeStatus,
} from './types';
import type { LogFn, StatusFn } from './executor';

/**
 * High-level facade used by commands and the Language Model Tool.
 * Keeps all business logic in one place (no vscode imports).
 */
export class AutostartService {
  constructor(
    private readonly root: string,
    private getTracked: () => TrackedProcess[],
    private setTracked: (procs: TrackedProcess[]) => void
  ) {}

  scan(subdir?: string): ScanResult {
    const candidates = fingerprintRepo(this.root, subdir);
    const { runbook, wrotePath, overwritten } = scanAndPersist(this.root, candidates);
    return { runbook, candidates, wrotePath, overwritten };
  }

  async start(log: LogFn, onStatus: StatusFn): Promise<StartResult> {
    // One-click start: infer and save a runbook when none exists yet.
    let runbook = readRunbook(this.root);
    if (!runbook || runbook.services.length === 0) {
      this.scan();
      runbook = readRunbook(this.root);
    }
    if (!runbook || runbook.services.length === 0) {
      return {
        started: [],
        failed: {
          serviceId: '(none)',
          reason:
            'Could not detect how to run this project. Looked for Docker Compose, a package.json dev/start/serve script, a Procfile, Python, and a Makefile.',
        },
      };
    }
    const { result, processes } = await startRunbook(
      this.root,
      runbook,
      this.getTracked(),
      log,
      onStatus
    );
    this.setTracked(processes);
    return result;
  }

  async stop(log: LogFn, onStatus: StatusFn): Promise<StopResult> {
    const runbook = readRunbook(this.root);
    const { result, processes } = await stopRunbook(
      this.root,
      runbook,
      this.getTracked(),
      log,
      onStatus
    );
    this.setTracked(processes);
    return result;
  }

  status(): StatusSnapshot {
    const runbook = readRunbook(this.root);
    const tracked = this.getTracked();
    const services =
      runbook?.services.map((s) => {
        const t = tracked.find((p) => p.serviceId === s.id);
        const status: ServiceRuntimeStatus = t ? 'healthy' : 'idle';
        return { id: s.id, status, pid: t?.pid };
      }) ?? [];
    return {
      services,
      lastScanAt: runbook?.generatedAt,
    };
  }

  formatScanReport(result: ScanResult): string {
    const lines = [
      `Scan ${result.overwritten ? 'updated' : 'wrote'} ${result.wrotePath}`,
      `Services (${result.runbook.services.length}):`,
      ...result.runbook.services.map(
        (s, i) =>
          `  ${i + 1}. ${s.id} — ${s.command}` +
          (s.healthCheck ? ` [${s.healthCheck.type}:${s.healthCheck.target}]` : '')
      ),
    ];
    if (result.runbook.warnings.length) {
      lines.push('Warnings:', ...result.runbook.warnings.map((w) => `  - ${w}`));
    }
    return lines.join('\n');
  }

  formatStatusReport(snap: StatusSnapshot): string {
    if (!snap.services.length) {
      return 'No runbook loaded. Run a scan first.';
    }
    const lines = snap.services.map(
      (s) => `- ${s.id}: ${s.status}${s.pid ? ` (pid ${s.pid})` : ''}`
    );
    if (snap.lastScanAt) {
      lines.unshift(`Last scan: ${snap.lastScanAt}`);
    }
    return lines.join('\n');
  }
}
