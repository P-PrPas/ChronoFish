import { useEffect, useState } from "react";
import { type ApiItem, get, request } from "../api/client";
import { ErrorMessage, Metric, ReportPanel, ReportTable } from "../components";
import { analyticsFilters, type DashboardFilters, parseFilters, updateFilterURL, withFilters } from "../filters";
import { type AppText, text } from "../types";
import { FilterBar, FunnelChart, percent, SurvivalChart, useDashboardMasterOptions } from "./dashboard";

type PrintableReport = {
  generatedAt: string;
  timingProfileVersions: number[];
  kpi: ApiItem | null;
  funnel: ApiItem[];
  survival: ApiItem[];
  deviation: ApiItem[];
  abnormality: ApiItem[];
  fishSurvival: ApiItem[];
  gaps: ApiItem[];
  pipeline: ApiItem[];
  loading: boolean;
  error: string;
};

function filterSummary(filters: DashboardFilters): string {
  const values = Object.entries(filters).filter(([, value]) => value);
  return values.length === 0 ? "All records" : values.map(([key, value]) => `${key}=${value}`).join(" · ");
}

export function Export({ t = text.en }: { t?: AppText } = {}) {
  const options = useDashboardMasterOptions();
  const [filters, setFilters] = useState<DashboardFilters>(() => analyticsFilters(parseFilters()));
  const [message, setMessage] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [reportReady, setReportReady] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  useEffect(() => {
    const onPop = () => setFilters(analyticsFilters(parseFilters()));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const download = async (path: string, init: RequestInit, filename: string) => {
    setDownloading(true);
    setMessage("");
    try {
      const response = await request(path, init);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setDownloading(false);
    }
  };
  const downloadExcel = () =>
    download(
      "/exports/excel",
      { method: "POST", body: JSON.stringify({ locale: "th", filters }) },
      "kuvth-zebrafish-lims-export.xlsx",
    );
  const downloadRTable = () =>
    download(withFilters("/exports/r-table", filters), {}, "kuvth-zebrafish-lims-r-analysis.csv");
  const thai = t === text.th;
  return (
    <>
      <section className="export-controls">
        <div className="page-heading">
          <div>
            <p className="eyebrow">{thai ? "ข้อมูลพร้อมใช้งานต่อ" : "ANALYSIS-READY DATA"}</p>
            <h1>{thai ? "ดาวน์โหลดข้อมูลและรายงาน" : "Downloads and reports"}</h1>
            <p className="muted">
              {thai
                ? "เลือกข้อมูลชุดเดียวกับหน้าผลการทดลอง แล้วดาวน์โหลดในรูปแบบที่เหมาะกับงานต่อไป"
                : "Choose the same records used in Research results, then download the format that fits your next task."}
            </p>
          </div>
        </div>
        <FilterBar
          filters={filters}
          options={options}
          t={t}
          onChange={(next) => {
            setFilters(next);
            updateFilterURL(next);
          }}
        />
        <div className="action-grid">
          <button className="action-card" onClick={downloadExcel} disabled={downloading} aria-busy={downloading}>
            <strong>{t.downloadExcel}</strong>
            <span>{thai ? "สำหรับตรวจข้อมูลและส่งต่อในทีม · 14 ชีต" : "For review and team handoff · 14 sheets"}</span>
          </button>
          <button className="action-card" onClick={downloadRTable} disabled={downloading} aria-busy={downloading}>
            <strong>{thai ? "ดาวน์โหลด R CSV" : "Download R CSV"}</strong>
            <span>
              {thai ? "สำหรับนำเข้า R โดยตรง · UTF-8 จำนวน 30 คอลัมน์" : "Ready for R · UTF-8, 30-column analysis table"}
            </span>
          </button>
          <button className="action-card" onClick={() => window.print()} type="button" disabled={!reportReady}>
            <strong>{t.printPDF}</strong>
            <span>
              {reportReady
                ? thai
                  ? "พิมพ์กราฟและตารางวิเคราะห์ทั้งหมด"
                  : "Print all analytical panels."
                : thai
                  ? "กำลังเตรียมหน้ารายงาน…"
                  : "Preparing analytical panels…"}
            </span>
          </button>
        </div>
        <button
          className="button button--secondary"
          type="button"
          disabled={!reportReady}
          onClick={() => setPreviewOpen((value) => !value)}
        >
          {previewOpen
            ? thai
              ? "ซ่อนตัวอย่างรายงาน"
              : "Hide report preview"
            : thai
              ? "ดูตัวอย่างรายงานก่อนพิมพ์"
              : "Preview report before printing"}
        </button>
        {downloading && (
          <p className="table-note" role="status">
            {thai ? "กำลังเตรียมไฟล์…" : "Preparing export…"}
          </p>
        )}
        {message && <ErrorMessage message={message} />}
      </section>
      <div className={previewOpen ? "report-preview report-preview--open" : "report-preview"}>
        <PrintableDashboard filters={filters} t={t} onReadyChange={setReportReady} />
      </div>
    </>
  );
}

export function PrintableDashboard({
  filters,
  t = text.en,
  onReadyChange,
}: {
  filters: DashboardFilters;
  t?: AppText;
  onReadyChange?: (ready: boolean) => void;
}) {
  const [report, setReport] = useState<PrintableReport>({
    generatedAt: "",
    timingProfileVersions: [],
    kpi: null,
    funnel: [],
    survival: [],
    deviation: [],
    abnormality: [],
    fishSurvival: [],
    gaps: [],
    pipeline: [],
    loading: true,
    error: "",
  });
  useEffect(() => {
    let cancelled = false;
    onReadyChange?.(false);
    setReport((current) => ({ ...current, loading: true, error: "" }));
    void get(withFilters("/analytics/dashboard", filters))
      .then((bundle) => {
        const items = (value: unknown) => (value as ApiItem | undefined)?.items ?? [];
        if (!cancelled)
          setReport({
            generatedAt: String((bundle.reportMeta as ApiItem | undefined)?.generatedAt ?? ""),
            timingProfileVersions:
              ((bundle.reportMeta as ApiItem | undefined)?.timingProfileVersions as number[] | undefined) ?? [],
            kpi: (bundle.kpi as ApiItem | null) ?? null,
            funnel: items(bundle.funnel),
            survival: items(bundle.survival),
            deviation: items(bundle.timingDeviation),
            abnormality: items(bundle.abnormalityOnset),
            fishSurvival: items(bundle.fishSurvival),
            gaps: items(bundle.observationGaps),
            pipeline: items(bundle.pipeline),
            loading: false,
            error: "",
          });
        if (!cancelled) onReadyChange?.(true);
      })
      .catch((error: Error) => {
        if (!cancelled)
          setReport((current) => ({
            ...current,
            loading: false,
            error: error.message,
          }));
      });
    return () => {
      cancelled = true;
    };
  }, [filters, onReadyChange]);
  const stage1 = report.kpi?.stage1 as ApiItem | undefined;
  const stage2 = report.kpi?.stage2 as ApiItem | undefined;
  const comparison = (stage1?.controlComparison as ApiItem[] | undefined) ?? [];
  const thai = t === text.th;
  return (
    <section className="print-report" aria-labelledby="print-report-title">
      <div className="print-report__header">
        <p className="eyebrow">KUVTH ZEBRAFISH LIMS / {thai ? "รายงานผลการทดลอง" : "RESEARCH RESULTS"}</p>
        <h1 id="print-report-title">{thai ? "รายงานสรุปผลการทดลอง" : "Experiment results report"}</h1>
        <p className="muted">
          {thai
            ? "สร้างจากชุดข้อมูลและตัวกรองเดียวกับหน้าผลการทดลองและไฟล์ Excel"
            : "Generated from the same filtered dataset as Research results and the Excel workbook."}
        </p>
        <p className="muted print-report__filters">
          {thai ? "ตัวกรอง" : "Filters"}: {filterSummary(filters)}
        </p>
        <p className="muted">Timing profile versions: {report.timingProfileVersions.join(", ") || "none"}</p>
      </div>
      {report.loading && <p className="notice">Loading dashboard panels...</p>}
      {report.error && <ErrorMessage message={report.error} />}
      {!report.loading && !report.error && (
        <>
          <div className="metric-grid">
            <Metric label="Activated embryos" value={Number(stage1?.nActivated ?? 0)} />
            <Metric label="Promoted fish" value={Number(stage1?.nPromoted ?? 0)} />
            <Metric label="Reached Shield" value={Number(stage1?.nReachedShield ?? 0)} />
            <Metric label="Reached Day 1" value={Number(stage1?.nReachedDay1 ?? 0)} />
            <Metric label="Normal %" value={percent(stage1?.pctNormal)} />
            <Metric label="Alive fish" value={Number(stage2?.nAlive ?? 0)} />
            <Metric label="Batches" value={Number(stage1?.nBatches ?? 0)} />
            <Metric label="Frozen fish" value={Number(stage2?.nFrozen ?? 0)} />
            <Metric label="Discarded fish" value={Number(stage2?.nDiscarded ?? 0)} />
            <Metric label="Normal fish" value={Number(stage2?.nNormal ?? 0)} />
            <Metric label="Abnormal fish" value={Number(stage2?.nAbnormal ?? 0)} />
          </div>
          <ReportPanel title="Overview pipeline">
            <FunnelChart points={report.funnel} />
            <ReportTable
              headers={["Step", "n", "% previous", "% activated"]}
              rows={report.pipeline.map((point) => [
                String(point.step ?? "—"),
                Number(point.count ?? 0),
                percent(point.pctOfPrevious),
                percent(point.pctOfStart),
              ])}
            />
          </ReportPanel>
          <ReportPanel title="Stage 1 survival curve">
            <SurvivalChart points={report.survival} />
            <ReportTable
              headers={["Site", "Strain", "Stage", "Risk set", "Alive", "Survival"]}
              rows={report.survival.map((point) => [
                String(point.site ?? "All"),
                String(point.strain ?? "All"),
                String(point.stageLabel ?? point.stageOrder ?? "—"),
                Number(point.riskSet ?? 0),
                Number(point.alive ?? 0),
                Number(point.surv ?? 0).toFixed(4),
              ])}
            />
          </ReportPanel>
          <ReportPanel title="Attrition / abnormality onset">
            <FunnelChart points={report.funnel} />
            <ReportTable
              headers={["Stage", "Count"]}
              rows={report.abnormality.map((point) => [
                String(point.stageLabel ?? point.stageOrder ?? "—"),
                Number(point.count ?? 0),
              ])}
            />
          </ReportPanel>
          <ReportPanel title="Timing deviation / group comparison">
            <ReportTable
              headers={["Group", "Stage", "n", "Mean H", "Median H", "SD H"]}
              rows={report.deviation.map((point) => [
                String(point.treatmentGroup ?? point.strain ?? "All"),
                String(point.stageLabel ?? point.stageOrder ?? "—"),
                Number(point.n ?? 0),
                Number(point.meanDeviationH ?? 0).toFixed(4),
                Number(point.medianDeviationH ?? 0).toFixed(4),
                point.sdDeviationH == null ? "—" : Number(point.sdDeviationH).toFixed(4),
              ])}
            />
          </ReportPanel>
          <ReportPanel title="Stage 2 fish survival">
            <ReportTable
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
              rows={report.fishSurvival.map((point) => [
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
                Number(point.surv ?? 0).toFixed(4),
              ])}
            />
          </ReportPanel>
          <ReportPanel title="SCNT / control comparison">
            <ReportTable
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
          <ReportPanel title="Observation gaps">
            <ReportTable
              headers={["Fish", "Last observed", "Missed days"]}
              rows={report.gaps.map((point) => [
                String(point.fishCode ?? "—"),
                String(point.lastObservedOn ?? "—"),
                Number(point.missedDays ?? 0),
              ])}
            />
          </ReportPanel>
          <footer className="muted">Generated: {report.generatedAt}</footer>
        </>
      )}
    </section>
  );
}
