import * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import type { HealthCheck } from './types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkTcp(target: string, timeoutMs: number): Promise<boolean> {
  const [host, portStr] = target.split(':');
  const port = Number(portStr);
  return new Promise((resolve) => {
    const socket = net.connect({ host, port }, () => {
      socket.end();
      resolve(true);
    });
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(false);
    });
  });
}

function checkHttp(target: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const lib = target.startsWith('https') ? https : http;
    const req = lib.get(target, { timeout: timeoutMs }, (res) => {
      res.resume();
      // DIRECTIVE: HTTP health means a successful response (2xx), not merely "not 5xx".
      const code = res.statusCode ?? 0;
      resolve(code >= 200 && code < 300);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

export async function waitForHealth(
  health: HealthCheck | undefined,
  opts: { timeoutMs?: number; intervalMs?: number; onTick?: (msg: string) => void } = {}
): Promise<{ ok: boolean; detail: string }> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 500;
  const started = Date.now();

  if (!health) {
    opts.onTick?.(
      'No health check declared — waiting fixed grace period (3s). Service may not be ready yet.'
    );
    await sleep(3000);
    return { ok: true, detail: 'grace period (no health check)' };
  }

  if (health.type === 'grace') {
    const ms = Number(health.target) || 3000;
    opts.onTick?.(
      `No tcp/http probe available (compose healthcheck without a published host port, or no port detected) — waiting ${ms}ms grace. Do not treat this as a readiness check.`
    );
    await sleep(ms);
    return { ok: true, detail: `grace ${ms}ms` };
  }

  while (Date.now() - started < timeoutMs) {
    const ok =
      health.type === 'tcp'
        ? await checkTcp(health.target, Math.min(2000, intervalMs * 2))
        : await checkHttp(health.target, Math.min(2000, intervalMs * 2));
    if (ok) {
      return { ok: true, detail: `${health.type} ${health.target}` };
    }
    opts.onTick?.(`Waiting for ${health.type} ${health.target}…`);
    await sleep(intervalMs);
  }

  return {
    ok: false,
    detail: `${health.type} check for ${health.target} timed out after ${timeoutMs}ms`,
  };
}

export async function isPortInUse(port: number, host = '127.0.0.1'): Promise<boolean> {
  return checkTcp(`${host}:${port}`, 500);
}
