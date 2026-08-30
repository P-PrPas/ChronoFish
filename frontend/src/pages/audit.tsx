import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type ApiItem, get } from "../api/client";
import { Empty, ErrorMessage } from "../components";
import { formatBangkokDateTime } from "../time";
import { type AppText, text } from "../types";

type AuditFilters = {
  table: string;
  recordId: string;
  operatorId: string;
  from: string;
  to: string;
};

const emptyFilters: AuditFilters = {
  table: "",
  recordId: "",
  operatorId: "",
  from: "",
  to: "",
};

function queryString(filters: AuditFilters, cursor?: string): string {
  const values = Object.entries(filters).filter(([, value]) => value) as [string, string][];
  if (cursor) values.push(["cursor", cursor]);
  const query = new URLSearchParams(values).toString();
  return query ? `?${query}` : "";
}

function jsonValue(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

const actionLabel = (value: string, thai: boolean) => ({ INSERT: thai ? 'สร้างรายการ' : 'Created', UPDATE: thai ? 'แก้ไขรายการ' : 'Updated', DELETE: thai ? 'ลบรายการ' : 'Deleted' }[value] ?? value)
const tableLabel = (value: string, thai: boolean) => ({ sites: thai ? 'สถานที่ปฏิบัติงาน' : 'Lab location', experiment_batch: thai ? 'การทดลอง' : 'Experiment', experiment_batches: thai ? 'การทดลอง' : 'Experiment', batch: thai ? 'การทดลอง' : 'Experiment', clone_fish: thai ? 'ทะเบียนปลา' : 'Fish record', fish: thai ? 'ทะเบียนปลา' : 'Fish record', fish_observations: thai ? 'ผลการตรวจปลา' : 'Fish observation', embryo_observations: thai ? 'ผลการตรวจตัวอ่อน' : 'Embryo observation', embryo: thai ? 'ผลการตรวจตัวอ่อน' : 'Embryo observation', specimens: thai ? 'ตัวอย่างเนื้อเยื่อและ DNA' : 'Tissue or DNA sample', specimen: thai ? 'ตัวอย่างเนื้อเยื่อและ DNA' : 'Tissue or DNA sample' }[value] ?? value.replaceAll('_', ' '))

export function Audit({ t = text.en }: { t?: AppText } = {}) {
  const thai = t === text.th;
  const [draft, setDraft] = useState<AuditFilters>(emptyFilters);
  const [filters, setFilters] = useState<AuditFilters>(emptyFilters);
  const [items, setItems] = useState<ApiItem[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [nextCursor, setNextCursor] = useState<string>();

  const load = useCallback(
    (cursor?: string, append = false) => {
      setLoading(true);
      setError("");
      void get(`/audit-log${queryString(filters, cursor)}`)
        .then((data) => {
          const page = data.items ?? [];
          setItems((current) => (append ? [...current, ...page] : page));
          setNextCursor(data.nextCursor ? String(data.nextCursor) : undefined);
          setLoaded(true);
        })
        .catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : "Unable to load audit history");
        })
        .finally(() => setLoading(false));
    },
    [filters],
  );

  useEffect(() => {
    load();
  }, [load]);

  const update = (key: keyof AuditFilters, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setItems([]);
    setNextCursor(undefined);
    setLoaded(false);
    setFilters({ ...draft });
  };

  const clearFilters = () => {
    setDraft(emptyFilters);
    setItems([]);
    setNextCursor(undefined);
    setLoaded(false);
    setFilters({ ...emptyFilters });
  };

  return (
    <section aria-busy={loading}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{thai ? 'หลักฐานการเปลี่ยนแปลงข้อมูล' : 'DATA CHANGE EVIDENCE'}</p>
          <h1>{thai ? 'ตรวจสอบการแก้ไขย้อนหลัง' : 'Change history'}</h1>
          <p className="muted">{thai ? 'ค้นหาว่าใครแก้ข้อมูลอะไร เมื่อใด และเปรียบเทียบค่าก่อน–หลังโดยไม่ต้องอ่านชื่อฐานข้อมูล' : 'See who changed what and when, with before-and-after values kept for verification.'}</p>
        </div>
        <button
          className="button button--secondary"
          type="button"
          onClick={() => load()}
          disabled={loading}
        >
          {loading ? t.loading : t.refresh}
        </button>
      </div>

      <form onSubmit={applyFilters}>
        <details className="filter-disclosure">
          <summary>{t.historyFilters}</summary>
        <fieldset className="filter-bar">
          <legend>{t.historyFilters}</legend>
          <label>
            {t.table}
            <input value={draft.table} onChange={(event) => update("table", event.target.value)} placeholder="experiment_batch" />
          </label>
          <label>
            {t.recordId}
            <input value={draft.recordId} onChange={(event) => update("recordId", event.target.value)} />
          </label>
          <label>
            {t.operatorId}
            <input value={draft.operatorId} onChange={(event) => update("operatorId", event.target.value)} />
          </label>
          <label>
            {t.from}
            <input type="datetime-local" value={draft.from} onChange={(event) => update("from", event.target.value)} />
          </label>
          <label>
            {t.to}
            <input type="datetime-local" value={draft.to} onChange={(event) => update("to", event.target.value)} />
          </label>
          <div className="button-row">
            <button className="button button--primary" type="submit" disabled={loading}>
              {t.refresh}
            </button>
            <button className="button button--secondary" type="button" onClick={clearFilters} disabled={loading}>
              {t.clear}
            </button>
          </div>
        </fieldset>
        </details>
      </form>

      {error && <ErrorMessage message={error} />}
      {loading && <p className="table-note" role="status">{t.loading}</p>}
      {!loading && loaded && items.length === 0 && <Empty message={t.noAuditMatches} />}
      {!loading && items.length > 0 && (
        <div className="list" aria-label={t.audit}>
          {items.map((item) => {
            const action = String(item.action ?? "—");
            const table = String(item.tableName ?? "—");
            const recordId = String(item.recordId ?? "—");
            const operatorId = String(item.operatorId ?? "—");
            const operator = item.operatorName ? String(item.operatorName) : (thai ? "ผู้ปฏิบัติงาน" : "Operator");
            const occurredAt = String(item.occurredAt ?? "");
            const displayedAt = formatBangkokDateTime(occurredAt) || "—";
            const readableAction = actionLabel(action, thai);
            const readableTable = tableLabel(table, thai);
            return (
              <details className="list-row audit-row" key={String(item.id)}>
                <summary>
                  <span>
                    <strong>{readableAction} · {readableTable}</strong>
                    <small>
                      <time dateTime={occurredAt}>{displayedAt}</time>
                    </small>
                  </span>
                  <span className="pill">{operator}</span>
                </summary>
                <div className="audit-detail">
                  <dl className="audit-meta">
                    <div><dt>{t.action}</dt><dd>{readableAction} <span className="mono">({action})</span></dd></div>
                    <div><dt>{t.table}</dt><dd>{readableTable}</dd></div>
                    <div><dt>{t.record}</dt><dd className="mono">{recordId}</dd></div>
                    <div><dt>{t.operator}</dt><dd>{operator}<br /><span className="mono">{operatorId}</span></dd></div>
                    <div><dt>{t.device}</dt><dd>{String(item.deviceId ?? "—")}</dd></div>
                    <div><dt>{t.timestamp}</dt><dd>{displayedAt}</dd></div>
                  </dl>
                  <div className="audit-values">
                    <div><h2>{t.before}</h2><pre>{jsonValue(item.oldValues)}</pre></div>
                    <div><h2>{t.after}</h2><pre>{jsonValue(item.newValues)}</pre></div>
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      )}
      {nextCursor && !loading && (
        <button className="button button--secondary" type="button" onClick={() => load(nextCursor, true)}>
          {t.loadMore}
        </button>
      )}
    </section>
  );
}
