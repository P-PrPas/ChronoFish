// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Batches } from "../src/pages/batches";
import { text } from "../src/types";

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

const settle = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("batch detail actions", () => {
  beforeEach(() => sessionStorage.setItem("chronofish.operator_id", "operator-1"));
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("duplicates a batch and manages embryos in an activated injection lot", async () => {
    const detail = {
      id: "batch-1",
      batchCode: "B-1",
      experimentDate: "2026-09-01",
      injectionLots: [
        { id: "lot-1", lotNo: "1", donorCellLineId: "donor-1", activatedAt: "2026-09-01T01:00:00Z", nActivated: 1 },
        { id: "lot-template", lotNo: "2", donorCellLineId: "donor-1", activatedAt: null, nActivated: 0 },
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/batches") && !init?.method) return json({ items: [detail] });
      if (path.endsWith("/batches/batch-1") && !init?.method) return json(detail);
      if (path.includes("/injection-lots/lot-1/embryos"))
        return json({
          items: [{ id: "embryo-1", injectionLotId: "lot-1", embryoCode: "B-1_1_1", wellPosition: "A1" }],
        });
      if (path.includes("/injection-lots/lot-template/embryos")) return json({ items: [] });
      if (path.endsWith("/donor-cell-lines?includeInactive=true"))
        return json({ items: [{ id: "donor-1", strain: "AB" }] });
      return json({ id: "ok" });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.stubGlobal(
      "prompt",
      vi.fn().mockReturnValueOnce("2026-09-02").mockReturnValueOnce("7").mockReturnValueOnce("duplicate entry"),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);

    await act(async () => {
      root.render(<Batches t={text.en} />);
      await settle();
    });
    await act(async () => {
      (document.querySelector(".list-row") as HTMLButtonElement).click();
      await settle();
    });
    expect(document.body.textContent).toContain("Lot 1");

    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "+ Add injection lot")
        ?.click();
      await settle();
    });
    const lotForm = document.querySelector("form.lot-builder") as HTMLFormElement;
    const donor = Array.from(lotForm.querySelectorAll("label"))
      .find((label) => label.textContent?.startsWith("Donor cell line"))
      ?.querySelector("select") as HTMLSelectElement;
    const activated = Array.from(lotForm.querySelectorAll("label"))
      .find((label) => label.textContent?.startsWith("Activated embryos"))
      ?.querySelector("input") as HTMLInputElement;
    const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setSelect?.call(donor, "donor-1");
      donor.dispatchEvent(new Event("change", { bubbles: true }));
      setValue?.call(activated, "2");
      activated.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    await act(async () => {
      (document.querySelectorAll(".well-grid .well")[0] as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await act(async () => {
      (document.querySelectorAll(".well-grid .well")[1] as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await act(async () => {
      lotForm.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      await settle();
    });
    const createLot = fetchMock.mock.calls.find(
      ([input, init]) => String(input).endsWith("/batches/batch-1/injection-lots") && init?.method === "POST",
    );
    expect(JSON.parse(String(createLot?.[1]?.body))).toMatchObject({
      donorCellLineId: "donor-1",
      nActivated: 2,
      wellPositions: ["A1", "A2"],
    });

    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Duplicate")
        ?.click();
      await settle();
    });
    const duplicate = fetchMock.mock.calls.find(
      ([input, init]) => String(input).endsWith("/batches/batch-1/duplicate") && init?.method === "POST",
    );
    expect(JSON.parse(String(duplicate?.[1]?.body))).toEqual({
      experimentDate: "2026-09-02",
      dayNo: 7,
      copyInjectionLots: true,
    });

    const additional = document.querySelector('input[type="number"][min="1"]') as HTMLInputElement;
    await act(async () => {
      setValue?.call(additional, "2");
      additional.dispatchEvent(new Event("input", { bubbles: true }));
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Add 2 embryos")
        ?.click();
      await settle();
    });
    const addEmbryos = fetchMock.mock.calls.find(
      ([input, init]) => String(input).endsWith("/injection-lots/lot-1/embryos") && init?.method === "POST",
    );
    expect(JSON.parse(String(addEmbryos?.[1]?.body))).toEqual({ count: 2 });

    const well = document.querySelector('select[aria-label="Well for B-1_1_1"]') as HTMLSelectElement;
    await act(async () => {
      setSelect?.call(well, "A2");
      well.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    });
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Clear well")
        ?.click();
      await settle();
    });
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) => String(input).endsWith("/embryos/embryo-1") && init?.method === "PATCH",
      ),
    ).toHaveLength(2);

    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Delete embryo")
        ?.click();
      await settle();
    });
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).includes("/embryos/embryo-1?reason=duplicate%20entry") && init?.method === "DELETE",
      ),
    ).toBe(true);
    root.unmount();
  });

  it("creates an experiment with typed optional batch metadata", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/batches") && !init?.method) return json({ items: [] });
      if (path.endsWith("/sites")) return json({ items: [{ id: "site-1", code: "KU", name: "KUVTH" }] });
      if (path.endsWith("/operators")) return json({ items: [{ id: "operator-1", name: "Tech One" }] });
      if (path.endsWith("/protocols")) return json({ items: [{ id: "protocol-1", name: "SCNT" }] });
      if (path.endsWith("/treatment-groups")) return json({ items: [{ id: "treatment-1", code: "SCNT" }] });
      if (path.endsWith("/recipient-egg-lots")) return json({ items: [{ id: "egg-1", label: "E-1" }] });
      if (path.endsWith("/csof-lots")) return json({ items: [{ id: "csof-1", lotCode: "C-1" }] });
      return json({ id: "batch-1" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Batches t={text.en} />);
      await settle();
    });
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "+ New experiment")
        ?.click();
      await settle();
    });
    const form = document.querySelector("form") as HTMLFormElement;
    const dayNo = form.querySelector('[data-testid="batch-day-no"]') as HTMLInputElement;
    const selects = Array.from(form.querySelectorAll("select")) as HTMLSelectElement[];
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(dayNo, "4");
      dayNo.dispatchEvent(new Event("input", { bubbles: true }));
      for (const [select, value] of [
        [selects[0], "operator-1"],
        [selects[1], "site-1"],
        [selects[2], "protocol-1"],
        [selects[3], "treatment-1"],
        [selects[4], "egg-1"],
        [selects[5], "csof-1"],
      ] as const) {
        setSelect?.call(select, value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await settle();
    });
    await act(async () => {
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      await settle();
    });
    const create = fetchMock.mock.calls.find(
      ([input, init]) => String(input).endsWith("/batches") && init?.method === "POST",
    );
    expect(JSON.parse(String(create?.[1]?.body))).toMatchObject({
      dayNo: 4,
      siteId: "site-1",
      operatorId: "operator-1",
      protocolId: "protocol-1",
      treatmentGroupId: "treatment-1",
      recipientEggLotId: "egg-1",
      csofLotId: "csof-1",
    });
    root.unmount();
  });

  it("refreshes the experiment list after sync and exposes a rejected queued batch", async () => {
    const fetchMock = vi.fn(async () =>
      json({ items: [{ id: "batch-1", batchCode: "B-1", experimentDate: "2026-09-01" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Batches t={text.en} />);
      await settle();
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("chronofish:queue-rejected", { detail: { path: "/batches", lastError: "Duplicate code" } }),
      );
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Duplicate code");
    await act(async () => {
      window.dispatchEvent(new Event("chronofish:queue-drained"));
      await settle();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    root.unmount();
  });

  it("renders populated experiment, lot, and plate-review details in Thai", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith("/batches"))
          return json({
            items: [
              {
                id: "batch-1",
                batchCode: "B-1",
                experimentDate: "2026-09-01",
                siteId: "site-1",
                operatorId: "operator-1",
                treatmentGroupId: "treatment-1",
              },
            ],
          });
        if (path.endsWith("/batches/batch-1"))
          return json({
            id: "batch-1",
            batchCode: "B-1",
            experimentDate: "2026-09-01",
            siteId: "site-1",
            operatorId: "operator-1",
            treatmentGroupId: "treatment-1",
            injectionLots: [
              {
                id: "lot-1",
                lotNo: "1",
                donorCellLineId: "donor-1",
                activatedAt: "2026-09-01T01:00:00Z",
                nActivated: 2,
              },
            ],
          });
        if (path.includes("/injection-lots/lot-1/embryos") && !init?.method)
          return json({
            items: [{ id: "embryo-1", injectionLotId: "lot-1", embryoCode: "B-1_1_1", wellPosition: "A1" }],
          });
        if (path.endsWith("/sites?includeInactive=true")) return json({ items: [{ id: "site-1", code: "KU" }] });
        if (path.endsWith("/operators?includeInactive=true"))
          return json({ items: [{ id: "operator-1", name: "Tech One" }] });
        if (path.endsWith("/treatment-groups?includeInactive=true"))
          return json({ items: [{ id: "treatment-1", code: "SCNT" }] });
        if (path.endsWith("/donor-cell-lines?includeInactive=true"))
          return json({ items: [{ id: "donor-1", strain: "AB" }] });
        return json({ items: [] });
      }),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Batches t={text.th} />);
      await settle();
    });
    await act(async () => {
      (document.querySelector(".list-row") as HTMLButtonElement).click();
      await settle();
    });
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("เพิ่มชุดตัวอ่อน"))
        ?.click();
      await settle();
    });
    expect(document.querySelectorAll(".well-grid .well")).toHaveLength(96);
    expect(document.body.textContent).toContain("B-1");
    root.unmount();
  });

  it("restores batch-detail state when a live embryo mutation is rejected", async () => {
    const batch = { id: "batch-1", batchCode: "B-1", experimentDate: "2026-09-01" };
    vi.stubGlobal(
      "prompt",
      vi.fn(() => "review correction"),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.endsWith("/batches") && !init?.method) return json({ items: [batch] });
        if (path.endsWith("/batches/batch-1") && !init?.method)
          return json({
            ...batch,
            injectionLots: [
              { id: "lot-1", lotNo: "1", donorCellLineId: "donor-1", activatedAt: "2026-09-01T01:00:00Z" },
            ],
          });
        if (path.includes("/injection-lots/lot-1/embryos") && !init?.method)
          return json({
            items: [{ id: "embryo-1", injectionLotId: "lot-1", embryoCode: "B-1_1_1", wellPosition: "A1" }],
          });
        if (path.includes("?includeInactive=true")) return json({ items: [] });
        if (init?.method)
          return new Response(JSON.stringify({ error: { message: "Rejected by laboratory rules" } }), {
            status: 422,
            headers: { "Content-Type": "application/json" },
          });
        return json({ items: [] });
      }),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Batches t={text.en} />);
      await settle();
    });
    await act(async () => {
      (document.querySelector(".list-row") as HTMLButtonElement).click();
      await settle();
    });
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Add 1 embryos")
        ?.click();
      await settle();
    });
    expect(document.body.textContent).toContain("Rejected by laboratory rules");
    const well = document.querySelector('select[aria-label="Well for B-1_1_1"]') as HTMLSelectElement;
    const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    await act(async () => {
      setSelect?.call(well, "A2");
      well.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    });
    expect(well.value).toBe("A1");
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Delete embryo")
        ?.click();
      await settle();
    });
    expect(document.body.textContent).toContain("B-1_1_1");
    root.unmount();
  });
});
