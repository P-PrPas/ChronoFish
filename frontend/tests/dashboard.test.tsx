// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgeDistributionSummary,
  BatchPerformanceSummary,
  BoxCensusSummary,
  ControlSummary,
  Dashboard,
  dashboardDataPath,
  FishSurvivalChart,
  FunnelChart,
  formatDeviationHours,
  PipelineSummary,
  parseDashboardTab,
  parseStage1Comparison,
  parseStage2Comparison,
  StackedComposition,
  SurvivalChart,
  TimingSummary,
} from "../src/pages/dashboard";
import { text } from "../src/types";

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const meta = (sampleSize = 3, extra: Record<string, unknown> = {}) => ({
  filters: { siteId: "site-1" },
  sampleSize,
  denominators: { activated: sampleSize },
  unknown: {},
  missing: {},
  ...extra,
});

describe("analytics dashboard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/#dashboard");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("requests one consistent dashboard snapshot with URL filters and exposes data quality", async () => {
    window.history.replaceState(null, "", "/?siteId=site-1&dateFrom=2026-08-20#dashboard");
    const navigate = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/sites")) return json({ items: [{ id: "site-1", name: "North Lab" }] });
      if (path.includes("/analytics/dashboard"))
        return json({
          reportMeta: { generatedAt: "2026-08-24T03:00:00Z", timingProfileVersions: [1, 2] },
          kpi: {
            stage1: {
              nActivated: 3,
              nReachedShield: 2,
              nReachedDay1: 2,
              nPromoted: 1,
              pctNormal: null,
              controlComparison: [],
            },
            stage2: {
              nFish: 1,
              nAlive: 1,
              nDead: 0,
              nFrozen: 0,
              nDiscarded: 0,
              nNormal: 1,
              nAbnormal: 0,
              meanAgeDaysAlive: 4,
            },
            meta: meta(4, { unknown: { fishSex: 1 }, missing: { latestEmbryoObservation: 1 } }),
          },
          funnel: {
            items: [{ stageOrder: 1, stageLabel: "1-cell", alive: 3, riskSet: 3, nDead: 0, pctOfActivated: 1 }],
            meta: meta(),
          },
          survival: {
            items: [
              {
                stageOrder: 1,
                stageLabel: "1-cell",
                siteId: "site-1",
                strain: "AB",
                treatmentGroup: "SCNT",
                riskSet: 3,
                alive: 3,
                surv: 1,
              },
            ],
            meta: meta(),
          },
          timingDeviation: {
            items: [
              {
                stageOrder: 1,
                stageLabel: "1-cell",
                n: 3,
                meanDeviationH: 0,
                medianDeviationH: 0,
                q1DeviationH: 0,
                q3DeviationH: 0,
                minDeviationH: 0,
                maxDeviationH: 0,
              },
            ],
            meta: meta(),
          },
          abnormalityOnset: { items: [{ stageOrder: 1, stageLabel: "1-cell", count: 1 }], meta: meta() },
          fishSurvival: {
            items: [
              { ageDays: 0, atRisk: 1, alive: 1, surv: 1, condition: "NORMAL", strain: "AB", treatmentGroup: "SCNT" },
            ],
            meta: meta(1),
            supporting: {
              statusComposition: [
                { status: "DEAD", n: 1, pct: 0.5 },
                { status: "DISCARDED", n: 1, pct: 0.5 },
              ],
              ageDistribution: [{ bin: "14-20", n: 2, pct: 1 }],
              ageDefinition: "Age is calculated at the current follow-up date.",
              sexComposition: [
                { sex: "F", n: 1, pct: 0.5 },
                { sex: "UNKNOWN", n: 1, pct: 0.5 },
              ],
              sexCompleteness: { known: 1, unknown: 1, pctComplete: 0.5 },
              boxCensus: [
                {
                  boxCode: "A2",
                  n: 0,
                  pct: 0,
                  empty: true,
                  statusCounts: { DEAD: 0, DISCARDED: 0 },
                },
              ],
              boxMeta: { nBoxes: 1, emptyBoxes: 1 },
              batchPerformance: [
                {
                  batchId: "batch-1",
                  batchCode: "B-1",
                  status: "MISSING",
                  n: 0,
                  denominator: 0,
                  missingEmbryos: 1,
                  pctNormal: null,
                },
              ],
              day5Definition: "Day 5 is calculated from each lot due time.",
            },
          },
          observationGaps: {
            items: [{ fishCode: "F-01", lastObservedOn: "2026-08-22", missedDays: 2 }],
            meta: meta(1, { missing: { observation: 1 } }),
          },
          pipeline: { items: [{ step: "Activated", count: 3, pctOfPrevious: 1, pctOfStart: 1 }], meta: meta() },
        });
      return json({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Dashboard onNavigate={navigate} t={text.en} />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const analyticsCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes("/analytics/"));
    expect(analyticsCalls).toHaveLength(1);
    expect(
      analyticsCalls.every(
        ([input]) =>
          String(input).includes("siteId=site-1") &&
          String(input).includes("dateFrom=2026-08-20") &&
          String(input).includes("stage1GroupBy=site") &&
          String(input).includes("stage1GroupBy=strain"),
      ),
    ).toBe(true);
    expect(String(analyticsCalls[0][0])).not.toContain("stage2GroupBy");
    expect(window.location.search).toContain("tab=stage1");
    expect(window.location.search).toContain("stage1Compare=strain");
    expect(window.location.search).toContain("stage2Compare=overall");
    expect(document.body.textContent).toContain("Records in view");
    expect(document.body.textContent).not.toContain("ANALYSIS SCOPE");
    expect(document.body.textContent).toContain("North Lab");
    expect(document.body.textContent).toContain("Bangkok time");
    expect(document.body.textContent).toContain("Timing profile version(s)");
    expect(document.body.textContent).toContain("Activated embryos");
    expect(document.body.textContent).not.toContain("All fish in registry");
    expect(Array.from(document.querySelectorAll("h2")).every((heading) => !heading.textContent?.includes("(n="))).toBe(
      true,
    );
    expect(document.body.textContent).toContain("Data quality");
    expect(document.body.textContent).toContain("Exploratory data only: n=3");
    expect(document.body.textContent).not.toContain("Lowest filtered survival is 100.00% at 1-cell");
    expect(document.body.textContent).not.toContain("Highest loss occurs at 1-cell: 0 of 3 embryos");
    expect(document.body.textContent).toContain("Source records");
    expect(document.body.textContent).toContain("Attrition ranking by checkpoint");
    expect(document.body.textContent).toContain("No abnormality recorded");
    expect(document.querySelector("table caption")).not.toBeNull();
    expect(document.querySelector('[aria-label="Timing deviation from standard in hours"]')).toBeNull();

    const stage1Tab = document.getElementById("dashboard-tab-stage1") as HTMLButtonElement;
    await act(async () => {
      stage1Tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await Promise.resolve();
    });
    expect(document.getElementById("dashboard-tab-stage2")?.getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("dashboard-panel-stage2")).not.toBeNull();
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("stage2");
    expect(new URLSearchParams(window.location.search).get("siteId")).toBe("site-1");
    expect(document.body.textContent).toContain("All fish in registry");
    expect(document.body.textContent).toContain("View supporting fish composition and cohort quality");
    expect(document.body.textContent).toContain("Completeness warning: unknown sex records remain in this cohort.");
    expect(document.body.textContent).toContain("1 fish need a follow-up check");
    expect(document.body.textContent).toContain("Open daily fish check");
    expect(document.body.textContent).toContain("no lowest/best fish-survival headline is reported");
    const stage2Comparison = Array.from(document.querySelectorAll("select")).find(
      (select) => select.getAttribute("aria-label") === "Chart comparison dimension",
    ) as HTMLSelectElement;
    expect(Array.from(stage2Comparison.options).map((option) => option.value)).toEqual([
      "overall",
      "abnormalityGroup",
      "strain",
      "treatmentGroup",
    ]);
    const beforeComparisonURL = window.location.href;
    const pushState = vi.spyOn(window.history, "pushState");
    await act(async () => {
      stage2Comparison.value = "strain";
      stage2Comparison.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(new URLSearchParams(window.location.search).get("stage2Compare")).toBe("strain");
    expect(pushState).toHaveBeenCalledWith(null, "", expect.stringContaining("stage2Compare=strain"));
    window.history.replaceState(null, "", beforeComparisonURL);
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
      await Promise.resolve();
    });
    const restoredComparison = Array.from(document.querySelectorAll("select")).find(
      (select) => select.getAttribute("aria-label") === "Chart comparison dimension",
    ) as HTMLSelectElement;
    expect(restoredComparison.value).toBe("overall");
    for (const value of ["abnormalityGroup", "treatmentGroup", "overall"]) {
      const comparison = Array.from(document.querySelectorAll("select")).find(
        (select) => select.getAttribute("aria-label") === "Chart comparison dimension",
      ) as HTMLSelectElement;
      await act(async () => {
        comparison.value = value;
        comparison.dispatchEvent(new Event("change", { bubbles: true }));
        await Promise.resolve();
      });
      expect(comparison.value).toBe(value);
    }
    const dailyFishCheck = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Open daily fish check",
    );
    await act(async () => {
      dailyFishCheck?.click();
      await Promise.resolve();
    });
    expect(navigate).toHaveBeenCalledWith("fish");
    await act(async () => {
      document
        .getElementById("dashboard-tab-stage2")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      await Promise.resolve();
    });
    const stage1Comparison = Array.from(document.querySelectorAll("select")).find(
      (select) => select.getAttribute("aria-label") === "Chart comparison dimension",
    ) as HTMLSelectElement;
    for (const value of ["treatmentGroup", "operator", "strain"]) {
      await act(async () => {
        stage1Comparison.value = value;
        stage1Comparison.dispatchEvent(new Event("change", { bubbles: true }));
        await Promise.resolve();
      });
      expect(stage1Comparison.value).toBe(value);
    }
    await act(async () => {
      stage1Tab.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      await Promise.resolve();
      document
        .getElementById("dashboard-tab-overall")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      await Promise.resolve();
    });
    expect(document.getElementById("dashboard-tab-stage1")?.getAttribute("aria-selected")).toBe("true");

    const openBatches = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Open filtered batches",
    );
    await act(async () => {
      openBatches?.click();
      await Promise.resolve();
    });
    expect(navigate).toHaveBeenCalledWith("batches");
    expect(window.location.search).toContain("siteId=site-1");
    const editFilters = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Edit filters",
    );
    const filterDisclosure = document.getElementById("dashboard-filter-disclosure") as HTMLDetailsElement;
    expect(filterDisclosure.open).toBe(false);
    await act(async () => {
      editFilters?.click();
      await Promise.resolve();
    });
    expect(filterDisclosure.open).toBe(true);
    const clearFilters = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Clear filters",
    );
    await act(async () => {
      clearFilters?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(window.location.search).not.toContain("siteId=site-1");
    window.history.replaceState(
      null,
      "",
      "/?siteId=site-1&dateFrom=2026-08-20&tab=overall&stage1Compare=operator&stage2Compare=treatmentGroup#dashboard",
    );
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
      await Promise.resolve();
    });
    expect(document.getElementById("dashboard-tab-overall")?.getAttribute("aria-selected")).toBe("true");
    expect(window.location.search).toContain("siteId=site-1");
    expect(window.location.search).toContain("tab=overall");
    expect(new URLSearchParams(window.location.search).get("stage1Compare")).toBe("operator");
    expect(new URLSearchParams(window.location.search).get("stage2Compare")).toBe("treatmentGroup");
    root.unmount();
  });

  it("falls back to Stage 1 for an invalid URL tab", () => {
    expect(parseDashboardTab("?tab=not-a-dashboard-tab")).toBe("stage1");
    expect(parseDashboardTab("?tab=stage2")).toBe("stage2");
    expect(parseDashboardTab("?tab=overall")).toBe("overall");
    expect(parseStage1Comparison("?stage1Compare=operator")).toBe("operator");
    expect(parseStage1Comparison("?stage1Compare=treatmentGroup")).toBe("treatmentGroup");
    expect(parseStage1Comparison("?stage1Compare=invalid")).toBe("strain");
    expect(parseStage2Comparison("?stage2Compare=abnormalityGroup")).toBe("abnormalityGroup");
    expect(parseStage2Comparison("?stage2Compare=strain")).toBe("strain");
    expect(parseStage2Comparison("?stage2Compare=treatmentGroup")).toBe("treatmentGroup");
    expect(parseStage2Comparison("?stage2Compare=invalid")).toBe("overall");
    expect(dashboardDataPath({ siteId: "site-1" }, "strain", "overall")).toContain(
      "stage1GroupBy=site&stage1GroupBy=strain",
    );
    expect(dashboardDataPath({ siteId: "site-1" }, "strain", "abnormalityGroup")).toContain("stage2GroupBy=condition");
    expect(dashboardDataPath({}, "operator", "treatmentGroup")).toContain("stage2GroupBy=treatmentGroup");
    expect(dashboardDataPath({}, "treatmentGroup", "overall")).not.toContain("stage2GroupBy");
  });

  it("renders populated Stage 1, Stage 2, and overview analytics in Thai", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/analytics/dashboard"))
        return json({
          reportMeta: { generatedAt: "2026-09-02T01:00:00Z", timingProfileVersions: [1, 2] },
          kpi: {
            stage1: {
              nActivated: 8,
              nPromoted: 3,
              nReachedShield: 4,
              nReachedDay1: 3,
              nBatches: 2,
              pctNormal: 0.5,
              controlComparison: [
                { armType: "SCNT", stageLabel: "Shield", n: 4, nNormal: 2, nAbnormal: 2, pctNormal: 0.5 },
              ],
              meta: meta(8, { unknown: { fishSex: 1 }, missing: { latestEmbryoObservation: 1 } }),
            },
            stage2: {
              nFish: 3,
              nAlive: 2,
              nDead: 1,
              nFrozen: 0,
              nDiscarded: 0,
              nNormal: 2,
              nAbnormal: 1,
              meanAgeDaysAlive: 30,
            },
          },
          funnel: {
            items: [
              { stageOrder: 1, stageLabel: "1-cell", riskSet: 8, alive: 8, nDead: 0, pctOfActivated: 1 },
              { stageOrder: 2, stageLabel: "Shield", riskSet: 8, alive: 4, nDead: 4, pctOfActivated: 0.5 },
            ],
            meta: meta(),
          },
          survival: {
            items: [
              { site: "KU", strain: "AB", stageOrder: 1, stageLabel: "1-cell", riskSet: 4, alive: 4, surv: 1 },
              { site: "KU", strain: "AB", stageOrder: 2, stageLabel: "Shield", riskSet: 4, alive: 2, surv: 0.5 },
              { site: "KU", strain: "TU", stageOrder: 1, stageLabel: "1-cell", riskSet: 4, alive: 4, surv: 1 },
              { site: "KU", strain: "TU", stageOrder: 2, stageLabel: "Shield", riskSet: 4, alive: 2, surv: 0.5 },
            ],
            meta: meta(),
          },
          timingDeviation: {
            items: [
              {
                stageOrder: 2,
                stageLabel: "Shield",
                n: 4,
                meanDeviationH: 1,
                medianDeviationH: 1,
                q1DeviationH: 0,
                q3DeviationH: 2,
                minDeviationH: -1,
                maxDeviationH: 3,
              },
            ],
            meta: meta(),
          },
          abnormalityOnset: {
            items: [{ stageOrder: 2, stageLabel: "Shield", count: 2 }],
            meta: meta(8, { denominators: { noAbnormalityRecorded: 4 }, missing: { firstAbnormality: 2 } }),
          },
          fishSurvival: {
            items: [
              {
                ageDays: 30,
                atRisk: 3,
                alive: 2,
                surv: 0.67,
                condition: "NORMAL",
                strain: "AB",
                treatmentGroup: "SCNT",
                nEvents: 1,
                nCensored: 1,
              },
            ],
            meta: meta(3),
            supporting: {
              statusComposition: [
                { status: "ALIVE", n: 2, pct: 2 / 3 },
                { status: "FROZEN", n: 1, pct: 1 / 3 },
              ],
              ageDistribution: [
                { bin: "0-6", n: 2, pct: 2 / 3 },
                { bin: "7-13", n: 1, pct: 1 / 3 },
              ],
              ageDefinition: "Age is calculated from the latest follow-up date.",
              sexComposition: [
                { sex: "M", n: 1, pct: 1 / 3 },
                { sex: "UNKNOWN", n: 2, pct: 2 / 3 },
              ],
              sexCompleteness: { known: 1, unknown: 2, pctComplete: 1 / 3 },
              boxCensus: [
                {
                  boxCode: "A1",
                  n: 3,
                  pct: 1,
                  empty: false,
                  statusCounts: { ALIVE: 2, FROZEN: 1 },
                },
              ],
              boxMeta: { nBoxes: 1, emptyBoxes: 0 },
              batchPerformance: [
                {
                  batchId: "batch-1",
                  batchCode: "B-1",
                  status: "ELIGIBLE",
                  n: 3,
                  denominator: 3,
                  missingEmbryos: 1,
                  pctNormal: 2 / 3,
                },
              ],
              day5Definition: "Day 5 is based on the lot due time.",
            },
          },
          observationGaps: { items: [{ fishCode: "F-1", lastObservedOn: "2026-09-01", missedDays: 2 }], meta: meta(3) },
          pipeline: {
            items: [
              { step: "Activated", count: 8, pctOfPrevious: 1, pctOfStart: 1 },
              { step: "Shield", count: 4, pctOfPrevious: 0.5, pctOfStart: 0.5 },
            ],
            meta: meta(),
          },
        });
      return json({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Dashboard onNavigate={vi.fn()} t={text.th} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelectorAll(".chart-point")).not.toHaveLength(0);
    for (const tab of ["overall", "stage2"] as const) {
      await act(async () => {
        (document.getElementById(`dashboard-tab-${tab}`) as HTMLButtonElement).click();
        await Promise.resolve();
      });
      expect(document.getElementById(`dashboard-panel-${tab}`)?.getAttribute("role")).toBe("tabpanel");
    }
    const supporting = document.querySelector("details.supporting-analysis") as HTMLDetailsElement;
    await act(async () => {
      supporting.open = true;
      supporting.dispatchEvent(new Event("toggle"));
    });
    expect(supporting.querySelectorAll(".supporting-analysis__section")).toHaveLength(5);
    expect(supporting.querySelectorAll(".composition__segment")).not.toHaveLength(0);
    root.unmount();
  });

  it("keeps all dashboard tabs usable when an analytical snapshot is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/analytics/dashboard"))
          return json({
            reportMeta: {},
            kpi: { stage1: { controlComparison: [] }, stage2: {}, meta: meta(0) },
            funnel: { items: [], meta: meta(0) },
            survival: { items: [], meta: meta(0) },
            timingDeviation: { items: [], meta: meta(0) },
            abnormalityOnset: { items: [], meta: meta(0) },
            fishSurvival: { items: [], meta: meta(0) },
            observationGaps: { items: [], meta: meta(0) },
            pipeline: { items: [], meta: meta(0) },
          });
        return json({ items: [] });
      }),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Dashboard onNavigate={vi.fn()} t={text.en} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    for (const tab of ["stage1", "stage2", "overall"] as const) {
      await act(async () => {
        (document.getElementById(`dashboard-tab-${tab}`) as HTMLButtonElement).click();
        await Promise.resolve();
      });
      expect(document.getElementById(`dashboard-panel-${tab}`)).not.toBeNull();
    }
    expect(document.body.textContent).toContain("No pipeline records match these filters.");
    root.unmount();
  });

  it("renders a partial analytics response without turning unknown values into invented measurements", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/analytics/dashboard"))
          return json({
            reportMeta: {},
            kpi: { stage1: { controlComparison: [{}] }, stage2: {} },
            funnel: { items: [{}] },
            survival: { items: [{}] },
            timingDeviation: { items: [{}] },
            abnormalityOnset: { items: [{}] },
            fishSurvival: { items: [{}], supporting: {} },
            observationGaps: { items: [] },
            pipeline: { items: [{}] },
          });
        return json({ items: [] });
      }),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Dashboard onNavigate={vi.fn()} t={text.en} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      (document.getElementById("dashboard-tab-stage2") as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Unknown complete.");
    expect(document.body.textContent).toContain("View supporting fish composition and cohort quality");
    expect(document.body.textContent).toContain("No composition data is available for this cohort.");
    expect(document.body.textContent).toContain("No fish ages are available for this cohort.");
    expect(document.body.textContent).toContain("No fish-box records are available for this cohort.");
    await act(async () => {
      (document.getElementById("dashboard-tab-overall") as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("End-to-end pipeline conversion");
    root.unmount();
  });

  it("guards headline candidates by their own risk set even when total n is five", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/analytics/dashboard"))
        return json({
          reportMeta: { generatedAt: "2026-08-24T03:00:00Z" },
          kpi: {
            stage1: { nActivated: 5, nReachedShield: 4, nReachedDay1: 3, nPromoted: 2, controlComparison: [] },
            stage2: { nFish: 5, nAlive: 2, nDead: 1, nFrozen: 1, nDiscarded: 1 },
            meta: meta(10),
          },
          funnel: {
            items: [
              { stageOrder: 1, stageLabel: "1-cell", riskSet: 5, nDead: 0 },
              { stageOrder: 2, stageLabel: "2-cell", riskSet: 1, nDead: 1 },
            ],
            meta: meta(5),
          },
          survival: {
            items: [
              { stageOrder: 1, stageLabel: "1-cell", site: "North", strain: "AB", riskSet: 5, surv: 1 },
              { stageOrder: 1, stageLabel: "1-cell", site: "North", strain: "TU", riskSet: 1, surv: 0.9 },
              { stageOrder: 2, stageLabel: "2-cell", site: "North", strain: "AB", riskSet: 1, surv: 0.1 },
            ],
            meta: meta(5),
          },
          timingDeviation: { items: [], meta: meta(5) },
          abnormalityOnset: { items: [], meta: meta(5) },
          fishSurvival: {
            items: [
              { ageDays: 0, atRisk: 5, surv: 1, strain: "AB" },
              { ageDays: 0, atRisk: 1, surv: 1, strain: "TU" },
              { ageDays: 2, atRisk: 1, surv: 0.1, nEvents: 1, strain: "AB" },
            ],
            meta: meta(5),
          },
          observationGaps: { items: [], meta: meta(5) },
          pipeline: { items: [{ step: "Activated", count: 5, pctOfPrevious: 1, pctOfStart: 1 }], meta: meta(5) },
        });
      return json({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Dashboard onNavigate={vi.fn()} t={text.en} />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.body.textContent).toContain(
      "No lowest/best survival headline: the candidate checkpoint has risk set n=1",
    );
    expect(document.body.textContent).not.toContain("Lowest filtered survival is");
    expect(document.body.textContent).toContain("No highest-loss ranking: the candidate checkpoint has risk set n=1");
    expect(document.body.textContent).toContain("Series with fewer than 5 at the initial point");
    const stage2Tab = document.getElementById("dashboard-tab-stage2") as HTMLButtonElement;
    await act(async () => {
      stage2Tab.click();
      await Promise.resolve();
    });
    const stage2Comparison = Array.from(document.querySelectorAll("select")).find(
      (select) => select.getAttribute("aria-label") === "Chart comparison dimension",
    ) as HTMLSelectElement;
    await act(async () => {
      stage2Comparison.value = "strain";
      stage2Comparison.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.body.textContent).toContain(
      "No lowest/best fish-survival headline: the candidate age has at-risk n=1",
    );
    expect(document.body.textContent).not.toContain("Lowest filtered fish survival is");
    expect(document.body.textContent).toContain("Series with fewer than 5 at the initial point");
    root.unmount();
  });

  it("uses high-contrast fish series with non-color line patterns", async () => {
    const points = ["AB", "TU", "NHGRI", "WT", "MIXED"].flatMap((strain, index) => [
      { ageDays: 0, surv: 1, strain, treatmentGroup: "SCNT", condition: "NORMAL" },
      { ageDays: 10, surv: 0.8 - index * 0.1, strain, treatmentGroup: "SCNT", condition: "NORMAL" },
    ]);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<FishSurvivalChart points={points} thai comparison="strain" />);
      await Promise.resolve();
    });

    const lines = Array.from(document.querySelectorAll<SVGPathElement>(".chart-line"));
    expect(new Set(lines.map((line) => line.getAttribute("stroke")))).toEqual(
      new Set(["#0b6761", "#b67b2f", "#557f9c", "#775f8f"]),
    );
    expect(lines.some((line) => line.hasAttribute("stroke-dasharray"))).toBe(true);
    expect(document.querySelector('svg[aria-label="กราฟ Kaplan–Meier อัตรารอดของปลาตามอายุ"]')).not.toBeNull();
    expect(document.querySelectorAll(".chart-line")).toHaveLength(4);
    root.unmount();
  });

  it("caps crowded comparison charts while retaining toggles and group fallbacks", async () => {
    const stagePoints = ["SCNT", "IVF", "Control", "Rescue", "Pilot"].flatMap((treatmentGroup, index) => [
      {
        stageOrder: 1,
        stageLabel: "1-cell",
        site: "North",
        treatmentGroup,
        riskSet: 5,
        alive: 5,
        surv: 1,
      },
      {
        stageOrder: 2,
        stageLabel: "2-cell",
        site: "North",
        treatmentGroup,
        riskSet: 5,
        alive: 4,
        surv: 0.95 - index / 20,
      },
    ]);
    const fishPoints = ["EVER_ABNORMAL", "NO_ABNORMALITY", "UNKNOWN", "REVIEW", "PENDING"].flatMap(
      (abnormalityGroup, index) => [
        { ageDays: 0, abnormalityGroup, atRisk: 5, surv: 1, nEvents: 0, nCensored: 0 },
        { ageDays: 7, abnormalityGroup, atRisk: 5, surv: 0.9 - index / 20, nEvents: 1, nCensored: 0 },
      ],
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(
        <>
          <SurvivalChart points={stagePoints} comparison="treatmentGroup" />
          <FishSurvivalChart points={fishPoints} comparison="abnormalityGroup" />
          <FunnelChart
            points={Array.from({ length: 9 }, (_, index) => ({
              stageOrder: index + 1,
              stageLabel: `Stage ${index + 1}`,
              riskSet: index === 0 ? 0 : 10,
              nDead: index === 1 ? 0 : index,
            }))}
          />
        </>,
      );
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Showing at most 4 series per site (4 of 5)");
    expect(document.body.textContent).toContain("Showing 4 of 5 groups");
    expect(document.body.textContent).toContain("Abnormality group");
    expect(document.querySelector("svg.chart--funnel")?.getAttribute("viewBox")).toBe("0 0 560 268");
    const legendItems = document.querySelectorAll<HTMLButtonElement>("button.chart-legend__item");
    await act(async () => {
      legendItems[0].click();
      legendItems[4].click();
      await Promise.resolve();
    });
    expect(legendItems[0].getAttribute("aria-pressed")).toBe("false");
    expect(legendItems[4].getAttribute("aria-pressed")).toBe("false");
    root.unmount();
  });

  it("renders step paths, accessible checkpoint points, KM uncertainty and censor/event marks", async () => {
    const points = [
      { stageOrder: 1, stageLabel: "1-cell", site: "North", strain: "AB", surv: 1, riskSet: 5 },
      { stageOrder: 2, stageLabel: "2-cell", site: "North", strain: "AB", surv: 0.8, riskSet: 5 },
      { ageDays: 0, surv: 1, survLower95: 0.9, survUpper95: 1, atRisk: 5, nEvents: 0, nCensored: 0 },
      { ageDays: 2, surv: 0.8, survLower95: 0.6, survUpper95: 0.95, atRisk: 5, nEvents: 1, nCensored: 1 },
    ];
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(
        <>
          <SurvivalChart points={points.slice(0, 2)} />
          <FishSurvivalChart points={points.slice(2)} />
        </>,
      );
      await Promise.resolve();
    });
    expect(document.querySelector(".chart-line")?.getAttribute("d")).toContain("H");
    expect(document.querySelectorAll(".chart-point")).toHaveLength(4);
    expect(document.querySelectorAll('.chart-point[tabindex="0"]').length).toBe(2);
    const firstPoint = document.querySelector('.chart-point[tabindex="0"]') as SVGCircleElement;
    await act(async () => {
      firstPoint.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelectorAll('.chart-point[tabindex="0"]').length).toBe(2);
    expect(document.querySelectorAll(".chart-point")[1].getAttribute("tabindex")).toBe("0");
    expect(document.querySelector(".chart-ci")).not.toBeNull();
    expect(document.querySelector(".chart-censor")).not.toBeNull();
    expect(document.querySelector(".chart-event")).not.toBeNull();
    root.unmount();
  });

  it("connects coincident end labels to distinct collision-safe lane positions", async () => {
    const points = ["AB", "NHGRI", "TU"].map((strain) => ({
      stageOrder: 1,
      stageLabel: "1-cell",
      site: "North",
      strain,
      surv: 1,
      riskSet: 5,
    }));
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<SurvivalChart points={points} />);
      await Promise.resolve();
    });
    const labels = Array.from(document.querySelectorAll<SVGTextElement>(".chart-end-label"));
    const leaders = Array.from(document.querySelectorAll<SVGLineElement>(".chart-end-leader"));
    expect(labels).toHaveLength(3);
    expect(new Set(labels.map((label) => label.getAttribute("y"))).size).toBe(3);
    expect(new Set(labels.map((label) => label.getAttribute("x"))).size).toBe(1);
    expect(leaders).toHaveLength(3);
    expect(leaders.every((leader) => leader.getAttribute("x1") !== leader.getAttribute("x2"))).toBe(true);
    expect(leaders.filter((leader) => leader.getAttribute("stroke-dasharray")).length).toBe(2);
    root.unmount();
  });

  it("uses a taller, wider mobile chart geometry with fewer axis ticks", async () => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(
        <SurvivalChart
          points={[
            { stageOrder: 1, stageLabel: "1-cell", site: "North", strain: "AB", surv: 1, riskSet: 5 },
            { stageOrder: 26, stageLabel: "Day 5", site: "North", strain: "AB", surv: 0.5, riskSet: 5 },
          ]}
        />,
      );
      await Promise.resolve();
    });
    const chart = document.querySelector("svg.chart");
    expect(chart?.getAttribute("viewBox")).toBe("0 0 500 330");
    expect(chart?.querySelectorAll("text")).toHaveLength(11);
    root.unmount();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
  });

  it("uses readable selected dimensions in visible chart summaries", async () => {
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(
        <SurvivalChart
          points={[
            { stageOrder: 1, stageLabel: "1-cell", site: "North", operatorId: "op-1", riskSet: 5, alive: 5, surv: 1 },
          ]}
          comparison="operator"
          operators={[{ id: "op-1", name: "Dr Somchai" }]}
        />,
      );
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Dr Somchai");
    expect(document.body.textContent).toContain("Visible checkpoint risk summary");
    root.unmount();
    const fishRootElement = document.createElement("div");
    document.body.append(fishRootElement);
    const fishRoot = createRoot(fishRootElement);
    await act(async () => {
      fishRoot.render(
        <FishSurvivalChart
          points={[
            { ageDays: 0, treatmentGroup: "SCNT", atRisk: 5, surv: 1 },
            { ageDays: 0, treatmentGroup: "IVF", atRisk: 1, surv: 1 },
          ]}
          comparison="treatmentGroup"
        />,
      );
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Treatment group");
    expect(document.body.textContent).toContain("SCNT");
    expect(document.body.textContent).toContain("Visible risk, event, and censor summary");
    fishRoot.unmount();
  });

  it("shows Thai pipeline labels and percentages without relying on the bar fill", async () => {
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(
        <PipelineSummary
          thai
          points={[
            { step: "Activated", count: 10, pctOfPrevious: 1, pctOfStart: 1 },
            { step: "Promoted", count: 4, pctOfPrevious: 0.4, pctOfStart: 0.4 },
          ]}
        />,
      );
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("เริ่มติดตาม");
    expect(document.body.textContent).toContain("จากก่อนหน้า 40.0%");
    root.unmount();
  });

  it("renders supporting composition, bins, box census, Day 5 guards and timing summaries", async () => {
    expect(formatDeviationHours(8 / 60)).toBe("+8 min");
    expect(formatDeviationHours(-1.2)).toBe("−1 hr 12 min");
    expect(formatDeviationHours(0)).toBe("0 min");
    expect(formatDeviationHours(null)).toBe("Unknown");
    expect(formatDeviationHours("not-a-number")).toBe("Unknown");
    expect(formatDeviationHours(1, true)).toMatch(/1/);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(
        <>
          <StackedComposition
            rows={[
              { status: "ALIVE", n: 3, pct: 0.6 },
              { status: "DEAD", n: 2, pct: 0.4 },
            ]}
            field="status"
            thai={false}
          />
          <StackedComposition
            rows={[
              { sex: "M", n: 2, pct: 0.5 },
              { sex: "F", n: 1, pct: 0.25 },
              { sex: "UNKNOWN", n: 1, pct: 0.25 },
            ]}
            field="sex"
            thai={false}
          />
          <AgeDistributionSummary
            rows={[
              { bin: "0-6", n: 2, pct: 0.5 },
              { bin: "7-13", n: 2, pct: 0.5 },
            ]}
            definition="Age in days at current follow-up date."
            thai={false}
          />
          <AgeDistributionSummary
            rows={[{ bin: "0-6", n: 2, pct: 0.5 }]}
            definition="Age in days at current follow-up date."
            thai
          />
          <BoxCensusSummary
            rows={[
              {
                boxCode: "B1",
                n: 4,
                pct: 1,
                empty: false,
                statusCounts: { ALIVE: 4, DEAD: 0, FROZEN: 0, DISCARDED: 0, UNKNOWN: 0 },
              },
            ]}
            meta={{ nBoxes: 1, emptyBoxes: 0 }}
            thai={false}
          />
          <BatchPerformanceSummary
            rows={[
              {
                batchId: "b1",
                batchCode: "B1",
                status: "ELIGIBLE",
                denominator: 2,
                n: 2,
                missingEmbryos: 1,
                pctNormal: 0.5,
              },
              { batchId: "b2", batchCode: "B2", status: "MISSING", denominator: 0, n: 0 },
            ]}
            definition="Day 5 denominator is known condition."
            thai={false}
          />
          <BatchPerformanceSummary
            rows={[{ batchId: "b1", batchCode: "B1", status: "NOT_ELIGIBLE", denominator: 0, n: 0 }]}
            definition="Day 5 denominator is known condition."
            thai
          />
          <ControlSummary
            points={[
              { armType: "SCNT", stageOrder: 3, n: 4, nNormal: 3, pctNormal: 0.75 },
              { armType: "IVF", stageOrder: 3, n: 0, nNormal: 0, pctNormal: null },
            ]}
            thai={false}
          />
          <TimingSummary
            rows={[
              { stageOrder: 1, stageLabel: "1-cell", medianDeviationH: -1.2, q1DeviationH: -2, q3DeviationH: 0.25 },
            ]}
            thai={false}
          />
        </>,
      );
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("ALIVE: 3 (60.00%)");
    expect(document.body.textContent).toContain("Unknown: 1 (25.00%)");
    expect(document.body.textContent).toContain("0-6 days");
    expect(document.body.textContent).toContain("B1");
    expect(document.body.textContent).toContain("ALIVE 4");
    expect(document.body.textContent).toContain("50.00% normal");
    expect(document.body.textContent).toContain("known 2 · missing due 1");
    expect(document.body.textContent).toContain("partial data");
    expect(document.body.textContent).toContain("Data-quality warning: 1 batch has due observations missing");
    expect(document.body.textContent).toContain("denominator below 5");
    expect(document.body.textContent).toContain("Unknown (n=0)");
    expect(document.body.textContent).toContain("Median −1 hr 12 min");
    expect(document.body.textContent).toContain("อายุเป็นวัน ณ วันที่ติดตามล่าสุด");
    expect(document.body.textContent).toContain("Day 5 ใช้เวลา due ของแต่ละล็อต");
    root.unmount();
  });

  it("distinguishes unavailable and incomplete supporting analytics from zero-valued results", async () => {
    const boxes = Array.from({ length: 9 }, (_, index) => ({
      boxCode: `B${index + 1}`,
      n: index === 0 ? 0 : index,
      pct: index / 40,
      empty: index === 0,
      statusCounts: index === 1 ? undefined : { ALIVE: index },
    }));
    const batches = Array.from({ length: 9 }, (_, index) => ({
      batchId: `batch-${index + 1}`,
      batchCode: `Batch ${index + 1}`,
      status: index === 0 ? "MISSING_CONDITION" : index === 1 ? "UNMAPPED" : "ELIGIBLE",
      denominator: index < 2 ? 0 : 5,
      n: index,
      missingEmbryos: index < 2 ? 1 : 0,
      pctNormal: index < 2 ? null : 0.8,
    }));
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(
        <>
          <StackedComposition rows={[]} field="status" thai={false} />
          <AgeDistributionSummary rows={[]} thai={false} />
          <BoxCensusSummary rows={[]} thai={false} />
          <BatchPerformanceSummary rows={[]} thai={false} />
          <BoxCensusSummary rows={boxes} thai={false} />
          <BatchPerformanceSummary rows={batches} thai={false} />
          <TimingSummary
            rows={[
              {
                stageOrder: 1,
                stageLabel: "Unknown timing",
                medianDeviationH: null,
                q1DeviationH: "bad",
                q3DeviationH: 1,
              },
            ]}
            thai={false}
          />
          <ControlSummary
            points={[
              { armType: "SCNT", stageOrder: 1, n: 6, pctNormal: 1.5 },
              { armType: "IVF", stageOrder: 2, n: 5, pctNormal: -0.5 },
              { armType: "WT", stageOrder: 3, n: 5, pctNormal: null },
            ]}
            thai={false}
          />
          <PipelineSummary
            points={[
              { step: "Activated", count: 2, pctOfPrevious: null, pctOfStart: null },
              { step: "Corrected", count: 3, pctOfPrevious: 1.5, pctOfStart: 1.5 },
            ]}
            thai={false}
          />
        </>,
      );
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("No composition data is available for this cohort.");
    expect(document.body.textContent).toContain("No fish ages are available for this cohort.");
    expect(document.body.textContent).toContain("No fish-box records are available for this cohort.");
    expect(document.body.textContent).toContain("No batches are available for Day 5 comparison.");
    expect(document.body.textContent).toContain("Showing 8 boxes; 1 more are in the full table.");
    expect(document.body.textContent).toContain("No fish");
    expect(document.body.textContent).toContain("Condition missing");
    expect(document.body.textContent).toContain("Showing 8 of 9 batches; see the full table below.");
    expect(document.body.textContent).toContain("Data-quality warning: 2 batches have due observations missing");
    expect(document.body.textContent).toContain("Median Unknown · IQR Unknown–+1 hr");
    expect(document.body.textContent).toContain("Unknown (n=5)");
    expect(document.body.textContent).toContain("Data quality: a downstream count exceeds its upstream count");
    root.unmount();
  });
});
