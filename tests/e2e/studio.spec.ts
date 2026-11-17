import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
      marketing: { enabled: true }
    })
  )
  execFileSync('git', ['init', '-q'], { cwd: project })

  const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, THINKERER_APP_DATA: join(tmp, 'appdata') } })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
    }, project)
    await page.getByRole('button', { name: 'Import folder…' }).click()
    await expect(page.getByRole('heading', { name: 'Demo site', exact: true })).toBeVisible()

    // Tasks
    await page.getByRole('tab', { name: 'Tasks' }).click()
    await page.getByLabel('Task title').fill('Write the landing page')
    await page.getByRole('button', { name: 'Add task' }).click()
    await expect(page.getByRole('region', { name: 'To do' })).toContainText('Write the landing page')
    await page.getByRole('button', { name: 'Move to In progress' }).click()
    await expect(page.getByRole('region', { name: 'In progress' })).toContainText('Write the landing page')

    // MCP grants
    await page.getByRole('tab', { name: 'MCP' }).click()
    await page.locator('.mcp-server', { hasText: 'Project health' }).getByRole('checkbox').check()
    await page.locator('.mcp-server', { hasText: 'Playwright browser' }).getByRole('checkbox').check()
    await expect(page.locator('table.effective')).toContainText('Project health')
    await expect(page.locator('table.effective tr', { hasText: 'Playwright browser' })).toContainText('✓ included')
    await page.screenshot({ path: join(shots, 'mcp.png') })

    // Website Studio: real dev server + embedded preview
    await page.getByRole('tab', { name: 'Website' }).click()
    await page.getByRole('button', { name: 'Start dev server' }).click()
    await expect(page.locator('.website-head .pill')).toHaveText('Running', { timeout: 20_000 })
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

    await page.getByRole('button', { name: 'Stop dev server' }).click()
    await expect(page.locator('.website-head .pill')).toHaveText('Stopped')

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
