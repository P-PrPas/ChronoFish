import { useCallback, useEffect, useState } from "react";
import { type ApiItem, get } from "../api/client";
import {
  type DashboardFilters,
  parseFilters,
  updateFilterURL,
  withFilters,
} from "../filters";
import { type AppText, type Page } from "../types";
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

function percent(value: unknown): string {
  return value == null ? "Unknown" : `${(Number(value) * 100).toFixed(2)}%`;
}

function QualityNote({ meta }: { meta: AnalyticsMeta | null }) {
  if (!meta) return null;
  const unknown = Object.entries(meta.unknown ?? {}).map(([key, value]) => `${key}: ${value}`);
  const missing = Object.entries(meta.missing ?? {}).map(([key, value]) => `${key}: ${value}`);
  if (unknown.length === 0 && missing.length === 0) return null;
  return <p className="table-note" role="status">Data quality — unknown: {unknown.join(", ") || "none"}; missing: {missing.join(", ") || "none"}.</p>;
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
}: {
  filters: DashboardFilters;
  onChange: (filters: DashboardFilters) => void;
}) {
  const sites = useMasterOptions("sites");
  const operators = useMasterOptions("operators");
  const treatments = useMasterOptions("treatment-groups");
  const donors = useMasterOptions("donor-cell-lines");
  const batches = useMasterOptions("batches");
  const update = (key: keyof DashboardFilters, value: string) =>
    onChange({ ...filters, [key]: value || undefined });
  return (
    <fieldset className="filter-bar">
      <legend>Dashboard filters / ตัวกรอง</legend>
      <label>
        Site
        <select
          value={filters.siteId ?? ""}
          onChange={(event) => update("siteId", event.target.value)}
        >
          <option value="">All sites</option>
          {sites.map((item) => (
            <option key={String(item.id)} value={String(item.id)}>
              {String(item.name ?? item.code)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Operator
        <select
          value={filters.operatorId ?? ""}
          onChange={(event) => update("operatorId", event.target.value)}
        >
          <option value="">All operators</option>
          {operators.map((item) => (
            <option key={String(item.id)} value={String(item.id)}>
              {String(item.name)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Treatment
        <select
          value={filters.treatmentGroupId ?? ""}
          onChange={(event) => update("treatmentGroupId", event.target.value)}
        >
          <option value="">All treatments</option>
          {treatments.map((item) => (
            <option key={String(item.id)} value={String(item.id)}>
              {String(item.code ?? item.name)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Donor
        <select
          value={filters.donorCellLineId ?? ""}
          onChange={(event) => update("donorCellLineId", event.target.value)}
        >
          <option value="">All donors</option>
          {donors.map((item) => (
            <option key={String(item.id)} value={String(item.id)}>
              {String(item.strain ?? item.batchCode)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Batch
        <select
          value={filters.batchId ?? ""}
          onChange={(event) => update("batchId", event.target.value)}
        >
          <option value="">All batches</option>
          {batches.map((item) => (
            <option key={String(item.id)} value={String(item.id)}>
              {String(item.batchCode)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Strain
        <input
          value={filters.strain ?? ""}
          onChange={(event) => update("strain", event.target.value)}
          placeholder="Any strain"
        />
      </label>
      <label>
        From
        <input
          type="date"
          value={filters.dateFrom ?? ""}
          onChange={(event) => update("dateFrom", event.target.value)}
        />
      </label>
      <label>
        To
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
        Clear
      </button>
    </fieldset>
  );
}

function NoData({
  message = "No observations match these filters. Record a checkpoint or clear filters.",
}: {
  message?: string;
}) {
  return <p className="table-note">{message}</p>;
}

export function SurvivalChart({ points }: { points: ApiItem[] }) {
  if (points.length === 0) return null;
  const width = 560;
  const height = 180;
  const groups = new Map<string, ApiItem[]>();
  for (const point of points) {
    const key = `${String(point.siteId ?? "All")} / ${String(point.strain ?? "All")} / ${String(point.treatmentGroup ?? "All")}`;
    groups.set(key, [...(groups.get(key) ?? []), point]);
  }
  const colors = ["#ef9f67", "#78c7b5", "#caa7f7", "#f2d479", "#8ab6ed"];
  return (
    <svg
      className="chart"
      role="img"
      aria-label="Stage 1 survival curve"
      viewBox={`0 0 ${width} ${height}`}
    >
      <line
        x1="12"
        y1={height - 18}
        x2={width - 12}
        y2={height - 18}
        stroke="currentColor"
        opacity=".35"
      />
      {Array.from(groups.entries()).map(([key, values], groupIndex) => {
        const sorted = [...values].sort((left, right) => Number(left.stageOrder ?? 0) - Number(right.stageOrder ?? 0));
        const path = sorted.map((point, index) => `${(index / Math.max(1, sorted.length - 1)) * (width - 24) + 12},${height - 18 - Math.max(0, Math.min(1, Number(point.surv ?? 0))) * (height - 36)}`).join(" ");
        return <g key={key}><polyline fill="none" stroke={colors[groupIndex % colors.length]} strokeWidth="2.5" points={path} /><text x="18" y={16 + groupIndex * 13} fill={colors[groupIndex % colors.length]}>{key}</text></g>;
      })}
    </svg>
  );
}

export function FunnelChart({ points }: { points: ApiItem[] }) {
  if (points.length === 0) return null;
  const width = 560;
  const max = Math.max(1, ...points.map((point) => Number(point.alive ?? 0)));
  return (
    <svg
      className="chart chart--funnel"
      role="img"
      aria-label="Stage 1 attrition funnel"
      viewBox={`0 0 ${width} 180`}
    >
      {points.map((point, index) => (
        <rect
          key={String(point.stageOrder)}
          x="12"
          y={index * 6.2}
          width={(Number(point.alive ?? 0) / max) * (width - 24)}
          height="4"
          fill="currentColor"
          opacity={Math.max(0.2, 1 - index / points.length)}
        />
      ))}
    </svg>
  );
}

export function DeviationChart({ points }: { points: ApiItem[] }) {
  if (points.length === 0) return null;
  const width = 560;
  const height = 180;
  const values = points.flatMap((point) => [Number(point.minDeviationH ?? 0), Number(point.maxDeviationH ?? 0)]);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = Math.max(0.5, max - min);
  const y = (value: number) => 14 + ((max - value) / span) * (height - 34);
  const slotWidth = (width - 28) / points.length;
  const axis = y(0);
  return (
    <svg
      className="chart"
      role="img"
      aria-label="Timing deviation by stage and group"
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
      {points.map((point, index) => {
        const minimum = Number(point.minDeviationH ?? 0);
        const q1 = Number(point.q1DeviationH ?? point.medianDeviationH ?? 0);
        const median = Number(point.medianDeviationH ?? 0);
        const q3 = Number(point.q3DeviationH ?? point.medianDeviationH ?? 0);
        const maximum = Number(point.maxDeviationH ?? 0);
        const mean = Number(point.meanDeviationH ?? 0);
        const x = 14 + slotWidth * (index + 0.5);
        const boxWidth = Math.max(4, Math.min(18, slotWidth * 0.65));
        return (
          <g key={`${String(point.stageOrder)}-${String(point.treatmentGroup ?? "")}-${index}`}>
            <line x1={x} y1={y(maximum)} x2={x} y2={y(minimum)} stroke="currentColor" />
            <line x1={x - boxWidth / 3} y1={y(maximum)} x2={x + boxWidth / 3} y2={y(maximum)} stroke="currentColor" />
            <line x1={x - boxWidth / 3} y1={y(minimum)} x2={x + boxWidth / 3} y2={y(minimum)} stroke="currentColor" />
            <rect x={x - boxWidth / 2} y={y(q3)} width={boxWidth} height={Math.max(1, y(q1) - y(q3))} fill="#f2a65a" fillOpacity=".35" stroke="currentColor" />
            <line x1={x - boxWidth / 2} y1={y(median)} x2={x + boxWidth / 2} y2={y(median)} stroke="currentColor" strokeWidth="2" />
            <circle cx={x} cy={y(mean)} r="2" fill="#6dc5b0">
              <title>{`${String(point.treatmentGroup ?? point.strain ?? "All")} · ${String(point.stageLabel ?? point.stageOrder)}: median ${median.toFixed(4)} h`}</title>
            </circle>
          </g>
        );
      })}
      <text x="12" y="14">
        + late
      </text>
      <text x="12" y={height - 4}>
        − early
      </text>
    </svg>
  );
}

export function FishSurvivalChart({ points }: { points: ApiItem[] }) {
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
  return <svg className="chart" role="img" aria-label="Stage 2 survival curves by strain and treatment" viewBox={`0 0 ${width} ${height}`}>
    <line x1="18" y1={height - 22} x2={width - 12} y2={height - 22} stroke="currentColor" opacity=".35" />
    <line x1="18" y1="12" x2="18" y2={height - 22} stroke="currentColor" opacity=".35" />
    {Array.from(groups.entries()).map(([key, values], index) => {
      const sorted = [...values].sort((left, right) => Number(left.ageDays ?? 0) - Number(right.ageDays ?? 0))
      const path = sorted.map((point) => `${18 + (Number(point.ageDays ?? 0) / maxAge) * (width - 30)},${height - 22 - Math.max(0, Math.min(1, Number(point.surv ?? 0))) * (height - 36)}`).join(' ')
      return <g key={key}><polyline fill="none" stroke={colors[index % colors.length]} strokeWidth="2.5" points={path} /><text x="24" y={24 + index * 14} fill={colors[index % colors.length]}>{key}</text></g>
    })}
  </svg>
}

export function Dashboard({
  onNavigate,
  t,
}: {
  onNavigate: (page: Page) => void;
  t: AppText;
}) {
  const [filters, setFilters] = useState<DashboardFilters>(() =>
    parseFilters(),
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
  return (
    <section>
      <div className="page-heading">
        <div>
          <p className="eyebrow">SCNT / CLONE FISH</p>
          <h1>{t.dashboard}</h1>
          <p className="muted">
            Evidence from the same filtered canonical dataset used by export.
          </p>
        </div>
        <button
          className="button button--secondary"
          onClick={load}
          disabled={loading}
        >
          {loading ? "Loading..." : t.refresh}
        </button>
      </div>
      <FilterBar filters={filters} onChange={changeFilters} />
      {loading && <p className="table-note dashboard-status" role="status">Loading dashboard analytics…</p>}
      {error && <ErrorMessage message={error} />}
      {data.kpi && !loading && (
        <div className="metric-grid">
          <Metric label="Activated" value={Number(stage1?.nActivated ?? 0)} />
          <Metric label="Reached Shield" value={Number(stage1?.nReachedShield ?? 0)} />
          <Metric label="Reached Day 1" value={Number(stage1?.nReachedDay1 ?? 0)} />
          <Metric label="Promoted" value={Number(stage1?.nPromoted ?? 0)} />
          <Metric label="Normal %" value={percent(stage1?.pctNormal)} />
          <Metric label="Fish all" value={Number(stage2?.nFish ?? 0)} />
          <Metric label="Alive fish" value={Number(stage2?.nAlive ?? 0)} />
          <Metric label="Frozen" value={Number(stage2?.nFrozen ?? 0)} />
          <Metric label="Dead" value={Number(stage2?.nDead ?? 0)} />
          <Metric label="Discarded" value={Number(stage2?.nDiscarded ?? 0)} />
          <Metric label="Normal" value={Number(stage2?.nNormal ?? 0)} />
          <Metric label="Abnormal" value={Number(stage2?.nAbnormal ?? 0)} />
          <Metric
            label="Mean age (alive)"
            value={stage2?.meanAgeDaysAlive == null ? "Unknown" : Number(stage2.meanAgeDaysAlive)}
          />
        </div>
      )}
      <div className="tabs" role="tablist" aria-label="Dashboard stage">
        <button
          role="tab"
          aria-selected={tab === "stage1"}
          className={tab === "stage1" ? "tab tab--active" : "tab"}
          onClick={() => setTab("stage1")}
        >
          Stage 1
        </button>
        <button
          role="tab"
          aria-selected={tab === "stage2"}
          className={tab === "stage2" ? "tab tab--active" : "tab"}
          onClick={() => setTab("stage2")}
        >
          Stage 2
        </button>
        <button
          role="tab"
          aria-selected={tab === "overall"}
          className={tab === "overall" ? "tab tab--active" : "tab"}
          onClick={() => setTab("overall")}
        >
          Overview
        </button>
      </div>
      {tab === "stage1" && (
        <>
          <ReportPanel title="Stage 1 survival curve" loading={loading} empty={data.survival.length === 0} emptyMessage="No survival observations match these filters." sampleSize={data.survivalMeta?.sampleSize} quality={<QualityNote meta={data.survivalMeta} />}>
            <SurvivalChart points={data.survival} />
            <ReportTable
              caption="Stage 1 survival by checkpoint"
              headers={[
                "Site",
                "Strain",
                "Treatment",
                "Stage",
                "Risk set",
                "Alive",
                "Survival",
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
            <p className="table-note">Source records: <button type="button" className="inline-action" onClick={() => openSource("batches")}>Open filtered batches</button><button type="button" className="inline-action" onClick={() => openSource("due")}>Open embryo checkpoints</button></p>
          </ReportPanel>
          <ReportPanel title="Attrition / abnormality onset" loading={loading} empty={data.funnelMeta?.sampleSize === 0 && data.abnormality.length === 0} emptyMessage="No attrition or abnormality observations match these filters." sampleSize={data.funnelMeta?.sampleSize} quality={<QualityNote meta={data.funnelMeta} />}>
            <FunnelChart points={data.funnel} />
            <ReportTable
              caption="Attrition ranking by checkpoint"
              headers={["Rank", "Stage", "At risk", "Dead"]}
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
              caption="Abnormality onset by checkpoint"
              headers={["Stage", "n"]}
              rows={data.abnormality.map((point) => [
                String(point.stageLabel ?? point.stageOrder),
                Number(point.count ?? 0),
              ])}
            />
            <QualityNote meta={data.abnormalityMeta} />
          </ReportPanel>
          <ReportPanel title="Timing box plot / group comparison" loading={loading} empty={data.deviation.length === 0} emptyMessage="No timing deviations match these filters." sampleSize={data.deviationMeta?.sampleSize} quality={<QualityNote meta={data.deviationMeta} />}>
            <DeviationChart points={data.deviation} />
            <ReportTable
              caption="Timing deviation by checkpoint and group"
              headers={[
                "Group",
                "Stage",
                "n",
                "Mean H",
                "Median H",
                "Min",
                "Max",
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
            <p className="table-note">Source records: <button type="button" className="inline-action" onClick={() => openSource("batches")}>Open filtered batches</button></p>
          </ReportPanel>
          <ReportPanel title="SCNT / control comparison" loading={loading} empty={data.kpiMeta?.denominators?.stage1Condition === 0 && comparison.every((point) => Number(point.n ?? 0) === 0)} emptyMessage="No SCNT or control-arm counts match these filters." sampleSize={data.kpiMeta?.sampleSize} quality={<QualityNote meta={data.kpiMeta} />}>
            <ReportTable
              caption="SCNT and control-arm comparison"
              headers={["Arm", "Stage", "n", "Normal", "Abnormal", "Normal %"]}
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
        </>
      )}
      {tab === "stage2" && (
        <>
          <ReportPanel title="Fish survival by age" loading={loading} empty={data.fishSurvival.length === 0} emptyMessage="No fish survival observations match these filters." sampleSize={data.fishSurvivalMeta?.sampleSize} quality={<QualityNote meta={data.fishSurvivalMeta} />}>
            <FishSurvivalChart points={data.fishSurvival} />
            <ReportTable
              caption="Fish survival by age and condition"
              headers={[
                "Condition",
                "Strain",
                "Treatment",
                "Age day",
                "At risk",
                "Alive",
                "Dead",
                "Frozen",
                "Discarded",
                "M/F",
                "Boxes",
                "Survival",
              ]}
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
            <p className="table-note">Source records: <button type="button" className="inline-action" onClick={() => openSource("fish")}>Open filtered fish registry</button></p>
          </ReportPanel>
          <ReportPanel title="Observation gaps" loading={loading} empty={data.gaps.length === 0} emptyMessage="No fish observation gaps for this filter." sampleSize={data.gapsMeta?.sampleSize} quality={<QualityNote meta={data.gapsMeta} />}>
            <ReportTable
              caption="Fish observation gaps"
              headers={["Fish", "Last observed", "Missed days"]}
              rows={data.gaps.map((point) => [
                String(point.fishCode ?? "—"),
                String(point.lastObservedOn ?? "—"),
                Number(point.missedDays ?? 0),
              ])}
            />
            <p className="table-note">Source records: <button type="button" className="inline-action" onClick={() => openSource("fish")}>Open fish records</button></p>
          </ReportPanel>
        </>
      )}
      {tab === "overall" && (
        <>
          <ReportPanel title="Pipeline conversion" loading={loading} empty={data.pipelineMeta?.sampleSize === 0} emptyMessage="No pipeline records match these filters." sampleSize={data.pipelineMeta?.sampleSize} quality={<QualityNote meta={data.pipelineMeta} />}>
            <ReportTable
              caption="End-to-end pipeline conversion"
              headers={["Step", "n", "% previous", "% activated"]}
              rows={data.pipeline.map((point) => [
                String(point.step),
                Number(point.count ?? 0),
                percent(point.pctOfPrevious),
                percent(point.pctOfStart),
              ])}
            />
            <p className="table-note">Source records: <button type="button" className="inline-action" onClick={() => openSource("batches")}>Open batches</button><button type="button" className="inline-action" onClick={() => openSource("fish")}>Open fish registry</button></p>
          </ReportPanel>
          <ReportPanel title="Timing deviation evidence" loading={loading} empty={data.deviation.length === 0} emptyMessage="No timing deviations match these filters." sampleSize={data.deviationMeta?.sampleSize} quality={<QualityNote meta={data.deviationMeta} />}>
            <DeviationChart points={data.deviation} />
            <ReportTable
              caption="Timing deviation evidence"
              headers={["Stage", "n", "Mean H", "SD H"]}
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
      <div className="action-grid">
        <button onClick={() => onNavigate("due")} className="action-card">
          <strong>{t.due}</strong>
          <span>Create/checkpoint</span>
        </button>
        <button onClick={() => onNavigate("batches")} className="action-card">
          <strong>{t.batches}</strong>
          <span>Create a batch and injection lot.</span>
        </button>
        <button onClick={() => onNavigate("fish")} className="action-card">
          <strong>{t.fish}</strong>
          <span>Run the daily fish roll-call.</span>
        </button>
      </div>
    </section>
  );
}
