import { looksLikeApproval } from '../../shared/protocol'
import type { ProtocolStage, RunMode } from '../../shared/types'

// How the composer's next message will run, worked out from the chat and the
// draft. Kept out of AgentTab so the rule is small, testable and in one place.

export interface ComposerModeInput {
  /** A chat is open (false: the next message starts a new chat). */
  hasChat: boolean
  /** The open chat follows the protocol, or the new one will. */
  protocolChat: boolean
  /** The open chat's protocol stage, if any. */
  stage: ProtocolStage | undefined
  /** The mode picker's value (ignored in protocol chats, where the stage decides). */
  mode: RunMode
  draft: string
}

export interface ComposerMode {
  /** The draft approves the protocol's plan, so sending it starts the implementation. */
  approving: boolean
  /** The next message runs read-only. */
  planning: boolean
}

export function composerMode({ hasChat, protocolChat, stage, mode, draft }: ComposerModeInput): ComposerMode {
  // The engine decides with the same rule (shared/protocol.ts), so what the button says is what happens.
  const approving = hasChat && stage === 'plan' && looksLikeApproval(draft)
  const planning = protocolChat ? !approving && (!hasChat || stage === 'plan') : mode === 'plan'
  return { approving, planning }
}
