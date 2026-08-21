import { useCallback, useEffect, useState } from 'react'
import { type ApiItem, get } from '../api/client'
import { Empty, ErrorMessage } from '../components'

type AuditFilters = { table?: string; recordId?: string; operatorId?: string; from?: string; to?: string }

export function Audit() {
  const [items, setItems] = useState<ApiItem[]>([])
  const [filters, setFilters] = useState<AuditFilters>({})
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string>()
  const load = useCallback((cursor?: string, append = false) => {
    const values = Object.entries(filters).filter(([, value]) => Boolean(value)) as [string, string][]
    if (cursor) values.push(['cursor', cursor])
    const query = new URLSearchParams(values).toString()
    setLoading(true)
    setError('')
    void get(`/audit-log${query ? `?${query}` : ''}`).then((data) => {
      const page = data.items ?? []
      setItems((current) => append ? [...current, ...page] : page)
      setNextCursor(data.nextCursor ? String(data.nextCursor) : undefined)
    }).catch((e: Error) => setError(e.message)).finally(() => setLoading(false))
  }, [filters])
  useEffect(() => { void load() }, [load])
  const update = (key: keyof AuditFilters, value: string) => setFilters((current) => ({ ...current, [key]: value || undefined }))
  return <section><div className="page-heading"><div><p className="eyebrow">SCR-18 / APPEND-ONLY</p><h1>Audit history</h1><p className="muted">Filter every mutation by resource, record, operator, or time window.</p></div><button className="button button--secondary" onClick={() => void load()} disabled={loading}>{loading ? 'Loading...' : 'Refresh'}</button></div><fieldset className="filter-bar"><legend>History filters</legend><label>Table<input value={filters.table ?? ''} onChange={(event) => update('table', event.target.value)} placeholder="batches" /></label><label>Record ID<input value={filters.recordId ?? ''} onChange={(event) => update('recordId', event.target.value)} /></label><label>Operator ID<input value={filters.operatorId ?? ''} onChange={(event) => update('operatorId', event.target.value)} /></label><label>From<input type="datetime-local" value={filters.from ?? ''} onChange={(event) => update('from', event.target.value)} /></label><label>To<input type="datetime-local" value={filters.to ?? ''} onChange={(event) => update('to', event.target.value)} /></label><button type="button" className="button button--secondary" onClick={() => setFilters({})}>Clear</button></fieldset>{error && <ErrorMessage message={error} />}{items.length === 0 ? <Empty message="No audit records match these filters" /> : <><div className="list">{items.map((item) => <details className="list-row" key={String(item.id)}><summary><span><strong>{String(item.action)} · {String(item.tableName)}</strong><small>{String(item.recordId)} · {String(item.occurredAt)}</small></span><span className="pill">{String(item.operatorName ?? item.operatorId ?? '—')}</span></summary><div className="audit-detail"><p><strong>Device:</strong> {String(item.deviceId ?? '—')}</p><pre>{JSON.stringify({ before: item.oldValues, after: item.newValues }, null, 2)}</pre></div></details>)}</div>{nextCursor && <button className="button button--secondary" onClick={() => void load(nextCursor, true)} disabled={loading}>{loading ? 'Loading...' : 'Load older records'}</button>}</>}</section>
}
