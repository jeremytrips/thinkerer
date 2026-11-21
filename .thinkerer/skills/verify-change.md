---
name: verify-change
description: The checks to run before finishing any Thinkerer change, and how to report them.
---

# Verify a change

Run, don't assume. Report the real output when something fails.

1. `npm run typecheck`
2. `npm test` (or a single file first: `npx vitest run tests/<file>.test.ts`)
3. UI flow touched → `npm run test:e2e`
4. UI touched → Playwright MCP browser on the preview URL: navigate, exercise the change, take a
   screenshot. State **PASSED** or **FAILED**. If the preview isn't reachable, say so.
5. Self-review the diff (`git diff`): no stray debug code, no hard-coded colours or ports, no
   secrets, no new deps without reason, files under ~400 lines.

Summary format:
- **Changed:** files/behaviour, one line each
- **Verified:** each command and result; browser check PASSED/FAILED
- **Restart app needed:** yes if `electron/`, `engine/`, `shared/` or `mcp/` changed, otherwise no
- **Not done / follow-ups:** honestly
