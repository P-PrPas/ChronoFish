import { useCallback, useEffect, useState } from "react";
import { type ApiItem, get } from "../api/client";
import {
  type DashboardFilters,
  analyticsFilters,
  parseFilters,
  updateFilterURL,
  withFilters,
} from "../filters";
import { type AppText, type Page, text } from "../types";
import { ErrorMessage, Metric, ReportPanel, ReportTable } from "../components";

type DashboardTab = "stage1" | "stage2" | "overall";
type AnalyticsMeta = {
  sampleSize?: number;
  denominators?: Record<string, number>;
  unknown?: Record<string, number>;
  missing?: Record<string, number>;
};
type DashboardData = {
  kpi: ApiItem | null;
  kpiMeta: AnalyticsMeta | null;
  funnel: ApiItem[];
  funnelMeta: AnalyticsMeta | null;
  survival: ApiItem[];
  survivalMeta: AnalyticsMeta | null;
  deviation: ApiItem[];
  deviationMeta: AnalyticsMeta | null;
  abnormality: ApiItem[];
  abnormalityMeta: AnalyticsMeta | null;
  fishSurvival: ApiItem[];
  fishSurvivalMeta: AnalyticsMeta | null;
  gaps: ApiItem[];
  gapsMeta: AnalyticsMeta | null;
  pipeline: ApiItem[];
  pipelineMeta: AnalyticsMeta | null;
};

function responseMeta(response: ApiItem): AnalyticsMeta {
  return (response.meta as AnalyticsMeta | undefined) ?? {};
}

export function percent(value: unknown): string {
  return value == null ? "Unknown" : `${(Number(value) * 100).toFixed(2)}%`;
}

function QualityNote({ meta, thai = false }: { meta: AnalyticsMeta | null; thai?: boolean }) {
  if (!meta) return null;
  const labels: Record<string, string> = { stageCheckpoint: 'ผลตรวจตามระยะ', firstAbnormality: 'ระยะแรกที่ผิดปกติ', stage1Condition: 'สภาพตัวอ่อน', fishSex: 'เพศปลา', latestEmbryoObservation: 'ผลตรวจตัวอ่อนล่าสุด' };
  const unknown = Object.entries(meta.unknown ?? {}).map(([key, value]) => `${thai ? labels[key] ?? key : key}: ${value}`);
  const missing = Object.entries(meta.missing ?? {}).map(([key, value]) => `${thai ? labels[key] ?? key : key}: ${value}`);
  if (unknown.length === 0 && missing.length === 0) return null;
  return <p className="table-note" role="status">{thai ? `ความครบถ้วนของข้อมูล — ไม่ระบุ: ${unknown.join(", ") || "ไม่มี"}; ขาดข้อมูล: ${missing.join(", ") || "ไม่มี"}` : `Data quality — unknown: ${unknown.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}.`}</p>;
}

function useMasterOptions(resource: string): ApiItem[] {
  const [items, setItems] = useState<ApiItem[]>([]);
  useEffect(() => {
    void get(`/${resource}`)
      .then((data) => setItems(data.items ?? []))
      .catch(() => undefined);
  }, [resource]);
  return items;
}

export function FilterBar({
  filters,
  onChange,
  t = text.en,
}: {
  filters: DashboardFilters;
  onChange: (filters: DashboardFilters) => void;
  t?: AppText;
}) {
  const sites = useMasterOptions("sites");
  const operators = useMasterOptions("operators");
  const treatments = useMasterOptions("treatment-groups");
  const donors = useMasterOptions("donor-cell-lines");
  const batches = useMasterOptions("batches");
  const thai = t === text.th;
  const activeCount = Object.values(filters).filter(Boolean).length;
  const update = (key: keyof DashboardFilters, value: string) =>
    onChange({ ...filters, [key]: value || undefined });
  return (
    <details className="filter-disclosure">
      <summary>{thai ? "ตัวกรองข้อมูล" : "Filter data"}{activeCount ? ` · ${activeCount} ${thai ? "รายการ" : "active"}` : ` · ${thai ? "ทั้งหมด" : "All records"}`}</summary>
      <fieldset className="filter-bar">
      <legend>{thai ? "เลือกเฉพาะข้อมูลที่ต้องการวิเคราะห์" : "Choose records to analyse"}</legend>
      <label>
        {thai ? "สถานที่" : "Site"}
        <select
          value={filters.siteId ?? ""}
          onChange={(event) => update("siteId", event.target.value)}
        >
          <option value="">{thai ? "ทุกสถานที่" : "All sites"}</option>
          {sites.map((item) => (
            <option key={String(item.id)} value={String(item.id)}>
              {String(item.name ?? item.code)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {thai ? "ผู้ปฏิบัติงาน" : "Operator"}
        <select
          value={filters.operatorId ?? ""}
          onChange={(event) => update("operatorId", event.target.value)}
        >
          <option value="">{thai ? "ทุกคน" : "All operators"}</option>
          {operators.map((item) => (
            <option key={String(item.id)} value={String(item.id)}>
              {String(item.name)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {thai ? "กลุ่มการทดลอง" : "Treatment"}
        <select
          value={filters.treatmentGroupId ?? ""}
          onChange={(event) => update("treatmentGroupId", event.target.value)}
        >
          <option value="">{thai ? "ทุกกลุ่ม" : "All treatments"}</option>
          {treatments.map((item) => (
            <option key={String(item.id)} value={String(item.id)}>
              {String(item.code ?? item.name)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {thai ? "เซลล์ผู้ให้" : "Donor"}
        <select
          value={filters.donorCellLineId ?? ""}
          onChange={(event) => update("donorCellLineId", event.target.value)}
        >
          <option value="">{thai ? "ทุกสาย" : "All donors"}</option>
          {donors.map((item) => (
            <option key={String(item.id)} value={String(item.id)}>
              {String(item.strain ?? item.batchCode)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {thai ? "รอบทดลอง" : "Batch"}
        <select
          value={filters.batchId ?? ""}
          onChange={(event) => update("batchId", event.target.value)}
        >
          <option value="">{thai ? "ทุกรอบ" : "All batches"}</option>
          {batches.map((item) => (
            <option key={String(item.id)} value={String(item.id)}>
              {String(item.batchCode)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {thai ? "สายพันธุ์" : "Strain"}
        <input
          value={filters.strain ?? ""}
          onChange={(event) => update("strain", event.target.value)}
          placeholder={thai ? "ทุกสายพันธุ์" : "Any strain"}
        />
      </label>
      <label>
        {thai ? "ตั้งแต่วันที่" : "From"}
        <input
          type="date"
          value={filters.dateFrom ?? ""}
          onChange={(event) => update("dateFrom", event.target.value)}
        />
      </label>
      <label>
        {thai ? "ถึงวันที่" : "To"}
        <input
          type="date"
          value={filters.dateTo ?? ""}
          onChange={(event) => update("dateTo", event.target.value)}
        />
      </label>
      <button
        type="button"
        className="button button--secondary"
        onClick={() => onChange({})}
      >
        {thai ? "ล้างตัวกรอง" : "Clear"}
      </button>
      </fieldset>
    </details>
  );
}

function NoData({
  message = "No observations match these filters. Record a checkpoint or clear filters.",
}: {
  message?: string;
}) {
  return <p className="table-note">{message}</p>;
}

export function SurvivalChart({ points, thai = false }: { points: ApiItem[]; thai?: boolean }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  if (points.length === 0) return null;
  const width = 560;
  const height = 190;
  const groups = new Map<string, { label: string; points: ApiItem[] }>();
  for (const point of points) {
    const key = `${String(point.siteId ?? "All")} / ${String(point.strain ?? "All")} / ${String(point.treatmentGroup ?? "All")}`;
    const label = `${String(point.site ?? "All")} · ${String(point.strain ?? "All")} · ${String(point.treatmentGroup ?? "All")}`;
    groups.set(key, { label, points: [...(groups.get(key)?.points ?? []), point] });
  }
  const colors: Record<string, string> = { AB: "#0b6761", TU: "#b67b2f", NHGRI: "#557f9c" };
  const lineStyle = (point: ApiItem) => {
    const color = colors[String(point.strain)] ?? "#775f8f";
    const key = `${String(point.site ?? "All")}-${String(point.treatmentGroup ?? "All")}`;
    const dash = key === "KU-RK701" ? "6 3" : String(point.site ?? "All") === "MSU" ? (String(point.treatmentGroup) === "RK701" ? "8 3 2 3" : "2 3") : undefined;
    return { color, dash };
  };
  const stages = Array.from(new Map([...points].sort((a, b) => Number(a.stageOrder ?? 0) - Number(b.stageOrder ?? 0)).map((point) => [Number(point.stageOrder ?? 0), point])).values());
  const minStage = Number(stages[0]?.stageOrder ?? 0);
  const maxStage = Number(stages.at(-1)?.stageOrder ?? minStage + 1);
  const x = (stage: number) => 38 + ((stage - minStage) / Math.max(1, maxStage - minStage)) * (width - 50);
  const plotTop = 12;
  const plotBottom = height - 32;
  return (
    <div className="chart-block">
      <div className="chart-legend" aria-label={thai ? "เลือกเส้นข้อมูลที่ต้องการแสดง" : "Toggle site, strain and treatment series"}>
        {Array.from(groups.entries()).map(([key, group]) => {
          const sample = group.points[0] ?? {};
          const { color, dash } = lineStyle(sample);
          return <button type="button" aria-pressed={!hidden.has(key)} className="chart-legend__item" key={key} onClick={() => setHidden((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })}><svg className="chart-legend__swatch" viewBox="0 0 18 6" aria-hidden="true"><line x1="1" y1="3" x2="17" y2="3" stroke={color} strokeDasharray={dash} strokeWidth="2" /></svg>{group.label.replace("CONTROL", "CTRL")}</button>;
        })}
      </div>
    <svg
      className="chart"
      role="img"
      aria-label={thai ? "กราฟอัตรารอดของตัวอ่อนตามระยะ" : "Stage 1 survival curves"}
      viewBox={`0 0 ${width} ${height}`}
    >
      {[0, .5, 1].map((value) => <g key={value}><line x1="38" y1={plotBottom - value * (plotBottom - plotTop)} x2={width - 12} y2={plotBottom - value * (plotBottom - plotTop)} stroke="currentColor" opacity=".12"/><text x="4" y={plotBottom + 4 - value * (plotBottom - plotTop)}>{value * 100}%</text></g>)}
      {stages.filter((_, index) => index % Math.max(1, Math.ceil(stages.length / 6)) === 0 || index === stages.length - 1).map((stage) => <text key={String(stage.stageOrder)} x={x(Number(stage.stageOrder ?? 0))} y={height - 7} textAnchor={Number(stage.stageOrder) === minStage ? "start" : Number(stage.stageOrder) === maxStage ? "end" : "middle"}>{String(stage.stageLabel ?? stage.stageOrder)}</text>)}
      {Array.from(groups.entries()).map(([key, group]) => {
        if (hidden.has(key)) return null;
        const sorted = [...group.points].sort((left, right) => Number(left.stageOrder ?? 0) - Number(right.stageOrder ?? 0));
        const path = sorted.map((point) => `${x(Number(point.stageOrder ?? 0))},${plotBottom - Math.max(0, Math.min(1, Number(point.surv ?? 0))) * (plotBottom - plotTop)}`).join(" ");
        const sample = group.points[0] ?? {};
        const { color, dash } = lineStyle(sample);
        return <polyline key={key} fill="none" stroke={color} strokeDasharray={dash} strokeWidth="2" points={path}><title>{group.label}</title></polyline>;
      })}
    </svg>
    </div>
  );
}

export function FunnelChart({ points, thai = false }: { points: ApiItem[]; thai?: boolean }) {
  if (points.length === 0) return null;
  const width = 560;
  const shown = [...points].sort((left, right) => Number(right.nDead ?? 0) - Number(left.nDead ?? 0)).slice(0, 8);
  const max = Math.max(1, ...shown.map((point) => Number(point.nDead ?? 0)));
  return (
    <svg
      className="chart chart--funnel"
      role="img"
      aria-label={thai ? "อันดับระยะที่สูญเสียตัวอ่อนมากที่สุด" : "Embryo loss ranked by checkpoint"}
      viewBox={`0 0 ${width} ${Math.max(150, shown.length * 27 + 12)}`}
    >
      {shown.map((point, index) => {
        const dead = Number(point.nDead ?? 0);
        const riskSet = Number(point.riskSet ?? 0);
        const barWidth = dead === 0 ? 0 : Math.max(3, (dead / max) * (width - 190));
        return <g key={`${String(point.stageOrder)}-${index}`}>
          <text x="4" y={index * 27 + 17}>{String(point.stageLabel ?? point.stageOrder)}</text>
          <rect x="126" y={index * 27 + 5} width={width - 176} height="16" rx="8" fill="#e7efec" />
          <rect x="126" y={index * 27 + 5} width={barWidth} height="16" rx="8" fill="#0b6761" />
          <text x={width - 4} y={index * 27 + 17} textAnchor="end">{dead} ({riskSet ? `${Math.round(dead / riskSet * 100)}%` : "—"})</text>
        </g>;
      })}
    </svg>
  );
}

export function DeviationChart({ points, thai = false }: { points: ApiItem[]; thai?: boolean }) {
  const stages = Array.from(new Map(points.map((point) => [String(point.stageOrder ?? point.stageLabel), point])).entries());
  const [selectedStage, setSelectedStage] = useState('');
  if (points.length === 0) return null;
  const stageKey = stages.some(([key]) => key === selectedStage) ? selectedStage : stages[0][0];
  const shown = points.filter((point) => String(point.stageOrder ?? point.stageLabel) === stageKey);
  const width = 560;
  const height = 180;
  const values = shown.flatMap((point) => [Number(point.minDeviationH ?? 0), Number(point.maxDeviationH ?? 0)]);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = Math.max(0.5, max - min);
  const y = (value: number) => 14 + ((max - value) / span) * (height - 34);
  const slotWidth = (width - 70) / shown.length;
  const axis = y(0);
  return (
    <div className="chart-block">
      <label className="chart-select">{thai ? "ระยะที่ต้องการเปรียบเทียบ" : "Checkpoint to compare"}<select value={stageKey} onChange={(event) => setSelectedStage(event.target.value)}>{stages.map(([key, point]) => <option key={key} value={key}>{String(point.stageLabel ?? point.stageOrder)}</option>)}</select></label>
    <svg
      className="chart"
      role="img"
      aria-label={thai ? "การเบี่ยงเบนเวลาเทียบมาตรฐาน หน่วยชั่วโมง" : "Timing deviation from standard in hours"}
      viewBox={`0 0 ${width} ${height}`}
    >
      <line
        x1="12"
        y1={axis}
        x2={width - 12}
        y2={axis}
        stroke="currentColor"
        opacity=".35"
      />
      {shown.map((point, index) => {
        const minimum = Number(point.minDeviationH ?? 0);
        const q1 = Number(point.q1DeviationH ?? point.medianDeviationH ?? 0);
        const median = Number(point.medianDeviationH ?? 0);
        const q3 = Number(point.q3DeviationH ?? point.medianDeviationH ?? 0);
        const maximum = Number(point.maxDeviationH ?? 0);
        const mean = Number(point.meanDeviationH ?? 0);
        const x = 58 + slotWidth * (index + 0.5);
        const boxWidth = Math.max(4, Math.min(18, slotWidth * 0.65));
        return (
          <g key={`${String(point.stageOrder)}-${String(point.treatmentGroup ?? "")}-${index}`}>
            <line x1={x} y1={y(maximum)} x2={x} y2={y(minimum)} stroke="currentColor" />
            <line x1={x - boxWidth / 3} y1={y(maximum)} x2={x + boxWidth / 3} y2={y(maximum)} stroke="currentColor" />
            <line x1={x - boxWidth / 3} y1={y(minimum)} x2={x + boxWidth / 3} y2={y(minimum)} stroke="currentColor" />
            <rect x={x - boxWidth / 2} y={y(q3)} width={boxWidth} height={Math.max(1, y(q1) - y(q3))} fill="#f2a65a" fillOpacity=".35" stroke="currentColor" />
            <line x1={x - boxWidth / 2} y1={y(median)} x2={x + boxWidth / 2} y2={y(median)} stroke="currentColor" strokeWidth="2" />
            <circle cx={x} cy={y(mean)} r="2" fill="#6dc5b0">
              <title>{`${String(point.treatmentGroup ?? point.strain ?? "All")} · ${String(point.stageLabel ?? point.stageOrder)}: ${thai ? "มัธยฐาน" : "median"} ${median.toFixed(2)} h`}</title>
            </circle>
            <text x={x} y={height - 4} textAnchor="middle">{String(point.treatmentGroup ?? point.strain ?? (thai ? "ทั้งหมด" : "All"))}</text>
          </g>
        );
      })}
      <text x="4" y="14">{thai ? "+ ช้า (ชม.)" : "+ late (h)"}</text>
      <text x="4" y={height - 20}>{thai ? "− เร็ว" : "− early"}</text>
    </svg>
    </div>
  );
}

export function FishSurvivalChart({ points, thai = false }: { points: ApiItem[]; thai?: boolean }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  if (points.length === 0) return null
  const width = 560
  const height = 190
  const maxAge = Math.max(1, ...points.map((point) => Number(point.ageDays ?? 0)))
  const groups = new Map<string, ApiItem[]>()
  for (const point of points) {
    const key = `${String(point.strain ?? 'All')} / ${String(point.treatmentGroup ?? 'All')} / ${String(point.condition ?? 'All')}`
    groups.set(key, [...(groups.get(key) ?? []), point])
  }
  const colors = ['#ef9f67', '#78c7b5', '#caa7f7', '#f2d479', '#8ab6ed']
  return <div className="chart-block"><div className="chart-legend" aria-label={thai ? "เลือกกลุ่มปลาที่ต้องการแสดง" : "Toggle fish groups"}>{Array.from(groups.keys()).map((key, index) => <button type="button" key={key} aria-pressed={!hidden.has(key)} className="chart-legend__item" onClick={() => setHidden((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })}><span className="chart-dot" style={{ background: colors[index % colors.length] }} aria-hidden="true" />{key}</button>)}</div><svg className="chart" role="img" aria-label={thai ? "กราฟอัตรารอดของปลาตามอายุ" : "Fish survival curves by age, strain and treatment"} viewBox={`0 0 ${width} ${height}`}>
    {[0, .5, 1].map((value) => <g key={value}><line x1="38" y1={height - 28 - value * (height - 44)} x2={width - 12} y2={height - 28 - value * (height - 44)} stroke="currentColor" opacity=".12"/><text x="4" y={height - 24 - value * (height - 44)}>{value * 100}%</text></g>)}
    <text x="38" y={height - 7}>0</text><text x={width - 12} y={height - 7} textAnchor="end">{maxAge} {thai ? "วัน" : "days"}</text>
    {Array.from(groups.entries()).map(([key, values], index) => {
      if (hidden.has(key)) return null
      const sorted = [...values].sort((left, right) => Number(left.ageDays ?? 0) - Number(right.ageDays ?? 0))
      const path = sorted.map((point) => `${38 + (Number(point.ageDays ?? 0) / maxAge) * (width - 50)},${height - 28 - Math.max(0, Math.min(1, Number(point.surv ?? 0))) * (height - 44)}`).join(' ')
      return <polyline key={key} fill="none" stroke={colors[index % colors.length]} strokeDasharray={index % 3 === 1 ? "6 3" : index % 3 === 2 ? "2 3" : undefined} strokeWidth="2.5" points={path}><title>{key}</title></polyline>
    })}
  </svg></div>
}

function BarSummary({ points, label, value }: { points: ApiItem[]; label: (point: ApiItem) => string; value: (point: ApiItem) => number }) {
  const max = Math.max(1, ...points.map(value))
  return <div className="bar-summary" role="img" aria-label={points.map((point) => `${label(point)} ${value(point)}`).join(', ')}>{points.map((point, index) => <div className="bar-summary__row" key={`${label(point)}-${index}`}><span>{label(point)}</span><span className="bar-summary__track" aria-hidden="true"><span style={{ width: `${Math.max(2, value(point) / max * 100)}%` }} /></span><strong>{value(point).toLocaleString()}</strong></div>)}</div>
}

export function Dashboard({
  onNavigate,
  t,
}: {
  onNavigate: (page: Page) => void;
  t: AppText;
}) {
  const [filters, setFilters] = useState<DashboardFilters>(() =>
    analyticsFilters(parseFilters()),
  );
  const [tab, setTab] = useState<DashboardTab>("stage1");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DashboardData>({
    kpi: null,
    kpiMeta: null,
    funnel: [],
    funnelMeta: null,
    survival: [],
    survivalMeta: null,
    deviation: [],
    deviationMeta: null,
    abnormality: [],
    abnormalityMeta: null,
    fishSurvival: [],
    fishSurvivalMeta: null,
    gaps: [],
    gapsMeta: null,
    pipeline: [],
    pipelineMeta: null,
  });
  const load = useCallback(() => {
    setLoading(true);
    setError("");
    void get(withFilters("/analytics/dashboard", filters))
      .then((bundle) => {
        const kpi = bundle.kpi as ApiItem;
        const funnel = bundle.funnel as ApiItem;
        const survival = bundle.survival as ApiItem;
        const deviation = bundle.timingDeviation as ApiItem;
        const abnormality = bundle.abnormalityOnset as ApiItem;
        const fishSurvival = bundle.fishSurvival as ApiItem;
        const gaps = bundle.observationGaps as ApiItem;
        const pipeline = bundle.pipeline as ApiItem;
        setData({
          kpi,
          kpiMeta: responseMeta(kpi),
          funnel: funnel.items ?? [],
          funnelMeta: responseMeta(funnel),
          survival: survival.items ?? [],
          survivalMeta: responseMeta(survival),
          deviation: deviation.items ?? [],
          deviationMeta: responseMeta(deviation),
          abnormality: abnormality.items ?? [],
          abnormalityMeta: responseMeta(abnormality),
          fishSurvival: fishSurvival.items ?? [],
          fishSurvivalMeta: responseMeta(fishSurvival),
          gaps: gaps.items ?? [],
          gapsMeta: responseMeta(gaps),
          pipeline: pipeline.items ?? [],
          pipelineMeta: responseMeta(pipeline),
        });
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [filters]);
  useEffect(() => {
    updateFilterURL(filters);
    load();
  }, [filters, load]);
  const changeFilters = (next: DashboardFilters) => {
    setFilters(next);
    updateFilterURL(next);
  };
  const openSource = (page: Page) => {
    updateFilterURL(filters);
    onNavigate(page);
  };
  const stage1 = data.kpi?.stage1 as ApiItem | undefined;
  const stage2 = data.kpi?.stage2 as ApiItem | undefined;
  const comparison = (stage1?.controlComparison as ApiItem[] | undefined) ?? [];
  const thai = t === text.th;
  return (
    <section>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{thai ? "คำตอบจากข้อมูลการทดลอง" : "RESEARCH EVIDENCE"}</p>
          <h1>{thai ? "ผลการทดลอง" : "Research results"}</h1>
          <p className="muted">
            {thai ? "ตอบคำถามสำคัญจากข้อมูลชุดเดียวกับรายงานและไฟล์ส่งออก" : "Answer key research questions from the same dataset used for reports and exports."}
          </p>
        </div>
        <button
          className="button button--secondary"
          onClick={load}
          disabled={loading}
        >
          {loading ? t.loading : t.refresh}
        </button>
      </div>
      <FilterBar filters={filters} onChange={changeFilters} t={t} />
      {loading && <p className="table-note dashboard-status" role="status">{thai ? "กำลังคำนวณภาพรวม…" : "Loading dashboard analytics…"}</p>}
      {error && <ErrorMessage message={error} />}
      {data.kpi && !loading && (
        <>
          <div className="metric-grid metric-grid--primary">
            <Metric label={thai ? "ตัวอ่อนที่เริ่มติดตาม" : "Activated embryos"} value={Number(stage1?.nActivated ?? 0)} />
            <Metric label={thai ? "ถึงระยะ Shield" : "Reached Shield"} value={Number(stage1?.nReachedShield ?? 0)} />
            <Metric label={thai ? "เลื่อนเข้าอนุบาล" : "Promoted fish"} value={Number(stage1?.nPromoted ?? 0)} />
            <Metric label={thai ? "ปลาที่ยังอยู่" : "Alive fish"} value={Number(stage2?.nAlive ?? 0)} />
          </div>
          <details className="metric-disclosure">
            <summary>{thai ? "ดูตัวชี้วัดเพิ่มเติม" : "View additional indicators"}</summary>
            <div className="metric-grid">
              <Metric label={thai ? "ถึงวันที่ 1" : "Reached Day 1"} value={Number(stage1?.nReachedDay1 ?? 0)} />
              <Metric label={thai ? "สภาพปกติ" : "Normal"} value={percent(stage1?.pctNormal)} />
              <Metric label={thai ? "ปลาทั้งหมด" : "All fish"} value={Number(stage2?.nFish ?? 0)} />
              <Metric label={thai ? "แช่แข็ง" : "Frozen"} value={Number(stage2?.nFrozen ?? 0)} />
              <Metric label={thai ? "ตาย" : "Dead"} value={Number(stage2?.nDead ?? 0)} />
              <Metric label={thai ? "คัดออก" : "Discarded"} value={Number(stage2?.nDiscarded ?? 0)} />
              <Metric label={thai ? "ปลาสภาพปกติ" : "Normal fish"} value={Number(stage2?.nNormal ?? 0)} />
              <Metric label={thai ? "ปลาที่พบความผิดปกติ" : "Abnormal fish"} value={Number(stage2?.nAbnormal ?? 0)} />
              <Metric label={thai ? "อายุเฉลี่ยของปลาที่ยังอยู่" : "Mean age (alive)"} value={stage2?.meanAgeDaysAlive == null ? (thai ? "ไม่มีข้อมูล" : "Unknown") : `${Number(stage2.meanAgeDaysAlive).toLocaleString(thai ? "th-TH" : "en-US", { maximumFractionDigits: 1 })} ${thai ? "วัน" : "days"}`} />
            </div>
          </details>
        </>
      )}
      <div className="tabs" role="tablist" aria-label="Dashboard stage">
        <button
          role="tab"
          aria-selected={tab === "stage1"}
          className={tab === "stage1" ? "tab tab--active" : "tab"}
          onClick={() => setTab("stage1")}
        >
          {thai ? "ระยะตัวอ่อน" : "Stage 1"}
        </button>
        <button
          role="tab"
          aria-selected={tab === "stage2"}
          className={tab === "stage2" ? "tab tab--active" : "tab"}
          onClick={() => setTab("stage2")}
        >
          {thai ? "ระยะปลา" : "Stage 2"}
        </button>
        <button
          role="tab"
          aria-selected={tab === "overall"}
          className={tab === "overall" ? "tab tab--active" : "tab"}
          onClick={() => setTab("overall")}
        >
          {thai ? "ภาพรวมกระบวนการ" : "Overview"}
        </button>
      </div>
      {tab === "stage1" && (
        <>
          <ReportPanel title={thai ? "การรอดของตัวอ่อนตามระยะ" : "Stage 1 survival curve"} loading={loading} empty={data.survival.length === 0} emptyMessage={thai ? "ยังไม่มีข้อมูลการรอดที่ตรงกับตัวกรอง" : "No survival observations match these filters."} sampleSize={data.survivalMeta?.sampleSize} quality={<QualityNote meta={data.survivalMeta} thai={thai} />}>
            <SurvivalChart points={data.survival} thai={thai} />
            <p className="insight-strip">{thai ? "เส้นที่ลดลงแสดงช่วงที่ตัวอ่อนสูญเสียมากขึ้น ใช้ระบุระยะที่ควรตรวจเงื่อนไขการทดลองเพิ่มเติม" : "A steeper drop marks the checkpoint where embryo loss increases and the protocol may need closer review."}</p>
            <ReportTable
              collapsed summary={thai ? "ดูตารางข้อมูลและแหล่งที่มา" : "View supporting data"}
              caption="Stage 1 survival by checkpoint"
              headers={[
                thai ? "สถานที่" : "Site",
                thai ? "สายพันธุ์" : "Strain",
                thai ? "กลุ่มทดลอง" : "Treatment",
                thai ? "ระยะ" : "Stage",
                thai ? "จำนวนตั้งต้น" : "Risk set",
                thai ? "รอด" : "Alive",
                thai ? "อัตรารอด" : "Survival",
              ]}
              rows={data.survival.map((point) => [
                String(point.siteId ?? "All"),
                String(point.strain ?? "All"),
                String(point.treatmentGroup ?? "All"),
                String(point.stageLabel ?? point.stageOrder),
                Number(point.riskSet ?? 0),
                Number(point.alive ?? 0),
                point.surv == null ? "Unknown" : Number(point.surv).toFixed(4),
              ])}
            />
            <p className="table-note">{thai ? "ตรวจข้อมูลต้นทาง:" : "Source records:"} <button type="button" className="inline-action" onClick={() => openSource("batches")}>{thai ? "เปิดการทดลองตามตัวกรอง" : "Open filtered batches"}</button><button type="button" className="inline-action" onClick={() => openSource("due")}>{thai ? "เปิดผลตรวจตัวอ่อน" : "Open embryo checkpoints"}</button></p>
          </ReportPanel>
          <ReportPanel title={thai ? "ระยะที่สูญเสียและเริ่มพบความผิดปกติ" : "Attrition / abnormality onset"} loading={loading} empty={data.funnelMeta?.sampleSize === 0 && data.abnormality.length === 0} emptyMessage={thai ? "ยังไม่มีข้อมูลความสูญเสียที่ตรงกับตัวกรอง" : "No attrition or abnormality observations match these filters."} sampleSize={data.funnelMeta?.sampleSize} quality={<QualityNote meta={data.funnelMeta} thai={thai} />}>
            <FunnelChart points={data.funnel} thai={thai} />
            <p className="insight-strip">{thai ? "เรียงจากระยะที่สูญเสียมากที่สุด เพื่อชี้จุดที่ควรย้อนตรวจวิธีปฏิบัติและสภาวะแวดล้อม" : "Stages are ranked by loss so the highest-impact protocol and environment checks surface first."}</p>
            <ReportTable
              collapsed summary={thai ? "ดูอันดับการสูญเสีย" : "View attrition ranking"}
              caption="Attrition ranking by checkpoint"
              headers={thai ? ["อันดับ", "ระยะ", "จำนวนตั้งต้น", "สูญเสีย"] : ["Rank", "Stage", "At risk", "Dead"]}
              rows={[...data.funnel]
                .sort((left, right) => Number(right.nDead ?? 0) - Number(left.nDead ?? 0))
                .map((point, index) => [
                  index + 1,
                  String(point.stageLabel ?? point.stageOrder),
                  Number(point.riskSet ?? 0),
                  Number(point.nDead ?? 0),
                ])}
            />
            <ReportTable
              collapsed summary={thai ? "ดูระยะที่เริ่มพบความผิดปกติ" : "View abnormality onset"}
              caption="Abnormality onset by checkpoint"
              headers={thai ? ["ระยะ", "จำนวน"] : ["Stage", "n"]}
              rows={data.abnormality.map((point) => [
                String(point.stageLabel ?? point.stageOrder),
                Number(point.count ?? 0),
              ])}
            />
            <QualityNote meta={data.abnormalityMeta} thai={thai} />
          </ReportPanel>
          <details className="secondary-analysis"><summary>{thai ? "ดูการวิเคราะห์เวลาและกลุ่มควบคุมเพิ่มเติม" : "View timing and control analysis"}</summary>
          <ReportPanel title={thai ? "เวลาเร็ว–ช้าเมื่อเทียบค่ามาตรฐาน" : "Timing deviation / group comparison"} loading={loading} empty={data.deviation.length === 0} emptyMessage={thai ? "ยังไม่มีข้อมูลเวลาเบี่ยงเบนที่ตรงกับตัวกรอง" : "No timing deviations match these filters."} sampleSize={data.deviationMeta?.sampleSize} quality={<QualityNote meta={data.deviationMeta} thai={thai} />}>
            <DeviationChart points={data.deviation} thai={thai} />
            <p className="insight-strip">{thai ? "ค่าใกล้ศูนย์หมายถึงเวลาใกล้มาตรฐาน ค่าบวกคือช้ากว่า และค่าลบคือเร็วกว่ามาตรฐาน" : "Values near zero match the timing standard; positive values are later and negative values are earlier."}</p>
            <ReportTable
              collapsed summary={thai ? "ดูค่ารายกลุ่ม" : "View group values"}
              caption="Timing deviation by checkpoint and group"
              headers={[
                thai ? "กลุ่ม" : "Group",
                thai ? "ระยะ" : "Stage",
                thai ? "จำนวน" : "n",
                thai ? "เฉลี่ย (ชม.)" : "Mean H",
                thai ? "มัธยฐาน (ชม.)" : "Median H",
                thai ? "ต่ำสุด" : "Min",
                thai ? "สูงสุด" : "Max",
              ]}
              rows={data.deviation.map((point) => [
                String(point.treatmentGroup ?? point.strain ?? "All"),
                String(point.stageLabel ?? point.stageOrder),
                Number(point.n ?? 0),
                Number(point.meanDeviationH ?? 0).toFixed(4),
                Number(point.medianDeviationH ?? 0).toFixed(4),
                Number(point.minDeviationH ?? 0).toFixed(4),
                Number(point.maxDeviationH ?? 0).toFixed(4),
              ])}
            />
            <p className="table-note">{thai ? "ตรวจข้อมูลต้นทาง:" : "Source records:"} <button type="button" className="inline-action" onClick={() => openSource("batches")}>{thai ? "เปิดการทดลองตามตัวกรอง" : "Open filtered batches"}</button></p>
          </ReportPanel>
          <ReportPanel title={thai ? "เปรียบเทียบ SCNT กับกลุ่มควบคุม" : "SCNT / control comparison"} loading={loading} empty={data.kpiMeta?.denominators?.stage1Condition === 0 && comparison.every((point) => Number(point.n ?? 0) === 0)} emptyMessage={thai ? "ยังไม่มีข้อมูลกลุ่มควบคุมที่ตรงกับตัวกรอง" : "No SCNT or control-arm counts match these filters."} sampleSize={data.kpiMeta?.sampleSize} quality={<QualityNote meta={data.kpiMeta} thai={thai} />}>
            <BarSummary points={comparison} label={(point) => `${String(point.armType)} · ${String(point.stageLabel ?? point.stageOrder)}`} value={(point) => Number(point.nNormal ?? 0)} />
            <ReportTable
              collapsed summary={thai ? "ดูผลเปรียบเทียบรายระยะ" : "View comparison by stage"}
              caption="SCNT and control-arm comparison"
              headers={thai ? ["กลุ่ม", "ระยะ", "จำนวน", "ปกติ", "ผิดปกติ", "ปกติ (%)"] : ["Arm", "Stage", "n", "Normal", "Abnormal", "Normal %"]}
              rows={comparison.map((point) => [
                String(point.armType),
                String(point.stageLabel ?? point.stageOrder),
                Number(point.n ?? 0),
                Number(point.nNormal ?? 0),
                Number(point.nAbnormal ?? 0),
                percent(point.pctNormal),
              ])}
            />
          </ReportPanel>
          </details>
        </>
      )}
      {tab === "stage2" && (
        <>
          <ReportPanel title={thai ? "การรอดของปลาตามอายุ" : "Fish survival by age"} loading={loading} empty={data.fishSurvival.length === 0} emptyMessage={thai ? "ยังไม่มีข้อมูลการรอดของปลาที่ตรงกับตัวกรอง" : "No fish survival observations match these filters."} sampleSize={data.fishSurvivalMeta?.sampleSize} quality={<QualityNote meta={data.fishSurvivalMeta} thai={thai} />}>
            <FishSurvivalChart points={data.fishSurvival} thai={thai} />
            <p className="insight-strip">{thai ? "เปรียบเทียบเส้นตามอายุเพื่อดูว่ากลุ่มใดเริ่มมีการรอดลดลงเร็วกว่ากลุ่มอื่น" : "Compare age curves to see which group begins losing survival earlier than the others."}</p>
            <ReportTable
              collapsed summary={thai ? "ดูข้อมูลการรอดรายอายุ" : "View survival data by age"}
              caption="Fish survival by age and condition"
              headers={thai ? ["สภาพ", "สายพันธุ์", "กลุ่มทดลอง", "อายุ (วัน)", "จำนวนตั้งต้น", "รอด", "ตาย", "แช่แข็ง", "คัดออก", "ผู้/เมีย", "ตู้ปลา", "อัตรารอด"] : ["Condition", "Strain", "Treatment", "Age day", "At risk", "Alive", "Dead", "Frozen", "Discarded", "M/F", "Boxes", "Survival"]}
              rows={data.fishSurvival.map((point) => [
                String(point.condition ?? "All"),
                String(point.strain ?? "All"),
                String(point.treatmentGroup ?? "All"),
                Number(point.ageDays ?? 0),
                Number(point.atRisk ?? 0),
                Number(point.alive ?? 0),
                Number(point.nDead ?? 0),
                Number(point.nFrozen ?? 0),
                Number(point.nDiscarded ?? 0),
                `${Number(point.nMale ?? 0)}/${Number(point.nFemale ?? 0)}`,
                Number(point.nBoxes ?? 0),
                point.surv == null ? "Unknown" : Number(point.surv).toFixed(4),
              ])}
            />
            <p className="table-note">{thai ? "ตรวจข้อมูลต้นทาง:" : "Source records:"} <button type="button" className="inline-action" onClick={() => openSource("fish")}>{thai ? "เปิดทะเบียนปลาตามตัวกรอง" : "Open filtered fish registry"}</button></p>
          </ReportPanel>
          <ReportPanel title={thai ? "ปลาที่ขาดการตรวจติดตาม" : "Observation gaps"} loading={loading} empty={data.gaps.length === 0} emptyMessage={thai ? "ไม่พบปลาที่ขาดการตรวจติดตาม" : "No fish observation gaps for this filter."} sampleSize={data.gapsMeta?.sampleSize} quality={<QualityNote meta={data.gapsMeta} thai={thai} />}>
            <ReportTable
              collapsed summary={thai ? "ดูปลาที่ขาดการติดตาม" : "View fish with missing checks"}
              caption="Fish observation gaps"
              headers={thai ? ["ปลา", "ตรวจล่าสุด", "ขาดการตรวจ (วัน)"] : ["Fish", "Last observed", "Missed days"]}
              rows={data.gaps.map((point) => [
                String(point.fishCode ?? "—"),
                String(point.lastObservedOn ?? "—"),
                Number(point.missedDays ?? 0),
              ])}
            />
            <p className="table-note">{thai ? "ตรวจข้อมูลต้นทาง:" : "Source records:"} <button type="button" className="inline-action" onClick={() => openSource("fish")}>{thai ? "เปิดทะเบียนปลา" : "Open fish records"}</button></p>
          </ReportPanel>
        </>
      )}
      {tab === "overall" && (
        <>
          <ReportPanel title={thai ? "ผลลัพธ์ตลอดกระบวนการ" : "Pipeline conversion"} loading={loading} empty={data.pipelineMeta?.sampleSize === 0} emptyMessage={thai ? "ยังไม่มีข้อมูลกระบวนการที่ตรงกับตัวกรอง" : "No pipeline records match these filters."} sampleSize={data.pipelineMeta?.sampleSize} quality={<QualityNote meta={data.pipelineMeta} thai={thai} />}>
            <BarSummary points={data.pipeline} label={(point) => String(point.step)} value={(point) => Number(point.count ?? 0)} />
            <ReportTable
              collapsed summary={thai ? "ดูอัตราเปลี่ยนผ่านทุกขั้น" : "View conversion by step"}
              caption="End-to-end pipeline conversion"
              headers={thai ? ["ขั้นตอน", "จำนวน", "% จากขั้นก่อน", "% จากตัวอ่อนที่กระตุ้น"] : ["Step", "n", "% previous", "% activated"]}
              rows={data.pipeline.map((point) => [
                String(point.step),
                Number(point.count ?? 0),
                percent(point.pctOfPrevious),
                percent(point.pctOfStart),
              ])}
            />
            <p className="table-note">{thai ? "ตรวจข้อมูลต้นทาง:" : "Source records:"} <button type="button" className="inline-action" onClick={() => openSource("batches")}>{thai ? "เปิดการทดลอง" : "Open batches"}</button><button type="button" className="inline-action" onClick={() => openSource("fish")}>{thai ? "เปิดทะเบียนปลา" : "Open fish registry"}</button></p>
          </ReportPanel>
          <ReportPanel title={thai ? "หลักฐานเวลาเบี่ยงเบน" : "Timing deviation evidence"} loading={loading} empty={data.deviation.length === 0} emptyMessage={thai ? "ยังไม่มีข้อมูลเวลาเบี่ยงเบนที่ตรงกับตัวกรอง" : "No timing deviations match these filters."} sampleSize={data.deviationMeta?.sampleSize} quality={<QualityNote meta={data.deviationMeta} thai={thai} />}>
            <DeviationChart points={data.deviation} thai={thai} />
            <ReportTable
              collapsed summary={thai ? "ดูหลักฐานเวลาเบี่ยงเบน" : "View timing evidence"}
              caption="Timing deviation evidence"
              headers={thai ? ["ระยะ", "จำนวน", "เฉลี่ย (ชม.)", "SD (ชม.)"] : ["Stage", "n", "Mean H", "SD H"]}
              rows={data.deviation.map((point) => [
                String(point.stageLabel ?? point.stageOrder),
                Number(point.n ?? 0),
                Number(point.meanDeviationH ?? 0).toFixed(4),
                point.sdDeviationH == null
                  ? "—"
                  : Number(point.sdDeviationH).toFixed(4),
              ])}
            />
          </ReportPanel>
        </>
      )}
      {data.kpi == null && !loading && (
        <NoData message="Dashboard is empty. Create a batch and record observations to see panels." />
      )}
    </section>
  );
}
