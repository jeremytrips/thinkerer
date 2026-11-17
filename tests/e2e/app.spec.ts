import { mkdtempSync, rmSync } from 'node:fs'
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

    await page.getByRole('tab', { name: 'Agent' }).click()
    await expect(page.locator('.agent-side .providers')).toContainText('Claude Code')
    await expect(page.locator('.agent-side .providers')).toContainText('Codex')
    await page.locator('.agent-side .provider-policy').first().locator('summary').click()
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
