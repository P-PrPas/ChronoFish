// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Batches } from '../src/pages/batches'
import { Fish } from '../src/pages/fish'
import { Controls, Timing } from '../src/pages/settings'
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

  it('offers activation for copied injection-lot drafts', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/batches')) return json({ items: [{ id: 'batch-1', batchCode: 'B-1', experimentDate: '2026-08-23' }] })
      if (path.endsWith('/batches/batch-1')) return json({ id: 'batch-1', batchCode: 'B-1', experimentDate: '2026-08-23', injectionLots: [{ id: 'lot-1', lotNo: '1', donorCellLineId: 'donor-1', activatedAt: null, nActivated: 0 }] })
      if (path.includes('/injection-lots/lot-1/embryos')) return json({ items: [] })
      if (path.endsWith('/donor-cell-lines')) return json({ items: [{ id: 'donor-1', strain: 'AB' }] })
      return json({ items: [] })
    }))
    const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement)
    await act(async () => { root.render(<Batches t={text.en} />); await Promise.resolve() })
    await act(async () => { (document.querySelector('.list-row') as HTMLButtonElement)?.click(); await Promise.resolve() })
    const activate = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('Activate template'))
    expect(activate).not.toBeUndefined()
    await act(async () => { activate?.click(); await Promise.resolve() })
    expect(document.body.textContent).toContain('Activate injection lot template')
    root.unmount()
  })

  it('shows a 96-well planner, mobile fallback, and confirms before creating a lot', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/batches')) return json({ items: [{ id: 'batch-1', batchCode: 'B-1', experimentDate: '2026-08-23' }] })
      if (path.endsWith('/batches/batch-1')) return json({ id: 'batch-1', batchCode: 'B-1', experimentDate: '2026-08-23', injectionLots: [] })
      if (path.includes('/donor-cell-lines?')) return json({ items: [{ id: 'donor-1', strain: 'AB', active: true }] })
      return json({ items: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement)
    await act(async () => { root.render(<Batches t={text.en} />); await Promise.resolve() })
    await act(async () => { (document.querySelector('.list-row') as HTMLButtonElement)?.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(document.querySelectorAll('.well-grid--plate .well')).toHaveLength(96)
    expect(document.querySelector('.well-list--mobile')).not.toBeNull()
    const lotForm = Array.from(document.querySelectorAll('form')).find((form) => form.textContent?.includes('Injection lot'))
    await act(async () => { lotForm?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })); await Promise.resolve() })
    expect(confirm).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false)
    root.unmount()
  })

  it('resolves inactive master data in historical batch details without offering it for new records', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/batches')) return json({ items: [{ id: 'batch-1', batchCode: 'B-1', experimentDate: '2026-08-23', siteId: 'site-old', operatorId: 'operator-old', treatmentGroupId: 'treatment-old' }] })
      if (path.endsWith('/batches/batch-1')) return json({ id: 'batch-1', batchCode: 'B-1', experimentDate: '2026-08-23', siteId: 'site-old', operatorId: 'operator-old', treatmentGroupId: 'treatment-old', injectionLots: [{ id: 'lot-1', lotNo: '1', donorCellLineId: 'donor-old', activatedAt: '2026-08-23T01:00:00Z', nActivated: 1 }] })
      if (path.includes('/injection-lots/lot-1/embryos')) return json({ items: [] })
      if (path.endsWith('/sites?includeInactive=true')) return json({ items: [{ id: 'site-old', code: 'OLD', name: 'Archived Lab', active: false }] })
      if (path.endsWith('/operators?includeInactive=true')) return json({ items: [{ id: 'operator-old', name: 'Archived Operator', active: false }] })
      if (path.endsWith('/treatment-groups?includeInactive=true')) return json({ items: [{ id: 'treatment-old', code: 'OLD-TX', name: 'Archived Treatment', active: false }] })
      if (path.endsWith('/donor-cell-lines?includeInactive=true')) return json({ items: [{ id: 'donor-old', strain: 'Archived Donor', active: false }] })
      return json({ items: [] })
    }))
    const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement)
    await act(async () => { root.render(<Batches t={text.en} />); await Promise.resolve() })
    await act(async () => { (document.querySelector('.list-row') as HTMLButtonElement)?.click(); await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(document.body.textContent).toContain('Archived Lab')
    expect(document.body.textContent).toContain('Archived Operator')
    expect(document.body.textContent).toContain('Archived Treatment')
    expect(document.body.textContent).toContain('Archived Donor')
    expect(Array.from(document.querySelectorAll('option')).some((option) => option.textContent === 'Archived Donor')).toBe(false)
    root.unmount()
  })

  it('edits the complete mutable batch record through the shared batch form', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      const batch = { id: 'batch-1', batchCode: 'B-1', dayNo: 2, experimentDate: '2026-08-23', siteId: 'site-1', operatorId: 'operator-1', protocolId: 'protocol-1', treatmentGroupId: 'treatment-1', recipientEggLotId: 'egg-1', csofLotId: 'csof-1', clutchCode: 'C-1', replicateNo: 2, incubationTempC: 28.5, notes: 'baseline' }
      if (path.endsWith('/batches')) return json({ items: [batch] })
      if (path.endsWith('/batches/batch-1')) return json({ ...batch, injectionLots: [] })
      if (path.includes('/sites')) return json({ items: [{ id: 'site-1', code: 'LAB' }] })
      if (path.includes('/operators')) return json({ items: [{ id: 'operator-1', name: 'Tech' }] })
      if (path.includes('/protocols')) return json({ items: [{ id: 'protocol-1', name: 'SCNT' }] })
      if (path.includes('/treatment-groups')) return json({ items: [{ id: 'treatment-1', code: 'SCNT' }] })
      if (path.includes('/recipient-egg-lots')) return json({ items: [{ id: 'egg-1', lotCode: 'EGG-1' }] })
      if (path.includes('/csof-lots')) return json({ items: [{ id: 'csof-1', lotCode: 'CSOF-1' }] })
      if (path.includes('/donor-cell-lines')) return json({ items: [] })
      return json({ items: [] })
    }))
    const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement)
    await act(async () => { root.render(<Batches t={text.en} />); await Promise.resolve() })
    await act(async () => { (document.querySelector('.list-row') as HTMLButtonElement)?.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    const edit = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Edit batch')
    await act(async () => { edit?.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect((document.querySelector('[data-testid="batch-day-no"]') as HTMLInputElement).value).toBe('2')
    expect(document.body.textContent).toContain('Recipient egg lot')
    expect(document.body.textContent).toContain('Incubation')
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
    await act(async () => { root.render(<Fish t={text.en} />); await Promise.resolve() })
    expect(document.body.textContent).toContain('Bangkok date')
    expect(document.body.textContent).toContain('Frozen')
    const registryTab = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Fish registry')
    await act(async () => { registryTab?.click(); await Promise.resolve() })
    expect(document.body.textContent).toContain('DOB from')
    expect(document.body.textContent).toContain('Treatment')
    root.unmount()
  })

  it('shows timing version history, old/new values, and confirms a new version', async () => {
    const current = { id: 'profile-2', version: 2, name: 'Current profile', isCurrent: true, createdAt: '2026-08-23T01:00:00Z', createdByOperatorId: 'operator-1', entries: [{ id: 'stage-1', stageCode: 'stage_01_1C', stageLabel: 'Activated (1-cell)', stageOrder: 1, expectedHpa: 2.5 }] }
    const archived = { id: 'profile-1', version: 1, name: 'Archived profile', isCurrent: false, createdAt: '2026-08-22T01:00:00Z', createdByOperatorId: 'operator-2', entries: current.entries }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/protocols')) return json({ items: [{ id: 'protocol-1', name: 'Zebrafish SCNT' }] })
      if (path.includes('/operators?')) return json({ items: [{ id: 'operator-1', name: 'Tech One' }, { id: 'operator-2', name: 'Tech Two' }] })
      if (path.includes('/timing-profiles/current')) return json(current)
      if (path.includes('/timing-profiles?')) return json({ items: [current, archived] })
      return json({})
    })
    vi.stubGlobal('fetch', fetchMock)
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement)
    await act(async () => { root.render(<Timing />); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(document.body.textContent).toContain('Protocol')
    expect(document.querySelector('select[required]')).not.toBeNull()
    expect(document.querySelector('input[aria-label="Expected HPA stage_01_1C"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Current version 2')
    expect(document.body.textContent).toContain('Archived profile')
    expect(document.body.textContent).toContain('Tech One')
    expect(document.body.textContent).toContain('Current HPA')
    expect(document.body.textContent).toContain('New HPA')

    const input = document.querySelector('input[aria-label="Expected HPA stage_01_1C"]') as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => { setValue?.call(input, '2.75'); input.dispatchEvent(new Event('input', { bubbles: true })); await Promise.resolve() })
    await act(async () => { document.querySelector('form')?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })); await Promise.resolve() })
    expect(confirm).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false)
    root.unmount()
  })

  it('previews timing CSV rows before importing them', async () => {
    const current = { id: 'profile-1', version: 1, name: 'Current profile', isCurrent: true, entries: [
      { id: 'stage-1', stageCode: 'stage_01_1C', stageLabel: 'Activated (1-cell)', stageOrder: 1, expectedHpa: 0 },
      { id: 'stage-2', stageCode: 'stage_02_2C', stageLabel: '2-cell', stageOrder: 2, expectedHpa: 0.75 },
    ] }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/protocols')) return json({ items: [{ id: 'protocol-1', name: 'Zebrafish SCNT' }] })
      if (path.includes('/timing-profiles/current')) return json(current)
      if (path.includes('/timing-profiles?')) return json({ items: [current] })
      return json({})
    })
    vi.stubGlobal('fetch', fetchMock)
    const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement)
    await act(async () => { root.render(<Timing />); await new Promise((resolve) => setTimeout(resolve, 0)) })

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File([
      'stage_order,stage_code,label,expected_hpa\n1,stage_01_1C,Activated (1-cell),0\n2,stage_02_2C,2-cell,0.8\n',
    ], 'timing.csv', { type: 'text/csv' })
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] })
    await act(async () => { fileInput.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(document.body.textContent).toContain('CSV preview')
    expect(document.body.textContent).toContain('2 rows ready')
    expect(document.body.textContent).toContain('Import preview')
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false)

    const invalidFile = new File([
      'stage_order,stage_code,label,expected_hpa\n1,stage_01_1C,Activated (1-cell),0\n1,stage_01_1C,Activated (1-cell),1\n',
    ], 'invalid.csv', { type: 'text/csv' })
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [invalidFile] })
    await act(async () => { fileInput.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(document.body.textContent).toContain('duplicate stage')
    expect(Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('Import preview'))?.disabled).toBe(true)
    root.unmount()
  })

  it('loads existing control rows and shows their totals', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/batches')) return json({ items: [{ id: 'batch-1', batchCode: 'B-1', protocolId: 'protocol-1' }] })
      if (path.endsWith('/protocols')) return json({ items: [{ id: 'protocol-1', name: 'SCNT' }] })
      if (path.includes('/protocols/protocol-1/stages')) return json({ items: [{ code: 'stage_19_SH', label: 'Shield' }] })
      if (path.includes('/batches/batch-1/control-arm-counts')) return json({ items: [{ armType: 'IVF', stageCode: 'stage_19_SH', nNormal: 4, nAbnormal: 2 }] })
      return json({ items: [] })
    }))
    const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement)
    await act(async () => { root.render(<Controls t={text.en} />); await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(Array.from(document.querySelectorAll('.metric')).map((item) => item.textContent)).toEqual([
      'Normal total4', 'Abnormal total2', 'Grand total6',
    ])
    expect((document.querySelector('input[type="number"]') as HTMLInputElement).value).toBe('4')
    root.unmount()
  })
})
