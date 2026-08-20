import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'

type Page = 'dashboard' | 'due' | 'batches' | 'fish' | 'master'
type Language = 'th' | 'en'
type ApiItem = Record<string, any>

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

async function get(path: string) { return (await request(path)).json() }

async function putQueue(path: string, body: unknown) {
  const key = crypto.randomUUID()
  try { return await (await request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'X-Idempotency-Key': key } })).json() } catch (error) {
    const status = (error as Error & { status?: number }).status
    if (status && status >= 400 && status < 500) throw error
    if (!('indexedDB' in window)) throw error
    await queueWrite({ path, body, key, createdAt: Date.now() })
    throw new Error('บันทึกไว้ในคิวออฟไลน์แล้ว / Saved to offline queue')
  }
}

type QueuedWrite = { path: string; body: unknown; key: string; createdAt: number }
function openQueue() { return new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('chronofish', 1); open.onupgradeneeded = () => open.result.createObjectStore('writes', { autoIncrement: true }); open.onerror = () => reject(open.error); open.onsuccess = () => resolve(open.result) }) }
async function queueWrite(item: QueuedWrite) { const db = await openQueue(); await new Promise<void>((resolve, reject) => { const tx = db.transaction('writes', 'readwrite'); tx.objectStore('writes').add(item); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error) }); db.close() }
async function queueCount() { if (!('indexedDB' in window)) return 0; try { const db = await openQueue(); const count = await new Promise<number>((resolve, reject) => { const req = db.transaction('writes').objectStore('writes').count(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) }); db.close(); return count } catch { return 0 } }
async function drainQueue() { if (!navigator.onLine || !('indexedDB' in window)) return; try { const db = await openQueue(); const records = await new Promise<{ key: IDBValidKey; value: QueuedWrite }[]>((resolve, reject) => { const tx = db.transaction('writes'); const store = tx.objectStore('writes'); const values = store.getAll(); const keys = store.getAllKeys(); tx.oncomplete = () => resolve(values.result.map((value, index) => ({ key: keys.result[index], value }))); tx.onerror = () => reject(tx.error) }); for (const record of records) { try { await request(record.value.path, { method: 'POST', body: JSON.stringify(record.value.body), headers: { 'X-Idempotency-Key': record.value.key } }); await new Promise<void>((resolve, reject) => { const tx = db.transaction('writes', 'readwrite'); tx.objectStore('writes').delete(record.key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error) }) } catch { /* Keep rejected/network-failed rows for the next online event. */ } } db.close() } catch { /* IndexedDB may be unavailable or full. */ } }

function App() {
  const [page, setPage] = useState<Page>('dashboard')
  const [language, setLanguage] = useState<Language>('th')
  const [online, setOnline] = useState(navigator.onLine)
  const [pending, setPending] = useState(0)
  const t = text[language]
  useEffect(() => { const on = () => { setOnline(true); void drainQueue().then(() => queueCount().then(setPending)) }; const off = () => setOnline(false); window.addEventListener('online', on); window.addEventListener('offline', off); void drainQueue().then(() => queueCount().then(setPending)); return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) } }, [])
  return <div className="app">
    <header className="topbar"><div><span className="brand">ChronoFish</span><span className="tagline">SCNT tracking</span></div><div className="top-actions"><span className={`connection connection--${online ? 'online' : 'offline'}`} aria-live="polite"><span aria-hidden="true" />{online ? t.online : t.offline}</span><span className="queue">{pending ? `${t.pending} ${pending}` : '✓'}</span><button className="language" onClick={() => setLanguage(language === 'th' ? 'en' : 'th')} aria-label="Switch language">{language === 'th' ? 'EN' : 'ไทย'}</button></div></header>
    <div className="layout"><nav aria-label="Main navigation">{([['dashboard', t.dashboard], ['due', t.due], ['batches', t.batches], ['fish', t.fish], ['master', t.master]] as [Page, string][]).map(([key, label]) => <button key={key} className={page === key ? 'nav-link nav-link--active' : 'nav-link'} onClick={() => setPage(key)}>{label}</button>)}</nav><main className="content">{page === 'dashboard' && <Dashboard onNavigate={setPage} t={t} />}{page === 'due' && <Due t={t} onPendingChange={setPending} />}{page === 'batches' && <Batches t={t} />}{page === 'fish' && <Fish t={t} onPendingChange={setPending} />}{page === 'master' && <Master t={t} />}</main></div>
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
  return <section><div className="page-heading"><div><p className="eyebrow">STAGE 1</p><h1>{t.due}</h1><p className="muted">เรียงตามความเร่งด่วน • refresh ทุก 60 วินาที</p></div><button className="button button--secondary" onClick={load}>{t.refresh}</button></div>{error && <ErrorMessage message={error} />}{items.length === 0 ? <Empty message={t.empty} /> : <div className="list">{items.map((item: ApiItem) => <button key={`${item.injectionLotId}-${item.stageCode}`} className="list-row" onClick={() => setSelected(item)}><span><strong>{item.batchCode} / Lot {item.lotNo}</strong><small>{item.stageLabel} · {item.stageCode}</small></span><span className={item.minutesLate > 0 ? 'pill pill--late' : 'pill'}>{item.minutesLate > 0 ? `ช้า ${item.minutesLate} นาที` : 'กำลังจะถึง'}</span></button>)}</div>}</section>
}

function Checkpoint({ due, t, onBack }: { due: ApiItem; t: typeof text.th; onBack: () => void }) {
  const [entry, setEntry] = useState<ApiItem | null>(null); const [error, setError] = useState(''); const [saving, setSaving] = useState(false)
  useEffect(() => { void get(`/injection-lots/${due.injectionLotId}/checkpoints/${due.stageCode}`).then(setEntry).catch((e: Error) => setError(e.message)) }, [due])
  const save = async () => { if (!entry) return; setSaving(true); const observations = (entry.embryos ?? []).map((embryo: ApiItem) => ({ clientUuid: crypto.randomUUID(), embryoId: embryo.embryoId, stageCode: due.stageCode, observedAt: new Date().toISOString(), outcome: 'ALIVE', condition: embryo.defaultCondition ?? 'NORMAL' })); try { await putQueue('/observations/embryo', { observations }); onBack() } catch (e) { setError((e as Error).message) } finally { setSaving(false) } }
  return <section><button className="back" onClick={onBack}>← {t.due}</button><div className="page-heading"><div><p className="eyebrow">{due.batchCode} / LOT {due.lotNo}</p><h1>{due.stageLabel}</h1><p className="muted">{entry?.embryos?.length ?? 0} embryos · {due.stageCode}</p></div><button className="button button--primary" disabled={saving || !entry} onClick={save}>{saving ? 'กำลังบันทึก…' : t.allAlive}</button></div>{error && <ErrorMessage message={error} />}{entry && <div className="well-grid">{entry.embryos?.map((embryo: ApiItem) => <div className="well" key={embryo.embryoId}><strong>{embryo.wellPosition ?? '—'}</strong><small>{embryo.embryoCode}</small></div>)}</div>}</section>
}

function Batches({ t }: { t: typeof text.th }) {
  const [items, setItems] = useState<ApiItem[]>([]); const [showForm, setShowForm] = useState(false); const [message, setMessage] = useState('')
  const load = useCallback(() => { void get('/batches').then((data) => setItems(data.items ?? [])).catch((e: Error) => setMessage(e.message)) }, [])
  useEffect(load, [load])
  return <section><div className="page-heading"><div><p className="eyebrow">EXPERIMENTS</p><h1>{t.batches}</h1><p className="muted">Batch และ timing profile ที่ถูก pin ตอนสร้าง</p></div><button className="button button--primary" onClick={() => setShowForm(!showForm)}>＋ {t.save}</button></div>{message && <ErrorMessage message={message} />}{showForm && <BatchForm onSaved={() => { setShowForm(false); load() }} />}{items.length === 0 ? <Empty message={t.empty} /> : <div className="list">{items.map((item) => <div className="list-row" key={item.id}><span><strong>{item.batchCode}</strong><small>{item.experimentDate} · {item.timingProfileId}</small></span><span className="pill">active</span></div>)}</div>}</section>
}

function BatchForm({ onSaved }: { onSaved: () => void }) {
  const [form, setForm] = useState({ experimentDate: new Date().toISOString().slice(0, 10), siteId: '', operatorId: operatorId(), protocolId: '01900000-0000-7000-8000-000000000001', treatmentGroupId: '' }); const [sites, setSites] = useState<ApiItem[]>([]); const [error, setError] = useState('')
  useEffect(() => { void get('/sites').then((data) => setSites(data.items ?? [])) }, [])
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await putQueue('/batches', form); onSaved() } catch (e) { setError((e as Error).message) } }
  return <form className="form-card" onSubmit={submit}><label>Experiment date<input type="date" required value={form.experimentDate} onChange={(e) => setForm({ ...form, experimentDate: e.target.value })} /></label><label>Site<select required value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}><option value="">เลือก site</option>{sites.map((site) => <option key={site.id} value={site.id}>{site.code} — {site.name}</option>)}</select></label><label>Treatment group<input required value={form.treatmentGroupId} onChange={(e) => setForm({ ...form, treatmentGroupId: e.target.value })} /></label>{error && <ErrorMessage message={error} />}<button className="button button--primary" type="submit">บันทึก batch</button></form>
}

function Fish({ t, onPendingChange }: { t: typeof text.th; onPendingChange: (count: number) => void }) {
  const [items, setItems] = useState<ApiItem[]>([]); const [error, setError] = useState(''); const date = new Date().toISOString().slice(0, 10)
  const load = useCallback(() => { void get(`/fish/roll-call?date=${date}`).then((data) => { setItems(data.items ?? []); onPendingChange(0) }).catch((e: Error) => setError(e.message)) }, [date, onPendingChange])
  useEffect(load, [load])
  const markAlive = async () => { const observations = items.filter((item) => !item.alreadyRecorded).map((item) => ({ clientUuid: crypto.randomUUID(), cloneFishId: item.fishId, observedOn: date, outcome: 'ALIVE', condition: item.condition ?? 'NORMAL' })); if (!observations.length) return; try { await putQueue('/observations/fish', { observations }); load() } catch (e) { setError((e as Error).message) } }
  return <section><div className="page-heading"><div><p className="eyebrow">STAGE 2 / {date}</p><h1>{t.fish}</h1><p className="muted">เฉพาะปลาที่มีสถานะ ALIVE</p></div><button className="button button--primary" onClick={markAlive}>{t.allAlive}</button></div>{error && <ErrorMessage message={error} />}{items.length === 0 ? <Empty message={t.empty} /> : <div className="list">{items.map((fish) => <div className="list-row" key={fish.fishId}><span><strong>{fish.fishCode}</strong><small>{fish.ageDays} days · {fish.condition}</small></span><span className={fish.alreadyRecorded ? 'pill pill--done' : 'pill'}>{fish.alreadyRecorded ? 'บันทึกแล้ว' : 'รอบันทึก'}</span></div>)}</div>}</section>
}

function Master({ t }: { t: typeof text.th }) {
  const [sites, setSites] = useState<ApiItem[]>([]); const [code, setCode] = useState(''); const [name, setName] = useState(''); const [message, setMessage] = useState('')
  const load = useCallback(() => { void get('/sites').then((data) => setSites(data.items ?? [])).catch((e: Error) => setMessage(e.message)) }, [])
  useEffect(load, [load])
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await putQueue('/sites', { code, name }); setCode(''); setName(''); setMessage('บันทึกแล้ว'); load() } catch (e) { setMessage((e as Error).message) } }
  return <section><div className="page-heading"><div><p className="eyebrow">SCR-16</p><h1>{t.master}</h1><p className="muted">ข้อมูลที่ inactive จะไม่แสดงใน dropdown</p></div></div><form className="form-card form-card--inline" onSubmit={submit}><label>Site code<input required value={code} onChange={(e) => setCode(e.target.value)} /></label><label>Site name<input required value={name} onChange={(e) => setName(e.target.value)} /></label><button className="button button--primary" type="submit">{t.save}</button></form>{message && <p className="notice" role="status">{message}</p>}{sites.length === 0 ? <Empty message={t.empty} /> : <div className="list">{sites.map((site) => <div className="list-row" key={site.id}><span><strong>{site.code}</strong><small>{site.name}</small></span><span className="pill">{site.active === false ? 'inactive' : 'active'}</span></div>)}</div>}</section>
}

function Empty({ message }: { message: string }) { return <div className="empty"><span aria-hidden="true">⌁</span><p>{message}</p></div> }
function ErrorMessage({ message }: { message: string }) { return <p className="error" role="alert">{message}</p> }

export default App
