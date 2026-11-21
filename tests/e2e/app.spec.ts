import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

// Launches the built app (npm run test:e2e builds first) with an isolated app-data
// folder, imports this repository as a project, and checks the Phase 0 surfaces.

const root = resolve(__dirname, '..', '..')
const shots = process.env.THINKERER_SCREENSHOTS ?? join(root, 'test-results')

async function launch(appData: string) {
  const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, THINKERER_APP_DATA: appData } })
  const page = await app.firstWindow()
  return { app, page }
}

test('import this repository, browse read-only files, see providers, persist across restart', async () => {
  const appData = mkdtempSync(join(tmpdir(), 'thinkerer-e2e-'))
  try {
    let { app, page } = await launch(appData)
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()

    // Renderer must not have Node access.
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined')

    // About dialog opens from the top bar and closes again.
    await page.getByRole('button', { name: 'About', exact: true }).click()
    const about = page.getByRole('dialog', { name: 'About Thinkerer' })
    await expect(about).toBeVisible()
    await expect(about).toContainText('Version')
    await page.screenshot({ path: join(shots, 'about.png') })
    await about.getByRole('button', { name: 'Close' }).click()
    await expect(about).toBeHidden()

    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog
    }, root)
    await page.getByRole('button', { name: 'Import folder…' }).click()
    await expect(page.getByRole('heading', { name: 'Thinkerer', exact: true })).toBeVisible()
    await page.screenshot({ path: join(shots, 'overview.png') })

    await page.getByRole('tab', { name: 'Files' }).click()
    await page.getByRole('button', { name: 'package.json' }).click()
    await expect(page.locator('.viewer-head')).toContainText('package.json')
    await expect(page.locator('.code')).toContainText('"name": "thinkerer"')
    await expect(page.locator('textarea, [contenteditable="true"]')).toHaveCount(0) // nothing editable
    await page.screenshot({ path: join(shots, 'files.png') })

    await page.getByRole('tab', { name: 'Settings' }).click()
    await expect(page.locator('.settings .providers')).toContainText('Claude Code')
    await expect(page.locator('.settings .providers')).toContainText('Codex')
    await page.locator('.settings .provider-policy').first().locator('summary').click()
    await page.screenshot({ path: join(shots, 'settings.png') })

    await page.getByRole('tab', { name: 'Agent' }).click()
    await expect(page.locator('.agent-preview .preview-pane')).toBeVisible() // website shown beside the chat by default
    // Chats are listed beside the conversation (open by default), with a New chat composer.
    await expect(page.getByRole('button', { name: 'Chats', pressed: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Message to the agent' })).toBeVisible()
    await page.screenshot({ path: join(shots, 'agent.png') })

    await app.close()
    ;({ app, page } = await launch(appData))
    // Route + project survive the restart.
    await expect(page.getByRole('tab', { name: 'Agent', selected: true })).toBeVisible()
    await page.getByRole('button', { name: '← Projects' }).click()
    await expect(page.locator('.project-card')).toHaveCount(1)
    await page.screenshot({ path: join(shots, 'home.png') })
    await app.close()
  } finally {
    rmSync(appData, { recursive: true, force: true })
  }
})

test('settings: save tracks unsaved changes, trims values and rejects empty numbers', async () => {
  const appData = mkdtempSync(join(tmpdir(), 'thinkerer-e2e-'))
  const folder = mkdtempSync(join(tmpdir(), 'thinkerer-settings-'))
  const configFile = join(folder, '.thinkerer', 'project.json')
  try {
    const { app, page } = await launch(appData)
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog
    }, folder)
    await page.getByRole('button', { name: 'Import folder…' }).click()
    await page.getByRole('tab', { name: 'Settings' }).click()

    const settings = page.locator('.settings')
    const save = settings.getByRole('button', { name: 'Save' })
    await expect(save).toBeDisabled() // nothing changed yet

    const name = settings.getByLabel('Display name')
    await name.fill('  Renamed project  ')
    await expect(settings.getByText('Unsaved changes')).toBeVisible()
    await save.click()
    await expect(settings.getByText('Saved to .thinkerer/project.json')).toBeVisible()
    await expect(name).toHaveValue('Renamed project') // resynced with what the server stored
    await expect(page.locator('.topbar-name')).toHaveText('Renamed project')
    await expect(save).toBeDisabled()
    expect(JSON.parse(readFileSync(configFile, 'utf8')).name).toBe('Renamed project')

    // Editing again replaces the "Saved" message.
    const ports = settings.getByLabel('Ports per worktree')
    await ports.fill('')
    await expect(settings.getByText('Saved to .thinkerer/project.json')).toBeHidden()
    await expect(settings.getByText('Unsaved changes')).toBeVisible()
    const before = readFileSync(configFile, 'utf8')
    await save.click()
    await expect(settings.getByRole('alert')).toContainText('Ports per worktree must be a whole number from 0 to 10')
    expect(readFileSync(configFile, 'utf8')).toBe(before) // nothing saved
    await page.screenshot({ path: join(shots, 'settings-validation.png') })
    await app.close()
  } finally {
    rmSync(appData, { recursive: true, force: true })
    rmSync(folder, { recursive: true, force: true })
  }
})

test('dark is the default theme and light still applies', async () => {
  const appData = mkdtempSync(join(tmpdir(), 'thinkerer-e2e-'))
  try {
    const { app, page } = await launch(appData)
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
    const bg = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())
    await page.emulateMedia({ colorScheme: 'dark' })
    expect(await bg()).toBe('#14161a')
    await page.screenshot({ path: join(shots, 'theme-dark.png') })
    await page.emulateMedia({ colorScheme: 'light' })
    expect(await bg()).toBe('#f6f6f4')
    await page.screenshot({ path: join(shots, 'theme-light.png') })
    await app.close()
  } finally {
    rmSync(appData, { recursive: true, force: true })
  }
})
