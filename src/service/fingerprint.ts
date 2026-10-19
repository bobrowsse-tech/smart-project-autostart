import * as fs from 'fs';
import * as path from 'path';
import ignore from 'ignore';
import { parse as parseYaml } from 'yaml';
import * as toml from 'toml';
import type { HealthCheck, ServiceCandidate } from './types';

const DB_PORTS = new Set([5432, 6379, 27017, 3306, 1433, 9200]);

function readText(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function loadGitignore(root: string) {
  const ig = ignore();
  ig.add(['.git', 'node_modules', 'dist', 'out', '.vscode-test']);
  const gi = readText(path.join(root, '.gitignore'));
  if (gi) {
    ig.add(gi);
  }
  return ig;
}

function walkFiles(root: string, ig: ReturnType<typeof ignore>, maxFiles = 5000): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (!rel || ig.ignores(rel)) {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  }
  return out;
}

function tcpHealth(port: number): HealthCheck {
  return { type: 'tcp', target: `127.0.0.1:${port}` };
}

function httpHealth(port: number): HealthCheck {
  return { type: 'http', target: `http://127.0.0.1:${port}/` };
}

function graceHealth(ms = 3000): HealthCheck {
  return { type: 'grace', target: String(ms) };
}

function parsePortsFromCompose(ports: unknown): number[] {
  if (!Array.isArray(ports)) {
    return [];
  }
  const result: number[] = [];
  for (const p of ports) {
    if (typeof p === 'number') {
      result.push(p);
      continue;
    }
    if (typeof p !== 'string') {
      continue;
    }
    // "8080:80", "127.0.0.1:5432:5432", "3000"
    const parts = p.split(':');
    const hostPart = parts.length === 1 ? parts[0] : parts[parts.length - 2] ?? parts[0];
    const n = Number(hostPart.replace(/\/.*/, ''));
    if (Number.isFinite(n)) {
      result.push(n);
    }
  }
  return result;
}

function fingerprintPackageJson(
  root: string,
  filePath: string,
  candidates: ServiceCandidate[]
): void {
  const raw = readText(filePath);
  if (!raw) {
    return;
  }
  let pkg: {
    name?: string;
    scripts?: Record<string, string>;
    engines?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(raw);
  } catch {
    return;
  }
  const scripts = pkg.scripts ?? {};
  const scriptName = (['dev', 'start', 'serve'] as const).find(
    (name) => typeof scripts[name] === 'string'
  );
  if (!scriptName) {
    return;
  }
  const cwd = path.dirname(filePath);
  const rel = path.relative(root, cwd) || '.';
  const idBase = pkg.name?.replace(/[@/]/g, '-') || path.basename(cwd) || 'node-app';
  const id = `npm:${idBase}`;
  const pm = detectPackageManager(cwd);
  candidates.push({
    id,
    kind: 'npm',
    command: `${pm} run ${scriptName}`,
    cwd: rel,
    ports: [],
    dependsOn: [],
    healthCheck: graceHealth(),
    envHints: pkg.engines,
  });
}

function detectPackageManager(dir: string): 'pnpm' | 'yarn' | 'npm' {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) {
    return 'yarn';
  }
  return 'npm';
}

function fingerprintCompose(
  root: string,
  filePath: string,
  candidates: ServiceCandidate[]
): void {
  const raw = readText(filePath);
  if (!raw) {
    return;
  }
  let doc: {
    services?: Record<
      string,
      {
        depends_on?: string[] | Record<string, unknown>;
        ports?: unknown;
        healthcheck?: { test?: string | string[] };
        image?: string;
        build?: unknown;
      }
    >;
  };
  try {
    doc = parseYaml(raw);
  } catch {
    return;
  }
  const services = doc.services ?? {};
  const composeFile = path.relative(root, filePath) || path.basename(filePath);
  for (const [name, svc] of Object.entries(services)) {
    const ports = parsePortsFromCompose(svc.ports);
    let dependsOn: string[] = [];
    if (Array.isArray(svc.depends_on)) {
      dependsOn = svc.depends_on.map((d) => `compose:${d}`);
    } else if (svc.depends_on && typeof svc.depends_on === 'object') {
      dependsOn = Object.keys(svc.depends_on).map((d) => `compose:${d}`);
    }
    let healthCheck: HealthCheck | undefined;
    if (ports.length) {
      // DB-class ports: tcp only. App ports: http probe for 2xx.
      healthCheck = DB_PORTS.has(ports[0]) ? tcpHealth(ports[0]) : httpHealth(ports[0]);
    } else if (svc.healthcheck) {
      // Compose declares a container healthcheck but no published host port —
      // we cannot probe from the host, so fall back to an explicit grace wait.
      healthCheck = graceHealth(5000);
    } else {
      healthCheck = graceHealth();
    }
    candidates.push({
      id: `compose:${name}`,
      kind: 'compose',
      command: `docker compose -f ${composeFile} up -d ${name}`,
      cwd: '.',
      ports,
      dependsOn,
      healthCheck,
      composeService: name,
    });
  }
}

function fingerprintPython(root: string, files: string[], candidates: ServiceCandidate[]): void {
  const hasPyProject = files.some((f) => path.basename(f) === 'pyproject.toml');
  const hasRequirements = files.some((f) => path.basename(f) === 'requirements.txt');
  const procfile = files.find((f) => path.basename(f) === 'Procfile');
  if (!hasPyProject && !hasRequirements && !procfile) {
    return;
  }

  if (procfile) {
    const raw = readText(procfile);
    if (raw) {
      for (const line of raw.split('\n')) {
        const m = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
        if (!m) {
          continue;
        }
        const [, processName, command] = m;
        candidates.push({
          id: `procfile:${processName}`,
          kind: 'procfile',
          command: command.trim(),
          cwd: path.relative(root, path.dirname(procfile)) || '.',
          ports: [],
          dependsOn: [],
          healthCheck: graceHealth(),
        });
      }
    }
  }

  if (hasPyProject) {
    const pyPath = files.find((f) => path.basename(f) === 'pyproject.toml')!;
    const raw = readText(pyPath);
    let projectName = 'python-app';
    if (raw) {
      try {
        const parsed = toml.parse(raw) as {
          project?: { name?: string; scripts?: Record<string, string> };
          tool?: { poetry?: { name?: string; scripts?: Record<string, string> } };
        };
        projectName =
          parsed.project?.name || parsed.tool?.poetry?.name || path.basename(path.dirname(pyPath));
        const scripts = parsed.project?.scripts || parsed.tool?.poetry?.scripts;
        if (scripts) {
          const first = Object.keys(scripts)[0];
          if (first) {
            candidates.push({
              id: `python:${projectName}`,
              kind: 'python',
              command: `poetry run ${first}`,
              cwd: path.relative(root, path.dirname(pyPath)) || '.',
              ports: [],
              dependsOn: [],
              healthCheck: graceHealth(),
            });
            return;
          }
        }
      } catch {
        // fall through
      }
    }
    if (!candidates.some((c) => c.kind === 'python' || c.kind === 'procfile')) {
      candidates.push({
        id: `python:${projectName}`,
        kind: 'python',
        command: 'python -m uvicorn main:app --reload',
        cwd: path.relative(root, path.dirname(pyPath)) || '.',
        ports: [8000],
        dependsOn: [],
        healthCheck: httpHealth(8000),
      });
    }
  } else if (hasRequirements && !procfile) {
    candidates.push({
      id: 'python:app',
      kind: 'python',
      command: 'python app.py',
      cwd: '.',
      ports: [],
      dependsOn: [],
      healthCheck: graceHealth(),
    });
  }
}

function fingerprintMakefile(root: string, filePath: string, candidates: ServiceCandidate[]): void {
  const raw = readText(filePath);
  if (!raw) {
    return;
  }
  const targets = new Set<string>();
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:/);
    if (m && !line.startsWith('\t')) {
      targets.add(m[1]);
    }
  }
  const preferred = ['run', 'start', 'serve', 'up'].find((t) => targets.has(t));
  if (!preferred) {
    return;
  }
  candidates.push({
    id: `make:${preferred}`,
    kind: 'makefile',
    command: `make ${preferred}`,
    cwd: path.relative(root, path.dirname(filePath)) || '.',
    ports: [],
    dependsOn: [],
    healthCheck: graceHealth(),
  });
}

/**
 * Walk a workspace root and produce normalized service candidates.
 * Pure Node — no vscode imports.
 */
export function fingerprintRepo(root: string, subdir?: string): ServiceCandidate[] {
  const scanRoot = subdir ? path.resolve(root, subdir) : root;
  const ig = loadGitignore(root);
  const files = walkFiles(scanRoot, ig);
  const candidates: ServiceCandidate[] = [];

  for (const file of files) {
    const base = path.basename(file);
    if (base === 'package.json') {
      fingerprintPackageJson(root, file, candidates);
    } else if (base === 'docker-compose.yml' || base === 'docker-compose.yaml' || base === 'compose.yaml' || base === 'compose.yml') {
      fingerprintCompose(root, file, candidates);
    } else if (base === 'Makefile' || base === 'makefile') {
      fingerprintMakefile(root, file, candidates);
    }
  }

  fingerprintPython(root, files, candidates);

  // Deduplicate by id (last wins for overlapping discoveries).
  const byId = new Map<string, ServiceCandidate>();
  for (const c of candidates) {
    byId.set(c.id, c);
  }
  return [...byId.values()];
}
