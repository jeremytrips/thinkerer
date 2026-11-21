import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import * as mobile from '../../mcp/mobile-driver.mjs'

// The Emulator panel against a real, already-booted Android emulator: the live
// screen shows up, a click on it is a real tap, and "Send to agent" attaches
// the device screen. Skipped when no Android emulator is running (it never
// boots or shuts one down).

const root = resolve(__dirname, '..', '..')
const shots = process.env.THINKERER_SCREENSHOTS ?? join(root, 'test-results')

test('emulator panel shows and drives a real Android emulator', async () => {
  const android = (await mobile.listDevices()).find((d) => d.platform === 'android' && d.state === 'booted')
  test.skip(!android, 'No booted Android emulator')
  const device = android!

  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-emu-')))
  const project = join(tmp, 'demo-app')
  mkdirSync(join(project, '.thinkerer'), { recursive: true })
  writeFileSync(
    join(project, '.thinkerer', 'project.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'Demo app',
      components: ['website', 'mobile'],
      target: 'web',
      website: { devCommand: '', previewUrl: '' },
      agent: { provider: 'auto', enabledMcpServers: ['mobile'] },
      worktrees: { setupCommand: '', teardownCommand: '', ports: 0 },
      marketing: { enabled: true }
    })
  )
  execFileSync('git', ['init', '-q'], { cwd: project })

  // Start from the Settings app, whose search bar is a stable tap target.
  await mobile.launchApp(device.id, 'com.android.settings')
  await new Promise((r) => setTimeout(r, 1500))

  const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, THINKERER_APP_DATA: join(tmp, 'appdata') } })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog
    }, project)
    await page.getByRole('button', { name: 'Import folder…' }).click()
    await expect(page.getByRole('heading', { name: 'Demo app', exact: true })).toBeVisible()

    // The MCP tab offers the mobile server to the agent.
    await page.getByRole('tab', { name: 'MCP' }).click()
    await expect(page.locator('table.effective tr', { hasText: 'Mobile emulators' })).toContainText('✓ included')

    await page.getByRole('tab', { name: 'Agent', exact: true }).click()
    await page.getByRole('tab', { name: 'Emulator' }).click()
    await page.getByLabel('Emulator device').selectOption(device.id)
    const screen = page.locator('img.emulator-screen')
    await expect(screen).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.emulator-pane .preview-bar .pill').first()).toHaveText('Running')

    // Click the on-screen search bar; the real device must open Settings search.
    const ui = (await mobile.describeUi(device.id)) as { label: string | null; id?: string; center: { x: number; y: number } }[]
    const search = ui.find((e) => /search/i.test(`${e.label ?? ''} ${e.id ?? ''}`))
    expect(search, 'Settings search bar on screen').toBeTruthy()
    const shot = await mobile.screenshot(device.id, { logical: true })
    const box = (await screen.boundingBox())!
    // The image is object-fit: contain inside its box.
    const fit = Math.min(box.width / shot.pointWidth, box.height / shot.pointHeight)
    const left = box.x + (box.width - shot.pointWidth * fit) / 2
    const top = box.y + (box.height - shot.pointHeight * fit) / 2
    await page.screenshot({ path: join(shots, 'emulator-before.png') })
    await page.mouse.click(left + search!.center.x * fit, top + search!.center.y * fit)
    await expect
      .poll(async () => ((await mobile.describeUi(device.id)) as { editable?: boolean }[]).some((e) => e.editable), { timeout: 15_000 })
      .toBe(true)

    // Typing from the panel reaches the device.
    await page.getByLabel('Type into the device').fill('wifi')
    await page.getByLabel('Type into the device').press('Enter')
    await expect
      .poll(async () => ((await mobile.describeUi(device.id)) as { label: string | null }[]).some((e) => /wifi/i.test(e.label ?? '')), { timeout: 15_000 })
      .toBe(true)
    await page.waitForTimeout(800) // let the live view catch up for the screenshot
    await page.screenshot({ path: join(shots, 'emulator-after.png') })

    // "Send to agent" attaches the device screen, labelled with the device.
    await page.locator('.emulator-pane').getByRole('button', { name: 'Send to agent' }).click()
    await expect(page.locator('.attachment-chip')).toContainText(device.name)
    await page.getByRole('button', { name: 'Remove screenshot' }).click()
  } finally {
    await app.close()
    await mobile.pressKey(device.id, 'home').catch(() => {})
    rmSync(tmp, { recursive: true, force: true })
  }
})
