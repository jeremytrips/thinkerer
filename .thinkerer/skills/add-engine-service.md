---
name: add-engine-service
description: Create or extend a privileged service in engine/ (git, files, processes, stores) with a real integration test.
---

# Add an engine service

- One concern per module in `engine/` (look at `tasks.ts` for a small store, `worktrees.ts` for
  git work, `devserver.ts` for processes). No `electron` imports, so vitest can load it.
- State outside the repo goes under the app-data dir passed in (`THINKERER_APP_DATA` in tests);
  project state goes in `.thinkerer/` (non-secret only). Secrets: never in files; main's
  `secrets.ts` (safeStorage) owns them.
- Paths from the UI: resolve through `engine/paths.ts` helpers (escape and symlink checks).
- Subprocesses: `execFile`/`spawn` with an args array, never a shell string built from input.
  Kill whole process trees on cancel (see the supervisor).
- Git: never rewrite history or touch `refs/thinkerer/*` except through `checkpoints.ts`.

## Test (required)

`tests/<module>.test.ts`, following `tests/engine.test.ts`:
- `mkdtempSync` + `realpathSync` temp dir in `beforeEach`, `rmSync` in `afterEach`.
- Real git (`git init`, commits) and real files; don't mock git or fs.
- Assert behaviour *and* safety (rejects path escapes, bad input, unapproved commands).

Verify: `npm test -- tests/<module>.test.ts`, then `npm run typecheck && npm test`.
Engine changes need **Restart app**; say so.
