import { type KeyboardEvent, useCallback, useEffect, useState } from "react";
import { type ApiItem, get } from "../api/client";
import {
  type DashboardFilters,
  analyticsFilters,
  filterQuery,
  parseFilters,
  withFilters,
} from "../filters";
import { type AppText, type Page, text } from "../types";
import { ErrorMessage, Metric, ReportPanel, ReportTable } from "../components";

export const dashboardTabs = ["stage1", "stage2", "overall"] as const;
type DashboardTab = (typeof dashboardTabs)[number];
export type Stage1Comparison = "strain" | "treatmentGroup" | "operator";
export type Stage2Comparison = "overall" | "abnormalityGroup" | "strain" | "treatmentGroup";
const stage1Comparisons: Stage1Comparison[] = ["strain", "treatmentGroup", "operator"];
const stage2Comparisons: Stage2Comparison[] = ["overall", "abnormalityGroup", "strain", "treatmentGroup"];

export function dashboardDataPath(filters: DashboardFilters, stage1Comparison: Stage1Comparison, stage2Comparison: Stage2Comparison): string {
  const params = new URLSearchParams();
  params.append("stage1GroupBy", "site");
  params.append("stage1GroupBy", stage1Comparison);
  if (stage2Comparison !== "overall") params.append("stage2GroupBy", stage2Comparison === "abnormalityGroup" ? "condition" : stage2Comparison);
  return withFilters(`/analytics/dashboard?${params.toString()}`, filters);
}

export function parseDashboardTab(search = window.location.search): DashboardTab {
  const value = new URLSearchParams(search).get("tab");
  return dashboardTabs.includes(value as DashboardTab) ? (value as DashboardTab) : "stage1";
}

function dashboardURL(filters: DashboardFilters, tab: DashboardTab): string {
  const params = new URLSearchParams(filterQuery(analyticsFilters(filters)));
  params.set("tab", tab);
  return `${window.location.pathname}?${params.toString()}${window.location.hash}`;
}

function updateDashboardURL(filters: DashboardFilters, tab: DashboardTab): void {
  window.history.replaceState(null, "", dashboardURL(filters, tab));
}

function pushDashboardTab(filters: DashboardFilters, tab: DashboardTab): void {
  window.history.pushState(null, "", dashboardURL(filters, tab));
}

type AnalyticsMeta = {
  sampleSize?: number;
  denominators?: Record<string, number>;
  unknown?: Record<string, number>;
  missing?: Record<string, number>;
};
type DashboardData = {
  reportMeta: ApiItem | null;
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

type DashboardMasterOptions = {
  sites: ApiItem[];
  operators: ApiItem[];
  treatments: ApiItem[];
  donors: ApiItem[];
  batches: ApiItem[];
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

export function useDashboardMasterOptions(): DashboardMasterOptions {
  return {
    sites: useMasterOptions("sites"),
    operators: useMasterOptions("operators"),
    treatments: useMasterOptions("treatment-groups"),
    donors: useMasterOptions("donor-cell-lines"),
    batches: useMasterOptions("batches"),
  };
}

function masterLabel(items: ApiItem[], id: string, fallback: string): string {
  const item = items.find((candidate) => String(candidate.id) === id);
  return String(item?.name ?? item?.code ?? item?.batchCode ?? item?.strain ?? fallback);
}

function generatedAtLabel(value: unknown, thai: boolean): string {
  if (!value) return thai ? "กำลังรอเวลา" : "Waiting for timestamp";
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.valueOf())) return thai ? "ไม่ทราบเวลา" : "Unknown time";
  return `${new Intl.DateTimeFormat(thai ? "th-TH" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Bangkok",
  }).format(parsed)} (${thai ? "เวลาไทย" : "Bangkok time"})`;
}

type ScopeBarProps = {
  filters: DashboardFilters;
  options: DashboardMasterOptions;
  reportMeta: ApiItem | null;
  thai: boolean;
  onClear: () => void;
  onEdit: () => void;
};

function ScopeBar({ filters, options, reportMeta, thai, onClear, onEdit }: ScopeBarProps) {
  const labels: Record<string, string> = {
    siteId: thai ? "สถานที่" : "Site",
    operatorId: thai ? "ผู้ปฏิบัติงาน" : "Operator",
    treatmentGroupId: thai ? "กลุ่มทดลอง" : "Treatment",
    donorCellLineId: thai ? "เซลล์ผู้ให้" : "Donor",
    batchId: thai ? "รอบทดลอง" : "Batch",
    strain: thai ? "สายพันธุ์" : "Strain",
    dateFrom: thai ? "ตั้งแต่" : "From",
    dateTo: thai ? "ถึง" : "To",
  };
  const optionLists: Record<string, ApiItem[]> = {
    siteId: options.sites,
    operatorId: options.operators,
    treatmentGroupId: options.treatments,
    donorCellLineId: options.donors,
    batchId: options.batches,
  };
  const chips = Object.entries(filters).map(([key, value]) => {
    const display = optionLists[key]
      ? masterLabel(optionLists[key], String(value), String(value))
      : String(value);
    return <span className="scope-chip" key={key}><strong>{labels[key] ?? key}</strong><span>{display}</span></span>;
  });
  const versions = ((reportMeta?.timingProfileVersions as number[] | undefined) ?? []).join(", ");
  return (
    <section className="analysis-scope" aria-label={thai ? "ขอบเขตข้อมูลผลการทดลอง" : "Research result analysis scope"}>
      <div className="analysis-scope__heading">
        <div>
          <p className="eyebrow">{thai ? "ขอบเขตการวิเคราะห์" : "ANALYSIS SCOPE"}</p>
          <h2>{thai ? "ข้อมูลที่กำลังสรุป" : "Records in view"}</h2>
        </div>
        <div className="button-row">
          <button type="button" className="button button--secondary" onClick={onEdit}>{thai ? "แก้ตัวกรอง" : "Edit filters"}</button>
          {chips.length > 0 && <button type="button" className="button button--secondary" onClick={onClear}>{thai ? "ล้างตัวกรอง" : "Clear filters"}</button>}
        </div>
      </div>
      <div className="analysis-scope__chips" aria-live="polite">
        {chips.length > 0 ? chips : <span className="scope-chip scope-chip--all">{thai ? "ทุกข้อมูลที่มีสิทธิ์ดู" : "All available records"}</span>}
      </div>
      <dl className="analysis-scope__meta">
        <div><dt>{thai ? "สร้างผลเมื่อ" : "Generated"}</dt><dd><time dateTime={reportMeta?.generatedAt ? String(reportMeta.generatedAt) : undefined}>{generatedAtLabel(reportMeta?.generatedAt, thai)}</time></dd></div>
        <div><dt>{thai ? "รุ่น timing profile" : "Timing profile version(s)"}</dt><dd>{versions || (thai ? "ไม่ระบุ" : "Not specified")}</dd></div>
      </dl>
    </section>
  );
}

export function FilterBar({
  filters,
  onChange,
  options,
  t = text.en,
}: {
  filters: DashboardFilters;
  onChange: (filters: DashboardFilters) => void;
  options: DashboardMasterOptions;
  t?: AppText;
}) {
  const thai = t === text.th;
  const activeCount = Object.values(filters).filter(Boolean).length;
  const update = (key: keyof DashboardFilters, value: string) =>
    onChange({ ...filters, [key]: value || undefined });
  return (
    <details id="dashboard-filter-disclosure" className="filter-disclosure">
      <summary id="dashboard-filter-summary">{thai ? "ตัวกรองข้อมูล" : "Filter data"}{activeCount ? ` · ${activeCount} ${thai ? "รายการ" : "active"}` : ` · ${thai ? "ทั้งหมด" : "All records"}`}</summary>
      <fieldset className="filter-bar">
      <legend>{thai ? "เลือกเฉพาะข้อมูลที่ต้องการวิเคราะห์" : "Choose records to analyse"}</legend>
      <label>
        {thai ? "สถานที่" : "Site"}
        <select
          value={filters.siteId ?? ""}
          onChange={(event) => update("siteId", event.target.value)}
        >
          <option value="">{thai ? "ทุกสถานที่" : "All sites"}</option>
          {options.sites.map((item) => (
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
          {options.operators.map((item) => (
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
          {options.treatments.map((item) => (
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
          {options.donors.map((item) => (
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
          {options.batches.map((item) => (
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

function ComparisonControl({ kind, value, onChange, thai }: { kind: "stage1" | "stage2"; value: Stage1Comparison | Stage2Comparison; onChange: (value: Stage1Comparison | Stage2Comparison) => void; thai: boolean }) {
  const options = kind === "stage1" ? stage1Comparisons : stage2Comparisons;
  const labels: Record<string, string> = {
    overall: thai ? "ภาพรวม (ไม่แบ่งกลุ่ม)" : "Overall (no groups)",
    abnormalityGroup: thai ? "กลุ่มความผิดปกติ" : "Abnormality group",
    strain: thai ? "สายพันธุ์" : "Strain",
    treatmentGroup: thai ? "กลุ่มทดลอง" : "Treatment",
    operator: thai ? "ผู้ปฏิบัติงาน" : "Operator",
  };
  return <div className="chart-controls">
    <label>{thai ? "เปรียบเทียบตามมิติเดียว" : "Compare by one dimension"}
      <select value={value} onChange={(event) => onChange(event.target.value as Stage1Comparison | Stage2Comparison)} aria-label={thai ? "มิติสำหรับเปรียบเทียบกราฟ" : "Chart comparison dimension"}>
        {options.map((option) => <option key={option} value={option}>{labels[option]}</option>)}
      </select>
    </label>
    <span className="chart-controls__note">{kind === "stage1" ? (thai ? "แยกแผงตามสถานที่" : "Each site is a separate facet") : (thai ? "ภาพรวมใช้ Kaplan–Meier ชุดเดียว" : "Overall uses one Kaplan-Meier series")}</span>
  </div>;
}

function stepPath(points: ApiItem[], x: (value: number) => number, y: (value: number) => number, valueKey: string, xKey = "stageOrder"): string {
  const sorted = [...points].sort((left, right) => Number(left[xKey] ?? 0) - Number(right[xKey] ?? 0));
  if (sorted.length === 0) return "";
  let path = `M ${x(Number(sorted[0][xKey] ?? 0))} ${y(Number(sorted[0][valueKey] ?? 0))}`;
  for (const point of sorted.slice(1)) {
    const pointX = x(Number(point[xKey] ?? 0));
    const pointY = y(Number(point[valueKey] ?? 0));
    path += ` H ${pointX} V ${pointY}`;
  }
  return path;
}

function stageComparisonLabel(comparison: Stage1Comparison, thai: boolean): string {
  if (comparison === "operator") return thai ? "ผู้ปฏิบัติงาน" : "Operator";
  if (comparison === "treatmentGroup") return thai ? "กลุ่มทดลอง" : "Treatment group";
  return thai ? "สายพันธุ์" : "Strain";
}

function stageComparisonValue(point: ApiItem, comparison: Stage1Comparison, operators: ApiItem[] = []): string {
  if (comparison === "operator") {
    const id = String(point.operator ?? point.operatorId ?? "");
    return id ? masterLabel(operators, id, id) : "All operators";
  }
  if (comparison === "treatmentGroup") return String(point.treatmentGroup ?? point.treatmentGroupId ?? "All treatments");
  return String(point.strain ?? "All strains");
}

function chartPalette(index: number): { color: string; dash?: string } {
  const palette = [
    { color: "#0b6761" },
    { color: "#b67b2f", dash: "7 4" },
    { color: "#557f9c", dash: "2 4" },
    { color: "#775f8f", dash: "10 3 2 3" },
  ];
  return palette[index % palette.length];
}

function ChartAxis({ width, height, min, max, xLabel, thai }: { width: number; height: number; min: number; max: number; xLabel: string; thai: boolean }) {
  const plotTop = 18;
  const plotBottom = height - 48;
  const x = (value: number) => 54 + ((value - min) / Math.max(1, max - min)) * (width - 76);
  return <>
    {[0, .5, 1].map((value) => <g key={value}><line x1="54" y1={plotBottom - value * (plotBottom - plotTop)} x2={width - 22} y2={plotBottom - value * (plotBottom - plotTop)} stroke="currentColor" opacity=".14" /><text x="8" y={plotBottom + 4 - value * (plotBottom - plotTop)}>{value * 100}%</text></g>)}
    <text x={width / 2} y={height - 6} textAnchor="middle">{xLabel}</text>
    <text x="10" y={height / 2} textAnchor="middle" transform={`rotate(-90 10 ${height / 2})`}>{thai ? "อัตรารอด (%)" : "Survival (%)"}</text>
    <line x1="54" y1={plotBottom} x2={width - 22} y2={plotBottom} stroke="currentColor" opacity=".35" />
    <line x1="54" y1={plotTop} x2="54" y2={plotBottom} stroke="currentColor" opacity=".35" />
    {Array.from({ length: Math.min(7, Math.max(1, max - min + 1)) }, (_, index) => {
      const value = min + (max - min) * index / Math.max(1, Math.min(6, max - min));
      return <text key={index} x={x(value)} y={plotBottom + 18} textAnchor={index === 0 ? "start" : index === Math.min(6, max - min) ? "end" : "middle"}>{String(Math.round(value))}</text>;
    })}
  </>;
}

function chartPointLabel(point: ApiItem, label: string, thai: boolean): string {
  const stage = String(point.stageLabel ?? point.stageOrder ?? "?");
  const survival = `${(Number(point.surv ?? 0) * 100).toFixed(1)}%`;
  return thai ? `${label}, ${stage}, อัตรารอด ${survival}, กลุ่มเสี่ยง ${Number(point.riskSet ?? 0)}` : `${label}, ${stage}, survival ${survival}, risk set ${Number(point.riskSet ?? 0)}`;
}

function chartPointKeyDown(
  event: KeyboardEvent<SVGCircleElement>,
  pointIndex: number,
  pointCount: number,
  setActivePoint: (index: number) => void,
): void {
  const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
  const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? pointCount - 1 : direction ? (pointIndex + direction + pointCount) % pointCount : -1;
  if (nextIndex < 0 || nextIndex === pointIndex) return;
  event.preventDefault();
  setActivePoint(nextIndex);
  const source = event.currentTarget;
  requestAnimationFrame(() => {
    const series = source.closest("[data-chart-series]");
    series?.querySelectorAll<SVGCircleElement>(".chart-point")[nextIndex]?.focus();
  });
}

function sampleChartPoints(points: ApiItem[], xKey: "stageOrder" | "ageDays"): ApiItem[] {
  const sorted = [...points].sort((left, right) => Number(left[xKey] ?? 0) - Number(right[xKey] ?? 0));
  if (sorted.length <= 3) return sorted;
  const indexes = [0, Math.floor((sorted.length - 1) / 2), sorted.length - 1];
  return indexes.map((index) => sorted[index]).filter((point, index, selected) => selected.findIndex((candidate) => candidate[xKey] === point[xKey]) === index);
}

function initialSeriesSamples(points: ApiItem[], group: (point: ApiItem) => string, xKey: "stageOrder" | "ageDays", nKey: "riskSet" | "atRisk"): Array<{ label: string; n: number }> {
  const initial = new Map<string, ApiItem>();
  for (const point of points) {
    const label = group(point);
    const current = initial.get(label);
    if (!current || Number(point[xKey] ?? 0) < Number(current[xKey] ?? 0)) initial.set(label, point);
  }
  return [...initial.entries()].map(([label, point]) => ({ label, n: Number(point[nKey] ?? 0) })).sort((left, right) => left.label.localeCompare(right.label));
}

function smallSeriesMessage(samples: Array<{ label: string; n: number }>, thai: boolean): string | null {
  const small = samples.filter((sample) => sample.n < 5);
  if (small.length === 0) return null;
  const labels = small.map((sample) => `${sample.label} (n=${sample.n})`).join(", ");
  return thai ? `กลุ่มที่มีจุดเริ่มต้นน้อยกว่า 5: ${labels}; แสดงข้อมูลเชิงสำรวจเท่านั้น` : `Series with fewer than 5 at the initial point: ${labels}; exploratory data only.`;
}

function StageRiskSummary({ points, comparison, operators, thai, site }: { points: ApiItem[]; comparison: Stage1Comparison; operators: ApiItem[]; thai: boolean; site: string }) {
  const grouped = new Map<string, ApiItem[]>();
  for (const point of points) {
    const label = stageComparisonValue(point, comparison, operators);
    grouped.set(label, [...(grouped.get(label) ?? []), point]);
  }
  const rows = [...grouped.entries()].flatMap(([label, groupPoints]) => sampleChartPoints(groupPoints, "stageOrder").map((point) => ({ label, point })));
  return <div className="chart-mini-table-wrap">
    <table className="chart-mini-table">
      <caption>{thai ? `สรุปจุดตรวจและกลุ่มเสี่ยง: ${site}` : `Visible checkpoint risk summary: ${site}`}</caption>
      <thead><tr><th scope="col">{stageComparisonLabel(comparison, thai)}</th><th scope="col">{thai ? "ระยะ" : "Checkpoint"}</th><th scope="col">{thai ? "กลุ่มเสี่ยง" : "Risk set"}</th><th scope="col">{thai ? "รอด" : "Alive"}</th></tr></thead>
      <tbody>{rows.map(({ label, point }, index) => <tr key={`${label}-${point.stageOrder}-${index}`}><th scope="row">{label}</th><td>{String(point.stageLabel ?? point.stageOrder)}</td><td>{Number(point.riskSet ?? 0)}</td><td>{Number(point.alive ?? 0)}</td></tr>)}</tbody>
    </table>
  </div>;
}

export function SurvivalChart({ points, thai = false, comparison = "strain", operators = [] }: { points: ApiItem[]; thai?: boolean; comparison?: Stage1Comparison; operators?: ApiItem[] }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [activePoints, setActivePoints] = useState<Record<string, number>>({});
  if (points.length === 0) return null;
  const width = 620;
  const height = 230;
  const facets = new Map<string, Map<string, ApiItem[]>>();
  for (const point of points) {
    const site = String(point.site ?? point.siteId ?? "All sites");
    const label = stageComparisonValue(point, comparison, operators);
    const groups = facets.get(site) ?? new Map<string, ApiItem[]>();
    groups.set(label, [...(groups.get(label) ?? []), point]);
    facets.set(site, groups);
  }
  const facetEntries = [...facets.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const stageValues = points.map((point) => Number(point.stageOrder ?? 0));
  const minStage = Math.min(...stageValues);
  const maxStage = Math.max(...stageValues);
  const plotTop = 18;
  const plotBottom = height - 48;
  const x = (stage: number) => 54 + ((stage - minStage) / Math.max(1, maxStage - minStage)) * (width - 76);
  const y = (survival: number) => plotBottom - Math.max(0, Math.min(1, survival)) * (plotBottom - plotTop);
  const visibleSeries = facetEntries.reduce((total, [, groups]) => total + Math.min(4, groups.size), 0);
  const totalSeries = facetEntries.reduce((total, [, groups]) => total + groups.size, 0);
  return <div className="chart-block chart-block--facets">
    {facetEntries.map(([site, groups]) => {
      const series = [...groups.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      const shown = series.slice(0, 4);
      return <section className="chart-facet" key={site}>
        <h3>{thai ? `สถานที่: ${site}` : `Site: ${site}`}</h3>
        <div className="chart-legend" aria-label={thai ? `เลือกเส้นข้อมูลของ ${site}` : `Toggle series for ${site}`}>
          {shown.map(([label], index) => {
            const key = `${site}::${label}`;
            const { color, dash } = chartPalette(index);
            return <button type="button" aria-pressed={!hidden.has(key)} className="chart-legend__item" key={key} onClick={() => setHidden((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })}><svg className="chart-legend__swatch" viewBox="0 0 18 6" aria-hidden="true"><line x1="1" y1="3" x2="17" y2="3" stroke={color} strokeDasharray={dash} strokeWidth="2" /></svg>{label}</button>;
          })}
        </div>
        <svg className="chart chart--survival" role="group" aria-label={thai ? `กราฟเส้นขั้นบันไดอัตรารอดตัวอ่อน ${site}` : `Stage 1 step survival chart for ${site}`} viewBox={`0 0 ${width} ${height}`}>
          <ChartAxis width={width} height={height} min={minStage} max={maxStage} xLabel={thai ? "ระยะการพัฒนา" : "Development checkpoint"} thai={thai} />
          {shown.map(([label, groupPoints], index) => {
            const key = `${site}::${label}`;
            const { color, dash } = chartPalette(index);
            const sorted = [...groupPoints].sort((left, right) => Number(left.stageOrder ?? 0) - Number(right.stageOrder ?? 0));
            const last = sorted.at(-1);
            const activePoint = Math.min(activePoints[key] ?? 0, Math.max(0, sorted.length - 1));
            return hidden.has(key) ? null : <g key={key}>
              <path className="chart-line" d={stepPath(groupPoints, x, y, "surv")} fill="none" stroke={color} strokeDasharray={dash} strokeWidth="2.5" />
              <g data-chart-series={key}>
                {sorted.map((point, pointIndex) => <circle className="chart-point" key={`${key}-${point.stageOrder}-${pointIndex}`} cx={x(Number(point.stageOrder ?? 0))} cy={y(Number(point.surv ?? 0))} r="4" fill={color} tabIndex={activePoint === pointIndex ? 0 : -1} role="img" aria-label={chartPointLabel(point, label, thai)} onFocus={() => setActivePoints((current) => ({ ...current, [key]: pointIndex }))} onKeyDown={(event) => chartPointKeyDown(event, pointIndex, sorted.length, (next) => setActivePoints((current) => ({ ...current, [key]: next })))}><title>{chartPointLabel(point, label, thai)}</title></circle>)}
              </g>
              {last && <text className="chart-end-label" x={width - 24} y={y(Number(last.surv ?? 0)) - 6} fill={color} textAnchor="end">{label}</text>}
            </g>;
          })}
        </svg>
        <p className="chart-summary" role="status">{thai ? `${shown.length} เส้นแสดงในแผงนี้ แยกตาม${comparison === "strain" ? "สายพันธุ์" : comparison === "operator" ? "ผู้ปฏิบัติงาน" : "กลุ่มทดลอง"}; จุดข้อมูลมีอัตรารอดและ risk set` : `${shown.length} series shown in this site facet, compared by ${comparison === "strain" ? "strain" : comparison === "operator" ? "operator" : "treatment"}; focus a point for survival and risk-set details.`}</p>
        <StageRiskSummary points={shown.flatMap(([, groupPoints]) => groupPoints)} comparison={comparison} operators={operators} thai={thai} site={site} />
      </section>;
    })}
    {totalSeries > visibleSeries && <p className="chart-limit-note" role="status">{thai ? `แสดงไม่เกิน 4 เส้นต่อสถานที่ (${visibleSeries} จาก ${totalSeries} เส้น) ดูข้อมูลทั้งหมดในตารางประกอบด้านล่าง` : `Showing at most 4 series per site (${visibleSeries} of ${totalSeries}); the supporting table below contains every series.`}</p>}
  </div>;
}

export function FunnelChart({ points, thai = false }: { points: ApiItem[]; thai?: boolean }) {
  if (points.length === 0) return null;
  const width = 560;
  const shown = [...points].sort((left, right) => {
    const leftRate = Number(left.riskSet ?? 0) ? Number(left.nDead ?? 0) / Number(left.riskSet) : -1;
    const rightRate = Number(right.riskSet ?? 0) ? Number(right.nDead ?? 0) / Number(right.riskSet) : -1;
    return rightRate - leftRate || Number(right.nDead ?? 0) - Number(left.nDead ?? 0);
  }).slice(0, 8);
  const maxRate = Math.max(1, ...shown.map((point) => Number(point.riskSet ?? 0) ? Number(point.nDead ?? 0) / Number(point.riskSet) : 0));
  return (
    <svg
      className="chart chart--funnel"
      role="img"
      aria-label={thai ? "อัตราการสูญเสียตัวอ่อนแยกตามระยะ" : "Embryo loss rate by checkpoint"}
      viewBox={`0 0 ${width} ${Math.max(150, shown.length * 27 + 12)}`}
    >
      {shown.map((point, index) => {
        const dead = Number(point.nDead ?? 0);
        const riskSet = Number(point.riskSet ?? 0);
        const lossRate = riskSet ? dead / riskSet : null;
        const barWidth = lossRate == null || lossRate === 0 ? 0 : Math.max(3, (lossRate / maxRate) * (width - 190));
        return <g key={`${String(point.stageOrder)}-${index}`}>
          <text x="4" y={index * 27 + 17}>{String(point.stageLabel ?? point.stageOrder)}</text>
          <rect x="126" y={index * 27 + 5} width={width - 176} height="16" rx="8" fill="#e7efec" />
          <rect x="126" y={index * 27 + 5} width={barWidth} height="16" rx="8" fill="#0b6761" />
          <text x={width - 4} y={index * 27 + 17} textAnchor="end">{dead} / {riskSet} ({lossRate == null ? "—" : `${Math.round(lossRate * 100)}%`})</text>
        </g>;
      })}
    </svg>
  );
}

function AbnormalityOnsetChart({ points, meta, thai = false }: { points: ApiItem[]; meta: AnalyticsMeta | null; thai?: boolean }) {
  const categories = [
    ...[...points].sort((left, right) => Number(left.stageOrder ?? 0) - Number(right.stageOrder ?? 0)).map((point) => ({
      label: String(point.stageLabel ?? point.stageOrder),
      count: Number(point.count ?? 0),
    })),
    { label: thai ? "ไม่เคยพบความผิดปกติ" : "No abnormality recorded", count: Number(meta?.denominators?.noAbnormalityRecorded ?? 0) },
    { label: thai ? "ข้อมูลแรกที่ผิดปกติหายไป" : "Missing first-abnormality evidence", count: Number(meta?.missing?.firstAbnormality ?? 0) },
  ];
  if (categories.length === 0) return null;
  const max = Math.max(1, ...categories.map((category) => category.count));
  return <div className="histogram" role="img" aria-label={thai ? "ฮิสโตแกรมระยะแรกที่พบความผิดปกติ พร้อมข้อมูลที่ไม่เคยพบและข้อมูลหาย" : "Abnormality onset histogram with no-abnormality and missing-data categories"}>
    {categories.map((category) => <div className="histogram__row" key={category.label}>
      <span>{category.label}</span>
      <span className="histogram__track" aria-hidden="true"><span style={{ width: `${category.count / max * 100}%` }} /></span>
      <strong>{category.count.toLocaleString()}</strong>
    </div>)}
    <p className="chart-summary">{thai ? "แยกข้อมูลที่ไม่เคยพบความผิดปกติออกจากข้อมูลที่ไม่มีหลักฐาน" : "No abnormality recorded is kept separate from missing first-abnormality evidence."}</p>
  </div>;
}

function fishComparisonValue(point: ApiItem, comparison: Stage2Comparison): string {
  if (comparison === "overall") return "Overall";
  if (comparison === "abnormalityGroup") return String(point.abnormalityGroup ?? point.condition ?? "UNKNOWN");
  if (comparison === "treatmentGroup") return String(point.treatmentGroup ?? "ALL");
  return String(point.strain ?? "ALL");
}

function fishComparisonLabel(comparison: Stage2Comparison, thai: boolean): string {
  if (comparison === "overall") return thai ? "ภาพรวม" : "Overall";
  if (comparison === "abnormalityGroup") return thai ? "กลุ่มความผิดปกติ" : "Abnormality group";
  if (comparison === "treatmentGroup") return thai ? "กลุ่มทดลอง" : "Treatment group";
  return thai ? "สายพันธุ์" : "Strain";
}

function fishPointLabel(point: ApiItem, label: string, thai: boolean): string {
  const survival = `${(Number(point.surv ?? 0) * 100).toFixed(1)}%`;
  const events = Number(point.nEvents ?? 0);
  const censored = Number(point.nCensored ?? 0);
  return thai ? `${label}, อายุ ${Number(point.ageDays ?? 0)} วัน, อัตรารอด ${survival}, เสี่ยง ${Number(point.atRisk ?? 0)}, เหตุการณ์ ${events}, censored ${censored}` : `${label}, age ${Number(point.ageDays ?? 0)} days, survival ${survival}, at risk ${Number(point.atRisk ?? 0)}, events ${events}, censored ${censored}`;
}

function ciBandPath(points: ApiItem[], x: (value: number) => number, y: (value: number) => number): string {
  const sorted = [...points].sort((left, right) => Number(left.ageDays ?? 0) - Number(right.ageDays ?? 0));
  if (sorted.length < 2) return "";
  const upper = sorted.map((point) => `${x(Number(point.ageDays ?? 0))},${y(Number(point.survUpper95 ?? point.surv ?? 0))}`).join(" ");
  const lower = [...sorted].reverse().map((point) => `${x(Number(point.ageDays ?? 0))},${y(Number(point.survLower95 ?? point.surv ?? 0))}`).join(" ");
  return `M ${upper} L ${lower} Z`;
}

function FishRiskSummary({ points, comparison, thai }: { points: ApiItem[]; comparison: Stage2Comparison; thai: boolean }) {
  const grouped = new Map<string, ApiItem[]>();
  for (const point of points) {
    const label = fishComparisonValue(point, comparison);
    grouped.set(label, [...(grouped.get(label) ?? []), point]);
  }
  const rows = [...grouped.entries()].flatMap(([label, groupPoints]) => sampleChartPoints(groupPoints, "ageDays").map((point) => ({ label, point })));
  return <div className="chart-mini-table-wrap">
    <table className="chart-mini-table">
      <caption>{thai ? "สรุปกลุ่มเสี่ยง เหตุการณ์ และข้อมูลตัดขวา" : "Visible risk, event, and censor summary"}</caption>
      <thead><tr><th scope="col">{fishComparisonLabel(comparison, thai)}</th><th scope="col">{thai ? "อายุ (วัน)" : "Age (days)"}</th><th scope="col">{thai ? "กลุ่มเสี่ยง" : "At risk"}</th><th scope="col">{thai ? "เหตุการณ์ตาย" : "Death events"}</th><th scope="col">{thai ? "ตัดขวา" : "Censored"}</th></tr></thead>
      <tbody>{rows.map(({ label, point }, index) => <tr key={`${label}-${point.ageDays}-${index}`}><th scope="row">{label}</th><td>{Number(point.ageDays ?? 0)}</td><td>{Number(point.atRisk ?? 0)}</td><td>{Number(point.nEvents ?? 0)}</td><td>{Number(point.nCensored ?? 0)}</td></tr>)}</tbody>
    </table>
  </div>;
}

export function FishSurvivalChart({ points, thai = false, comparison = "overall" }: { points: ApiItem[]; thai?: boolean; comparison?: Stage2Comparison }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [activePoints, setActivePoints] = useState<Record<string, number>>({});
  if (points.length === 0) return null;
  const width = 620;
  const height = 230;
  const maxAge = Math.max(1, ...points.map((point) => Number(point.ageDays ?? 0)));
  const groups = new Map<string, ApiItem[]>();
  for (const point of points) {
    const key = fishComparisonValue(point, comparison);
    groups.set(key, [...(groups.get(key) ?? []), point]);
  }
  const series = [...groups.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const shown = series.slice(0, 4);
  const plotTop = 18;
  const plotBottom = height - 48;
  const x = (age: number) => 54 + age / maxAge * (width - 76);
  const y = (survival: number) => plotBottom - Math.max(0, Math.min(1, survival)) * (plotBottom - plotTop);
  return <div className="chart-block">
    <div className="chart-legend" aria-label={thai ? "เลือกกลุ่มปลาที่ต้องการแสดง" : "Toggle fish survival series"}>
      {shown.map(([label], index) => {
        const key = label;
        const { color, dash } = chartPalette(index);
        return <button type="button" key={key} aria-pressed={!hidden.has(key)} className="chart-legend__item" onClick={() => setHidden((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })}><svg className="chart-legend__swatch" viewBox="0 0 18 6" aria-hidden="true"><line x1="1" y1="3" x2="17" y2="3" stroke={color} strokeDasharray={dash} strokeWidth="2" /></svg>{label}</button>;
      })}
    </div>
    <svg className="chart chart--survival" role="group" aria-label={thai ? "กราฟ Kaplan–Meier อัตรารอดของปลาตามอายุ" : "Kaplan-Meier fish survival step chart by age"} viewBox={`0 0 ${width} ${height}`}>
      <ChartAxis width={width} height={height} min={0} max={maxAge} xLabel={thai ? "อายุ (วัน)" : "Age (days)"} thai={thai} />
      {shown.map(([label, groupPoints], index) => {
        const key = label;
        const { color, dash } = chartPalette(index);
        const sorted = [...groupPoints].sort((left, right) => Number(left.ageDays ?? 0) - Number(right.ageDays ?? 0));
        const last = sorted.at(-1);
        const activePoint = Math.min(activePoints[key] ?? 0, Math.max(0, sorted.length - 1));
        return hidden.has(key) ? null : <g key={key}>
          {comparison === "overall" && <path className="chart-ci" d={ciBandPath(groupPoints, x, y)} fill={color} opacity=".13" aria-label={thai ? `ช่วงความเชื่อมั่น 95% ${label}` : `95% confidence interval for ${label}`} />}
          <path className="chart-line" d={stepPath(groupPoints, (value) => x(value), y, "surv", "ageDays")} fill="none" stroke={color} strokeDasharray={dash} strokeWidth="2.5" />
          <g data-chart-series={key}>
          {sorted.map((point, pointIndex) => <g key={`${key}-${point.ageDays}-${pointIndex}`}>
            <circle className="chart-point" cx={x(Number(point.ageDays ?? 0))} cy={y(Number(point.surv ?? 0))} r="4" fill={color} tabIndex={activePoint === pointIndex ? 0 : -1} role="img" aria-label={fishPointLabel(point, label, thai)} onFocus={() => setActivePoints((current) => ({ ...current, [key]: pointIndex }))} onKeyDown={(event) => chartPointKeyDown(event, pointIndex, sorted.length, (next) => setActivePoints((current) => ({ ...current, [key]: next })))}><title>{fishPointLabel(point, label, thai)}</title></circle>
            {Number(point.nCensored ?? 0) > 0 && <line className="chart-censor" x1={x(Number(point.ageDays ?? 0))} y1={y(Number(point.surv ?? 0)) - 7} x2={x(Number(point.ageDays ?? 0))} y2={y(Number(point.surv ?? 0)) + 7} stroke={color} strokeWidth="2"><title>{thai ? `censored ${Number(point.nCensored)}` : `${Number(point.nCensored)} censored`}</title></line>}
            {Number(point.nEvents ?? 0) > 0 && <circle className="chart-event" cx={x(Number(point.ageDays ?? 0))} cy={y(Number(point.surv ?? 0))} r="7" fill="none" stroke={color} strokeWidth="2"><title>{thai ? `เหตุการณ์ ${Number(point.nEvents)}` : `${Number(point.nEvents)} death events`}</title></circle>}
          </g>)}
          </g>
          {last && <text className="chart-end-label" x={width - 24} y={y(Number(last.surv ?? 0)) - 6} fill={color} textAnchor="end">{label}</text>}
        </g>;
      })}
    </svg>
    <p className="chart-summary" role="status">{thai ? `${shown.length} เส้น Kaplan–Meier แสดงตาม${comparison === "overall" ? "ภาพรวม" : comparison === "abnormalityGroup" ? "กลุ่มความผิดปกติ" : comparison === "strain" ? "สายพันธุ์" : "กลุ่มทดลอง"}; ขีดแนวตั้งคือ censored และวงกลมคือเหตุการณ์` : `${shown.length} Kaplan-Meier series shown by ${comparison === "overall" ? "overall" : comparison === "abnormalityGroup" ? "abnormality group" : comparison === "strain" ? "strain" : "treatment"}; vertical marks are censored and rings are events.`}</p>
    <FishRiskSummary points={shown.flatMap(([, groupPoints]) => groupPoints)} comparison={comparison} thai={thai} />
    {comparison !== "overall" && <p className="chart-limit-note">{thai ? "ไม่แสดงแถบ CI เพื่อให้กราฟเปรียบเทียบอ่านง่าย; ดูค่า CI ในตารางประกอบ" : "CI bands are suppressed for comparison readability; the supporting table contains CI values."}</p>}
    {series.length > shown.length && <p className="chart-limit-note" role="status">{thai ? `แสดง 4 จาก ${series.length} กลุ่ม ดูข้อมูลทั้งหมดในตารางประกอบ` : `Showing 4 of ${series.length} groups; the supporting table below contains every group.`}</p>}
  </div>;
}

function BarSummary({ points, label, value }: { points: ApiItem[]; label: (point: ApiItem) => string; value: (point: ApiItem) => number }) {
  const max = Math.max(1, ...points.map(value))
  return <div className="bar-summary" role="img" aria-label={points.map((point) => `${label(point)} ${value(point)}`).join(', ')}>{points.map((point, index) => <div className="bar-summary__row" key={`${label(point)}-${index}`}><span>{label(point)}</span><span className="bar-summary__track" aria-hidden="true"><span style={{ width: `${Math.max(2, value(point) / max * 100)}%` }} /></span><strong>{value(point).toLocaleString()}</strong></div>)}</div>
}

function pipelineStepLabel(step: unknown, thai: boolean): string {
  const labels: Record<string, string> = {
    Activated: thai ? "เริ่มติดตาม" : "Activated",
    "Reached Shield": thai ? "ถึงระยะ Shield" : "Reached Shield",
    "Reached Day 1": thai ? "ถึง Day 1" : "Reached Day 1",
    Promoted: thai ? "เลื่อนเป็นปลาโคลน" : "Promoted",
    "Alive Fish": thai ? "ปลาที่รอด" : "Alive Fish",
  };
  return labels[String(step)] ?? String(step);
}

export function PipelineSummary({ points, thai }: { points: ApiItem[]; thai: boolean }) {
  const nonMonotonic = points.some((point, index) => index > 0 && Number(point.count ?? 0) > Number(points[index - 1].count ?? 0));
  const bottleneck = !nonMonotonic ? points.slice(1).filter((point) => point.pctOfPrevious != null).reduce<ApiItem | undefined>((lowest, point) => !lowest || Number(point.pctOfPrevious) < Number(lowest.pctOfPrevious) ? point : lowest, undefined) : undefined;
  const max = Math.max(1, ...points.map((point) => Number(point.count ?? 0)));
  return <div className="pipeline-summary" role="group" aria-label={thai ? "จำนวนและร้อยละของแต่ละขั้นตอนในกระบวนการ" : "Pipeline counts and percentages by step"}>
    {points.map((point) => {
      const count = Number(point.count ?? 0);
      const previous = point.pctOfPrevious == null ? "—" : `${(Number(point.pctOfPrevious) * 100).toFixed(1)}%`;
      const start = point.pctOfStart == null ? "—" : `${(Number(point.pctOfStart) * 100).toFixed(1)}%`;
      return <div className="pipeline-summary__row" key={String(point.step)}>
        <span className="pipeline-summary__label">{pipelineStepLabel(point.step, thai)}</span>
        <span className="pipeline-summary__track" aria-hidden="true"><span style={{ width: `${count / max * 100}%` }} /></span>
        <strong>{count.toLocaleString()}</strong>
        <span className="pipeline-summary__percent">{thai ? `จากก่อนหน้า ${previous} · จากเริ่มต้น ${start}` : `${previous} previous · ${start} activated`}</span>
      </div>;
    })}
    {bottleneck && <p className="insight-strip">{thai ? `คอขวดของกระบวนการคือ ${pipelineStepLabel(bottleneck.step, thai)} (${bottleneck.pctOfPrevious == null ? "—" : `${(Number(bottleneck.pctOfPrevious) * 100).toFixed(1)}% จากขั้นก่อนหน้า`})` : `Bottleneck: ${pipelineStepLabel(bottleneck.step, thai)} (${bottleneck.pctOfPrevious == null ? "—" : `${(Number(bottleneck.pctOfPrevious) * 100).toFixed(1)}% of previous step`}).`}</p>}
    {nonMonotonic && <p className="table-note" role="status">{thai ? "คุณภาพข้อมูล: จำนวนขั้นตอนถัดไปสูงกว่าขั้นก่อนหน้า จึงไม่สรุปเป็นอัตราการเปลี่ยนผ่านที่เชื่อถือได้" : "Data quality: a downstream count exceeds its upstream count, so conversion percentages should be interpreted cautiously."}</p>}
  </div>;
}

function TabMetrics({ tab, stage1, stage2, pipeline, thai }: { tab: DashboardTab; stage1?: ApiItem; stage2?: ApiItem; pipeline: ApiItem[]; thai: boolean }) {
  const alivePromoted = pipeline.find((point) => point.step === "Alive Fish")?.count;
  const metrics = tab === "stage1"
    ? [
        [thai ? "ตัวอ่อนที่เริ่มติดตาม" : "Activated embryos", Number(stage1?.nActivated ?? 0)],
        [thai ? "ถึงระยะ Shield" : "Reached Shield", Number(stage1?.nReachedShield ?? 0)],
        [thai ? "ถึง Day 1" : "Reached Day 1", Number(stage1?.nReachedDay1 ?? 0)],
        [thai ? "เลื่อนเป็นปลาโคลน" : "Promoted fish", Number(stage1?.nPromoted ?? 0)],
      ]
    : tab === "stage2"
      ? [
          [thai ? "ปลาทั้งหมดในทะเบียน" : "All fish in registry", Number(stage2?.nFish ?? 0)],
          [thai ? "ปลาที่ยังอยู่ในทะเบียน" : "Alive fish in registry", Number(stage2?.nAlive ?? 0)],
          [thai ? "ปลาที่ตาย" : "Dead fish", Number(stage2?.nDead ?? 0)],
          [thai ? "แช่แข็งหรือคัดออก" : "Frozen or discarded", Number(stage2?.nFrozen ?? 0) + Number(stage2?.nDiscarded ?? 0)],
        ]
      : [
          [thai ? "ตัวอ่อนที่เริ่มติดตาม" : "Activated embryos", Number(stage1?.nActivated ?? 0)],
          [thai ? "เลื่อนเป็นปลาโคลน" : "Promoted fish", Number(stage1?.nPromoted ?? 0)],
          [thai ? "ปลาที่รอดจากตัวอ่อนที่เลื่อนขั้น" : "Alive promoted fish", Number(alivePromoted ?? 0)],
          [thai ? "รอบทดลองในขอบเขต" : "Batches in scope", Number(stage1?.nBatches ?? 0)],
        ];
  return <div className="metric-grid metric-grid--tab">{metrics.map(([label, value]) => <Metric key={String(label)} label={String(label)} value={value as number} />)}</div>;
}

function ObservationGapSummary({ gaps, meta, thai, loading, onNavigate }: { gaps: ApiItem[]; meta: AnalyticsMeta | null; thai: boolean; loading: boolean; onNavigate: (page: Page) => void }) {
  const count = gaps.length;
  const missing = meta?.missing?.observation ?? 0;
  if (loading) {
    return <section className="data-quality-alert data-quality-alert--ok" aria-label={thai ? "กำลังตรวจคุณภาพข้อมูลการติดตามปลา" : "Checking fish follow-up data quality"}><div className="data-quality-alert__icon" aria-hidden="true">…</div><div><h2>{thai ? "กำลังตรวจช่วงขาดการติดตาม" : "Checking follow-up coverage"}</h2><p>{thai ? "กำลังโหลดข้อมูลการตรวจปลาล่าสุด" : "Loading the latest fish checks for this filter."}</p></div></section>;
  }
  return (
    <section className={count ? "data-quality-alert" : "data-quality-alert data-quality-alert--ok"} aria-label={thai ? "คุณภาพข้อมูลการติดตามปลา" : "Fish follow-up data quality"}>
      <div className="data-quality-alert__icon" aria-hidden="true">{count ? "!" : "✓"}</div>
      <div>
        <h2>{count ? (thai ? `พบปลาขาดการติดตาม ${count} ตัว` : `${count} fish need a follow-up check`) : (thai ? "ไม่พบช่วงขาดการติดตาม" : "No follow-up gaps found")}</h2>
        <p>{count
          ? (thai ? `ข้อมูลสรุปมีปลาที่ยังอยู่แต่ขาดการตรวจ ${missing ? `และไม่มีผลตรวจเลย ${missing} ตัว` : ""}` : `The filtered set has ${count} active fish with a missed check${missing ? `; ${missing} have no observation yet` : ""}.`)
          : (thai ? "ชุดข้อมูลที่กรองมีประวัติการติดตามเพียงพอสำหรับวันนี้" : "The filtered set has current follow-up coverage.")}</p>
        {count > 0 && <button type="button" className="inline-action" onClick={() => onNavigate("fish")}>{thai ? "ไปตรวจปลาประจำวัน" : "Open daily fish check"}</button>}
      </div>
    </section>
  );
}

export function Dashboard({
  onNavigate,
  t,
}: {
  onNavigate: (page: Page) => void;
  t: AppText;
}) {
  const options = useDashboardMasterOptions();
  const [filters, setFilters] = useState<DashboardFilters>(() =>
    analyticsFilters(parseFilters()),
  );
  const [tab, setTab] = useState<DashboardTab>(() => parseDashboardTab());
  const [stage1Comparison, setStage1Comparison] = useState<Stage1Comparison>("strain");
  const [stage2Comparison, setStage2Comparison] = useState<Stage2Comparison>("overall");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DashboardData>({
    reportMeta: null,
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
    void get(dashboardDataPath(filters, stage1Comparison, stage2Comparison))
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
          reportMeta: (bundle.reportMeta as ApiItem | undefined) ?? null,
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
  }, [filters, stage1Comparison, stage2Comparison]);
  useEffect(() => {
    updateDashboardURL(filters, tab);
  }, [filters, tab]);
  useEffect(() => {
    load();
  }, [filters, load]);
  useEffect(() => {
    const onPopState = () => {
      setFilters(analyticsFilters(parseFilters()));
      setTab(parseDashboardTab());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const changeFilters = (next: DashboardFilters) => {
    setFilters(analyticsFilters(next));
  };
  const openSource = (page: Page) => {
    updateDashboardURL(filters, tab);
    onNavigate(page);
  };
  const stage1 = data.kpi?.stage1 as ApiItem | undefined;
  const stage2 = data.kpi?.stage2 as ApiItem | undefined;
  const comparison = (stage1?.controlComparison as ApiItem[] | undefined) ?? [];
  const thai = t === text.th;
  const lowestEmbryoSurvival = data.survival.reduce<ApiItem | undefined>((lowest, point) => !lowest || Number(point.surv ?? 1) < Number(lowest.surv ?? 1) ? point : lowest, undefined);
  const lossRate = (point: ApiItem): number => Number(point.riskSet ?? 0) > 0 ? Number(point.nDead ?? 0) / Number(point.riskSet) : -1;
  const highestEmbryoLoss = data.funnel.reduce<ApiItem | undefined>((highest, point) => !highest || lossRate(point) > lossRate(highest) || lossRate(point) === lossRate(highest) && Number(point.nDead ?? 0) > Number(highest.nDead ?? 0) ? point : highest, undefined);
  const lowestFishSurvival = data.fishSurvival.reduce<ApiItem | undefined>((lowest, point) => !lowest || Number(point.surv ?? 1) < Number(lowest.surv ?? 1) ? point : lowest, undefined);
  const stage1SeriesSamples = initialSeriesSamples(data.survival, (point) => `${String(point.site ?? point.siteId ?? "All sites")} · ${stageComparisonValue(point, stage1Comparison, options.operators)}`, "stageOrder", "riskSet");
  const stage1SmallSeries = smallSeriesMessage(stage1SeriesSamples, thai);
  const fishSeriesSamples = initialSeriesSamples(data.fishSurvival, (point) => fishComparisonValue(point, stage2Comparison), "ageDays", "atRisk");
  const fishSmallSeries = smallSeriesMessage(fishSeriesSamples, thai);
  const lowestEmbryoGroup = lowestEmbryoSurvival ? stageComparisonValue(lowestEmbryoSurvival, stage1Comparison, options.operators) : "All";
  const lowestFishGroup = lowestFishSurvival ? fishComparisonValue(lowestFishSurvival, stage2Comparison) : "Overall";
  const embryoHeadlineReady = Number(data.survivalMeta?.sampleSize ?? 0) >= 5 && Number(lowestEmbryoSurvival?.riskSet ?? 0) >= 5;
  const attritionHeadlineReady = Number(data.funnelMeta?.sampleSize ?? 0) >= 5 && Number(highestEmbryoLoss?.riskSet ?? 0) >= 5;
  const fishHeadlineReady = Number(data.fishSurvivalMeta?.sampleSize ?? 0) >= 5 && Number(lowestFishSurvival?.atRisk ?? 0) >= 5;
  const selectTab = (nextTab: DashboardTab) => {
    if (nextTab === tab) return;
    pushDashboardTab(filters, nextTab);
    setTab(nextTab);
  };
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? dashboardTabs.length - 1 : (dashboardTabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + dashboardTabs.length) % dashboardTabs.length
    const nextTab = dashboardTabs[index];
    selectTab(nextTab);
    requestAnimationFrame(() => document.getElementById(`dashboard-tab-${nextTab}`)?.focus());
  }
  const editFilters = () => {
    const disclosure = document.getElementById("dashboard-filter-disclosure") as HTMLDetailsElement | null;
    disclosure?.setAttribute("open", "");
    requestAnimationFrame(() => document.getElementById("dashboard-filter-summary")?.focus());
  };
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
      <ScopeBar filters={filters} options={options} reportMeta={data.reportMeta} thai={thai} onClear={() => changeFilters({})} onEdit={editFilters} />
      <FilterBar filters={filters} onChange={changeFilters} options={options} t={t} />
      {loading && <p className="table-note dashboard-status" role="status">{thai ? "กำลังคำนวณภาพรวม…" : "Loading dashboard analytics…"}</p>}
      {error && <ErrorMessage message={error} />}
      <div className="tabs" role="tablist" aria-label={thai ? "ช่วงของผลการทดลอง" : "Dashboard stage"}>
        <button
          id="dashboard-tab-stage1"
          role="tab"
          aria-controls="dashboard-panel-stage1"
          aria-selected={tab === "stage1"}
          tabIndex={tab === 'stage1' ? 0 : -1}
          className={tab === "stage1" ? "tab tab--active" : "tab"}
          onClick={() => selectTab("stage1")}
          onKeyDown={moveTab}
        >
          {thai ? "ระยะตัวอ่อน" : "Stage 1"}
        </button>
        <button
          id="dashboard-tab-stage2"
          role="tab"
          aria-controls="dashboard-panel-stage2"
          aria-selected={tab === "stage2"}
          tabIndex={tab === 'stage2' ? 0 : -1}
          className={tab === "stage2" ? "tab tab--active" : "tab"}
          onClick={() => selectTab("stage2")}
          onKeyDown={moveTab}
        >
          {thai ? "ระยะปลา" : "Stage 2"}
        </button>
        <button
          id="dashboard-tab-overall"
          role="tab"
          aria-controls="dashboard-panel-overall"
          aria-selected={tab === "overall"}
          tabIndex={tab === 'overall' ? 0 : -1}
          className={tab === "overall" ? "tab tab--active" : "tab"}
          onClick={() => selectTab("overall")}
          onKeyDown={moveTab}
        >
          {thai ? "ภาพรวมกระบวนการ" : "Overview"}
        </button>
      </div>
      {tab === "stage1" && (
        <div id="dashboard-panel-stage1" role="tabpanel" aria-labelledby="dashboard-tab-stage1">
          {data.kpi && !loading && <TabMetrics tab="stage1" stage1={stage1} stage2={stage2} pipeline={data.pipeline} thai={thai} />}
          <ReportPanel title={thai ? "การรอดของตัวอ่อนตามระยะ" : "Stage 1 survival curve"} loading={loading} empty={data.survival.length === 0} emptyMessage={thai ? "ยังไม่มีข้อมูลการรอดที่ตรงกับตัวกรอง" : "No survival observations match these filters."} sampleSize={data.survivalMeta?.sampleSize} quality={<QualityNote meta={data.survivalMeta} thai={thai} />}>
            {!embryoHeadlineReady
              ? <p className="small-n-note" role="status">{Number(data.survivalMeta?.sampleSize ?? 0) < 5
                ? (thai ? `ข้อมูลเชิงสำรวจเท่านั้น: n=${Number(data.survivalMeta?.sampleSize ?? 0)} ยังไม่สรุปว่าอัตรารอดต่ำสุดหรือดีที่สุด` : `Exploratory data only: n=${Number(data.survivalMeta?.sampleSize ?? 0)}; no lowest/best survival headline is reported.`)
                : (thai ? `ไม่แสดงการจัดอันดับ: จุดที่อัตรารอดต่ำสุดมีกลุ่มเสี่ยง n=${Number(lowestEmbryoSurvival?.riskSet ?? 0)} (<5)` : `No lowest/best survival headline: the candidate checkpoint has risk set n=${Number(lowestEmbryoSurvival?.riskSet ?? 0)} (<5).`)}</p>
              : <p className="insight-strip">{thai ? `อัตรารอดต่ำสุดในข้อมูลที่กรองคือ ${percent(lowestEmbryoSurvival?.surv)} ที่ระยะ ${String(lowestEmbryoSurvival?.stageLabel ?? lowestEmbryoSurvival?.stageOrder)} · ${lowestEmbryoGroup} (n=${Number(lowestEmbryoSurvival?.riskSet ?? 0)})` : `Lowest filtered survival is ${percent(lowestEmbryoSurvival?.surv)} at ${String(lowestEmbryoSurvival?.stageLabel ?? lowestEmbryoSurvival?.stageOrder)} · ${lowestEmbryoGroup} (n=${Number(lowestEmbryoSurvival?.riskSet ?? 0)}).`}</p>}
            {stage1SmallSeries && <p className="small-n-note" role="status">{stage1SmallSeries}</p>}
            <ComparisonControl kind="stage1" value={stage1Comparison} onChange={(value) => setStage1Comparison(value as Stage1Comparison)} thai={thai} />
            <SurvivalChart points={data.survival} thai={thai} comparison={stage1Comparison} operators={options.operators} />
            <ReportTable
              collapsed summary={thai ? "ดูตารางข้อมูลและแหล่งที่มา" : "View supporting data"}
              caption={thai ? `การรอดของตัวอ่อนแยกตาม${stageComparisonLabel(stage1Comparison, thai)} และระยะ` : `Stage 1 survival by ${stageComparisonLabel(stage1Comparison, thai).toLowerCase()} and checkpoint`}
              headers={[
                 thai ? "สถานที่" : "Site",
                 stageComparisonLabel(stage1Comparison, thai),
                thai ? "ระยะ" : "Stage",
                thai ? "จำนวนตั้งต้น" : "Risk set",
                thai ? "รอด" : "Alive",
                thai ? "อัตรารอด" : "Survival",
              ]}
              rows={data.survival.map((point) => [
                String(point.site ?? "All"),
                stageComparisonValue(point, stage1Comparison, options.operators),
                String(point.stageLabel ?? point.stageOrder),
                Number(point.riskSet ?? 0),
                Number(point.alive ?? 0),
                point.surv == null ? "Unknown" : Number(point.surv).toFixed(4),
              ])}
            />
            <p className="table-note">{thai ? "ตรวจข้อมูลต้นทาง:" : "Source records:"} <button type="button" className="inline-action" onClick={() => openSource("batches")}>{thai ? "เปิดการทดลองตามตัวกรอง" : "Open filtered batches"}</button><button type="button" className="inline-action" onClick={() => openSource("due")}>{thai ? "เปิดผลตรวจตัวอ่อน" : "Open embryo checkpoints"}</button></p>
          </ReportPanel>
          <ReportPanel title={thai ? "ระยะที่สูญเสียและเริ่มพบความผิดปกติ" : "Attrition / abnormality onset"} loading={loading} empty={data.funnelMeta?.sampleSize === 0 && data.abnormality.length === 0} emptyMessage={thai ? "ยังไม่มีข้อมูลความสูญเสียที่ตรงกับตัวกรอง" : "No attrition or abnormality observations match these filters."} sampleSize={data.funnelMeta?.sampleSize} quality={<QualityNote meta={data.funnelMeta} thai={thai} />}>
            {!attritionHeadlineReady
              ? <p className="small-n-note" role="status">{Number(data.funnelMeta?.sampleSize ?? 0) < 5
                ? (thai ? `ข้อมูลเชิงสำรวจเท่านั้น: n=${Number(data.funnelMeta?.sampleSize ?? 0)} ไม่จัดอันดับระยะที่สูญเสียมากที่สุด` : `Exploratory data only: n=${Number(data.funnelMeta?.sampleSize ?? 0)}; no highest-loss ranking is reported.`)
                : (thai ? `ไม่แสดงการจัดอันดับ: จุดที่มีอัตราสูญเสียสูงสุดมีกลุ่มเสี่ยง n=${Number(highestEmbryoLoss?.riskSet ?? 0)} (<5)` : `No highest-loss ranking: the candidate checkpoint has risk set n=${Number(highestEmbryoLoss?.riskSet ?? 0)} (<5).`)}</p>
              : <p className="insight-strip">{thai ? `ระยะที่สูญเสียมากที่สุดคือ ${String(highestEmbryoLoss?.stageLabel ?? highestEmbryoLoss?.stageOrder)} จำนวน ${Number(highestEmbryoLoss?.nDead ?? 0)} จาก ${Number(highestEmbryoLoss?.riskSet ?? 0)} ฟอง` : `Highest loss occurs at ${String(highestEmbryoLoss?.stageLabel ?? highestEmbryoLoss?.stageOrder)}: ${Number(highestEmbryoLoss?.nDead ?? 0)} of ${Number(highestEmbryoLoss?.riskSet ?? 0)} embryos.`}</p>}
            <FunnelChart points={data.funnel} thai={thai} />
            <AbnormalityOnsetChart points={data.abnormality} meta={data.abnormalityMeta} thai={thai} />
            <ReportTable
              collapsed summary={thai ? "ดูอันดับการสูญเสีย" : "View attrition ranking"}
              caption={thai ? "อันดับการสูญเสียแยกตามระยะ" : "Attrition ranking by checkpoint"}
              headers={thai ? ["อันดับ", "ระยะ", "กลุ่มเสี่ยง", "สูญเสีย (n)", "อัตราสูญเสีย"] : ["Rank", "Stage", "At risk", "Dead (n)", "Loss rate"]}
              rows={[...data.funnel]
                .sort((left, right) => {
                  const leftRate = Number(left.riskSet ?? 0) ? Number(left.nDead ?? 0) / Number(left.riskSet) : -1;
                  const rightRate = Number(right.riskSet ?? 0) ? Number(right.nDead ?? 0) / Number(right.riskSet) : -1;
                  return rightRate - leftRate || Number(right.nDead ?? 0) - Number(left.nDead ?? 0);
                })
                .map((point, index) => [
                  index + 1,
                  String(point.stageLabel ?? point.stageOrder),
                  Number(point.riskSet ?? 0),
                  Number(point.nDead ?? 0),
                  percent(Number(point.riskSet ?? 0) ? Number(point.nDead ?? 0) / Number(point.riskSet) : null),
                ])}
            />
            <ReportTable
              collapsed summary={thai ? "ดูระยะที่เริ่มพบความผิดปกติ" : "View abnormality onset"}
              caption={thai ? "ระยะที่เริ่มพบความผิดปกติ" : "Abnormality onset by checkpoint"}
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
            <p className="insight-strip">{thai ? "ค่าใกล้ศูนย์หมายถึงเวลาใกล้มาตรฐาน ค่าบวกคือช้ากว่า และค่าลบคือเร็วกว่ามาตรฐาน" : "Values near zero match the timing standard; positive values are later and negative values are earlier."}</p>
            <ReportTable
              collapsed summary={thai ? "ดูค่ารายกลุ่ม" : "View group values"}
              caption={thai ? "เวลาเบี่ยงเบนแยกตามระยะและกลุ่ม" : "Timing deviation by checkpoint and group"}
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
              caption={thai ? "เปรียบเทียบ SCNT และกลุ่มควบคุม" : "SCNT and control-arm comparison"}
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
        </div>
      )}
      {tab === "stage2" && (
        <div id="dashboard-panel-stage2" role="tabpanel" aria-labelledby="dashboard-tab-stage2">
          {data.kpi && !loading && <TabMetrics tab="stage2" stage1={stage1} stage2={stage2} pipeline={data.pipeline} thai={thai} />}
          <ReportPanel title={thai ? "การรอดของปลาตามอายุ" : "Fish survival by age"} loading={loading} empty={data.fishSurvival.length === 0} emptyMessage={thai ? "ยังไม่มีข้อมูลการรอดของปลาที่ตรงกับตัวกรอง" : "No fish survival observations match these filters."} sampleSize={data.fishSurvivalMeta?.sampleSize} quality={<QualityNote meta={data.fishSurvivalMeta} thai={thai} />}>
            {!fishHeadlineReady
              ? <p className="small-n-note" role="status">{Number(data.fishSurvivalMeta?.sampleSize ?? 0) < 5
                ? (thai ? `ข้อมูลเชิงสำรวจเท่านั้น: n=${Number(data.fishSurvivalMeta?.sampleSize ?? 0)} ยังไม่สรุปว่าอัตรารอดต่ำสุดหรือดีที่สุด` : `Exploratory data only: n=${Number(data.fishSurvivalMeta?.sampleSize ?? 0)}; no lowest/best fish-survival headline is reported.`)
                : (thai ? `ไม่แสดงการจัดอันดับ: จุดที่อัตรารอดต่ำสุดมีกลุ่มเสี่ยง n=${Number(lowestFishSurvival?.atRisk ?? 0)} (<5)` : `No lowest/best fish-survival headline: the candidate age has at-risk n=${Number(lowestFishSurvival?.atRisk ?? 0)} (<5).`)}</p>
              : <p className="insight-strip">{thai ? `อัตรารอดของปลาต่ำสุดในข้อมูลที่กรองคือ ${percent(lowestFishSurvival?.surv)} เมื่ออายุ ${Number(lowestFishSurvival?.ageDays ?? 0)} วัน · ${lowestFishGroup} (n=${Number(lowestFishSurvival?.atRisk ?? 0)})` : `Lowest filtered fish survival is ${percent(lowestFishSurvival?.surv)} at age ${Number(lowestFishSurvival?.ageDays ?? 0)} days · ${lowestFishGroup} (n=${Number(lowestFishSurvival?.atRisk ?? 0)}).`}</p>}
            {fishSmallSeries && <p className="small-n-note" role="status">{fishSmallSeries}</p>}
            <ComparisonControl kind="stage2" value={stage2Comparison} onChange={(value) => setStage2Comparison(value as Stage2Comparison)} thai={thai} />
            {stage2Comparison === "abnormalityGroup" && <p className="comparison-note" role="note">{thai ? "Ever abnormal เทียบกับไม่เคยบันทึกความผิดปกติ เป็นการเปรียบเทียบเชิงสำรวจ ไม่ใช่เหตุผลเชิงสาเหตุ" : "Ever abnormal vs No abnormality recorded is an exploratory comparison, not a causal estimate."}</p>}
            <FishSurvivalChart points={data.fishSurvival} thai={thai} comparison={stage2Comparison} />
            <ReportTable
              collapsed summary={thai ? "ดูข้อมูลการรอดรายอายุ" : "View survival data by age"}
              caption={thai ? `การรอดของปลาแยกตาม${fishComparisonLabel(stage2Comparison, thai)} และอายุ` : `Fish survival by ${fishComparisonLabel(stage2Comparison, thai).toLowerCase()} and age`}
              headers={thai ? [fishComparisonLabel(stage2Comparison, thai), "อายุ (วัน)", "เสี่ยง", "เหตุการณ์ตาย", "censored", "อัตรารอด", "CI 95%"] : [fishComparisonLabel(stage2Comparison, thai), "Age day", "At risk", "Death events", "Censored", "Kaplan-Meier survival", "95% CI"]}
              rows={data.fishSurvival.map((point) => [
                fishComparisonValue(point, stage2Comparison),
                Number(point.ageDays ?? 0),
                Number(point.atRisk ?? 0),
                Number(point.nEvents ?? 0),
                Number(point.nCensored ?? 0),
                point.surv == null ? "Unknown" : Number(point.surv).toFixed(4),
                point.survLower95 == null || point.survUpper95 == null ? "—" : `${Number(point.survLower95).toFixed(3)}–${Number(point.survUpper95).toFixed(3)}`,
              ])}
            />
            <p className="table-note">{thai ? "ตรวจข้อมูลต้นทาง:" : "Source records:"} <button type="button" className="inline-action" onClick={() => openSource("fish")}>{thai ? "เปิดทะเบียนปลาตามตัวกรอง" : "Open filtered fish registry"}</button></p>
          </ReportPanel>
          <ObservationGapSummary gaps={data.gaps} meta={data.gapsMeta} thai={thai} loading={loading} onNavigate={onNavigate} />
        </div>
      )}
      {tab === "overall" && (
        <div id="dashboard-panel-overall" role="tabpanel" aria-labelledby="dashboard-tab-overall">
          {data.kpi && !loading && <TabMetrics tab="overall" stage1={stage1} stage2={stage2} pipeline={data.pipeline} thai={thai} />}
          <ReportPanel title={thai ? "ผลลัพธ์ตลอดกระบวนการ" : "Pipeline conversion"} loading={loading} empty={data.pipelineMeta?.sampleSize === 0} emptyMessage={thai ? "ยังไม่มีข้อมูลกระบวนการที่ตรงกับตัวกรอง" : "No pipeline records match these filters."} sampleSize={data.pipelineMeta?.sampleSize} quality={<QualityNote meta={data.pipelineMeta} thai={thai} />}>
            <PipelineSummary points={data.pipeline} thai={thai} />
            <ReportTable
              collapsed summary={thai ? "ดูอัตราเปลี่ยนผ่านทุกขั้น" : "View conversion by step"}
              caption={thai ? "อัตราการเปลี่ยนผ่านตลอดกระบวนการ" : "End-to-end pipeline conversion"}
              headers={thai ? ["ขั้นตอน", "จำนวน", "% จากขั้นก่อน", "% จากตัวอ่อนที่กระตุ้น"] : ["Step", "n", "% previous", "% activated"]}
              rows={data.pipeline.map((point) => [
                pipelineStepLabel(point.step, thai),
                Number(point.count ?? 0),
                percent(point.pctOfPrevious),
                percent(point.pctOfStart),
              ])}
            />
            <p className="table-note">{thai ? "ตรวจข้อมูลต้นทาง:" : "Source records:"} <button type="button" className="inline-action" onClick={() => openSource("batches")}>{thai ? "เปิดการทดลอง" : "Open batches"}</button><button type="button" className="inline-action" onClick={() => openSource("fish")}>{thai ? "เปิดทะเบียนปลา" : "Open fish registry"}</button></p>
          </ReportPanel>
        </div>
      )}
      {data.kpi == null && !loading && (
        <NoData message="Dashboard is empty. Create a batch and record observations to see panels." />
      )}
    </section>
  );
}
