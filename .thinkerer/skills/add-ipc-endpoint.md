---
name: add-ipc-endpoint
description: Expose a privileged engine capability to the renderer through validated IPC. Use when the UI needs data or an action from engine/.
---

# Add an IPC endpoint

Five places, in this order. Skipping one breaks either security or the browser preview.

1. **Engine** (`engine/<module>.ts`): the real work. No `electron` imports. Unit-test it
   (see `add-engine-service.md`).
2. **Types** (`shared/api.ts`, data shapes in `shared/types.ts`): add the method to the right
   namespace of `ThinkererApi`. The renderer imports *types only* from `shared/`.
3. **Handler** (`electron/main/ipc.ts`, inside `registerIpc`):
   ```ts
   handle('ns:verb', async (projectId: unknown, name: unknown) => {
     const project = await okProject(projectId)           // validates id, folder exists
     return doThing(project.path, str(name, 'name', 200))  // validate EVERY argument
   })
   ```
   - `handle()` checks the sender; never call `ipcMain.handle` directly.
   - Validate types, lengths, enums (`str()`, `bounds()`, `PROVIDERS.includes`).
   - Running a user-configured command, deleting, or leaving the project: confirm with the
     native `confirm()` dialog in main, or `approvals` for exact-text command approval.
   - Never add a generic "run command" or "read any path" channel.
4. **Preload** (`electron/preload/index.ts`): `verb: (a, b) => call('ns:verb', a, b)`;
   events via `subscribe('ns:event', cb)`.
5. **Browser-preview fallback** (`src/api.ts` `previewApi`): reads resolve empty
   (`async () => []` / `null`), actions use `unavailable`. Typecheck fails if you forget.

Use it in the renderer through `api.ns.verb(...)` from `src/api.ts`.
Verify: `npm run typecheck && npm test`. Main/preload changes need **Restart app**; say so.
