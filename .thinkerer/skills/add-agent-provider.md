---
name: add-agent-provider
description: Integrate a new agent provider (any CLI such as Gemini or Aider, or an API model) through the common adapter interface.
---

# Add an agent provider

Contract: `engine/agents/types.ts` `AgentAdapter` = `detect()`, `buildInvocation()`,
`createParser()`, plus `label` and a plain-language `policySummary`. Models: `claude.ts`, `codex.ts`.

1. `engine/agents/<id>.ts`:
   - `detect()`: installed? version? logged in? Use the CLI's own login; never ask for tokens.
   - `buildInvocation()`: non-interactive, machine-readable streaming output; prompt on **stdin**;
     `cwd` = worktree; no prompts (auto mode); confine writes to the worktree; apply
     `policy.allowedCommands` and `policy.appendSystemPrompt`; pass **only** `opts.mcp` servers
     (disable the user's own config/plugins); secrets only via `env`, never argv or files;
     support `resumeSessionId` if the CLI can resume.
   - `createParser()`: map each output line to `ParsedUpdate` (events, current action,
     sessionId, usage *only as reported*, final result and denials).
2. Register: `ProviderId` in `shared/types.ts`, `PROVIDERS` in `electron/main/ipc.ts`, the adapters
   list and `DEFAULT_PREFERENCE` in `engine/agents/supervisor.ts`, the settings UI. (ROADMAP R-05
   makes this data-driven; prefer extending that once it exists.)
3. Document its limits honestly in the README "Agent limits" table (what it can read, write, run).
4. Tests: parser unit test against captured real output lines (like `tests/codex.test.ts`);
   opt-in live test in `tests/agents.live.test.ts` behind an env flag.

**API providers** have no CLI: they need Thinkerer's own tool loop (worktree-confined file tools,
approved commands, MCP client) enforcing the *same* policy. Don't ship one with weaker limits.
Engine changes need **Restart app**.
