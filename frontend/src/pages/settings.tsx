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

const seedProtocolId = "01900000-0000-7000-8000-000000000001";

export function Timing({ t = text.en }: { t?: AppText } = {}) {
  const [profile, setProfile] = useState<ApiItem | null>(null);
  const [entries, setEntries] = useState<ApiItem[]>([]);
  const [protocols, setProtocols] = useState<ApiItem[]>([]);
  const [protocolId, setProtocolId] = useState("");
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [name, setName] = useState("Lab timing update");
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => {
    if (!protocolId) {
      setProfile(null);
      setEntries([]);
      return;
    }
    void get(`/timing-profiles/current?protocolId=${protocolId}`)
      .then((value) => {
        setProfile(value);
        setEntries((value.entries as ApiItem[] | undefined) ?? []);
      })
      .catch((e: Error) => setError(e.message));
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
  useEffect(load, [load]);
  useEffect(() => {
    const refresh = () => load();
    window.addEventListener("chronofish:queue-drained", refresh);
    return () =>
      window.removeEventListener("chronofish:queue-drained", refresh);
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
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !protocolId) return;
    setImporting(true);
    setError("");
    try {
      const body = await file.text();
      const result = await putQueue(
        `/timing-profiles/csv?protocolId=${protocolId}`,
        body,
        "text/csv",
      );
      if (!result.queued) await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(false);
      event.target.value = "";
    }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = {
        protocolId,
        name,
        entries: entries.map((entry, index) => ({
          stageOrder: Number(entry.stageOrder ?? index + 1),
          stageCode: String(entry.stageCode ?? entry.code),
          stageLabel: String(entry.stageLabel ?? entry.label),
          expectedHpa: Number(entry.expectedHpa),
        })),
      };
      const result = await putQueue("/timing-profiles", payload);
      if (result.queued)
        setError(
          "Timing profile saved offline; it will create a new version when online",
        );
      else await load();
    } catch (e) {
      setError((e as Error).message);
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
  return (
    <section>
      <div className="page-heading">
        <div>
          <p className="eyebrow">SCR-15 / VERSIONED</p>
          <label>
            Protocol
            <select
              required
              value={protocolId}
              onChange={(event) => {
                setProtocolId(event.target.value);
                setProfile(null);
                setEntries([]);
              }}
            >
              <option value="">Select protocol</option>
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
          <h1>{t.timing}</h1>
          <p className="muted">
            Edit expected HPA values and save one complete new version. Existing
            batches keep their snapshot.
          </p>
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
              onChange={upload}
            />
          </label>
        </div>
      </div>
      {error && <ErrorMessage message={error} />}
      {profile && (
        <form className="form-card" onSubmit={save}>
          <label>
            New version name
            <input
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Label</th>
                  <th>Expected HPA</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, index) => (
                  <tr key={String(entry.id ?? entry.stageCode)}>
                    <td>{String(entry.stageCode ?? entry.code)}</td>
                    <td>{String(entry.stageLabel ?? entry.label)}</td>
                    <td>
                      <input
                        aria-label={`Expected HPA ${String(entry.stageCode ?? index + 1)}`}
                        type="number"
                        min="0"
                        step="0.0001"
                        value={Number(entry.expectedHpa)}
                        onChange={(event) =>
                          updateEntry(index, event.target.value)
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="button button--primary" disabled={saving}>
            {saving ? t.saving : t.saveTimingVersion}
          </button>
        </form>
      )}
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
    <section>
      <div className="page-heading">
        <div>
          <p className="eyebrow">SCR-07 / CONFIRMATION REQUIRED</p>
          <h1>{t.promotions}</h1>
          <p className="muted">
            Review strain, first abnormality, fish code, and optional box before
            confirmation.
          </p>
        </div>
        <div className="button-row">
          <button className="button button--secondary" onClick={load}>
            {t.refresh}
          </button>
          <button
            className="button button--primary"
            disabled={!eligibleSelected.length}
            onClick={() => void promote(eligibleSelected)}
          >
            {t.confirmSelected} ({eligibleSelected.length})
          </button>
        </div>
      </div>
      {message && <ErrorMessage message={message} />}
      {items.length === 0 ? (
        <Empty message={t.noEligiblePromotions} />
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
              <div className="list-row" key={id}>
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
                      Strain {String(item.strain ?? "—")} · DOB{" "}
                      {String(item.dob)} · first abnormality{" "}
                      {String(item.firstAbnormalStageLabel ?? "—")}
                    </small>
                  </span>
                </label>
                <input
                  aria-label={`Fish code ${String(item.embryoCode)}`}
                  value={edit.fishCode}
                  onChange={(event) =>
                    setEdits((current) => ({
                      ...current,
                      [id]: { ...edit, fishCode: event.target.value },
                    }))
                  }
                />
                <select
                  aria-label={`Fish box ${String(item.embryoCode)}`}
                  value={edit.fishBoxId}
                  onChange={(event) =>
                    setEdits((current) => ({
                      ...current,
                      [id]: { ...edit, fishBoxId: event.target.value },
                    }))
                  }
                >
                  <option value="">No box</option>
                  {boxes.map((box) => (
                    <option key={String(box.id)} value={String(box.id)}>
                      {String(box.boxCode ?? box.code)}
                    </option>
                  ))}
                </select>
                <button
                  className="button button--primary"
                  disabled={isQueued}
                  onClick={() => void promote([item])}
                >
                  {isQueued ? t.queued : t.confirm}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

type ControlRow = {
  armType: "NATURAL_BREEDING" | "IVF";
  stageCode: string;
  nNormal: number;
  nAbnormal: number;
};
export function Controls({ t = text.en }: { t?: AppText } = {}) {
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
  useEffect(() => {
    void get("/batches").then((data) => setBatches(data.items ?? []));
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
  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await putQueue(`/batches/${batchId}/control-arm-counts`, { items: rows });
      setMessage(t.controlCountsSaved);
    } catch (e) {
      setMessage((e as Error).message);
    }
  };
  return (
    <section>
      <div className="page-heading">
        <div>
          <p className="eyebrow">SCR-11 / CONTROL ARMS</p>
          <h1>{t.controls}</h1>
          <p className="muted">
            Record multiple natural-breeding and IVF rows against real batch and
            stage data.
          </p>
        </div>
      </div>
      <form className="form-card" onSubmit={save}>
        <label>
          Protocol
          <select
            required
            value={protocolId}
            onChange={(event) => setProtocolId(event.target.value)}
          >
            <option value="">Select protocol</option>
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
          Batch
          <select
            required
            value={batchId}
            onChange={(event) => setBatchId(event.target.value)}
          >
            <option value="">Select batch</option>
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
              Arm
              <select
                value={row.armType}
                onChange={(event) =>
                  update(index, {
                    armType: event.target.value as ControlRow["armType"],
                  })
                }
              >
                <option>NATURAL_BREEDING</option>
                <option>IVF</option>
              </select>
            </label>
            <label>
              Stage
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
              Normal
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
              Abnormal
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
              Remove
            </button>
          </div>
        ))}
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
            Add arm row
          </button>
          <button className="button button--primary" type="submit">
            Save counts
          </button>
        </div>
      </form>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
