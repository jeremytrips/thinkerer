#!/usr/bin/env node
// Development launcher. Runs `electron-vite dev` (renderer hot reload; main and
// preload are NOT auto-restarted, so an agent editing them cannot kill its own
// supervisor mid-run). When the app exits with code 75 — the in-app "Restart"
// action — this loop rebuilds main/preload and relaunches.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const RESTART_CODE = 75
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite')

function launch() {
  const child = spawn(bin, ['dev', ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, THINKERER_DEV_WRAPPER: '1' },
    shell: process.platform === 'win32'
  })
  const forward = (sig) => child.kill(sig)
  process.on('SIGINT', forward)
  process.on('SIGTERM', forward)
  child.on('exit', (code) => {
    process.off('SIGINT', forward)
    process.off('SIGTERM', forward)
    if (code === RESTART_CODE) {
      console.log('\n[thinkerer] Restart requested — rebuilding main/preload and relaunching…\n')
      launch()
    } else {
      process.exit(code ?? 0)
    }
  })
}

launch()
