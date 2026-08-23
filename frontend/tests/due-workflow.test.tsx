// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Due } from '../src/pages/due'
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
  embryos: [
    { embryoId: 'embryo-1', embryoCode: 'B-1_1_1', wellPosition: 'A1', defaultCondition: 'NORMAL', priorOutcome: 'ALIVE' },
    { embryoId: 'embryo-2', embryoCode: 'B-1_1_2', wellPosition: 'A2', defaultCondition: 'ABNORMAL', priorOutcome: 'ALIVE' },
  ],
}

describe('due and checkpoint workflows', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('shows overdue/upcoming time and filters the due queue by site and operator', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.includes('/due-checkpoints')) return json({
        overdue: [dueItem], upcoming: [{ ...dueItem, stageCode: 'stage_04_8C', minutesLate: -10 }],
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
    const site = document.querySelector('[aria-label="Filter due by site"]') as HTMLSelectElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    await act(async () => { setValue?.call(site, 'site-1'); site.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve() })
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('siteId=site-1'))).toBe(true)
    root.unmount()
  })

  it('renders a 96-well checkpoint and only marks remaining alive embryos dead', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.includes('/due-checkpoints')) return json({ overdue: [dueItem], upcoming: [], pendingPromotionCount: 0 })
      if (path.includes('/checkpoints/')) return json(checkpoint)
      return json({ items: [] })
    }))
    const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement)
    await act(async () => { root.render(<Due t={text.en} />); await Promise.resolve() })
    await act(async () => { (document.querySelector('.list-row') as HTMLButtonElement).click(); await Promise.resolve() })

    expect(document.body.textContent).toContain('Survivors 2 / 3')
    expect(document.querySelectorAll('.checkpoint-grid [data-well]')).toHaveLength(96)
    await act(async () => {
      window.dispatchEvent(new CustomEvent('chronofish:queue-drained', { detail: {
        path: '/observations/embryo', body: { observations: [{ embryoId: 'another-lot', stageCode: 'stage_03_4C' }] },
        result: { results: [{ id: 'other-observation', status: 'created', deviationH: 99 }] },
      } }))
      await Promise.resolve()
    })
    expect(document.body.textContent).not.toContain('Official deviation +99.0000 h')
    const first = document.querySelector('button[aria-label="Cycle outcome for B-1_1_1"]') as HTMLButtonElement
    await act(async () => { first.click(); first.click(); await Promise.resolve() })
    const remainingDead = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'All remaining dead')
    await act(async () => { remainingDead?.click(); await Promise.resolve() })
    expect((document.querySelector('button[aria-label="Cycle outcome for B-1_1_1"]') as HTMLButtonElement).textContent).toBe('DEGENERATED')
    expect((document.querySelector('button[aria-label="Cycle outcome for B-1_1_2"]') as HTMLButtonElement).textContent).toBe('DEAD')
    root.unmount()
  })

  it('completes the fifteen-embryo all-alive workflow in three taps within the response budgets', async () => {
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

    const allAlive = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'All alive')
    const responseStartedAt = performance.now()
    await act(async () => { allAlive?.click(); await Promise.resolve() })
    expect(performance.now() - responseStartedAt).toBeLessThan(100)
    await act(async () => { Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Save checkpoint')?.click(); await Promise.resolve() })

    expect((saved as { observations: unknown[] }).observations).toHaveLength(15)
    root.unmount()
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
    const save = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Save checkpoint')
    await act(async () => { save?.click(); await Promise.resolve() })

    expect(document.body.textContent).toContain('observedAt is too far in the future')
    expect(document.body.textContent).toContain('4-cell')
    root.unmount()
  })

  it('uses official save metrics and supports confirmed correction and ten-second undo', async () => {
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
    await act(async () => { Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Save checkpoint')?.click(); await Promise.resolve() })

    expect(document.body.textContent).toContain('Official deviation +0.1333 h')
    expect(document.body.textContent).toContain('Saved by operator-1')
    expect(document.body.textContent).toContain('Backdated')
    const correctionReason = document.querySelector('[aria-label="Correction reason"]') as HTMLInputElement
    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => { setInput?.call(correctionReason, 'wrong status'); correctionReason.dispatchEvent(new Event('input', { bubbles: true })); await Promise.resolve() })
    await act(async () => { Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Save correction')?.click(); await Promise.resolve() })
    await act(async () => { Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Undo last save')?.click(); await Promise.resolve() })
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
    root.unmount()
  })
})
