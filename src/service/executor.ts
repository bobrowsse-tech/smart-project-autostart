import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import type { Runbook, RunbookService, StartResult, StopResult, TrackedProcess } from './types';
import { isPortInUse, waitForHealth } from './health';

export type LogFn = (serviceId: string, line: string) => void;
export type StatusFn = (serviceId: string, status: string, detail?: string) => void;

export interface ExecutorState {
  processes: TrackedProcess[];
}

/** Live children for the current Extension Host session (not persisted across restarts). */
const liveChildren = new Map<string, ChildProcess>();

/**
 * Kill a shell-spawned service by process group (POSIX) or taskkill tree (Windows).
 *
 * `shell: true` means the tracked PID is often the shell, not `node server.js`.
 * Without a group/tree kill, stop flips status to stopped while the real
 * server keeps the port. Detached spawn on POSIX makes the child its own
 * process-group leader so `-pid` signals the whole tree.
 */
export async function killProcessGroup(
  pid: number,
  log: LogFn,
  serviceId: string,
  child?: ChildProcess
): Promise<void> {
  if (process.platform === 'win32') {
    log(serviceId, `taskkill /t tree for pid ${pid}`);
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
      });
      killer.on('exit', () => resolve());
      killer.on('error', () => resolve());
    });
    return;
  }

  log(serviceId, `SIGTERM process group -${pid}`);
  trySignalGroup(pid, 'SIGTERM');

  const exited = await waitForPidExit(pid, child, 5000);
  if (!exited) {
    log(serviceId, `Grace period elapsed — SIGKILL process group -${pid}`);
    trySignalGroup(pid, 'SIGKILL');
    await waitForPidExit(pid, child, 2000);
  }
}

function trySignalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH / already gone
  }
}

function waitForPidExit(pid: number, child: ChildProcess | undefined, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (child) {
        child.removeListener('exit', onExit);
      }
      resolve(ok);
    };

    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), ms);
    const poll = setInterval(() => {
      try {
        process.kill(pid, 0);
      } catch {
        finish(true);
      }
    }, 100);

    if (child && child.exitCode === null) {
      child.once('exit', onExit);
    } else if (child && child.exitCode !== null) {
      finish(true);
    }
  });
}

/**
 * Turn a compose `up -d` start command into a per-service `stop`.
 * Avoids `docker compose down`, which tears down the whole stack on the first service.
 */
export function composeStopCommand(startCommand: string, composeService: string): string {
  const match = startCommand.match(/^(docker\s+compose\b.*?)\s+up\s+-d\s+(\S+)/i);
  if (match) {
    return `${match[1]} stop ${match[2]}`;
  }
  return `docker compose stop ${composeService}`;
}

function spawnService(
  root: string,
  svc: RunbookService,
  log: LogFn
): { child: ChildProcess; tracked: TrackedProcess } {
  const cwd = path.resolve(root, svc.cwd || '.');
  const child = spawn(svc.command, {
    cwd,
    shell: true,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX: process-group leader so stop can signal -pid. No effect on Windows.
    detached: process.platform !== 'win32',
  });

  const onData = (buf: Buffer) => {
    const text = buf.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.length) {
        log(svc.id, line);
      }
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  child.on('exit', () => {
    liveChildren.delete(svc.id);
  });

  liveChildren.set(svc.id, child);

  return {
    child,
    tracked: {
      serviceId: svc.id,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      composeProject: svc.kind === 'compose' ? svc.composeService : undefined,
    },
  };
}

/**
 * Start services in runbook order with health-check gating.
 * Pure Node — logging/status via callbacks; PID list returned for persistence.
 */
export async function startRunbook(
  root: string,
  runbook: Runbook,
  previous: TrackedProcess[],
  log: LogFn,
  onStatus: StatusFn
): Promise<{ result: StartResult; processes: TrackedProcess[] }> {
  const processes = [...previous];
  const started: string[] = [];

  for (const svc of runbook.services) {
    onStatus(svc.id, 'starting');

    for (const port of extractPorts(svc)) {
      if (await isPortInUse(port)) {
        const reason = `Port ${port} is already in use before starting ${svc.id}. Stop the stale process or edit the runbook.`;
        onStatus(svc.id, 'failed', reason);
        log(svc.id, reason);
        return {
          result: { started, failed: { serviceId: svc.id, reason } },
          processes,
        };
      }
    }

    log(svc.id, `$ ${svc.command}`);
    const { tracked } = spawnService(root, svc, log);
    processes.push(tracked);

    const health = await waitForHealth(svc.healthCheck, {
      onTick: (msg) => log(svc.id, msg),
    });
    if (!health.ok) {
      const reason = `Service "${svc.id}" did not become healthy: ${health.detail}`;
      onStatus(svc.id, 'failed', reason);
      log(svc.id, reason);
      if (tracked.pid) {
        await killProcessGroup(tracked.pid, log, svc.id, liveChildren.get(svc.id));
      }
      liveChildren.delete(svc.id);
      return {
        result: { started, failed: { serviceId: svc.id, reason } },
        processes: processes.filter((p) => p.serviceId !== svc.id),
      };
    }

    onStatus(svc.id, 'healthy', health.detail);
    log(svc.id, `Healthy (${health.detail})`);
    started.push(svc.id);
  }

  return { result: { started }, processes };
}

function extractPorts(svc: RunbookService): number[] {
  const hc = svc.healthCheck;
  if (!hc) {
    return [];
  }
  if (hc.type === 'tcp') {
    const port = Number(hc.target.split(':').pop());
    return Number.isFinite(port) ? [port] : [];
  }
  if (hc.type === 'http') {
    try {
      const u = new URL(hc.target);
      const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
      return Number.isFinite(port) ? [port] : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Stop tracked processes in reverse start order.
 * Compose services are stopped individually (`stop <name>`), not `down`.
 */
export async function stopRunbook(
  root: string,
  runbook: Runbook | undefined,
  processes: TrackedProcess[],
  log: LogFn,
  onStatus: StatusFn
): Promise<{ result: StopResult; processes: TrackedProcess[] }> {
  const order = runbook
    ? [...runbook.services].map((s) => s.id).reverse()
    : [...new Set(processes.map((p) => p.serviceId))].reverse();

  const byId = new Map(runbook?.services.map((s) => [s.id, s]) ?? []);
  const stopped: string[] = [];
  const remaining = [...processes];

  for (const id of order) {
    const tracked = remaining.filter((p) => p.serviceId === id);
    if (!tracked.length) {
      continue;
    }
    onStatus(id, 'stopping');
    const svc = byId.get(id);

    for (const t of tracked) {
      const composeName = t.composeProject || svc?.composeService;
      if (composeName) {
        const cmd = composeStopCommand(svc?.command ?? '', composeName);
        log(id, `$ ${cmd}`);
        await new Promise<void>((resolve) => {
          const child = spawn(cmd, {
            cwd: root,
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          child.on('close', () => resolve());
          child.on('error', () => resolve());
        });
      } else if (t.pid) {
        await killProcessGroup(t.pid, log, id, liveChildren.get(id));
      }
    }

    liveChildren.delete(id);
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (remaining[i].serviceId === id) {
        remaining.splice(i, 1);
      }
    }
    onStatus(id, 'stopped');
    stopped.push(id);
  }

  return { result: { stopped }, processes: remaining };
}

/** Test helper: clear in-memory child handles. */
export function clearLiveChildren(): void {
  liveChildren.clear();
}
