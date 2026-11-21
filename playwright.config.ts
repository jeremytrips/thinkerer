import { defineConfig } from '@playwright/test'

// When the tests run from inside a Thinkerer dev session (an agent verifying its
// own work), the shell inherits the running app's dev-server URL. The app under
// test would then load *that* renderer instead of the freshly built one in out/.
delete process.env.ELECTRON_RENDERER_URL
delete process.env.THINKERER_DEV_WRAPPER
// The app under test runs without showing its window (or a Dock icon), so it doesn't steal focus.
// Set THINKERER_BACKGROUND=0 to watch it.
process.env.THINKERER_BACKGROUND ??= '1'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  reporter: 'list'
})
