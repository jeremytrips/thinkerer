# Thinkerer

A project-first AI creation environment, as a desktop app (Electron + React + TypeScript + Vite).
Each project is a real folder on disk. You describe changes in the Agent tab. A local coding-agent
CLI makes them. You inspect the result. Thinkerer has no source editor.

This is the **Phase 0** bootstrap, plus the second provider from Phase 1, of [`docs/THINKERER_MVP_v0.1.md`](docs/THINKERER_MVP_v0.1.md).
Thinkerer can open its own repository and have an agent modify it from inside the app.

## Requirements

- Node.js 20+ (developed on Node 26) and npm
- Git
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) on your `PATH`, logged in (run `claude` once in a terminal).
  Thinkerer never asks for or stores CLI tokens; it uses the CLI's own login.
- Optional: the [Codex CLI](https://github.com/openai/codex), logged in with `codex login`. Auto mode
  uses it when Claude Code is unavailable or cooling down after a rate limit.

## Run it

```sh
npm install
npm run dev
```

`npm run dev` starts the app from source:

- **Renderer (`src/`) changes hot-reload** in the running window.
- **Main/preload/engine changes (`electron/`, `engine/`, `shared/`) do not auto-restart.** An agent
  editing them can't kill its own supervisor mid-run. Click **Restart app** (sidebar or top bar) when
  you want them loaded. The dev launcher (`scripts/dev.mjs`) rebuilds and relaunches. Restart is
  refused while an agent run is active.

App state (project registry, run history) lives outside the repo, in the OS app-data folder
(`~/Library/Application Support/Thinkerer` on macOS). It survives reloads and restarts. Set
`THINKERER_APP_DATA=/some/dir` to use a different folder.

## Import this repository as Thinkerer's first project

1. `npm run dev`
2. On **Projects**, click **Import folder…** and choose this repository's folder.
   Thinkerer reads the committed `.thinkerer/project.json` (name, `components: ["website"]`,
   `target: "electron"`, dev command, preview URL). It writes that file only if it's missing.
3. Open the project. The Overview shows a banner confirming it is the source of the running app.
4. Go to **Agent**, leave the provider on **Auto** (or pick Claude Code or Codex), and enter something like:
   > Add a visible About Thinkerer dialog, and test that it opens.
5. Watch progress stream in. **Stop run** cancels and kills the agent's whole process tree.
6. When the run finishes, the run summary shows the agent's summary, any commands denied by policy,
   and the files whose Git status changed. Renderer edits already show in the window. If main or
   engine code changed, a **Restart now** button appears.
7. **Files** shows the read-only tree, a file preview, and uncommitted changes.

## What the agent is allowed to do

Each run starts one provider CLI non-interactively, with the project folder as its working directory.
The prompt goes in on stdin. Both providers get the same instructions: stay in the project; never
push, deploy, publish or purchase. The two CLIs enforce limits differently, and the app shows each
policy under **Providers → What runs may do**.

| | Claude Code (`claude -p --restricted …`) | Codex (`codex exec --sandbox workspace-write …`) |
|---|---|---|
| File writes | project folder only | project folder + temp dirs (OS sandbox) |
| File reads | project folder only | **not confined** by the sandbox |
| Shell | only `npm run *`, `npm test*`, `npx tsc/vitest/playwright test`, `git status/diff/log`; anything else denied | any command, inside the sandbox |
| Network from shell | denied unless an allowed command does it | off |
| Approvals | none in Phase 0; prompts are auto-denied | `approval_policy="never"`; no escalation |
| MCP / extras | none (`--strict-mcp-config`, empty) | none: `--ignore-user-config`, `--ignore-rules`; connectors, plugins, browser/computer use, image generation, hooks and web search disabled |
| User config | Claude settings files not loaded | `~/.codex/config.toml` and rules not loaded (login still used) |

The Codex read gap is real. A Codex run can read files outside the project, such as other repos or
dotfiles, and their contents go to the model. Shell network access is off, but prefer Claude for
sensitive machines until Phase 1 adds read confinement (Codex permission profiles). npm scripts run
with your user permissions under either provider. Only use agents on projects whose scripts you trust.

Usage is shown only when the CLI reports it: token counts from both, and Claude's rate-limit window
utilisation. Otherwise the UI says **usage unavailable**. A Codex `turn.failed` that mentions a
rate/usage limit, or a Claude `rate_limit_event` with status `rejected`, puts that provider on
cooldown for Auto.

Auto picks the first usable provider in the order `claude > codex`, because neither CLI gives a
comparable consumption signal. The rationale is recorded with each run. A manually chosen provider
that's unavailable is refused, never silently swapped.

The shared policy is `DEFAULT_POLICY` in `engine/agents/supervisor.ts`; provider-specific flags live
in `engine/agents/claude.ts` and `engine/agents/codex.ts`.

## Tests

```sh
npm run typecheck
npm test            # engine integration tests: projects, read-only files, git, stream parsing, supervisor lifecycle/cancel
npm run test:e2e    # builds, launches the real Electron app, imports this repo, checks Files/Agent, restarts
npm run test:live:claude   # opt-in: REAL claude CLI on a throwaway folder (uses your quota)
npm run test:live:codex    # opt-in: REAL codex CLI (needs `codex login`)
```

The supervisor tests use a stand-in process that speaks Claude's stream-json format
(`tests/fixtures/stand-in-agent.mjs`) to test cancellation and process-tree cleanup deterministically.
The live tests check the real adapters. Neither is wired into the app as a fake provider.
The Codex parser tests use event lines in the `codex exec --json` format (codex-cli 0.169).

## Architecture

```text
src/                 React renderer (untrusted UI): no Node, no fs, no shell
electron/preload/    Narrow typed bridge → window.thinkerer (shared/api.ts)
electron/main/       Window + security policy, validated IPC handlers, restart
engine/              Privileged services, Electron-free (unit-testable)
  projects.ts          project registry + .thinkerer/project.json
  files.ts, paths.ts   read-only listing/preview with path + symlink escape checks
  git.ts               git status
  agents/
    types.ts           AgentAdapter interface (one per provider CLI)
    claude.ts          Claude Code adapter (args, detection, stream-json parser)
    codex.ts           Codex adapter (args, detection, exec --json parser)
    supervisor.ts      run lifecycle, provider selection, one-run-per-project lock, cancel, run records
shared/              Types shared by engine and renderer
scripts/dev.mjs      dev launcher with restart loop
```

Electron baseline: `contextIsolation`, `sandbox`, no `nodeIntegration`, CSP, no new windows, and
navigation locked to the app origin. All permission requests are denied, and every IPC call checks
its sender and arguments.

## Status against the spec

Done in Phase 0:

- F1: desktop shell, project list, create/import, metadata, tabs, read-only file tree and preview.
- F2: Claude and Codex adapters behind one interface, CLI detection and login status, standard run states, streaming output, current action, elapsed time, cancel with process-tree cleanup, one modifying run per project, persisted run records.
- F3: Auto/Claude/Codex selector with a recorded rationale and health checks (installed, logged in, cooldown), a manual choice never silently switched, rate-limit cooldown driven by CLI signals, CLI-reported usage only.
- F6 (partial): Git status before and after each run, changed files.
- F7: this repo importable, renderer hot reload, controlled restart for main-process changes.

Not yet built (Phase 1):

- MCP registry and per-project grants
- Website Studio (dev server, preview, Playwright)
- Git checkpoints, restore, and diff view
- Task board
- Interactive approvals (`awaiting-approval`)
