// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Due, nextCheckpoints } from '../src/pages/due'
import { text } from '../src/types'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
})

const dueItem = {
  injectionLotId: 'lot-1', batchCode: 'B-1', lotNo: '1', stageCode: 'stage_03_4C',
  stageLabel: '4-cell', stageOrder: 3, dueAt: '2026-08-23T01:00:00Z', minutesLate: 25,
  embryosRemaining: 2,
}

const checkpoint = {
  injectionLotId: 'lot-1', batchCode: 'B-1', lotNo: '1',
  stage: { code: 'stage_03_4C', label: '4-cell', stageOrder: 3 },
  activatedAt: '2026-08-23T00:00:00Z', expectedHpa: 1, totalEmbryos: 3, embryosRemaining: 2,
  stages: [
    { stageCode: 'stage_02_2C', stageLabel: '2-cell', stageOrder: 2, expectedHpa: 0.75 },
    { stageCode: 'stage_03_4C', stageLabel: '4-cell', stageOrder: 3, expectedHpa: 1 },
    { stageCode: 'stage_04_8C', stageLabel: '8-cell', stageOrder: 4, expectedHpa: 1.25 },
  ],
  embryos: [
    { embryoId: 'embryo-1', embryoCode: 'B-1_1_1', wellPosition: 'A1', defaultCondition: 'NORMAL', priorOutcome: 'ALIVE', priorStageCode: 'stage_02_2C' },
    { embryoId: 'embryo-2', embryoCode: 'B-1_1_2', wellPosition: 'A2', defaultCondition: 'ABNORMAL', priorOutcome: 'ALIVE' },
  ],
}

describe('due and checkpoint workflows', () => {
  beforeEach(() => sessionStorage.setItem('chronofish.operator_id', 'operator-1'))
  afterEach(() => {
    document.body.innerHTML = ''
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('shows only the next checkpoint for each injection lot', () => {
    expect(nextCheckpoints([
      dueItem,
      { ...dueItem, stageCode: 'stage_04_8C', stageOrder: 4, minutesLate: 10 },
      { ...dueItem, injectionLotId: 'lot-2', stageCode: 'stage_02_2C', minutesLate: -5 },
    ])).toEqual([
      expect.objectContaining({ injectionLotId: 'lot-1', stageCode: 'stage_03_4C', pendingStages: 2 }),
      expect.objectContaining({ injectionLotId: 'lot-2', pendingStages: 0 }),
    ])
  })

  it('shows overdue/upcoming time and filters the due queue by site and operator', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.includes('/due-checkpoints')) return json({
        overdue: [dueItem], upcoming: [{ ...dueItem, injectionLotId: 'lot-2', stageCode: 'stage_04_8C', minutesLate: -10 }],
        pendingPromotionCount: 0,
      })
      if (path.endsWith('/sites')) return json({ items: [{ id: 'site-1', code: 'LAB' }] })
      if (path.endsWith('/operators')) return json({ items: [{ id: 'operator-1', name: 'Tech One' }] })
      return json({ items: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement)
    await act(async () => { root.render(<Due t={text.en} />); await Promise.resolve() })

    expect(document.body.textContent).toContain('Late 25 min')
    expect(document.body.textContent).toContain('Due in 10 min')
    const site = Array.from(document.querySelectorAll('label')).find((label) => label.textContent?.startsWith('Site'))?.querySelector('select') as HTMLSelectElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    await act(async () => { setValue?.call(site, 'site-1'); site.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve() })
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('siteId=site-1'))).toBe(true)
    root.unmount()
  })

  it('renders a compact plate map with one selected-well editor', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.includes('/due-checkpoints')) return json({ overdue: [dueItem], upcoming: [], pendingPromotionCount: 0 })
      if (path.includes('/checkpoints/')) return json(checkpoint)
      return json({ items: [] })
    }))
    const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement)
    await act(async () => { root.render(<Due t={text.en} />); await Promise.resolve() })
    await act(async () => { (document.querySelector('.list-row') as HTMLButtonElement).click(); await Promise.resolve() })

    expect(document.body.textContent).toContain('Plate map · 0 / 2 selected')
    expect(document.body.textContent).toContain('Previous: 2-cell')
    expect(document.body.textContent).not.toContain('stage_02_2C')
    expect(document.querySelectorAll('.checkpoint-grid [data-well]')).toHaveLength(2)
    expect(document.querySelectorAll('.checkpoint-grid select')).toHaveLength(0)
    expect(document.querySelectorAll('.checkpoint-editor [aria-label^="Stage for well"]')).toHaveLength(1)
    await act(async () => {
      window.dispatchEvent(new CustomEvent('chronofish:queue-drained', { detail: {
        path: '/observations/embryo', body: { observations: [{ embryoId: 'another-lot', stageCode: 'stage_03_4C' }] },
        result: { results: [{ id: 'other-observation', status: 'created', deviationH: 99 }] },
      } }))
      await Promise.resolve()
    })
    expect(document.body.textContent).not.toContain('Saved by')
    expect(document.querySelectorAll('.checkpoint-editor [aria-label^="Stage for well"]')).toHaveLength(1)
    expect(document.querySelectorAll('.checkpoint-editor [aria-label^="Outcome for well"]')).toHaveLength(1)
    expect(Array.from(document.querySelectorAll('.checkpoint-editor [aria-label^="Outcome for well"] option')).map((option) => option.textContent)).toContain('Not observed')
    root.unmount()
  })

  it('opens the first physical well when the checkpoint API order is unsorted', async () => {
    const unsortedCheckpoint = { ...checkpoint, embryos: [...checkpoint.embryos].reverse() }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.includes('/due-checkpoints')) return json({ overdue: [dueItem], upcoming: [], pendingPromotionCount: 0 })
      if (path.includes('/checkpoints/')) return json(unsortedCheckpoint)
      return json({ items: [] })
    }))
    const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement)
    await act(async () => { root.render(<Due t={text.en} />); await Promise.resolve() })
    await act(async () => { (document.querySelector('.list-row') as HTMLButtonElement).click(); await Promise.resolve() })

    expect(document.querySelector('#checkpoint-editor-heading')?.textContent).toBe('A1')
    expect(document.querySelector('[data-well="A1"]')?.getAttribute('aria-pressed')).toBe('true')
    root.unmount()
  })

  it('counts an abnormal default as unreviewed until its stage is selected while keeping it in exceptions', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.includes('/due-checkpoints')) return json({ overdue: [dueItem], upcoming: [], pendingPromotionCount: 0 })
      if (path.includes('/checkpoints/')) return json(checkpoint)
      return json({ items: [] })
    }))
    const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement)
    await act(async () => { root.render(<Due t={text.en} />); await Promise.resolve() })
    await act(async () => { (document.querySelector('.list-row') as HTMLButtonElement).click(); await Promise.resolve() })

    const metrics = Array.from(document.querySelectorAll('.checkpoint-metrics > div')).map((metric) => metric.textContent ?? '')
    expect(metrics[1]).toContain('2')
    expect(metrics[2]).toContain('1')
    const filter = document.querySelector('#well-filter') as HTMLSelectElement
    const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    await act(async () => { setSelect?.call(filter, 'exception'); filter.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve() })
    expect(document.querySelectorAll('.checkpoint-grid [data-well]')).toHaveLength(1)
    expect(document.querySelector('.checkpoint-grid [data-well]')?.getAttribute('data-well')).toBe('A2')
    root.unmount()
  })

  it('applies one stage to a same-stage round before confirming all embryos', async () => {
    const embryos = Array.from({ length: 15 }, (_, index) => ({
      embryoId: `embryo-${index + 1}`, embryoCode: `B-1_1_${index + 1}`,
      wellPosition: `A${index + 1}`, defaultCondition: 'NORMAL', priorOutcome: 'ALIVE',
    }))
    let saved: unknown
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.includes('/due-checkpoints')) return json({ overdue: [dueItem], upcoming: [], pendingPromotionCount: 0 })
      if (path.includes('/checkpoints/')) return json({ ...checkpoint, totalEmbryos: 15, embryosRemaining: 15, embryos })
      if (init?.method === 'POST') {
        saved = JSON.parse(String(init.body))
        return json({ results: embryos.map((_, index) => ({
          id: `obs-${index + 1}`, status: 'created', hpaActual: 1, hpaExpected: 1,
          deviationH: 0, deviationLabel: 'ตรงกับสากล',
        })) })
      }
      return json({ items: [] })
    }))
    const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement)
    await act(async () => { root.render(<Due t={text.en} />); await Promise.resolve() })
    const openedAt = performance.now()
    await act(async () => { (document.querySelector('.list-row') as HTMLButtonElement).click(); await Promise.resolve() })
    expect(performance.now() - openedAt).toBeLessThan(1_000)

    const bulkStage = document.querySelector('#bulk-stage') as HTMLSelectElement
    const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    await act(async () => { setSelect?.call(bulkStage, 'stage_03_4C'); bulkStage.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve() })
    await act(async () => { Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Apply to 15 blank')?.click(); await Promise.resolve() })
    expect(document.body.textContent).toContain('Stage applied to 15 blank embryos')
    await act(async () => { Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Undo bulk stage')?.click(); await Promise.resolve() })
    expect(document.body.textContent).toContain('Apply to 15 blank')
    await act(async () => { Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Apply to 15 blank')?.click(); await Promise.resolve() })
    await act(async () => { Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Confirm 15 observations')?.click(); await Promise.resolve() })

    expect((saved as { observations: unknown[] }).observations).toHaveLength(15)
    root.unmount()
  })

  it('records only selected embryos with independent stages and timestamps the confirmation', async () => {
    let saved: { observations: Array<{ embryoId: string; stageCode: string; observedAt: string }> } | undefined
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-23T02:00:00Z'))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.includes('/due-checkpoints')) return json({ overdue: [dueItem], upcoming: [], pendingPromotionCount: 0 })
      if (path.includes('/checkpoints/')) return json(checkpoint)
      if (init?.method === 'POST') {
        saved = JSON.parse(String(init.body))
        return json({ results: [{ id: 'obs-1', status: 'created' }] })
      }
      return json({ items: [] })
    }))
    const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement)
    await act(async () => { root.render(<Due t={text.en} />); await Promise.resolve() })
    await act(async () => { (document.querySelector('.list-row') as HTMLButtonElement).click(); await Promise.resolve() })

    const stageSelect = document.querySelector<HTMLSelectElement>('#active-stage')
    expect(stageSelect).not.toBeNull()
    const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    await act(async () => {
      setSelect?.call(stageSelect, 'stage_04_8C')
      stageSelect?.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    vi.setSystemTime(new Date('2026-08-23T02:05:00Z'))
    await act(async () => { Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('Confirm 1'))?.click(); await Promise.resolve() })

    expect(saved?.observations).toEqual([
      expect.objectContaining({ embryoId: 'embryo-1', stageCode: 'stage_04_8C', observedAt: '2026-08-23T02:05:00.000Z' }),
    ])
    root.unmount()
    vi.useRealTimers()
  })

  it('keeps the checkpoint open and reports every rejected save row', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.includes('/due-checkpoints')) return json({ overdue: [dueItem], upcoming: [], pendingPromotionCount: 0 })
      if (path.includes('/checkpoints/')) return json(checkpoint)
      if (init?.method === 'POST') return json({ results: [
        { id: 'obs-1', clientUuid: 'client-1', status: 'created', hpaActual: 1.1, hpaExpected: 1, deviationH: 0.1, deviationLabel: 'ช้ากว่าสากล 6 นาที' },
        { clientUuid: 'client-2', status: 'rejected', error: { message: 'observedAt is too far in the future' } },
      ] })
      return json({ items: [] })
    }))
    const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement)
    await act(async () => { root.render(<Due t={text.en} />); await Promise.resolve() })
    await act(async () => { (document.querySelector('.list-row') as HTMLButtonElement).click(); await Promise.resolve() })
    const bulkStage = document.querySelector('#bulk-stage') as HTMLSelectElement
    const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    await act(async () => { setSelect?.call(bulkStage, 'stage_03_4C'); bulkStage.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve() })
    await act(async () => { Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Apply to 2 blank')?.click(); await Promise.resolve() })
    await act(async () => { Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Confirm 2 observations')?.click(); await Promise.resolve() })

    expect(document.body.textContent).toContain('observedAt is too far in the future')
    expect(document.body.textContent).toContain('4-cell')
    root.unmount()
  })

  it('captures confirm time and supports confirmed correction and ten-second undo', async () => {
    sessionStorage.setItem('chronofish.operator_id', 'operator-1')
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.includes('/due-checkpoints')) return json({ overdue: [dueItem], upcoming: [], pendingPromotionCount: 0 })
      if (path.includes('/checkpoints/')) return json({ ...checkpoint, totalEmbryos: 1, embryosRemaining: 1, embryos: [checkpoint.embryos[0]] })
      if (init?.method === 'POST') return json({ results: [
        { id: 'obs-1', clientUuid: 'client-1', status: 'created', hpaActual: 2.6333, hpaExpected: 2.5, deviationH: 0.1333, deviationLabel: 'ช้ากว่าสากล 8 นาที', isBackdated: true },
      ] })
      if (init?.method === 'PATCH') return json({ id: 'obs-1', outcome: 'DEAD', condition: 'NORMAL' })
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      return json({ items: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('confirm', vi.fn(() => true))
    const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement)
    await act(async () => { root.render(<Due t={text.en} />); await Promise.resolve() })
    await act(async () => { (document.querySelector('.list-row') as HTMLButtonElement).click(); await Promise.resolve() })
    const stage = document.querySelector('#active-stage') as HTMLSelectElement
    const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    await act(async () => { setSelect?.call(stage, 'stage_03_4C'); stage.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve() })
    await act(async () => { Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Confirm 1 observations')?.click(); await Promise.resolve() })

    expect(document.body.textContent).toContain('Saved by Operator unavailable')
    expect(document.body.textContent).toContain('Observation time is captured automatically')
    const correctionReason = Array.from(document.querySelectorAll('label')).find((label) => label.textContent?.startsWith('Correction reason'))?.querySelector('input') as HTMLInputElement
    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => { setInput?.call(correctionReason, 'wrong status'); correctionReason.dispatchEvent(new Event('input', { bubbles: true })); await Promise.resolve() })
    await act(async () => { Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Save correction')?.click(); await Promise.resolve() })
    await act(async () => { Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Undo last save')?.click(); await Promise.resolve() })
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
    root.unmount()
  })
})
