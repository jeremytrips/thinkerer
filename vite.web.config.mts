import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Renderer-only dev server: Thinkerer's UI in a plain browser (no Electron, no
// preload — it runs in "browser preview" mode). Used as Thinkerer's own
// Website Studio preview and by the agent's Playwright browser. Port 5174 so it
// never collides with the desktop dev instance on 5173.
export default defineConfig({
  root: resolve(import.meta.dirname, 'src'),
  plugins: [react()],
  server: { port: 5174, strictPort: true }
})
