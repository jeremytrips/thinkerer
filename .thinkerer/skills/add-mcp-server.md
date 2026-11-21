---
name: add-mcp-server
description: Add a built-in MCP server that Thinkerer ships and grants per project to every provider.
---

# Add a built-in MCP server

1. Server script in `mcp/<name>.mjs` (stdio). Small and dependency-light; `thinkerer-health.mjs` is
   the template. Tools take validated input and stay inside what the project allows.
2. Register in `engine/mcp.ts` beside the existing `builtin: true` entries; use `{appRoot}` in args.
   Secrets are declared as `secretEnv` names, never values.
3. It reaches providers through `claudeMcpConfig` / Codex `-c mcp_servers.*` automatically. Check
   both in `tests/mcp.test.ts` (same logical catalog; disabled servers absent).
4. Enable it for Thinkerer itself in `.thinkerer/project.json` `agent.enabledMcpServers` only if
   agents on this repo should use it.

Toolchain servers for engineering components (KiCad, CAD kernel, serial) follow the same pattern.
Changes to `mcp/` and `engine/` need **Restart app**.
