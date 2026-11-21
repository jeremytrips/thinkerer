import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

// The software protocol in the app, with the stand-in agent: the first message is
// planned read-only, then implement (Thinkerer runs the checks), an independent
// review, and ship (merge + report). Cleanup stays a manual /cleanup.

const root = resolve(__dirname, '..', '..')
const shots = process.env.THINKERER_SCREENSHOTS ?? join(root, 'test-results')
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', ...args], { cwd, encoding: 'utf8' }).trim()

test('a protocol chat goes plan → implement (approved by reply) + checks → review → ship', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'thinkerer-protocol-')))
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
      worktrees: { setupCommand: '', teardownCommand: '', ports: 0 },
      protocol: { checkCommand: 'test -f made.txt && echo checks-ok', maxReviewRounds: 2 },
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
      // Approves the check command when Thinkerer asks.
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
    }, project)
    await page.getByRole('button', { name: 'Import folder…' }).click()
    await page.getByRole('tab', { name: 'Agent' }).click()
    await page.getByRole('button', { name: 'Preview' }).click()

    await expect(page.getByLabel('Chat type')).toHaveValue('feature')
    await expect(page.getByLabel('Mode for the next message')).toHaveCount(0)
    const composer = page.getByRole('textbox', { name: 'Message to the agent' })
    await composer.fill('Add a file')
    await expect(page.getByRole('button', { name: 'Plan', exact: true })).toBeVisible()
    await composer.press('Enter')

    // 1. Plan (read-only: nothing written in the worktree yet).
    const bar = page.getByRole('region', { name: 'Protocol steps' })
    await expect(bar.locator('[aria-current="step"]')).toHaveText('Plan')
    await expect(bar.getByRole('button', { name: 'Approve plan & implement' })).toBeVisible()
    // A reply that asks for changes keeps planning; one that plainly approves says it will implement.
    await composer.fill('ok, but drop step 3')
    await expect(page.getByRole('button', { name: 'Plan', exact: true })).toBeVisible()
    await composer.fill('ok implement')
    await expect(page.getByRole('button', { name: 'Approve & implement' })).toBeVisible()
    await expect(page.getByText('This approves the plan: the agent starts implementing (not read-only).')).toBeVisible()
    await page.screenshot({ path: join(shots, 'protocol-approve-reply.png') })
    await composer.press('Enter')

    // 2. Implement; then Thinkerer runs the approved checks itself.
    await expect(page.getByRole('article', { name: 'Checks: Checks passed' })).toBeVisible()
    await expect(bar.locator('[aria-current="step"]')).toHaveText('Implement + tests')
    await expect(bar).toContainText('Checks passed.')
    // No merge before the review: Ship does it.
    await composer.fill('/merge')
    await composer.press('Enter')
    await expect(page.getByRole('article', { name: '/merge: Not merged: this chat follows the software protocol (stage: implement)' })).toBeVisible()
    await bar.getByRole('button', { name: 'Start review' }).click()

    // 3. Review in a fresh session; the stand-in reports one finding.
    await expect(bar.getByRole('button', { name: 'Fix findings' })).toBeVisible()
    await expect(bar.locator('[aria-current="step"]')).toContainText('Review')
    await expect(bar).toContainText('round 1/2')
    const review = page.getByRole('article', { name: /^Message: \/code-review medium thinkerer\// })
    await expect(review).toContainText('[high] made.txt:1: example finding; fix it')
    await expect(review).toContainText('Fresh session')
    await page.screenshot({ path: join(shots, 'protocol-review.png') })

    // 4. Ship: merged into main, with the report.
    await bar.getByRole('button', { name: 'Ship to main' }).click()
    const report = page.getByRole('article', { name: 'Protocol: Shipped: protocol report' })
    await expect(report).toBeVisible()
    await expect(report).toContainText('Review round 1: 1 finding')
    await expect(report).toContainText('Last findings (not addressed before shipping):')
    await expect(page.getByRole('article', { name: '/merge: Merged into main' })).toBeVisible()
    await expect(bar).toContainText('Shipped. Type /cleanup')
    expect(readFileSync(join(project, 'made.txt'), 'utf8')).toContain('The plan is approved')
    await page.screenshot({ path: join(shots, 'protocol-shipped.png') })

    // Cleanup stays manual.
    await composer.fill('/cleanup')
    await composer.press('Enter')
    await expect(page.getByRole('article', { name: '/cleanup: Cleaned up — chat done' })).toBeVisible()
  } finally {
    await app.close()
    rmSync(tmp, { recursive: true, force: true })
  }
})
