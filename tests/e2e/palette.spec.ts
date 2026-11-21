import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type Page } from '@playwright/test'

// The ⌘K palette: switch project and tab, start a new chat, and run a slash
// command on the open chat (with the stand-in agent, never a real CLI).

const root = resolve(__dirname, '..', '..')
const shots = process.env.THINKERER_SCREENSHOTS ?? join(root, 'test-results')
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', ...args], { cwd, encoding: 'utf8' }).trim()

function makeProject(tmp: string, name: string): string {
  const folder = join(tmp, name.toLowerCase())
  mkdirSync(join(folder, '.thinkerer'), { recursive: true })
  writeFileSync(join(folder, 'README.md'), `# ${name}\n`)
  writeFileSync(
    join(folder, '.thinkerer', 'project.json'),
    JSON.stringify({
      schemaVersion: 1,
      name,
      components: ['website'],
      target: 'web',
      website: { devCommand: '', previewUrl: '' },
      agent: { provider: 'auto', enabledMcpServers: [] },
      marketing: { enabled: false }
    })
  )
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: folder })
  git(folder, 'add', '-A')
  git(folder, 'commit', '-qm', 'initial')
  return folder
}

async function palette(page: Page, query: string) {
  await page.keyboard.press('ControlOrMeta+k')
  const dialog = page.getByRole('dialog', { name: 'Command palette' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('combobox', { name: 'Search commands' }).fill(query)
  return dialog
}

test('the command palette switches project and tab, starts a chat and runs slash commands', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-palette-')))
  const alpha = makeProject(tmp, 'Alpha')
  const beta = makeProject(tmp, 'Beta')
  const app = await electron.launch({
    args: [root],
    cwd: root,
    env: { ...process.env, THINKERER_APP_DATA: join(tmp, 'appdata'), THINKERER_E2E_AGENT: join(root, 'tests', 'fixtures', 'stand-in-agent.mjs') }
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
    const importFolder = async (folder: string) => {
      await app.evaluate(({ dialog }, f) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as typeof dialog.showOpenDialog
      }, folder)
      // The projects screen's own actions are in the palette too.
      const dialog = await palette(page, 'import')
      await expect(dialog.getByRole('option', { name: /Import folder…/ })).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('Enter')
      await expect(dialog).toBeHidden()
    }
    // Opened over another dialog, the palette is drawn on top of it.
    await page.getByRole('button', { name: 'About', exact: true }).click()
    const aboutBox = (await page.getByRole('dialog', { name: 'About Thinkerer' }).boundingBox())!
    let dialog = await palette(page, '')
    // Over the About card, the topmost element belongs to the palette's layer, not to About.
    const onTop = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.palette-backdrop'), [aboutBox.x + aboutBox.width / 2, aboutBox.y + aboutBox.height / 2])
    expect(onTop).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('dialog', { name: 'About Thinkerer' })).toBeVisible() // esc closed only the palette
    await page.getByRole('button', { name: 'Close' }).click()

    await importFolder(alpha)
    await expect(page.getByRole('tab', { name: 'Overview', selected: true })).toBeVisible()
    await page.getByRole('button', { name: '← Projects' }).click()
    await importFolder(beta)

    // Switch project: Beta is open, so the palette offers Alpha (and home), not Beta.
    dialog = await palette(page, '')
    await expect(dialog.getByRole('group', { name: 'Projects' }).getByRole('option')).toHaveCount(2)
    await expect(dialog.getByRole('group', { name: 'Actions' }).getByRole('option', { name: /New chat/ })).toBeVisible()
    await page.waitForTimeout(250) // let the 140ms fade-in finish
    await page.screenshot({ path: join(shots, 'palette.png') })
    await dialog.getByRole('combobox').fill('alph')
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('navigation', { name: 'Project' })).toContainText('Alpha')

    // Switch tab, moving the selection with the arrow keys.
    dialog = await palette(page, 'tasks')
    await expect(dialog.getByRole('option').first()).toHaveText(/Tasks/)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('tab', { name: 'Tasks', selected: true })).toBeVisible()

    // esc closes without doing anything; no match says so.
    dialog = await palette(page, 'zzzz')
    await expect(dialog).toContainText('No commands match “zzzz”.')
    // Clicking inside the palette (not on an entry) and Tab keep the keys working.
    await dialog.getByRole('combobox').fill('')
    await dialog.getByText('Projects', { exact: true }).click()
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('combobox')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('tab', { name: 'Tasks', selected: true })).toBeVisible()

    // New chat: the Agent tab opens on a new chat with the composer focused.
    await palette(page, 'new chat')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('tab', { name: 'Agent', selected: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible()
    const composer = page.getByRole('textbox', { name: 'Message to the agent' })
    await expect(composer).toBeFocused()

    // Slash commands need an open chat: start one with the stand-in agent.
    await page.getByRole('button', { name: 'Preview' }).click() // no dev server in this project
    await page.getByLabel('Chat type').selectOption('chat')
    await composer.fill('Add a file')
    await composer.press('Enter')
    await expect(page.getByText('Wrote made.txt')).toBeVisible()
    await expect(page.getByLabel('Working')).toHaveCount(0)

    // A leading "/" lists only slash commands; ⌘K works while typing in the composer.
    // A draft in the composer survives a slash command run from the palette.
    await composer.fill('keep this draft')
    await composer.focus()
    dialog = await palette(page, '/')
    await expect(dialog.getByRole('group')).toHaveCount(1)
    await expect(dialog.getByRole('group', { name: 'Slash commands' }).getByRole('option', { name: /^\/merge/ })).toBeVisible()
    await page.waitForTimeout(250) // let the 140ms fade-in finish
    await page.screenshot({ path: join(shots, 'palette-slash.png') })
    await dialog.getByRole('combobox').fill('/done')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('article', { name: /^\/done: Marked done/ })).toBeVisible()
    await expect(composer).toHaveValue('keep this draft')
  } finally {
    await app.close()
    rmSync(tmp, { recursive: true, force: true })
  }
})
