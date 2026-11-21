import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

// The Tasks tab end to end: milestones → epics → tasks, the detail pane, the board,
// archive/restore/delete, an agent's MCP write showing up live, and a task following
// its chat (stand-in agent) from In progress to Done on /merge.

const root = resolve(__dirname, '..', '..')
const shots = process.env.THINKERER_SCREENSHOTS ?? join(root, 'test-results')
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', ...args], { cwd, encoding: 'utf8' }).trim()

/** What an agent does through the thinkerer-board MCP server: one tool call over stdio. */
function agentCreatesTask(projectRoot: string, title: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--no-warnings', join(root, 'mcp', 'thinkerer-board.mjs')], {
      env: { ...process.env, THINKERER_BOARD_ROOT: projectRoot, THINKERER_CHAT_ID: 'e2e-agent' }
    })
    child.stdout.on('data', (d) => {
      if (String(d).includes('"id":1')) {
        child.kill()
        done()
      }
    })
    child.on('error', fail)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'board_create', arguments: { kind: 'task', title } } }) + '\n')
  })
}

test('plan, board, archive, live agent edits, and a task that follows its chat', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-tasks-')))
  const project = join(tmp, 'gadget')
  mkdirSync(join(project, '.thinkerer'), { recursive: true })
  writeFileSync(join(project, 'README.md'), '# Gadget\n')
  writeFileSync(
    join(project, '.thinkerer', 'project.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'Gadget',
      components: ['hardware'],
      target: 'web',
      website: { devCommand: '', previewUrl: '' },
      agent: { provider: 'auto', enabledMcpServers: [] },
      worktrees: { setupCommand: '', teardownCommand: '', ports: 0 },
      marketing: { enabled: true }
    })
  )
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project })
  git(project, 'add', '-A')
  git(project, 'commit', '-qm', 'initial')

  const app = await electron.launch({
    args: [root],
    cwd: root,
    env: { ...process.env, THINKERER_APP_DATA: join(tmp, 'appdata'), THINKERER_E2E_AGENT: join(root, 'tests', 'fixtures', 'stand-in-agent.mjs') }
  })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
    }, project)
    await page.getByRole('button', { name: 'Import folder…' }).click()
    await page.getByRole('tab', { name: 'Tasks' }).click()
    await expect(page.getByText('Nothing planned yet.')).toBeVisible()

    // A milestone, an epic in it, a task in the epic (which takes the epic's type).
    const what = page.getByLabel('What to add')
    const title = page.getByLabel('Title of the new item')
    await what.selectOption('milestone')
    await title.fill('Prototype')
    await page.getByRole('button', { name: 'Add milestone' }).click()
    await what.selectOption('epic')
    await title.fill('Blink firmware')
    await page.getByLabel('Type', { exact: true }).selectOption('firmware')
    await page.getByLabel('Milestone', { exact: true }).selectOption({ label: 'M-1 · Prototype' })
    await page.getByRole('button', { name: 'Add epic' }).click()
    await what.selectOption('task')
    await title.fill('Toggle the LED pin')
    await page.getByLabel('Epic', { exact: true }).selectOption({ label: 'E-1 · Blink firmware' })
    await page.getByRole('button', { name: 'Add task' }).click()

    const milestone = page.getByRole('region', { name: 'Milestone Prototype' })
    const taskRow = milestone.getByRole('button', { name: /T-1 Toggle the LED pin/ })
    await expect(milestone.getByRole('button', { name: /E-1 Blink firmware/ })).toContainText('0/1')
    await expect(taskRow).toContainText('Firmware')

    // Details: a criterion, priority, status.
    await taskRow.click()
    const detail = page.getByRole('complementary', { name: 'Task T-1' })
    await detail.getByLabel('New criterion').fill('LED blinks at 1 Hz')
    await detail.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(detail.getByRole('checkbox', { name: 'LED blinks at 1 Hz' })).not.toBeChecked()
    await detail.getByLabel('Priority').selectOption('high')
    await detail.getByLabel('Status').selectOption('review')
    await expect(taskRow).toContainText('In review')
    await expect(taskRow).toContainText('High')
    await page.screenshot({ path: join(shots, 'tasks-plan.png') })

    // Board: the card is in review; Shift+→ moves it to Done.
    await page.getByRole('tab', { name: 'Board' }).click()
    const card = page.getByRole('region', { name: 'In review' }).getByRole('article', { name: /T-1/ })
    await expect(card).toContainText('☑ 0/1')
    await card.focus()
    await card.press('Shift+ArrowRight')
    await expect(page.getByRole('region', { name: 'Done' })).toContainText('Toggle the LED pin')
    await page.screenshot({ path: join(shots, 'tasks-board.png') })

    // Archive, find it under Archived, restore it, archive again, delete it for good.
    await detail.getByRole('button', { name: 'Archive' }).click()
    await expect(page.getByRole('region', { name: 'Done' })).not.toContainText('Toggle the LED pin')
    await page.getByRole('tab', { name: /Archived/ }).click()
    const archivedTasks = page.getByRole('region', { name: 'Archived tasks' })
    await expect(archivedTasks).toContainText('T-1')
    await page.screenshot({ path: join(shots, 'tasks-archived.png') })
    await archivedTasks.getByRole('button', { name: 'Restore' }).click()
    await expect(page.getByText('Nothing archived.')).toBeVisible()
    await detail.getByRole('button', { name: 'Archive' }).click()
    await archivedTasks.getByRole('button', { name: 'Delete…' }).click()
    await archivedTasks.getByRole('button', { name: 'Delete T-1 for good' }).click()
    await expect(page.getByText('Nothing archived.')).toBeVisible()

    // An agent adds a task through the board MCP server: it shows up without a reload.
    await page.getByRole('tab', { name: 'Plan' }).click()
    await agentCreatesTask(project, 'Order the parts')
    const agentRow = page.getByRole('button', { name: /T-2 Order the parts/ })
    await expect(agentRow).toBeVisible({ timeout: 10_000 })

    // Start a chat on it: the task moves to In progress, and to Done when the chat is merged.
    await agentRow.click()
    await page.getByRole('button', { name: 'Start a chat on T-2' }).click()
    const composer = page.getByRole('textbox', { name: 'Message to the agent' })
    await expect(composer).toHaveValue(/^T-2: Order the parts/)
    await page.getByRole('button', { name: 'Preview' }).click() // no dev server in this project
    await page.getByLabel('Software protocol').uncheck()
    await composer.press('Enter')
    await expect(page.getByText(/Wrote made\.txt/)).toBeVisible()
    await expect(page.getByLabel('Working')).toHaveCount(0)

    // Claude's /clear would cut the chat off from its session (and its task): refused.
    await composer.fill('/clear')
    await composer.press('Enter')
    await expect(page.getByText("/clear isn't available in Thinkerer chats")).toBeVisible()

    await page.getByRole('tab', { name: 'Tasks' }).click()
    await expect(page.getByRole('button', { name: /T-2 Order the parts/ })).toContainText('In progress')
    await page.getByRole('button', { name: /T-2 Order the parts/ }).click()
    await page.getByRole('complementary', { name: 'Task T-2' }).getByRole('button', { name: 'Open chat' }).click()
    await expect(page.getByRole('heading', { name: 'T-2: Order the parts', level: 1 })).toBeVisible()
    await composer.fill('/merge')
    await composer.press('Enter')
    await expect(page.getByRole('article', { name: '/merge: Merged into main' })).toBeVisible()
    await page.getByRole('tab', { name: 'Tasks' }).click()
    await expect(page.getByRole('button', { name: /T-2 Order the parts/ })).toContainText('Done')

    // History says the agent created it.
    await page.getByRole('button', { name: /T-2 Order the parts/ }).click()
    const detail2 = page.getByRole('complementary', { name: 'Task T-2' })
    await detail2.getByText(/^History/).click()
    await expect(detail2.locator('.detail-history')).toContainText('an agent · created')
    await detail2.getByRole('button', { name: 'Close details' }).click()

    // Plan: drag the loose task onto the epic; collapse; ↑/↓ between rows; filter.
    await page.getByRole('region', { name: 'Tasks without an epic' }).getByRole('button', { name: /T-2 Order the parts/ }).dragTo(milestone.getByRole('button', { name: /E-1 Blink firmware/ }))
    await expect(milestone.getByRole('button', { name: /T-2 Order the parts/ })).toBeVisible()
    await expect(milestone.getByRole('button', { name: /E-1 Blink firmware/ })).toContainText('1/1')
    await milestone.getByRole('button', { name: 'Collapse Blink firmware' }).click()
    await expect(milestone.getByRole('button', { name: /T-2 Order the parts/ })).toHaveCount(0)
    await milestone.getByRole('button', { name: 'Expand Blink firmware' }).click()
    await milestone.getByRole('button', { name: /M-1 Prototype/ }).focus()
    await page.keyboard.press('ArrowDown')
    await expect(milestone.getByRole('button', { name: /E-1 Blink firmware/ })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(milestone.getByRole('button', { name: /T-2 Order the parts/ })).toBeFocused()
    await what.selectOption('task')
    await page.getByLabel('Epic', { exact: true }).selectOption('')
    await title.fill('Write the README')
    await page.getByRole('button', { name: 'Add task' }).click()
    await page.getByLabel('Filter text').fill('readme')
    await expect(page.getByRole('button', { name: /T-3 Write the README/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /T-2 Order the parts/ })).toHaveCount(0)
    await page.getByRole('button', { name: 'Clear filters' }).click()
    await expect(page.getByRole('button', { name: /T-2 Order the parts/ })).toBeVisible()

    // Plan's status filter doesn't hide cards in the Board, which has no control for it.
    await page.getByLabel('Filter by status').selectOption('done')
    await expect(page.getByRole('button', { name: /T-3 Write the README/ })).toHaveCount(0)

    // Board: drag a card to another column (saved with its new order in one write).
    await page.getByRole('tab', { name: 'Board' }).click()
    await page.getByRole('region', { name: 'To do' }).getByRole('article', { name: /T-3/ }).dragTo(page.getByRole('region', { name: 'In progress' }))
    await expect(page.getByRole('region', { name: 'In progress' })).toContainText('Write the README')
    expect(git(project, 'status', '--porcelain')).toBe('')
  } finally {
    await app.close()
    rmSync(tmp, { recursive: true, force: true })
  }
})
