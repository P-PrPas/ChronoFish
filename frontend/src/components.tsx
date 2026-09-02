import type { ReactNode } from "react";
import { text } from "./types";

// Sentinel codes thrown by the API client are not user-facing copy. Mapping
// them here covers every page at once, and <html lang> already carries the
// language so no caller has to pass it down.
const errorCopy: Record<string, keyof typeof text.th> = { OPERATOR_REQUIRED: "operatorRequired" };

export function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function ReportPanel({
  title,
  children,
  loading = false,
  loadingMessage,
  empty = false,
  emptyMessage = "No data",
  quality,
}: {
  title: string;
  children: ReactNode;
  loading?: boolean;
  loadingMessage?: string;
  empty?: boolean;
  emptyMessage?: string;
  quality?: ReactNode;
}) {
  const localizedLoading = loadingMessage ?? (/[฀-๿]/.test(title) ? "กำลังโหลดข้อมูลวิเคราะห์…" : "Loading analytics…");
  return (
    <section className="report-panel" aria-busy={loading}>
      <h2>{title}</h2>
      {loading ? (
        <p className="table-note" role="status">
          {localizedLoading}
        </p>
      ) : empty ? (
        <>
          <p className="table-note">{emptyMessage}</p>
          {quality}
        </>
      ) : (
        <>
          {children}
          {quality}
        </>
      )}
    </section>
  );
}

export function ReportTable({
  headers,
  rows,
  caption,
  emptyMessage = "No data",
  collapsed = false,
  summary = "View supporting data",
}: {
  headers: string[];
  rows: (string | number)[][];
  caption?: string;
  emptyMessage?: string;
  collapsed?: boolean;
  summary?: string;
}) {
  const localizedEmpty =
    emptyMessage === "No data" && headers.some((header) => /[฀-๿]/.test(header)) ? "ไม่มีข้อมูล" : emptyMessage;
  const table = (
    <div className="table-wrap" role="region" tabIndex={0} aria-label={caption ?? summary}>
      <table>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={headers.length}>{localizedEmpty}</td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr key={index}>
                {row.map((value, cell) => (
                  <td key={cell}>{String(value)}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
  return collapsed ? (
    <details className="data-disclosure">
      <summary>{summary}</summary>
      {table}
    </details>
  ) : (
    table
  );
}

export function Empty({
  message,
  actionLabel,
  onAction,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty">
      <span aria-hidden="true">
        <svg
          className="icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <path d="M4 7h16v12H4zM8 7V4h8v3M9 12h6" />
        </svg>
      </span>
      <p>{message}</p>
      {actionLabel && onAction && (
        <button type="button" className="button button--secondary" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function ErrorMessage({ message }: { message: string }) {
  const key = errorCopy[message];
  const copy = key ? text[document.documentElement.lang === "en" ? "en" : "th"][key] : message;
  return (
    <p className="error" role="alert" tabIndex={-1} autoFocus>
      {copy}
    </p>
  );
}
