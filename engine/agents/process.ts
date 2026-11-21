import { spawn, type ChildProcess } from 'node:child_process'
import type { RunRecord, UsageObservation } from '../../shared/types'
import type { ActiveRun, RunReporter } from './runState'
import type { AgentAdapter } from './types'

export interface WireHooks extends RunReporter {
  refreshArtifacts(run: ActiveRun): Promise<void>
  noteRateLimit(usage: UsageObservation): void
  finish(run: ActiveRun, status: RunRecord['status'], exitCode: number | null, error: string | null): Promise<void>
}

/** Streams the provider CLI's output into the run record, and finishes the run when the process ends. */
export function wireChild(run: ActiveRun, adapter: AgentAdapter, hooks: WireHooks): void {
  const child = run.child!
  const parser = adapter.createParser()
  let buffer = ''
  let stderrTail = ''
  let sawResult: { isError: boolean } | null = null

  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    buffer += chunk
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      for (const u of parser.parseLine(line)) {
        if (u.currentAction) run.record.currentAction = u.currentAction
        if (u.sessionId) run.record.sessionId = u.sessionId
        if (u.capabilities) run.record.capabilities = u.capabilities
        if (u.usage) run.record.usage = mergeUsage(run.record.usage, u.usage)
        if (u.result) {
          sawResult = { isError: u.result.isError }
          run.record.resultText = u.result.text
          run.record.permissionDenials = u.result.denials
        }
        if (u.event) hooks.addEvent(run, u.event)
        if (u.event?.kind === 'tool-result' && run.record.mcpServers.includes('playwright')) void hooks.refreshArtifacts(run)
      }
      if (run.record.usage?.rateLimitStatus === 'rejected') hooks.noteRateLimit(run.record.usage)
      hooks.emitUpdate(run.record)
    }
  })
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4000)
    hooks.addEvent(run, { kind: 'stderr', text: chunk })
  })
  child.on('error', (err) => {
    void hooks.finish(run, 'failed', null, `Could not start ${adapter.label}: ${err.message}`)
  })
  child.on('close', (code, signal) => {
    if (buffer.trim()) for (const u of parser.parseLine(buffer)) if (u.event) hooks.addEvent(run, u.event)
    if (run.cancelRequested) return void hooks.finish(run, 'cancelled', code, null)
    const result = sawResult as { isError: boolean } | null
    if (code === 0 && result && !result.isError) return void hooks.finish(run, 'succeeded', code, null)
    const reason = signal
      ? `Agent process killed by ${signal}`
      : result?.isError
        ? 'Agent reported an error'
        : `Agent exited with code ${code}${stderrTail.trim() ? `: ${stderrTail.trim().split('\n').slice(-3).join(' ')}` : ''}`
    void hooks.finish(run, 'failed', code, reason)
  })
}

export function mergeUsage(prev: UsageObservation | null, next: UsageObservation): UsageObservation {
  return { ...prev, ...next, windows: { ...prev?.windows, ...next.windows } }
}

/** Signals the child's whole process group (it is spawned detached), so tools it started stop too. */
export function killTree(child: ChildProcess | null, signal: NodeJS.Signals): void {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(-child.pid, signal)
    }
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}
