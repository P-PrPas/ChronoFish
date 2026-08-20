import { useEffect, useState } from 'react'
import { type ApiItem, get } from '../api/client'
import { Empty, ErrorMessage } from '../components'

export function Audit() {
  const [items, setItems] = useState<ApiItem[]>([]); const [error, setError] = useState('')
  useEffect(() => { void get('/audit-log').then((data) => setItems(data.items ?? [])).catch((e: Error) => setError(e.message)) }, [])
  return <section><div className="page-heading"><div><p className="eyebrow">SCR-18 / APPEND-ONLY</p><h1>Audit history</h1><p className="muted">Every mutation records operator, device, and before/after values.</p></div></div>{error && <ErrorMessage message={error} />}{items.length === 0 ? <Empty message="No audit records yet" /> : <div className="list">{items.map((item) => <div className="list-row" key={String(item.id)}><span><strong>{String(item.action)} · {String(item.tableName)}</strong><small>{String(item.recordId)} · {String(item.occurredAt)}</small></span><span className="pill">{String(item.operatorName ?? item.operatorId ?? '—')}</span></div>)}</div>}</section>
}
