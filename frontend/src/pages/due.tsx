import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { type ApiItem, get, operatorId } from '../api/client'
import { putQueue, type ApiQueueResult, type QueuedWrite } from '../offline'
import { type AppText, text } from '../types'
import { Empty, ErrorMessage } from '../components'
import { dateTimeLocalToRFC3339 } from '../time'
import { uuidv7 } from '../uuidv7'
import { parseFilters, withFilters } from '../filters'

type EmbryoOutcome = 'ALIVE' | 'DEAD'
type ObservationDraft = { embryoId?: unknown; [key: string]: unknown }
type ObservationResult = { id?: unknown; status?: unknown; error?: { message?: unknown }; [key: string]: unknown }
const outcomes: EmbryoOutcome[] = ['ALIVE', 'DEAD']
const conditions = ['NORMAL', 'ABNORMAL']
export type CheckpointTiming = { actual: number | null; expected: number; deviation: number | null; observedMinutes: number | null; liveMinutes: number | null; label: string }

export function nextCheckpoints(items: ApiItem[]): ApiItem[] {
  const byLot = new Map<string, ApiItem[]>()
  for (const item of items) {
    const key = String(item.injectionLotId)
    byLot.set(key, [...(byLot.get(key) ?? []), item])
  }
  return [...byLot.values()]
    .map((group) => ({ ...[...group].sort((a, b) => Number(b.minutesLate ?? 0) - Number(a.minutesLate ?? 0))[0], pendingStages: group.filter((item) => Number(item.minutesLate ?? 0) > 0).length }))
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
    void Promise.all(['sites', 'operators'].map((resource) => get(`/${resource}`).then((value) => [resource, value.items ?? []] as [string, ApiItem[]])))
      .then((items) => { setMasters(Object.fromEntries(items)); setMastersReady(true) }).catch((e: Error) => setError(e.message))
  }, [])
  const thai = t === text.th
  if (selected) {
    const current = masters.operators.find((item) => String(item.id) === operatorId())
    const operatorName = current?.name ? String(current.name) : mastersReady ? (thai ? 'ไม่พบชื่อผู้ปฏิบัติงาน' : 'Operator unavailable') : (thai ? 'กำลังโหลดชื่อผู้ปฏิบัติงาน…' : 'Loading operator…')
    return <ObservationRound due={selected} t={t} operatorName={operatorName} onBack={() => setSelected(null)} />
  }
  const items = nextCheckpoints([...(data.overdue ?? []), ...(data.upcoming ?? [])])
  return <section>
    <div className="page-heading"><div><p className="eyebrow">{thai ? 'งานตรวจตัวอ่อนวันนี้' : 'Stage 1 daily work'}</p><h1>{t.due}</h1><p className="muted">{thai ? 'เปิดตรวจเป็นราย lot แล้วเลือกผลของตัวอ่อนแต่ละฟองตามที่เห็นจริง' : 'Open a lot, then record the stage seen for each embryo independently.'}</p></div><button className="button button--secondary" onClick={load}>{t.refresh}</button></div>
    <details className="filter-disclosure"><summary>{thai ? 'กรองตามสถานที่หรือผู้ปฏิบัติงาน' : 'Filter by site or operator'}</summary><fieldset className="filter-bar"><legend>{thai ? 'แสดงเฉพาะงานที่เกี่ยวข้อง' : 'Show relevant work'}</legend><label>{thai ? 'สถานที่' : 'Site'}<select value={siteId} onChange={(event) => setSiteId(event.target.value)}><option value="">{thai ? 'ทุกสถานที่' : 'All sites'}</option>{masters.sites.map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.code ?? item.name)}</option>)}</select></label><label>{thai ? 'ผู้ปฏิบัติงาน' : 'Operator'}<select value={selectedOperatorId} onChange={(event) => setSelectedOperatorId(event.target.value)}><option value="">{thai ? 'ทุกคน' : 'All operators'}</option>{masters.operators.map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.name ?? '')}</option>)}</select></label></fieldset></details>
    {error && <ErrorMessage message={error} />}
    {items.length === 0 ? <Empty message={t.empty} actionLabel={thai ? 'เปิดรายการทดลอง' : 'Open experiments'} onAction={() => { location.hash = 'batches' }} /> : <div className="list">{items.map((item: ApiItem) => {
      const late = Number(item.minutesLate ?? 0); const pendingStages = Number(item.pendingStages ?? 0)
      return <button key={String(item.injectionLotId)} className="list-row" onClick={() => setSelected(item)}><span><strong>{String(item.batchCode)} · Lot {String(item.lotNo)}</strong><small>{thai ? `ช่วงแนะนำ ${String(item.stageLabel)} · เหลือ ${String(item.embryosRemaining ?? '—')} ตัว${pendingStages > 1 ? ` · มี ${pendingStages} ช่วงที่ถึงเวลาแล้ว` : ''}` : `Suggested ${String(item.stageLabel)} · ${String(item.embryosRemaining ?? '—')} embryos${pendingStages > 1 ? ` · ${pendingStages} stages due` : ''}`}</small></span><span className={late > 0 ? 'pill pill--late' : 'pill'}>{late > 0 ? (thai ? `เกิน ${late} นาที` : `Late ${late} min`) : (thai ? `อีก ${Math.abs(late)} นาที` : `Due in ${Math.abs(late)} min`)}</span></button>
    })}</div>}
  </section>
}

type WellFilter = 'all' | 'unreviewed' | 'ready' | 'exception' | 'saved'

function wellPositionKey(value: unknown): [number, number] {
  const match = /^([A-Za-z]+)(\d+)$/.exec(String(value ?? ''))
  if (!match) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
  const row = [...match[1].toUpperCase()].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0)
  return [row, Number(match[2])]
}

function compareEmbryosByWell(left: ApiItem, right: ApiItem): number {
  const [leftRow, leftColumn] = wellPositionKey(left.wellPosition); const [rightRow, rightColumn] = wellPositionKey(right.wellPosition)
  return leftRow - rightRow || leftColumn - rightColumn || String(left.embryoCode ?? '').localeCompare(String(right.embryoCode ?? ''))
}

function wellButtonId(id: string): string { return `checkpoint-well-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}` }

function outcomeLabel(value: EmbryoOutcome, thai: boolean): string {
  return ({ ALIVE: thai ? 'รอด' : 'Alive', DEAD: thai ? 'ตาย' : 'Dead' } as Record<EmbryoOutcome, string>)[value]
}

function conditionLabel(value: string, thai: boolean): string {
  return ({ NORMAL: thai ? 'ปกติ' : 'Normal', ABNORMAL: thai ? 'พบความผิดปกติ' : 'Abnormal' } as Record<string, string>)[value] ?? value
}

function isPersistentlyDead(embryo: ApiItem): boolean {
  return embryo.isDead === true || ['DEAD', 'DEGENERATED'].includes(String(embryo.priorOutcome ?? ''))
}

function ObservationRound({ due, t, operatorName, onBack }: { due: ApiItem; t: AppText; operatorName: string; onBack: () => void }) {
  const thai = t === text.th
  const [entry, setEntry] = useState<ApiItem | null>(null)
  const [stageCodes, setStageCodes] = useState<Record<string, string>>({})
  const [selectedStage, setSelectedStage] = useState(String(due.stageCode ?? ''))
  const [selectedId, setSelectedId] = useState('')
  const [embryoOutcomes, setEmbryoOutcomes] = useState<Record<string, EmbryoOutcome>>({})
  const [embryoConditions, setEmbryoConditions] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [correctionReason, setCorrectionReason] = useState('')
  const [confirmedAt, setConfirmedAt] = useState('')
  const [savedIds, setSavedIds] = useState<Record<string, string>>({})
  const [queuedIds, setQueuedIds] = useState<Record<string, boolean>>({})
  const [lastSavedIds, setLastSavedIds] = useState<string[]>([])
  const [lastBulk, setLastBulk] = useState<{ ids: string[]; stage: string } | null>(null)
  const [saveStatus, setSaveStatus] = useState(thai ? 'ยังไม่บันทึก' : 'Not saved')
  const [undoUntil, setUndoUntil] = useState(0)
  const [viewFilter, setViewFilter] = useState<WellFilter>('all')
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const wellButtons = useRef<Record<string, HTMLButtonElement | null>>({})
  const editorHeading = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void get(`/injection-lots/${due.injectionLotId}/checkpoints/${due.stageCode}`).then((value) => {
      const loadedEmbryos = (value.embryos as ApiItem[] | undefined) ?? []
      const sortedEmbryos = [...loadedEmbryos].sort(compareEmbryosByWell)
      const firstWell = sortedEmbryos.find((embryo) => !isPersistentlyDead(embryo)) ?? sortedEmbryos[0]
      setEntry(value); setSelectedId(String(firstWell?.embryoId ?? ''))
      setEmbryoOutcomes(Object.fromEntries(loadedEmbryos.map((embryo) => [String(embryo.embryoId), isPersistentlyDead(embryo) ? 'DEAD' : 'ALIVE'])))
      setEmbryoConditions(Object.fromEntries(loadedEmbryos.map((embryo) => [String(embryo.embryoId), embryo.defaultCondition === 'ABNORMAL' ? 'ABNORMAL' : 'NORMAL'])))
    }).catch((e: Error) => setError(e.message))
  }, [due.injectionLotId, due.stageCode])

  const embryos = (entry?.embryos as ApiItem[] | undefined) ?? []
  const stages = (entry?.stages as ApiItem[] | undefined) ?? []
  const orderedEmbryos = [...embryos].sort(compareEmbryosByWell)
  const recordableEmbryos = orderedEmbryos.filter((embryo) => !isPersistentlyDead(embryo))
  const hasException = (embryo: ApiItem): boolean => {
    if (isPersistentlyDead(embryo)) return false
    const id = String(embryo.embryoId)
    return (embryoOutcomes[id] ?? 'ALIVE') !== 'ALIVE' || (embryoConditions[id] ?? 'NORMAL') !== 'NORMAL' || Boolean(notes[id]?.trim())
  }
  const stateFor = (embryo: ApiItem): 'dead' | 'saved' | 'queued' | 'exception' | 'ready' | 'unreviewed' => {
    const id = String(embryo.embryoId)
    if (isPersistentlyDead(embryo) || embryoOutcomes[id] === 'DEAD') return 'dead'
    if (savedIds[id]) return 'saved'; if (queuedIds[id]) return 'queued'; if (!stageCodes[id]) return 'unreviewed'; if (hasException(embryo)) return 'exception'
    return 'ready'
  }
  const stateLabel = (state: ReturnType<typeof stateFor>): string => ({ dead: thai ? 'ตาย' : 'Dead', saved: thai ? 'บันทึกแล้ว' : 'Saved', queued: thai ? 'รอส่ง' : 'Queued', exception: thai ? 'ข้อยกเว้น' : 'Exception', ready: thai ? 'พร้อมบันทึก' : 'Ready to save', unreviewed: thai ? 'ยังไม่ตรวจ' : 'Unreviewed' }[state])
  const matchingEmbryos = orderedEmbryos.filter((embryo) => {
    const query = search.trim().toLowerCase(); const matchesSearch = !query || String(embryo.wellPosition ?? '').toLowerCase().includes(query) || String(embryo.embryoCode ?? '').toLowerCase().includes(query)
    const id = String(embryo.embryoId)
    const matchesFilter = viewFilter === 'all' || (viewFilter === 'exception' ? hasException(embryo) : viewFilter === 'unreviewed' ? !isPersistentlyDead(embryo) && !stageCodes[id] && !savedIds[id] && !queuedIds[id] : stateFor(embryo) === viewFilter)
    return matchesSearch && matchesFilter
  })
  const pending = recordableEmbryos.filter((embryo) => { const id = String(embryo.embryoId); return Boolean(stageCodes[id]) && !savedIds[id] && !queuedIds[id] })
  const bulkable = recordableEmbryos.filter((embryo) => { const id = String(embryo.embryoId); return !stageCodes[id] && !savedIds[id] && !queuedIds[id] })
  const selectedCount = recordableEmbryos.filter((embryo) => Boolean(stageCodes[String(embryo.embryoId)])).length
  const unreviewedCount = recordableEmbryos.filter((embryo) => { const id = String(embryo.embryoId); return !stageCodes[id] && !savedIds[id] && !queuedIds[id] }).length
  const exceptionCount = recordableEmbryos.filter(hasException).length
  const savedCount = Object.keys(savedIds).length; const queuedCount = Object.keys(queuedIds).length
  const activeEmbryo = orderedEmbryos.find((embryo) => String(embryo.embryoId) === selectedId) ?? null
  const activeId = activeEmbryo ? String(activeEmbryo.embryoId) : ''
  const activeWell = activeEmbryo ? String(activeEmbryo.wellPosition ?? (thai ? 'ไม่ระบุหลุม' : 'Unassigned')) : ''
  const priorStage = activeEmbryo && stages.find((stage: ApiItem) => String(stage.stageCode) === String(activeEmbryo.priorStageCode))
  const disabledReason = !entry ? (thai ? 'กำลังโหลดหลุมทดลอง…' : 'Loading wells…') : saving ? (thai ? 'กำลังบันทึก…' : 'Saving…') : pending.length > 0 ? (unreviewedCount ? (thai ? `ยังไม่ตรวจ ${unreviewedCount} ฟอง; เลือกระยะเพื่อรวมในการยืนยัน` : `${unreviewedCount} unreviewed; select a stage to include them`) : (thai ? 'พร้อมยืนยัน' : 'Ready to confirm')) : queuedCount > 0 ? (thai ? `รอส่ง ${queuedCount} รายการ` : `${queuedCount} queued for delivery`) : unreviewedCount > 0 ? (thai ? 'เลือกระยะอย่างน้อยหนึ่งฟองก่อนยืนยัน' : 'Select a stage for at least one embryo before confirming') : (thai ? 'ยังไม่มีรายการที่พร้อมบันทึก' : 'There are no unsaved observations to confirm')

  const applyResults = useCallback((result: ApiQueueResult, submitted: ObservationDraft[]) => {
    const rows = (result.results as ObservationResult[] | undefined) ?? []; const rejected = rows.filter((item) => item.status === 'rejected')
    const successfulIds = rows.flatMap((item, index) => item.id && item.status !== 'rejected' && submitted[index]?.embryoId != null ? [String(submitted[index].embryoId)] : [])
    setQueuedIds((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !submitted.some((item) => String(item.embryoId) === id))))
    setSavedIds((current) => ({ ...current, ...Object.fromEntries(rows.flatMap((item, index) => item.id && item.status !== 'rejected' && submitted[index]?.embryoId != null ? [[String(submitted[index].embryoId), String(item.id)]] : [])) }))
    if (successfulIds.length) { setLastSavedIds(successfulIds); setUndoUntil(Date.now() + 10_000) }
    setSaveStatus(rejected.length ? `${thai ? 'บันทึกแล้ว' : 'Saved'} ${rows.length - rejected.length}; ${rejected.length} rejected` : `${thai ? 'บันทึกโดย' : 'Saved by'} ${operatorName}`)
    setError(rejected.map((item) => String(item.error?.message ?? 'Observation rejected')).join(' · '))
  }, [operatorName, thai])

  useEffect(() => {
    const currentEmbryos = new Set(embryos.map((embryo) => String(embryo.embryoId))); const currentObservations = new Set(Object.values(savedIds))
    const bodyEmbryos = (detail: QueuedWrite) => ((detail.body as ApiItem).observations as ObservationDraft[] | undefined) ?? []
    const belongsToRound = (detail: QueuedWrite) => {
      if (detail.path !== '/observations/embryo') return [...currentObservations].some((id) => detail.path.startsWith(`/observations/embryo/${id}`))
      const submitted = bodyEmbryos(detail); return submitted.length > 0 && submitted.every((item) => currentEmbryos.has(String(item.embryoId)))
    }
    const drained = (event: Event) => { const detail = (event as CustomEvent<QueuedWrite & { result?: ApiQueueResult }>).detail; if (detail.result && belongsToRound(detail) && detail.path === '/observations/embryo') applyResults(detail.result, bodyEmbryos(detail)) }
    const rejected = (event: Event) => { const detail = (event as CustomEvent<QueuedWrite>).detail; if (!belongsToRound(detail)) return; const submitted = detail.path === '/observations/embryo' ? bodyEmbryos(detail) : []; setQueuedIds((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !submitted.some((item) => String(item.embryoId) === id)))); setError(detail.lastError ?? 'Observation round write rejected') }
    window.addEventListener('chronofish:queue-drained', drained); window.addEventListener('chronofish:queue-rejected', rejected)
    return () => { window.removeEventListener('chronofish:queue-drained', drained); window.removeEventListener('chronofish:queue-rejected', rejected) }
  }, [applyResults, embryos, savedIds])

  const observationFor = (embryo: ApiItem, observedAt: string) => {
    const id = String(embryo.embryoId)
    return { clientUuid: uuidv7(), embryoId: embryo.embryoId, stageCode: stageCodes[id], observedAt, outcome: embryoOutcomes[id] ?? 'ALIVE', condition: embryoConditions[id] ?? 'NORMAL', notes: notes[id] || null }
  }
  const removeQueuedIds = (items: ObservationDraft[]) => setQueuedIds((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !items.some((item) => String(item.embryoId) === id))))
  const save = async () => {
    if (!entry || pending.length === 0) return
    const observedAt = new Date().toISOString(); const observations = pending.map((embryo) => observationFor(embryo, observedAt))
    setQueuedIds((current) => ({ ...current, ...Object.fromEntries(observations.map((item) => [String(item.embryoId), true])) }))
    setConfirmedAt(observedAt); setError(''); setSaving(true)
    try { const result = await putQueue('/observations/embryo', { observations }); if (result.queued) setSaveStatus(`${thai ? 'รอส่งโดย' : 'Queued by'} ${operatorName}`); else applyResults(result, observations) }
    catch (e) { removeQueuedIds(observations); setError((e as Error).message) } finally { setSaving(false) }
  }
  const correct = async () => {
    if (!correctionReason.trim()) { setError(thai ? 'โปรดระบุเหตุผลที่แก้ไข' : 'Enter a correction reason'); return }
    if (!window.confirm(thai ? 'บันทึกการแก้ไขพร้อมเหตุผลลงในประวัติหรือไม่?' : 'Save this correction with an audit reason?')) return
    setSaving(true); setError('')
    try {
      const savedEmbryos = embryos.filter((embryo) => savedIds[String(embryo.embryoId)])
      const results = await Promise.all(savedEmbryos.map((embryo) => { const id = String(embryo.embryoId); return putQueue(`/observations/embryo/${savedIds[id]}`, { observedAt: confirmedAt, outcome: embryoOutcomes[id], condition: embryoConditions[id], notes: notes[id] || null, correctionReason: correctionReason.trim() }, 'application/json', 'PATCH') }))
      setSaveStatus(`${results.some((result) => result.queued) ? (thai ? 'รอส่งการแก้ไข' : 'Correction queued') : (thai ? 'บันทึกการแก้ไขแล้ว' : 'Correction saved')} ${thai ? 'โดย' : 'by'} ${operatorName}`)
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  const undo = async () => {
    if (!window.confirm(thai ? 'ยกเลิกการบันทึกรอบตรวจล่าสุดหรือไม่?' : 'Undo the last observation round save?')) return
    setSaving(true); setError('')
    try {
      const idsToUndo = lastSavedIds.map((embryoId) => savedIds[embryoId]).filter(Boolean); const results = await Promise.all(idsToUndo.map((id) => putQueue(`/observations/embryo/${id}?reason=undo-within-10-seconds`, undefined, 'application/json', 'DELETE')))
      setSavedIds((current) => Object.fromEntries(Object.entries(current).filter(([embryoId]) => !lastSavedIds.includes(embryoId)))); setLastSavedIds([]); setUndoUntil(0)
      setSaveStatus(results.some((result) => result.queued) ? (thai ? 'รอส่งคำขอยกเลิก' : 'Undo queued') : (thai ? 'ยกเลิกการบันทึกล่าสุดแล้ว' : 'Last save undone'))
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  const applyStageToBlankRows = () => {
    if (!selectedStage || bulkable.length === 0) return
    const ids = bulkable.map((embryo) => String(embryo.embryoId)); setStageCodes((current) => ({ ...current, ...Object.fromEntries(ids.map((id) => [id, selectedStage])) })); setLastBulk({ ids, stage: selectedStage }); setSaveStatus(`${thai ? 'ตั้งระยะให้แล้ว' : 'Stage applied to'} ${ids.length} ${thai ? 'ฟอง' : 'blank embryos'}`)
  }
  const clearLatestBulk = () => {
    if (!lastBulk) return
    setStageCodes((current) => Object.fromEntries(Object.entries(current).map(([id, value]) => lastBulk.ids.includes(id) && value === lastBulk.stage && !savedIds[id] && !queuedIds[id] ? [id, ''] : [id, value]))); setLastBulk(null); setSaveStatus(thai ? 'ล้างการตั้งระยะล่าสุดแล้ว' : 'Latest bulk stage cleared')
  }
  const selectWell = (id: string, scrollToEditor = false) => {
    setSelectedId(id)
    if (scrollToEditor && window.matchMedia?.('(max-width: 780px)')?.matches) window.setTimeout(() => editorHeading.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }), 0)
  }
  const moveWell = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || matchingEmbryos.length === 0) return
    const current = matchingEmbryos[index]; const [currentRow, currentColumn] = wellPositionKey(current.wellPosition); let nextIndex = -1
    if (currentRow !== Number.MAX_SAFE_INTEGER) {
      const sameAxis = matchingEmbryos.flatMap((embryo, candidateIndex) => { const [row, column] = wellPositionKey(embryo.wellPosition); const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'; const matches = horizontal ? row === currentRow : column === currentColumn; const distance = event.key === 'ArrowLeft' ? currentColumn - column : event.key === 'ArrowRight' ? column - currentColumn : event.key === 'ArrowUp' ? currentRow - row : row - currentRow; return matches && distance > 0 ? [{ candidateIndex, distance }] : [] }).sort((left, right) => left.distance - right.distance)
      nextIndex = sameAxis[0]?.candidateIndex ?? -1
    }
    if (nextIndex < 0) nextIndex = Math.min(matchingEmbryos.length - 1, Math.max(0, index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1)))
    if (nextIndex === index || nextIndex < 0) return
    event.preventDefault(); const nextId = String(matchingEmbryos[nextIndex].embryoId); setSelectedId(nextId); window.setTimeout(() => wellButtons.current[nextId]?.focus(), 0)
  }

  return <section className="checkpoint-round">
    <button className="back" onClick={onBack}>← {t.due}</button>
    <div className="page-heading"><div><p className="eyebrow">{String(due.batchCode)} · LOT {String(due.lotNo)}</p><h1>{thai ? 'บันทึกรอบตรวจ Lot' : 'Record lot observation'}</h1><p className="muted">{thai ? `ช่วงที่ระบบแนะนำ: ${String(due.stageLabel)} · เลือกระยะจริงแยกแต่ละฟองในแผ่นหลุม` : `Suggested window: ${String(due.stageLabel)} · scan wells and record only what you observe`}</p></div></div>
    <div className="checkpoint-status" role="status" aria-live="polite"><strong>{thai ? 'ผู้บันทึก' : 'Operator'} {operatorName}</strong><span>{saveStatus}</span></div>
    {error && <ErrorMessage message={error} />}
    <p className="timing-preview">{thai ? 'เวลาจะถูกบันทึกอัตโนมัติเมื่อกดยืนยัน' : 'Observation time is captured automatically when Confirm is pressed.'}{confirmedAt && ` · ${new Date(confirmedAt).toLocaleString()}`}</p>
    <div className="checkpoint-metrics" role="status" aria-live="polite"><div><span aria-hidden="true">•</span><strong>{pending.length} / {recordableEmbryos.length}</strong><small>{thai ? 'พร้อมบันทึก' : 'Ready to save'}</small></div><div><span aria-hidden="true">○</span><strong>{unreviewedCount}</strong><small>{thai ? 'ยังไม่ตรวจ' : 'Unreviewed'}</small></div><div><span aria-hidden="true">!</span><strong>{exceptionCount}</strong><small>{thai ? 'ข้อยกเว้น' : 'Exceptions'}</small></div><div><span aria-hidden="true">✓</span><strong>{savedCount} / {recordableEmbryos.length}</strong><small>{thai ? 'บันทึกแล้ว' : 'Saved'}</small></div></div>
    <div className="checkpoint-shortcuts form-card form-card--inline"><label htmlFor="bulk-stage">{thai ? 'ระยะที่แนะนำสำหรับฟองที่ยังว่าง' : 'Suggested stage for blank embryos'}<select id="bulk-stage" value={selectedStage} onChange={(event) => setSelectedStage(event.target.value)}><option value="">{thai ? 'เลือกระยะ' : 'Choose stage'}</option>{stages.map((stage) => <option key={String(stage.stageCode)} value={String(stage.stageCode)}>{String(stage.stageLabel)}</option>)}</select></label><div className="bulk-action-copy"><strong>{thai ? `การกระทำนี้จะมีผลกับ ${bulkable.length} ฟองที่ยังว่างและยังไม่บันทึก` : `This deliberate action affects ${bulkable.length} blank unsaved embryos.`}</strong><span>{thai ? 'ตรวจทานหลุมที่เป็นข้อยกเว้นได้ทีละหลุมก่อนยืนยัน' : 'Review exception wells individually before confirming.'}</span></div><div className="button-row"><button className="button button--secondary" type="button" disabled={!selectedStage || bulkable.length === 0} onClick={applyStageToBlankRows}>{thai ? `ใช้กับฟองว่าง ${bulkable.length} ฟอง` : `Apply to ${bulkable.length} blank`}</button>{lastBulk && <button className="button button--secondary" type="button" onClick={clearLatestBulk}>{thai ? 'ล้างการตั้งค่าล่าสุด' : 'Undo bulk stage'}</button>}</div></div>
    <div className="checkpoint-workspace">
      <section className="checkpoint-plate" aria-labelledby="checkpoint-plate-heading"><div className="checkpoint-section-heading"><div><h2 id="checkpoint-plate-heading">{thai ? `แผ่นหลุม · เลือกแล้ว ${selectedCount} / ${recordableEmbryos.length}` : `Plate map · ${selectedCount} / ${recordableEmbryos.length} selected`}</h2><p className="muted">{thai ? 'เลือกหลุมเพื่อเปิดตัวแก้ไขด้านข้าง · หลุมตายคงเป็นสีแดงและไม่ต้องตรวจซ้ำ' : 'Select a well to open its editor · dead wells stay red and are not observed again.'}</p></div><span className="checkpoint-selection-note">{thai ? `กำลังแสดง ${matchingEmbryos.length} หลุม` : `Showing ${matchingEmbryos.length} wells`}</span></div>
        <fieldset className="checkpoint-filters"><legend>{thai ? 'ค้นหาและกรองหลุม' : 'Find and filter wells'}</legend><label htmlFor="well-search">{thai ? 'ค้นหา Well ID หรือรหัสตัวอ่อน' : 'Search well ID or embryo code'}<input id="well-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={thai ? 'เช่น A1' : 'e.g. A1'} /></label><label htmlFor="well-filter">{thai ? 'แสดงสถานะ' : 'Show status'}<select id="well-filter" value={viewFilter} onChange={(event) => setViewFilter(event.target.value as WellFilter)}><option value="all">{thai ? 'ทุกหลุม' : 'All wells'}</option><option value="unreviewed">{thai ? 'ยังไม่ตรวจ' : 'Unreviewed'}</option><option value="ready">{thai ? 'พร้อมบันทึก' : 'Ready'}</option><option value="exception">{thai ? 'ข้อยกเว้น' : 'Exceptions'}</option><option value="saved">{thai ? 'บันทึกแล้ว' : 'Saved'}</option></select></label></fieldset>
        <div className="checkpoint-legend" aria-label={thai ? 'คำอธิบายสถานะหลุม' : 'Well status legend'}><span>○ {thai ? 'ยังไม่ตรวจ' : 'Unreviewed'}</span><span>• {thai ? 'พร้อมบันทึก' : 'Ready to save'}</span><span>! {thai ? 'ข้อยกเว้น' : 'Exception'}</span><span>✓ {thai ? 'บันทึกแล้ว' : 'Saved'}</span><span>× {thai ? 'ตาย · ไม่ตรวจซ้ำ' : 'Dead · no further observation'}</span></div>
        {!matchingEmbryos.length ? <div className="empty"><p>{thai ? 'ไม่พบหลุมตามตัวกรอง' : 'No wells match this filter.'}</p><button className="button button--secondary" type="button" onClick={() => { setViewFilter('all'); setSearch('') }}>{thai ? 'แสดงทุกหลุม' : 'Show all wells'}</button></div> : <div className="well-grid checkpoint-grid" role="grid" aria-label={thai ? 'แผ่นหลุมตัวอ่อน' : 'Embryo plate wells'} aria-colcount={12}>{matchingEmbryos.map((embryo, index) => {
          const id = String(embryo.embryoId); const well = String(embryo.wellPosition ?? (thai ? 'ไม่ระบุหลุม' : 'Unassigned')); const state = stateFor(embryo)
          return <div role="gridcell" aria-selected={id === selectedId} key={id}><button ref={(button) => { wellButtons.current[id] = button }} id={wellButtonId(id)} data-well={well} type="button" className={`well-cell well-cell--${state}${id === selectedId ? ' well-cell--selected' : ''}`} aria-label={`${thai ? 'หลุม' : 'Well'} ${well}, ${String(embryo.embryoCode ?? '')}, ${stateLabel(state)}${id === selectedId ? `, ${thai ? 'กำลังเลือก' : 'selected'}` : ''}`} aria-pressed={id === selectedId} tabIndex={id === selectedId || (!selectedId && index === 0) ? 0 : -1} onClick={() => selectWell(id, true)} onKeyDown={(event) => moveWell(event, index)}><strong>{well}</strong><small title={String(embryo.embryoCode ?? '')}>{String(embryo.embryoCode ?? '')}</small><span><b aria-hidden="true">{state === 'dead' ? '×' : state === 'saved' ? '✓' : state === 'exception' ? '!' : state === 'unreviewed' ? '○' : state === 'queued' ? '↺' : '•'}</b> {stateLabel(state)}</span></button></div>
        })}</div>}
      </section>
      <aside className="checkpoint-editor" aria-labelledby="checkpoint-editor-heading">{activeEmbryo ? <>
        <div ref={editorHeading} className="checkpoint-editor__heading" aria-live="polite"><p className="eyebrow">{thai ? 'หลุมที่เลือก' : 'Selected well'}</p><h2 id="checkpoint-editor-heading">{activeWell}</h2><p className="checkpoint-editor__code" title={String(activeEmbryo.embryoCode ?? '')}>{String(activeEmbryo.embryoCode ?? '')}</p>{activeEmbryo.priorStageCode != null && <p className="muted">{thai ? 'ครั้งก่อน' : 'Previous'}: {String(priorStage?.stageLabel ?? '—')}{activeEmbryo.priorOutcome ? ` · ${outcomeLabel(isPersistentlyDead(activeEmbryo) ? 'DEAD' : 'ALIVE', thai)}` : ''}</p>}</div>
        {isPersistentlyDead(activeEmbryo) ? <div className="checkpoint-dead-notice" role="status"><strong>{thai ? 'ตาย' : 'Dead'}</strong><p>{thai ? 'หลุมนี้ถูกบันทึกว่าตายแล้ว จึงคงเป็นสีแดงและไม่ต้องบันทึกผลซ้ำในรอบต่อไป' : 'This embryo was recorded dead. The well stays red and is excluded from future observations.'}</p></div> : <>
          <fieldset className="checkpoint-editor__fields"><legend>{thai ? `ผลการตรวจ ${activeWell}` : `Observation for ${activeWell}`}</legend><label htmlFor="active-stage">{thai ? 'ระยะที่เห็น' : 'Observed stage'}<select id="active-stage" aria-label={`${thai ? 'ระยะของหลุม' : 'Stage for well'} ${activeWell}`} value={stageCodes[activeId] ?? ''} disabled={Boolean(savedIds[activeId] || queuedIds[activeId])} onChange={(event) => setStageCodes((current) => ({ ...current, [activeId]: event.target.value }))}><option value="">{thai ? 'ยังไม่เลือกระยะ' : 'Select observed stage'}</option>{stages.map((stage) => <option key={String(stage.stageCode)} value={String(stage.stageCode)}>{String(stage.stageLabel)}</option>)}</select></label><label htmlFor="active-outcome">{thai ? 'สถานะ' : 'Outcome'}<select id="active-outcome" aria-label={`${thai ? 'สถานะของหลุม' : 'Outcome for well'} ${activeWell}`} value={embryoOutcomes[activeId] ?? 'ALIVE'} onChange={(event) => setEmbryoOutcomes((current) => ({ ...current, [activeId]: event.target.value as EmbryoOutcome }))}>{outcomes.map((outcome) => <option key={outcome} value={outcome}>{outcomeLabel(outcome, thai)}</option>)}</select></label><label htmlFor="active-condition">{thai ? 'สภาพ' : 'Condition'}<select id="active-condition" aria-label={`${thai ? 'สภาพของหลุม' : 'Condition for well'} ${activeWell}`} value={embryoConditions[activeId] ?? 'NORMAL'} onChange={(event) => setEmbryoConditions((current) => ({ ...current, [activeId]: event.target.value }))}>{conditions.map((condition) => <option key={condition} value={condition}>{conditionLabel(condition, thai)}</option>)}</select></label></fieldset>
          <details className="checkpoint-notes"><summary>{notes[activeId] ? (thai ? 'แก้ไขหมายเหตุ' : 'Edit notes') : (thai ? 'เพิ่มหมายเหตุ (ไม่บังคับ)' : 'Add notes (optional)')}</summary><label htmlFor="active-notes">{thai ? 'หมายเหตุ' : 'Notes'}<textarea id="active-notes" rows={4} value={notes[activeId] ?? ''} onChange={(event) => setNotes((current) => ({ ...current, [activeId]: event.target.value }))} /></label></details>
        </>}
        {activeEmbryo.firstAbnormalStageLabel && <p className="checkpoint-warning"><span aria-hidden="true">!</span>{thai ? `เคยพบความผิดปกติที่ระยะ ${String(activeEmbryo.firstAbnormalStageLabel)}` : `Abnormality was first recorded at ${String(activeEmbryo.firstAbnormalStageLabel)}.`}</p>}
        {savedCount > 0 && <form className="checkpoint-correction" onSubmit={(event) => { event.preventDefault(); void correct() }}><h3>{thai ? 'แก้ไขผลที่บันทึกแล้ว' : 'Correct saved results'}</h3><label htmlFor="correction-reason">{thai ? 'เหตุผลที่แก้ไข' : 'Correction reason'}<input id="correction-reason" required value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} /></label><div className="button-row"><button className="button button--secondary" disabled={saving}>{thai ? 'บันทึกการแก้ไข' : 'Save correction'}</button>{lastSavedIds.length > 0 && undoUntil >= Date.now() && <button className="button button--secondary" type="button" onClick={() => void undo()}>{thai ? 'ยกเลิกการบันทึกล่าสุด' : 'Undo last save'}</button>}</div></form>}
        <button className="checkpoint-editor__return button button--secondary" type="button" onClick={() => { const button = wellButtons.current[activeId]; button?.scrollIntoView?.({ behavior: 'smooth', block: 'center' }); button?.focus() }}>{thai ? 'กลับไปที่แผ่นหลุม' : 'Return to plate'}</button>
      </> : <p className="muted">{thai ? 'เลือกหลุมเพื่อเริ่มบันทึก' : 'Select a well to start recording.'}</p>}</aside>
    </div>
    <div className="checkpoint-action-bar" aria-describedby="checkpoint-confirm-explainer"><div><strong>{thai ? 'ยืนยันผลการตรวจ' : 'Confirm observations'}</strong><span id="checkpoint-confirm-explainer">{disabledReason}</span></div><button className="button button--primary" disabled={saving || !entry || pending.length === 0} onClick={() => void save()}>{saving ? t.saving : thai ? `ยืนยัน ${pending.length} รายการ` : `Confirm ${pending.length} observations`}</button></div>
  </section>
}
