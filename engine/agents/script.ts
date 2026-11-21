import type { ProviderStatus } from '../../shared/types'
import { parseClaudeLine } from './claude'
import { childEnv } from './detect'
import type { AgentAdapter } from './types'

/**
 * For end-to-end tests only (unpackaged builds, THINKERER_E2E_AGENT): a script
 * that speaks Claude's stream-json stands in for the real CLIs, run with
 * Electron's own Node.
 */
export function scriptAdapter(script: string): AgentAdapter {
  const status: ProviderStatus = {
    id: 'claude',
    label: 'Claude Code',
    installed: true,
    executable: process.execPath,
    version: 'e2e stand-in',
    authenticated: true,
    adapterAvailable: true,
    detail: 'E2E stand-in agent',
    policy: 'E2E stand-in agent'
  }
  return {
    id: 'claude',
    label: 'Claude Code',
    policySummary: status.policy,
    detect: async () => status,
    buildInvocation: ({ executable, prompt, mode }) => ({
      command: executable,
      // Plan-mode turns are read-only, as with the real CLIs.
      args: [script, mode === 'plan' ? 'readonly' : 'ok'],
      stdin: prompt,
      env: { ...childEnv(), ELECTRON_RUN_AS_NODE: '1' }
    }),
    createParser: () => ({ parseLine: parseClaudeLine })
  }
}
