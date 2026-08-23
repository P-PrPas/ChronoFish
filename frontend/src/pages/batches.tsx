import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { operatorId, type ApiItem, get } from "../api/client";
import { putQueue, type QueuedWrite } from "../offline";
import { type AppText } from "../types";
import { Empty, ErrorMessage } from "../components";
import {
  dateTimeLocalToRFC3339,
  formatBangkokDateTime,
  rfc3339ToDateTimeLocal,
} from "../time";

const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(
    new Date(),
  );
const dateTimeInput = (value: string) =>
  value
    ? rfc3339ToDateTimeLocal(value)
    : rfc3339ToDateTimeLocal(new Date().toISOString());
const wells = Array.from(
  { length: 96 },
  (_, index) =>
    `${String.fromCharCode(65 + Math.floor(index / 12))}${(index % 12) + 1}`,
);

const masterName = (items: ApiItem[] | undefined, id: unknown) => {
  const item = items?.find((candidate) => candidate.id === id);
  return String(
    item?.name ??
      item?.strain ??
      item?.label ??
      item?.lotCode ??
      item?.code ??
      id ??
      "",
  );
};

export function Batches({ t }: { t: AppText }) {
  const [items, setItems] = useState<ApiItem[]>([]);
  const [selected, setSelected] = useState<ApiItem | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(() => {
    void get("/batches")
      .then((data) => setItems(data.items ?? []))
      .catch((e: Error) => setMessage(e.message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const refresh = () => load();
    const reject = (event: Event) => {
      const detail = (event as CustomEvent<QueuedWrite>).detail;
      if (detail.path === "/batches") {
        setItems((current) => current.filter((item) => !item.queued));
        setMessage(detail.lastError ?? "Queued batch rejected");
      }
    };
    window.addEventListener("chronofish:queue-drained", refresh);
    window.addEventListener("chronofish:queue-rejected", reject);
    return () => {
      window.removeEventListener("chronofish:queue-drained", refresh);
      window.removeEventListener("chronofish:queue-rejected", reject);
    };
  }, [load]);
  if (selected)
    return <BatchDetail batch={selected} onBack={() => setSelected(null)} />;
  const addQueued = (batch: ApiItem) => {
    setItems((current) => [
      { ...batch, id: `queued-${Date.now()}`, queued: true },
      ...current,
    ]);
    setShowForm(false);
    setMessage("Saved offline; will sync automatically");
  };
  return (
    <section>
      <div className="page-heading">
        <div>
          <p className="eyebrow">EXPERIMENTS</p>
          <h1>{t.batches}</h1>
          <p className="muted">
            Create batches, pin timing, and add injection lots.
          </p>
        </div>
        <button
          className="button button--primary"
          onClick={() => setShowForm(!showForm)}
        >
          + {t.save}
        </button>
      </div>
      {message && <ErrorMessage message={message} />}
      {showForm && (
        <BatchForm
          onSaved={() => {
            setShowForm(false);
            load();
          }}
          onQueued={addQueued}
        />
      )}
      {items.length === 0 ? (
        <Empty message={t.empty} />
      ) : (
        <div className="list">
          {items.map((item) => (
            <button
              className="list-row"
              key={String(item.id)}
              onClick={() => setSelected(item)}
            >
              <span>
                <strong>{String(item.batchCode)}</strong>
                <small>
                  {String(item.experimentDate)} · profile{" "}
                  {String(
                    item.timingProfileVersion ?? item.timingProfileId ?? "",
                  )}
                </small>
              </span>
              <span className="pill">{item.queued ? "queued" : "active"}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function BatchForm({
  batch,
  onSaved,
  onQueued,
}: {
  batch?: ApiItem;
  onSaved: () => void;
  onQueued?: (batch: ApiItem) => void;
}) {
  const [form, setForm] = useState({
    batchCode: String(batch?.batchCode ?? ""),
    dayNo: String(batch?.dayNo ?? ""),
    experimentDate: String(batch?.experimentDate ?? today()),
    siteId: String(batch?.siteId ?? ""),
    operatorId: String(batch?.operatorId ?? operatorId()),
    protocolId: String(batch?.protocolId ?? ""),
    treatmentGroupId: String(batch?.treatmentGroupId ?? ""),
    recipientEggLotId: String(batch?.recipientEggLotId ?? ""),
    csofLotId: String(batch?.csofLotId ?? ""),
    clutchCode: String(batch?.clutchCode ?? ""),
    replicateNo: String(batch?.replicateNo ?? ""),
    incubationTempC: String(batch?.incubationTempC ?? ""),
    notes: String(batch?.notes ?? ""),
  });
  const [masters, setMasters] = useState<Record<string, ApiItem[]>>({
    sites: [],
    operators: [],
    protocols: [],
    "treatment-groups": [],
    "recipient-egg-lots": [],
    "csof-lots": [],
  });
  const [error, setError] = useState("");
  useEffect(() => {
    void Promise.all(
      [
        "sites",
        "operators",
        "protocols",
        "treatment-groups",
        "recipient-egg-lots",
        "csof-lots",
      ].map((resource) =>
        get(`/${resource}${batch ? "?includeInactive=true" : ""}`).then(
          (data) => [resource, data.items ?? []] as [string, ApiItem[]],
        ),
      ),
    )
      .then((result) => {
        const next = Object.fromEntries(result);
        setMasters(next);
        setForm((current) => ({
          ...current,
          protocolId:
            current.protocolId || String(next.protocols?.[0]?.id ?? ""),
        }));
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  const set = (key: string, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    const payload = {
      ...form,
      dayNo: form.dayNo ? Number(form.dayNo) : null,
      batchCode: form.batchCode || null,
      recipientEggLotId: form.recipientEggLotId || null,
      csofLotId: form.csofLotId || null,
      clutchCode: form.clutchCode || null,
      replicateNo: form.replicateNo ? Number(form.replicateNo) : null,
      incubationTempC: form.incubationTempC
        ? Number(form.incubationTempC)
        : null,
      notes: form.notes || null,
    };
    try {
      const result = (await putQueue(
        batch ? `/batches/${batch.id}` : "/batches",
        payload,
        "application/json",
        batch ? "PATCH" : "POST",
      )) as ApiItem;
      if (result.queued && onQueued) onQueued(form as unknown as ApiItem);
      else onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <form className="form-card" onSubmit={submit}>
      <h2>{batch ? "Edit batch" : "New batch"}</h2>
      <p className="muted">
        Suggested code:{" "}
        <code>{`${form.dayNo || "day_no"}_${form.operatorId || "operator"}_${form.treatmentGroupId || "treatment"}`}</code>
        . Leave it blank to let the server generate it.
      </p>
      <div className="form-card--inline">
        <label>
          Day no.
          <input
            required
            data-testid="batch-day-no"
            type="number"
            min="1"
            value={form.dayNo}
            onChange={(e) => set("dayNo", e.target.value)}
          />
        </label>
        <label>
          Batch code
          <input
            required={Boolean(batch)}
            data-testid="batch-code"
            value={form.batchCode}
            placeholder={`${form.dayNo || "day_no"}_${form.operatorId || "operator"}_${form.treatmentGroupId || "treatment"}`}
            onChange={(e) => set("batchCode", e.target.value)}
          />
        </label>
        <label>
          Experiment date
          <input
            required
            type="date"
            value={form.experimentDate}
            onChange={(e) => set("experimentDate", e.target.value)}
          />
        </label>
      </div>
      <div className="form-card--inline">
        <label>
          Operator
          <select
            required
            value={form.operatorId}
            onChange={(e) => set("operatorId", e.target.value)}
          >
            <option value="">Choose operator</option>
            {(masters.operators ?? []).map((item) => (
              <option key={String(item.id)} value={String(item.id)}>
                {String(item.name ?? item.code ?? item.id)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Site
          <select
            required
            value={form.siteId}
            onChange={(e) => set("siteId", e.target.value)}
          >
            <option value="">Select site</option>
            {(masters.sites ?? []).map((site) => (
              <option key={String(site.id)} value={String(site.id)}>
                {String(site.code)} — {String(site.name)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Protocol
          <select
            required
            disabled={Boolean(batch)}
            value={form.protocolId}
            onChange={(e) => set("protocolId", e.target.value)}
          >
            <option value="">Select protocol</option>
            {(masters.protocols ?? []).map((item) => (
              <option key={String(item.id)} value={String(item.id)}>
                {String(item.code ?? item.name ?? item.id)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Treatment group
          <select
            required
            value={form.treatmentGroupId}
            onChange={(e) => set("treatmentGroupId", e.target.value)}
          >
            <option value="">Select treatment</option>
            {(masters["treatment-groups"] ?? []).map((item) => (
              <option key={String(item.id)} value={String(item.id)}>
                {String(item.code ?? item.name)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-card--inline">
        <label>
          Recipient egg lot
          <select
            value={form.recipientEggLotId}
            onChange={(e) => set("recipientEggLotId", e.target.value)}
          >
            <option value="">Not linked</option>
            {(masters["recipient-egg-lots"] ?? []).map((item) => (
              <option key={String(item.id)} value={String(item.id)}>
                {String(item.label ?? item.lotCode ?? item.id)}
              </option>
            ))}
          </select>
        </label>
        <label>
          CSOF lot
          <select
            value={form.csofLotId}
            onChange={(e) => set("csofLotId", e.target.value)}
          >
            <option value="">Not linked</option>
            {(masters["csof-lots"] ?? []).map((item) => (
              <option key={String(item.id)} value={String(item.id)}>
                {String(item.lotCode ?? item.code ?? item.id)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Clutch code
          <input
            value={form.clutchCode}
            onChange={(e) => set("clutchCode", e.target.value)}
          />
        </label>
      </div>
      <div className="form-card--inline">
        <label>
          Replicate no.
          <input
            type="number"
            min="1"
            value={form.replicateNo}
            onChange={(e) => set("replicateNo", e.target.value)}
          />
        </label>
        <label>
          Incubation °C
          <input
            type="number"
            min="0"
            max="50"
            step="0.1"
            value={form.incubationTempC}
            onChange={(e) => set("incubationTempC", e.target.value)}
          />
        </label>
        <label>
          Notes
          <input
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
        </label>
      </div>
      {error && <ErrorMessage message={error} />}
      <button className="button button--primary" type="submit">
        {batch ? "Save changes" : "Save batch"}
      </button>
    </form>
  );
}

function BatchDetail({
  batch,
  onBack,
}: {
  batch: ApiItem;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<ApiItem | null>(null);
  const [embryos, setEmbryos] = useState<Record<string, ApiItem[]>>({});
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(false);
  const [lot, setLot] = useState({
    lotNo: "1",
    donorCellLineId: "",
    activatedAt: dateTimeInput(""),
    enuPowerPct: "",
    enuPulseUs: "",
    enuLed: "",
    enuStartAt: "",
    enuFinishAt: "",
    nEggs: "",
    nActivated: "1",
    notes: "",
    wellPositions: "",
  });
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [masters, setMasters] = useState<Record<string, ApiItem[]>>({});
  const [count, setCount] = useState(1);
  const load = useCallback(() => {
    void get(`/batches/${batch.id}`)
      .then(async (value) => {
        setDetail(value);
        const lots = (value.injectionLots as ApiItem[] | undefined) ?? [];
        const loaded = await Promise.all(
          lots.map(
            async (item: ApiItem) =>
              [
                String(item.id),
                (
                  await get(
                    `/injection-lots/${item.id}/embryos?aliveOnly=false`,
                  )
                ).items ?? [],
              ] as [string, ApiItem[]],
          ),
        );
        setEmbryos(Object.fromEntries(loaded));
      })
      .catch((e: Error) => setMessage(e.message));
  }, [batch.id]);
  useEffect(load, [load]);
  useEffect(() => {
    const resources = [
      "sites",
      "operators",
      "treatment-groups",
      "donor-cell-lines",
    ];
    void Promise.all(
      resources.map((resource) =>
        get(`/${resource}?includeInactive=true`).then(
          (data) => [resource, data.items ?? []] as [string, ApiItem[]],
        ),
      ),
    )
      .then((items) => setMasters(Object.fromEntries(items)))
      .catch((error: Error) => setMessage(error.message));
  }, []);
  useEffect(() => {
    const rejected = (event: Event) => {
      const detail = (event as CustomEvent<QueuedWrite>).detail;
      if (
        detail.path.startsWith(`/batches/${String(batch.id)}`) ||
        detail.path.startsWith("/injection-lots/") ||
        detail.path.startsWith("/embryos/")
      ) {
        load();
        setMessage(
          detail.lastError ?? "Queued change was rejected; data was restored",
        );
      }
    };
    window.addEventListener("chronofish:queue-rejected", rejected);
    return () =>
      window.removeEventListener("chronofish:queue-rejected", rejected);
  }, [batch.id, load]);
  const setLotValue = (key: string, value: string) =>
    setLot((current) => ({ ...current, [key]: value }));
  const duplicate = async () => {
    const requestedDate = window.prompt(
      "Experiment date (YYYY-MM-DD)",
      today(),
    );
    if (!requestedDate) return;
    const requestedDayNo = window.prompt(
      "Day number in the experiment series (blank = next)",
      "",
    );
    if (requestedDayNo === null) return;
    const copyLots = window.confirm(
      "Copy injection lots as unactivated templates?",
    );
    try {
      const result = await putQueue(`/batches/${batch.id}/duplicate`, {
        experimentDate: requestedDate,
        dayNo: requestedDayNo.trim() ? Number(requestedDayNo) : null,
        copyInjectionLots: copyLots,
      });
      setMessage(
        result.queued ? "Duplicate queued for sync" : "Batch duplicated",
      );
      load();
    } catch (e) {
      setMessage((e as Error).message);
    }
  };
  const createLot = async (event: FormEvent) => {
    event.preventDefault();
    const positions = lot.wellPositions
      .split(/[ ,\n]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    const optimisticId = templateId ?? `queued-lot-${Date.now()}`;
    const optimistic = {
      ...lot,
      id: optimisticId,
      batchId: batch.id,
      nActivated: Number(lot.nActivated),
      activatedAt: dateTimeLocalToRFC3339(lot.activatedAt),
      queued: true,
    };
    const previousDetail = detail;
    try {
      const payload = {
        ...lot,
        activatedAt: dateTimeLocalToRFC3339(lot.activatedAt),
        enuStartAt: lot.enuStartAt
          ? dateTimeLocalToRFC3339(lot.enuStartAt)
          : null,
        enuFinishAt: lot.enuFinishAt
          ? dateTimeLocalToRFC3339(lot.enuFinishAt)
          : null,
        enuPowerPct: lot.enuPowerPct ? Number(lot.enuPowerPct) : null,
        enuPulseUs: lot.enuPulseUs ? Number(lot.enuPulseUs) : null,
        enuLed: lot.enuLed ? Number(lot.enuLed) : null,
        nEggs: lot.nEggs ? Number(lot.nEggs) : null,
        nActivated: Number(lot.nActivated),
        wellPositions: positions,
      };
      if (
        !window.confirm(
          `${templateId ? "Activate" : "Create"} lot ${lot.lotNo} with ${payload.nActivated} embryos?`,
        )
      )
        return;
      const path = templateId
        ? `/injection-lots/${templateId}`
        : `/batches/${batch.id}/injection-lots`;
      const result = await putQueue(
        path,
        payload,
        "application/json",
        templateId ? "PATCH" : "POST",
      );
      if (result.queued) {
        setDetail((current) =>
          current
            ? {
                ...current,
                injectionLots: templateId
                  ? (
                      (current.injectionLots as ApiItem[] | undefined) ?? []
                    ).map((item) =>
                      item.id === templateId ? optimistic : item,
                    )
                  : [
                      ...((current.injectionLots as ApiItem[] | undefined) ??
                        []),
                      optimistic,
                    ],
              }
            : current,
        );
        setEmbryos((current) => ({
          ...current,
          [optimisticId]: positions.map((wellPosition, index) => ({
            id: `${optimisticId}-${index + 1}`,
            injectionLotId: optimisticId,
            embryoCode: `${String(detail?.batchCode ?? batch.batchCode)}_${lot.lotNo}_${index + 1}`,
            wellPosition,
            queued: true,
          })),
        }));
        setMessage("Lot saved offline; it will sync automatically");
      } else {
        setMessage(
          (result.warnings as string[] | undefined)?.join(" ") ||
            (templateId ? "Lot template activated" : "Lot created"),
        );
        load();
      }
      setTemplateId(null);
    } catch (e) {
      setDetail(previousDetail);
      setMessage((e as Error).message);
    }
  };
  const useTemplate = (item: ApiItem) => {
    setTemplateId(String(item.id));
    setLot({
      lotNo: String(item.lotNo ?? "1"),
      donorCellLineId: String(item.donorCellLineId ?? ""),
      activatedAt: dateTimeInput(""),
      enuPowerPct: String(item.enuPowerPct ?? ""),
      enuPulseUs: String(item.enuPulseUs ?? ""),
      enuLed: String(item.enuLed ?? ""),
      enuStartAt: "",
      enuFinishAt: "",
      nEggs: String(item.nEggs ?? ""),
      nActivated: "1",
      notes: String(item.notes ?? ""),
      wellPositions: "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const addEmbryos = async (lotId: string) => {
    const previous = embryos[lotId] ?? [];
    const optimistic = Array.from({ length: count }, (_, index) => ({
      id: `queued-embryo-${Date.now()}-${index}`,
      embryoCode: `queued-${previous.length + index + 1}`,
      injectionLotId: lotId,
      queued: true,
    }));
    setEmbryos((current) => ({
      ...current,
      [lotId]: [...previous, ...optimistic],
    }));
    try {
      const result = await putQueue(`/injection-lots/${lotId}/embryos`, {
        count,
      });
      if (result.queued) setMessage("Embryos queued for sync");
      else {
        setMessage("Embryos added");
        load();
      }
    } catch (e) {
      setEmbryos((current) => ({ ...current, [lotId]: previous }));
      setMessage((e as Error).message);
    }
  };
  const updateWell = async (embryo: ApiItem, wellPosition: string | null) => {
    const lotId = String(embryo.injectionLotId ?? "");
    const previous = embryos[lotId] ?? [];
    setEmbryos((current) => ({
      ...current,
      [lotId]: (current[lotId] ?? []).map((item) =>
        item.id === embryo.id
          ? { ...item, wellPosition: wellPosition || null }
          : item,
      ),
    }));
    try {
      await putQueue(
        `/embryos/${embryo.id}`,
        { wellPosition: wellPosition || null },
        "application/json",
        "PATCH",
      );
      if (!String(embryo.id).startsWith("queued-")) load();
    } catch (e) {
      setEmbryos((current) => ({ ...current, [lotId]: previous }));
      setMessage((e as Error).message);
    }
  };
  const deleteEmbryo = async (embryo: ApiItem) => {
    const reason = window.prompt("Reason for deleting this embryo");
    if (!reason?.trim()) return;
    const lotId = String(embryo.injectionLotId ?? "");
    const previous = embryos[lotId] ?? [];
    setEmbryos((current) => ({
      ...current,
      [lotId]: (current[lotId] ?? []).filter((item) => item.id !== embryo.id),
    }));
    try {
      await putQueue(
        `/embryos/${embryo.id}?reason=${encodeURIComponent(reason)}`,
        undefined,
        "application/json",
        "DELETE",
      );
    } catch (e) {
      setEmbryos((current) => ({ ...current, [lotId]: previous }));
      setMessage((e as Error).message);
    }
  };
  const preview = Array.from(
    { length: Math.min(Math.max(Number(lot.nActivated) || 0, 0), 96) },
    (_, index) =>
      `${String(detail?.batchCode ?? batch.batchCode)}_${lot.lotNo}_${index + 1}`,
  );
  const selectedWells = lot.wellPositions
    .split(/[ ,\n]+/)
    .map((value) => value.trim().toUpperCase())
    .filter((value, index, values) =>
      wells.includes(value) && values.indexOf(value) === index,
    )
    .slice(0, preview.length);
  const toggleWell = (well: string) => {
    const next = selectedWells.includes(well)
      ? selectedWells.filter((value) => value !== well)
      : selectedWells.length < preview.length
        ? [...selectedWells, well]
        : selectedWells;
    setLotValue("wellPositions", next.join(", "));
  };
  return (
    <section>
      <button className="back" onClick={onBack}>
        ← Batches
      </button>
      <div className="page-heading">
        <div>
          <p className="eyebrow">EXPERIMENT</p>
          <h1>{String(detail?.batchCode ?? batch.batchCode)}</h1>
          <p className="muted">
            {String(detail?.experimentDate ?? batch.experimentDate)} ·{" "}
            {masterName(masters.sites, detail?.siteId ?? batch.siteId)} ·{" "}
            {masterName(masters.operators, detail?.operatorId ?? batch.operatorId)} ·{" "}
            {masterName(
              masters["treatment-groups"],
              detail?.treatmentGroupId ?? batch.treatmentGroupId,
            )}
          </p>
        </div>
        <div className="button-row">
          <button
            className="button button--secondary"
            onClick={() => setEditing(!editing)}
          >
            Edit batch
          </button>
          <button
            className="button button--secondary"
            onClick={() => void duplicate()}
          >
            Duplicate
          </button>
        </div>
      </div>
      {message && <ErrorMessage message={message} />}
      {editing && detail && (
        <BatchForm
          batch={detail}
          onSaved={() => {
            setEditing(false);
            setMessage("Batch updated");
            load();
          }}
        />
      )}
      <form className="form-card" onSubmit={createLot}>
        <h2>{templateId ? "Activate injection lot template" : "Injection lot"}</h2>
        <div className="form-card--inline">
          <label>
            Lot number
            <input
              required
              value={lot.lotNo}
              onChange={(event) => setLotValue("lotNo", event.target.value)}
            />
          </label>
          <label>
            Donor cell line
            <select
              required
              value={lot.donorCellLineId}
              onChange={(event) =>
                setLotValue("donorCellLineId", event.target.value)
              }
            >
              <option value="">Select donor</option>
              {(masters["donor-cell-lines"] ?? [])
                .filter((item) => item.active !== false)
                .map((item) => (
                  <option key={String(item.id)} value={String(item.id)}>
                    {String(item.strain ?? item.batchCode ?? item.id)}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Activated at
            <input
              required
              type="datetime-local"
              value={lot.activatedAt}
              onChange={(event) =>
                setLotValue("activatedAt", event.target.value)
              }
            />
          </label>
        </div>
        <div className="form-card--inline">
          <label>
            Eggs
            <input
              type="number"
              min="0"
              value={lot.nEggs}
              onChange={(event) => setLotValue("nEggs", event.target.value)}
            />
          </label>
          <label>
            Activated embryos
            <input
              required
              type="number"
              min="0"
              max="96"
              value={lot.nActivated}
              onChange={(event) =>
                setLotValue("nActivated", event.target.value)
              }
            />
          </label>
          <label>
            ENU power %
            <input
              type="number"
              min="0"
              max="100"
              value={lot.enuPowerPct}
              onChange={(event) =>
                setLotValue("enuPowerPct", event.target.value)
              }
            />
          </label>
        </div>
        <div className="form-card--inline">
          <label>
            ENU pulse µs
            <input
              type="number"
              min="0"
              value={lot.enuPulseUs}
              onChange={(event) =>
                setLotValue("enuPulseUs", event.target.value)
              }
            />
          </label>
          <label>
            ENU LED
            <input
              type="number"
              min="0"
              value={lot.enuLed}
              onChange={(event) => setLotValue("enuLed", event.target.value)}
            />
          </label>
          <label>
            ENU start at
            <input
              type="datetime-local"
              value={lot.enuStartAt}
              onChange={(event) =>
                setLotValue("enuStartAt", event.target.value)
              }
            />
          </label>
        </div>
        <div className="form-card--inline">
          <label>
            ENU finish at
            <input
              type="datetime-local"
              value={lot.enuFinishAt}
              onChange={(event) =>
                setLotValue("enuFinishAt", event.target.value)
              }
            />
          </label>
          <label>
            Notes
            <input
              value={lot.notes}
              onChange={(event) => setLotValue("notes", event.target.value)}
            />
          </label>
        </div>
        <label>
          Well positions (comma or newline separated)
          <textarea
            rows={2}
            value={lot.wellPositions}
            placeholder="A1, A2, A3"
            onChange={(event) =>
              setLotValue("wellPositions", event.target.value)
            }
          />
        </label>
        <button className="button button--primary" type="submit">
          {templateId ? "Activate template" : "Create lot"}
        </button>
      </form>
      <article className="form-card">
        <h2>96-well code preview</h2>
        <p className="muted">
          {preview.length} code(s); verify positions before saving.
        </p>
        <div className="well-grid well-grid--plate">
          {wells.map((well) => {
            const embryoIndex = selectedWells.indexOf(well);
            return (
              <button
                type="button"
                className="well"
                aria-pressed={embryoIndex >= 0}
                key={well}
                onClick={() => toggleWell(well)}
              >
                <strong>{well}</strong>
                <small>{embryoIndex >= 0 ? preview[embryoIndex] : "Available"}</small>
              </button>
            );
          })}
        </div>
        <ol className="well-list--mobile">
          {preview.map((code, index) => (
            <li key={code}>
              <strong>{selectedWells[index] ?? "Unassigned"}</strong> {code}
            </li>
          ))}
        </ol>
      </article>
      {(detail?.injectionLots ?? []).map((item: ApiItem) => (
        <article className="form-card" key={String(item.id)}>
          <div className="page-heading">
            <div>
              <h2>Lot {String(item.lotNo)}</h2>
              <p className="muted">
                Donor{" "}
                {masterName(
                  masters["donor-cell-lines"],
                  item.donorCellLineId,
                )} ·{" "}
                {String(item.nActivated ?? 0)} activated ·{" "}
                {formatBangkokDateTime(String(item.activatedAt ?? ""))}
              </p>
            </div>
            {item.activatedAt ? (
              <button
                className="button button--secondary"
                type="button"
                onClick={() => addEmbryos(String(item.id))}
              >
                Add {count} embryos
              </button>
            ) : (
              <button className="button button--primary" type="button" onClick={() => useTemplate(item)}>
                Activate template
              </button>
            )}
          </div>
          {Boolean(item.activatedAt) && (
            <label className="form-card--inline">
              Additional embryos
              <input
                type="number"
                min="1"
                max="96"
                value={count}
                onChange={(event) => setCount(Number(event.target.value))}
              />
            </label>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Well</th>
                  <th>Embryo</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {(embryos[String(item.id)] ?? []).map((embryo) => (
                  <tr key={String(embryo.id)}>
                    <td>
                      <select
                        aria-label={`Well for ${String(embryo.embryoCode)}`}
                        value={String(embryo.wellPosition ?? "")}
                        onChange={(event) =>
                          void updateWell(embryo, event.target.value)
                        }
                      >
                        <option value="">Unassigned</option>
                        {wells.map((well) => (
                          <option key={well}>{well}</option>
                        ))}
                      </select>
                    </td>
                    <td>{String(embryo.embryoCode)}</td>
                    <td>
                      <button
                        className="inline-action inline-action--danger"
                        type="button"
                        onClick={() => void updateWell(embryo, null)}
                      >
                        Clear well
                      </button>
                      <button
                        className="inline-action inline-action--danger"
                        type="button"
                        onClick={() => void deleteEmbryo(embryo)}
                      >
                        Delete embryo
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      ))}
    </section>
  );
}
