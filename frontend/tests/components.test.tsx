// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Empty, ErrorMessage, Metric, ReportPanel, ReportTable } from "../src/components";
import { renderPage } from "./helpers";

describe("shared report components", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("announces a focusable error message in the document language", async () => {
    document.documentElement.lang = "en";
    const view = await renderPage(<ErrorMessage message="OPERATOR_REQUIRED" />);
    const error = view.element.querySelector('[role="alert"]');
    expect(error?.textContent).toBe("Choose an operator before recording");
    expect(error?.getAttribute("tabindex")).toBe("-1");
    await view.unmount();
  });

  it("shows a localized loading status before report content", async () => {
    const view = await renderPage(
      <ReportPanel title="ผลการทดลอง" loading>
        <p>content</p>
      </ReportPanel>,
    );
    expect(view.element.querySelector('[role="status"]')?.textContent).toBe("กำลังโหลดข้อมูลวิเคราะห์…");
    expect(view.element.querySelector("section")?.getAttribute("aria-busy")).toBe("true");
    expect(view.element.textContent).not.toContain("content");
    await view.unmount();
  });

  it("shows an empty report and its quality note together", async () => {
    const view = await renderPage(
      <ReportPanel title="Report" empty emptyMessage="No rows" quality={<p>Data quality note</p>}>
        <p>content</p>
      </ReportPanel>,
    );
    expect(view.element.textContent).toContain("No rows");
    expect(view.element.textContent).toContain("Data quality note");
    await view.unmount();
  });

  it("renders labelled, scrollable table regions and spans empty rows", async () => {
    const view = await renderPage(<ReportTable headers={["Code", "Count"]} rows={[]} caption="Results table" />);
    const region = view.element.querySelector('[role="region"]');
    const empty = view.element.querySelector("td");
    expect(region?.getAttribute("aria-label")).toBe("Results table");
    expect(region?.getAttribute("tabindex")).toBe("0");
    expect(empty?.getAttribute("colspan")).toBe("2");
    await view.unmount();
  });

  it("localizes default empty copy and supports collapsed data", async () => {
    const view = await renderPage(<ReportTable headers={["รหัส"]} rows={[]} collapsed summary="ข้อมูลเพิ่มเติม" />);
    expect(view.element.querySelector("details summary")?.textContent).toBe("ข้อมูลเพิ่มเติม");
    expect(view.element.textContent).toContain("ไม่มีข้อมูล");
    await view.unmount();
  });

  it("renders an empty-state action only when both label and handler exist", async () => {
    const action = vi.fn();
    const without = await renderPage(<Empty message="No records" actionLabel="Retry" />);
    expect(without.element.querySelector("button")).toBeNull();
    await without.unmount();

    const withAction = await renderPage(<Empty message="No records" actionLabel="Retry" onAction={action} />);
    (withAction.element.querySelector("button") as HTMLButtonElement).click();
    expect(action).toHaveBeenCalledOnce();
    await withAction.unmount();
  });

  it("renders metric labels and values", async () => {
    const view = await renderPage(<Metric label="Embryos" value={12} />);
    expect(view.element.textContent).toContain("Embryos");
    expect(view.element.textContent).toContain("12");
    await view.unmount();
  });
});
