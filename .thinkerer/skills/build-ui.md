---
name: build-ui
description: Rules for any renderer/UI change in Thinkerer: Raycast-like design, tokens, accessibility, preview-mode safety.
---

# Build UI

Read `docs/DESIGN.md` first. Checklist:

- Colours, radii, fonts only via CSS variables in `src/styles.css`. Add a token instead of a literal.
- Dark-first; check light too (`prefers-color-scheme`).
- Keyboard: focusable, ↑/↓/↵/esc in lists, visible focus ring; register new actions in the
  command palette once it exists (ROADMAP R-02).
- Real roles and accessible names (`role="tab"`, `aria-label`): the e2e tests select by them.
- One primary (accent) action per view. Status = colour + label/glyph.
- Unknown data shows "unavailable". No fake progress.
- No source-editing controls, anywhere.
- No Node, fs or `window.thinkerer` access outside `src/api.ts`.
- Must not crash in browser preview (empty data).

Check in the browser: Playwright MCP against the preview URL, take a screenshot, report
PASSED/FAILED. Renderer changes hot-reload after `/merge`; no restart needed.
