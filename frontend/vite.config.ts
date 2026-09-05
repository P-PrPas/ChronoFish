import { defineConfig } from "vitest/config"
import react from '@vitejs/plugin-react'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { serviceWorkerSource } from './src/service-worker'

function hashedShell(): Plugin {
  return {
    name: 'kuvth-zebrafish-lims-hashed-shell',
    async closeBundle() {
      const outDir = resolve(process.cwd(), 'dist')
      const html = await readFile(resolve(outDir, 'index.html'), 'utf8')
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map((match) => match[1])
      await writeFile(resolve(outDir, 'sw.js'), serviceWorkerSource(['/', '/manifest.webmanifest', ...assets]))
    },
  }
}

export default defineConfig({
  plugins: [react(), hashedShell()],
  test: {
    environment: "happy-dom",
    globals: false,
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/api/schema.d.ts", "src/main.tsx", "src/vite-env.d.ts"],
      thresholds: { lines: 85, branches: 78 },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
})
