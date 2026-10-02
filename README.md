# Smart Project Autostart

Infers how to start and stop an unfamiliar repo and runs it with one click — npm scripts, Docker Compose, Procfile, Python, and Makefile targets.

## Install

```bash
git clone https://github.com/bobrowsse-tech/smart-project-autostart.git
cd smart-project-autostart
npm install
npm run package
npx @vscode/vsce package --no-dependencies
code --install-extension smart-project-autostart-0.1.2.vsix
```

Or press **F5** in VS Code / Cursor after `npm install` to launch an Extension Development Host.

## Use

Open a workspace, then open the **Smart Project Autostart** activity-bar panel:

| Action | What it does |
|---|---|
| **Scan & Generate Plan** | Fingerprints the repo and writes a dependency-ordered `.runbook.json` |
| **Start Project** | Runs each step in order, waiting for health checks |
| **Stop Project** | Tears down tracked processes in reverse order |
| **View Logs** / **Edit Runbook** | Inspect logs or correct a command/health check by hand |

Agents (Copilot Chat, Claude Code, etc.) can call the Language Model Tool `project_autostart_run` with `scan`, `start`, `stop`, or `status`.

## How it’s built

- **TypeScript** (strict) + **esbuild** CJS bundle (`dist/extension.js`)
- VS Code Extension API `^1.95.0` — side-panel `WebviewView`, commands, Language Model Tool
- Core logic lives in `src/service/` with **no** `vscode` imports (shared by UI + LM tool)

```bash
npm run watch      # esbuild + tsc
npm run test:unit  # Node test runner via tsx
npm run package    # production bundle
```

## Author

[Bob Rowsse Walakira](https://bobrowsse.com) — [hello@bobrowsse.com](mailto:hello@bobrowsse.com)

## License

MIT

## Contributing

Changes to `main` must go through a pull request. See [CONTRIBUTING.md](./CONTRIBUTING.md).

### Extension Development Host

With the local suite umbrella checked out, press **F5** (**Extension + playground**) to load `../playgrounds/smart-project-autostart/` as the test workspace.
