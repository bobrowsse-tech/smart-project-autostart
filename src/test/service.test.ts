import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';
import * as http from 'http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprintRepo,
  orderServices,
  buildRunbook,
  mergeRunbook,
  scanAndPersist,
  waitForHealth,
  composeStopCommand,
} from '../service';
import type { Runbook } from '../service';

const fixtures = path.join(__dirname, 'fixtures');

describe('fingerprintRepo', () => {
  it('finds npm start/dev scripts in a Node app', () => {
    const candidates = fingerprintRepo(path.join(fixtures, 'node-app'));
    assert.ok(candidates.some((c) => c.kind === 'npm' && c.command.includes('npm run')));
  });

  it('prefers pnpm when pnpm-lock.yaml is present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autostart-pm-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'pm', scripts: { serve: 'node x.js' } })
      );
      fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      const candidates = fingerprintRepo(dir);
      assert.equal(candidates[0]?.command, 'pnpm run serve');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses compose services, ports, and depends_on', () => {
    const candidates = fingerprintRepo(path.join(fixtures, 'compose-stack'));
    const ids = candidates.map((c) => c.id).sort();
    assert.deepEqual(ids, ['compose:api', 'compose:db', 'compose:web']);
    const api = candidates.find((c) => c.id === 'compose:api')!;
    assert.ok(api.dependsOn.includes('compose:db'));
    assert.ok(api.ports.includes(3000));
    assert.equal(api.healthCheck?.type, 'http');
    const db = candidates.find((c) => c.id === 'compose:db')!;
    assert.equal(db.healthCheck?.type, 'tcp');
  });

  it('parses object-form depends_on', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autostart-dep-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'compose.yml'),
        [
          'services:',
          '  db:',
          '    image: postgres',
          '    ports: ["5432:5432"]',
          '  api:',
          '    image: api',
          '    ports: ["3000:3000"]',
          '    depends_on:',
          '      db:',
          '        condition: service_healthy',
          '',
        ].join('\n')
      );
      const candidates = fingerprintRepo(dir);
      const api = candidates.find((c) => c.id === 'compose:api')!;
      assert.ok(api.dependsOn.includes('compose:db'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses grace when compose has healthcheck but no published ports', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autostart-grace-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'docker-compose.yml'),
        [
          'services:',
          '  worker:',
          '    image: worker',
          '    healthcheck:',
          '      test: ["CMD", "true"]',
          '',
        ].join('\n')
      );
      const candidates = fingerprintRepo(dir);
      assert.equal(candidates[0]?.healthCheck?.type, 'grace');
      assert.equal(candidates[0]?.healthCheck?.target, '5000');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discovers mixed Node + Python + compose stacks', () => {
    const candidates = fingerprintRepo(path.join(fixtures, 'mixed-stack'));
    assert.ok(candidates.some((c) => c.kind === 'compose'));
    assert.ok(candidates.some((c) => c.kind === 'npm' || c.kind === 'procfile'));
    assert.ok(candidates.some((c) => c.kind === 'python' || c.kind === 'procfile'));
  });
});

describe('orderServices', () => {
  it('topologically sorts compose depends_on', () => {
    const candidates = fingerprintRepo(path.join(fixtures, 'compose-stack'));
    const { ordered, warnings } = orderServices(candidates);
    const ids = ordered.map((c) => c.id);
    assert.ok(ids.indexOf('compose:db') < ids.indexOf('compose:api'));
    assert.ok(ids.indexOf('compose:api') < ids.indexOf('compose:web'));
    assert.equal(warnings.filter((w) => w.includes('cycle')).length, 0);
  });

  it('surfaces cycles as warnings instead of throwing', () => {
    const { ordered, warnings } = orderServices([
      {
        id: 'a',
        kind: 'npm',
        command: 'a',
        cwd: '.',
        ports: [],
        dependsOn: ['b'],
      },
      {
        id: 'b',
        kind: 'npm',
        command: 'b',
        cwd: '.',
        ports: [],
        dependsOn: ['a'],
      },
    ]);
    assert.equal(ordered.length, 2);
    assert.ok(warnings.some((w) => w.toLowerCase().includes('cycle')));
  });
});

describe('composeStopCommand', () => {
  it('rewrites up -d into per-service stop', () => {
    assert.equal(
      composeStopCommand('docker compose -f compose.yml up -d api', 'api'),
      'docker compose -f compose.yml stop api'
    );
  });

  it('falls back when the start command is not a compose up', () => {
    assert.equal(composeStopCommand('something else', 'web'), 'docker compose stop web');
  });
});

describe('waitForHealth', () => {
  it('succeeds on tcp when a port accepts connections', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const port = addr.port;
    try {
      const result = await waitForHealth(
        { type: 'tcp', target: `127.0.0.1:${port}` },
        { timeoutMs: 2000, intervalMs: 50 }
      );
      assert.equal(result.ok, true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('times out on tcp when nothing is listening', async () => {
    const result = await waitForHealth(
      { type: 'tcp', target: '127.0.0.1:1' },
      { timeoutMs: 300, intervalMs: 50 }
    );
    assert.equal(result.ok, false);
    assert.ok(result.detail.includes('timed out'));
  });

  it('accepts HTTP 2xx and rejects 404/500', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200);
        res.end('ok');
      } else if (req.url === '/missing') {
        res.writeHead(404);
        res.end('no');
      } else {
        res.writeHead(500);
        res.end('err');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const port = addr.port;
    try {
      const ok = await waitForHealth(
        { type: 'http', target: `http://127.0.0.1:${port}/ok` },
        { timeoutMs: 2000, intervalMs: 50 }
      );
      assert.equal(ok.ok, true);

      const missing = await waitForHealth(
        { type: 'http', target: `http://127.0.0.1:${port}/missing` },
        { timeoutMs: 300, intervalMs: 50 }
      );
      assert.equal(missing.ok, false);

      const boom = await waitForHealth(
        { type: 'http', target: `http://127.0.0.1:${port}/boom` },
        { timeoutMs: 300, intervalMs: 50 }
      );
      assert.equal(boom.ok, false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('honours grace health checks', async () => {
    const started = Date.now();
    const result = await waitForHealth({ type: 'grace', target: '100' });
    assert.equal(result.ok, true);
    assert.ok(Date.now() - started >= 90);
  });
});

describe('runbook persistence', () => {
  it('writes .runbook.json and preserves manual fields on re-scan', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autostart-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'tmp', scripts: { start: 'node x.js' } })
      );
      const first = scanAndPersist(dir, fingerprintRepo(dir));
      assert.ok(fs.existsSync(first.wrotePath));
      assert.equal(first.runbook.services[0].command, 'npm run start');

      const manual: Runbook = {
        ...first.runbook,
        services: first.runbook.services.map((s) => ({
          ...s,
          command: 'node custom.js',
          fieldSources: { ...s.fieldSources, command: 'manual' as const },
        })),
      };
      fs.writeFileSync(first.wrotePath, JSON.stringify(manual, null, 2));

      const second = scanAndPersist(dir, fingerprintRepo(dir));
      assert.equal(second.runbook.services[0].command, 'node custom.js');
      assert.equal(second.overwritten, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buildRunbook sets version and generatedAt', () => {
    const rb = buildRunbook(fingerprintRepo(path.join(fixtures, 'node-app')));
    assert.equal(rb.version, 1);
    assert.ok(rb.generatedAt);
    assert.ok(rb.services.length >= 1);
  });

  it('mergeRunbook keeps manual-only services', () => {
    const inferred = buildRunbook([]);
    const existing: Runbook = {
      version: 1,
      generatedAt: '2020-01-01T00:00:00.000Z',
      warnings: [],
      services: [
        {
          id: 'manual:extra',
          command: 'echo hi',
          cwd: '.',
          dependsOn: [],
          kind: 'npm',
          fieldSources: { command: 'manual' },
        },
      ],
    };
    const merged = mergeRunbook(existing, inferred);
    assert.ok(merged.services.some((s) => s.id === 'manual:extra'));
  });
});
