// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'

describe('browser shell workflows', () => {
  afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); window.location.hash = '' })

  it('keeps the lab navigation keyboard reachable and switches language', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { headers: { 'Content-Type': 'application/json' } })))
    const rootElement = document.createElement('div')
    document.body.append(rootElement)
    const root = createRoot(rootElement)
    await act(async () => { root.render(<App />); await Promise.resolve() })
    expect(document.querySelector('nav[aria-label="Main navigation"]')).not.toBeNull()
    expect(document.querySelectorAll('nav button').length).toBe(10)
    expect(Array.from(document.querySelectorAll('button')).every((button) => button.tabIndex >= 0)).toBe(true)
    const language = Array.from(document.querySelectorAll('button')).find((button) => button.getAttribute('aria-label') === 'Switch language')
    expect(language?.textContent).toBe('EN')
    await act(async () => { language?.click(); await Promise.resolve() })
    expect(document.querySelector('nav')?.textContent).toContain('Dashboard')
    root.unmount()
  })
})
