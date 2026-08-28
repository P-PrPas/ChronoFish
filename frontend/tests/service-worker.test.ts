import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { expect, test, vi } from 'vitest'

test('service worker leaves API requests to the network', async () => {
  const source = await readFile(new URL('../dist/sw.js', import.meta.url), 'utf8')
  type FetchEvent = { request: Request; respondWith: (response: unknown) => void }
  let onFetch: ((event: FetchEvent) => void) | undefined
  const self = {
    location: { origin: 'http://localhost' },
    addEventListener(type: string, listener: (event: unknown) => void) {
      if (type === 'fetch') onFetch = listener as (event: FetchEvent) => void
    },
  }

  runInNewContext(source, { self, URL, Response, fetch, caches: {} })
  expect(onFetch).toBeTypeOf('function')
  const respondWith = vi.fn()
  onFetch!({ request: new Request('http://localhost/api/v1/health'), respondWith })
  expect(respondWith).not.toHaveBeenCalled()
})
