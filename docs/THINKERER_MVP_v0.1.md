# Thinkerer — MVP Product & Build Specification v0.1

**Status:** Proposed implementation specification  
**Primary objective:** Use Thinkerer to develop Thinkerer itself, without editing source code in Thinkerer's user interface.  
**Release target:** Desktop application, built with web technologies and Electron.  
**Initial project component:** Website Studio (with an Electron desktop runtime target).  
**Operating mode:** Local-first, one user, one active agent run per project.

## 1. Product definition

Thinkerer is a project-first AI creation environment. Each project is a real folder on disk. Users express changes through an agent conversation, inspect results, and approve consequential operations. AI coding agents perform source changes. A project may eventually contain website, mobile, and hardware components; marketing belongs inside each project, not as a separate project type.

The MVP focuses on Website Studio and on a self-development workflow. Thinkerer's own repository must be importable as a project. From the running app, the user can ask an agent to change Thinkerer's code, review the result, test it, and reload/restart the development build.

### Is Thinkerer a “web project”?

The interface is a web application (React/TypeScript/CSS), but the product runs as an Electron desktop application with a local privileged engine. The `website` component represents the web UI and its browser preview. It is *not* permission to treat the entire Electron app as a sandboxed website: CLI execution, filesystem access, Git, and MCP belong in a trusted local service or Electron main-process subsystem. Project metadata should support a runtime target, e.g. `"components":["website"]` and `"target":"electron"`.

## 2. The single required end-to-end user journey

1. Launch Thinkerer as an Electron development build.
2. Import the local Thinkerer repository folder as a project.
3. Select the **Thinkerer** project.
4. Open **Agent** and request: “Add a visible About Thinkerer dialog, and test that it opens.”
5. The orchestrator selects Codex or Claude Code according to the routing policy, or uses the manually selected provider.
6. The selected CLI runs with the project root as its working directory, receives project-scoped MCP tools, and implements the change.
7. Thinkerer streams progress and logs. The user can stop the run.
8. Thinkerer shows changed files and a read-only diff; a Git checkpoint exists for recovery.
9. The Website Studio opens the running UI and verifies the interaction through Playwright automation; show the resulting pass/fail and screenshot.
10. The user confirms the result. UI changes reload in development mode; Electron main-process changes require a deliberate restart.

**MVP is complete only when this journey works against Thinkerer's own source repository.**

## 3. MVP features (required)

### F1 — Desktop shell and project navigation
- Electron desktop shell using React, TypeScript and Vite.
- Project list, project creation, import existing folder, open project, rename/display project metadata.
- Actual filesystem folder is project source of truth.
- Project UI tabs: Overview, Agent, Website, Tasks, Files, MCP, Settings. Marketing may appear as a clearly labeled placeholder inside a project.
- Project settings include `components` (multi-select), `target` (`web` or `electron` initially), development command, and preview URL.
- No editable code editor. File tree, source preview, and diffs are read-only.

### F2 — Local agent supervisor
- Detect locally installed `codex` and `claude` executables; show missing/authentication status clearly.
- Run both through separate adapters using supported noninteractive modes and streaming machine-readable output.
- Standardized run model: queued, running, awaiting approval, succeeded, failed, cancelled.
- Display agent output, current action, elapsed run time, exit status, and recoverable errors.
- Agent is explicitly scoped to a selected project directory and permitted tools.
- The user can cancel a run, and the supervisor cleans up the child process.
- Only one modifying agent run per project at a time in the MVP.
- Authentication is handled by each provider's existing CLI login; never ask users to paste CLI tokens into project files.

### F3 — Provider selection and consumption
- Provider selector: Auto / Codex / Claude.
- In Auto, first check whether each CLI is installed, authenticated/usable, and not cooling down after a limit/error.
- Prefer the provider with lower observed resource consumption *when reliable, comparable signals are available*; otherwise choose a stable configurable preference.
- Show `usage unavailable` rather than guessing percentages or subscription quota remaining.
- Record provider, selection rationale, usage observations (when provided by CLI), and errors for each run.
- If a provider is unavailable before the run, choose the healthy provider. If a run fails after making changes, do not silently replay onto another agent: reconcile the workspace and request confirmation first.
- Optional project-specific provider override.

### F4 — Shared MCP registry
- One global Thinkerer registry defining MCP server endpoints, labels, connection types, and configuration templates.
- Project-specific allowlist of enabled MCP servers/tools.
- Both Codex and Claude adapters receive the **same approved logical tool catalog**, translated into each CLI's supported MCP configuration mechanism.
- Shared registry does not imply shared secrets, unrestricted cross-project access, or a single shared browser session.
- MVP servers: Playwright MCP and one simple demonstration/server-health integration. Other connectors are optional.
- Protect credentials in OS credential storage or protected application settings, never in the project repository or CLI logs.
- Changes to project MCP grants take effect at the next agent run. Display effective tools for the selected provider.
- Prevent conflicting agent writes or browser control through run-level locking.

### F5 — Website Studio
- Start/stop a project-configured local development command with console output and error reporting.
- Embedded local preview using a sandboxed Electron web-content surface; navigation restricted to configured local preview origin by default.
- Playwright-managed browser automation available to the selected agent through approved MCP access.
- Show observed browser actions, test outcome, screenshots, and console errors in the project UI.
- **Important MVP implementation detail:** The embedded preview and Playwright automation browser can be separate browser sessions visiting the same local dev server. Do not claim synchronized cookies or identical session state. A true shared interactive session is post-MVP.
- No uncontrolled browsing of arbitrary sites by default; navigation outside allowed origins needs approval.

### F6 — Tasks, files, and Git safety
- Simple local task board: To do, In progress, Done; create/change status and attach an agent run to a task.
- Read-only file tree, selected source preview, changed-files list, and Git diff.
- Git status shown at the start and end of each modifying run.
- Before modifications, create a recoverable Git checkpoint (commit, branch or ref) without discarding pre-existing user changes. If the worktree is dirty, handle it explicitly rather than silently overwriting it.
- Restore/checkpoint action with explicit confirmation and a preview of what will be replaced.
- Never automatically push, deploy, publish or purchase anything.

### F7 — Self-hosted development workflow
- The Thinkerer app repo can be imported as a project like any other directory.
- Running from development source supports hot reload of renderer changes.
- For Electron main/preload/engine changes, provide a controlled app restart workflow.
- Keep the active application executable and its source repository conceptually separate; never attempt to patch a packaged executable in place.
- Ensure application state and project metadata survive a reload or restart.

## 4. User interface structure

```text
Thinkerer (Electron)
├── Home / Projects
│   ├── Thinkerer        [Website + Electron target]
│   └── Create / Import Project
└── Project: Thinkerer
    ├── Overview         [component cards, status, recent activity]
    ├── Agent            [conversation, Auto/Codex/Claude, run controls]
    ├── Website          [local preview, URL, browser logs, agent tests]
    ├── Tasks            [simple board]
    ├── Files            [read-only tree, source, diffs, Git checkpoints]
    ├── MCP              [global tools, per-project enable/disable]
    ├── Marketing        [project-local placeholder]
    └── Settings         [project folder, runtime, dev command, permissions]
```

## 5. Initial technical architecture

```text
Electron desktop window
  └── React/TypeScript renderer (untrusted UI surface)
      └── Narrow, typed preload/IPC API
          └── Local Thinkerer supervisor (Electron main or dedicated Node process)
              ├── Project service (project folders and metadata)
              ├── Agent router (Auto/Codex/Claude)
              ├── Codex CLI adapter  ───┐
              ├── Claude CLI adapter ──┤ approved MCP registry/configuration
              ├── Task and run store    └── MCP server instances
              ├── Git/checkpoint service
              └── Website service (dev server + Playwright)
```

**Electron security baseline:** Node integration disabled in renderers, context isolation enabled, sandboxed preview content, validated IPC messages, strict external URL handling, and no arbitrary shell-command execution exposed to the UI. Privileged execution must be explicitly mediated by the supervisor.

**Suggested stack:** Electron; React + TypeScript + Vite; Node.js for CLI supervision; JSON project metadata for MVP; SQLite only if run/task indexing becomes difficult; Git via controlled subprocess; Playwright MCP; Electron `WebContentsView` (preferred over deprecated `BrowserView`) for embedded local web content.

## 6. Folder layout

Example project configuration:

```text
~/Projects/thinkerer/               # Real project folder and repository
├── .git/
├── .thinkerer/
│   ├── project.json                # Non-secret project configuration
│   └── tasks.json                  # MVP tasks
├── src/                            # Renderer / application UI
├── electron/                       # Main and preload code
├── engine/                         # Local services / CLI adapters
├── package.json
└── README.md
```

Application-level state, separate from the repo:

```text
<OS application data>/Thinkerer/
├── projects-index.json             # Registered folder paths
├── mcp-registry.json               # Global tool definitions (no secrets)
├── routing.json                    # Provider preferences / cooldowns
├── runs/                           # Run records and redacted logs
└── browser-profiles/               # Isolated test/browser sessions
```

Use the OS keychain for secrets. Exclude sensitive local logs, profile data, and credentials from Git.

Example `.thinkerer/project.json`:

```json
{
  "schemaVersion": 1,
  "name": "Thinkerer",
  "components": ["website"],
  "target": "electron",
  "website": {
    "devCommand": "npm run dev",
    "previewUrl": "http://localhost:5173"
  },
  "agent": {
    "provider": "auto",
    "enabledMcpServers": ["playwright"]
  },
  "marketing": {"enabled": true}
}
```

The dev command above is illustrative; the real scaffold must define the matching scripts and port.

## 7. Agent behavior contract

1. Source code can be modified by CLI agents, not by editable controls in Thinkerer's UI.
2. UI users can send instructions, inspect diffs, stop jobs, approve privileged operations, and restore checkpoints.
3. The agent may read and write only within the selected project scope unless separately approved.
4. The agent may run project build/test commands under the approved execution policy; block unexpected access to unrelated folders and secrets.
5. Present unknown consumption honestly; never invent provider quota percentages.
6. Record the run's provider, start/end state, changes, tests, browser artifacts, and outcome.
7. Handle failed runs safely: retain diagnostic logs, show workspace state and offer retry/rollback.

## 8. Acceptance criteria

- [ ] Desktop app launches with a readable project-first UI.
- [ ] Create/import a real folder; restart Thinkerer; project remains registered.
- [ ] Import Thinkerer's own source directory as an Electron-target Website project.
- [ ] Codex and Claude independently complete a small, non-interactive read/write task in the selected folder (when installed/authenticated).
- [ ] Switching provider does not move or duplicate the project's source directory.
- [ ] Both CLI adapters receive the same project-approved MCP registry entries; per-project disabled entries are absent.
- [ ] Auto mode uses observed signals or a documented preference, never fabricated quota percentages.
- [ ] Project dev server starts; the Website tab shows its running page.
- [ ] Agent runs a Playwright browser interaction, with a visible outcome and screenshot.
- [ ] File tree is read-only; source changes are made by the CLI agent; a Git diff is visible.
- [ ] A safe checkpoint is created, and rollback works after confirmation.
- [ ] Stop/cancel kills the active job and reflects its final state.
- [ ] One Thinkerer-to-Thinkerer feature change passes test and reload/restart verification.

## 9. Out of scope for v0.1

- Full Android/iOS emulators, hardware CAD/PCB/firmware flows.
- Multi-user collaboration, accounts, cloud sync, remote access, or mobile companion.
- Production-grade marketing automation (marketing stays inside the project navigation).
- Multi-agent parallel coding, distributed workers, or autonomous merge approval.
- Exact provider subscription quota tracking without a reliable official signal.
- Billing, plugin marketplace, large-scale analytics, deploying to production.
- Seamlessly sharing one live interactive Chromium session between embedded preview and Playwright; snapshots are sufficient initially.

## 10. Bootstrapping plan

### Phase 0 — External bootstrap (before Thinkerer is usable)
- Scaffold Electron + React + TypeScript + Vite.
- Implement project import and minimal persistence.
- Implement at least one working CLI adapter and agent-run UI.
- Start with Thinkerer's own repository as a project.

**Exit condition:** A user can open Thinkerer and ask an agent to modify its repository from inside the app.

### Phase 1 — Self-development capability
- Add second CLI adapter and automatic routing.
- Add global MCP registry with project-scoped grants.
- Add Website Studio local preview and Playwright tests.
- Add Git changes/checkpoints and read-only file viewer.
- Add task board and persistent run history.

**Exit condition:** The end-to-end self-development journey in section 2 passes.

### Phase 2 — Post-MVP extensions
- Improve consumption/usage accounting based on verified telemetry.
- Expand Website Studio debugging and synced browser-session controls.
- Add mobile and hardware component studios while retaining the project-first structure.
- Add marketing workflows, calendar, richer MCP integrations, and remote monitoring.

## 11. First bootstrap instruction for a CLI coding agent

> Implement `THINKERER_MVP_v0.1.md` incrementally. Begin with Phase 0 only. Use Electron, React, TypeScript and Vite; create a project-first UI backed by real folder import, a read-only file explorer, and a local agent supervisor. First support one provider end-to-end, then add the second provider through a common adapter interface. Do not implement mock CLI execution as though it were functional. Never put filesystem or shell access directly in the renderer. Provide a working dev command, a simple integration test, and document how to import this repository as Thinkerer's first project.

## 12. References verified while drafting

- Electron process model: https://www.electronjs.org/docs/latest/tutorial/process-model
- Electron security: https://www.electronjs.org/docs/latest/tutorial/security
- Electron WebContentsView: https://www.electronjs.org/docs/latest/api/web-contents-view
- Codex non-interactive CLI: https://learn.chatgpt.com/docs/non-interactive-mode
- Claude Code CLI: https://docs.anthropic.com/en/docs/claude-code/cli-usage
- Playwright MCP: https://playwright.dev/docs/getting-started-mcp
