---
name: write-e2e-test
description: Write or extend a Playwright end-to-end test that drives the real built Electron app.
---

# Write an e2e test

Location `tests/e2e/*.spec.ts`; run `npm run test:e2e` (builds first). Copy the structure of
`app.spec.ts` (app basics) or `chats.spec.ts` (agent flow).

- Launch with an isolated app-data dir: `electron.launch({ args: [root], cwd: root, env: { ...process.env, THINKERER_APP_DATA: tmp } })`.
  Clean up the temp dir in `finally`.
- Build throwaway projects in a temp dir with real `git init` and commits. Don't use this repo's
  working tree for anything that writes.
- Select by role and name (`getByRole('button', { name: 'Import folder…' })`), never CSS classes.
- Native dialogs: stub in main with `app.evaluate(({ dialog }) => { dialog.showOpenDialog = … })`.
- Agent runs: use the stand-in agent (`tests/fixtures/stand-in-agent.mjs` via
  `THINKERER_E2E_AGENT`), never a real CLI or quota.
- Screenshots of key states to `THINKERER_SCREENSHOTS ?? test-results/`.
- Assert security invariants where relevant (e.g. renderer has no `require`).
