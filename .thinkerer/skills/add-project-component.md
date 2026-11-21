---
name: add-project-component
description: Add an engineering component type (electronics, mechanical/3D, firmware, marketing, mobile) to Thinkerer projects.
---

# Add a project component

Read `docs/PRODUCT.md` "Components" first. A component is always these six parts:

1. **Config:** add it to `Component` in `shared/types.ts` and `COMPONENTS` in `engine/projects.ts`,
   plus an optional config section in `ProjectConfig` with defaults and validation in the patch logic.
2. **Studio tab:** a read-only viewer (`add-project-view.md`). Viewers render artifacts
   (schematic SVG, 3D mesh, BOM table); they never edit them.
3. **Toolchain access:** an MCP server or approved commands for the tool (e.g. `kicad-cli`,
   CadQuery/build123d, `pio`), so every provider gets the same tools (`add-mcp-server.md`).
4. **Verification:** commands an agent runs to prove its change (ERC/DRC, model builds, export
   succeeds, firmware compiles), surfaced in the run as pass/fail with artifacts.
5. **Text-first formats:** pick a format agents can diff (code-CAD, KiCad text files). Binary outputs
   (STEP, STL, gerbers) are generated artifacts, not sources.
6. **Context summary:** what an agent must know about this component, so runs don't explore
   (`.thinkerer/components/<id>.md` once ROADMAP R-06 lands).

Until ROADMAP R-07 (plug-in model) ships, keep component code grouped
(`engine/components/<id>*.ts`, `src/views/<Id>*.tsx`) so it can move cleanly.
