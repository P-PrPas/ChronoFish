import type { ReactNode } from 'react'

export function Metric({ label, value }: { label: string; value: number }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div> }
export function ReportPanel({ title, children }: { title: string; children: ReactNode }) { return <section className="report-panel"><h2>{title}</h2>{children}</section> }
export function ReportTable({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) { return <div className="table-wrap"><table><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.length === 0 ? <tr><td colSpan={headers.length}>No data</td></tr> : rows.map((row, index) => <tr key={index}>{row.map((value, cell) => <td key={cell}>{String(value)}</td>)}</tr>)}</tbody></table></div> }
export function Empty({ message }: { message: string }) { return <div className="empty"><span aria-hidden="true">⌁</span><p>{message}</p></div> }
export function ErrorMessage({ message }: { message: string }) { return <p className="error" role="alert">{message}</p> }
