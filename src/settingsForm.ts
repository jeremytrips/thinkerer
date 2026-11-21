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

export function patchFromForm(form: SettingsForm): { patch: ProjectConfigPatch } | { error: string } {
  if (!form.name.trim()) return { error: 'Display name cannot be empty' }
  const ports = wholeNumber(form.ports, PORTS_RANGE)
  if (ports === null) return { error: `Ports per worktree must be a whole number from ${PORTS_RANGE.min} to ${PORTS_RANGE.max}` }
  const rounds = wholeNumber(form.reviewRounds, REVIEW_ROUNDS_RANGE)
  if (rounds === null) return { error: `Review rounds must be a whole number from ${REVIEW_ROUNDS_RANGE.min} to ${REVIEW_ROUNDS_RANGE.max}` }
  return {
    patch: {
      name: form.name,
      components: form.components,
      target: form.target,
      website: { devCommand: form.devCommand, previewUrl: form.previewUrl },
      agent: { provider: form.provider, claude: { model: form.model, effort: form.effort, tools: form.claudeTools } },
      worktrees: { setupCommand: form.setupCommand, teardownCommand: form.teardownCommand, ports },
      protocol: { checkCommand: form.checkCommand, maxReviewRounds: rounds, review: { model: form.reviewModel, effort: form.reviewEffort } }
    }
  }
}

/** The form as the server would store it: trimmed where it trims, arrays in a fixed order. */
function canonical(form: SettingsForm): SettingsForm {
  return {
    ...form,
    name: form.name.trim(),
    model: form.model.trim(),
    checkCommand: form.checkCommand.trim(),
    reviewModel: form.reviewModel.trim(),
    ports: form.ports.trim(),
    reviewRounds: form.reviewRounds.trim(),
    components: [...new Set(form.components)].sort(),
    claudeTools: [...new Set(form.claudeTools)].sort()
  }
}

/** Whether saving the form would change the stored config. */
export function isDirty(form: SettingsForm, config: ProjectConfig): boolean {
  return JSON.stringify(canonical(form)) !== JSON.stringify(canonical(formFromConfig(config)))
}
