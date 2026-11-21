# Thinkerer: Design guidelines

Direction: **Raycast-like.** A fast, quiet, keyboard-first tool for engineers. Original visual
identity: take the *principles*, not Raycast's assets, icons or exact look.

## Principles

1. **Keyboard first.** Every action is reachable from the command palette (⌘K). Lists navigate with
   ↑/↓, ↵ opens, esc goes back, ⌘↵ for the primary action. Show shortcuts next to actions.
2. **List + detail.** Most screens are a searchable list on the left and a detail pane on the right.
3. **Dense but calm.** 13px base text, tight vertical rhythm, few borders, subtle separators.
   Show only what helps the current decision; details expand on demand.
4. **Status at a glance.** Running, waiting, failed and merged states use colour *and* a glyph or label.
   Never colour alone.
5. **Nothing blocks.** Long work streams progress inline; toasts for completion; modals only for
   confirmations that are destructive or privileged (native dialogs for those).
6. **Honest UI.** Unknown values show as "unavailable". Never fake progress bars.

## Tokens

All colours, radii and fonts are CSS variables in `src/styles.css`. Never hard-code colours.
Dark is the primary theme; light must keep working.

| Token | Use |
|---|---|
| `--bg`, `--surface`, `--surface-2` | window, panels, raised/hover rows |
| `--border` | 1px separators, sparingly |
| `--text`, `--muted` | primary text, secondary/meta text |
| `--accent`, `--accent-soft`, `--accent-text` | focus, selection, primary action (one per view); text on accent |
| `--ok`, `--warn`, `--danger` (+ `-soft`), `--danger-text` | status only; text on a danger button |
| `--info-soft`, `--code-bg` | info banners; code, logs and diffs |
| `--backdrop`, `--shadow`, `--shadow-soft`, `--bezel` | modal backdrop, overlays, device-frame preview |
| `--type-software` … `--type-other` | work-type tags on the board (always with a label) |
| `--radius`, `--radius-control`, `--radius-badge` | 8px panels; 6px controls; 4px badges |
| `--mono` | paths, commands, diffs, logs, IDs |

Dark values live in `:root`; light overrides sit under `@media (prefers-color-scheme: light)`.
`tests/design-tokens.test.ts` checks that every token above is defined in both themes and that no
colour literal appears outside those two blocks or inline in `src/`.

Target sizes: 13px body, 12px meta, 15–17px titles; row height 32–36px; 8px spacing grid.
Motion: 120–180ms ease-out, opacity/translate only; honour `prefers-reduced-motion`.

## Patterns

- **Command palette:** fuzzy search across projects, tabs, chats, slash commands, recent actions.
  Sections with headers; right-aligned shortcut hints.
- **Action bar:** bottom strip of the detail pane with the primary action and "⌘K Actions".
- **Empty states:** one sentence + the one action that fixes it.
- **Errors:** inline banner near the cause: what happened, what to do. Copyable details.
- **Viewers** (code, diff, schematic, 3D): read-only, monospace or canvas, with a toolbar.

## Accessibility

Real roles and labels (e2e tests select by role/name, so this is also testability). Visible focus
ring using `--accent`. Contrast AA in both themes.
