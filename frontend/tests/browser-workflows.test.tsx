// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App, { markInvalidFields } from '../src/App'
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
    expect(document.querySelector('.brand')?.textContent).toBe('KUVTH Zebrafish LIMS')
    expect(document.querySelector('nav[aria-label="เมนูหลัก"]')).not.toBeNull()
    expect(document.querySelectorAll('.nav-group--primary button')).toHaveLength(4)
    expect(document.querySelector('.nav-disclosure--mobile summary')?.textContent).toContain('เพิ่มเติม')
    expect(document.querySelectorAll('.nav-disclosure--mobile button')).toHaveLength(6)
    expect(Array.from(document.querySelectorAll('nav button')).every((button) => button.tabIndex >= 0)).toBe(true)
    expect(document.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1)
    const language = document.querySelector<HTMLButtonElement>('[aria-label="เปลี่ยนภาษาเป็นอังกฤษ"]')
    expect(language?.textContent).toBe('EN')
    await act(async () => { language?.click(); await Promise.resolve() })
    expect(document.querySelector('nav')?.textContent).toContain('Research results')
    root.unmount()
  })

  it('announces route changes and restores focus for history navigation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { headers: { 'Content-Type': 'application/json' } })))
    vi.stubGlobal('scrollTo', vi.fn())
    const rootElement = document.createElement('div')
    document.body.append(rootElement)
    const root = createRoot(rootElement)
    await act(async () => { root.render(<App />); await Promise.resolve() })

    const batches = Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-group--primary button')).find((button) => button.textContent?.trim() === 'การทดลอง')
    await act(async () => { batches?.click(); await new Promise((resolve) => requestAnimationFrame(resolve)) })
    expect(document.title).toBe('การทดลอง · KUVTH Zebrafish LIMS')
    expect(document.activeElement?.id).toBe('main-content')

    await act(async () => {
      window.history.pushState(null, '', `${window.location.pathname}#audit`)
      window.dispatchEvent(new PopStateEvent('popstate'))
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
    expect(document.title).toBe('ตรวจสอบการแก้ไข · KUVTH Zebrafish LIMS')
    expect(document.activeElement?.id).toBe('main-content')
    root.unmount()
  })

  it('marks invalid required fields and links them to the error summary', () => {
    const form = document.createElement('form')
    form.innerHTML = '<label>รหัสสถานที่<input required></label><label>ชื่อสถานที่<input required></label>'
    document.body.append(form)
    const invalid = form.querySelector<HTMLInputElement>('input[required]')
    expect(markInvalidFields(form, 'master', 'th')).toHaveLength(2)
    expect(invalid?.getAttribute('aria-invalid')).toBe('true')
    expect(invalid?.getAttribute('aria-describedby')).toContain(`${invalid?.id}-error`)
    expect(invalid?.parentElement?.getAttribute('data-field-error')).toBe('กรุณากรอกหรือแก้ไขข้อมูลในช่องนี้')
    const secondForm = form.cloneNode(true) as HTMLFormElement
    secondForm.querySelectorAll('input').forEach((input) => { input.removeAttribute('id'); input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby') })
    document.body.append(secondForm)
    const secondErrors = markInvalidFields(secondForm, 'master', 'th')
    expect(secondErrors[0]?.id).not.toBe(invalid?.id)
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
