# Thinkerer: Roadmap

**Format.** Three horizons: **Now** (being worked on, at most ~3 items), **Next** (agreed, ordered),
**Later** (direction, unordered). Each item has an ID, a one-line why, and acceptance criteria an
agent can verify. Status: `todo`, `doing`, `done`. When an item ships, mark it `done` with the date
and commit, and move the facts into the README. Break `doing` items into tasks on the project board
(the board MCP server) so they show in the Tasks tab (see `.thinkerer/skills/roadmap-item.md`).

Priorities among the engineering components are not decided yet. The order below is a proposal:
foundations first, then the component plug-in model, then components.

## Now

### R-01 · Agent instructions reach every run · `done` (2026-11-21)
Why: without this, no guideline or skill has any effect. A run inside Thinkerer was observed to
start without the contents of `CLAUDE.md` in its context, and Codex gets `AGENTS.md` only if it
loads it itself.
- [x] Likely cause: `--restricted` ignores project settings, so Claude skipped `CLAUDE.md`. The engine now
      injects `AGENTS.md`/`CLAUDE.md` itself through `appendSystemPrompt` (`engine/agents/instructions.ts`).
- [x] Both providers demonstrably receive `AGENTS.md` (stand-in assertion in `tests/supervisor.test.ts`).
- [x] The Agent tab shows which instruction files a run received (turn footer).

### R-02 · Raycast-style UI foundation · `todo`
Why: every later studio reuses it.
- [ ] Design tokens in `src/styles.css` match `docs/DESIGN.md` (dark-first).
- [ ] Global command palette (⌘K): switch project/tab, new chat, slash commands.
- [ ] Keyboard navigation for lists (↑/↓/↵/esc); e2e test covers the palette.

### R-03 · Split oversized views · `todo`
Why: `AgentTab.tsx` (~800 lines) and `supervisor.ts` (~750) make agent runs expensive.
Progress: `AgentTab.tsx` split into `Agent{Chats,Composer,Preview,Transcript}.tsx` + `useFollowUps.ts`
(427 lines left); `mcp/mobile-driver.mjs` split into `mcp/mobile/`. `supervisor.ts` is still to do.
- [ ] No file over ~400 lines in `src/views` and `engine/agents`; behaviour unchanged; tests pass.

### R-10 · Software protocol · `done` (2026-11-21)
Why: a repeatable process for software chats that costs fewer tokens: plan, implement + tests, review, ship.
- [x] Stages plan → implement → review → ship on a chat; the user approves each step.
- [x] Thinkerer runs the checks and the merge itself; only failing output goes back to the agent.
- [x] Review in a fresh read-only session (Claude: `/code-review` on the chat's range, with the plan; Codex: the plan and the diff); fixes resume the implementer.
- [x] Report on ship from recorded data, including reported tokens per stage; cleanup stays manual.
- [x] Settings → Software protocol: check command, review rounds, review model and effort.
- [x] Fixes from the first real use (2026-11-21): a plain "ok implement" reply approves the plan; the
  review diffs the implement commits and refuses an empty diff; `/merge` waits for Ship; lockfile-based
  worktree setup suggestion; per-chat preview started before a turn, or the browser check is skipped.

### R-11 · Project management (board) · `doing`
Why: the Tasks tab grows from a flat list into the project's plan, shared by the user and every agent.
- [x] Milestones → epics → tasks with keys, types (software, firmware, electronics, mechanical, marketing,
      research, other), priority, labels, "done when" criteria, blockers; SQLite in `.thinkerer/local/`.
- [x] Plan, Board and Archived views with a detail pane; archive / restore / delete archived only.
- [x] Task status follows its chats (run → In progress, review → In review, merge/ship → Done, discard → To do).
- [x] Built-in board MCP server for every provider; no delete for agents; changes show live.
- [x] Claude's `/clear` refused in chats (adapter `blockedCommands`).
- [x] Move this roadmap into the board through the MCP server (the user does this when needed).
- [x] Manual check in the running app after **Restart app** (create items, a chat moving a task, an agent edit).

## Next

### R-04 · Interactive approvals · `todo`
Auto mode stays default; what policy denies can instead be *asked* in the UI (command, URL, file
outside scope), with "allow once / always for this project". Uses the unused `awaiting-approval` state.

### R-05 · Generic provider adapters (any CLI, any API) · `todo`
- [ ] `ProviderId` becomes data-driven (registry), not a union of two names.
- [ ] A configurable "generic CLI" adapter (command, args template, output parser).
- [ ] An API adapter with Thinkerer's own minimal tool loop (file read/write in worktree, approved
      commands, MCP), the same policy as CLIs.

### R-06 · Context system v1 (token reduction) · `todo`
- [ ] Generate and maintain `.thinkerer/map.md` and `components/<id>.md`.
- [ ] Per-run context assembly: rules + map + relevant summaries/skills only.
- [ ] Project-level skills in `.thinkerer/skills/`, provider-neutral.
- [ ] Run view shows reported token usage, so before and after can be compared.

### R-07 · Component plug-in model · `todo`
- [ ] `Component` becomes extensible: config section, studio tab, MCP tools, verify commands,
      context summary (see `add-project-component` skill).
- [ ] Website Studio refactored onto it as the first component.

### R-08 · Autonomy policy levels · `todo`
Per-project levels (e.g. local-only → commit/merge → push/PR → release/deploy), executed as audited
engine actions. Default: local-only.

### R-09 · Configurable parallelism · `todo`
Max concurrent chats becomes a setting (no hard product limit).

## Later

- **Electronics Studio:** KiCad project files, `kicad-cli` ERC/DRC/BOM, schematic and PCB rendering.
- **Mechanical Studio:** code-CAD (CadQuery/build123d/OpenSCAD), STEP/STL export, 3D viewer.
- **Firmware Studio:** build/flash commands, serial monitor.
- **Marketing Studio:** AI-driven copy, launch plans, posts, calendar.
- **Orchestration:** planner chat that spawns worker chats from a roadmap item.
- **Remote control from phone:** local-first relay, approve/drive chats.
- **Mobile Studio:** emulator previews.
- **Shared live browser session** between preview and agent.

## Done

- MVP v0.1 Phases 0–1: self-development journey (verified 2026-11-17, see README).
- Per-chat worktrees, `/merge` `/cleanup` `/done` `/discard`, follow-ups resuming sessions.
