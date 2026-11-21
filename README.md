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
   a renderer-only Vite server on http://localhost:5174. Playwright, health, mobile and board MCP servers are enabled.
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
| Agent | The software protocol (plan → implement + checks → review → ship), chats in their own worktrees, with follow-ups (each message checkpointed and committed on the chat branch), `/merge` `/cleanup` `/done` `/discard`, Auto / Claude / Codex, task link, the project's MCP tools, live progress, changes with diffs, restore, retry, screenshots, a preview of the chat's own dev server |
| Website | Approved dev command runner with logs. Sandboxed embedded preview (Electron `WebContentsView`), locked to the preview origin, with other origins only after approval. Preview console. The agent's browser checks |
| Tasks | Project board: milestones → epics → tasks, as a **Plan** tree, a **Board** (Backlog / To do / In progress / In review / Done) and an **Archived** view; a detail pane per item; status follows the task's chats; agents use it through the board MCP server (see below) |
| Files | Read-only tree and preview, uncommitted changes with diffs, checkpoints with restore |
| MCP | Global server registry (built-in + your own stdio, streamable HTTP and SSE servers, Keychain-encrypted secrets), per-project enable, the tools each provider will actually get, **Check** (connect and list a server's tools), **Import from Claude Code** (`.mcp.json`, `~/.claude.json`) |
| Settings | Name, components, target, dev command, preview URL, chat worktree hooks and ports, default provider, Claude Code model / effort / optional tools, software protocol (check command, review rounds, review model / effort), LLM providers, agent permissions |
| Marketing | Placeholder (post-MVP) |

### Tasks (project board)

- **Items.** Milestones (target date, Planned / Active / Done) → epics → tasks. Every item has a short key (`M-1`,
  `E-3`, `T-12`) that is never reused. Epics and tasks have a type: Software, Firmware, Electronics, Mechanical / 3D,
  Marketing, Research or Other; a new task takes its epic's type unless you pick one. Tasks also have a priority,
  labels, a "Done when" checklist, and "Waits for" (blockers; loops are refused). Epic and milestone progress is
  counted from their tasks.
- **Views.** **Plan**: the tree, with collapse, ↑/↓ between rows, and drag a task onto an epic. **Board**: drag cards
  between columns, or Shift+←/→ on a focused card. **Archived**: restore, or delete for good (asks first). Filters by
  text, type, label and (in Plan) status. Click an item for its detail pane: every field, the linked chats, **Start a chat on T-n**
  (fills the composer with the key, title, notes and checklist, linked to the task), **Open chat**, the history of who
  changed what (you, Thinkerer, or an agent), Archive.
- **Archive.** Archiving takes the item's children along; restoring brings back what was archived with it, and its
  archived parents. Only archived items can be deleted. Nothing new can be put under an archived epic or milestone
  (restore it first), by you or by an agent.
- **Status follows chats.** A turn on a task moves it from Backlog / To do to In progress; a protocol review moves it
  to In review; `/merge` or a protocol ship moves it to Done (a `/cleanup` of a chat that never merged does not);
  `/discard` moves it back to To do unless another open chat works on it. Each chat applies each of these once, so a
  status you set by hand afterwards sticks.
- **Storage.** `<project>/.thinkerer/local/board.sqlite` (Node's built-in `node:sqlite`, no dependency). Thinkerer
  writes `.thinkerer/local/.gitignore` (`*`), so the board is never committed, checkpointed or merged. The database is
  created on the first change (yours or an agent's), not when a project is only opened. It is always the
  main project folder's board, also for chats in worktrees. A project's old `.thinkerer/tasks.json` is imported once
  (ids and run links kept) and left in place; you can delete it afterwards.
- **Agents: the board MCP server** (built-in, `board`; off for new projects, enable it per project in the MCP tab). Tools:
  `board_overview`, `board_list`, `board_get`, `board_current_task`, `board_create`, `board_update`, `board_check` (tick
  one criterion), `board_archive`, `board_unarchive`. No delete. Agent changes are recorded as that chat's and appear in
  the Tasks tab within about a second (the app polls SQLite's `data_version`). It runs on Thinkerer's own Node (Electron
  as Node), not the `node` on your PATH, because it needs `node:sqlite`. When it is enabled, every run's instructions
  (any project, any provider) say to break work into tasks under an epic and to keep "done when" lists for checks only.
- **Verified** 2026-11-21 by `npm test` and `tests/e2e/tasks.spec.ts`, and by hand in the running app after a restart:
  an agent chat moved `docs/ROADMAP.md` into the board through the board MCP server.

### Claude Code features

- **Slash commands and skills.** Type `/` in the composer: Thinkerer's own commands (`/merge`, `/cleanup`, `/done`,
  `/discard`) come first, then the commands and skills Claude Code reported for this chat (`/compact`, `/context`,
  `/init`, `/code-review`, `/security-review`, your skills…). Those are sent to the agent as the message. Commands that only
  work in Claude's interactive terminal, or that Thinkerer handles itself (`/model`, `/effort`, `/mcp`, `/clear`), are left out.
  A message that starts with `/clear` (or its aliases `/reset` and `/new`) is refused: it would start a new Claude session
  and disconnect the chat (and its task) from it. Adapters declare such commands in `blockedCommands`.
- **Plan mode.** The composer's **Mode** select runs one message read-only (`--permission-mode plan` for Claude, a
  read-only sandbox for Codex, which gets no MCP servers for that message because their tools would run pre-approved
  outside the sandbox). The agent replies with a plan; your next message (back in **Make changes**) carries it out.
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
  never reach the UI, and `${VAR}` references become secrets to set (`${VAR:-default}` starts from its default). Servers that rely on `claude mcp login` OAuth may not
  authenticate.

### Software protocol

New chats follow the software protocol unless you untick **Software protocol** under the composer.
The bar at the top of the chat shows the stage and offers the next step:

1. **Plan.** Your first message is the task. It runs read-only, and the agent replies with the goal,
   steps, tests and acceptance criteria. Reply to change the plan, or click **Approve plan & implement**.
   A short reply that plainly approves ("ok implement", "lgtm", "go ahead") counts as approval: the send
   button turns into **Approve & implement** before you send it. A reply with "but", "instead", a
   question mark and the like still refines the plan.
2. **Implement + tests.** The agent continues the same session, implements the plan and adds its tests.
   Then Thinkerer runs the project's check command itself in the worktree (shown as a **Checks** note).
   If the checks fail, **Fix failing checks** sends only the last 50 lines of output back to the agent.
   While the checks run, steps and new messages wait (a queued message is sent when they finish), and
   each new implement turn clears the previous result so it is never reported for code it didn't test.
3. **Review.** A fresh, read-only session. Both kinds of review cover the same range: the implement
   turns, from HEAD before the first one to the branch head. That still holds if the base branch already
   has the work, and it includes commits the agent made itself. A review with nothing to diff (lockfiles
   and minified files aside) is refused, and no turn runs. With Claude Code it runs the `/code-review`
   skill on the chat's branch (`/code-review <level> <branch>`; the turn gets the Skill tool, and
   sub-agents only if the project enables them). Its instructions pin that range, skip lockfiles and
   minified files, add the plan and the check result, and ask for one finding per line. Codex has no
   review command, so it gets the plan, the check result and the diff in the message (same files left
   out; above 60k characters, only the file list). The plan is the latest plan-stage reply with
   acceptance criteria. A reply ending in `No findings.` counts as clean. **Fix findings** sends just
   the findings back to the implementer's session. Review rounds are capped (2 by default); **Review
   again** after a review that didn't finish re-runs the same round, even at the cap.
4. **Ship.** Thinkerer runs the same steps as `/merge`, then adds a report built only from what was
   recorded: turns, check result, findings per round and the tokens each stage's provider reported.
   Cleanup stays manual: type `/cleanup`. Until a protocol chat has shipped, `/merge` refuses and
   points to Ship, so unreviewed work never lands in the base branch.

Settings → **Software protocol** sets the check command (detected from `package.json` `typecheck` /
`test` scripts on import), the review rounds (1–5), and the review model and effort (Claude only, e.g. a
cheaper model for reviews). The review effort is also the `/code-review` level; when it is unset the agent
effort is used (max held at xhigh) or `medium`. They are saved under `protocol` in `.thinkerer/project.json`.

### Worktrees, ports and Docker

Settings → **Chat worktrees** has a setup command, a teardown command and a number of ports. Each new
chat gets that many free ports, kept until its worktree is removed. The setup command runs in the new
worktree before the first message (a failure is shown in the chat, and the next message retries it);
the teardown command runs when `/cleanup` or `/discard` removes it. On import, a project with a
lockfile gets a suggested setup command (`npm ci`, `pnpm install --frozen-lockfile` or `yarn install
--frozen-lockfile`), so new worktrees have their dependencies; like every hook it runs only once approved. Both, the dev command and the agent
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
runs the project folder, which has no worktree ports: `{port1:5174}` gives it port 5174 instead. The
fallback is for the project folder only; a worktree chat without its own port has no preview rather than
the project folder's. This repository uses `http://localhost:{port1:5174}` with `npm run dev:web`, whose
Vite config reads `THINKERER_PORT_1` (so it works on every OS's shell).

Before a turn whose agent has the Playwright tools, Thinkerer checks that the preview answers. If it
doesn't, the turn can edit (read-only plan and review turns never start a server) and the dev command is approved, it starts the chat's dev server and waits up to 30 s. If the
preview is still down, the agent is told to skip the browser check and say so, instead of being asked
to check a page nothing serves.

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

**Each chat has its own devices**, one per platform, so chats never share a screen or app state. A
chat's device is a copy of one of your own emulators/simulators: same hardware and OS, its own apps and
data (`xcrun simctl create`; for Android a new AVD that reuses the base's system image and
`config.ini`). Your own devices are only templates in the panel's **Create** row, never used directly.
The agent's first turn with the Mobile emulators server on creates any missing copy from the last
template picked (else the newest iPhone and the first AVD). Copies are named `Thinkerer · …`
(iOS) / `Thinkerer_…` (AVD), and are shut down and deleted by **Delete** or when the chat's worktree
is removed (`/cleanup`, `/discard`); deletion refuses any device without that prefix. A chat without
a worktree uses the project folder's devices.

The screen is live in the panel. Click to tap, drag to swipe, use the wheel to scroll, with Back / Home
/ Recents and a text field for typing. **Open preview** loads the project's preview URL on the device;
**Send to agent** attaches the device screen to your next message. Booted devices keep running until
you shut them down.

The agent controls the **same devices** through the built-in **Mobile emulators** MCP server
(`mcp/thinkerer-mobile.mjs`; enable it in the MCP tab). Its tools: `mobile_list_devices`,
`mobile_boot`/`shutdown`, `mobile_screenshot` (at logical-point resolution, saved with the run),
`mobile_describe_ui`, `mobile_tap`/`swipe`/`type`/`press_key`, `mobile_open_url`,
`mobile_install_app`/`launch_app`/`terminate_app`/`list_apps` and `mobile_logs`. All coordinates are
logical points (iOS points, Android dp). Both use one dependency-free driver, `mcp/mobile-driver.mjs` (platform code in `mcp/mobile/`).

The server only lists and accepts the chat's own devices (`THINKERER_DEVICES`), and the run's
instructions name them. Devices a chat starts run **only inside Thinkerer**. `mobile_boot` always boots headless (it has no
window option), and every run's instructions tell the agent never to open a device window
(Simulator.app, Xcode, Android Studio, or `emulator` without `-no-window`). Without the MCP server
enabled, the instructions also give the headless shell commands to use instead.

**Each chat has its own embedded browser**: its own session (cookies and storage; `localhost` cookies
ignore the port, so worktree ports alone wouldn't separate them), and its page stays loaded when you
switch chats. Up to six stay open; the least recently shown closes first. A chat's browser is closed
and its storage cleared when its worktree is removed.

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

**Commands you configure.** The dev command, the worktree setup and teardown commands and the protocol's check command live in
`.thinkerer/project.json`, which an agent could edit (Thinkerer reads it from the project folder, never
from a worktree), so each runs only after you approve that exact text in a native dialog. Adding an MCP server also
confirms the command in a native dialog. A compromised renderer cannot fake these dialogs.

**Agent limits.** Both providers get the same instructions: stay in the project, and never push,
deploy, publish or purchase. Each CLI enforces limits its own way, and the app shows each policy under
**Providers → What runs may do**.

**Project instructions.** Thinkerer reads the chat worktree's `AGENTS.md` and `CLAUDE.md` itself
(following `@file` imports, each file once, never outside the worktree, capped at 32k characters)
and adds them to every run's instructions, because `claude --restricted` appears to skip Claude’s own
`CLAUDE.md` discovery. Each turn's footer shows which files the run received
(`engine/agents/instructions.ts`).

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
npm test                   # engine integration: projects, files, git, checkpoints/restore, the board (SQLite,
                           # two processes writing at once, tasks following chats), MCP registry + CLI translation,
                           # health and board MCP servers, dev server, stream parsers, supervisor
npm run test:e2e           # real Electron app: import this repo, Files/Agent, restart persistence; Website Studio
                           # with a real dev server + embedded preview, blocked navigation, Tasks, MCP, diffs;
                           # a chat in its worktree with setup/teardown hooks, /merge and /cleanup;
                           # a protocol chat through plan, checks, review and ship; the Tasks tab (plan, board,
                           # archive, an MCP write showing up live, a task going to Done when its chat is merged,
                           # drag and drop, collapse, ↑/↓, filter, agent history)
npm run test:live:mobile   # opt-in: the mobile driver against already-booted emulators/simulators
                           # (THINKERER_LIVE_MOBILE=1 also runs tests/e2e/emulator.spec.ts, which copies an AVD, boots it, deletes it)
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
  board.ts             project boards for the app: live updates, tasks following chats (store: mcp/board/)
  mcp.ts               MCP registry, per-project grants, run-time resolution
  mobile.ts            Emulator panel backend (wraps mcp/mobile-driver.mjs)
  devserver.ts         approved dev command runner (project folder, and one per chat worktree)
  approvals.ts         exact-text approvals for dev, setup and teardown commands
  chats.ts             chat records: worktree, state (active / merged / done), notes
  worktrees.ts         worktrees, ports, hooks, commits and merges
  chatCommands.ts      /merge, /cleanup, /done, /discard
  agents/              adapter interface, Claude + Codex adapters, supervisor
mcp/                 bundled MCP: thinkerer-health (demo), Playwright launcher, thinkerer-mobile + mobile-driver (emulators),
                     thinkerer-board + board/ (the SQLite board store, shared with the engine)
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
