import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Layout follows THINKERER_MVP_v0.1.md §6: renderer in src/, main + preload in
// electron/, privileged services in engine/ (bundled into main).
export default defineConfig({
  main: {
    build: {
      lib: { entry: resolve(__dirname, 'electron/main/index.ts') }
    }
  },
  preload: {
    build: {
      lib: { entry: resolve(__dirname, 'electron/preload/index.ts') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    // Fixed port so the Thinkerer project config can point its preview at it.
    server: { port: 5173, strictPort: true },
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/index.html') }
    },
    plugins: [react()]
  }
})
