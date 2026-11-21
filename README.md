# Thinkerer

A project-first AI creation environment, as a desktop app (Electron + React + TypeScript + Vite).
Each project is a real folder on disk. You describe changes in the Agent tab, and a local
coding-agent CLI (Claude Code or Codex) makes them. You review the diff, test in the browser, and
roll back if needed. Thinkerer has no source editor.

This implements the MVP in [`docs/THINKERER_MVP_v0.1.md`](docs/THINKERER_MVP_v0.1.md) (Phases 0 and 1, now historical).
Where it is going: [`docs/PRODUCT.md`](docs/PRODUCT.md) and [`docs/ROADMAP.md`](docs/ROADMAP.md). Agents follow
[`AGENTS.md`](AGENTS.md) and the playbooks in `.thinkerer/skills/`; UI follows [`docs/DESIGN.md`](docs/DESIGN.md).
Thinkerer opens its own repository as a project and develops itself from inside the app.

## Requirements

- Node.js 20+ (developed on Node 26), npm, and Git
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) on your `PATH`, logged in (run `claude` once in a terminal).
  Thinkerer never asks for or stores CLI tokens; it uses each CLI's own login.
- Optional: the [Codex CLI](https://github.com/openai/codex), logged in with `codex login`. Auto mode
  uses it when Claude Code is unavailable or cooling down after a rate limit.
- For the agent's browser checks: `npm run setup:browsers` (one-time Chromium download for Playwright MCP, ~100 MB).

## Run it

```sh
npm install
npm run setup:browsers   # once
npm run dev
```

`npm run dev` starts the app from source:

- **Renderer (`src/`) changes hot-reload** in the running window.
- **Main/preload/engine changes (`electron/`, `engine/`, `shared/`, `mcp/`) do not auto-restart.** An
  agent editing them can't kill its own supervisor mid-run. Click **Restart app** when you want them
  loaded. The dev launcher (`scripts/dev.mjs`) rebuilds and relaunches. Restart is refused while an
  agent run is active.

App state (project registry, MCP registry, encrypted secrets, approved dev commands, run history and
screenshots) lives outside the repo, in the OS app-data folder (`~/Library/Application
Support/Thinkerer` on macOS). Set `THINKERER_APP_DATA=/some/dir` to use a different folder.

## The self-development journey

1. `npm run dev`
2. **Projects → Import folder…**, then choose this repository. The committed `.thinkerer/project.json`
   says this is a `website` component with an `electron` target. Its dev command is `npm run dev:web`,
   a renderer-only Vite server on http://localhost:5174. Playwright and health MCP servers are enabled.
3. **Website → Start dev server.** The first time, a native dialog asks you to approve the command. The
   preview then shows Thinkerer's UI in "browser preview" mode, without desktop features.
4. **Agent**: type “Add a visible About Thinkerer dialog, and test that it opens.” and press Enter
   (Shift+Enter adds a line).
   - The chat gets its **own Git worktree and branch** (`thinkerer/<title>-<id>`), created from the
     project's current branch under Thinkerer's app data, so parallel chats never touch each other's files
     (uncommitted work in the project folder stays there). The project's **setup hook** runs in it first,
     with its own ports (see Worktrees below).
   - A **Git checkpoint** is saved before every message. When a message's turn ends, Thinkerer
     **commits its changes on the chat branch** (the agent never commits or pushes).
   - The CLI streams its progress into the chat. **Stop** kills its whole process tree.
   - **Reply in the same chat** to keep going. A follow-up resumes the CLI's own session
     (`claude --resume`, `codex exec resume`), so the agent remembers the conversation; the provider
     and task stay the chat's. Every message gets its own checkpoint, so each can be rolled back.
     A message sent while the agent is working is queued and goes out when it finishes.
   - Open chats are listed on the left; **+ New chat** starts another, and up to 4 can work at once.
     When you're happy, type **`/merge`** to merge the branch into its base branch in the project folder
     (locally; nothing is pushed), then **`/cleanup`**: it checks nothing is left (no running turn, nothing
     uncommitted, everything merged, no other unmerged branches or stashes from the chat), runs the
     teardown hook and removes the worktree and branch. The chat moves to **Done**. A branch merged
     outside Thinkerer is noticed too ("Merged · /cleanup"). **`/done`** files a chat away and keeps its
     worktree; **`/discard`** deletes the worktree and branch, merged or not, after a confirmation.
     Type `/` in the composer to see them.
   - The agent can drive a headless Chromium (Playwright MCP) against the preview. Its actions and
     screenshots appear in the run, and under **Website → Agent browser checks**.
5. Review **N files changed** under each reply (per-file diffs). The running app hot-reloads from the
   project folder, so a chat's renderer changes show up there after `/merge` (or in the chat's own preview
   before that, see below). If main, preload or engine code changed, use **Restart now**.
6. Not happy? **Restore checkpoint…** shows exactly which files will be reverted, deleted or recreated,
   and asks for confirmation. Your current state is checkpointed first, so a restore can be undone too.

Verified on 2026-11-17. Thinkerer ran this exact journey on its own repo, with Auto selecting Claude
Code. The agent added the dialog and an e2e test, and checked it in the Playwright browser on :5174
(PASSED, with a screenshot). The change hot-reloaded into the running window, where the dialog opened.
The result is commit `8438cfd`; typecheck, unit and e2e tests passed when re-run independently.

## What's in the app

| Tab | What it does |
|---|---|
| Overview | Component cards, Git state, providers, recent runs |
| Agent | Chats in their own worktrees, with follow-ups (each message checkpointed and committed on the chat branch), `/merge` `/cleanup` `/done` `/discard`, Auto / Claude / Codex, task link, the project's MCP tools, live progress, changes with diffs, restore, retry, screenshots, a preview of the chat's own dev server |
| Website | Approved dev command runner with logs. Sandboxed embedded preview (Electron `WebContentsView`), locked to the preview origin, with other origins only after approval. Preview console. The agent's browser checks |
| Tasks | To do / In progress / Done board in `.thinkerer/tasks.json`; runs attach to tasks |
| Files | Read-only tree and preview, uncommitted changes with diffs, checkpoints with restore |
| MCP | Global server registry (built-in + your own stdio, streamable HTTP and SSE servers, Keychain-encrypted secrets), per-project enable, the tools each provider will actually get, **Check** (connect and list a server's tools), **Import from Claude Code** (`.mcp.json`, `~/.claude.json`) |
| Settings | Name, components, target, dev command, preview URL, chat worktree hooks and ports, default provider, Claude Code model / effort / optional tools, LLM providers, agent permissions |
| Marketing | Placeholder (post-MVP) |

### Claude Code features

- **Slash commands and skills.** Type `/` in the composer: Thinkerer's own commands (`/merge`, `/cleanup`, `/done`,
  `/discard`) come first, then the commands and skills Claude Code reported for this chat (`/compact`, `/context`,
  `/init`, `/code-review`, `/security-review`, your skills…). Those are sent to the agent as the message. Commands that only
  work in Claude's interactive terminal, or that Thinkerer handles itself (`/model`, `/effort`, `/mcp`, `/clear`), are left out.
- **Plan mode.** The composer's **Mode** select runs one message read-only (`--permission-mode plan` for Claude, a
  read-only sandbox for Codex). The agent replies with a plan; your next message (back in **Make changes**) carries it out.
- **Model, effort, optional tools.** Settings → **Claude Code**: a model alias or name (`--model`), an effort level
  (`--effort`), and opt-in built-in tools: subagents (`Task`) and skills (`Skill`), on by default; web search and
  Jupyter notebooks, off by default. Stored in `.thinkerer/project.json` under `agent.claude`.
- **Session details.** Each turn's **Details** show what Claude reported when its session started: model, tools, each
  MCP server's connection status, subagents, skills and commands. An MCP server that failed to connect is also noted in
  the conversation.
- **MCP.** Remote servers (streamable HTTP, or SSE for Claude only) with headers that reference secrets as `${NAME}`.
  Codex gets the same server when it can express the header (a whole value, or `Authorization: Bearer ${NAME}`); otherwise
  the MCP tab says why it's left out. **Check** runs the MCP handshake and lists tools without calling any. **Import from
  Claude Code** reads (never writes) `.mcp.json` and `~/.claude.json`. Secret-looking values go to encrypted storage and
  never reach the UI, and `${VAR}` references become secrets to set. Servers that rely on `claude mcp login` OAuth may not
  authenticate.

### Worktrees, ports and Docker

Settings → **Chat worktrees** has a setup command, a teardown command and a number of ports. Each new
chat gets that many free ports, kept until its worktree is removed. The setup command runs in the new
worktree before the first message (a failure is shown in the chat, and the next message retries it);
the teardown command runs when `/cleanup` or `/discard` removes it. Both, the dev command and the agent
get:

| Variable | Value |
|---|---|
| `THINKERER_PORT_1` … `_N`, `THINKERER_PORT` | the chat's ports (`THINKERER_PORT` = the first) |
| `COMPOSE_PROJECT_NAME` | `thinkerer-<project>-<id>`, so each worktree's `docker compose` stack is separate |
| `THINKERER_WORKTREE`, `THINKERER_BRANCH`, `THINKERER_CHAT_ID` | the worktree, its branch, the chat |
| `THINKERER_PROJECT_ROOT` | the project folder (e.g. to copy an ignored `.env`) |

For example: setup `cp "$THINKERER_PROJECT_ROOT/.env" . && npm ci && docker compose up -d`, teardown
`docker compose down -v`, compose ports like `"${THINKERER_PORT_1:-5432}:5432"`. The preview URL may use
`{port1}`…: with `http://localhost:{port1}` and a dev command such as `npm run dev -- --port
$THINKERER_PORT_1`, the preview beside each chat runs and shows that chat's worktree. The Website tab
runs the project folder, which has no worktree ports.

### Mobile emulators

The preview panel beside a chat has three surfaces: **Web browser**, **Phone viewport** (the same
embedded browser sized like a phone, with no device emulation) and **Emulator**, which runs a real
Android emulator or iOS simulator on this machine:

- **Android** needs the Android SDK (Android Studio, or `ANDROID_HOME`) with at least one AVD. Thinkerer
  boots it headless (`emulator -no-window`) and drives it with `adb`: screen capture, `input`
  tap/swipe/text/keys, `uiautomator` UI dumps. `localhost` URLs work through `adb reverse`.
- **iOS** needs Xcode. Simulators boot headless with `xcrun simctl`, which also handles screenshots,
  URLs, installing/launching apps and logs. simctl can't send touches, so taps and typing need
  [idb](https://fbidb.io): `brew install facebook/fb/idb-companion && pipx install fb-idb`. Without
  it, the iOS screen is view-only. idb's companion process goes stale over time ("Mach port invalid,
  device disconnected"); the driver then runs `idb kill` and retries once. Physical iPhones are not
  supported yet.

The screen is live in the panel. Click to tap, drag to swipe, use the wheel to scroll, with Back / Home
/ Recents and a text field for typing. **Open preview** loads the project's preview URL on the device;
**Send to agent** attaches the device screen to your next message. Booted devices keep running until
you shut them down.

The agent controls the **same devices** through the built-in **Mobile emulators** MCP server
(`mcp/thinkerer-mobile.mjs`; enable it in the MCP tab). Its tools: `mobile_list_devices`,
`mobile_boot`/`shutdown`, `mobile_screenshot` (at logical-point resolution, saved with the run),
`mobile_describe_ui`, `mobile_tap`/`swipe`/`type`/`press_key`, `mobile_open_url`,
`mobile_install_app`/`launch_app`/`terminate_app`/`list_apps` and `mobile_logs`. All coordinates are
logical points (iOS points, Android dp). Both use one dependency-free driver, `mcp/mobile-driver.mjs`.

The embedded preview and the agent's Playwright browser are **separate browser sessions** that visit
the same dev server. They don't share cookies or login state; per the spec, a shared live session is
post-MVP.

## Safety model

**Checkpoints.** Before each run, Thinkerer commits a snapshot of the full working tree through a
temporary index. That includes modified and untracked files; ignored files are excluded. The snapshot
goes to `refs/thinkerer/checkpoints/<run>`, and the end state to `refs/thinkerer/after/<run>`. Your
HEAD, branch, staging area and files are never touched. These local refs are not pushed by default.
The newest 50 are kept. Agents run only in Git repositories; the Agent tab offers to initialize one.

**Worktrees.** Each chat edits its own worktree, never the project folder; `/merge` is the only step
that changes the project folder. It first checks for conflicts with `git merge-tree` (which touches no
files), so a conflict leaves the folder untouched, and Git refuses a merge that would overwrite your
uncommitted changes. Thinkerer never pushes. Worktree branches are deleted only by `/cleanup` (after
checking they're merged) or by `/discard` (after you confirm in a native dialog).

**Commands you configure.** The dev command and the worktree setup and teardown commands live in
`.thinkerer/project.json`, which an agent could edit (Thinkerer reads it from the project folder, never
from a worktree), so each runs only after you approve that exact text in a native dialog. Adding an MCP server also
confirms the command in a native dialog. A compromised renderer cannot fake these dialogs.

**Agent limits.** Both providers get the same instructions: stay in the project, and never push,
deploy, publish or purchase. Each CLI enforces limits its own way, and the app shows each policy under
**Providers → What runs may do**.

| | Claude Code (`claude -p --restricted …`) | Codex (`codex exec --sandbox workspace-write …`) |
|---|---|---|
| File writes | project folder only | project folder + temp dirs (OS sandbox) |
| File reads | project folder only | **not confined** by the sandbox |
| Shell | `npm run *`, `npm test*`, `npx tsc/vitest/playwright test`, `git status/diff/log` pre-approved; anything else decided by Claude's auto-mode classifier (`--permission-mode auto`) | any command, inside the sandbox |
| Network from shell | only if an allowed command does it or the classifier approves it | off |
| Approvals | none; anything auto mode would ask about is denied and listed in the run | `approval_policy="never"`; no escalation |
| MCP | only the project's enabled servers (`--strict-mcp-config`) | only the project's enabled servers; connectors, plugins, built-in browser/computer use, image generation, hooks and web search disabled |
| User config | Claude settings files not loaded | `~/.codex/config.toml` and rules not loaded (login still used) |

The Codex read gap is real: a Codex run can read files outside the project, and their contents go to
the model. Prefer Claude on sensitive machines. npm scripts run with your user permissions under either
provider, so only use agents on projects whose scripts you trust.

**MCP.** Both CLIs receive the same servers, translated to `--mcp-config` JSON for Claude and to
`-c mcp_servers.*` overrides for Codex. Secrets are passed through the CLI's environment, never in
arguments or files: Claude references them as `${NAME}`, and Codex forwards them with `env_vars` and
excludes them from its shell. Under Claude, allowed shell commands still inherit them.
The Playwright server runs headless with an isolated in-memory profile per run. It is limited to the
preview origin with `--allowed-origins`, which Playwright documents as not a hard security boundary,
and it saves screenshots to the run's folder in app data.

**Usage.** Usage is shown only as the CLI reports it: token counts from both, and Claude's rate-limit
window utilisation. Otherwise the UI says **usage unavailable**. Auto picks the first usable provider
in the order `claude > codex`, because neither CLI gives a comparable consumption signal. It skips a
provider that's missing, logged out, or cooling down after a reported rate limit. A manually chosen
provider that's unavailable is refused, never silently swapped. A failed run that changed files offers
**Restore checkpoint first** or **Retry on top**; it never replays automatically.

## Tests

```sh
npm run typecheck
npm test                   # engine integration: projects, files, git, checkpoints/restore, tasks, MCP registry +
                           # CLI translation, health MCP server, dev server, stream parsers, supervisor
npm run test:e2e           # real Electron app: import this repo, Files/Agent, restart persistence; Website Studio
                           # with a real dev server + embedded preview, blocked navigation, Tasks, MCP, diffs;
                           # a chat in its worktree with setup/teardown hooks, /merge and /cleanup
npm run test:live:mobile   # opt-in: the mobile driver against already-booted emulators/simulators
                           # (tests/e2e/emulator.spec.ts also drives a booted Android emulator; skipped if none)
npm run test:live:claude   # opt-in: REAL claude CLI on a throwaway folder (uses your quota)
npm run test:live:codex    # opt-in: REAL codex CLI (needs `codex login`)
```

The supervisor tests use a stand-in process that speaks Claude's stream-json format
(`tests/fixtures/stand-in-agent.mjs`) to test cancellation and process-tree cleanup deterministically.
The live tests check the real adapters. The chat e2e test runs the same stand-in through the real app
via `THINKERER_E2E_AGENT`, which unpackaged builds only honor for tests; packaged apps ignore it.

## Architecture

```text
src/                 React renderer (untrusted UI): no Node, no fs, no shell; runs in "browser preview" mode without the bridge
electron/preload/    Narrow typed bridge → window.thinkerer (shared/api.ts)
electron/main/       Window + security policy, validated IPC, native confirmations, preview view, safeStorage secrets
engine/              Privileged services, Electron-free (unit-testable)
  projects.ts          project registry + .thinkerer/project.json
  files.ts, paths.ts   read-only listing/preview with path + symlink escape checks
  git.ts, checkpoints.ts  status; checkpoints, run diffs, restore
  tasks.ts             task board store
  mcp.ts               MCP registry, per-project grants, run-time resolution
  mobile.ts            Emulator panel backend (wraps mcp/mobile-driver.mjs)
  devserver.ts         approved dev command runner (project folder, and one per chat worktree)
  approvals.ts         exact-text approvals for dev, setup and teardown commands
  chats.ts             chat records: worktree, state (active / merged / done), notes
  worktrees.ts         worktrees, ports, hooks, commits and merges
  chatCommands.ts      /merge, /cleanup, /done, /discard
  agents/              adapter interface, Claude + Codex adapters, supervisor
mcp/                 bundled MCP: thinkerer-health (demo), Playwright launcher, thinkerer-mobile + mobile-driver (emulators)
shared/              Types shared by engine and renderer
scripts/dev.mjs      dev launcher with restart loop
vite.web.config.mts  renderer-only dev server (:5174) for self-preview
```

Electron baseline: `contextIsolation`, `sandbox`, no `nodeIntegration`, CSP, no new windows,
navigation locked to the app origin, all permission requests denied, and every IPC call checks its
sender and arguments. The preview view has no preload, its own session per project, and the same
navigation lock.

## Known limitations

- **Codex:** its read access isn't confined by its sandbox. Live runs, including MCP tool calls, are
  verified against codex-cli 0.169 (`npm run test:live:codex`). Codex reports token counts but no
  rate-limit window figures, so those show as unavailable.
- **Approvals:** there are no interactive approval prompts for agents yet (`awaiting-approval` is
  unused). Anything outside policy is denied and listed in the run. Off-origin navigation in the agent
  browser is blocked rather than offered for approval.
- **Packaging:** the bundled MCP scripts are resolved from the app folder. That works from source;
  packaging would need them as extra resources.
- **Mobile:** the Emulator panel streams screenshots (a few frames per second), not video. iOS input
  needs idb. Only one device is shown at a time.
- **Formatting:** agent messages are shown as plain text, not rendered Markdown.
