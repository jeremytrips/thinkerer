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
    }
  }, 120_000)
})
