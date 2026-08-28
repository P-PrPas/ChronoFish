import type { ReactNode } from 'react'

export function Metric({ label, value }: { label: string; value: number | string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div> }
export function ReportPanel({ title, children, loading = false, empty = false, emptyMessage = 'No data', sampleSize, quality }: { title: string; children: ReactNode; loading?: boolean; empty?: boolean; emptyMessage?: string; sampleSize?: number; quality?: ReactNode }) {
  return <section className="report-panel" aria-busy={loading}>
    <h2>{title}{sampleSize !== undefined ? ` (n=${sampleSize})` : ''}</h2>
    {loading ? <p className="table-note" role="status">Loading analytics…</p> : empty ? <><p className="table-note">{emptyMessage}</p>{quality}</> : <>{children}{quality}</>}
  </section>
}
export function ReportTable({ headers, rows, caption }: { headers: string[]; rows: (string | number)[][]; caption?: string }) { return <div className="table-wrap"><table aria-label={caption ?? 'Report table'}>{caption && <caption className="sr-only">{caption}</caption>}<thead><tr>{headers.map((header) => <th key={header} scope="col">{header}</th>)}</tr></thead><tbody>{rows.length === 0 ? <tr><td colSpan={headers.length}>No data</td></tr> : rows.map((row, index) => <tr key={index}>{row.map((value, cell) => <td key={cell}>{String(value)}</td>)}</tr>)}</tbody></table></div> }
export function Empty({ message }: { message: string }) { return <div className="empty"><span aria-hidden="true"><svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 7h16v12H4zM8 7V4h8v3M9 12h6" /></svg></span><p>{message}</p></div> }
export function ErrorMessage({ message }: { message: string }) { return <p className="error" role="alert">{message}</p> }
