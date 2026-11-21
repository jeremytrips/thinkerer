---
name: add-project-view
description: Add a new tab or screen inside a project (e.g. a new studio). Use with build-ui.md.
---

# Add a project tab or view

1. `src/views/ProjectView.tsx`: add the id to `TabId`, an entry in `TABS` (`later: true` shows a
   "soon" badge), and a branch in the render switch.
2. Create `src/views/<Name>Tab.tsx`, taking `{ project }` (plus callbacks it needs). Split pieces
   into `src/views/<Name>*.tsx` before a file passes ~400 lines.
3. Data comes only from `api.*` (`src/api.ts`). If it doesn't exist yet: `add-ipc-endpoint.md`.
4. The view must render in browser preview (`browserPreview` true, empty data): show an empty
   state, not a crash.
5. Follow `docs/DESIGN.md` (list + detail, keyboard, tokens).
6. Add an e2e step that opens the tab and checks its main heading/role (`write-e2e-test.md`).

Verify with `verify-change.md`, including a browser-preview screenshot.
