import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

// Website Studio, Tasks, MCP and checkpoints against a throwaway project with a
// tiny real dev server. Native dialogs are answered from the main process.

const root = resolve(__dirname, '..', '..')
const shots = process.env.THINKERER_SCREENSHOTS ?? join(root, 'test-results')

async function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port
      s.close(() => r(port))
    })
  })
}

test('website studio, tasks, MCP grants and checkpoints', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-studio-')))
  const project = join(tmp, 'demo-site')
  const port = await freePort()
  mkdirSync(join(project, '.thinkerer'), { recursive: true })
  writeFileSync(
    join(project, 'server.mjs'),
    `import http from 'node:http'
const page = '<!doctype html><title>Demo</title><h1>Demo site</h1><a id="out" href="https://example.com/">external</a><script>console.error("demo console error")</script>'
http.createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end(page) }).listen(${port}, () => console.log('demo listening'))\n`
  )
  writeFileSync(
    join(project, '.thinkerer', 'project.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'Demo site',
      components: ['website'],
      target: 'web',
      website: { devCommand: 'node server.mjs', previewUrl: `http://localhost:${port}` },
      agent: { provider: 'auto', enabledMcpServers: [] },
      worktrees: { setupCommand: '', teardownCommand: '', ports: 0 },
      marketing: { enabled: true }
    })
  )
  // A server configured for Claude Code itself, to import (no secrets, so no Keychain access).
  writeFileSync(
    join(project, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'Local Health': { command: process.execPath, args: [join(root, 'mcp', 'thinkerer-health.mjs')], env: { LOG_LEVEL: 'info' } } } })
  )
  execFileSync('git', ['init', '-q'], { cwd: project })
  // A throwaway home, so importing never reads the real ~/.claude.json.
  const home = join(tmp, 'home')
  mkdirSync(home)

  const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, HOME: home, THINKERER_APP_DATA: join(tmp, 'appdata') } })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
    }, project)
    await page.getByRole('button', { name: 'Import folder…' }).click()
    await expect(page.getByRole('heading', { name: 'Demo site', exact: true })).toBeVisible()

    // Tasks (the full flow is in tasks.spec.ts)
    await page.getByRole('tab', { name: 'Tasks' }).click()
    await page.getByLabel('Title of the new item').fill('Write the landing page')
    await page.getByRole('button', { name: 'Add task' }).click()
    await expect(page.getByRole('button', { name: /T-1 Write the landing page/ })).toContainText('To do')

    // MCP grants
    await page.getByRole('tab', { name: 'MCP' }).click()
    await page.locator('.mcp-server', { hasText: 'Project health' }).getByRole('checkbox').check()
    await page.locator('.mcp-server', { hasText: 'Playwright browser' }).getByRole('checkbox').check()
    await expect(page.locator('table.effective')).toContainText('Project health')
    await expect(page.locator('table.effective tr', { hasText: 'Playwright browser' })).toContainText('✓ included')
    await page.screenshot({ path: join(shots, 'mcp.png') })

    // Check a server: connect and list its tools
    const health = page.locator('.mcp-server', { hasText: 'Project health' })
    await health.getByRole('button', { name: 'Check' }).click()
    await expect(health.locator('.mcp-check')).toContainText(/Connected to thinkerer-health .* 1 tool/, { timeout: 15_000 })

    // Import a server from Claude Code's own configuration (.mcp.json), then check it
    await page.getByRole('button', { name: 'Import from Claude Code…' }).click()
    const candidate = page.locator('.import-list li', { hasText: 'Local Health' })
    await expect(candidate).toContainText('.mcp.json')
    await expect(candidate).toContainText('local-health')
    await candidate.getByRole('button', { name: 'Import' }).click()
    await expect(candidate.getByRole('button', { name: 'Replace' })).toBeVisible()
    const imported = page.locator('.mcp-server', { hasText: 'local-health' })
    await expect(imported).toContainText('Imported from .mcp.json')
    await imported.getByRole('button', { name: 'Check' }).click()
    await expect(imported.locator('.mcp-check')).toContainText('1 tool', { timeout: 15_000 })
    await page.screenshot({ path: join(shots, 'mcp-import-check.png') })

    // Claude Code run options in Settings, saved to .thinkerer/project.json
    await page.getByRole('tab', { name: 'Settings' }).click()
    const claude = page.getByRole('group', { name: 'Claude Code' })
    await claude.getByLabel('Model').fill('sonnet')
    await claude.getByLabel('Effort').selectOption('high')
    await page.getByRole('group', { name: 'Optional Claude Code tools' }).getByRole('checkbox', { name: /Web search/ }).check()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved to .thinkerer/project.json')).toBeVisible()
    const saved = JSON.parse(readFileSync(join(project, '.thinkerer', 'project.json'), 'utf8'))
    expect(saved.agent.claude).toEqual({ model: 'sonnet', effort: 'high', tools: ['Task', 'Skill', 'WebSearch'] })

    // Software protocol options, saved alongside
    const protocol = page.getByRole('group', { name: 'Software protocol' })
    await protocol.getByLabel('Check command').fill('npm test')
    await protocol.getByLabel('Review rounds').fill('3')
    await protocol.getByLabel('Review model').fill('haiku')
    await protocol.getByLabel('Review effort').selectOption('low')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved to .thinkerer/project.json')).toBeVisible()
    expect(JSON.parse(readFileSync(join(project, '.thinkerer', 'project.json'), 'utf8')).protocol).toEqual({
      checkCommand: 'npm test',
      maxReviewRounds: 3,
      review: { model: 'haiku', effort: 'low' }
    })
    await page.screenshot({ path: join(shots, 'settings-protocol.png') })
    await page.screenshot({ path: join(shots, 'settings-claude.png') })

    // Plan mode is offered per message in the composer
    await page.getByRole('tab', { name: 'Agent' }).click()
    // New chats follow the software protocol by default; the mode picker is for ordinary chats.
    await expect(page.getByLabel('Mode for the next message')).toHaveCount(0)
    await page.getByLabel('Software protocol').uncheck()
    await expect(page.getByLabel('Mode for the next message')).toHaveValue('auto')
    await page.getByLabel('Mode for the next message').selectOption('plan')
    await expect(page.getByRole('button', { name: 'Plan', exact: true })).toBeVisible()
    await page.getByLabel('Mode for the next message').selectOption('auto')

    // Website Studio: real dev server + embedded preview
    await page.getByRole('tab', { name: 'Website' }).click()
    await page.getByRole('button', { name: 'Start dev server' }).click()
    await expect(page.locator('.preview-bar .pill')).toHaveText('Running', { timeout: 20_000 })
    await expect(page.locator('.devlog')).toContainText('demo listening')
    const previewUrl = `http://localhost:${port}/`
    await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()))).toContain(previewUrl)

    await page.getByRole('tab', { name: /Preview console/ }).click()
    await expect(page.locator('.console')).toContainText('demo console error')
    // Navigation away from the preview origin is blocked and offered for approval.
    await app.evaluate(({ webContents }, url) => {
      void webContents.getAllWebContents().find((w) => w.getURL() === url)!.executeJavaScript('document.getElementById("out").click()')
    }, previewUrl)
    await expect(page.locator('.console')).toContainText('Blocked navigation to https://example.com/')
    await expect(page.getByRole('button', { name: 'Allow & open…' })).toBeVisible()
    expect(await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().some((w) => w.getURL() === url), previewUrl)).toBe(true)
    await page.screenshot({ path: join(shots, 'website.png') })
    const previewPng = await app.evaluate(async ({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL() === url)!
      return (await wc.capturePage()).toPNG().toString('base64')
    }, previewUrl)
    writeFileSync(join(shots, 'website-preview.png'), Buffer.from(previewPng, 'base64'))

    // Agent tab: the same live preview beside the chat, and "Send to agent" attaches what the user sees.
    await page.getByRole('tab', { name: 'Agent', exact: true }).click()
    await expect(page.locator('.agent-preview .preview-bar .pill')).toHaveText('Running')
    const frame = page.locator('.agent-preview .preview-frame')
    const nativeBounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map((v) => v.getBounds()))
    await expect.poll(async () => {
      const box = (await frame.boundingBox())!
      return (await nativeBounds()).some((b) => Math.abs(b.x - box.x) <= 1 && Math.abs(b.width - box.width) <= 1)
    }).toBe(true)
    await page.getByRole('button', { name: 'Send to agent' }).click({ timeout: 10_000 })
    // The page logged one console error; the blocked navigation above must not have reset it.
    await expect(page.locator('.attachment-chip')).toContainText('1 console error')
    const attachmentsDir = join(project, '.thinkerer', 'attachments')
    const pngs = () => readdirSync(attachmentsDir).filter((n) => n.endsWith('.png'))
    expect(pngs()).toHaveLength(1)
    expect(execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: project, encoding: 'utf8' })).not.toContain('attachments')
    await page.screenshot({ path: join(shots, 'agent-with-preview.png') })
    await page.getByRole('button', { name: 'Remove screenshot' }).click({ timeout: 10_000 })
    await expect(page.locator('.attachment-chip')).toHaveCount(0)
    await expect.poll(() => pngs().length).toBe(0)
    // The phone viewport shows the same page in a phone-sized screen, and the native view follows it.
    await page.getByRole('tab', { name: 'Phone viewport' }).click()
    const screen = page.locator('.agent-preview .preview-screen')
    await expect.poll(async () => {
      const box = (await screen.boundingBox())!
      return (await nativeBounds()).some((b) => Math.abs(b.x - box.x) <= 1 && Math.abs(b.width - box.width) <= 1 && b.width <= 393)
    }).toBe(true)
    await page.screenshot({ path: join(shots, 'agent-mobile.png') })
    await page.getByRole('tab', { name: 'Web browser' }).click()
    await expect.poll(async () => {
      const box = (await frame.boundingBox())!
      return (await nativeBounds()).some((b) => Math.abs(b.x - box.x) <= 1 && Math.abs(b.width - box.width) <= 1)
    }).toBe(true)
    // The preview can be hidden and brought back.
    await page.getByRole('button', { name: 'Preview', pressed: true }).click({ timeout: 10_000 })
    await expect(page.locator('.agent-preview')).toHaveCount(0)
    await expect.poll(async () => (await nativeBounds()).length).toBe(0)
    await page.getByRole('button', { name: 'Preview', pressed: false }).click({ timeout: 10_000 })
    await expect(page.locator('.agent-preview .preview-bar .pill')).toHaveText('Running')
    await page.getByRole('tab', { name: 'Website', exact: true }).click()

    await page.getByRole('button', { name: 'Stop dev server' }).click()
    await expect(page.locator('.preview-bar .pill')).toHaveText('Stopped')

    // Files: uncommitted changes with a diff, no checkpoints yet
    await page.getByRole('tab', { name: 'Files' }).click()
    await page.getByRole('tab', { name: /Uncommitted changes/ }).click()
    await page.getByRole('button', { name: /server\.mjs/ }).click()
    await expect(page.locator('.diff')).toContainText('+import http from')
    await page.screenshot({ path: join(shots, 'files-changes.png') })
    await page.getByRole('tab', { name: /Checkpoints/ }).click()
    await expect(page.locator('.files-panel')).toContainText('No checkpoints yet')
  } finally {
    await app.close()
    rmSync(tmp, { recursive: true, force: true })
  }
})
