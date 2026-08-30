// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'
import { drainQueue, putQueue, rejectedQueueCount } from '../src/offline'

describe('browser shell workflows', () => {
  afterEach(() => {
    if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase('chronofish')
    document.body.innerHTML = ''
    localStorage.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    window.location.hash = ''
  })

  it('keeps the lab navigation keyboard reachable and switches language', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { headers: { 'Content-Type': 'application/json' } })))
    const rootElement = document.createElement('div')
    document.body.append(rootElement)
    const root = createRoot(rootElement)
    await act(async () => { root.render(<App />); await Promise.resolve() })
    expect(document.querySelector('nav[aria-label="เมนูหลัก"]')).not.toBeNull()
    expect(document.querySelectorAll('nav button').length).toBe(10)
    expect(Array.from(document.querySelectorAll('button')).every((button) => button.tabIndex >= 0)).toBe(true)
    const language = document.querySelector<HTMLButtonElement>('[aria-label="เปลี่ยนภาษาเป็นอังกฤษ"]')
    expect(language?.textContent).toBe('EN')
    await act(async () => { language?.click(); await Promise.resolve() })
    expect(document.querySelector('nav')?.textContent).toContain('Research results')
    root.unmount()
  })

  it('keeps rejected writes visible until the user reviews or discards them', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDB)
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    localStorage.setItem('chronofish.operator_id', 'operator-a')
    localStorage.setItem('chronofish.device_id', 'device-a')
    await putQueue('/batches', { batchCode: 'REJECTED' })

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'invalid business state' } }),
      { status: 422, headers: { 'Content-Type': 'application/json' } },
    )))
    await drainQueue(true)
    expect(await rejectedQueueCount()).toBe(1)

    const rootElement = document.createElement('div')
    document.body.append(rootElement)
    const root = createRoot(rootElement)
    await act(async () => { root.render(<App />); await new Promise((resolve) => setTimeout(resolve, 0)) })
    const language = document.querySelector<HTMLButtonElement>('[aria-label="เปลี่ยนภาษาเป็นอังกฤษ"]')
    await act(async () => { language?.click(); await Promise.resolve() })

    await vi.waitFor(() => expect(document.querySelector('.queue')?.textContent).toBe('Pending 1'))
    expect(document.body.textContent).toContain('invalid business state')
    const review = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Open related page')
    await act(async () => { review?.click(); await Promise.resolve() })
    expect(document.querySelector('[aria-current="page"]')?.textContent).toBe('Experiments')
    vi.stubGlobal('confirm', vi.fn(() => true))
    const discard = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Discard rejected change')
    await act(async () => { discard?.click(); await Promise.resolve() })
    await vi.waitFor(() => expect(document.querySelector('.queue')?.textContent).toBe('Saved'))
    expect(await rejectedQueueCount()).toBe(0)
    root.unmount()
  })
})
