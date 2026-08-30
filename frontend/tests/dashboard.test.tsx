// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Dashboard } from '../src/pages/dashboard'
import { text } from '../src/types'

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const meta = (sampleSize = 3, extra: Record<string, unknown> = {}) => ({ filters: { siteId: 'site-1' }, sampleSize, denominators: { activated: sampleSize }, unknown: {}, missing: {}, ...extra })

describe('analytics dashboard', () => {
  afterEach(() => { document.body.innerHTML = ''; window.history.replaceState(null, '', '/#dashboard'); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('requests one consistent dashboard snapshot with URL filters and exposes data quality', async () => {
    window.history.replaceState(null, '', '/?siteId=site-1&dateFrom=2026-08-20#dashboard')
    const navigate = vi.fn()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.includes('/analytics/dashboard')) return json({
        kpi: { stage1: { nActivated: 3, nReachedShield: 2, nReachedDay1: 2, nPromoted: 1, pctNormal: null, controlComparison: [] }, stage2: { nFish: 1, nAlive: 1, nDead: 0, nFrozen: 0, nDiscarded: 0, nNormal: 1, nAbnormal: 0, meanAgeDaysAlive: 4 }, meta: meta(4, { unknown: { fishSex: 1 }, missing: { latestEmbryoObservation: 1 } }) },
        funnel: { items: [{ stageOrder: 1, stageLabel: '1-cell', alive: 3, riskSet: 3, nDead: 0, pctOfActivated: 1 }], meta: meta() },
        survival: { items: [{ stageOrder: 1, stageLabel: '1-cell', siteId: 'site-1', strain: 'AB', treatmentGroup: 'SCNT', riskSet: 3, alive: 3, surv: 1 }], meta: meta() },
        timingDeviation: { items: [{ stageOrder: 1, stageLabel: '1-cell', n: 3, meanDeviationH: 0, medianDeviationH: 0, q1DeviationH: 0, q3DeviationH: 0, minDeviationH: 0, maxDeviationH: 0 }], meta: meta() },
        abnormalityOnset: { items: [{ stageOrder: 1, stageLabel: '1-cell', count: 1 }], meta: meta() },
        fishSurvival: { items: [{ ageDays: 0, atRisk: 1, alive: 1, surv: 1, condition: 'NORMAL', strain: 'AB', treatmentGroup: 'SCNT' }], meta: meta(1) },
        observationGaps: { items: [], meta: meta(1) },
        pipeline: { items: [{ step: 'Activated', count: 3, pctOfPrevious: 1, pctOfStart: 1 }], meta: meta() },
      })
      return json({ items: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement)
    await act(async () => { root.render(<Dashboard onNavigate={navigate} t={text.en} />); await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)) })

    const analyticsCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('/analytics/'))
    expect(analyticsCalls).toHaveLength(1)
    expect(analyticsCalls.every(([input]) => String(input).includes('siteId=site-1') && String(input).includes('dateFrom=2026-08-20'))).toBe(true)
    expect(document.body.textContent).toContain('(n=3)')
    expect(document.body.textContent).toContain('Data quality')
    expect(document.body.textContent).toContain('Source records')
    expect(document.body.textContent).toContain('Attrition ranking by checkpoint')
    expect(document.querySelector('table caption')).not.toBeNull()
    expect(document.querySelector('[aria-label="Timing deviation from standard in hours"]')).toBeNull()

    const stage1Tab = document.getElementById('dashboard-tab-stage1') as HTMLButtonElement
    await act(async () => { stage1Tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await Promise.resolve() })
    expect(document.getElementById('dashboard-tab-stage2')?.getAttribute('aria-selected')).toBe('true')
    expect(document.getElementById('dashboard-panel-stage2')).not.toBeNull()
    await act(async () => { document.getElementById('dashboard-tab-stage2')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); await Promise.resolve() })

    const openBatches = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Open filtered batches')
    await act(async () => { openBatches?.click(); await Promise.resolve() })
    expect(navigate).toHaveBeenCalledWith('batches')
    expect(window.location.search).toContain('siteId=site-1')
    root.unmount()
  })
})
