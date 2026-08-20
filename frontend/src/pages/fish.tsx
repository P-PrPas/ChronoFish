import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { type ApiItem, get } from '../api/client'
import { putQueue, type QueuedWrite } from '../offline'
import { type AppText } from '../types'
import { Empty, ErrorMessage, ReportTable } from '../components'

type FishOutcome = 'ALIVE' | 'DEAD' | 'FROZEN' | 'DISCARDED'
type FishCondition = 'NORMAL' | 'ABNORMAL' | 'UNDETERMINED'
const outcomes: FishOutcome[] = ['ALIVE', 'DEAD', 'FROZEN', 'DISCARDED']
const outcomeLabel = (outcome: FishOutcome) => outcome.charAt(0) + outcome.slice(1).toLowerCase()
const bangkokDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date())

export function Fish({ t, onPendingChange }: { t: AppText; onPendingChange: (count: number) => void }) {
  const [mode, setMode] = useState<'rollcall' | 'registry'>('rollcall')
  const [date, setDate] = useState(bangkokDate())
  const [items, setItems] = useState<ApiItem[]>([])
  const [registry, setRegistry] = useState<ApiItem[]>([])
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [outcomesByFish, setOutcomesByFish] = useState<Record<string, FishOutcome>>({})
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState({ siteId: '', boxId: '', status: '', strain: '', treatmentGroupId: '', dobFrom: '', dobTo: '' })
  const [masters, setMasters] = useState<Record<string, ApiItem[]>>({ sites: [], 'fish-boxes': [], 'treatment-groups': [] })

  const loadRollCall = useCallback(() => {
    void get(`/fish/roll-call?date=${date}`).then((data) => {
      setItems(data.items ?? [])
      onPendingChange(0)
    }).catch((e: Error) => setError(e.message))
  }, [date, onPendingChange])
  const loadRegistry = useCallback(() => {
    void get('/fish?includeInactive=true').then((data) => setRegistry(data.items ?? [])).catch((e: Error) => setError(e.message))
  }, [])
  useEffect(() => {
    void Promise.all(['sites', 'fish-boxes', 'treatment-groups'].map(async (resource) => [resource, (await get(`/${resource}`)).items ?? []] as [string, ApiItem[]]))
      .then((result) => setMasters(Object.fromEntries(result))).catch(() => undefined)
  }, [])
  useEffect(() => { if (mode === 'rollcall') loadRollCall(); else loadRegistry() }, [mode, loadRollCall, loadRegistry])
  useEffect(() => {
    const refresh = () => { loadRollCall(); loadRegistry() }
    const reject = (event: Event) => {
      const detail = (event as CustomEvent<QueuedWrite>).detail
      if (detail.path === '/observations/fish') setError(detail.lastError ?? 'Fish observation was rejected')
    }
    window.addEventListener('chronofish:queue-drained', refresh)
    window.addEventListener('chronofish:queue-rejected', reject)
    return () => {
      window.removeEventListener('chronofish:queue-drained', refresh)
      window.removeEventListener('chronofish:queue-rejected', reject)
    }
  }, [loadRollCall, loadRegistry])

  const record = async (fish: ApiItem, outcome: FishOutcome) => {
    const id = String(fish.fishId)
    setOutcomesByFish((current) => ({ ...current, [id]: outcome }))
    try {
      await putQueue('/observations/fish', { observations: [{ clientUuid: crypto.randomUUID(), cloneFishId: fish.fishId, observedOn: date, outcome, condition: fish.condition ?? 'NORMAL' }] })
      loadRollCall()
    } catch (e) {
      setOutcomesByFish((current) => { const next = { ...current }; delete next[id]; return next })
      setError((e as Error).message)
    }
  }
  const markAlive = async () => {
    const pending = items.filter((item) => !item.alreadyRecorded)
    const lots = new Map<string, ApiItem[]>()
    for (const fish of pending) {
      const lot = String(fish.injectionLotId ?? 'unassigned')
      lots.set(lot, [...(lots.get(lot) ?? []), fish])
    }
    for (const group of lots.values()) {
      for (const fish of group) setOutcomesByFish((current) => ({ ...current, [String(fish.fishId)]: 'ALIVE' }))
      try {
        await putQueue('/observations/fish', { observations: group.map((fish) => ({ clientUuid: crypto.randomUUID(), cloneFishId: fish.fishId, observedOn: date, outcome: 'ALIVE', condition: fish.condition ?? 'NORMAL' })) })
      } catch (e) { setError((e as Error).message); break }
    }
    loadRollCall()
  }
  const visible = useMemo(() => registry.filter((fish) =>
    (!filters.siteId || String(fish.siteId) === filters.siteId) &&
    (!filters.boxId || String(fish.fishBoxId) === filters.boxId) &&
    (!filters.status || String(fish.status) === filters.status) &&
    (!filters.treatmentGroupId || String(fish.treatmentGroupId) === filters.treatmentGroupId) &&
    (!filters.strain || String(fish.strain ?? '').toLowerCase().includes(filters.strain.toLowerCase())) &&
    (!filters.dobFrom || String(fish.dob) >= filters.dobFrom) &&
    (!filters.dobTo || String(fish.dob) <= filters.dobTo) &&
    (!search || `${fish.fishCode ?? ''} ${fish.strain ?? ''}`.toLowerCase().includes(search.toLowerCase()))
  ), [registry, filters, search])

  if (selected) return <FishDetail fishId={selected} masters={masters} onBack={() => setSelected('')} />
  return <section>
    <div className="page-heading"><div><p className="eyebrow">STAGE 2 / REGISTRY</p><h1>{t.fish}</h1><p className="muted">Bangkok date: {date}. One request per injection lot for All Alive.</p></div><div className="button-row">{mode === 'rollcall' && <button className="button button--secondary" onClick={() => void markAlive()}>{t.allAlive}</button>}<button className="button button--primary" onClick={() => setShowCreate(true)}>Register fish</button></div></div>
    <div className="tabs" role="tablist"><button role="tab" aria-selected={mode === 'rollcall'} className={mode === 'rollcall' ? 'tab tab--active' : 'tab'} onClick={() => setMode('rollcall')}>Daily roll-call</button><button role="tab" aria-selected={mode === 'registry'} className={mode === 'registry' ? 'tab tab--active' : 'tab'} onClick={() => setMode('registry')}>Fish registry</button></div>
    {showCreate && <ManualFishForm masters={masters} onSaved={() => { setShowCreate(false); loadRegistry() }} onCancel={() => setShowCreate(false)} />}
    {error && <ErrorMessage message={error} />}
    {mode === 'rollcall' ? <>
      <label className="form-card">Roll-call date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
      {items.length === 0 ? <Empty message={t.empty} /> : <div className="list">{items.map((fish) => {
        const id = String(fish.fishId)
        const value = outcomesByFish[id] ?? (fish.alreadyRecorded ? String(fish.status ?? 'ALIVE') as FishOutcome : 'ALIVE')
        return <div className="list-row" key={id}><button className="fish-row-main" onClick={() => setSelected(id)}><strong>{String(fish.fishCode)}</strong><small>{String(fish.ageDays ?? '—')} days · {String(fish.condition ?? '—')} · first abnormality {String(fish.firstAbnormalOn ?? '—')}</small></button><div className="button-row">{outcomes.map((outcome) => <button key={outcome} className={value === outcome ? 'button button--primary' : 'button button--secondary'} onClick={() => void record(fish, outcome)}>{outcomeLabel(outcome)}</button>)}</div></div>
      })}</div>}
    </> : <>
      <fieldset className="filter-bar"><legend>Registry filters</legend><label>Search<input value={search} onChange={(event) => setSearch(event.target.value)} /></label><label>Site<select value={filters.siteId} onChange={(event) => setFilters({ ...filters, siteId: event.target.value })}><option value="">All</option>{(masters.sites ?? []).map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.code ?? item.name)}</option>)}</select></label><label>Box<select value={filters.boxId} onChange={(event) => setFilters({ ...filters, boxId: event.target.value })}><option value="">All</option>{(masters['fish-boxes'] ?? []).map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.boxCode ?? item.code)}</option>)}</select></label><label>Status<select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">All</option>{outcomes.map((value) => <option key={value}>{value}</option>)}</select></label><label>Strain<input value={filters.strain} onChange={(event) => setFilters({ ...filters, strain: event.target.value })} /></label><label>Treatment<select value={filters.treatmentGroupId} onChange={(event) => setFilters({ ...filters, treatmentGroupId: event.target.value })}><option value="">All</option>{(masters['treatment-groups'] ?? []).map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.code ?? item.name)}</option>)}</select></label><label>DOB from<input type="date" value={filters.dobFrom} onChange={(event) => setFilters({ ...filters, dobFrom: event.target.value })} /></label><label>DOB to<input type="date" value={filters.dobTo} onChange={(event) => setFilters({ ...filters, dobTo: event.target.value })} /></label><button type="button" className="button button--secondary" onClick={() => setFilters({ siteId: '', boxId: '', status: '', strain: '', treatmentGroupId: '', dobFrom: '', dobTo: '' })}>Clear</button></fieldset>
      {visible.length === 0 ? <Empty message="No fish match these filters" /> : <div className="list">{visible.map((fish) => <button className="list-row" key={String(fish.id)} onClick={() => setSelected(String(fish.id))}><span><strong>{String(fish.fishCode)}</strong><small>Strain {String(fish.strain ?? 'Unknown')} · DOB {String(fish.dob ?? '—')} · first abnormality {String(fish.firstAbnormalOn ?? '—')}</small></span><span className="pill">{String(fish.status ?? '—')}</span></button>)}</div>}
    </>}
  </section>
}

function ManualFishForm({ masters, onSaved, onCancel }: { masters: Record<string, ApiItem[]>; onSaved: () => void; onCancel: () => void }) {
  const [form, setForm] = useState({ fishCode: '', dob: bangkokDate(), donorCellLineId: '', siteId: '', fishBoxId: '', condition: 'NORMAL', sex: 'UNKNOWN', remarks: '' })
  const [donors, setDonors] = useState<ApiItem[]>([]); const [error, setError] = useState('')
  useEffect(() => { void get('/donor-cell-lines').then((data) => setDonors(data.items ?? [])) }, [])
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await putQueue('/fish', { ...form, siteId: form.siteId || null, fishBoxId: form.fishBoxId || null }); onSaved() } catch (e) { setError((e as Error).message) } }
  return <form className="form-card" onSubmit={submit}><h2>Register clone fish</h2><div className="form-card--inline"><label>Fish code<input required value={form.fishCode} onChange={(e) => setForm({ ...form, fishCode: e.target.value })} /></label><label>DOB<input required type="date" value={form.dob} onChange={(e) => setForm({ ...form, dob: e.target.value })} /></label><label>Donor<select required value={form.donorCellLineId} onChange={(e) => setForm({ ...form, donorCellLineId: e.target.value })}><option value="">Select donor</option>{donors.map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.strain ?? item.id)}</option>)}</select></label></div><div className="form-card--inline"><label>Site<select value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}><option value="">No site</option>{(masters.sites ?? []).map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.code ?? item.name)}</option>)}</select></label><label>Fish box<select value={form.fishBoxId} onChange={(e) => setForm({ ...form, fishBoxId: e.target.value })}><option value="">No box</option>{(masters['fish-boxes'] ?? []).map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.boxCode ?? item.code)}</option>)}</select></label><label>Sex<select value={form.sex} onChange={(e) => setForm({ ...form, sex: e.target.value })}><option>UNKNOWN</option><option>M</option><option>F</option></select></label></div><label>Remarks<input value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} /></label>{error && <ErrorMessage message={error} />}<div className="button-row"><button className="button button--primary">Save fish</button><button type="button" className="button button--secondary" onClick={onCancel}>Cancel</button></div></form>
}

function FishDetail({ fishId, masters, onBack }: { fishId: string; masters: Record<string, ApiItem[]>; onBack: () => void }) {
  const [detail, setDetail] = useState<ApiItem | null>(null); const [error, setError] = useState(''); const [fishEdit, setFishEdit] = useState({ fishCode: '', sex: 'UNKNOWN', fishBoxId: '', remarks: '' }); const [specimen, setSpecimen] = useState({ specimenCode: '', specimenKind: 'CL', specimenType: 'CAUDAL_FIN_CLIP', collectedOn: bangkokDate(), frozenOn: '', storage: '', notes: '', markFinClipped: false }); const [editing, setEditing] = useState<ApiItem | null>(null); const [reason, setReason] = useState('')
  const load = useCallback(() => { void get(`/fish/${fishId}`).then((value) => { setDetail(value); setFishEdit({ fishCode: String(value.fishCode ?? ''), sex: String(value.sex ?? 'UNKNOWN'), fishBoxId: String(value.fishBoxId ?? ''), remarks: String(value.remarks ?? '') }) }).catch((e: Error) => setError(e.message)) }, [fishId]); useEffect(load, [load])
  const saveFish = async (event: FormEvent) => { event.preventDefault(); try { await putQueue(`/fish/${fishId}`, { ...fishEdit, fishBoxId: fishEdit.fishBoxId || null }, 'application/json', 'PATCH'); load() } catch (e) { setError((e as Error).message) } }
  const saveSpecimen = async (event: FormEvent) => { event.preventDefault(); try { await putQueue(`/fish/${fishId}/specimens`, { ...specimen, frozenOn: specimen.frozenOn || null, storage: specimen.storage || null }); setSpecimen({ ...specimen, specimenCode: '' }); load() } catch (e) { setError((e as Error).message) } }
  const correct = async (event: FormEvent) => { event.preventDefault(); if (!editing || !reason.trim()) return; try { await putQueue(`/observations/fish/${editing.id}`, { correctionReason: reason, observedOn: editing.observedOn, outcome: editing.outcome, condition: editing.condition, notes: editing.notes }, 'application/json', 'PATCH'); setEditing(null); setReason(''); load() } catch (e) { setError((e as Error).message) } }
  const remove = async (item: ApiItem) => { const deleteReason = window.prompt('Reason for deleting this observation'); if (!deleteReason?.trim()) return; try { await putQueue(`/observations/fish/${item.id}?reason=${encodeURIComponent(deleteReason)}`, undefined, 'application/json', 'DELETE'); load() } catch (e) { setError((e as Error).message) } }
  if (!detail) return <section><button className="back" onClick={onBack}>← Fish registry</button>{error ? <ErrorMessage message={error} /> : <p className="notice">Loading fish record...</p>}</section>
  const observations = (detail.observations as ApiItem[] | undefined) ?? []; const specimens = (detail.specimens as ApiItem[] | undefined) ?? []
  return <section><button className="back" onClick={onBack}>← Fish registry</button><div className="page-heading"><div><p className="eyebrow">FISH DETAIL / TIMELINE</p><h1>{String(detail.fishCode)}</h1><p className="muted">Strain {String(detail.strain ?? '—')} · DOB {String(detail.dob ?? '—')} · {String(detail.status ?? '—')}</p><p className="muted">First abnormality: {String(detail.firstAbnormalOn ?? '—')} · age {String(detail.firstAbnormalAgeDays ?? '—')}</p></div></div>{error && <ErrorMessage message={error} />}<form className="form-card form-card--inline" onSubmit={saveFish}><label>Fish code<input required value={fishEdit.fishCode} onChange={(event) => setFishEdit({ ...fishEdit, fishCode: event.target.value })} /></label><label>Sex<select value={fishEdit.sex} onChange={(event) => setFishEdit({ ...fishEdit, sex: event.target.value })}><option>UNKNOWN</option><option>M</option><option>F</option></select></label><label>Fish box<select value={fishEdit.fishBoxId} onChange={(event) => setFishEdit({ ...fishEdit, fishBoxId: event.target.value })}><option value="">No box</option>{(masters['fish-boxes'] ?? []).map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.boxCode ?? item.code)}</option>)}</select></label><label>Remarks<input value={fishEdit.remarks} onChange={(event) => setFishEdit({ ...fishEdit, remarks: event.target.value })} /></label><button className="button button--primary">Save fish</button></form><ReportTable headers={['Observed on', 'Age', 'Outcome', 'Condition']} rows={observations.map((item) => [String(item.observedOn ?? '—'), String(item.ageDays ?? '—'), String(item.outcome ?? '—'), String(item.condition ?? '—')])} />{observations.map((item) => <div className="button-row" key={String(item.id)}><button className="inline-action" onClick={() => { setEditing(item); setReason('') }}>Correct</button><button className="inline-action inline-action--danger" onClick={() => void remove(item)}>Delete</button></div>)}{editing && <form className="form-card form-card--inline" onSubmit={correct}><label>Outcome<select value={String(editing.outcome ?? 'ALIVE')} onChange={(event) => setEditing({ ...editing, outcome: event.target.value })}><option>ALIVE</option><option>DEAD</option><option>FROZEN</option><option>DISCARDED</option></select></label><label>Condition<select value={String(editing.condition ?? 'NORMAL')} onChange={(event) => setEditing({ ...editing, condition: event.target.value as FishCondition })}><option>NORMAL</option><option>ABNORMAL</option><option>UNDETERMINED</option></select></label><label>Correction reason<input required value={reason} onChange={(event) => setReason(event.target.value)} /></label><button className="button button--primary">Save correction</button></form>}<form className="form-card" onSubmit={saveSpecimen}><h2>Specimen</h2><div className="form-card--inline"><label>Code<input required value={specimen.specimenCode} onChange={(event) => setSpecimen({ ...specimen, specimenCode: event.target.value })} /></label><label>Kind<select value={specimen.specimenKind} onChange={(event) => setSpecimen({ ...specimen, specimenKind: event.target.value })}><option>CL</option><option>RT</option><option>DC</option></select></label><label>Type<select value={specimen.specimenType} onChange={(event) => setSpecimen({ ...specimen, specimenType: event.target.value })}><option>CAUDAL_FIN_CLIP</option><option>WHOLE_EMBRYO</option></select></label></div><div className="form-card--inline"><label>Collected on<input required type="date" value={specimen.collectedOn} onChange={(event) => setSpecimen({ ...specimen, collectedOn: event.target.value })} /></label><label>Frozen on<input type="date" value={specimen.frozenOn} onChange={(event) => setSpecimen({ ...specimen, frozenOn: event.target.value })} /></label><label>Storage<select value={specimen.storage} onChange={(event) => setSpecimen({ ...specimen, storage: event.target.value })}><option value="">Not stored</option><option>-20</option><option>-80</option></select></label></div><label>Notes<input value={specimen.notes} onChange={(event) => setSpecimen({ ...specimen, notes: event.target.value })} /></label><label><input type="checkbox" checked={specimen.markFinClipped} onChange={(event) => setSpecimen({ ...specimen, markFinClipped: event.target.checked })} /> Mark fin clipped</label><button className="button button--primary">Add specimen</button></form><ReportTable headers={['Specimen', 'Kind', 'Type', 'Collected', 'Frozen', 'Storage']} rows={specimens.map((item) => [String(item.specimenCode ?? '—'), String(item.specimenKind ?? '—'), String(item.specimenType ?? '—'), String(item.collectedOn ?? '—'), String(item.frozenOn ?? '—'), String(item.storage ?? '—')])} /></section>
}
