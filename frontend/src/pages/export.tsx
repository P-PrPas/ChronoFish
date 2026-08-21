import { useEffect, useState } from 'react'
import { type ApiItem, get, request } from '../api/client'
import { type DashboardFilters, parseFilters, updateFilterURL, withFilters } from '../filters'
import { ErrorMessage, Metric, ReportPanel, ReportTable } from '../components'
import { DeviationChart, FilterBar, FunnelChart, SurvivalChart } from './dashboard'

type PrintableReport = {
  kpi: ApiItem | null
  funnel: ApiItem[]
  survival: ApiItem[]
  deviation: ApiItem[]
  abnormality: ApiItem[]
  fishSurvival: ApiItem[]
  gaps: ApiItem[]
  pipeline: ApiItem[]
  loading: boolean
  error: string
}

export function Export() {
  const [filters, setFilters] = useState<DashboardFilters>(() => parseFilters())
  const [message, setMessage] = useState('')
  useEffect(() => {
    const onPop = () => setFilters(parseFilters())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const download = async () => {
    try {
      const response = await request('/exports/excel', { method: 'POST', body: JSON.stringify({ locale: 'th', filters }) })
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url; link.download = 'chronofish-export.xlsx'; link.click(); URL.revokeObjectURL(url)
    } catch (e) { setMessage((e as Error).message) }
  }
  return <>
    <section className="export-controls"><div className="page-heading"><div><p className="eyebrow">SCR-17 / 14 SHEETS</p><h1>Export</h1><p className="muted">The workbook and printable report use the same URL filters.</p></div></div><FilterBar filters={filters} onChange={(next) => { setFilters(next); updateFilterURL(next) }} /><div className="action-grid"><button className="action-card" onClick={download}><span className="action-icon">↓</span><strong>Download Excel</strong><span>14 flat sheets with raw n and R analysis shape.</span></button><button className="action-card" onClick={() => window.print()}><span className="action-icon">▣</span><strong>Print / PDF</strong><span>Print all analytical panels, not only the export controls.</span></button></div>{message && <ErrorMessage message={message} />}</section>
    <PrintableDashboard filters={filters} />
  </>
}

export function PrintableDashboard({ filters }: { filters: DashboardFilters }) {
  const [report, setReport] = useState<PrintableReport>({ kpi: null, funnel: [], survival: [], deviation: [], abnormality: [], fishSurvival: [], gaps: [], pipeline: [], loading: true, error: '' })
  useEffect(() => {
    let cancelled = false
    setReport((current) => ({ ...current, loading: true, error: '' }))
    void Promise.all([
      get(withFilters('/analytics/kpi', filters)), get(withFilters('/analytics/funnel', filters)), get(withFilters('/analytics/survival', filters)),
      get(withFilters('/analytics/timing-deviation', filters)), get(withFilters('/analytics/abnormality-onset', filters)),
      get(withFilters('/analytics/fish-survival?splitByCondition=true', filters)), get(withFilters('/analytics/observation-gaps', filters)), get(withFilters('/analytics/pipeline', filters)),
    ]).then(([kpi, funnel, survival, deviation, abnormality, fishSurvival, gaps, pipeline]) => {
      if (!cancelled) setReport({ kpi, funnel: funnel.items ?? [], survival: survival.items ?? [], deviation: deviation.items ?? [], abnormality: abnormality.items ?? [], fishSurvival: fishSurvival.items ?? [], gaps: gaps.items ?? [], pipeline: pipeline.items ?? [], loading: false, error: '' })
    }).catch((error: Error) => { if (!cancelled) setReport((current) => ({ ...current, loading: false, error: error.message })) })
    return () => { cancelled = true }
  }, [filters])
  const stage1 = report.kpi?.stage1 as ApiItem | undefined
  const stage2 = report.kpi?.stage2 as ApiItem | undefined
  const comparison = (stage1?.controlComparison as ApiItem[] | undefined) ?? []
  return <section className="print-report" aria-labelledby="print-report-title"><div className="print-report__header"><p className="eyebrow">CHRONOFISH / DASHBOARD SUMMARY</p><h1 id="print-report-title">Experiment dashboard report</h1><p className="muted">Generated from the same filtered analytical dataset as the dashboard and workbook.</p></div>{report.loading && <p className="notice">Loading dashboard panels...</p>}{report.error && <ErrorMessage message={report.error} />}{!report.loading && !report.error && <>
    <div className="metric-grid"><Metric label="Activated embryos" value={Number(stage1?.nActivated ?? 0)} /><Metric label="Promoted fish" value={Number(stage1?.nPromoted ?? 0)} /><Metric label="Alive fish" value={Number(stage2?.nAlive ?? 0)} /><Metric label="Batches" value={Number(stage1?.nBatches ?? 0)} /><Metric label="Frozen fish" value={Number(stage2?.nFrozen ?? 0)} /><Metric label="Discarded fish" value={Number(stage2?.nDiscarded ?? 0)} /></div>
    <ReportPanel title="Overview pipeline"><FunnelChart points={report.funnel} /><ReportTable headers={['Step', 'n', '% previous', '% activated']} rows={report.pipeline.map((point) => [String(point.step ?? '—'), Number(point.count ?? 0), `${(Number(point.pctOfPrevious ?? 0) * 100).toFixed(2)}%`, `${(Number(point.pctOfStart ?? 0) * 100).toFixed(2)}%`])} /></ReportPanel>
    <ReportPanel title="Stage 1 survival curve"><SurvivalChart points={report.survival} /><ReportTable headers={['Site', 'Strain', 'Stage', 'Risk set', 'Alive', 'Survival']} rows={report.survival.map((point) => [String(point.siteId ?? 'All'), String(point.strain ?? 'All'), String(point.stageLabel ?? point.stageOrder ?? '—'), Number(point.riskSet ?? 0), Number(point.alive ?? 0), Number(point.surv ?? 0).toFixed(4)])} /></ReportPanel>
    <ReportPanel title="Attrition / abnormality onset"><FunnelChart points={report.funnel} /><ReportTable headers={['Stage', 'Count']} rows={report.abnormality.map((point) => [String(point.stageLabel ?? point.stageOrder ?? '—'), Number(point.count ?? 0)])} /></ReportPanel>
    <ReportPanel title="Timing deviation / group comparison"><DeviationChart points={report.deviation} /><ReportTable headers={['Group', 'Stage', 'n', 'Mean H', 'Median H', 'SD H']} rows={report.deviation.map((point) => [String(point.treatmentGroup ?? point.strain ?? 'All'), String(point.stageLabel ?? point.stageOrder ?? '—'), Number(point.n ?? 0), Number(point.meanDeviationH ?? 0).toFixed(4), Number(point.medianDeviationH ?? 0).toFixed(4), point.sdDeviationH == null ? '—' : Number(point.sdDeviationH).toFixed(4)])} /></ReportPanel>
    <ReportPanel title="Stage 2 fish survival"><ReportTable headers={['Condition', 'Age day', 'At risk', 'Alive', 'Survival']} rows={report.fishSurvival.map((point) => [String(point.condition ?? 'All'), Number(point.ageDays ?? 0), Number(point.atRisk ?? 0), Number(point.alive ?? 0), Number(point.surv ?? 0).toFixed(4)])} /></ReportPanel>
    <ReportPanel title="SCNT / control comparison"><ReportTable headers={['Arm', 'Stage', 'n', 'Normal', 'Abnormal', 'Normal %']} rows={comparison.map((point) => [String(point.armType), String(point.stageLabel ?? point.stageOrder), Number(point.n ?? 0), Number(point.nNormal ?? 0), Number(point.nAbnormal ?? 0), `${(Number(point.pctNormal ?? 0) * 100).toFixed(2)}%`])} /></ReportPanel>
    <ReportPanel title="Observation gaps"><ReportTable headers={['Fish', 'Last observed', 'Missed days']} rows={report.gaps.map((point) => [String(point.fishCode ?? '—'), String(point.lastObservedOn ?? '—'), Number(point.missedDays ?? 0)])} /></ReportPanel>
  </>}</section>
}
