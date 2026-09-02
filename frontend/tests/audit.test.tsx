// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Audit } from "../src/pages/audit";
import { text } from "../src/types";

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const entry = {
  id: "01900000-0000-7000-8000-000000000301",
  tableName: "sites",
  recordId: "01900000-0000-7000-8000-000000000302",
  action: "UPDATE",
  operatorId: "01900000-0000-7000-8000-000000000303",
  deviceId: "ipad-01",
  occurredAt: "2026-08-24T03:00:00Z",
  oldValues: { name: "Before" },
  newValues: { name: "After" },
};

describe("audit history", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads change context and only applies filters on submit", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      json({ items: [entry], nextCursor: null, requested: String(input) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);

    await act(async () => {
      root.render(<Audit t={text.en} />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("24/08/2026 10:00");
    expect(document.body.textContent).not.toContain("2026-08-24T03:00:00Z");

    const clearButton = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Clear filters"),
    );
    await act(async () => {
      clearButton?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const table = document.querySelector("form input") as HTMLInputElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(table, "sites");
      table.dispatchEvent(new Event("input", { bubbles: true }));
      table.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      document.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain("table=sites");
    expect(document.body.textContent).toContain("ipad-01");
    expect(document.body.textContent).toContain('"Before"');
    expect(document.body.textContent).toContain('"After"');
    root.unmount();
  });
});
