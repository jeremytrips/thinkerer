import { useEffect, useRef, useState } from 'react'
import type { PreviewCapture, RunMode, RunSummary } from '../../shared/types'
import type { Chat } from './AgentChats'

/** A message typed while the chat was working; it is sent when the agent finishes. */
export interface Queued {
  text: string
  attachments: PreviewCapture[]
  mode: RunMode
}

/** Two follow-ups queued for one chat run as one message. Read-only wins, so nothing asked to be only planned gets edited. */
export function mergeQueued(a: Queued, b: Queued): Queued {
  return { text: `${a.text}\n\n${b.text}`, attachments: [...a.attachments, ...b.attachments], mode: a.mode === 'plan' || b.mode === 'plan' ? 'plan' : b.mode }
}

interface Options {
  chats: Chat[]
  runs: RunSummary[]
  /** Starts the follow-up; false if it could not be sent. */
  send: (chatId: string, q: Queued) => Promise<boolean>
  /** Puts an unsent message back into its chat's composer. */
  giveBack: (chatId: string, q: Queued) => void
}

/** Follow-ups queued per chat, sent once their chat finishes. A stopped chat gives the message back instead. */
export function useFollowUps({ chats, runs, send, giveBack }: Options) {
  const [queued, setQueued] = useState<Record<string, Queued>>({})
  const sending = useRef(new Set<string>())

  useEffect(() => {
    for (const [id, q] of Object.entries(queued)) {
      const c = chats.find((x) => x.id === id)
      if (!c || c.live || sending.current.has(id)) continue
      sending.current.add(id)
      setQueued(({ [id]: _sent, ...rest }) => rest)
      if (c.last.status === 'cancelled') {
        giveBack(id, q)
        sending.current.delete(id)
        continue
      }
      void send(id, q)
        .then((ok) => ok || giveBack(id, q))
        .finally(() => sending.current.delete(id))
    }
  }, [runs, queued])

  return {
    queued,
    queue(chatId: string, q: Queued) {
      setQueued((cur) => ({ ...cur, [chatId]: cur[chatId] ? mergeQueued(cur[chatId], q) : q }))
    },
    /** Removes the chat's queued message and returns it (for editing). */
    take(chatId: string): Queued | undefined {
      const q = queued[chatId]
      if (q) setQueued(({ [chatId]: _removed, ...rest }) => rest)
      return q
    }
  }
}
