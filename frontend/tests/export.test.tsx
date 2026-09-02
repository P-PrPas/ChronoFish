// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Export, PrintableDashboard } from "../src/pages/export";
import { text } from "../src/types";

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

describe("export page", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/#export");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads the printable report from one filtered dashboard snapshot", async () => {
    window.history.replaceState(null, "", "/?siteId=site-1&status=DEAD#export");
    const print = vi.fn();
    Object.defineProperty(window, "print", { configurable: true, value: print });
    let resolveDashboard!: (response: Response) => void;
    const dashboardResponse = new Promise<Response>((resolve) => {
      resolveDashboard = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/analytics/dashboard")) {
        return dashboardResponse;
      }
      return json({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);

    await act(async () => {
      root.render(<Export t={text.en} />);
    });
    const printButton = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Print / PDF"),
    ) as HTMLButtonElement;
    expect(printButton.disabled).toBe(true);
    await act(async () => {
      printButton.click();
    });
    expect(print).not.toHaveBeenCalled();

    await act(async () => {
      resolveDashboard(
        json({
          reportMeta: { generatedAt: "2026-08-24T10:00:00Z", timingProfileVersions: [1] },
          kpi: {
            stage1: { nActivated: 3, nPromoted: 1, pctNormal: null, controlComparison: [] },
            stage2: { nAlive: 1, nFrozen: 0, nDiscarded: 0, nNormal: 1, nAbnormal: 0 },
          },
          funnel: { items: [] },
          survival: { items: [] },
          timingDeviation: { items: [] },
          abnormalityOnset: { items: [] },
          fishSurvival: { items: [] },
          observationGaps: { items: [] },
          pipeline: { items: [{ step: "Activated", count: 0, pctOfStart: null, pctOfPrevious: null }] },
        }),
      );
      await dashboardResponse;
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const dashboardCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes("/analytics/dashboard"));
    expect(dashboardCalls).toHaveLength(1);
    expect(String(dashboardCalls[0][0])).toContain("siteId=site-1");
    expect(String(dashboardCalls[0][0])).not.toContain("status=DEAD");
    expect(document.body.textContent).toContain("Filters: siteId=site-1");
    expect(document.body.textContent).not.toContain("status=DEAD");
    expect(document.body.textContent).toContain("Timing profile versions: 1");
    expect(document.body.textContent).toContain("Generated: 2026-08-24T10:00:00Z");
    expect(document.body.textContent).toContain("Unknown");
    expect(document.body.textContent).toContain("Download R CSV");

    expect(printButton.disabled).toBe(false);
    await act(async () => {
      printButton?.click();
    });
    expect(print).toHaveBeenCalledOnce();
    root.unmount();
  });

  it("shows a loading state and an error when the dashboard snapshot fails", async () => {
    let resolveDashboard!: (response: Response) => void;
    const dashboardResponse = new Promise<Response>((resolve) => {
      resolveDashboard = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(dashboardResponse);
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);

    await act(async () => {
      root.render(<PrintableDashboard filters={{}} t={text.en} />);
    });
    expect(document.body.textContent).toContain("Loading dashboard panels...");
    await act(async () => {
      resolveDashboard(new Response("unavailable", { status: 500 }));
      await dashboardResponse;
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.body.textContent).toContain("HTTP 500");
    expect(fetchMock).toHaveBeenCalledOnce();
    root.unmount();
  });

  it("renders populated analytical panels and opens a print preview", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/analytics/dashboard"))
        return json({
          reportMeta: { generatedAt: "2026-09-02T01:00:00Z", timingProfileVersions: [3, 4] },
          kpi: {
            stage1: {
              nActivated: 10,
              nPromoted: 4,
              nReachedShield: 3,
              nReachedDay1: 2,
              nBatches: 1,
              pctNormal: 50,
              controlComparison: [
                { armType: "SCNT", stageLabel: "Shield", n: 3, nNormal: 2, nAbnormal: 1, pctNormal: 66.7 },
              ],
            },
            stage2: { nAlive: 2, nFrozen: 1, nDiscarded: 1, nNormal: 2, nAbnormal: 1 },
          },
          funnel: { items: [{ step: "Activated", count: 10, pctOfStart: 100, pctOfPrevious: 100 }] },
          survival: { items: [{ site: "KU", strain: "AB", stageLabel: "Shield", riskSet: 4, alive: 3, surv: 0.75 }] },
          timingDeviation: {
            items: [
              {
                treatmentGroup: "SCNT",
                stageLabel: "Shield",
                n: 3,
                meanDeviationH: 1,
                medianDeviationH: 1,
                sdDeviationH: 0.5,
              },
            ],
          },
          abnormalityOnset: { items: [{ stageLabel: "Day 1", count: 1 }] },
          fishSurvival: {
            items: [
              {
                condition: "NORMAL",
                strain: "AB",
                treatmentGroup: "SCNT",
                ageDays: 30,
                atRisk: 3,
                alive: 2,
                nDead: 1,
                nFrozen: 0,
                nDiscarded: 0,
                nMale: 1,
                nFemale: 1,
                nBoxes: 1,
                surv: 0.67,
              },
            ],
          },
          observationGaps: { items: [{ fishCode: "F-1", lastObservedOn: "2026-09-01", missedDays: 2 }] },
          pipeline: { items: [{ step: "Activated", count: 10, pctOfStart: 100, pctOfPrevious: 100 }] },
        });
      return json({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Export t={text.en} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const preview = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Preview report before printing",
    ) as HTMLButtonElement;
    expect(preview.disabled).toBe(false);
    await act(async () => {
      preview.click();
      await Promise.resolve();
    });
    expect(document.querySelector(".report-preview")?.className).toContain("report-preview--open");
    expect(document.body.textContent).toContain("Stage 1 survival curve");
    expect(document.body.textContent).toContain("SCNT / control comparison");
    expect(document.body.textContent).toContain("F-1");
    expect(document.body.textContent).toContain("Timing profile versions: 3, 4");
    root.unmount();
  });

  it("downloads Excel and R files with the selected export format", async () => {
    sessionStorage.setItem("chronofish.operator_id", "operator-1");
    const createObjectURL = vi.fn(() => "blob:download");
    const revokeObjectURL = vi.fn();
    const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/analytics/dashboard"))
        return json({
          reportMeta: {},
          kpi: {},
          funnel: { items: [] },
          survival: { items: [] },
          timingDeviation: { items: [] },
          abnormalityOnset: { items: [] },
          fishSurvival: { items: [] },
          observationGaps: { items: [] },
          pipeline: { items: [] },
        });
      if (path.includes("/exports/")) return new Response("export", { headers: { "Content-Type": "text/csv" } });
      return json({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Export t={text.en} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Download Excel"))
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Download R CSV"))
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/exports/excel") && init?.method === "POST"),
    ).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/exports/r-table"))).toBe(true);
    expect(click).toHaveBeenCalledTimes(2);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate);
    else delete (URL as typeof URL & { createObjectURL?: unknown }).createObjectURL;
    if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
    else delete (URL as typeof URL & { revokeObjectURL?: unknown }).revokeObjectURL;
    root.unmount();
  });
});
