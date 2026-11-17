#!/usr/bin/env node
// Starts Playwright MCP with the run's artifacts folder as its working
// directory and workspace root, so screenshots (named or not) land there and
// never in the project tree. Usage: playwright-launch.mjs <artifactsDir> [playwright-mcp args…]
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const [outDir, ...args] = process.argv.slice(2)
if (!outDir) {
  console.error('usage: playwright-launch.mjs <artifactsDir> [args…]')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })
process.chdir(outDir)
const cli = fileURLToPath(new URL('../node_modules/@playwright/mcp/cli.js', import.meta.url))
process.argv = [process.argv[0], cli, ...args]
await import(cli)
