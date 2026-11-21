import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import * as mobile from '../../mcp/mobile-driver.mjs'
import { deleteDevice } from '../../mcp/mobile-provision.mjs'

// The Emulator panel against a real Android emulator, end to end: the project
// gets its own copy of one of the user's AVDs (same hardware and OS, fresh
// data), it boots headless and streams into the panel, a click on it is a real
// tap, "Send to agent" attaches the screen, and Delete removes the copy. The
// user's own AVD is only read, never booted or changed. Opt-in
// (THINKERER_LIVE_MOBILE=1): it boots an emulator, which takes about a minute.

const root = resolve(__dirname, '..', '..')
const shots = process.env.THINKERER_SCREENSHOTS ?? join(root, 'test-results')

test('emulator panel gives the project its own Android emulator and drives it', async () => {
  test.skip(!process.env.THINKERER_LIVE_MOBILE, 'Set THINKERER_LIVE_MOBILE=1 to boot a real emulator')
  const template = (await mobile.listDevices()).find((d) => d.platform === 'android' && d.kind === 'emulator' && !d.id.startsWith('android:Thinkerer_'))
  test.skip(!template, 'No Android Virtual Device to copy')
  test.setTimeout(360_000)

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
  /** The project's own device, as the app recorded it. */
  const owned = (): string | undefined => {
    try {
      const file = JSON.parse(readFileSync(join(tmp, 'appdata', 'chat-devices.json'), 'utf8')) as { scopes: Record<string, { id: string }[]> }
      return Object.values(file.scopes).flat()[0]?.id
    } catch {
      return undefined
    }
  }

  const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, THINKERER_APP_DATA: join(tmp, 'appdata') } })
  let id: string | undefined
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
    }, project)
    await page.getByRole('button', { name: 'Import folder…' }).click()
    await expect(page.getByRole('heading', { name: 'Demo app', exact: true })).toBeVisible()

    // The MCP tab offers the mobile server to the agent.
    await page.getByRole('tab', { name: 'MCP' }).click()
    await expect(page.locator('table.effective tr', { hasText: 'Mobile emulators' })).toContainText('✓ included')

    await page.getByRole('tab', { name: 'Agent', exact: true }).click()
    await page.getByRole('tab', { name: 'Emulator' }).click()
    // No device of its own yet: the user's devices are offered as templates, not used directly.
    await expect(page.locator('.emulator-pane')).toContainText('This chat has no device yet')
    await page.getByLabel('Device to copy').selectOption(template!.id)
    await page.locator('.emulator-create').getByRole('button', { name: 'Create' }).click()
    await expect.poll(owned, { timeout: 30_000 }).toMatch(/^android:Thinkerer_\w+$/)
    id = owned()!
    const device = { id }
    await expect(page.getByLabel('Emulator device')).toHaveValue(id)

    await page.locator('.emulator-pane').getByRole('button', { name: 'Boot' }).click()
    const screen = page.locator('img.emulator-screen')
    await expect(screen).toBeVisible({ timeout: 300_000 })
    await expect(page.locator('.emulator-pane .preview-bar .pill').first()).toHaveText('Running')

    // Start from the Settings app, whose search bar is a stable tap target. A freshly
    // created device is still finishing its first boot, so wait until Settings is up.
    type El = { label: string | null; id?: string; editable?: boolean; center: { x: number; y: number } }
    const findSearch = async () => ((await mobile.describeUi(device.id).catch(() => [])) as El[]).find((e) => /search/i.test(`${e.label ?? ''} ${e.id ?? ''}`))
    await expect
      .poll(async () => (await mobile.launchApp(device.id, 'com.android.settings').catch(() => false), !!(await findSearch())), { timeout: 120_000, intervals: [4000] })
      .toBe(true)
    await page.screenshot({ path: join(shots, 'emulator-before.png') })

    // Click the on-screen search bar in the panel; the real device must open Settings search.
    // Retried while the fresh device's layout settles (a click on an open search is harmless).
    await expect
      .poll(
        async () => {
          const search = await findSearch()
          const shot = await mobile.screenshot(device.id, { logical: true })
          const box = (await screen.boundingBox())!
          // The image is object-fit: contain inside its box.
          const fit = Math.min(box.width / shot.pointWidth, box.height / shot.pointHeight)
          const left = box.x + (box.width - shot.pointWidth * fit) / 2
          const top = box.y + (box.height - shot.pointHeight * fit) / 2
          if (search) await page.mouse.click(left + search.center.x * fit, top + search.center.y * fit)
          await page.waitForTimeout(2500)
          return ((await mobile.describeUi(device.id)) as El[]).some((e) => e.editable)
        },
        { timeout: 60_000, intervals: [1000] }
      )
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
    await expect(page.locator('.attachment-chip')).toContainText(`Demo app (${template!.name})`)
    await page.getByRole('button', { name: 'Remove screenshot' }).click()

    // Delete shuts the copy down and removes it; the user's template is untouched.
    await page.locator('.emulator-pane').getByRole('button', { name: 'Delete' }).click()
    await expect.poll(owned, { timeout: 90_000 }).toBeUndefined()
    const remaining = await mobile.listDevices()
    expect(remaining.some((d) => d.id === device.id)).toBe(false)
    expect(remaining.some((d) => d.id === template!.id)).toBe(true)
  } finally {
    await app.close()
    if (id) await deleteDevice(id).catch(() => {})
    rmSync(tmp, { recursive: true, force: true })
  }
})
