import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

// Running an epic from the Plan view: one click opens a protocol chat on its first ready
// task (stand-in agent), the bar follows it in the Tasks tab and in that chat, and Stop ends it.

const root = resolve(__dirname, '..', '..')
const shots = process.env.THINKERER_SCREENSHOTS ?? join(root, 'test-results')
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', ...args], { cwd, encoding: 'utf8' }).trim()

test('run an epic: its first task gets a protocol chat by itself, and Stop ends the run', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-epicrun-')))
  const project = join(tmp, 'gadget')
  mkdirSync(join(project, '.thinkerer'), { recursive: true })
  writeFileSync(join(project, 'README.md'), '# Gadget\n')
  writeFileSync(
    join(project, '.thinkerer', 'project.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'Gadget',
      components: ['software'],
      target: 'web',
      website: { devCommand: '', previewUrl: '' },
      agent: { provider: 'auto', enabledMcpServers: [] },
      worktrees: { setupCommand: '', teardownCommand: '', ports: 0 },
      marketing: { enabled: false }
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

    // An epic with two tasks, in plan order.
    const what = page.getByLabel('What to add')
    const title = page.getByLabel('Title of the new item')
    await what.selectOption('epic')
    await title.fill('Sign-in')
    await page.getByRole('button', { name: 'Add epic' }).click()
    for (const t of ['Login form', 'Remember me']) {
      await what.selectOption('task')
      await title.fill(t)
      await page.getByLabel('Epic', { exact: true }).selectOption({ label: 'E-1 · Sign-in' })
      await page.getByRole('button', { name: 'Add task' }).click()
    }
    await expect(page.getByRole('button', { name: /T-2 Remember me/ })).toBeVisible()

    await page.getByRole('button', { name: 'Run epic E-1' }).click()
    const bar = page.getByRole('status', { name: 'Epic run E-1' })
    await expect(bar).toContainText('Running')
    await expect(bar).toContainText('task 1 of 2')
    await expect(bar).toContainText('T-1 in progress')
    // The task moved by itself; the epic is in progress and can't be started twice.
    await expect(page.getByRole('button', { name: /T-1 Login form/ })).toContainText('In progress')
    await expect(page.getByRole('button', { name: /E-1 Sign-in/ })).toContainText('In progress')
    await expect(page.getByRole('button', { name: 'Run epic E-1' })).toHaveCount(0)
    await page.screenshot({ path: join(shots, 'epic-run-tasks.png') })

    // The chat it opened: a protocol chat on T-1, planning read-only, with the same bar.
    await bar.getByRole('button', { name: 'Open chat' }).click()
    await expect(page.getByRole('heading', { name: 'T-1: Login form', level: 1 })).toBeVisible()
    await expect(page.getByLabel('Working')).toHaveCount(0, { timeout: 15_000 })
    const chatBar = page.getByRole('status', { name: 'Epic run E-1' })
    await expect(chatBar).toContainText('T-1 in progress')
    await page.screenshot({ path: join(shots, 'epic-run-chat.png') })

    // Stop: no new chats; the open one stays, and the epic can be run again.
    await chatBar.getByRole('button', { name: 'Stop' }).click()
    await expect(page.getByRole('status', { name: 'Epic run E-1' })).toHaveCount(0)
    await page.getByRole('tab', { name: 'Tasks' }).click()
    await expect(page.getByRole('button', { name: 'Run epic E-1' })).toBeEnabled()
    await expect(page.getByRole('button', { name: /T-2 Remember me/ })).toContainText('To do')
  } finally {
    await app.close()
    rmSync(tmp, { recursive: true, force: true })
  }
})
