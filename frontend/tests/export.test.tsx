// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Export } from "../src/pages/export";
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
});
