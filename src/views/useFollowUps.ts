import { useEffect, useRef, useState } from 'react'
import type { RunSummary } from '../../shared/types'
import type { Chat } from './AgentChats'
import { enqueue, type Queued } from './queue'

interface Options {
  chats: Chat[]
  runs: RunSummary[]
  /** The chat isn't live but isn't ready for a new turn yet either. */
  waiting?: (chat: Chat) => boolean
  /** Starts the follow-up; false if it could not be sent. */
  send: (chatId: string, q: Queued) => Promise<boolean>
  /** Puts an unsent message back into its chat's composer. */
  giveBack: (chatId: string, q: Queued) => void
}

/** Follow-ups queued per chat, sent once their chat finishes. A stopped chat gives the message back instead. */
export function useFollowUps({ chats, runs, waiting, send, giveBack }: Options) {
  const [queued, setQueued] = useState<Record<string, Queued>>({})
  const sending = useRef(new Set<string>())

  useEffect(() => {
    for (const [id, q] of Object.entries(queued)) {
      const c = chats.find((x) => x.id === id)
      if (!c || c.live || sending.current.has(id) || waiting?.(c)) continue
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
    // chats too: a chat record update (checks finished) can be what releases a waiting follow-up.
  }, [runs, queued, chats])

  return {
    queued,
    /** Queues a follow-up; returns why it was refused (a different mode than one already queued), else null. */
    queue(chatId: string, q: Queued): string | null {
      const next = enqueue(queued[chatId], q)
      if ('refused' in next) return next.refused
      setQueued((cur) => ({ ...cur, [chatId]: next.queued }))
      return null
    },
    /** Removes the chat's queued message and returns it (for editing). */
    take(chatId: string): Queued | undefined {
      const q = queued[chatId]
      if (q) setQueued(({ [chatId]: _removed, ...rest }) => rest)
      return q
    }
  }
}
