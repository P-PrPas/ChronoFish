import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import type { components } from './api/schema'

type Page = 'dashboard' | 'due' | 'batches' | 'fish' | 'master' | 'timing' | 'promotions' | 'controls' | 'audit' | 'export'
type Language = 'th' | 'en'
type ApiRecord = Partial<components['schemas']['Site'] & components['schemas']['Operator'] & components['schemas']['Batch'] & components['schemas']['DueCheckpoint'] & components['schemas']['CloneFish'] & components['schemas']['PromotionCandidate'] & components['schemas']['ControlArmCount'] & {
  id: string
  batchId: string
  fishCode: string
  operatorId: string
  clientUuid: string
  stageCode: string
  stageLabel: string
  stageOrder: number
  expectedHpa: number
  code: string
  label: string
  defaultCondition: string
  minutesLate: number
  condition: string
  observedOn: string
  outcome: string
  stage1: { nActivated?: number; nPromoted?: number; nBatches?: number }
  stage2: { nAlive?: number }
  status: string
  queued: boolean
  nNormal: number
  nAbnormal: number
  fishId: string
  alreadyRecorded: boolean
  recordId: string
  tableName: string
  action: string
  occurredAt: string
  operatorName: string
  error: string
  pendingPromotionCount: number
}> & { [key: string]: unknown }
interface ApiItem extends ApiRecord {
  items?: ApiItem[]
  overdue?: ApiItem[]
  upcoming?: ApiItem[]
  embryos?: ApiItem[]
  injectionLots?: ApiItem[]
  entries?: ApiItem[]
  results?: ApiItem[]
}

const apiBase = import.meta.env.VITE_API_BASE_URL ?? '/api/v1'
const text = {
  th: { dashboard: 'ภาพรวม', due: 'รายการถึงกำหนด', batches: 'รอบทดลอง', fish: 'ทะเบียนปลา', master: 'ข้อมูลหลัก', online: 'เชื่อมต่อแล้ว', offline: 'ออฟไลน์', save: 'บันทึก', refresh: 'รีเฟรช', allAlive: 'รอดทั้งหมด', pending: 'ค้างส่ง', empty: 'ยังไม่มีข้อมูล' },
  en: { dashboard: 'Dashboard', due: 'Due now', batches: 'Experiments', fish: 'Fish registry', master: 'Master data', online: 'Online', offline: 'Offline', save: 'Save', refresh: 'Refresh', allAlive: 'All alive', pending: 'Pending', empty: 'No data yet' },
}

function deviceId() {
  const key = 'chronofish.device_id'
  let id = localStorage.getItem(key)
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(key, id) }
  return id
}

function operatorId() { return localStorage.getItem('chronofish.operator_id') ?? '00000000-0000-7000-8000-000000000001' }

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${apiBase}${path}`, { ...init, headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.method && init.method !== 'GET' ? { 'X-Operator-Id': operatorId(), 'X-Device-Id': deviceId(), 'X-Idempotency-Key': crypto.randomUUID() } : {}), ...init.headers } })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    const error = new Error(body?.error?.message ?? `HTTP ${response.status}`) as Error & { status?: number }
    error.status = response.status
    throw error
  }
  return response
}

async function get(path: string): Promise<ApiItem> { return (await request(path)).json() as Promise<ApiItem> }

async function putQueue(path: string, body: unknown, contentType = 'application/json') {
  const key = crypto.randomUUID()
  const serialized = contentType === 'application/json' ? JSON.stringify(body) : String(body)
  try { return await (await request(path, { method: 'POST', body: serialized, headers: { 'Content-Type': contentType, 'X-Idempotency-Key': key } })).json() } catch (error) {
    const status = (error as Error & { status?: number }).status
    if (status && status >= 400 && status < 500) throw error
    if (!('indexedDB' in window)) throw error
    await queueWrite({ path, body, contentType, key, createdAt: Date.now(), attempt: 0, nextAttempt: Date.now(), status: 'pending' })
    return { queued: true, key }
  }
}

type QueuedWrite = { path: string; body: unknown; contentType?: string; key: string; createdAt: number; attempt: number; nextAttempt: number; status: 'pending' | 'rejected'; lastError?: string }
function openQueue() { return new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('chronofish', 1); open.onupgradeneeded = () => open.result.createObjectStore('writes', { autoIncrement: true }); open.onerror = () => reject(open.error); open.onsuccess = () => resolve(open.result) }) }
async function queueWrite(item: QueuedWrite) { const db = await openQueue(); await new Promise<void>((resolve, reject) => { const tx = db.transaction('writes', 'readwrite'); tx.objectStore('writes').add(item); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error) }); db.close(); localStorage.setItem('chronofish.pending_count', String(Number(localStorage.getItem('chronofish.pending_count') ?? 0) + 1)) }
async function queueCount() { if (!('indexedDB' in window)) return 0; try { const db = await openQueue(); const count = await new Promise<number>((resolve, reject) => { const req = db.transaction('writes').objectStore('writes').getAll(); req.onsuccess = () => resolve((req.result as QueuedWrite[]).filter((item) => item.status === 'pending').length); req.onerror = () => reject(req.error) }); db.close(); return count } catch { return 0 } }
async function rejectedQueueCount() { if (!('indexedDB' in window)) return 0; try { const db = await openQueue(); const count = await new Promise<number>((resolve, reject) => { const req = db.transaction('writes').objectStore('writes').getAll(); req.onsuccess = () => resolve((req.result as QueuedWrite[]).filter((item) => item.status === 'rejected').length); req.onerror = () => reject(req.error) }); db.close(); return count } catch { return 0 } }
async function retryRejected() { if (!('indexedDB' in window)) return; const db = await openQueue(); const records = await new Promise<{ key: IDBValidKey; value: QueuedWrite }[]>((resolve, reject) => { const tx = db.transaction('writes'); const store = tx.objectStore('writes'); const values = store.getAll(); const keys = store.getAllKeys(); tx.oncomplete = () => resolve((values.result as QueuedWrite[]).map((value, index) => ({ key: keys.result[index], value }))); tx.onerror = () => reject(tx.error) }); for (const record of records) if (record.value.status === 'rejected') await updateQueued(db, record.key, { ...record.value, status: 'pending', nextAttempt: Date.now(), lastError: undefined }); db.close(); await drainQueue(true) }
async function updateQueued(db: IDBDatabase, key: IDBValidKey, value: QueuedWrite) { await new Promise<void>((resolve, reject) => { const tx = db.transaction('writes', 'readwrite'); tx.objectStore('writes').put(value, key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error) }) }
async function drainQueue(force = false) { if (!navigator.onLine || !('indexedDB' in window)) return; try { const db = await openQueue(); const records = await new Promise<{ key: IDBValidKey; value: QueuedWrite }[]>((resolve, reject) => { const tx = db.transaction('writes'); const store = tx.objectStore('writes'); const values = store.getAll(); const keys = store.getAllKeys(); tx.oncomplete = () => resolve((values.result as QueuedWrite[]).map((value, index) => ({ key: keys.result[index], value }))); tx.onerror = () => reject(tx.error) }); for (const record of records) { if (record.value.status !== 'pending' || (!force && record.value.nextAttempt > Date.now())) continue; try { const contentType = record.value.contentType ?? 'application/json'; const body = contentType === 'application/json' ? JSON.stringify(record.value.body) : String(record.value.body); await request(record.value.path, { method: 'POST', body, headers: { 'Content-Type': contentType, 'X-Idempotency-Key': record.value.key } }); await new Promise<void>((resolve, reject) => { const tx = db.transaction('writes', 'readwrite'); tx.objectStore('writes').delete(record.key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error) }); window.dispatchEvent(new CustomEvent('chronofish:queue-drained', { detail: record.value })) } catch (error) { const status = (error as Error & { status?: number }).status; if (status && status >= 400 && status < 500) { await updateQueued(db, record.key, { ...record.value, status: 'rejected', lastError: (error as Error).message }); window.dispatchEvent(new CustomEvent('chronofish:queue-rejected', { detail: record.value })) } else { const attempt = record.value.attempt + 1; const delay = Math.min(15 * 60_000, 1_000 * 2 ** Math.min(attempt, 10)) + Math.floor(Math.random() * 500); await updateQueued(db, record.key, { ...record.value, attempt, nextAttempt: Date.now() + delay }) } } } db.close() } catch { /* IndexedDB may be unavailable or full. */ } }

function App() {
  const [page, setPage] = useState<Page>((location.hash.slice(1) as Page) || 'dashboard')
  const [language, setLanguage] = useState<Language>('th')
  const [online, setOnline] = useState(navigator.onLine)
  const [pending, setPending] = useState(0)
  const [rejected, setRejected] = useState(0)
  const t = text[language]
  const [operators, setOperators] = useState<ApiItem[]>([])
  useEffect(() => { void get('/operators').then((data) => setOperators(data.items ?? [])).catch(() => undefined) }, [])
  useEffect(() => { window.history.replaceState(null, '', `#${page}`) }, [page])
  useEffect(() => { const refreshQueue = () => void Promise.all([queueCount(), rejectedQueueCount()]).then(([count, rejectedCount]) => { setPending(count); setRejected(rejectedCount); localStorage.setItem('chronofish.pending_count', String(count)) }); const on = () => { setOnline(true); void drainQueue().then(refreshQueue) }; const off = () => setOnline(false); const beforeClose = (event: BeforeUnloadEvent) => { if (Number(localStorage.getItem('chronofish.pending_count') ?? 0) > 0) { event.preventDefault(); event.returnValue = '' } }; window.addEventListener('online', on); window.addEventListener('offline', off); window.addEventListener('beforeunload', beforeClose); void drainQueue().then(refreshQueue); return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); window.removeEventListener('beforeunload', beforeClose) } }, [])
  return <div className="app">
    <header className="topbar"><div><span className="brand">ChronoFish</span><span className="tagline">SCNT tracking</span></div><div className="top-actions"><label className="operator-select"><span className="sr-only">Operator</span><select value={operatorId()} onChange={(event) => { localStorage.setItem('chronofish.operator_id', event.target.value); window.location.reload() }}><option value="00000000-0000-7000-8000-000000000001">Demo operator</option>{operators.map((operator) => <option key={operator.id} value={operator.id}>{operator.name}</option>)}</select></label><span className={`connection connection--${online ? 'online' : 'offline'}`} aria-live="polite"><span aria-hidden="true" />{online ? t.online : t.offline}</span><span className="queue">{pending ? `${t.pending} ${pending}` : '✓'}</span>{rejected > 0 && <button className="queue-retry" onClick={() => void retryRejected().then(() => { void queueCount().then(setPending); void rejectedQueueCount().then(setRejected) })}>Retry rejected ({rejected})</button>}<button className="language" onClick={() => setLanguage(language === 'th' ? 'en' : 'th')} aria-label="Switch language">{language === 'th' ? 'EN' : 'ไทย'}</button></div></header>
    <div className="layout"><nav aria-label="Main navigation">{([['dashboard', t.dashboard], ['due', t.due], ['batches', t.batches], ['fish', t.fish], ['master', t.master], ['timing', 'Timing'], ['promotions', 'Promotion'], ['controls', 'Controls'], ['audit', 'Audit'], ['export', 'Export']] as [Page, string][]).map(([key, label]) => <button key={key} className={page === key ? 'nav-link nav-link--active' : 'nav-link'} onClick={() => setPage(key)}>{label}</button>)}</nav><main className="content">{page === 'dashboard' && <Dashboard onNavigate={setPage} t={t} />}{page === 'due' && <Due t={t} onPendingChange={setPending} />}{page === 'batches' && <Batches t={t} />}{page === 'fish' && <Fish t={t} onPendingChange={setPending} />}{page === 'master' && <Master t={t} />}{page === 'timing' && <Timing />}{page === 'promotions' && <Promotions />}{page === 'controls' && <Controls />}{page === 'audit' && <Audit />}{page === 'export' && <Export />}</main></div>
  </div>
}

function Dashboard({ onNavigate, t }: { onNavigate: (page: Page) => void; t: typeof text.th }) {
  const [kpi, setKpi] = useState<ApiItem | null>(null); const [error, setError] = useState('')
  const load = useCallback(() => { void get('/analytics/kpi').then(setKpi).catch((e: Error) => setError(e.message)) }, [])
  useEffect(load, [load])
  return <section><div className="page-heading"><div><p className="eyebrow">SCNT / CLONE FISH</p><h1>{t.dashboard}</h1><p className="muted">ติดตามตั้งแต่ activated embryo จนถึง daily roll-call</p></div><button className="button button--secondary" onClick={load}>{t.refresh}</button></div>{error && <ErrorMessage message={error} />}{kpi && <div className="metric-grid"><Metric label="Activated embryos" value={kpi.stage1?.nActivated ?? 0} /><Metric label="Promoted fish" value={kpi.stage1?.nPromoted ?? 0} /><Metric label="Alive fish" value={kpi.stage2?.nAlive ?? 0} /><Metric label="Batches" value={kpi.stage1?.nBatches ?? 0} /></div>}<div className="action-grid"><button onClick={() => onNavigate('due')} className="action-card"><span className="action-icon">◷</span><strong>{t.due}</strong><span>checkpoint และ overdue</span></button><button onClick={() => onNavigate('batches')} className="action-card"><span className="action-icon">＋</span><strong>{t.batches}</strong><span>สร้างรอบและ injection lot</span></button><button onClick={() => onNavigate('fish')} className="action-card"><span className="action-icon">◉</span><strong>{t.fish}</strong><span>daily roll-call</span></button></div></section>
}

function Metric({ label, value }: { label: string; value: number }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div> }

function Due({ t, onPendingChange }: { t: typeof text.th; onPendingChange: (count: number) => void }) {
  const [data, setData] = useState<ApiItem>({ overdue: [], upcoming: [] }); const [selected, setSelected] = useState<ApiItem | null>(null); const [error, setError] = useState('')
  const load = useCallback(() => { void get('/due-checkpoints').then((value) => { setData(value); onPendingChange(value.pendingPromotionCount ?? 0) }).catch((e: Error) => setError(e.message)) }, [onPendingChange])
  useEffect(() => { load(); const timer = window.setInterval(load, 60_000); return () => window.clearInterval(timer) }, [load])
  if (selected) return <Checkpoint due={selected} t={t} onBack={() => setSelected(null)} />
  const items = [...(data.overdue ?? []), ...(data.upcoming ?? [])]
  return <section><div className="page-heading"><div><p className="eyebrow">STAGE 1</p><h1>{t.due}</h1><p className="muted">เรียงตามความเร่งด่วน • refresh ทุก 60 วินาที</p></div><button className="button button--secondary" onClick={load}>{t.refresh}</button></div>{error && <ErrorMessage message={error} />}{items.length === 0 ? <Empty message={t.empty} /> : <div className="list">{items.map((item: ApiItem) => { const late = item.minutesLate ?? 0; return <button key={`${item.injectionLotId}-${item.stageCode}`} className="list-row" onClick={() => setSelected(item)}><span><strong>{String(item.batchCode)} / Lot {String(item.lotNo)}</strong><small>{String(item.stageLabel)} · {String(item.stageCode)}</small></span><span className={late > 0 ? 'pill pill--late' : 'pill'}>{late > 0 ? `ช้า ${late} นาที` : 'กำลังจะถึง'}</span></button> })}</div>}</section>
}

function CheckpointLegacy({ due, t, onBack }: { due: ApiItem; t: typeof text.th; onBack: () => void }) {
  const [entry, setEntry] = useState<ApiItem | null>(null); const [error, setError] = useState(''); const [saving, setSaving] = useState(false)
  useEffect(() => { void get(`/injection-lots/${due.injectionLotId}/checkpoints/${due.stageCode}`).then(setEntry).catch((e: Error) => setError(e.message)) }, [due])
  const save = async () => { if (!entry) return; setSaving(true); const observations = (entry.embryos ?? []).map((embryo: ApiItem) => ({ clientUuid: crypto.randomUUID(), embryoId: embryo.embryoId, stageCode: due.stageCode, observedAt: new Date().toISOString(), outcome: 'ALIVE', condition: embryo.defaultCondition ?? 'NORMAL' })); try { await putQueue('/observations/embryo', { observations }); onBack() } catch (e) { setError((e as Error).message) } finally { setSaving(false) } }
  return <section><button className="back" onClick={onBack}>← {t.due}</button><div className="page-heading"><div><p className="eyebrow">{String(due.batchCode)} / LOT {String(due.lotNo)}</p><h1>{String(due.stageLabel)}</h1><p className="muted">{entry?.embryos?.length ?? 0} embryos · {String(due.stageCode)}</p></div><button className="button button--primary" disabled={saving || !entry} onClick={save}>{saving ? 'กำลังบันทึก…' : t.allAlive}</button></div>{error && <ErrorMessage message={error} />}{entry && <div className="well-grid">{entry.embryos?.map((embryo: ApiItem) => <div className="well" key={embryo.embryoId}><strong>{String(embryo.wellPosition ?? '—')}</strong><small>{String(embryo.embryoCode)}</small></div>)}</div>}</section>
}

function Checkpoint({ due, t, onBack }: { due: ApiItem; t: typeof text.th; onBack: () => void }) {
  const [entry, setEntry] = useState<ApiItem | null>(null); const [outcomes, setOutcomes] = useState<Record<string, string>>({}); const [conditions, setConditions] = useState<Record<string, string>>({}); const [notes, setNotes] = useState<Record<string, string>>({}); const [observedAt, setObservedAt] = useState(new Date().toISOString().slice(0, 16)); const [error, setError] = useState(''); const [saving, setSaving] = useState(false)
  useEffect(() => { void get(`/injection-lots/${due.injectionLotId}/checkpoints/${due.stageCode}`).then((value) => { setEntry(value); const nextOutcomes: Record<string, string> = {}; const nextConditions: Record<string, string> = {}; (value.embryos ?? []).forEach((embryo: ApiItem) => { nextOutcomes[String(embryo.embryoId)] = 'ALIVE'; nextConditions[String(embryo.embryoId)] = String(embryo.defaultCondition ?? 'NORMAL') }); setOutcomes(nextOutcomes); setConditions(nextConditions) }).catch((e: Error) => setError(e.message)) }, [due])
  const save = async () => { if (!entry) return; setSaving(true); const observations = (entry.embryos ?? []).map((embryo: ApiItem) => ({ clientUuid: crypto.randomUUID(), embryoId: embryo.embryoId, stageCode: due.stageCode, observedAt: new Date(observedAt).toISOString(), outcome: outcomes[String(embryo.embryoId)] ?? 'ALIVE', condition: conditions[String(embryo.embryoId)] ?? 'NORMAL', notes: notes[String(embryo.embryoId)] || null })); try { await putQueue('/observations/embryo', { observations }); onBack() } catch (e) { setError((e as Error).message) } finally { setSaving(false) } }
  return <section><button className="back" onClick={onBack}>← {t.due}</button><div className="page-heading"><div><p className="eyebrow">{String(due.batchCode)} / LOT {String(due.lotNo)}</p><h1>{String(due.stageLabel)}</h1><p className="muted">{entry?.embryos?.length ?? 0} embryos · {String(due.stageCode)}</p></div><button className="button button--primary" disabled={saving || !entry} onClick={save}>{saving ? 'Saving...' : 'Save checkpoint'}</button></div>{error && <ErrorMessage message={error} />}<label className="form-card">Observed at<input type="datetime-local" value={observedAt} onChange={(event) => setObservedAt(event.target.value)} /></label>{entry && <div className="well-grid">{entry.embryos?.map((embryo: ApiItem) => { const id = String(embryo.embryoId); return <div className="well" key={id}><strong>{String(embryo.wellPosition ?? '—')}</strong><small>{String(embryo.embryoCode)}</small><label>Outcome<select value={outcomes[id] ?? 'ALIVE'} onChange={(event) => setOutcomes({ ...outcomes, [id]: event.target.value })}><option>ALIVE</option><option>DEAD</option><option>DEGENERATED</option><option>NOT_OBSERVED</option></select></label><label>Condition<select value={conditions[id] ?? 'NORMAL'} onChange={(event) => setConditions({ ...conditions, [id]: event.target.value })}><option>NORMAL</option><option>ABNORMAL</option><option>UNDETERMINED</option></select></label><label>Notes<input value={notes[id] ?? ''} onChange={(event) => setNotes({ ...notes, [id]: event.target.value })} /></label></div> })}</div>}</section>
}

function BatchesLegacy({ t }: { t: typeof text.th }) {
  const [items, setItems] = useState<ApiItem[]>([]); const [showForm, setShowForm] = useState(false); const [selected, setSelected] = useState<ApiItem | null>(null); const [message, setMessage] = useState('')
  const load = useCallback(() => { void get('/batches').then((data) => setItems(data.items ?? [])).catch((e: Error) => setMessage(e.message)) }, [])
  useEffect(load, [load])
  useEffect(() => { const refresh = () => load(); const reject = (event: Event) => { const detail = (event as CustomEvent<QueuedWrite>).detail; if (detail.path === '/batches') { setItems((current) => current.filter((item) => !item.queued)); setMessage(detail.lastError ?? 'Queued batch rejected') } }; window.addEventListener('chronofish:queue-drained', refresh); window.addEventListener('chronofish:queue-rejected', reject); return () => { window.removeEventListener('chronofish:queue-drained', refresh); window.removeEventListener('chronofish:queue-rejected', reject) } }, [load])
  if (selected) return <BatchDetail batch={selected} onBack={() => setSelected(null)} />
  const addQueued = (batch: ApiItem) => { setItems((current) => [{ ...batch, id: `queued-${Date.now()}`, queued: true }, ...current]); setShowForm(false); setMessage('Saved offline; will sync when online') }
  return <section><div className="page-heading"><div><p className="eyebrow">EXPERIMENTS</p><h1>{t.batches}</h1><p className="muted">Batch และ timing profile ที่ถูก pin ตอนสร้าง</p></div><button className="button button--primary" onClick={() => setShowForm(!showForm)}>＋ {t.save}</button></div>{message && <ErrorMessage message={message} />}{showForm && <BatchForm onSaved={() => { setShowForm(false); load() }} onQueued={addQueued} />}{items.length === 0 ? <Empty message={t.empty} /> : <div className="list">{items.map((item) => <div className="list-row" key={String(item.id)}><span><strong>{String(item.batchCode)}</strong><small>{String(item.experimentDate)} · {String(item.timingProfileId ?? '')}</small></span><span className="pill">{item.queued ? 'queued' : 'active'}</span></div>)}</div>}</section>
}

function Batches({ t }: { t: typeof text.th }) {
  const [items, setItems] = useState<ApiItem[]>([]); const [selected, setSelected] = useState<ApiItem | null>(null); const [showForm, setShowForm] = useState(false); const [message, setMessage] = useState('')
  const load = useCallback(() => { void get('/batches').then((data) => setItems(data.items ?? [])).catch((e: Error) => setMessage(e.message)) }, [])
  useEffect(load, [load])
  useEffect(() => { const refresh = () => load(); const reject = (event: Event) => { const detail = (event as CustomEvent<QueuedWrite>).detail; if (detail.path === '/batches') { setItems((current) => current.filter((item) => !item.queued)); setMessage(detail.lastError ?? 'Queued batch rejected') } }; window.addEventListener('chronofish:queue-drained', refresh); window.addEventListener('chronofish:queue-rejected', reject); return () => { window.removeEventListener('chronofish:queue-drained', refresh); window.removeEventListener('chronofish:queue-rejected', reject) } }, [load])
  if (selected) return <BatchDetail batch={selected} onBack={() => setSelected(null)} />
  const addQueued = (batch: ApiItem) => { setItems((current) => [{ ...batch, id: `queued-${Date.now()}`, queued: true }, ...current]); setShowForm(false); setMessage('Saved offline; will sync when online') }
  return <section><div className="page-heading"><div><p className="eyebrow">EXPERIMENTS</p><h1>{t.batches}</h1><p className="muted">Batch and injection lot setup</p></div><button className="button button--primary" onClick={() => setShowForm(!showForm)}>+ {t.save}</button></div>{message && <ErrorMessage message={message} />}{showForm && <BatchForm onSaved={() => { setShowForm(false); load() }} onQueued={addQueued} />}{items.length === 0 ? <Empty message={t.empty} /> : <div className="list">{items.map((item) => <button className="list-row" key={String(item.id)} onClick={() => setSelected(item)}><span><strong>{String(item.batchCode)}</strong><small>{String(item.experimentDate)} · {String(item.timingProfileId ?? '')}</small></span><span className="pill">{item.queued ? 'queued' : 'active'}</span></button>)}</div>}</section>
}

function BatchDetail({ batch, onBack }: { batch: ApiItem; onBack: () => void }) {
  const [detail, setDetail] = useState<ApiItem | null>(null); const [embryos, setEmbryos] = useState<Record<string, ApiItem[]>>({}); const [donorCellLineId, setDonorCellLineId] = useState(''); const [lotNo, setLotNo] = useState('1'); const [count, setCount] = useState(1); const [message, setMessage] = useState('')
  const load = useCallback(() => { void get(`/batches/${batch.id}`).then(async (value) => { setDetail(value); const lots = (value.injectionLots as ApiItem[] | undefined) ?? []; const loaded = await Promise.all(lots.map(async (lot: ApiItem) => [String(lot.id), (await get(`/injection-lots/${lot.id}/embryos?aliveOnly=false`)).items ?? []] as [string, ApiItem[]])); setEmbryos(Object.fromEntries(loaded)) }).catch((e: Error) => setMessage(e.message)) }, [batch.id])
  useEffect(load, [load])
  const createLot = async (event: FormEvent) => { event.preventDefault(); try { const result = await putQueue(`/batches/${batch.id}/injection-lots`, { lotNo, donorCellLineId, activatedAt: new Date().toISOString(), nActivated: count }); if (result.queued) setMessage('Saved offline; will sync when online'); else { setMessage('Lot created'); load() } } catch (e) { setMessage((e as Error).message) } }
  const addEmbryos = async (lotId: string) => { try { const result = await putQueue(`/injection-lots/${lotId}/embryos`, { count }); if (result.queued) setMessage('Embryos queued for sync'); else { setMessage('Embryos added'); load() } } catch (e) { setMessage((e as Error).message) } }
  return <section><button className="back" onClick={onBack}>← Batches</button><div className="page-heading"><div><p className="eyebrow">EXPERIMENT</p><h1>{String(batch.batchCode)}</h1><p className="muted">{String(batch.experimentDate)} · {String(batch.siteId ?? '')}</p></div></div>{message && <ErrorMessage message={message} />}<form className="form-card form-card--inline" onSubmit={createLot}><label>Lot number<input required value={lotNo} onChange={(event) => setLotNo(event.target.value)} /></label><label>Donor cell line<input required value={donorCellLineId} onChange={(event) => setDonorCellLineId(event.target.value)} /></label><label>Embryos<input required type="number" min="1" max="96" value={count} onChange={(event) => setCount(Number(event.target.value))} /></label><button className="button button--primary" type="submit">Create lot</button></form>{(detail?.injectionLots ?? []).map((lot: ApiItem) => <article className="form-card" key={String(lot.id)}><div className="page-heading"><div><h2>Lot {String(lot.lotNo)}</h2><p className="muted">{String(lot.nActivated ?? 0)} activated · {String(lot.activatedAt ?? '')}</p></div><button className="button button--secondary" type="button" onClick={() => addEmbryos(String(lot.id))}>Add {count} embryos</button></div><div className="list">{(embryos[String(lot.id)] ?? []).map((embryo) => <div className="list-row" key={String(embryo.id)}><span><strong>{String(embryo.embryoCode)}</strong><small>Well {String(embryo.wellPosition ?? '')}</small></span><span className="pill">{embryo.exitAt ? 'exited' : 'alive'}</span></div>)}</div></article>)}</section>
}

function BatchForm({ onSaved, onQueued }: { onSaved: () => void; onQueued: (batch: ApiItem) => void }) {
  const [form, setForm] = useState({ experimentDate: new Date().toISOString().slice(0, 10), siteId: '', operatorId: operatorId(), protocolId: '01900000-0000-7000-8000-000000000001', treatmentGroupId: '' }); const [sites, setSites] = useState<ApiItem[]>([]); const [error, setError] = useState('')
  useEffect(() => { void get('/sites').then((data) => setSites(data.items ?? [])) }, [])
  const submit = async (event: FormEvent) => { event.preventDefault(); try { const result = await putQueue('/batches', form) as ApiItem; result.queued ? onQueued(form) : onSaved() } catch (e) { setError((e as Error).message) } }
  return <form className="form-card" onSubmit={submit}><label>Experiment date<input type="date" required value={form.experimentDate} onChange={(e) => setForm({ ...form, experimentDate: e.target.value })} /></label><label>Site<select required value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}><option value="">เลือก site</option>{sites.map((site) => <option key={site.id} value={site.id}>{site.code} — {site.name}</option>)}</select></label><label>Treatment group<input required value={form.treatmentGroupId} onChange={(e) => setForm({ ...form, treatmentGroupId: e.target.value })} /></label>{error && <ErrorMessage message={error} />}<button className="button button--primary" type="submit">บันทึก batch</button></form>
}

function Fish({ t, onPendingChange }: { t: typeof text.th; onPendingChange: (count: number) => void }) {
  const [items, setItems] = useState<ApiItem[]>([]); const [error, setError] = useState(''); const date = new Date().toISOString().slice(0, 10)
  const load = useCallback(() => { void get(`/fish/roll-call?date=${date}`).then((data) => { setItems(data.items ?? []); onPendingChange(0) }).catch((e: Error) => setError(e.message)) }, [date, onPendingChange])
  useEffect(load, [load])
  useEffect(() => { const refresh = () => load(); const reject = (event: Event) => { const detail = (event as CustomEvent<QueuedWrite>).detail; if (detail.path === '/observations/fish') { setItems((current) => current.map((item) => ({ ...item, alreadyRecorded: false }))); setError(detail.lastError ?? 'Queued observations rejected') } }; window.addEventListener('chronofish:queue-drained', refresh); window.addEventListener('chronofish:queue-rejected', reject); return () => { window.removeEventListener('chronofish:queue-drained', refresh); window.removeEventListener('chronofish:queue-rejected', reject) } }, [load])
  const markAlive = async () => { const observations = items.filter((item) => !item.alreadyRecorded).map((item) => ({ clientUuid: crypto.randomUUID(), cloneFishId: item.fishId, observedOn: date, outcome: 'ALIVE', condition: item.condition ?? 'NORMAL' })); if (!observations.length) return; const previous = items; setItems(items.map((item) => item.alreadyRecorded ? item : { ...item, alreadyRecorded: true })); try { const result = await putQueue('/observations/fish', { observations }) as ApiItem; if (!result.queued) load() } catch (e) { setItems(previous); setError((e as Error).message) } }
  return <section><div className="page-heading"><div><p className="eyebrow">STAGE 2 / {date}</p><h1>{t.fish}</h1><p className="muted">เฉพาะปลาที่มีสถานะ ALIVE</p></div><button className="button button--primary" onClick={markAlive}>{t.allAlive}</button></div>{error && <ErrorMessage message={error} />}{items.length === 0 ? <Empty message={t.empty} /> : <div className="list">{items.map((fish) => <div className="list-row" key={fish.fishId}><span><strong>{fish.fishCode}</strong><small>{fish.ageDays} days · {fish.condition}</small></span><span className={fish.alreadyRecorded ? 'pill pill--done' : 'pill'}>{fish.alreadyRecorded ? 'บันทึกแล้ว' : 'รอบันทึก'}</span></div>)}</div>}</section>
}

function Master({ t }: { t: typeof text.th }) {
  const [sites, setSites] = useState<ApiItem[]>([]); const [code, setCode] = useState(''); const [name, setName] = useState(''); const [message, setMessage] = useState('')
  const load = useCallback(() => { void get('/sites').then((data) => setSites(data.items ?? [])).catch((e: Error) => setMessage(e.message)) }, [])
  useEffect(load, [load])
  useEffect(() => { const refresh = () => load(); const reject = (event: Event) => { const detail = (event as CustomEvent<QueuedWrite>).detail; if (detail.path === '/sites') { setSites((current) => current.filter((item) => !item.queued)); setMessage(detail.lastError ?? 'Queued site rejected') } }; window.addEventListener('chronofish:queue-drained', refresh); window.addEventListener('chronofish:queue-rejected', reject); return () => { window.removeEventListener('chronofish:queue-drained', refresh); window.removeEventListener('chronofish:queue-rejected', reject) } }, [load])
  const submit = async (event: FormEvent) => { event.preventDefault(); const draft = { code, name }; try { const result = await putQueue('/sites', draft) as ApiItem; setCode(''); setName(''); if (result.queued) { setSites((current) => [{ ...draft, id: `queued-${Date.now()}`, queued: true }, ...current]); setMessage('Saved offline; will sync when online') } else { setMessage('บันทึกแล้ว'); load() } } catch (e) { setMessage((e as Error).message) } }
  return <section><div className="page-heading"><div><p className="eyebrow">SCR-16</p><h1>{t.master}</h1><p className="muted">ข้อมูลที่ inactive จะไม่แสดงใน dropdown</p></div></div><form className="form-card form-card--inline" onSubmit={submit}><label>Site code<input required value={code} onChange={(e) => setCode(e.target.value)} /></label><label>Site name<input required value={name} onChange={(e) => setName(e.target.value)} /></label><button className="button button--primary" type="submit">{t.save}</button></form>{message && <p className="notice" role="status">{message}</p>}{sites.length === 0 ? <Empty message={t.empty} /> : <div className="list">{sites.map((site) => <div className="list-row" key={site.id}><span><strong>{site.code}</strong><small>{site.name}</small></span><span className="pill">{site.active === false ? 'inactive' : 'active'}</span></div>)}</div>}<MasterCatalog /></section>
}

type MasterResource = 'operators' | 'donor-cell-lines' | 'recipient-egg-lots' | 'csof-lots' | 'treatment-groups' | 'fish-boxes'
const masterConfig: Record<MasterResource, { label: string; fields: { key: string; label: string; type?: string; options?: string[] }[] }> = {
  operators: { label: 'Operators', fields: [{ key: 'name', label: 'Name' }] },
  'donor-cell-lines': { label: 'Donor cell lines', fields: [{ key: 'strain', label: 'Strain' }, { key: 'preparation', label: 'Preparation', options: ['DISSOCIATED', 'CHUNKS'] }, { key: 'batchCode', label: 'Batch code' }] },
  'recipient-egg-lots': { label: 'Recipient egg lots', fields: [{ key: 'breed', label: 'Breed' }, { key: 'lotDate', label: 'Lot date', type: 'date' }, { key: 'label', label: 'Label' }] },
  'csof-lots': { label: 'CSOF lots', fields: [{ key: 'lotCode', label: 'Lot code' }] },
  'treatment-groups': { label: 'Treatment groups', fields: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'armType', label: 'Arm type', options: ['SCNT', 'NATURAL_BREEDING', 'IVF'] }] },
  'fish-boxes': { label: 'Fish boxes', fields: [{ key: 'boxCode', label: 'Box code' }, { key: 'siteId', label: 'Site ID' }] },
}
function MasterCatalog() {
  const [resource, setResource] = useState<MasterResource>('operators'); const [items, setItems] = useState<ApiItem[]>([]); const [form, setForm] = useState<Record<string, string>>({}); const [message, setMessage] = useState('')
  const config = masterConfig[resource]
  const load = useCallback(() => { void get(`/${resource}`).then((data) => setItems(data.items ?? [])).catch((e: Error) => setMessage(e.message)) }, [resource])
  useEffect(() => { setForm({}); load() }, [load])
  useEffect(() => { const refresh = () => load(); const reject = (event: Event) => { const detail = (event as CustomEvent<QueuedWrite>).detail; if (detail.path === `/${resource}`) { setItems((current) => current.filter((item) => !item.queued)); setMessage(detail.lastError ?? 'Queued master record rejected') } }; window.addEventListener('chronofish:queue-drained', refresh); window.addEventListener('chronofish:queue-rejected', reject); return () => { window.removeEventListener('chronofish:queue-drained', refresh); window.removeEventListener('chronofish:queue-rejected', reject) } }, [load, resource])
  const submit = async (event: FormEvent) => { event.preventDefault(); const draft = { ...form }; try { const result = await putQueue(`/${resource}`, draft) as ApiItem; setForm({}); if (result.queued) { setItems((current) => [{ ...draft, id: `queued-${Date.now()}`, queued: true }, ...current]); setMessage('Saved offline; will sync when online') } else { setMessage('Saved'); load() } } catch (e) { setMessage((e as Error).message) } }
  return <div className="master-catalog"><h2>All master data</h2><label>Resource<select value={resource} onChange={(event) => setResource(event.target.value as MasterResource)}>{Object.entries(masterConfig).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label><form className="form-card form-card--inline" onSubmit={submit}>{config.fields.map((field) => <label key={field.key}>{field.label}{field.options ? <select required value={form[field.key] ?? ''} onChange={(event) => setForm({ ...form, [field.key]: event.target.value })}><option value="">Select</option>{field.options.map((option) => <option key={option}>{option}</option>)}</select> : <input required={field.key !== 'batchCode' && field.key !== 'lotDate' && field.key !== 'siteId'} type={field.type ?? 'text'} value={form[field.key] ?? ''} onChange={(event) => setForm({ ...form, [field.key]: event.target.value })} />}</label>)}<button className="button button--primary" type="submit">Save</button></form>{message && <p className="notice">{message}</p>}<div className="list">{items.map((item) => <div className="list-row" key={item.id}><span><strong>{String(item.name ?? item.code ?? item.label ?? item.lotCode ?? item.boxCode ?? item.strain)}</strong></span><span className="pill">{item.active === false ? 'inactive' : 'active'}</span></div>)}</div></div>
}

function Timing() {
  const [profile, setProfile] = useState<ApiItem | null>(null); const [error, setError] = useState(''); const [importing, setImporting] = useState(false)
  const load = useCallback(() => { void get('/timing-profiles/current').then(setProfile).catch((e: Error) => setError(e.message)) }, [])
  useEffect(load, [load])
  useEffect(() => { const refresh = () => load(); window.addEventListener('chronofish:queue-drained', refresh); return () => window.removeEventListener('chronofish:queue-drained', refresh) }, [load])
  const download = async () => { try { const response = await request('/timing-profiles/csv?protocolId=01900000-0000-7000-8000-000000000001'); const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'timing-profile.csv'; link.click(); URL.revokeObjectURL(url) } catch (e) { setError((e as Error).message) } }
  const upload = async (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; setImporting(true); setError(''); try { const body = await file.text(); const result = await putQueue('/timing-profiles/csv', body, 'text/csv') as ApiItem; if (!result.queued) await load() } catch (e) { setError((e as Error).message) } finally { setImporting(false); event.target.value = '' } }
  return <section><div className="page-heading"><div><p className="eyebrow">SCR-15 / VERSIONED</p><h1>Timing profile</h1><p className="muted">โปรไฟล์เดิมแก้ย้อนหลังไม่ได้</p></div><div className="button-row"><button className="button button--secondary" onClick={download}>Download CSV</button><label className="button button--secondary">{importing ? 'Importing…' : 'Import CSV'}<input className="sr-only" type="file" accept=".csv,text/csv" disabled={importing} onChange={upload} /></label></div></div>{error && <ErrorMessage message={error} />}{profile && <div className="table-wrap"><table><thead><tr><th>Stage</th><th>Label</th><th>Expected HPA</th></tr></thead><tbody>{profile.entries?.map((entry: ApiItem) => <tr key={String(entry.id ?? entry.stageCode)}><td>{entry.stageCode ?? entry.code}</td><td>{entry.stageLabel ?? entry.label}</td><td>{Number(entry.expectedHpa).toFixed(4)}</td></tr>)}</tbody></table></div>}</section>
}

function Promotions() {
  const [items, setItems] = useState<ApiItem[]>([]); const [message, setMessage] = useState('')
  const load = useCallback(() => { void get('/promotions/pending').then((data) => setItems(data.items ?? [])).catch((e: Error) => setMessage(e.message)) }, [])
  useEffect(load, [load])
  useEffect(() => { const refresh = () => load(); window.addEventListener('chronofish:queue-drained', refresh); return () => window.removeEventListener('chronofish:queue-drained', refresh) }, [load])
  const promote = async (item: ApiItem) => { try { await putQueue('/promotions', { promotions: [{ clientUuid: crypto.randomUUID(), embryoId: item.embryoId, fishCode: item.suggestedFishCode }] }); setItems(items.filter((entry) => entry.embryoId !== item.embryoId)) } catch (e) { setMessage((e as Error).message) } }
  return <section><div className="page-heading"><div><p className="eyebrow">SCR-07 / CONFIRMATION REQUIRED</p><h1>Promotion</h1><p className="muted">เลือกและยืนยันตัวอ่อนที่เข้าเกณฑ์อายุ 5 วัน</p></div><button className="button button--secondary" onClick={load}>Refresh</button></div>{message && <ErrorMessage message={message} />}{items.length === 0 ? <Empty message="ยังไม่มีตัวอ่อนที่เข้าเกณฑ์" /> : <div className="list">{items.map((item) => <div className="list-row" key={item.embryoId}><span><strong>{item.embryoCode}</strong><small>DOB {item.dob} · {item.condition ?? 'NORMAL'}</small></span><button className="button button--primary" onClick={() => promote(item)}>Confirm</button></div>)}</div>}</section>
}

function Controls() {
  const [batchId, setBatchId] = useState(''); const [items, setItems] = useState<ApiItem[]>([]); const [message, setMessage] = useState('')
  const save = async (event: FormEvent) => { event.preventDefault(); try { await putQueue(`/batches/${batchId}/control-arm-counts`, { items }); setMessage('บันทึกแล้ว') } catch (e) { setMessage((e as Error).message) } }
  return <section><div className="page-heading"><div><p className="eyebrow">SCR-11 / CONTROL ARMS</p><h1>Control counts</h1><p className="muted">Natural breeding และ IVF แบบนับรวม</p></div></div><form className="form-card" onSubmit={save}><label>Batch ID<input required value={batchId} onChange={(event) => setBatchId(event.target.value)} /></label><label>Stage code<input required value={items[0]?.stageCode ?? ''} onChange={(event) => setItems([{ armType: 'NATURAL_BREEDING', stageCode: event.target.value, nNormal: 0, nAbnormal: 0 }])} /></label><label>Normal<input type="number" min="0" value={items[0]?.nNormal ?? 0} onChange={(event) => setItems([{ ...(items[0] ?? {}), armType: 'NATURAL_BREEDING', nNormal: Number(event.target.value), nAbnormal: items[0]?.nAbnormal ?? 0 }])} /></label><label>Abnormal<input type="number" min="0" value={items[0]?.nAbnormal ?? 0} onChange={(event) => setItems([{ ...(items[0] ?? {}), armType: 'NATURAL_BREEDING', nNormal: items[0]?.nNormal ?? 0, nAbnormal: Number(event.target.value) }])} /></label><button className="button button--primary" type="submit">Save counts</button></form>{message && <p className="notice">{message}</p>}</section>
}

function Audit() {
  const [items, setItems] = useState<ApiItem[]>([]); const [error, setError] = useState('')
  useEffect(() => { void get('/audit-log').then((data) => setItems(data.items ?? [])).catch((e: Error) => setError(e.message)) }, [])
  return <section><div className="page-heading"><div><p className="eyebrow">SCR-18 / APPEND-ONLY</p><h1>Audit history</h1><p className="muted">ทุก mutation มี operator, device และ before/after</p></div></div>{error && <ErrorMessage message={error} />}{items.length === 0 ? <Empty message="ยังไม่มีประวัติ" /> : <div className="list">{items.map((item) => <div className="list-row" key={item.id}><span><strong>{item.action} · {item.tableName}</strong><small>{item.recordId} · {item.occurredAt}</small></span><span className="pill">{item.operatorName ?? item.operatorId ?? '—'}</span></div>)}</div>}</section>
}

function Export() {
  const [message, setMessage] = useState('')
  const download = async () => { try { const response = await request('/exports/excel', { method: 'POST', body: JSON.stringify({ locale: 'th' }) }); const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'chronofish-export.xlsx'; link.click(); URL.revokeObjectURL(url) } catch (e) { setMessage((e as Error).message) } }
  return <section><div className="page-heading"><div><p className="eyebrow">SCR-17 / 14 SHEETS</p><h1>Export</h1><p className="muted">Excel และ print/PDF dashboard ตาม filter ปัจจุบัน</p></div></div><div className="action-grid"><button className="action-card" onClick={download}><span className="action-icon">↓</span><strong>Download Excel</strong><span>14 sheets + R analysis table</span></button><button className="action-card" onClick={() => window.print()}><span className="action-icon">▣</span><strong>Print / PDF</strong><span>ใช้ browser print พร้อมกราฟบนหน้าปัจจุบัน</span></button></div>{message && <ErrorMessage message={message} />}</section>
}

function Empty({ message }: { message: string }) { return <div className="empty"><span aria-hidden="true">⌁</span><p>{message}</p></div> }
function ErrorMessage({ message }: { message: string }) { return <p className="error" role="alert">{message}</p> }

export default App
