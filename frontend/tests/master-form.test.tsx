// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Master, MasterCatalog } from '../src/pages/master'
import { text } from '../src/types'

describe('master data form', () => {
  afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })

  it('blocks an empty required master field before submission', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }))))
    const rootElement = document.createElement('div')
    document.body.append(rootElement)
    const root = createRoot(rootElement)
    await act(async () => { root.render(<Master t={text.en} />); await Promise.resolve() })

    const form = document.querySelector<HTMLFormElement>('.master-catalog form')
    expect(form?.checkValidity()).toBe(false)
    expect(document.querySelectorAll('.admin-toolbar [aria-pressed="true"]')).toHaveLength(1)
    root.unmount()
  })

  it('recovers from master loading and queued-write failures', async () => {
    let rejectOperators: (error: Error) => void = () => undefined
    let operatorRequests = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).endsWith('/operators')) return new Response(JSON.stringify({ items: [] }))
      operatorRequests += 1
      if (operatorRequests === 1) return new Promise<Response>((_resolve, reject) => { rejectOperators = reject })
      return new Response(JSON.stringify({ items: [{ id: 'operator-1', name: 'Operator A' }] }))
    }))
    const rootElement = document.createElement('div')
    document.body.append(rootElement)
    const root = createRoot(rootElement)
    act(() => root.render(<MasterCatalog />))

    expect(document.querySelector('[role="status"]')?.textContent).toContain('Loading')
    await act(async () => { rejectOperators(new Error('Network unavailable')); await Promise.resolve() })
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Network unavailable')

    const retry = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Retry')
    await act(async () => { retry?.click(); await Promise.resolve() })
    expect(document.body.textContent).toContain('Operator A')
    expect(operatorRequests).toBe(2)

    await act(async () => {
      window.dispatchEvent(new CustomEvent('chronofish:queue-rejected', { detail: { path: '/operators/operator-1', lastError: 'Operator changed on the server' } }))
      await Promise.resolve()
    })
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Operator changed on the server')
    expect(operatorRequests).toBe(3)
    root.unmount()
  })
})
