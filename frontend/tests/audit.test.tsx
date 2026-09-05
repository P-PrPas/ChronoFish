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

  it("appends the next opaque cursor page and removes the control at the end", async () => {
    const second = { ...entry, id: "01900000-0000-7000-8000-000000000304", recordId: "next-record" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [entry], nextCursor: "opaque-cursor" }))
      .mockResolvedValueOnce(json({ items: [second], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);

    await act(async () => {
      root.render(<Audit t={text.en} />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const loadMore = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Load more",
    );
    await act(async () => {
      loadMore?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(String(fetchMock.mock.calls[1][0])).toContain("cursor=opaque-cursor");
    expect(document.body.textContent).toContain("next-record");
    expect(Array.from(document.querySelectorAll("button")).some((button) => button.textContent === "Load more")).toBe(
      false,
    );
    root.unmount();
  });

  it("keeps filters visible when the server rejects an audit query", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: { message: "Invalid cursor" } }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);

    await act(async () => {
      root.render(<Audit t={text.en} />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.body.textContent).toContain("Invalid cursor");
    expect(document.querySelector("form input")).not.toBeNull();
    root.unmount();
  });

  it("localizes multiple audit actions and record types in Thai", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          items: [
            { ...entry, id: "audit-1", action: "INSERT", tableName: "experiment_batch" },
            { ...entry, id: "audit-2", action: "UPDATE", tableName: "clone_fish", operatorName: "Tech One" },
            { ...entry, id: "audit-3", action: "DELETE", tableName: "specimen", oldValues: { code: "CL-1" } },
          ],
          nextCursor: "next-page",
        }),
      ),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Audit t={text.th} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelectorAll(".audit-row")).toHaveLength(3);
    expect(document.body.textContent).toContain("Tech One");
    expect(
      Array.from(document.querySelectorAll("button")).some((button) => button.textContent === text.th.loadMore),
    ).toBe(true);
    root.unmount();
  });
});
