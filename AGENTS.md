# Working on Thinkerer

This is the single source of instructions for every coding agent (Claude Code, Codex, any other CLI).
`CLAUDE.md` only imports this file. Keep it short; it is loaded into every run.

**What Thinkerer is:** a personal, project-first manager that drives AI agents for an engineer's whole
work: software, electronics, 3D/mechanical, marketing. The user never edits source in Thinkerer;
agents do. Read `docs/PRODUCT.md` once per task if you need the why, `docs/ROADMAP.md` for what's
next, and `docs/DESIGN.md` before any UI work.

## Hard rules

1. **Renderer is untrusted.** `src/` never touches Node, fs, shell or network beyond the preload API.
   Privileged work goes in `engine/` (no `electron` imports, so it stays unit-testable), exposed
   through a validated handler in `electron/main/ipc.ts`, the bridge in `electron/preload/index.ts`,
   the types in `shared/api.ts`, and a browser-preview fallback in `src/api.ts`.
2. **No source editor, ever.** Files stay read-only in the UI. This is permanent product policy.
3. **Never fabricate.** No invented usage/quota numbers, no claims of "tested" or "works" that you
   didn't check. Show only what a CLI or API reports; otherwise say "unavailable".
4. **Git safety.** Runs start from a checkpoint; never rewrite history or touch `refs/thinkerer/*`.
   You work in a chat worktree on a `thinkerer/*` branch; Thinkerer commits each turn. Don't commit,
   push or switch branches yourself. Autonomy features (push, PR, deploy) are built as *engine
   actions behind policy*, never as agents running `git push` themselves.
5. **Ports and preview.** Use `$THINKERER_PORT_1`… not 5173/5174. Don't run `npm run dev` (it starts
   a second app). `npm run dev:web` serves the renderer alone ("browser preview": no
   `window.thinkerer`, desktop features render empty); that is what the Playwright MCP browser checks.
   Each chat's preview runs on its own `$THINKERER_PORT_1` (`{port1:5174}`); if it is down, say so.
6. **Restart notice.** Edits to `electron/`, `engine/`, `shared/` or `mcp/` need the user to click
   **Restart app**; say so in your summary. Renderer edits hot-reload after the merge (in a protocol
   chat that is **Ship**; `/merge` refuses before it).
7. **Provider-neutral.** Anything that works for one agent provider must go through the adapter
   interface (`engine/agents/types.ts`) so every provider gets it. Same MCP tools, same instructions.

The project board (Tasks tab) is managed only through the `board` MCP server; never touch `.thinkerer/local/`.

Chats in Thinkerer follow the software protocol (plan → implement + tests → review → ship, see README).
In a protocol chat, the stage instructions say what each turn is for; Thinkerer runs the checks itself.

## Definition of done

- `npm run typecheck` and `npm test` pass. Run them; don't assume.
- Engine changes come with a vitest test in `tests/` (real temp folders and real git, no mocks of git).
- UI flows come with or update a Playwright e2e test in `tests/e2e/`, and run `npm run test:e2e`.
- UI changes are checked in the browser preview (Playwright MCP against the preview URL) with a
  screenshot, and the summary says PASSED or FAILED.
- Docs updated: README for shipped behaviour (verified facts only), `docs/ROADMAP.md` status for the
  item you worked on.
- Summary ends with: what changed, how it was verified, restart needed or not.

## Code conventions

- TypeScript strict, no `any` in new code. Validate every IPC argument (`str()`, `bounds()` helpers).
- Dependencies: almost none today, on purpose. Add one only if it saves real complexity; say why.
- Keep files under ~400 lines; split views into `src/views/<Feature>*.tsx` pieces (`AgentTab.tsx` is
  the cautionary example). One engine module per concern.
- Comments explain *why* and safety reasoning, not what the next line does.
- User-facing text: short, plain, specific. Errors say what happened and what to do next.
- Styling: CSS variables in `src/styles.css` only; no inline colours. Follow `docs/DESIGN.md`.

## Docs voice

README = what exists now, stated precisely and verified (dates and commit when a journey was run).
ROADMAP = intent. They never contradict: when you ship a roadmap item, move the facts to README and
mark the item done. `docs/THINKERER_MVP_v0.1.md` is historical; don't update it.

## Skills (playbooks)

Read the matching file before starting such a task. They are plain Markdown, usable by any agent.

| Task | Playbook |
|---|---|
| Expose engine work to the UI | `.thinkerer/skills/add-ipc-endpoint.md` |
| New engine service/module | `.thinkerer/skills/add-engine-service.md` |
| New project tab or view | `.thinkerer/skills/add-project-view.md` |
| Any UI work | `.thinkerer/skills/build-ui.md` |
| New agent provider (CLI or API) | `.thinkerer/skills/add-agent-provider.md` |
| New built-in MCP server | `.thinkerer/skills/add-mcp-server.md` |
| New engineering component (electronics, 3D…) | `.thinkerer/skills/add-project-component.md` |
| Writing e2e tests | `.thinkerer/skills/write-e2e-test.md` |
| Verifying before you finish | `.thinkerer/skills/verify-change.md` |
| Picking up / planning a roadmap item | `.thinkerer/skills/roadmap-item.md` |
| Updating docs after a change | `.thinkerer/skills/update-docs.md` |
