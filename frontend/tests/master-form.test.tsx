// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Master } from '../src/pages/master'
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
    root.unmount()
  })
})
