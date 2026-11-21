import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

// A chat end to end, with a stand-in agent (tests/fixtures/stand-in-agent.mjs)
// instead of a real CLI: it gets a worktree and branch, runs the setup hook,
// commits its turn, and is finished with /merge and /cleanup.

const root = resolve(__dirname, '..', '..')
const shots = process.env.THINKERER_SCREENSHOTS ?? join(root, 'test-results')
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', ...args], { cwd, encoding: 'utf8' }).trim()

test('a chat works in its own worktree and is finished with /merge and /cleanup', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-chats-')))
  const project = join(tmp, 'demo')
  mkdirSync(join(project, '.thinkerer'), { recursive: true })
  writeFileSync(join(project, 'README.md'), '# Demo\n')
  writeFileSync(
    join(project, '.thinkerer', 'project.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'Demo',
      components: ['website'],
      target: 'web',
      website: { devCommand: '', previewUrl: '' },
      agent: { provider: 'auto', enabledMcpServers: [] },
      worktrees: { setupCommand: 'echo "setting up $THINKERER_BRANCH on port $THINKERER_PORT_1"', teardownCommand: 'echo bye', ports: 1 },
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
    await page.getByRole('tab', { name: 'Agent' }).click()
    await page.getByRole('button', { name: 'Preview' }).click() // no dev server in this project

    await page.getByLabel('Chat type').selectOption('chat') // an ordinary chat; the protocol has its own test
    const composer = page.getByRole('textbox', { name: 'Message to the agent' })
    await composer.fill('Add a file')
    await composer.press('Enter')

    // Its own branch and port, the setup hook's output, and the agent's reply.
    const meta = page.locator('.chat-meta')
    await expect(meta).toContainText('thinkerer/add-a-file-')
    await expect(meta).toContainText('ports ')
    await expect(page.getByRole('article', { name: /^Setup: Worktree set up/ })).toBeVisible()
    await expect(page.getByText('Wrote made.txt')).toBeVisible()
    await expect(page.getByLabel('Working')).toHaveCount(0) // committed and finished
    expect(existsSync(join(project, 'made.txt'))).toBe(false)

    // Typing "/" offers the chat commands.
    await composer.fill('/')
    const menu = page.getByRole('listbox', { name: 'Chat commands' })
    await expect(menu.getByRole('option')).toHaveCount(4)
    await composer.fill('/me')
    await expect(menu.getByRole('option')).toHaveCount(1)
    await page.screenshot({ path: join(shots, 'chat-commands.png') })
    await composer.press('Enter')
    await expect(page.getByRole('article', { name: '/merge: Merged into main' })).toBeVisible()
    expect(readFileSync(join(project, 'made.txt'), 'utf8')).toBe('Add a file')
    await expect(page.locator('.chat-hint')).toHaveText('Merged · /cleanup')

    await composer.fill('/cleanup')
    await composer.press('Enter')
    await expect(page.getByRole('article', { name: '/cleanup: Cleaned up — chat done' })).toBeVisible()
    await expect(page.getByRole('article', { name: /^Teardown: Teardown finished/ })).toBeVisible()
    await expect(page.getByText('Done (1)')).toBeVisible()
    await expect(page.getByRole('list', { name: 'Open chats' })).toHaveCount(0)
    await expect(composer).toBeDisabled()
    expect(git(project, 'worktree', 'list').split('\n')).toHaveLength(1)
    await page.screenshot({ path: join(shots, 'chat-done.png') })

    await page.getByRole('tab', { name: 'Settings' }).click()
    await expect(page.getByLabel('Teardown command')).toHaveValue('echo bye')
    await expect(page.getByLabel('Ports per worktree')).toHaveValue('1')
  } finally {
    await app.close()
    rmSync(tmp, { recursive: true, force: true })
  }
})
