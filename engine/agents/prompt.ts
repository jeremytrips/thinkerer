import type { ClaudeRunConfig, PromptAttachment, RunMode } from '../../shared/types'
import { attachmentRelPath } from '../attachments'
import type { ResolvedMcpServer } from '../mcp'
import type { Workspace } from './runState'

/**
 * The system instructions for one turn: the policy's base text, then what this
 * turn's workspace, tools and mode mean for the agent, then the project's own.
 */
export function buildInstructions(
  base: string,
  servers: ResolvedMcpServer[],
  ws: Workspace,
  mode: RunMode,
  devices: string[] | undefined,
  extra: string,
  project = '',
  previewUp = true
): string {
  const lines = [base]
  if (mode === 'plan') {
    lines.push(
      'This message is in plan mode: investigate read-only and reply with a concrete, step-by-step plan. Do not edit files or run commands that change anything.',
      'The user will reply in this chat to carry the plan out.'
    )
  }
  const wt = ws.chat?.worktree
  if (wt) {
    lines.push(
      `This chat has its own Git worktree on branch ${wt.branch} (created from ${wt.base}); other chats work in other worktrees.`,
      'Thinkerer commits your changes on this branch after each turn, so do not commit, push, or switch branches yourself.'
    )
    if (ws.chat!.ports.length) {
      lines.push(
        `Ports reserved for this worktree: ${ws.chat!.ports.map((p, i) => `THINKERER_PORT_${i + 1}=${p}`).join(', ')} (also in your environment, with COMPOSE_PROJECT_NAME=${ws.chat!.composeProject}). Use them instead of the project's default ports.`
      )
    }
  }
  const preview = ws.previewUrl
  if (servers.some((s) => s.id === 'playwright') && preview && !previewUp) {
    lines.push(`The preview at ${preview} is not running, so skip the browser check and say in your summary that it was not run.`)
  } else if (servers.some((s) => s.id === 'playwright') && preview) {
    lines.push(
      `To check UI changes in a real browser, use the playwright MCP tools against ${preview} (served by the project's dev command; if it stops responding, say so).`,
      'Navigation is limited to that origin. Take a screenshot (browser_take_screenshot) of the verified state; screenshots are saved with the run, not in the project.',
      'State clearly whether the browser check PASSED or FAILED.'
    )
  }
  // Emulators an agent starts must stay inside Thinkerer's Emulator panel: a desktop window
  // (Simulator.app, the emulator UI) steals focus and is not what the user asked for.
  lines.push(
    servers.some((s) => s.id === 'mobile')
      ? `Android emulators and iOS simulators run headless and show only in Thinkerer's Emulator panel. Start and drive them with the mobile MCP tools (mobile_boot boots headless). ${
          devices?.length
            ? `This chat has its own devices, which only it uses: ${devices.join(', ')}. The tools only accept those; other chats have their own.`
            : 'This chat has no device of its own yet; the user can create one in the Emulator panel.'
        }`
      : 'If you start an Android emulator or iOS simulator, boot it headless so it shows only in Thinkerer\'s Emulator panel: `xcrun simctl boot <udid>` or `emulator -avd <name> -no-window`.',
    'Never open a device window yourself: no `open -a Simulator`, Xcode, Android Studio, or `emulator` without `-no-window`.'
  )
  if (servers.some((s) => s.id === 'health')) lines.push('The health MCP server reports project health (git state, preview reachability).')
  if (servers.some((s) => s.id === 'board')) {
    lines.push('The board MCP server is the project’s task board: board_current_task shows the task this chat works on; tick its criteria (board_check) only once verified, and record follow-up work there (board_create). Break work into tasks under an epic (one chat each); a "done when" list holds checks that prove an item is finished, never work items. Never edit files under .thinkerer/local/.')
  }
  if (extra) lines.push(extra)
  // Last, and on its own lines: the project's own instructions, read by Thinkerer (see instructions.ts).
  const text = lines.join(' ')
  return project ? `${text}\n\nProject instructions from the repository (follow them):\n\n${project}` : text
}

/** Tells the agent where the user's preview screenshots are and what page they show. */
export function attachmentNote(attachments: PromptAttachment[]): string {
  if (!attachments.length) return ''
  const items = attachments.map((a, i) => {
    const lines = [`${i + 1}. Screenshot: ${attachmentRelPath(a.id)}`, a.device ? `   Device screen: ${a.device} (use the mobile MCP tools to interact with it)` : `   Page: ${a.url ?? 'unknown'}`]
    if (a.consoleErrors.length) lines.push('   Console errors:', ...a.consoleErrors.map((e) => `   - ${e.slice(0, 500)}`))
    return lines.join('\n')
  })
  return [
    '',
    '',
    '---',
    `The user attached ${attachments.length === 1 ? 'a screenshot' : 'screenshots'} of the site as they see it in Thinkerer's preview. Open each image file (path relative to the project root) to look at it before you start; do not edit or delete it.`,
    ...items
  ].join('\n')
}

/** Per-turn Claude overrides; empty strings keep the project's value. */
export function mergeClaude(base: ClaudeRunConfig, over: Partial<ClaudeRunConfig>): ClaudeRunConfig {
  return { model: over.model || base.model, effort: over.effort || base.effort, tools: over.tools ?? base.tools }
}
