import { describe, expect, it } from 'vitest'
import * as mobile from '../mcp/mobile-driver.mjs'

// Opt-in: THINKERER_LIVE_MOBILE=1 npm run test:live:mobile
// Uses the emulators/simulators that are already booted; it never boots or shuts anything down.
const live = process.env.THINKERER_LIVE_MOBILE === '1'

describe.skipIf(!live)('mobile driver against real devices', () => {
  it('screenshots every booted device at logical resolution and reads Android UI trees', async () => {
    const booted = (await mobile.listDevices()).filter((d) => d.state === 'booted')
    expect(booted.length, 'boot an emulator or simulator first').toBeGreaterThan(0)
    for (const d of booted) {
      const shot = await mobile.screenshot(d.id, { logical: true })
      expect(shot.mimeType).toBe('image/png')
      expect(shot.pointWidth).toBeGreaterThan(200)
      expect(shot.pointHeight).toBeGreaterThan(shot.pointWidth)
      const live = await mobile.screenshot(d.id, { format: 'jpeg' })
      expect(live.width / live.scale).toBeCloseTo(shot.pointWidth, 0)
      if (d.platform === 'android') {
        const ui = (await mobile.describeUi(d.id)) as { center: { x: number; y: number } }[]
        expect(ui.length).toBeGreaterThan(0)
        for (const e of ui) expect(e.center.x).toBeLessThanOrEqual(shot.pointWidth + 1)
        await mobile.pressKey(d.id, 'home')
      }
      if (d.platform === 'ios' && mobile.toolStatus().ios.input) {
        const ui = (await mobile.describeUi(d.id)) as unknown[]
        expect(ui.length).toBeGreaterThan(0)
        await mobile.pressKey(d.id, 'home')
        await mobile.tap(d.id, shot.pointWidth / 2, shot.pointHeight / 2)
      }
    }
  }, 120_000)
})

describe('idb recovery', () => {
  it('recognises the errors a stale idb companion produces', () => {
    // Observed with idb 1.7.x on Xcode 26 after the companion outlived its simulator session.
    expect(mobile.STALE_IDB.test('idb ui button HOME: Mach port invalid, device disconnected')).toBe(true)
    expect(mobile.STALE_IDB.test("The simulator's accessibility service did not answer a frontmost request within 5.0s")).toBe(true)
    expect(mobile.STALE_IDB.test('idb ui tap: Unknown app com.example')).toBe(false)
  })
})
