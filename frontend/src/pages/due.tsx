import { useCallback, useEffect, useMemo, useState } from 'react'
import { type ApiItem, get } from '../api/client'
import { putQueue } from '../offline'
import { type AppText } from '../types'
import { Empty, ErrorMessage } from '../components'
import { dateTimeLocalToRFC3339, rfc3339ToDateTimeLocal } from '../time'
import { uuidv7 } from '../uuidv7'

type EmbryoOutcome = 'ALIVE' | 'DEAD' | 'DEGENERATED' | 'NOT_OBSERVED'
const outcomeCycle: EmbryoOutcome[] = ['ALIVE', 'DEAD', 'DEGENERATED']

export function Due({ t, onPendingChange }: { t: AppText; onPendingChange: (count: number) => void }) {
  const [data, setData] = useState<ApiItem>({ overdue: [], upcoming: [] })
  const [selected, setSelected] = useState<ApiItem | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    void get('/due-checkpoints').then((value) => {
      setData(value)
      onPendingChange(value.pendingPromotionCount ?? 0)
    }).catch((e: Error) => setError(e.message))
  }, [onPendingChange])
  useEffect(() => { load(); const timer = window.setInterval(load, 60_000); return () => window.clearInterval(timer) }, [load])
  if (selected) return <Checkpoint due={selected} t={t} onBack={() => setSelected(null)} />
  const items = [...(data.overdue ?? []), ...(data.upcoming ?? [])]
  return <section>
    <div className="page-heading"><div><p className="eyebrow">STAGE 1</p><h1>{t.due}</h1><p className="muted">Sorted by urgency. Refreshes every 60 seconds.</p></div><button className="button button--secondary" onClick={load}>{t.refresh}</button></div>
    {error && <ErrorMessage message={error} />}
    {items.length === 0 ? <Empty message={t.empty} /> : <div className="list">{items.map((item: ApiItem) => {
      const late = item.minutesLate ?? 0
      return <button key={`${item.injectionLotId}-${item.stageCode}`} className="list-row" onClick={() => setSelected(item)}><span><strong>{String(item.batchCode)} / Lot {String(item.lotNo)}</strong><small>{String(item.stageLabel)} · {String(item.stageCode)}</small></span><span className={late > 0 ? 'pill pill--late' : 'pill'}>{late > 0 ? `Late ${late} min` : 'Due soon'}</span></button>
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
  const total = embryos.length
  const alive = Object.values(outcomes).filter((outcome) => outcome === 'ALIVE').length
  const activatedAt = String(entry?.activatedAt ?? due.activatedAt ?? '')
  const activatedMs = Date.parse(activatedAt)
  const elapsedMinutes = Number.isNaN(activatedMs) ? null : Math.max(0, Math.floor((now - activatedMs) / 60_000))
  const expected = Number(entry?.expectedHpa ?? 0)
  const actual = elapsedMinutes === null ? null : elapsedMinutes / 60
  const deviation = actual === null ? null : actual - expected
  const deviationLabel = deviation === null || Math.abs(deviation) < 1 / 60 ? 'ตรงกับสากล' : `${deviation < 0 ? 'เร็วกว่า' : 'ช้ากว่า'}สากล ${Math.floor(Math.abs(deviation))} ชม. ${Math.round((Math.abs(deviation) % 1) * 60)} นาที`
  const stageOrder = Number((entry?.stage as ApiItem | undefined)?.stageOrder ?? due.stageOrder ?? 0)
  const progressLabel = `Checkpoint ${stageOrder || '?'} / 26 · Survivors ${alive} / ${total}`
  const timeLabel = elapsedMinutes === null ? 'T+—' : `T+${String(Math.floor(elapsedMinutes / 60)).padStart(2, '0')}:${String(elapsedMinutes % 60).padStart(2, '0')}`

  const setAll = (outcome: EmbryoOutcome) => setOutcomes(Object.fromEntries(embryos.map((embryo: ApiItem) => [String(embryo.embryoId), outcome])))
  const cycle = (id: string) => {
    const current = outcomes[id] ?? 'ALIVE'
    const next = outcomeCycle[(outcomeCycle.indexOf(current) + 1) % outcomeCycle.length]
    setOutcomes((values) => ({ ...values, [id]: next }))
  }
  const save = async () => {
    if (!entry) return
    if (Object.values(outcomes).some((outcome) => outcome === 'ALIVE') && !overrideReason.trim() && entry.requiresOverrideReason) {
      setError('Enter an override reason before recording ALIVE after an exit event.')
      return
    }
    setSaving(true)
    const observations = embryos.map((embryo: ApiItem) => ({
      clientUuid: uuidv7(), embryoId: embryo.embryoId, stageCode: due.stageCode,
      observedAt: dateTimeLocalToRFC3339(observedAt), outcome: outcomes[String(embryo.embryoId)] ?? 'ALIVE',
      condition: conditions[String(embryo.embryoId)] ?? 'NORMAL', notes: notes[String(embryo.embryoId)] || null,
      ...(overrideReason.trim() ? { overrideReason: overrideReason.trim() } : {}),
    }))
    try { await putQueue('/observations/embryo', { observations }); onBack() } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  return <section>
    <button className="back" onClick={onBack}>← {t.due}</button>
    <div className="page-heading"><div><p className="eyebrow">{String(due.batchCode)} / LOT {String(due.lotNo)}</p><h1>{String(due.stageLabel)}</h1><p className="muted">{progressLabel} · {timeLabel}</p></div><button className="button button--primary" disabled={saving || !entry} onClick={save}>{saving ? 'Saving…' : 'Save checkpoint'}</button></div>
    {error && <ErrorMessage message={error} />}
    <div className="metric-grid"><div className="metric"><span>Actual HPA</span><strong>{actual === null ? '—' : actual.toFixed(4)}</strong></div><div className="metric"><span>Expected HPA</span><strong>{expected.toFixed(4)}</strong></div><div className="metric"><span>Deviation</span><strong>{deviation === null ? '—' : `${deviation >= 0 ? '+' : ''}${deviation.toFixed(4)} h · ${deviationLabel}`}</strong></div></div>
    <div className="button-row checkpoint-shortcuts"><button className="button button--secondary" type="button" onClick={() => setAll('ALIVE')}>All alive</button><button className="button button--secondary" type="button" onClick={() => setAll('DEAD')}>All remaining dead</button></div>
    <label className="form-card">Observed at<input type="datetime-local" value={observedAt} onChange={(event) => setObservedAt(event.target.value)} /></label>
    <label className="form-card">Override reason (required for an exit override)<input value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} placeholder="Why this checkpoint overrides the exit state" /></label>
    {entry && <div className="well-grid">{embryos.map((embryo: ApiItem) => { const id = String(embryo.embryoId); const outcome = outcomes[id] ?? 'ALIVE'; return <div className="well" key={id}><strong>{String(embryo.wellPosition ?? '—')}</strong><small>{String(embryo.embryoCode)}</small><button type="button" className={`outcome outcome--${outcome.toLowerCase()}`} aria-label={`Cycle outcome for ${String(embryo.embryoCode)}`} onClick={() => cycle(id)}>{outcome}</button><label>Condition<select value={conditions[id] ?? 'NORMAL'} onChange={(event) => setConditions({ ...conditions, [id]: event.target.value })}><option>NORMAL</option><option>ABNORMAL</option><option>UNDETERMINED</option></select></label><label>Notes<input value={notes[id] ?? ''} onChange={(event) => setNotes({ ...notes, [id]: event.target.value })} /></label></div> })}</div>}
  </section>
}
