import type { ProviderId } from '../../shared/types'
import type { RunPolicy } from './types'

/** Parallel runs (chats) allowed per project. Each chat has its own worktree. */
export const MAX_PARALLEL_RUNS = 4

/** Preference used by Auto when no comparable consumption signal is available. */
export const DEFAULT_PREFERENCE: ProviderId[] = ['claude', 'codex']

export const DEFAULT_POLICY: RunPolicy = {
  allowedCommands: [
    'npm run *',
    'npm test*',
    'npx tsc *',
    'npx vitest *',
    'npx playwright test*',
    'git status*',
    'git diff*',
    'git log*',
    'git show*',
    'git merge-base*',
    'git rev-parse*',
    'git ls-files*'
  ],
  appendSystemPrompt: [
    'You are running inside Thinkerer, a desktop app that supervises coding agents.',
    'Stay inside your working directory.',
    'Never push, deploy, publish, or purchase anything. Do not commit unless explicitly asked.',
    'If a command or file access is denied, say so instead of trying workarounds.',
    'Finish with a short summary of what you changed and how you verified it.'
  ].join(' ')
}
