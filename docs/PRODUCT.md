# Thinkerer: Product

Living product definition. Replaces `THINKERER_MVP_v0.1.md` (now historical) as the reference for
*what Thinkerer should be*. What it *is today* is in the README; what comes next is in `ROADMAP.md`.

## One sentence

A personal project manager for an engineer that drives AI agents across the whole engineering
project (software, electronics, mechanical/3D, marketing) and keeps token use low by giving
agents a structured, pre-digested view of each project.

## Who it's for

- **Now:** one engineer (the author), as a personal tool. No accounts, no cloud, no multi-user.
- Design for an engineer who reads diffs, schematics and models but does not want to hand-edit
  them. Assume technical literacy; never hide what an agent did.

## Principles (permanent)

1. **Project-first.** A project is a real folder on disk and the source of truth. It can contain
   any mix of components: software (web, desktop, mobile, firmware), electronics (schematic, PCB),
   mechanical (3D parts, assemblies), marketing.
2. **Agents edit, the user directs.** No source editor, ever. The user instructs, reviews, approves,
   rolls back. Viewers (files, diffs, schematic, 3D) are read-only.
3. **Text-first artifacts.** Prefer formats agents can read and diff as text: code-CAD (e.g.
   CadQuery/OpenSCAD/build123d) over binary CAD, KiCad text files over proprietary EDA, Markdown
   over docs. Binary-only formats get an exported text/preview companion.
4. **Token economy is a feature.** Thinkerer, not the agent, decides what context a run gets:
   project map, component summaries, relevant skills, task history. Agents should rarely need to
   explore the tree from scratch. (See "Context system" below.)
5. **Any agent, same contract.** Any CLI (Claude Code, Codex, Gemini, Aider, …) or raw API model plugs
   in through one adapter interface and gets the same instructions, tools and limits.
6. **Honest by construction.** Never fabricate usage, quota, test results or status.
7. **Recoverable.** Every agent turn is checkpointed; every chat is isolated in its own worktree.
8. **Auto by default, autonomy by policy.** Agents run without prompts (auto mode). Interactive
   approvals exist for the things policy says to ask about. Full autonomy, including push, PR,
   release and deploy, is a goal, granted per project by explicit policy levels and executed by the
   engine (audited and reversible where possible), never as an ungated agent shell command.

## Components (the engineering suite)

| Component | Agent produces | Thinkerer shows (read-only) | Verification |
|---|---|---|---|
| Website / app | code | file tree, diffs, live preview | typecheck, tests, Playwright |
| Firmware | code | diffs, build output, serial log | build, unit tests, HIL later |
| Electronics | KiCad schematic/PCB files, BOM | schematic/PCB render, BOM table | ERC/DRC via `kicad-cli` |
| Mechanical / 3D | code-CAD source, STEP/STL exports | 3D viewer, part list | model builds, dimension/interference checks |
| Marketing | copy, plans, posts, assets | documents, calendar | review checklist, links |
| Mobile | code | emulator preview (later) | tests |

Every component plugs in the same way: a config section in `.thinkerer/project.json`, a studio tab,
optional MCP tools for its toolchain, verification commands, and context summaries.

## Context system (token reduction)

Thinkerer maintains, per project, a small set of files agents can rely on instead of exploring:

```text
.thinkerer/
├── project.json        # config (exists)
├── local/board.sqlite  # project board: milestones → epics → tasks (exists; git-ignored, via the board MCP)
├── map.md              # generated project map: folders → purpose, key entry points (planned)
├── components/<id>.md  # per-component summary: architecture, conventions, commands (planned)
└── skills/             # provider-neutral playbooks (exists for Thinkerer itself; general mechanism planned)
```

Per run, Thinkerer assembles: rules (`AGENTS.md`) + task + map + only the relevant component
summaries and skills. It measures what each run actually consumed (as reported) so the effect of
the context system is visible, not assumed. Thinkerer's own repo uses `AGENTS.md` and
`.thinkerer/skills/` today (read via the table in `AGENTS.md`); automatic per-run selection comes later (see ROADMAP).

## Agents and orchestration

- Providers: any CLI or API, through `engine/agents` adapters. Auto picks a healthy provider by
  documented preference until reliable consumption signals exist.
- Chats run in parallel, each in its own worktree. No hard product limit (the current cap of 4 is
  an implementation default and should become a setting).
- Later: orchestration, where a planning chat breaks a roadmap item into tasks and spawns
  worker chats, then merges them.

## Remote

Drive and approve chats from a phone. Planned after the local experience is solid; needs a
secure local-first relay design (no cloud account by default).

## Design

Raycast-like: dark-first, dense, keyboard-first, command palette at the centre. See `DESIGN.md`.

## Out of scope (for now)

Multi-user, accounts, cloud sync, billing, plugin marketplace, packaging/signing/auto-update.
