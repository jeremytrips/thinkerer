---
name: roadmap-item
description: Pick up, plan or break down an item from docs/ROADMAP.md into tasks and chats.
---

# Work a roadmap item

1. Read the item in `docs/ROADMAP.md` (ID, why, acceptance criteria) and the relevant part of
   `docs/PRODUCT.md`. If criteria are vague, propose concrete, checkable ones first.
2. Set its status to `doing`; move it to **Now** if needed (keep Now ≤ ~3 items).
3. Break it into tasks small enough for one chat each (one reviewable diff, ideally < ~300 lines).
   Add them to `.thinkerer/tasks.json` as `todo`, titles prefixed with the ID (`R-05: …`), each with
   notes that say what "done" means. The file may not exist yet; its shape is `Task` in
   `shared/types.ts` (`{ id, title, notes, status, runIds, createdAt, updatedAt }`, written by
   `engine/tasks.ts`).
4. Implement one task per chat; tick its acceptance checkbox only when verified (`verify-change.md`).
5. When all criteria are ticked: status `done (YYYY-MM-DD, <commit>)`, move it to **Done**, and
   document the shipped behaviour in README (`update-docs.md`).
