import { join } from 'node:path'
import type { ChatRecord, Project } from '../../shared/types'
import type { Approvals } from '../approvals'
import type { ChatStore } from '../chats'
import { deviceScope, type ChatDevices } from '../chatDevices'
import { allocatePorts, composeProjectName, createWorktree, resolvePreviewUrl, runHook, worktreeEnv } from '../worktrees'
import type { ActiveRun, RunReporter, Workspace } from './runState'

export interface WorkspaceContext extends RunReporter {
  chats: ChatStore
  approvals: Approvals
  worktreesDir: string
}

/**
 * The folder this turn runs in. A chat's first turn creates its worktree and
 * branch, reserves its ports and runs the project's setup hook; if setup
 * fails, the next message in the chat retries it.
 */
export async function prepareWorkspace(ctx: WorkspaceContext, run: ActiveRun, project: Project): Promise<Workspace> {
  const chatId = run.record.chatId!
  let chat = await ctx.chats.get(chatId)
  const config = project.config!
  if (!chat) return { chat: null, cwd: project.path, env: {}, previewUrl: resolvePreviewUrl(config.website.previewUrl, []) }
  const save = async (fn: (c: ChatRecord) => void) => {
    chat = await ctx.chats.update(chatId, fn)
    ctx.chats.emit('update', chat)
    return chat
  }

  if (chat.state === 'setting-up') {
    if (!chat.worktree && !run.wantsWorktree) {
      await save((c) => (c.state = 'active'))
      await ctx.chats.addNote(chatId, {
        kind: 'info',
        ok: true,
        title: 'Working in the project folder',
        lines: ['This repository has no commit to start a worktree from, so this chat edits the project folder directly.']
      })
    } else {
      if (!chat.worktree) {
        run.record.currentAction = 'Creating the worktree…'
        ctx.emitUpdate(run.record)
        const wt = await createWorktree(project.path, join(ctx.worktreesDir, project.id), chatId, chat.title)
        await save((c) => {
          c.worktree = wt
          c.composeProject = composeProjectName(project, chatId)
        })
        const dirty = run.record.gitBefore?.entries.length ?? 0
        ctx.addEvent(run, {
          kind: 'status',
          text: `Worktree ready: branch ${wt.branch} from ${wt.base} (${wt.baseCommit.slice(0, 7)})${dirty ? `. ${dirty} uncommitted change${dirty === 1 ? '' : 's'} in the project folder ${dirty === 1 ? 'is' : 'are'} not included` : ''}`,
          meta: dirty ? { notice: true } : undefined
        })
      }
      const wanted = config.worktrees.ports
      if (chat.ports.length < wanted) {
        const ports = await allocatePorts(wanted - chat.ports.length, [...chat.ports, ...(await ctx.chats.takenPorts())])
        await save((c) => (c.ports = [...c.ports, ...ports]))
        ctx.addEvent(run, { kind: 'status', text: `Ports for this chat: ${chat.ports.map((p, i) => `THINKERER_PORT_${i + 1}=${p}`).join(', ')}` })
      }
      const setup = config.worktrees.setupCommand.trim()
      if (setup) await runSetup(ctx, run, project, chat, setup)
      await save((c) => (c.state = 'active'))
    }
  } else if (chat.state !== 'active' && !chat.worktreeRemoved) {
    // A new message in a merged or done chat is new work.
    await save((c) => {
      c.state = 'active'
      c.doneReason = null
      c.doneAt = null
    })
  }
  const cwd = chat.worktree?.path ?? project.path
  return { chat, cwd, env: worktreeEnv(project, chat), previewUrl: resolvePreviewUrl(config.website.previewUrl, chat.ports) }
}

async function runSetup(ctx: WorkspaceContext, run: ActiveRun, project: Project, chat: ChatRecord, command: string): Promise<void> {
  if (!(await ctx.approvals.isApproved(project.id, 'setup', command))) {
    throw new Error('The worktree setup command has not been approved; send the message again to review it')
  }
  run.record.currentAction = 'Running the worktree setup command…'
  ctx.emitUpdate(run.record)
  ctx.addEvent(run, { kind: 'status', text: `Setting up the worktree: $ ${command}` })
  const lines: string[] = []
  const res = await runHook(command, chat.worktree!.path, worktreeEnv(project, chat), (line) => {
    lines.push(line)
    ctx.addEvent(run, { kind: 'log', text: line, meta: { hook: 'setup' } })
  })
  const ok = res.code === 0 && !res.timedOut
  await ctx.chats.addNote(chat.id, {
    kind: 'setup',
    ok,
    title: ok ? 'Worktree set up' : `Setup failed (${res.timedOut ? 'timed out' : `exit code ${res.code}`})`,
    lines: [`$ ${command}`, ...lines]
  })
  ctx.chats.emit('update', (await ctx.chats.get(chat.id))!)
  if (!ok) throw new Error(`The worktree setup command failed (${res.timedOut ? 'timed out' : `exit code ${res.code}`}); send another message to retry it`)
}

/**
 * The chat's own emulators, created on its first turn with the mobile server
 * enabled (a chat with a worktree; otherwise the project folder's). Null when
 * the mobile server is off for the project (or there is no device service).
 */
export async function chatDevices(devices: ChatDevices | undefined, project: Project, ws: Workspace): Promise<{ ids: string[]; problems: string[] } | null> {
  if (!devices || !project.config?.agent.enabledMcpServers.includes('mobile')) return null
  const chat = ws.chat?.worktree && !ws.chat.worktreeRemoved ? ws.chat : null
  const scope = deviceScope(project.id, chat?.id ?? null)
  try {
    return await devices.ensure(scope, chat?.title ?? project.config?.name ?? 'Project')
  } catch (err) {
    return { ids: await devices.ids(scope).catch(() => []), problems: [`This chat's emulators are unavailable: ${(err as Error).message}`] }
  }
}
