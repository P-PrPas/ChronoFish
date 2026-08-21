// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Batches } from '../src/pages/batches'
import { Fish } from '../src/pages/fish'
import { Timing } from '../src/pages/settings'
import { text } from '../src/types'

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })

describe('lab workflow forms', () => {
  afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })

  it('exposes required batch fields and foreign-key selectors', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/batches')) return json({ items: [] })
      if (path.endsWith('/sites')) return json({ items: [{ id: 'site-1', code: 'LAB' }] })
      if (path.endsWith('/treatment-groups')) return json({ items: [{ id: 'treatment-1', code: 'SCNT' }] })
      if (path.endsWith('/recipient-egg-lots')) return json({ items: [] })
      if (path.endsWith('/csof-lots')) return json({ items: [] })
      if (path.endsWith('/donor-cell-lines')) return json({ items: [{ id: 'donor-1', strain: 'AB' }] })
      return json({ items: [] })
    }))
    const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement)
    await act(async () => { root.render(<Batches t={text.en} />); await Promise.resolve() })
    document.querySelector('button.button--primary')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await act(async () => { await Promise.resolve() })
    expect(document.body.textContent).toContain('Recipient egg lot')
    expect(document.body.textContent).toContain('CSOF lot')
    expect(document.body.textContent).toContain('Treatment group')
    root.unmount()
  })

  it('exposes Bangkok roll-call outcomes and registry filters', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.includes('/fish/roll-call')) return json({ items: [{ fishId: 'fish-1', fishCode: 'F-1', status: 'ALIVE', condition: 'NORMAL' }] })
      if (path.endsWith('/fish?includeInactive=true') || path.endsWith('/fish')) return json({ items: [] })
      return json({ items: [] })
    }))
    const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement)
    await act(async () => { root.render(<Fish t={text.en} onPendingChange={() => undefined} />); await Promise.resolve() })
    expect(document.body.textContent).toContain('Bangkok date')
    expect(document.body.textContent).toContain('Frozen')
    const registryTab = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Fish registry')
    await act(async () => { registryTab?.click(); await Promise.resolve() })
    expect(document.body.textContent).toContain('DOB from')
    expect(document.body.textContent).toContain('Treatment')
    root.unmount()
  })

  it('renders editable timing HPA inputs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ entries: [{ id: 'stage-1', stageCode: 'stage_01_1C', stageLabel: '1-cell', stageOrder: 1, expectedHpa: 2.5 }] })))
    const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement)
    await act(async () => { root.render(<Timing />); await Promise.resolve() })
    expect(document.body.textContent).toContain('Protocol')
    expect(document.querySelector('select[required]')).not.toBeNull()
    expect(document.querySelector('input[aria-label="Expected HPA stage_01_1C"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Save new timing version')
    root.unmount()
  })
})
