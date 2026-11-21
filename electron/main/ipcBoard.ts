import type { BoardService } from '../../engine/board'
import type { BoardCreate, BoardKind, BoardPatch } from '../../shared/types'
import { plainObject, str } from './validate'

type Handle = <A extends unknown[], T>(channel: string, fn: (...args: A) => Promise<T> | T) => void

const KINDS: BoardKind[] = ['milestone', 'epic', 'task']

/**
 * The project board's channels. Shapes are checked here; every field's value is checked
 * again by the store (mcp/board/store.mjs), which the MCP server shares.
 */
export function registerBoardIpc(deps: {
  handle: Handle
  board: BoardService
  projectPath: (id: unknown) => Promise<string>
  send: (channel: string, ...args: unknown[]) => void
}): void {
  const { handle, board, projectPath, send } = deps
  const ref = (v: unknown) => str(v, 'item', 100)
  const order = (ids: unknown): string[] => {
    if (!Array.isArray(ids) || ids.length > 5000) throw new Error('Invalid order')
    return ids.map((i) => str(i, 'item id', 100))
  }

  handle('board:get', async (id: unknown) => board.board(await projectPath(id)))
  handle('board:history', async (id: unknown, item: unknown) => board.history(await projectPath(id), ref(item)))
  handle('board:create', async (id: unknown, input: unknown) => {
    const obj = plainObject(input, 'new item')
    if (!KINDS.includes(obj.kind as BoardKind)) throw new Error('Choose what to create: milestone, epic or task')
    return board.create(await projectPath(id), obj as unknown as BoardCreate)
  })
  handle('board:update', async (id: unknown, item: unknown, patch: unknown) =>
    board.update(await projectPath(id), ref(item), plainObject(patch, 'update') as BoardPatch)
  )
  handle('board:archive', async (id: unknown, item: unknown) => board.archive(await projectPath(id), ref(item)))
  handle('board:unarchive', async (id: unknown, item: unknown) => board.unarchive(await projectPath(id), ref(item)))
  handle('board:remove', async (id: unknown, item: unknown) => board.remove(await projectPath(id), ref(item)))
  handle('board:move', async (id: unknown, item: unknown, patch: unknown, ids: unknown) =>
    board.move(await projectPath(id), ref(item), plainObject(patch, 'update') as BoardPatch, order(ids))
  )
  handle('board:reorder', async (id: unknown, kind: unknown, ids: unknown) => {
    if (!KINDS.includes(kind as BoardKind)) throw new Error('Invalid kind')
    return board.reorder(await projectPath(id), kind as BoardKind, order(ids))
  })

  board.on('change', (path) => send('board:changed', path))
}
