import type { ChatCommand, ChatNote, ChatRecord, Project } from '../shared/types'
import type { Approvals } from './approvals'
import type { ChatStore } from './chats'
import { gitStatus } from './git'
import {
  branchExists,
  commitAll,
  commitsAhead,
  currentBranch,
  isMerged,
  localBranches,
  mergeBranch,
  removeWorktree,
  runHook,
  stashesOn,
  worktreeEnv
} from './worktrees'

// Slash commands typed in a chat. Thinkerer runs them itself (the agent never
// sees them) and records the outcome in the chat as a note. Nothing here pushes
// or rewrites history; the only way to delete unmerged work is /discard, which
// the user confirms in a native dialog first.

export const CHAT_COMMANDS: ChatCommand[] = ['merge', 'cleanup', 'done', 'discard']

export interface CommandContext {
  project: Project
  chat: ChatRecord
  chats: ChatStore
  approvals: Approvals
  /** Whether a turn of this chat is running or starting. */
  live: boolean
  /** Stops the dev server running in the chat's worktree, if any. */
  stopDevServer: () => void
}

type Note = Omit<ChatNote, 'at'>

export async function runChatCommand(name: ChatCommand, ctx: CommandContext): Promise<ChatRecord> {
  if (!CHAT_COMMANDS.includes(name)) throw new Error('Unknown command')
  const { note, apply } = await COMMANDS[name](ctx)
  await ctx.chats.addNote(ctx.chat.id, { ...note, kind: name })
  const chat = apply ? await ctx.chats.update(ctx.chat.id, apply) : (await ctx.chats.get(ctx.chat.id))!
  ctx.chats.emit('update', chat)
  return chat
}

type Outcome = { note: Omit<Note, 'kind'>; apply?: (c: ChatRecord) => void }

const COMMANDS: Record<ChatCommand, (ctx: CommandContext) => Promise<Outcome>> = { merge, cleanup, done, discard }

const fail = (title: string, ...lines: string[]): Outcome => ({ note: { ok: false, title, lines } })
const list = (items: string[], max = 15) => [...items.slice(0, max).map((i) => `  ${i}`), ...(items.length > max ? [`  … and ${items.length - max} more`] : [])]

async function merge({ project, chat, live }: CommandContext): Promise<Outcome> {
  const wt = chat.worktree
  if (live) return fail('Not merged: this chat is still working', 'Wait for it to finish or stop it, then run /merge again.')
  if (!wt || chat.worktreeRemoved) return fail('Nothing to merge', 'This chat works in the project folder, not in a worktree.')
  const lines: string[] = []
  const leftover = await commitAll(wt.path, 'Uncommitted changes in the chat worktree', `Thinkerer-Chat: ${chat.id}`)
  if (leftover) lines.push(`✅ Committed uncommitted changes in the worktree (${leftover.slice(0, 7)})`)
  const ahead = await commitsAhead(project.path, wt.base, wt.branch)
  if (!ahead) return { note: { ok: true, title: `Nothing to merge: ${wt.base} already has everything from this chat`, lines } }

  const onBranch = await currentBranch(project.path)
  if (onBranch !== wt.base) {
    return fail('Not merged', ...lines, `❌ The project folder is on ${onBranch ?? 'a detached HEAD'}, not ${wt.base}. Check out ${wt.base} there first.`)
  }
  const res = await mergeBranch(project.path, wt.branch, `Merge ${wt.branch}: ${chat.title}`)
  if (!res.ok) {
    return fail(
      res.conflicts.length ? `Not merged: ${res.conflicts.length} conflicting file${res.conflicts.length === 1 ? '' : 's'}` : 'Not merged',
      ...lines,
      ...(res.conflicts.length
        ? [
            '❌ Nothing was changed in the project folder. Conflicts in:',
            ...list(res.conflicts),
            `Ask the agent to "merge ${wt.base} into this branch and resolve the conflicts", then run /merge again.`
          ]
        : [
            '❌ Git refused the merge; nothing was changed:',
            ...list(res.output.split('\n').filter((l) => l.trim() && !l.startsWith('hint:')), 10),
            'Commit or stash the uncommitted changes Git lists in the project folder, then run /merge again.'
          ])
    )
  }
  return {
    note: {
      ok: true,
      title: `Merged into ${wt.base}`,
      lines: [...lines, `✅ ${ahead} commit${ahead === 1 ? '' : 's'} from ${wt.branch} merged into ${wt.base} (${res.commit.slice(0, 7)}). Nothing was pushed.`, 'Run /cleanup to remove the worktree.']
    },
    apply: (c) => (c.state = 'merged')
  }
}

/** Checks that nothing in the worktree still needs doing, then tears it down. */
async function cleanup(ctx: CommandContext): Promise<Outcome> {
  const { project, chat, live } = ctx
  const wt = chat.worktree
  if (!wt || chat.worktreeRemoved) {
    return chat.worktreeRemoved ? fail('Already cleaned up') : fail('Nothing to clean up', 'This chat works in the project folder. Use /done to file it away.')
  }
  const lines: string[] = []
  const stop = (why: string, ...more: string[]) => fail('Not cleaned up', ...lines, `❌ ${why}`, ...more)

  if (live) return stop('A turn is still running. Wait for it to finish or stop it.')
  lines.push('✅ No turn is running')

  const status = await gitStatus(wt.path)
  if (!status) return stop(`The worktree at ${wt.path} is missing or no longer a Git worktree.`, 'Use /discard to forget it.')
  if (status.entries.length) {
    return stop(`${status.entries.length} uncommitted change${status.entries.length === 1 ? '' : 's'} in the worktree:`, ...list(status.entries.map((e) => `${e.code} ${e.path}`)))
  }
  lines.push('✅ Nothing uncommitted in the worktree')

  if (await branchExists(project.path, wt.branch)) {
    const ahead = await commitsAhead(project.path, wt.base, wt.branch)
    if (ahead) return stop(`${ahead} commit${ahead === 1 ? '' : 's'} on ${wt.branch} ${ahead === 1 ? 'is' : 'are'} not in ${wt.base}.`, 'Run /merge first (or /discard to throw the work away).')
  }
  lines.push(`✅ Everything on ${wt.branch} is in ${wt.base}`)

  const start = new Set([...wt.branchesAtStart, wt.branch])
  const others: string[] = []
  for (const b of await localBranches(project.path)) {
    if (!start.has(b) && !(await isMerged(project.path, b, wt.base))) others.push(b)
  }
  if (others.length) return stop(`Branch${others.length === 1 ? '' : 'es'} created during this chat ${others.length === 1 ? 'is' : 'are'} not merged into ${wt.base}:`, ...list(others))
  lines.push('✅ No other unmerged branches from this chat')

  const stashes = await stashesOn(project.path, wt.branch)
  if (stashes.length) return stop(`${stashes.length} stash entr${stashes.length === 1 ? 'y was' : 'ies were'} made on this branch:`, ...list(stashes), 'Apply or drop them first.')
  lines.push('✅ No stashes left on this branch')

  const teardown = await runTeardown(ctx, lines)
  if (!teardown.ok) return stop('The teardown command failed, so the worktree was kept. Fix it and run /cleanup again.')
  await removeWorktree(project.path, wt)
  lines.push(`✅ Removed the worktree and the branch ${wt.branch}${chat.ports.length ? `; released ports ${chat.ports.join(', ')}` : ''}`)
  return { note: { ok: true, title: 'Cleaned up — chat done', lines }, apply: finished('cleanup') }
}

async function done({ chat }: CommandContext): Promise<Outcome> {
  const kept = chat.worktree && !chat.worktreeRemoved
  return {
    note: {
      ok: true,
      title: 'Marked done',
      lines: kept ? [`The worktree is still at ${chat.worktree!.path}. Run /cleanup to check it and remove it, or send a message to pick the chat up again.`] : []
    },
    apply: (c) => {
      c.state = 'done'
      c.doneReason = 'manual'
      c.doneAt = new Date().toISOString()
    }
  }
}

/** Deletes the worktree and its branch, merged or not. The IPC layer asks the user to confirm first. */
async function discard(ctx: CommandContext): Promise<Outcome> {
  const { project, chat, live } = ctx
  const wt = chat.worktree
  if (live) return fail('Not discarded: a turn is still running', 'Stop it first.')
  if (!wt || chat.worktreeRemoved) return fail('Nothing to discard', 'This chat has no worktree.')
  const lines: string[] = []
  const teardown = await runTeardown(ctx, lines)
  if (!teardown.ok) lines.push('⚠️ The teardown command failed; removing the worktree anyway.')
  await removeWorktree(project.path, wt, { force: true })
  lines.push(`✅ Deleted the worktree and the branch ${wt.branch}`)
  return { note: { ok: true, title: 'Discarded', lines }, apply: finished('discarded') }
}

function finished(reason: 'cleanup' | 'discarded') {
  return (c: ChatRecord) => {
    c.state = 'done'
    c.doneReason = reason
    c.doneAt = new Date().toISOString()
    c.worktreeRemoved = true
  }
}

/** Stops the chat's dev server and runs the project's teardown hook in the worktree. */
async function runTeardown({ project, chat, approvals, stopDevServer, chats }: CommandContext, lines: string[]): Promise<{ ok: boolean }> {
  stopDevServer()
  const command = project.config?.worktrees.teardownCommand.trim()
  if (!command) return { ok: true }
  if (!(await approvals.isApproved(project.id, 'teardown', command))) {
    lines.push('❌ The teardown command has not been approved')
    return { ok: false }
  }
  const output: string[] = []
  const res = await runHook(command, chat.worktree!.path, worktreeEnv(project, chat), (l) => output.push(l))
  const ok = res.code === 0 && !res.timedOut
  await chats.addNote(chat.id, {
    kind: 'teardown',
    ok,
    title: ok ? 'Teardown finished' : `Teardown failed (${res.timedOut ? 'timed out' : `exit code ${res.code}`})`,
    lines: [`$ ${command}`, ...output]
  })
  lines.push(ok ? `✅ Ran the teardown command` : `❌ The teardown command failed (${res.timedOut ? 'timed out' : `exit code ${res.code}`})`)
  return { ok }
}
