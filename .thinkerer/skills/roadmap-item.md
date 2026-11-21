---
name: roadmap-item
description: Pick up, plan or break down an item from docs/ROADMAP.md into tasks and chats.
---

# Work a roadmap item

1. Read the item in `docs/ROADMAP.md` (ID, why, acceptance criteria) and the relevant part of
   `docs/PRODUCT.md`. If criteria are vague, propose concrete, checkable ones first.
2. Set its status to `doing`; move it to **Now** if needed (keep Now ≤ ~3 items).
3. Break it into tasks small enough for one chat each (one reviewable diff, ideally < ~300 lines).
   Use the board MCP server: one epic for the item (`board_create` kind `epic`, title prefixed with
   the ID, `R-05: …`), then its tasks (`kind: task`, `epic: E-n`, `criteria` saying what "done"
   means for that task, `blockedBy` where one task needs another). Every piece of work becomes a
   task, also when the roadmap lists it as an acceptance checkbox: a "done when" list holds checks,
   never work items. The epic's `criteria` are only outcome checks of the whole item (e.g. "a third
   provider can be added without code changes"), or empty; don't copy the task titles there.
   Do this for every item moved onto the board, not only `doing` ones: `status: todo` for Now items,
   `backlog` for Next. Later items with only a one-line direction may stay as an epic with a
   description until they are planned. Never edit `.thinkerer/local/` directly; without the MCP
   server, list the tasks in your reply instead.
4. Implement one task per chat; tick its criteria (`board_check`) and acceptance checkbox only when
   verified (`verify-change.md`).
5. When all criteria are ticked: status `done (YYYY-MM-DD, <commit>)`, move it to **Done**, and
   document the shipped behaviour in README (`update-docs.md`).
