const COPY: Record<string, { title: string; body: string }> = {
  website: {
    title: 'Website Studio',
    body: 'Start the project’s dev command, preview it in a sandboxed view, and see Playwright test runs with screenshots. Planned for Phase 1.'
  },
  tasks: {
    title: 'Tasks',
    body: 'A simple To do / In progress / Done board with agent runs attached to tasks. Planned for Phase 1.'
  },
  mcp: {
    title: 'MCP tools',
    body: 'A global registry of MCP servers with per-project grants, passed identically to every agent provider. Planned for Phase 1. Until then, agents run with no MCP servers at all — your own global MCP configuration is deliberately not passed through.'
  },
  marketing: {
    title: 'Marketing',
    body: 'Marketing lives inside each project. This is a placeholder; marketing workflows are post-MVP.'
  }
}

export function Placeholder({ tab }: { tab: string }) {
  const copy = COPY[tab] ?? { title: tab, body: 'Not available yet.' }
  return (
    <section className="placeholder">
      <h1>{copy.title}</h1>
      <div className="card">
        <span className="badge">Not in this build</span>
        <p>{copy.body}</p>
      </div>
    </section>
  )
}
