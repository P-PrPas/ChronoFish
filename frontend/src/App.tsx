import { useEffect, useState } from 'react'
import { get, operatorId } from './api/client'
import { drainQueue, queueCount, rejectedQueueCount, retryRejected, startQueueSync } from './offline'
import { Dashboard } from './pages/dashboard'
import { Due } from './pages/due'
import { Batches } from './pages/batches'
import { Fish } from './pages/fish'
import { Master } from './pages/master'
import { Controls, Promotions, Timing } from './pages/settings'
import { Audit } from './pages/audit'
import { Export } from './pages/export'
import { type ApiItem, type Language, type Page, text } from './types'

function App() {
  const [page, setPage] = useState<Page>((location.hash.slice(1) as Page) || 'dashboard')
  const [language, setLanguage] = useState<Language>('th')
  const [online, setOnline] = useState(navigator.onLine)
  const [pending, setPending] = useState(0)
  const [rejected, setRejected] = useState(0)
  const [operators, setOperators] = useState<ApiItem[]>([])
  const currentOperator = operatorId()
  const t = text[language]

  useEffect(() => { void get('/operators').then((data) => setOperators(data.items ?? [])).catch(() => undefined) }, [])
  useEffect(() => { window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${page}`) }, [page])
  useEffect(() => {
    const refreshQueue = () => void Promise.all([queueCount(), rejectedQueueCount()]).then(([count, rejectedCount]) => { setPending(count); setRejected(rejectedCount) })
    const on = () => { setOnline(true); void drainQueue().then(refreshQueue) }
    const off = () => setOnline(false)
    const beforeClose = (event: BeforeUnloadEvent) => { if (pending > 0) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('online', on); window.addEventListener('offline', off); window.addEventListener('beforeunload', beforeClose)
    void drainQueue().then(refreshQueue)
    const stopQueueSync = startQueueSync(refreshQueue)
    return () => { stopQueueSync(); window.removeEventListener('online', on); window.removeEventListener('offline', off); window.removeEventListener('beforeunload', beforeClose) }
  }, [pending])

  const navigate = (next: Page) => setPage(next)
  return <div className="app">
    <header className="topbar"><div><span className="brand">ChronoFish</span><span className="tagline">SCNT tracking</span></div><div className="top-actions"><label className="operator-select"><span className="sr-only">Operator</span><select aria-label="Operator for this session" value={currentOperator} onChange={(event) => { sessionStorage.setItem('chronofish.operator_id', event.target.value); window.location.reload() }}><option value="">Choose operator</option>{operators.map((operator) => <option key={String(operator.id)} value={String(operator.id)}>{String(operator.name)}</option>)}</select></label>{!currentOperator && <span className="operator-required" role="status">Choose an operator before recording</span>}<span className={`connection connection--${online ? 'online' : 'offline'}`} aria-live="polite"><span aria-hidden="true" />{online ? t.online : t.offline}</span><span className="queue" aria-live="polite">{pending ? `${t.pending} ${pending}` : '✓'}</span>{rejected > 0 && <button className="queue-retry" onClick={() => void retryRejected().then(() => { void queueCount().then(setPending); void rejectedQueueCount().then(setRejected) })}>Retry rejected ({rejected})</button>}<button className="language" onClick={() => setLanguage(language === 'th' ? 'en' : 'th')} aria-label="Switch language">{language === 'th' ? 'EN' : 'ไทย'}</button></div></header>
    <div className="layout"><nav aria-label="Main navigation">{([['dashboard', t.dashboard], ['due', t.due], ['batches', t.batches], ['fish', t.fish], ['master', t.master], ['timing', 'Timing'], ['promotions', 'Promotion'], ['controls', 'Controls'], ['audit', 'Audit'], ['export', 'Export']] as [Page, string][]).map(([key, label]) => <button key={key} aria-current={page === key ? 'page' : undefined} className={page === key ? 'nav-link nav-link--active' : 'nav-link'} onClick={() => navigate(key)}>{label}</button>)}</nav><main className="content">{page === 'dashboard' && <Dashboard onNavigate={navigate} t={t} />}{page === 'due' && <Due t={t} onPendingChange={setPending} />}{page === 'batches' && <Batches t={t} />}{page === 'fish' && <Fish t={t} onPendingChange={setPending} />}{page === 'master' && <Master t={t} />}{page === 'timing' && <Timing />}{page === 'promotions' && <Promotions />}{page === 'controls' && <Controls />}{page === 'audit' && <Audit />}{page === 'export' && <Export />}</main></div>
  </div>
}

export default App
