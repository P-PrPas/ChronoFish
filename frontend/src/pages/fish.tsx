import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { type ApiItem, get } from '../api/client'
import { putQueue, type QueuedWrite } from '../offline'
import { type AppText } from '../types'
import { Empty, ErrorMessage, ReportTable } from '../components'

export function Fish({ t, onPendingChange }: { t: AppText; onPendingChange: (count: number) => void }) {
  const [items, setItems] = useState<ApiItem[]>([])
  const [selectedFish, setSelectedFish] = useState('')
  const [error, setError] = useState('')
  const date = new Date().toISOString().slice(0, 10)
  const load = useCallback(() => { void get(`/fish/roll-call?date=${date}`).then((data) => { setItems(data.items ?? []); onPendingChange(0) }).catch((e: Error) => setError(e.message)) }, [date, onPendingChange])
  useEffect(load, [load])
  useEffect(() => { const refresh = () => load(); const reject = (event: Event) => { const detail = (event as CustomEvent<QueuedWrite>).detail; if (detail.path === '/observations/fish') setError(detail.lastError ?? 'Queued observations rejected') }; window.addEventListener('chronofish:queue-drained', refresh); window.addEventListener('chronofish:queue-rejected', reject); return () => { window.removeEventListener('chronofish:queue-drained', refresh); window.removeEventListener('chronofish:queue-rejected', reject) } }, [load])
  const markAlive = async () => { const observations = items.filter((item) => !item.alreadyRecorded).map((item) => ({ clientUuid: crypto.randomUUID(), cloneFishId: item.fishId, observedOn: date, outcome: 'ALIVE', condition: item.condition ?? 'NORMAL' })); if (!observations.length) return; const previous = items; setItems(items.map((item) => item.alreadyRecorded ? item : { ...item, alreadyRecorded: true })); try { const result = await putQueue('/observations/fish', { observations }); if (!result.queued) load() } catch (e) { setItems(previous); setError((e as Error).message) } }
  if (selectedFish) return <FishDetail fishId={selectedFish} onBack={() => setSelectedFish('')} />
  return <section><div className="page-heading"><div><p className="eyebrow">STAGE 2 / {date}</p><h1>{t.fish}</h1><p className="muted">Daily roll-call for fish currently marked ALIVE.</p></div><button className="button button--primary" onClick={markAlive}>{t.allAlive}</button></div>{error && <ErrorMessage message={error} />}{items.length === 0 ? <Empty message={t.empty} /> : <div className="list">{items.map((fish) => <button className="list-row" key={String(fish.fishId)} onClick={() => setSelectedFish(String(fish.fishId))}><span><strong>{String(fish.fishCode)}</strong><small>{String(fish.ageDays ?? '—')} days · {String(fish.condition ?? '—')}</small></span><span className={fish.alreadyRecorded ? 'pill pill--done' : 'pill'}>{fish.alreadyRecorded ? 'Recorded' : 'Needs record'}</span></button>)}</div>}</section>
}

function FishDetail({ fishId, onBack }: { fishId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<ApiItem | null>(null)
  const [error, setError] = useState('')
  const [specimen, setSpecimen] = useState({ specimenCode: '', specimenKind: 'CL', specimenType: 'CAUDAL_FIN_CLIP' })
  const [saving, setSaving] = useState(false)
  const load = useCallback(() => { void get(`/fish/${fishId}`).then(setDetail).catch((e: Error) => setError(e.message)) }, [fishId])
  useEffect(load, [load])
  const saveSpecimen = async (event: FormEvent) => { event.preventDefault(); setSaving(true); try { await putQueue(`/fish/${fishId}/specimens`, specimen); setSpecimen({ specimenCode: '', specimenKind: 'CL', specimenType: 'CAUDAL_FIN_CLIP' }); await load() } catch (e) { setError((e as Error).message) } finally { setSaving(false) } }
  if (!detail) return <section><button className="back" onClick={onBack}>← Fish registry</button>{error ? <ErrorMessage message={error} /> : <p className="notice">Loading fish record…</p>}</section>
  const observations = (detail.observations as ApiItem[] | undefined) ?? (detail.timeline as ApiItem[] | undefined) ?? []
  const specimens = (detail.specimens as ApiItem[] | undefined) ?? []
  return <section><button className="back" onClick={onBack}>← Fish registry</button><div className="page-heading"><div><p className="eyebrow">FISH DETAIL / TIMELINE</p><h1>{String(detail.fishCode)}</h1><p className="muted">DOB {String(detail.dob ?? '—')} · {String(detail.status ?? '—')} · {String(detail.condition ?? '—')}</p></div></div>{error && <ErrorMessage message={error} />}<ReportTable headers={['Observed on', 'Age days', 'Outcome', 'Condition', 'Notes']} rows={observations.map((item) => [String(item.observedOn ?? '—'), item.ageDays ?? '—', String(item.outcome ?? '—'), String(item.condition ?? '—'), String(item.notes ?? '')])} /><form className="form-card form-card--inline" onSubmit={saveSpecimen}><label>Specimen code<input required value={specimen.specimenCode} onChange={(event) => setSpecimen({ ...specimen, specimenCode: event.target.value })} /></label><label>Kind<select value={specimen.specimenKind} onChange={(event) => setSpecimen({ ...specimen, specimenKind: event.target.value })}><option>CL</option><option>RT</option><option>DC</option></select></label><label>Type<select value={specimen.specimenType} onChange={(event) => setSpecimen({ ...specimen, specimenType: event.target.value })}><option>CAUDAL_FIN_CLIP</option><option>WHOLE_EMBRYO</option></select></label><button className="button button--primary" disabled={saving}>Add specimen</button></form><ReportTable headers={['Specimen', 'Kind', 'Type', 'Collected']} rows={specimens.map((item) => [String(item.specimenCode ?? '—'), String(item.specimenKind ?? '—'), String(item.specimenType ?? '—'), String(item.collectedOn ?? '—')])} /></section>
}
