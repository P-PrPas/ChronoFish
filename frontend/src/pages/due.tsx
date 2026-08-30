import { useCallback, useEffect, useState } from 'react'
import { type ApiItem, get, operatorId } from '../api/client'
import { putQueue, type ApiQueueResult, type QueuedWrite } from '../offline'
import { type AppText, text } from '../types'
import { Empty, ErrorMessage } from '../components'
import { dateTimeLocalToRFC3339 } from '../time'
import { uuidv7 } from '../uuidv7'
import { parseFilters, withFilters } from '../filters'

type EmbryoOutcome = 'ALIVE' | 'DEAD' | 'DEGENERATED' | 'NOT_OBSERVED'
type ObservationDraft = { embryoId?: unknown; [key: string]: unknown }
type ObservationResult = { id?: unknown; status?: unknown; error?: { message?: unknown }; [key: string]: unknown }
const outcomes: EmbryoOutcome[] = ['ALIVE', 'DEAD', 'DEGENERATED', 'NOT_OBSERVED']
const conditions = ['NORMAL', 'ABNORMAL', 'UNDETERMINED']
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

export function deviationDisplay(value: number | null): string {
  if (value === null || Math.abs(value) < 1 / 60) return 'ตรงกับสากล'
  const totalMinutes = Math.round(Math.abs(value) * 60)
  const direction = value < 0 ? 'เร็วกว่า' : 'ช้ากว่า'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours > 0 ? `${direction}สากล ${hours} ชม. ${minutes} นาที` : `${direction}สากล ${minutes} นาที`
}

/** Pure preview calculation retained for historical records and formula tests. */
export function checkpointTiming(activatedAt: string, observedAt: string, expectedHpa: number, now = Date.now()): CheckpointTiming {
  const activatedMs = Date.parse(activatedAt)
  let observedMs = Number.NaN
  try { observedMs = Date.parse(dateTimeLocalToRFC3339(observedAt)) } catch { /* invalid input stays unavailable */ }
  const observedMinutes = Number.isNaN(activatedMs) || Number.isNaN(observedMs) ? null : Math.max(0, Math.floor((observedMs - activatedMs) / 60_000))
  const liveMinutes = Number.isNaN(activatedMs) ? null : Math.max(0, Math.floor((now - activatedMs) / 60_000))
  const actual = observedMinutes === null ? null : observedMinutes / 60
  const deviation = actual === null ? null : actual - expectedHpa
  return { actual, expected: expectedHpa, deviation, observedMinutes, liveMinutes, label: deviationDisplay(deviation) }
}

export function Due({ t }: { t: AppText }) {
  const [dashboardFilters] = useState(parseFilters)
  const [data, setData] = useState<ApiItem>({ overdue: [], upcoming: [] })
  const [selected, setSelected] = useState<ApiItem | null>(null)
  const [siteId, setSiteId] = useState(dashboardFilters.siteId ?? '')
  const [selectedOperatorId, setSelectedOperatorId] = useState(dashboardFilters.operatorId ?? '')
  const [masters, setMasters] = useState<Record<string, ApiItem[]>>({ sites: [], operators: [] })
  const [mastersReady, setMastersReady] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    const filters = { ...dashboardFilters, siteId: siteId || undefined, operatorId: selectedOperatorId || undefined }
    void get(withFilters('/due-checkpoints', filters)).then(setData).catch((e: Error) => setError(e.message))
  }, [dashboardFilters, selectedOperatorId, siteId])
  useEffect(() => { load(); const timer = window.setInterval(load, 60_000); return () => window.clearInterval(timer) }, [load])
  useEffect(() => {
    void Promise.all(['sites', 'operators'].map((resource) =>
      get(`/${resource}`).then((value) => [resource, value.items ?? []] as [string, ApiItem[]])))
      .then((items) => { setMasters(Object.fromEntries(items)); setMastersReady(true) })
      .catch((e: Error) => setError(e.message))
  }, [])
  const thai = t === text.th
  if (selected) {
    const current = masters.operators.find((item) => String(item.id) === operatorId())
    const operatorName = current?.name ? String(current.name) : mastersReady ? (thai ? 'ไม่พบชื่อผู้ปฏิบัติงาน' : 'Operator unavailable') : (thai ? 'กำลังโหลดชื่อผู้ปฏิบัติงาน…' : 'Loading operator…')
    return <ObservationRound due={selected} t={t} operatorName={operatorName} onBack={() => setSelected(null)} />
  }
  const items = nextCheckpoints([...(data.overdue ?? []), ...(data.upcoming ?? [])])
  return <section>
    <div className="page-heading"><div><p className="eyebrow">{thai ? 'งานตรวจตัวอ่อนวันนี้' : 'Stage 1 daily work'}</p><h1>{t.due}</h1><p className="muted">{thai ? 'เปิดตรวจเป็นราย lot แล้วเลือกระยะของตัวอ่อนแต่ละฟองตามที่เห็นจริง' : 'Open a lot, then record the stage seen for each embryo independently.'}</p></div><button className="button button--secondary" onClick={load}>{t.refresh}</button></div>
    <details className="filter-disclosure"><summary>{thai ? 'กรองตามสถานที่หรือผู้ปฏิบัติงาน' : 'Filter by site or operator'}</summary><fieldset className="filter-bar"><legend>{thai ? 'แสดงเฉพาะงานที่เกี่ยวข้อง' : 'Show relevant work'}</legend>
      <label>{thai ? 'สถานที่' : 'Site'}<select aria-label="Filter due by site" value={siteId} onChange={(event) => setSiteId(event.target.value)}><option value="">{thai ? 'ทุกสถานที่' : 'All sites'}</option>{masters.sites.map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.code ?? item.name)}</option>)}</select></label>
      <label>{thai ? 'ผู้ปฏิบัติงาน' : 'Operator'}<select aria-label="Filter due by operator" value={selectedOperatorId} onChange={(event) => setSelectedOperatorId(event.target.value)}><option value="">{thai ? 'ทุกคน' : 'All operators'}</option>{masters.operators.map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.name ?? '')}</option>)}</select></label>
    </fieldset></details>
    {error && <ErrorMessage message={error} />}
    {items.length === 0 ? <Empty message={t.empty} actionLabel={thai ? 'เปิดรายการทดลอง' : 'Open experiments'} onAction={() => { location.hash = 'batches' }} /> : <div className="list">{items.map((item: ApiItem) => {
      const late = Number(item.minutesLate ?? 0)
      const pendingStages = Number(item.pendingStages ?? 0)
      return <button key={String(item.injectionLotId)} className="list-row" onClick={() => setSelected(item)}><span><strong>{String(item.batchCode)} · Lot {String(item.lotNo)}</strong><small>{thai ? `ช่วงแนะนำ ${String(item.stageLabel)} · เหลือ ${String(item.embryosRemaining ?? '—')} ตัว${pendingStages > 1 ? ` · มี ${pendingStages} ช่วงที่ถึงเวลาแล้ว` : ''}` : `Suggested ${String(item.stageLabel)} · ${String(item.embryosRemaining ?? '—')} embryos${pendingStages > 1 ? ` · ${pendingStages} stages due` : ''}`}</small></span><span className={late > 0 ? 'pill pill--late' : 'pill'}>{late > 0 ? (thai ? `เกิน ${late} นาที` : `Late ${late} min`) : (thai ? `อีก ${Math.abs(late)} นาที` : `Due in ${Math.abs(late)} min`)}</span></button>
    })}</div>}
  </section>
}

function ObservationRound({ due, t, operatorName, onBack }: { due: ApiItem; t: AppText; operatorName: string; onBack: () => void }) {
  const thai = t === text.th
  const [entry, setEntry] = useState<ApiItem | null>(null)
  const [stageCodes, setStageCodes] = useState<Record<string, string>>({})
  const [selectedStage, setSelectedStage] = useState(String(due.stageCode ?? ''))
  const [embryoOutcomes, setEmbryoOutcomes] = useState<Record<string, EmbryoOutcome>>({})
  const [embryoConditions, setEmbryoConditions] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [overrideReason, setOverrideReason] = useState('')
  const [correctionReason, setCorrectionReason] = useState('')
  const [confirmedAt, setConfirmedAt] = useState('')
  const [savedIds, setSavedIds] = useState<Record<string, string>>({})
  const [saveStatus, setSaveStatus] = useState(thai ? 'ยังไม่บันทึก' : 'Not saved')
  const [undoUntil, setUndoUntil] = useState(0)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void get(`/injection-lots/${due.injectionLotId}/checkpoints/${due.stageCode}`).then((value) => {
      setEntry(value)
      setEmbryoOutcomes(Object.fromEntries((value.embryos ?? []).map((embryo: ApiItem) => [String(embryo.embryoId), 'ALIVE'])))
      setEmbryoConditions(Object.fromEntries((value.embryos ?? []).map((embryo: ApiItem) => [String(embryo.embryoId), String(embryo.defaultCondition ?? 'NORMAL')])))
    }).catch((e: Error) => setError(e.message))
  }, [due.injectionLotId, due.stageCode])

  const embryos = (entry?.embryos as ApiItem[] | undefined) ?? []
  const stages = (entry?.stages as ApiItem[] | undefined) ?? []
  const pending = embryos.filter((embryo: ApiItem) => {
    const id = String(embryo.embryoId)
    return stageCodes[id] && !savedIds[id]
  })

  const applyResults = useCallback((result: ApiQueueResult, submitted: ObservationDraft[]) => {
    const rows = (result.results as ObservationResult[] | undefined) ?? []
    const rejected = rows.filter((item) => item.status === 'rejected')
    setSavedIds((current) => ({
      ...current,
      ...Object.fromEntries(rows.flatMap((item, index) =>
        item.id && item.status !== 'rejected' ? [[String(submitted[index]?.embryoId), String(item.id)]] : [])),
    }))
    setUndoUntil(Date.now() + 10_000)
    setSaveStatus(rejected.length ? `${thai ? 'บันทึก' : 'Saved'} ${rows.length - rejected.length}; ${rejected.length} rejected` : `${thai ? 'บันทึกโดย' : 'Saved by'} ${operatorName}`)
    setError(rejected.map((item) => String(item.error?.message ?? 'Observation rejected')).join(' · '))
  }, [operatorName, thai])

  useEffect(() => {
    const currentEmbryos = new Set((entry?.embryos ?? []).map((embryo: ApiItem) => String(embryo.embryoId)))
    const currentObservations = new Set(Object.values(savedIds))
    const belongsToRound = (detail: QueuedWrite) => {
      if (detail.path !== '/observations/embryo') return [...currentObservations].some((id) => detail.path.startsWith(`/observations/embryo/${id}`))
      const submitted = ((detail.body as ApiItem).observations as ObservationDraft[] | undefined) ?? []
      return submitted.length > 0 && submitted.every((item) => currentEmbryos.has(String(item.embryoId)))
    }
    const drained = (event: Event) => {
      const detail = (event as CustomEvent<QueuedWrite & { result?: ApiQueueResult }>).detail
      if (detail.result && belongsToRound(detail) && detail.path === '/observations/embryo') {
        applyResults(detail.result, ((detail.body as ApiItem).observations as ObservationDraft[] | undefined) ?? [])
      }
    }
    const rejected = (event: Event) => {
      const detail = (event as CustomEvent<QueuedWrite>).detail
      if (belongsToRound(detail)) setError(detail.lastError ?? 'Observation round write rejected')
    }
    window.addEventListener('chronofish:queue-drained', drained)
    window.addEventListener('chronofish:queue-rejected', rejected)
    return () => {
      window.removeEventListener('chronofish:queue-drained', drained)
      window.removeEventListener('chronofish:queue-rejected', rejected)
    }
  }, [applyResults, entry, savedIds])

  const observationFor = (embryo: ApiItem, observedAt: string) => {
    const id = String(embryo.embryoId)
    return {
      clientUuid: uuidv7(), embryoId: embryo.embryoId, stageCode: stageCodes[id], observedAt,
      outcome: embryoOutcomes[id] ?? 'ALIVE', condition: embryoConditions[id] ?? 'NORMAL', notes: notes[id] || null,
      ...(overrideReason.trim() ? { overrideReason: overrideReason.trim() } : {}),
    }
  }
  const save = async () => {
    if (!entry || pending.length === 0) return
    const observedAt = new Date().toISOString()
    const observations = pending.map((embryo: ApiItem) => observationFor(embryo, observedAt))
    setConfirmedAt(observedAt)
    setError('')
    setSaving(true)
    try {
      const result = await putQueue('/observations/embryo', { observations })
      if (result.queued) setSaveStatus(`${thai ? 'รอส่งโดย' : 'Queued by'} ${operatorName}`)
      else applyResults(result, observations)
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  const correct = async () => {
    if (!correctionReason.trim()) { setError(thai ? 'โปรดระบุเหตุผลที่แก้ไข' : 'Enter a correction reason'); return }
    if (!window.confirm(thai ? 'บันทึกการแก้ไขพร้อมเหตุผลลงในประวัติหรือไม่?' : 'Save this correction with an audit reason?')) return
    setSaving(true); setError('')
    try {
      const savedEmbryos = embryos.filter((embryo: ApiItem) => savedIds[String(embryo.embryoId)])
      const results = await Promise.all(savedEmbryos.map((embryo: ApiItem) => {
        const id = String(embryo.embryoId)
        return putQueue(`/observations/embryo/${savedIds[id]}`, {
          observedAt: confirmedAt, outcome: embryoOutcomes[id], condition: embryoConditions[id],
          notes: notes[id] || null, correctionReason: correctionReason.trim(),
        }, 'application/json', 'PATCH')
      }))
      setSaveStatus(`${results.some((result) => result.queued) ? (thai ? 'รอส่งการแก้ไข' : 'Correction queued') : (thai ? 'บันทึกการแก้ไขแล้ว' : 'Correction saved')} ${thai ? 'โดย' : 'by'} ${operatorName}`)
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  const undo = async () => {
    if (!window.confirm(thai ? 'ยกเลิกการบันทึกรอบตรวจล่าสุดหรือไม่?' : 'Undo the last observation round save?')) return
    setSaving(true); setError('')
    try {
      const results = await Promise.all(Object.values(savedIds).map((id) => putQueue(`/observations/embryo/${id}?reason=undo-within-10-seconds`, undefined, 'application/json', 'DELETE')))
      setSavedIds({}); setUndoUntil(0); setSaveStatus(results.some((result) => result.queued) ? (thai ? 'รอส่งคำขอยกเลิก' : 'Undo queued') : (thai ? 'ยกเลิกการบันทึกล่าสุดแล้ว' : 'Last save undone'))
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  const applyStageToBlankRows = () => {
    if (!selectedStage) return
    setStageCodes((current) => ({
      ...current,
      ...Object.fromEntries(embryos.flatMap((embryo: ApiItem) => {
        const id = String(embryo.embryoId)
        return !current[id] && !savedIds[id] ? [[id, selectedStage]] : []
      })),
    }))
  }
  const renderEmbryo = (embryo: ApiItem, well: string) => {
    const id = String(embryo.embryoId)
    const saved = Boolean(savedIds[id])
    const priorStage = stages.find((stage: ApiItem) => stage.stageCode === embryo.priorStageCode)
    return <div className="well checkpoint-well" data-well={well} key={id}>
      <strong>{well} · {String(embryo.embryoCode)}</strong>
      {embryo.priorStageCode != null && <small>{thai ? 'ครั้งก่อน' : 'Previous'}: {String(priorStage?.stageLabel ?? '—')}</small>}
      <label>{thai ? 'ระยะที่เห็น' : 'Observed stage'}<select aria-label={`${thai ? 'ระยะของ' : 'Stage for'} ${String(embryo.embryoCode)}`} value={stageCodes[id] ?? ''} disabled={saved} onChange={(event) => setStageCodes({ ...stageCodes, [id]: event.target.value })}><option value="">{thai ? 'ไม่บันทึกฟองนี้' : 'Skip this embryo'}</option>{stages.map((stage: ApiItem) => <option key={String(stage.stageCode)} value={String(stage.stageCode)}>{String(stage.stageLabel)}</option>)}</select></label>
      <label>{thai ? 'สถานะ' : 'Outcome'}<select aria-label={`${thai ? 'สถานะของ' : 'Outcome for'} ${String(embryo.embryoCode)}`} value={embryoOutcomes[id] ?? 'ALIVE'} onChange={(event) => setEmbryoOutcomes({ ...embryoOutcomes, [id]: event.target.value as EmbryoOutcome })}>{outcomes.map((outcome) => <option key={outcome}>{outcome}</option>)}</select></label>
      <label>{thai ? 'สภาพ' : 'Condition'}<select value={embryoConditions[id] ?? 'NORMAL'} onChange={(event) => setEmbryoConditions({ ...embryoConditions, [id]: event.target.value })}>{conditions.map((condition) => <option key={condition}>{condition}</option>)}</select></label>
      <label>{thai ? 'หมายเหตุ' : 'Notes'}<input value={notes[id] ?? ''} onChange={(event) => setNotes({ ...notes, [id]: event.target.value })} /></label>
      {saved && <span className="pill">{thai ? 'บันทึกแล้ว' : 'Saved'}</span>}
    </div>
  }
  return <section>
    <button className="back" onClick={onBack}>← {t.due}</button>
    <div className="page-heading"><div><p className="eyebrow">{String(due.batchCode)} · LOT {String(due.lotNo)}</p><h1>{thai ? 'บันทึกรอบตรวจ Lot' : 'Record lot observation'}</h1><p className="muted">{thai ? `ช่วงที่ระบบแนะนำ: ${String(due.stageLabel)} · เลือกระยะจริงแยกแต่ละฟอง` : `Suggested window: ${String(due.stageLabel)} · choose the observed stage per embryo`}</p></div><button className="button button--primary" disabled={saving || !entry || pending.length === 0} onClick={() => void save()}>{saving ? t.saving : thai ? `ยืนยัน ${pending.length} รายการ` : `Confirm ${pending.length} observations`}</button></div>
    <div className="checkpoint-status" role="status"><strong>{thai ? 'ผู้บันทึก' : 'Operator'} {operatorName}</strong><span>{saveStatus}</span></div>
    {error && <ErrorMessage message={error} />}
    <p className="timing-preview">{thai ? 'เวลาจะถูกบันทึกอัตโนมัติเมื่อกด “ยืนยัน”' : 'Observation time is captured automatically when Confirm is pressed.'}{confirmedAt && ` · ${new Date(confirmedAt).toLocaleString()}`}</p>
    <div className="form-card form-card--inline checkpoint-shortcuts"><label>{thai ? 'ตั้งระยะให้แถวที่ยังว่าง' : 'Stage for blank rows'}<select value={selectedStage} onChange={(event) => setSelectedStage(event.target.value)}><option value="">{thai ? 'เลือกระยะ' : 'Choose stage'}</option>{stages.map((stage: ApiItem) => <option key={String(stage.stageCode)} value={String(stage.stageCode)}>{String(stage.stageLabel)}</option>)}</select></label><button className="button button--secondary" type="button" disabled={!selectedStage} onClick={applyStageToBlankRows}>{thai ? 'ใช้กับฟองที่ยังไม่เลือกระยะ' : 'Apply to blank embryos'}</button></div>
    <details className="workflow-disclosure"><summary>{thai ? 'เหตุผลกรณีบันทึกว่ารอดหลังมีสถานะสิ้นสุด' : 'Alive-after-exit exception'}</summary><div className="workflow-disclosure__body form-card--inline"><label>{thai ? 'เหตุผล' : 'Override reason'}<input value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} /></label></div></details>
    {Object.keys(savedIds).length > 0 && <div className="form-card form-card--inline"><label>{thai ? 'เหตุผลที่แก้ไข' : 'Correction reason'}<input required aria-label="Correction reason" value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} /></label><button className="button button--secondary" type="button" disabled={saving} onClick={() => void correct()}>{thai ? 'บันทึกการแก้ไข' : 'Save correction'}</button>{undoUntil >= Date.now() && <button className="button button--secondary" type="button" onClick={() => void undo()}>{thai ? 'ยกเลิกการบันทึกล่าสุด' : 'Undo last save'}</button>}</div>}
    {entry && <details className="workflow-disclosure" open><summary>{thai ? `ผลรายฟอง · ${embryos.length} ฟอง` : `Individual embryos · ${embryos.length}`}</summary><div className="workflow-disclosure__body"><div className="checkpoint-grid">{embryos.map((embryo: ApiItem) => renderEmbryo(embryo, String(embryo.wellPosition ?? (thai ? 'ไม่ระบุหลุม' : 'Unassigned'))))}</div></div></details>}
  </section>
}
