import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

function hashedShell(): Plugin {
  return {
    name: 'chronofish-hashed-shell',
    async closeBundle() {
      const outDir = resolve(process.cwd(), 'dist')
      const html = await readFile(resolve(outDir, 'index.html'), 'utf8')
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map((match) => match[1])
      const precache = JSON.stringify(['/', '/manifest.webmanifest', ...assets])
      await writeFile(resolve(outDir, 'sw.js'), `const CACHE = 'chronofish-shell-v3'\nconst PRECACHE = ${precache}\nself.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())))\nself.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())))\nself.addEventListener('fetch', (event) => {\n  const url = new URL(event.request.url)\n  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return\n  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => { if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone())); return response }).catch(() => event.request.mode === 'navigate' ? caches.match('/') : new Response('', { status: 503 }))))\n})\n`)
    },
  }
}

export default defineConfig({
  plugins: [react(), hashedShell()],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
})
