import type { ClaudeOptionalTool, Component, Effort, ProjectConfig, ProjectConfigPatch, ProviderChoice, Target } from '../shared/types'

// The Settings form's values and how they map to and from the project config.
// Number fields stay strings while editing so an empty field shows as an error instead of being saved as 0.

export interface SettingsForm {
  name: string
  components: Component[]
  target: Target
  devCommand: string
  previewUrl: string
  provider: ProviderChoice
  setupCommand: string
  teardownCommand: string
  ports: string
  model: string
  effort: Effort
  claudeTools: ClaudeOptionalTool[]
  checkCommand: string
  reviewRounds: string
  reviewModel: string
  reviewEffort: Effort
}

export const PORTS_RANGE = { min: 0, max: 10 }
export const REVIEW_ROUNDS_RANGE = { min: 1, max: 5 }

export function formFromConfig(config: ProjectConfig): SettingsForm {
  return {
    name: config.name,
    components: [...config.components],
    target: config.target,
    devCommand: config.website.devCommand,
    previewUrl: config.website.previewUrl,
    provider: config.agent.provider,
    setupCommand: config.worktrees.setupCommand,
    teardownCommand: config.worktrees.teardownCommand,
    ports: String(config.worktrees.ports),
    model: config.agent.claude.model,
    effort: config.agent.claude.effort,
    claudeTools: [...config.agent.claude.tools],
    checkCommand: config.protocol.checkCommand,
    reviewRounds: String(config.protocol.maxReviewRounds),
    reviewModel: config.protocol.review.model,
    reviewEffort: config.protocol.review.effort
  }
}

function wholeNumber(value: string, { min, max }: { min: number; max: number }): number | null {
  const v = value.trim()
  if (!/^\d+$/.test(v)) return null
  const n = Number(v)
  return n >= min && n <= max ? n : null
}

// Same limits as applyPatch in engine/projects.ts, checked here so the message says what to fix.
export const MAX_NAME_LENGTH = 100
export const MAX_COMMAND_LENGTH = 500
const COMMANDS = [
  ['devCommand', 'Development command'],
  ['setupCommand', 'Setup command'],
  ['teardownCommand', 'Teardown command'],
  ['checkCommand', 'Check command']
] as const

export function patchFromForm(form: SettingsForm): { patch: ProjectConfigPatch } | { error: string } {
  const name = form.name.trim()
  if (!name) return { error: 'Display name cannot be empty' }
  if (name.length > MAX_NAME_LENGTH) return { error: `Display name must be ${MAX_NAME_LENGTH} characters or fewer` }
  for (const [key, label] of COMMANDS) {
    if (form[key].length > MAX_COMMAND_LENGTH) return { error: `${label} must be ${MAX_COMMAND_LENGTH} characters or fewer` }
  }
  const ports = wholeNumber(form.ports, PORTS_RANGE)
  if (ports === null) return { error: `Ports per worktree must be a whole number from ${PORTS_RANGE.min} to ${PORTS_RANGE.max}` }
  const rounds = wholeNumber(form.reviewRounds, REVIEW_ROUNDS_RANGE)
  if (rounds === null) return { error: `Review rounds must be a whole number from ${REVIEW_ROUNDS_RANGE.min} to ${REVIEW_ROUNDS_RANGE.max}` }
  return {
    patch: {
      name,
      components: form.components,
      target: form.target,
      website: { devCommand: form.devCommand, previewUrl: form.previewUrl },
      agent: { provider: form.provider, claude: { model: form.model.trim(), effort: form.effort, tools: form.claudeTools } },
      worktrees: { setupCommand: form.setupCommand, teardownCommand: form.teardownCommand, ports },
      protocol: { checkCommand: form.checkCommand, maxReviewRounds: rounds, review: { model: form.reviewModel.trim(), effort: form.reviewEffort } }
    }
  }
}

/** A whole number without leading zeros ('03' and '3' save the same); anything else unchanged. */
const sameNumber = (v: string) => (/^\d+$/.test(v.trim()) ? String(Number(v.trim())) : v.trim())

/** The form as the server would store it: trimmed where it trims, numbers as saved, arrays in a fixed order. */
function canonical(form: SettingsForm): SettingsForm {
  return {
    ...form,
    name: form.name.trim(),
    model: form.model.trim(),
    checkCommand: form.checkCommand.trim(),
    reviewModel: form.reviewModel.trim(),
    ports: sameNumber(form.ports),
    reviewRounds: sameNumber(form.reviewRounds),
    components: [...new Set(form.components)].sort(),
    claudeTools: [...new Set(form.claudeTools)].sort()
  }
}

/** Whether saving the form would change the stored config. */
export function isDirty(form: SettingsForm, config: ProjectConfig): boolean {
  return JSON.stringify(canonical(form)) !== JSON.stringify(canonical(formFromConfig(config)))
}
