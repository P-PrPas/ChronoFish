import { useCallback, useEffect, useState } from 'react'
import { type ApiItem, get, operatorId } from '../api/client'
import { putQueue, type ApiQueueResult, type QueuedWrite } from '../offline'
import { type AppText, text } from '../types'
import { Empty, ErrorMessage } from '../components'
import { dateTimeLocalToRFC3339, rfc3339ToDateTimeLocal } from '../time'
import { uuidv7 } from '../uuidv7'
import { parseFilters, withFilters } from '../filters'

type EmbryoOutcome = 'ALIVE' | 'DEAD' | 'DEGENERATED' | 'NOT_OBSERVED'
type ObservationDraft = { embryoId?: unknown; [key: string]: unknown }
type ObservationResult = { id?: unknown; status?: unknown; error?: { message?: unknown }; [key: string]: unknown }
const outcomeCycle: EmbryoOutcome[] = ['ALIVE', 'DEAD', 'DEGENERATED']
const wells = Array.from({ length: 96 }, (_, index) =>
  `${String.fromCharCode(65 + Math.floor(index / 12))}${(index % 12) + 1}`)

export type CheckpointTiming = { actual: number | null; expected: number; deviation: number | null; observedMinutes: number | null; liveMinutes: number | null; label: string }

export function nextCheckpoints(items: ApiItem[]): ApiItem[] {
  const byLot = new Map<string, ApiItem[]>()
  for (const item of items) {
    const key = String(item.injectionLotId)
    byLot.set(key, [...(byLot.get(key) ?? []), item])
  }
  return [...byLot.values()]
    .map((group) => ({
      ...[...group].sort((a, b) => Number(b.minutesLate ?? 0) - Number(a.minutesLate ?? 0))[0],
      pendingStages: group.filter((item) => Number(item.minutesLate ?? 0) > 0).length,
    }))
    .sort((a, b) => Number(b.minutesLate ?? 0) - Number(a.minutesLate ?? 0))
}

function hpaClock(hours: number): string {
  const totalMinutes = Math.max(0, Math.round(hours * 60))
  return `${Math.floor(totalMinutes / 60)}:${String(totalMinutes % 60).padStart(2, '0')}`
}

export function deviationDisplay(value: number | null): string {
  if (value === null || Math.abs(value) < 1 / 60) return 'ตรงกับสากล'
  const totalMinutes = Math.round(Math.abs(value) * 60)
  const direction = value < 0 ? 'เร็วกว่า' : 'ช้ากว่า'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours > 0 ? `${direction}สากล ${hours} ชม. ${minutes} นาที` : `${direction}สากล ${minutes} นาที`
}

/** Pure preview calculation used by the checkpoint and browser tests. */
export function checkpointTiming(activatedAt: string, observedAt: string, expectedHpa: number, now = Date.now()): CheckpointTiming {
  const activatedMs = Date.parse(activatedAt)
  let observedMs = Number.NaN
  try { observedMs = Date.parse(dateTimeLocalToRFC3339(observedAt)) } catch { /* invalid input stays unavailable */ }
  const observedMinutes = Number.isNaN(activatedMs) || Number.isNaN(observedMs) ? null : Math.max(0, Math.floor((observedMs - activatedMs) / 60_000))
  const liveMinutes = Number.isNaN(activatedMs) ? null : Math.max(0, Math.floor((now - activatedMs) / 60_000))
  const actual = observedMinutes === null ? null : observedMinutes / 60
  const deviation = actual === null ? null : actual - expectedHpa
  const label = deviationDisplay(deviation)
  return { actual, expected: expectedHpa, deviation, observedMinutes, liveMinutes, label }
}

export function Due({ t }: { t: AppText }) {
  const [dashboardFilters] = useState(parseFilters)
  const [data, setData] = useState<ApiItem>({ overdue: [], upcoming: [] })
  const [selected, setSelected] = useState<ApiItem | null>(null)
  const [siteId, setSiteId] = useState(dashboardFilters.siteId ?? '')
  const [selectedOperatorId, setSelectedOperatorId] = useState(dashboardFilters.operatorId ?? '')
  const [masters, setMasters] = useState<Record<string, ApiItem[]>>({ sites: [], operators: [] })
  const [error, setError] = useState('')
  const load = useCallback(() => {
    const filters = { ...dashboardFilters, siteId: siteId || undefined, operatorId: selectedOperatorId || undefined }
    void get(withFilters('/due-checkpoints', filters)).then((value) => {
      setData(value)
    }).catch((e: Error) => setError(e.message))
  }, [dashboardFilters, selectedOperatorId, siteId])
  useEffect(() => { load(); const timer = window.setInterval(load, 60_000); return () => window.clearInterval(timer) }, [load])
  useEffect(() => {
    void Promise.all(['sites', 'operators'].map((resource) =>
      get(`/${resource}`).then((value) => [resource, value.items ?? []] as [string, ApiItem[]])))
      .then((items) => setMasters(Object.fromEntries(items)))
      .catch((e: Error) => setError(e.message))
  }, [])
  if (selected) return <Checkpoint due={selected} t={t} onBack={() => setSelected(null)} />
  const items = nextCheckpoints([...(data.overdue ?? []), ...(data.upcoming ?? [])])
  const thai = t === text.th
  return <section>
    <div className="page-heading"><div><p className="eyebrow">{thai ? 'งานตรวจตัวอ่อนวันนี้' : 'Stage 1 daily work'}</p><h1>{t.due}</h1><p className="muted">{thai ? 'เรียงงานเร่งด่วนก่อน และอัปเดตเวลาให้อัตโนมัติทุก 60 วินาที' : 'The most urgent checkpoint appears first. Times refresh every 60 seconds.'}</p></div><button className="button button--secondary" onClick={load}>{t.refresh}</button></div>
    <details className="filter-disclosure">
      <summary>{thai ? 'กรองตามสถานที่หรือผู้ปฏิบัติงาน' : 'Filter by site or operator'}</summary>
      <fieldset className="filter-bar"><legend>{thai ? 'แสดงเฉพาะงานที่เกี่ยวข้อง' : 'Show relevant work'}</legend>
        <label>{thai ? 'สถานที่' : 'Site'}<select aria-label="Filter due by site" value={siteId} onChange={(event) => setSiteId(event.target.value)}><option value="">{thai ? 'ทุกสถานที่' : 'All sites'}</option>{masters.sites.map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.code ?? item.name)}</option>)}</select></label>
        <label>{thai ? 'ผู้ปฏิบัติงาน' : 'Operator'}<select aria-label="Filter due by operator" value={selectedOperatorId} onChange={(event) => setSelectedOperatorId(event.target.value)}><option value="">{thai ? 'ทุกคน' : 'All operators'}</option>{masters.operators.map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.name ?? item.id)}</option>)}</select></label>
      </fieldset>
    </details>
    {error && <ErrorMessage message={error} />}
    {items.length === 0 ? <Empty message={t.empty} actionLabel={thai ? 'เปิดรายการทดลอง' : 'Open experiments'} onAction={() => { location.hash = 'batches' }} /> : <div className="list">{items.map((item: ApiItem) => {
      const late = item.minutesLate ?? 0
      const pendingStages = Number(item.pendingStages ?? 0)
      return <button key={`${item.injectionLotId}-${item.stageCode}`} className="list-row" onClick={() => setSelected(item)}><span><strong>{String(item.batchCode)} · Lot {String(item.lotNo)}</strong><small>{String(item.stageLabel)} · {thai ? `เหลือ ${String(item.embryosRemaining ?? '—')} ตัว${pendingStages > 1 ? ` · ค้าง ${pendingStages} จุดตรวจ` : ''}` : `${String(item.embryosRemaining ?? '—')} embryos remaining${pendingStages > 1 ? ` · ${pendingStages} checkpoints overdue` : ''}`}</small></span><span className={late > 0 ? 'pill pill--late' : 'pill'}>{late > 0 ? (thai ? `เกิน ${late} นาที` : `Late ${late} min`) : (thai ? `อีก ${Math.abs(Number(late))} นาที` : `Due in ${Math.abs(Number(late))} min`)}</span></button>
    })}</div>}
  </section>
}

function Checkpoint({ due, t, onBack }: { due: ApiItem; t: AppText; onBack: () => void }) {
  const [entry, setEntry] = useState<ApiItem | null>(null)
  const [outcomes, setOutcomes] = useState<Record<string, EmbryoOutcome>>({})
  const [conditions, setConditions] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [observedAt, setObservedAt] = useState(rfc3339ToDateTimeLocal(new Date().toISOString()))
  const [overrideReason, setOverrideReason] = useState('')
  const [correctionReason, setCorrectionReason] = useState('')
  const [savedIds, setSavedIds] = useState<Record<string, string>>({})
  const [official, setOfficial] = useState<ApiItem | null>(null)
  const [saveStatus, setSaveStatus] = useState('Not saved')
  const [undoUntil, setUndoUntil] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void get(`/injection-lots/${due.injectionLotId}/checkpoints/${due.stageCode}`).then((value) => {
      setEntry(value)
      const nextOutcomes: Record<string, EmbryoOutcome> = {}
      const nextConditions: Record<string, string> = {}
      ;(value.embryos ?? []).forEach((embryo: ApiItem) => {
        nextOutcomes[String(embryo.embryoId)] = 'ALIVE'
        nextConditions[String(embryo.embryoId)] = String(embryo.defaultCondition ?? 'NORMAL')
      })
      setOutcomes(nextOutcomes)
      setConditions(nextConditions)
    }).catch((e: Error) => setError(e.message))
  }, [due])
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer) }, [])

  const embryos = entry?.embryos ?? []
  const total = Number(entry?.totalEmbryos ?? embryos.length)
  const alive = Object.values(outcomes).filter((outcome) => outcome === 'ALIVE').length
  const activatedAt = String(entry?.activatedAt ?? due.activatedAt ?? '')
  const activatedMs = Date.parse(activatedAt)
  const liveElapsedMinutes = Number.isNaN(activatedMs) ? null : Math.max(0, Math.floor((now - activatedMs) / 60_000))
  const observedMs = (() => { try { return Date.parse(dateTimeLocalToRFC3339(observedAt)) } catch { return Number.NaN } })()
  const elapsedMinutes = Number.isNaN(activatedMs) || Number.isNaN(observedMs) ? null : Math.max(0, Math.floor((observedMs - activatedMs) / 60_000))
  const expected = Number(official?.hpaExpected ?? entry?.expectedHpa ?? 0)
  const previewActual = elapsedMinutes === null ? null : elapsedMinutes / 60
  const actual = official?.hpaActual == null ? previewActual : Number(official.hpaActual)
  const deviation = official?.deviationH == null ? (actual === null ? null : actual - expected) : Number(official.deviationH)
  const deviationLabel = String(official?.deviationLabel ?? deviationDisplay(deviation))
  const stageOrder = Number((entry?.stage as ApiItem | undefined)?.stageOrder ?? due.stageOrder ?? 0)
  const progressLabel = `Checkpoint ${stageOrder || '?'} / 26 · Survivors ${alive} / ${total}`
  const timeLabel = elapsedMinutes === null ? 'T+—' : `T+${String(Math.floor(elapsedMinutes / 60)).padStart(2, '0')}:${String(elapsedMinutes % 60).padStart(2, '0')}`
  const liveTimeLabel = liveElapsedMinutes === null ? 'T+—' : `T+${String(Math.floor(liveElapsedMinutes / 60)).padStart(2, '0')}:${String(liveElapsedMinutes % 60).padStart(2, '0')}`
  const timingLabel = actual === null ? '—' : `จริง ${hpaClock(actual)} · สากล ${hpaClock(expected)} · ${deviationLabel}`
  const isBackdated = official?.isBackdated === true || (!Number.isNaN(observedMs) && Math.abs(now - observedMs) > 15 * 60_000)
  const allSaved = embryos.length > 0 && Object.keys(savedIds).length === embryos.length

  const applyResults = useCallback((result: ApiQueueResult, submitted: ObservationDraft[]) => {
    const rows = (result.results as ObservationResult[] | undefined) ?? []
    const rejected = rows.filter((item) => item.status === 'rejected')
    setSavedIds((current) => ({
      ...current,
      ...Object.fromEntries(rows.flatMap((item, index) =>
        item.id && item.status !== 'rejected' ? [[String(submitted[index]?.embryoId), String(item.id)]] : [])),
    }))
    const accepted = rows.find((item) => item.status !== 'rejected')
    if (accepted) setOfficial(accepted as ApiItem)
    setUndoUntil(Date.now() + 10_000)
    setSaveStatus(rejected.length ? `Saved ${rows.length - rejected.length}; ${rejected.length} rejected` : `Saved by ${operatorId() || 'unselected operator'}`)
    setError(rejected.map((item) => String(item.error?.message ?? 'Observation rejected')).join(' · '))
  }, [])
  useEffect(() => {
    const currentEmbryos = new Set((entry?.embryos ?? []).map((embryo: ApiItem) => String(embryo.embryoId)))
    const currentObservations = new Set(Object.values(savedIds))
    const belongsToCheckpoint = (detail: QueuedWrite) => {
      if (detail.path !== '/observations/embryo') {
        return [...currentObservations].some((id) => detail.path.startsWith(`/observations/embryo/${id}`))
      }
      const submitted = ((detail.body as ApiItem).observations as ObservationDraft[] | undefined) ?? []
      return submitted.length > 0 && submitted.every((item) =>
        currentEmbryos.has(String(item.embryoId)) && item.stageCode === due.stageCode)
    }
    const drained = (event: Event) => {
      const detail = (event as CustomEvent<QueuedWrite & { result?: ApiQueueResult }>).detail
      if (detail.result && belongsToCheckpoint(detail)) {
        const submitted = ((detail.body as ApiItem).observations as ObservationDraft[] | undefined) ?? []
        if (detail.path === '/observations/embryo') applyResults(detail.result, submitted)
      }
    }
    const rejected = (event: Event) => {
      const detail = (event as CustomEvent<QueuedWrite>).detail
      if (belongsToCheckpoint(detail)) setError(detail.lastError ?? 'Checkpoint write rejected')
    }
    window.addEventListener('chronofish:queue-drained', drained)
    window.addEventListener('chronofish:queue-rejected', rejected)
    return () => {
      window.removeEventListener('chronofish:queue-drained', drained)
      window.removeEventListener('chronofish:queue-rejected', rejected)
    }
  }, [applyResults, due.stageCode, entry, savedIds])

  const setAll = (outcome: EmbryoOutcome) => setOutcomes(Object.fromEntries(embryos.map((embryo: ApiItem) => [String(embryo.embryoId), outcome])))
  const setRemainingDead = () => setOutcomes((values) => Object.fromEntries(
    Object.entries(values).map(([id, outcome]) => [id, outcome === 'ALIVE' ? 'DEAD' : outcome])))
  const cycle = (id: string) => setOutcomes((values) => {
    const current = values[id] ?? 'ALIVE'
    return { ...values, [id]: outcomeCycle[(outcomeCycle.indexOf(current) + 1) % outcomeCycle.length] }
  })
  const observationFor = (embryo: ApiItem) => ({
    clientUuid: uuidv7(), embryoId: embryo.embryoId, stageCode: due.stageCode,
    observedAt: dateTimeLocalToRFC3339(observedAt), outcome: outcomes[String(embryo.embryoId)] ?? 'ALIVE',
    condition: conditions[String(embryo.embryoId)] ?? 'NORMAL', notes: notes[String(embryo.embryoId)] || null,
    ...(overrideReason.trim() ? { overrideReason: overrideReason.trim() } : {}),
  })
  const save = async () => {
    if (!entry) return
    setError('')
    setSaving(true)
    const observations = embryos.filter((embryo: ApiItem) => !savedIds[String(embryo.embryoId)]).map(observationFor)
    try {
      const result = await putQueue('/observations/embryo', { observations })
      if (result.queued) setSaveStatus(thai ? `รอส่งโดย ${operatorId() || 'ยังไม่ได้เลือกผู้ปฏิบัติงาน'}` : `Queued by ${operatorId() || 'unselected operator'}`)
      else applyResults(result, observations)
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  const correct = async () => {
    if (!correctionReason.trim()) { setError(thai ? 'โปรดระบุเหตุผลที่แก้ไข' : 'Enter a correction reason'); return }
    if (!window.confirm(thai ? 'บันทึกการแก้ไขพร้อมเหตุผลลงในประวัติหรือไม่?' : 'Save this correction with an audit reason?')) return
    setSaving(true); setError('')
    try {
      const results = await Promise.all(embryos.map((embryo: ApiItem) => {
        const id = String(embryo.embryoId)
        return putQueue(`/observations/embryo/${savedIds[id]}`, {
          observedAt: dateTimeLocalToRFC3339(observedAt), outcome: outcomes[id], condition: conditions[id],
          notes: notes[id] || null, correctionReason: correctionReason.trim(),
        }, 'application/json', 'PATCH')
      }))
      setSaveStatus(thai ? `${results.some((result) => result.queued) ? 'รอส่งการแก้ไข' : 'บันทึกการแก้ไขแล้ว'} โดย ${operatorId() || 'ยังไม่ได้เลือกผู้ปฏิบัติงาน'}` : `${results.some((result) => result.queued) ? 'Correction queued' : 'Correction saved'} by ${operatorId() || 'unselected operator'}`)
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  const undo = async () => {
    if (!window.confirm(thai ? 'ยกเลิกการบันทึกจุดตรวจล่าสุดหรือไม่?' : 'Undo the last checkpoint save?')) return
    setSaving(true); setError('')
    try {
      const results = await Promise.all(Object.values(savedIds).map((id) =>
        putQueue(`/observations/embryo/${id}?reason=undo-within-10-seconds`, undefined, 'application/json', 'DELETE')))
      setSavedIds({}); setOfficial(null); setUndoUntil(0); setSaveStatus(results.some((result) => result.queued) ? (thai ? 'รอส่งคำขอยกเลิก' : 'Undo queued') : (thai ? 'ยกเลิกการบันทึกล่าสุดแล้ว' : 'Last save undone'))
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  const renderEmbryo = (embryo: ApiItem, well: string) => {
    const id = String(embryo.embryoId); const outcome = outcomes[id] ?? 'ALIVE'
    return <div className="well checkpoint-well" data-well={well} key={id}><strong>{well}</strong><small>{String(embryo.embryoCode)}</small><button type="button" className={`outcome outcome--${outcome.toLowerCase()}`} aria-label={thai ? `เปลี่ยนผลของ ${String(embryo.embryoCode)}` : `Cycle outcome for ${String(embryo.embryoCode)}`} onClick={() => cycle(id)}>{outcome}</button><label>{thai ? 'สภาพ' : 'Condition'}<select value={conditions[id] ?? 'NORMAL'} onChange={(event) => setConditions({ ...conditions, [id]: event.target.value })}><option>NORMAL</option><option>ABNORMAL</option><option>UNDETERMINED</option></select></label><label>{thai ? 'หมายเหตุ' : 'Notes'}<input value={notes[id] ?? ''} onChange={(event) => setNotes({ ...notes, [id]: event.target.value })} /></label></div>
  }
  const byWell = new Map(embryos.filter((embryo: ApiItem) => wells.includes(String(embryo.wellPosition))).map((embryo: ApiItem) => [String(embryo.wellPosition), embryo]))
  const unassigned = embryos.filter((embryo: ApiItem) => !wells.includes(String(embryo.wellPosition)))
  const thai = t === text.th
  return <section>
    <button className="back" onClick={onBack}>← {t.due}</button>
    <div className="page-heading"><div><p className="eyebrow">{String(due.batchCode)} · LOT {String(due.lotNo)}</p><h1>{String(due.stageLabel)}</h1><p className="muted">{thai ? `จุดตรวจ ${stageOrder || '?'} จาก 26 · รอด ${alive} จาก ${total}` : progressLabel} · {timeLabel}</p></div><button className="button button--primary" disabled={saving || !entry} onClick={() => void (allSaved ? correct() : save())}>{saving ? t.saving : allSaved ? (thai ? 'บันทึกการแก้ไข' : 'Save correction') : Object.keys(savedIds).length ? (thai ? 'ลองบันทึกรายการที่เหลือ' : 'Retry rejected') : (thai ? 'บันทึกจุดตรวจ' : 'Save checkpoint')}</button></div>
    <div className="checkpoint-status" role="status"><strong>{thai ? 'ผู้บันทึก' : 'Operator'} {operatorId() || (thai ? 'ยังไม่ได้เลือก' : 'not selected')}</strong><span>{saveStatus}</span></div>
    {error && <ErrorMessage message={error} />}
    <p className="timing-preview" data-testid="checkpoint-timing-preview">{timingLabel} · {liveTimeLabel} {isBackdated && <span className="pill pill--late">Backdated</span>}</p>
    {official && <p className="notice">Official deviation {Number(official.deviationH) >= 0 ? '+' : ''}{Number(official.deviationH).toFixed(4)} h · {String(official.deviationLabel ?? '')}</p>}
    <div className="metric-grid"><div className="metric"><span>{thai ? 'เวลาจริง (HPA)' : 'Actual HPA'}</span><strong>{actual === null ? '—' : actual.toFixed(2)}</strong></div><div className="metric"><span>{thai ? 'เวลามาตรฐาน (HPA)' : 'Expected HPA'}</span><strong>{expected.toFixed(2)}</strong></div><div className="metric"><span>{thai ? 'ความเร็ว–ช้า' : 'Deviation'}</span><strong>{deviation === null ? '—' : deviationLabel}</strong></div></div>
    <div className="button-row checkpoint-shortcuts"><button className="button button--secondary" type="button" onClick={() => setAll('ALIVE')}>{thai ? 'ยืนยันว่ารอดทั้งหมด' : 'All alive'}</button><button className="button button--secondary" type="button" onClick={setRemainingDead}>{thai ? 'ตัวที่เหลือตายทั้งหมด' : 'All remaining dead'}</button>{undoUntil >= now && <button className="button button--secondary" type="button" onClick={() => void undo()}>{thai ? 'ยกเลิกการบันทึกล่าสุด' : 'Undo last save'}</button>}</div>
    <details className="workflow-disclosure">
      <summary>{thai ? 'เวลาและเหตุผลกรณีพิเศษ' : 'Time and exception details'}</summary>
      <div className="workflow-disclosure__body form-card--inline"><label>{thai ? 'เวลาที่สังเกต' : 'Observed at'}<input type="datetime-local" value={observedAt} onChange={(event) => setObservedAt(event.target.value)} /></label><label>{thai ? 'เหตุผลกรณีเปลี่ยนสถานะสิ้นสุด' : 'Override reason'}<input value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} placeholder={thai ? 'กรอกเมื่อจำเป็นต้องเปลี่ยนสถานะสิ้นสุด' : 'Why this checkpoint overrides the exit state'} /></label></div>
    </details>
    {Object.keys(savedIds).length > 0 && <label className="form-card">{thai ? 'เหตุผลที่แก้ไข' : 'Correction reason'}<input required aria-label="Correction reason" value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} /></label>}
    {entry && <details className="workflow-disclosure"><summary>{thai ? `ปรับผลรายตัว · ${embryos.length} ตัว` : `Review individual embryos · ${embryos.length}`}</summary><div className="workflow-disclosure__body"><div className="checkpoint-grid">{wells.map((well) => byWell.has(well) ? renderEmbryo(byWell.get(well) as ApiItem, well) : <div className="well checkpoint-well checkpoint-well--empty" data-well={well} key={well}><strong>{well}</strong><small>{thai ? 'ว่าง' : 'Empty'}</small></div>)}</div><div className="well-list--mobile">{embryos.map((embryo: ApiItem) => renderEmbryo(embryo, String(embryo.wellPosition ?? '—')))}</div>{unassigned.length > 0 && <div className="checkpoint-unassigned">{unassigned.map((embryo: ApiItem) => renderEmbryo(embryo, thai ? 'ไม่ได้ระบุหลุม' : 'Unassigned'))}</div>}</div></details>}
  </section>
}
