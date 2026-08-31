import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useState,
} from "react";
import { type ApiItem, get, request } from "../api/client";
import { putQueue, type QueuedWrite } from "../offline";
import { Empty, ErrorMessage } from "../components";
import { uuidv7 } from "../uuidv7";
import { type AppText, text } from "../types";
import { formatBangkokDateTime } from "../time";

const seedProtocolId = "01900000-0000-7000-8000-000000000001";

type CsvRow = {
  row: number;
  stageCode: string;
  label: string;
  expectedHpa: string;
  errors: string[];
};

type CsvPreview = {
  fileName: string;
  text: string;
  rows: CsvRow[];
  errors: string[];
};

const csvHeader = "stage_order,stage_code,label,expected_hpa";

function csvCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error("unclosed quoted value");
  cells.push(cell);
  return cells;
}

function previewCsv(fileName: string, textValue: string, stages: ApiItem[]): CsvPreview {
  // ponytail: canonical exports never contain multiline labels; the backend csv parser remains authoritative.
  const lines = textValue.replace(/^\uFEFF/, "").split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== csvHeader) {
    return { fileName, text: textValue, rows: [], errors: [`Row 1: expected header ${csvHeader}`] };
  }
  const knownStages = new Map(
    stages.map((stage) => [String(stage.stageCode ?? stage.code), Number(stage.stageOrder)]),
  );
  const seen = new Set<string>();
  const rows = lines.slice(1).flatMap((line, index) => {
    if (!line.trim()) return [];
    const rowNumber = index + 2;
    let cells: string[];
    try {
      cells = csvCells(line);
    } catch (error) {
      return [{ row: rowNumber, stageCode: "", label: "", expectedHpa: "", errors: [(error as Error).message] }];
    }
    const [orderText = "", stageCode = "", label = "", expectedHpa = ""] = cells;
    const errors: string[] = [];
    const order = Number(orderText);
    if (cells.length !== 4) errors.push("must contain exactly 4 columns");
    if (!Number.isInteger(order)) errors.push("stage_order must be an integer");
    if (!knownStages.has(stageCode) || knownStages.get(stageCode) !== order)
      errors.push("stage_code does not match stage_order");
    if (seen.has(stageCode)) errors.push("duplicate stage");
    else seen.add(stageCode);
    const expected = Number(expectedHpa);
    if (!expectedHpa.trim() || !Number.isFinite(expected) || expected < 0)
      errors.push("expected_hpa must be a number greater than or equal to 0");
    return [{ row: rowNumber, stageCode, label, expectedHpa, errors }];
  });
  const errors = rows.length === 0 ? ["Row 2: CSV must contain at least one data row"] : [];
  return { fileName, text: textValue, rows, errors };
}

function apiError(error: unknown): string {
  const failure = error as Error & { details?: { rows?: { row?: number; message?: string }[] } };
  const rows = failure.details?.rows;
  return rows?.length
    ? rows.map((row) => `Row ${row.row ?? "?"}: ${row.message ?? failure.message}`).join(" · ")
    : failure.message;
}

function createdAt(profile: ApiItem): string {
  const value = String(profile.createdAt ?? "");
  return formatBangkokDateTime(value) || "—";
}

function changedStages(profile: ApiItem, previous?: ApiItem, thai = false): string {
  const current = (profile.entries as ApiItem[] | undefined) ?? [];
  if (!previous) return thai ? `ค่าเริ่มต้น · ${current.length} ระยะ` : `Initial profile · ${current.length} stages`;
  const oldValues = new Map(
    ((previous.entries as ApiItem[] | undefined) ?? []).map((entry) => [
      String(entry.stageCode ?? entry.code),
      Number(entry.expectedHpa),
    ]),
  );
  const changes = current.filter(
    (entry) => oldValues.get(String(entry.stageCode ?? entry.code)) !== Number(entry.expectedHpa),
  );
  if (changes.length === 0) return thai ? "ไม่มีค่าเวลาเปลี่ยนแปลง" : "No timing values changed";
  return changes
    .slice(0, 3)
    .map((entry) => {
      const code = String(entry.stageCode ?? entry.code);
      return `${code}: ${oldValues.get(code) ?? "—"} → ${Number(entry.expectedHpa)}`;
    })
    .join(" · ") + (changes.length > 3 ? ` · +${changes.length - 3} ${thai ? "ระยะ" : "more"}` : "");
}

export function Timing({ t = text.en }: { t?: AppText } = {}) {
  const [profile, setProfile] = useState<ApiItem | null>(null);
  const [entries, setEntries] = useState<ApiItem[]>([]);
  const [history, setHistory] = useState<ApiItem[]>([]);
  const [protocols, setProtocols] = useState<ApiItem[]>([]);
  const [operatorNames, setOperatorNames] = useState<Record<string, string>>({});
  const [protocolId, setProtocolId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [csvPreview, setCsvPreview] = useState<CsvPreview | null>(null);
  const [name, setName] = useState("Lab timing update");
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    if (!protocolId) {
      setProfile(null);
      setEntries([]);
      setHistory([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [current, versions] = await Promise.all([
        get(`/timing-profiles/current?protocolId=${protocolId}`),
        get(`/timing-profiles?protocolId=${protocolId}`),
      ]);
      setProfile(current);
      setEntries((current.entries as ApiItem[] | undefined) ?? []);
      setHistory(versions.items ?? []);
    } catch (loadError) {
      setError(apiError(loadError));
    } finally {
      setLoading(false);
    }
  }, [protocolId]);
  useEffect(() => {
    void get("/protocols")
      .then((data) => {
        const items = data.items ?? [];
        setProtocols(items);
        if (!protocolId) setProtocolId(String(items[0]?.id ?? seedProtocolId));
      })
      .catch((e: Error) => {
        setError(e.message);
        if (!protocolId) setProtocolId(seedProtocolId);
      });
  }, []);
  useEffect(() => {
    void get("/operators?includeInactive=true")
      .then((data) =>
        setOperatorNames(
          Object.fromEntries((data.items ?? []).map((item) => [String(item.id), String(item.name ?? item.id)])),
        ),
      )
      .catch(() => setOperatorNames({}));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<QueuedWrite>).detail;
      if (detail?.path.startsWith("/timing-profiles")) {
        setCsvPreview(null);
        setMessage("");
        void load();
      }
    };
    const reject = (event: Event) => {
      const detail = (event as CustomEvent<QueuedWrite>).detail;
      if (detail?.path.startsWith("/timing-profiles")) setError(detail.lastError ?? "Timing update rejected");
    };
    window.addEventListener("chronofish:queue-drained", refresh);
    window.addEventListener("chronofish:queue-rejected", reject);
    return () => {
      window.removeEventListener("chronofish:queue-drained", refresh);
      window.removeEventListener("chronofish:queue-rejected", reject);
    };
  }, [load]);
  const download = async () => {
    if (!protocolId) return;
    try {
      const response = await request(
        `/timing-profiles/csv?protocolId=${protocolId}`,
      );
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "timing-profile.csv";
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const selectCsv = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !protocolId) return;
    setError("");
    try {
      const body = await file.text();
      setCsvPreview(previewCsv(file.name, body, entries));
    } catch (readError) {
      setError(apiError(readError));
    } finally {
      event.target.value = "";
    }
  };
  const importCsv = async () => {
    if (!csvPreview || csvPreview.errors.length || csvPreview.rows.some((row) => row.errors.length)) return;
    if (!window.confirm(thai ? `นำเข้าข้อมูลเวลา ${csvPreview.rows.length} แถวเป็นเวอร์ชันใหม่หรือไม่?` : `Import ${csvPreview.rows.length} timing rows as a new version?`)) return;
    setImporting(true);
    setError("");
    setMessage("");
    try {
      const result = await putQueue(
        `/timing-profiles/csv?protocolId=${protocolId}`,
        csvPreview.text,
        "text/csv",
      );
      if (result.queued) setMessage(thai ? "รอนำเข้า CSV เวอร์ชันใหม่จะแสดงหลังซิงก์" : "CSV import queued; the new version will appear after sync");
      else {
        setCsvPreview(null);
        await load();
      }
    } catch (importError) {
      setError(apiError(importError));
    } finally {
      setImporting(false);
    }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const oldEntries = new Map(
      (((profile?.entries as ApiItem[] | undefined) ?? []).map((entry) => [
        String(entry.stageCode ?? entry.code),
        Number(entry.expectedHpa),
      ])),
    );
    const changed = entries.filter(
      (entry) => oldEntries.get(String(entry.stageCode ?? entry.code)) !== Number(entry.expectedHpa),
    );
    if (changed.length === 0) {
      setError(thai ? "เปลี่ยนค่า HPA ที่คาดไว้อย่างน้อยหนึ่งระยะก่อนบันทึก" : "Change at least one expected HPA value before saving");
      return;
    }
    if (!window.confirm(thai ? `สร้างเวอร์ชันเวลาใหม่จากการเปลี่ยน ${changed.length} ระยะหรือไม่?` : `Create a new timing profile version with ${changed.length} changed stage(s)?`)) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const payload = {
        protocolId,
        name,
        entries: changed.map((entry) => ({
          stageCode: String(entry.stageCode ?? entry.code),
          expectedHpa: Number(entry.expectedHpa),
        })),
      };
      const result = await putQueue("/timing-profiles", payload);
      if (result.queued)
        setMessage(
          thai ? "รอส่งโปรไฟล์เวลา ระบบจะสร้างเวอร์ชันใหม่เมื่อออนไลน์" : "Timing profile queued; it will create a new version when online",
        );
      else await load();
    } catch (saveError) {
      setError(apiError(saveError));
    } finally {
      setSaving(false);
    }
  };
  const updateEntry = (index: number, value: string) =>
    setEntries((current) =>
      current.map((entry, position) =>
        position === index ? { ...entry, expectedHpa: Number(value) } : entry,
      ),
    );
  const thai = t === text.th;
  return (
    <section>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{thai ? "มาตรฐานเวลาแบบเก็บเวอร์ชัน" : "VERSIONED TIMING STANDARD"}</p>
          <h1>{thai ? "เวลามาตรฐานของแต่ละระยะ" : "Timing standards by stage"}</h1>
          <p className="muted">
            {thai ? "เลือกโพรโทคอล แล้วปรับเฉพาะระยะที่ต้องการ ระบบจะสร้างเวอร์ชันใหม่โดยไม่เปลี่ยนข้อมูลการทดลองเดิม" : "Choose a protocol and change only the stages you need. Saving creates a new version without changing existing experiments."}
          </p>
          <label>
            {thai ? "โพรโทคอล" : "Protocol"}
            <select
              required
              value={protocolId}
              onChange={(event) => {
                setProtocolId(event.target.value);
                setProfile(null);
                setEntries([]);
                setHistory([]);
                setCsvPreview(null);
              }}
            >
              <option value="">{thai ? "เลือกโพรโทคอล" : "Select protocol"}</option>
              {protocols.length === 0 && protocolId && (
                <option value={protocolId}>Default protocol</option>
              )}
              {protocols.map((item) => (
                <option key={String(item.id)} value={String(item.id)}>
                  {String(item.name ?? item.code ?? item.id)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="button-row">
          <button className="button button--secondary" onClick={download}>
            {t.downloadCSV}
          </button>
          <label className="button button--secondary">
            {importing ? t.importing : t.importCSV}
            <input
              className="sr-only"
              type="file"
              accept=".csv,text/csv"
              disabled={importing}
              onChange={selectCsv}
            />
          </label>
        </div>
      </div>
      {error && <ErrorMessage message={error} />}
      {message && <p className="notice">{message}</p>}
      {loading && <p className="muted">{thai ? "กำลังโหลดเวลามาตรฐาน…" : "Loading timing profile…"}</p>}
      {profile && (
        <>
          <div className="list-row">
            <span>
              <strong>{thai ? "เวอร์ชันที่ใช้อยู่" : "Current version"} {String(profile.version)}</strong>
              <small>{String(profile.name)} · {createdAt(profile)} · {thai ? "บันทึกโดย" : "by"} {operatorNames[String(profile.createdByOperatorId)] ?? (thai ? "ไม่ระบุผู้ปฏิบัติงาน" : "Unknown operator")}</small>
            </span>
            <span className="pill">{thai ? "กำลังใช้งาน" : "Current"}</span>
          </div>
          <form className="form-card" onSubmit={save}>
            <label>
              {thai ? "ชื่อเวอร์ชันใหม่" : "New version name"}
              <input
                required
                maxLength={200}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <details className="workflow-disclosure">
              <summary>{thai ? `ปรับค่า HPA รายระยะ · ${entries.length} ระยะ` : `Edit HPA by stage · ${entries.length} stages`}</summary>
              <div className="workflow-disclosure__body table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{thai ? "ระยะ" : "Stage"}</th>
                    <th>{thai ? "ชื่อระยะ" : "Label"}</th>
                    <th>{thai ? "HPA ปัจจุบัน" : "Current HPA"}</th>
                    <th>{thai ? "HPA ใหม่" : "New HPA"}</th>
                    <th>{thai ? "ผลต่าง" : "Change"}</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, index) => {
                    const original = Number((profile.entries as ApiItem[])[index]?.expectedHpa);
                    const updated = Number(entry.expectedHpa);
                    return (
                      <tr key={String(entry.id ?? entry.stageCode)}>
                        <td>{String(entry.stageCode ?? entry.code)}</td>
                        <td>{String(entry.stageLabel ?? entry.label)}</td>
                        <td>{original}</td>
                        <td>
                          <input
                            aria-label={`${thai ? "HPA ใหม่ของ" : "New HPA for"} ${String(entry.stageCode ?? index + 1)}`}
                            type="number"
                            required
                            min="0"
                            step="0.0001"
                            value={updated}
                            onChange={(event) => updateEntry(index, event.target.value)}
                          />
                        </td>
                        <td>{updated === original ? "—" : `${updated - original > 0 ? "+" : ""}${(updated - original).toFixed(4)}`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </details>
            <button className="button button--primary" disabled={saving}>
              {saving ? t.saving : t.saveTimingVersion}
            </button>
          </form>
        </>
      )}
      {csvPreview && (
        <section className="form-card" aria-label={thai ? "ตัวอย่าง CSV" : "CSV preview"}>
          <div>
            <h2>{thai ? "ตัวอย่าง CSV" : "CSV preview"}</h2>
            <p className="muted">{csvPreview.fileName} · {csvPreview.rows.length} {thai ? "แถวพร้อมนำเข้า" : "rows ready"}</p>
          </div>
          {csvPreview.errors.map((previewError) => <ErrorMessage key={previewError} message={previewError} />)}
          <div className="table-wrap">
            <table>
              <thead><tr>{(thai ? ["แถว", "ระยะ", "ชื่อระยะ", "HPA ที่คาดไว้", "สถานะ"] : ["Row", "Stage", "Label", "Expected HPA", "Status"]).map((header) => <th key={header}>{header}</th>)}</tr></thead>
              <tbody>
                {csvPreview.rows.map((row) => (
                  <tr key={row.row}>
                    <td>{row.row}</td><td>{row.stageCode}</td><td>{row.label}</td><td>{row.expectedHpa}</td>
                    <td>{row.errors.length ? row.errors.join(" · ") : (thai ? "พร้อม" : "Ready")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="button-row">
            <button className="button button--primary" disabled={importing || csvPreview.errors.length > 0 || csvPreview.rows.some((row) => row.errors.length > 0)} onClick={() => void importCsv()}>
              {importing ? t.importing : (thai ? "นำเข้าตัวอย่าง" : "Import preview")}
            </button>
            <button className="button button--secondary" onClick={() => setCsvPreview(null)}>{thai ? "ยกเลิก" : "Cancel"}</button>
          </div>
        </section>
      )}
      <section>
        <h2>{thai ? "ประวัติเวอร์ชัน" : "Version history"}</h2>
        <div className="list">
          {history.map((version, index) => (
            <div className="list-row" key={String(version.id)}>
              <span>
                <strong>{thai ? "เวอร์ชัน" : "Version"} {String(version.version)} · {String(version.name)}</strong>
                <small>{createdAt(version)} · {thai ? "บันทึกโดย" : "by"} {operatorNames[String(version.createdByOperatorId)] ?? (thai ? "ไม่ระบุผู้ปฏิบัติงาน" : "Unknown operator")} · {changedStages(version, history[index + 1], thai)}</small>
              </span>
              {Boolean(version.isCurrent) && <span className="pill">{thai ? "กำลังใช้งาน" : "Current"}</span>}
            </div>
          ))}
          {!loading && history.length === 0 && <Empty message={thai ? "ยังไม่มีประวัติเวอร์ชัน" : "No timing versions"} />}
        </div>
      </section>
    </section>
  );
}

export function Promotions({ t = text.en }: { t?: AppText } = {}) {
  const [items, setItems] = useState<ApiItem[]>([]);
  const [message, setMessage] = useState("");
  const [queued, setQueued] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [boxes, setBoxes] = useState<ApiItem[]>([]);
  const [edits, setEdits] = useState<
    Record<string, { fishCode: string; fishBoxId: string }>
  >({});
  const load = useCallback(() => {
    void get("/promotions/pending")
      .then((data) => {
        setItems(data.items ?? []);
        setEdits(
          Object.fromEntries(
            (data.items ?? []).map((item: ApiItem) => [
              String(item.embryoId),
              { fishCode: String(item.suggestedFishCode ?? ""), fishBoxId: "" },
            ]),
          ),
        );
      })
      .catch((e: Error) => setMessage(e.message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    void get("/fish-boxes")
      .then((data) => setBoxes(data.items ?? []))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    const refresh = () => load();
    const reject = (event: Event) => {
      const detail = (event as CustomEvent<QueuedWrite>).detail;
      if (detail.path === "/promotions") {
        setQueued([]);
        setMessage(
          detail.lastError ??
            t.promotionRejected,
        );
      }
    };
    window.addEventListener("chronofish:queue-drained", refresh);
    window.addEventListener("chronofish:queue-rejected", reject);
    return () => {
      window.removeEventListener("chronofish:queue-drained", refresh);
      window.removeEventListener("chronofish:queue-rejected", reject);
    };
  }, [load]);
  const promote = async (promotions: ApiItem[]) => {
    const ids = promotions.map((item) => String(item.embryoId));
    setQueued((current) => [...new Set([...current, ...ids])]);
    setSelected([]);
    try {
      const result = await putQueue("/promotions", {
        promotions: promotions.map((item) => ({
          clientUuid: uuidv7(),
          embryoId: item.embryoId,
          fishCode:
            edits[String(item.embryoId)]?.fishCode || item.suggestedFishCode,
          fishBoxId: edits[String(item.embryoId)]?.fishBoxId || null,
        })),
      });
      if (!result.queued)
        setItems((current) =>
          current.filter((entry) => !ids.includes(String(entry.embryoId))),
        );
    } catch (e) {
      setQueued((current) => current.filter((id) => !ids.includes(id)));
      setMessage((e as Error).message);
    }
  };
  const eligibleSelected = items.filter(
    (item) =>
      selected.includes(String(item.embryoId)) &&
      !queued.includes(String(item.embryoId)),
  );
  return (
    <form onSubmit={(event) => { event.preventDefault(); void promote(eligibleSelected) }}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t === text.th ? "เปลี่ยนสถานะจากตัวอ่อนเป็นปลา" : "EMBRYO-TO-FISH HANDOFF"}</p>
          <h1>{t === text.th ? "ขึ้นทะเบียนปลาโคลนที่เข้าเกณฑ์" : "Register eligible clone fish"}</h1>
          <p className="muted">
            {t === text.th ? "ตรวจสายพันธุ์ ระยะแรกที่พบความผิดปกติ และรหัสปลา จากนั้นเลือกหลายรายการเพื่อยืนยันพร้อมกัน" : "Review strain, first abnormality and fish code, then select multiple records to confirm together."}
          </p>
        </div>
        <div className="button-row">
          <button className="button button--secondary" type="button" onClick={load}>
            {t.refresh}
          </button>
          <button
            className="button button--primary"
            disabled={!eligibleSelected.length}
          >
            {t.confirmSelected} ({eligibleSelected.length})
          </button>
        </div>
      </div>
      {message && <ErrorMessage message={message} />}
      {items.length === 0 ? (
        <Empty message={t.noEligiblePromotions} actionLabel={t.due} onAction={() => { location.hash = 'due' }} />
      ) : (
        <div className="list">
          {items.map((item) => {
            const id = String(item.embryoId);
            const isQueued = queued.includes(id);
            const edit = edits[id] ?? {
              fishCode: String(item.suggestedFishCode ?? ""),
              fishBoxId: "",
            };
            return (
              <div className="list-row promotion-row" key={id}>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={selected.includes(id)}
                    disabled={isQueued}
                    onChange={() =>
                      setSelected((current) =>
                        current.includes(id)
                          ? current.filter((value) => value !== id)
                          : [...current, id],
                      )
                    }
                  />
                  <span>
                    <strong>{String(item.embryoCode)}</strong>
                    <small>
                      {t === text.th ? "สายพันธุ์" : "Strain"} {String(item.strain ?? "—")} · {t === text.th ? "เกิด" : "DOB"}{" "}
                      {String(item.dob)} · {t === text.th ? "เริ่มพบความผิดปกติ" : "first abnormality"}{" "}{String(item.firstAbnormalStageLabel ?? "—")}
                    </small>
                  </span>
                </label>
                <input
                  aria-label={`${t === text.th ? "รหัสปลา" : "Fish code"} ${String(item.embryoCode)}`}
                  required={selected.includes(id)}
                  value={edit.fishCode}
                  onChange={(event) =>
                    setEdits((current) => ({
                      ...current,
                      [id]: { ...edit, fishCode: event.target.value },
                    }))
                  }
                />
                <select
                  aria-label={`${t === text.th ? "ตู้ปลา" : "Fish box"} ${String(item.embryoCode)}`}
                  value={edit.fishBoxId}
                  onChange={(event) =>
                    setEdits((current) => ({
                      ...current,
                      [id]: { ...edit, fishBoxId: event.target.value },
                    }))
                  }
                >
                  <option value="">{t === text.th ? "ยังไม่ระบุตู้ปลา" : "No box"}</option>
                  {boxes.map((box) => (
                    <option key={String(box.id)} value={String(box.id)}>
                      {String(box.boxCode ?? box.code)}
                    </option>
                  ))}
                </select>
                {isQueued && <span className="pill">{t.queued}</span>}
              </div>
            );
          })}
        </div>
      )}
    </form>
  );
}

type ControlRow = {
  armType: "NATURAL_BREEDING" | "IVF";
  stageCode: string;
  nNormal: number;
  nAbnormal: number;
};
export function Controls({ t = text.en }: { t?: AppText } = {}) {
  const thai = t === text.th;
  const [batchId, setBatchId] = useState("");
  const [batches, setBatches] = useState<ApiItem[]>([]);
  const [protocols, setProtocols] = useState<ApiItem[]>([]);
  const [protocolId, setProtocolId] = useState("");
  const [stages, setStages] = useState<ApiItem[]>([]);
  const [rows, setRows] = useState<ControlRow[]>([
    {
      armType: "NATURAL_BREEDING",
      stageCode: "stage_01_1C",
      nNormal: 0,
      nAbnormal: 0,
    },
  ]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void get("/batches")
      .then((data) => {
        const items = data.items ?? [];
        setBatches(items);
        setBatchId((current) => current || String(items[0]?.id ?? ""));
      })
      .catch((e: Error) => setError(e.message));
    void get("/protocols")
      .then((data) => {
        const items = data.items ?? [];
        setProtocols(items);
        setProtocolId(
          (current) => current || String(items[0]?.id ?? seedProtocolId),
        );
      })
      .catch(() => setProtocolId(seedProtocolId));
  }, []);
  useEffect(() => {
    if (!batchId) return;
    const batch = batches.find((item) => item.id === batchId);
    if (batch?.protocolId) setProtocolId(String(batch.protocolId));
    void get(`/batches/${batchId}/control-arm-counts`)
      .then((data) => {
        const items = (data.items ?? []) as ControlRow[];
        setRows(
          items.length
            ? items
            : [
                {
                  armType: "NATURAL_BREEDING",
                  stageCode: "stage_01_1C",
                  nNormal: 0,
                  nAbnormal: 0,
                },
              ],
        );
      })
      .catch((e: Error) => setError(e.message));
  }, [batchId, batches]);
  useEffect(() => {
    if (!protocolId) return;
    void get(`/protocols/${protocolId}/stages`)
      .then((data) => setStages(data.items ?? []))
      .catch(() =>
        setStages(
          Array.from({ length: 26 }, (_, index) => ({
            code: `stage_${String(index + 1).padStart(2, "0")}`,
            label: `Stage ${index + 1}`,
          })),
        ),
      );
  }, [protocolId]);
  const update = (index: number, value: Partial<ControlRow>) =>
    setRows((current) =>
      current.map((row, position) =>
        position === index ? { ...row, ...value } : row,
      ),
    );
  const totals = rows.reduce(
    (current, row) => ({
      normal: current.normal + row.nNormal,
      abnormal: current.abnormal + row.nAbnormal,
    }),
    { normal: 0, abnormal: 0 },
  );
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    const keys = rows.map((row) => `${row.armType}:${row.stageCode}`);
    if (
      !rows.length ||
      rows.some(
        (row) =>
          !row.stageCode ||
          !Number.isInteger(row.nNormal) ||
          !Number.isInteger(row.nAbnormal) ||
          row.nNormal < 0 ||
          row.nAbnormal < 0,
      ) ||
      new Set(keys).size !== keys.length
    ) {
      setError("Use one row per arm and stage with non-negative whole counts");
      return;
    }
    try {
      await putQueue(`/batches/${batchId}/control-arm-counts`, { items: rows });
      setMessage(t.controlCountsSaved);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{thai ? "บันทึกข้อมูลเพื่อเปรียบเทียบ" : "COMPARISON EVIDENCE"}</p>
          <h1>{thai ? "ผลกลุ่มเปรียบเทียบ" : "Comparison group results"}</h1>
          <p className="muted">
            {thai ? "เลือกการทดลองและระยะ แล้วบันทึกจำนวนปกติ–ผิดปกติของกลุ่มผสมธรรมชาติหรือ IVF" : "Choose an experiment and stage, then record normal and abnormal counts for natural-breeding or IVF groups."}
          </p>
        </div>
      </div>
      <form className="task-surface form-card control-form" onSubmit={save}>
        <label>
          {thai ? "โพรโทคอล" : "Protocol"}
          <select
            required
            value={protocolId}
            onChange={(event) => setProtocolId(event.target.value)}
          >
            <option value="">{thai ? "เลือกโพรโทคอล" : "Select protocol"}</option>
            {protocols.length === 0 && protocolId && (
              <option value={protocolId}>Default protocol</option>
            )}
            {protocols.map((protocol) => (
              <option key={String(protocol.id)} value={String(protocol.id)}>
                {String(protocol.name ?? protocol.code ?? protocol.id)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {thai ? "การทดลอง" : "Batch"}
          <select
            required
            value={batchId}
            onChange={(event) => setBatchId(event.target.value)}
          >
            <option value="">{thai ? "เลือกการทดลอง" : "Select batch"}</option>
            {batches.map((batch) => (
              <option key={String(batch.id)} value={String(batch.id)}>
                {String(batch.batchCode)}
              </option>
            ))}
          </select>
        </label>
        {rows.map((row, index) => (
          <div className="form-card--inline" key={`${index}-${row.armType}`}>
            <label>
              {thai ? "กลุ่มเปรียบเทียบ" : "Arm"}
              <select
                value={row.armType}
                onChange={(event) =>
                  update(index, {
                    armType: event.target.value as ControlRow["armType"],
                  })
                }
              >
                <option value="NATURAL_BREEDING">{thai ? "ผสมพันธุ์ตามธรรมชาติ" : "Natural breeding"}</option>
                <option value="IVF">IVF</option>
              </select>
            </label>
            <label>
              {thai ? "ระยะที่ตรวจ" : "Stage"}
              <select
                value={row.stageCode}
                onChange={(event) =>
                  update(index, { stageCode: event.target.value })
                }
              >
                {stages.map((stage) => (
                  <option
                    key={String(stage.code ?? stage.stageCode)}
                    value={String(stage.code ?? stage.stageCode)}
                  >
                    {String(stage.label ?? stage.stageLabel ?? stage.code)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {thai ? "จำนวนปกติ" : "Normal"}
              <input
                type="number"
                min="0"
                value={row.nNormal}
                onChange={(event) =>
                  update(index, { nNormal: Number(event.target.value) })
                }
              />
            </label>
            <label>
              {thai ? "จำนวนผิดปกติ" : "Abnormal"}
              <input
                type="number"
                min="0"
                value={row.nAbnormal}
                onChange={(event) =>
                  update(index, { nAbnormal: Number(event.target.value) })
                }
              />
            </label>
            <button
              type="button"
              className="inline-action inline-action--danger"
              onClick={() =>
                setRows((current) =>
                  current.filter((_, position) => position !== index),
                )
              }
            >
              {thai ? "ลบแถว" : "Remove"}
            </button>
          </div>
        ))}
        <div className="record-facts">
          <div className="record-fact"><span>{thai ? "ปกติรวม" : "Normal total"}</span><strong>{totals.normal}</strong></div>
          <div className="record-fact"><span>{thai ? "ผิดปกติรวม" : "Abnormal total"}</span><strong>{totals.abnormal}</strong></div>
          <div className="record-fact"><span>{thai ? "จำนวนทั้งหมด" : "Grand total"}</span><strong>{totals.normal + totals.abnormal}</strong></div>
        </div>
        <div className="button-row">
          <button
            type="button"
            className="button button--secondary"
            onClick={() =>
              setRows((current) => [
                ...current,
                {
                  armType: "IVF",
                  stageCode: stages[0]?.code ?? "stage_01_1C",
                  nNormal: 0,
                  nAbnormal: 0,
                },
              ])
            }
          >
            {thai ? "เพิ่มกลุ่มหรือระยะ" : "Add arm row"}
          </button>
          <button className="button button--primary" type="submit">
            {thai ? "บันทึกผลเปรียบเทียบ" : "Save counts"}
          </button>
        </div>
      </form>
      {error && <ErrorMessage message={error} />}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
