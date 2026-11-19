# Working on Thinkerer

Thinkerer is an Electron + React + TypeScript + Vite desktop app. The product spec is in
`docs/THINKERER_MVP_v0.1.md`. README.md covers architecture and status.

- Renderer code (`src/`) must never touch Node, the filesystem, or shell. Privileged work goes in
  `engine/` (keep it free of `electron` imports so it stays testable). Expose it through a validated
  handler in `electron/main/ipc.ts`, the typed bridge in `electron/preload/index.ts`, and `shared/api.ts`.
- The Files view stays read-only. Do not add source-editing UI.
- Never fabricate provider usage/quota; show only what a CLI reports.
- You may be running *inside* Thinkerer on this repo. Renderer edits hot-reload immediately.
  Edits to `electron/`, `engine/`, `shared/`, `mcp/` need the user to click **Restart app**; say so in your summary.
  Do not run `npm run dev` (it would start a second instance). The Website tab serves the renderer alone via
  `npm run dev:web` on http://localhost:5174 ("browser preview" mode: no `window.thinkerer`, so desktop
  features render empty); that is what the Playwright MCP browser can check.
- Agent runs always start from a Git checkpoint; never rewrite history or touch `refs/thinkerer/*`.
- Chats run in their own Git worktree and branch (`thinkerer/*`), outside the project folder, and
  Thinkerer commits each turn there. Don't commit, push or switch branches yourself. Your edits reach the
  project folder (and the running app's hot reload) only when the user runs `/merge`. Your ports are in
  `$THINKERER_PORT_1`…; use them instead of 5173/5174.
- Verify with: `npm run typecheck`, `npm test`, and for UI flows `npm run test:e2e`
  (Playwright drives the real built app; see `tests/e2e/app.spec.ts`).
