const COPY: Record<string, { title: string; body: string }> = {
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
