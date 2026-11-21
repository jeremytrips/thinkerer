import type { ChatProtocol, ProtocolAction, ProtocolStage, RunSummary } from '../../shared/types'

// The software protocol's stepper (Plan · Implement + tests · Review · Ship) and
// the next steps the user can take. The engine checks every step again; this
// only offers the ones that make sense now.

const STEPS: { stage: ProtocolStage; label: string }[] = [
  { stage: 'plan', label: 'Plan' },
  { stage: 'implement', label: 'Implement + tests' },
  { stage: 'review', label: 'Review' },
  { stage: 'shipped', label: 'Ship' }
]

interface Props {
  protocol: ChatProtocol
  /** The chat's base branch, for the ship button. */
  base: string | null
  /** A turn is running or starting, or a step is being sent. */
  busy: boolean
  maxRounds: number
  /** The latest review turn, to tell "no findings" from findings. */
  lastReview: RunSummary | undefined
  onAction: (action: ProtocolAction) => void
}

interface Step {
  action: ProtocolAction
  label: string
  primary?: boolean
}

export function ProtocolBar({ protocol, base, busy, maxRounds, lastReview, onAction }: Props) {
  const current = STEPS.findIndex((s) => s.stage === protocol.stage)
  const { steps, hint } = nextSteps(protocol, base, maxRounds, lastReview)
  return (
    <section className="protocol-bar" aria-label="Protocol steps">
      <ol className="protocol-steps">
        {STEPS.map((s, i) => (
          <li key={s.stage} className={i < current || protocol.stage === 'shipped' ? 'done' : i === current ? 'current' : ''} aria-current={i === current ? 'step' : undefined}>
            {s.label}
            {s.stage === 'review' && protocol.round > 0 && <span className="muted"> · round {protocol.round}/{maxRounds}</span>}
          </li>
        ))}
      </ol>
      <div className="row small">
        {!busy &&
          steps.map((s) => (
            <button key={s.action} type="button" className={s.primary ? 'small primary' : 'small'} onClick={() => onAction(s.action)}>
              {s.label}
            </button>
          ))}
        <span className="muted">{busy ? 'Working…' : hint}</span>
      </div>
    </section>
  )
}

function nextSteps(p: ChatProtocol, base: string | null, maxRounds: number, lastReview: RunSummary | undefined): { steps: Step[]; hint: string } {
  const ship: Step = { action: 'ship', label: `Ship to ${base ?? 'base'}` }
  const canReview = p.round < maxRounds
  switch (p.stage) {
    case 'plan':
      return { steps: [{ action: 'approve-plan', label: 'Approve plan & implement', primary: true }], hint: 'Or reply to change the plan.' }
    case 'implement': {
      const checks = p.checks
      if (checks?.status === 'running') return { steps: [], hint: `Running checks: ${checks.command}` }
      const steps: Step[] = []
      if (checks?.status === 'failed') steps.push({ action: 'fix-checks', label: 'Fix failing checks', primary: true })
      if (canReview) steps.push({ action: 'start-review', label: checks?.status === 'failed' ? 'Review anyway' : 'Start review', primary: checks?.status !== 'failed' })
      if (p.round > 0) steps.push({ ...ship, primary: !canReview && checks?.status !== 'failed' })
      const hint =
        checks?.status === 'not-approved'
          ? 'Checks not run: the check command is not approved.'
          : !canReview
            ? `Review limit reached (${maxRounds}). Ship, or keep working by replying.`
            : checks?.status === 'passed'
              ? 'Checks passed.'
              : checks
                ? ''
                : 'No check command set for this project.'
      return { steps, hint }
    }
    case 'review': {
      const clean = /^\s*No findings\.?\s*$/i.test(lastReview?.resultText ?? '')
      if (lastReview && lastReview.status !== 'succeeded') {
        return { steps: [...(canReview ? [{ action: 'start-review' as const, label: 'Review again', primary: true }] : []), ship], hint: 'The review did not finish.' }
      }
      return clean
        ? { steps: [{ ...ship, primary: true }], hint: 'The reviewer found nothing to fix.' }
        : { steps: [{ action: 'fix-findings', label: 'Fix findings', primary: true }, ship], hint: '' }
    }
    case 'shipped':
      return { steps: [], hint: 'Shipped. Type /cleanup when you are ready to remove the worktree.' }
  }
}
