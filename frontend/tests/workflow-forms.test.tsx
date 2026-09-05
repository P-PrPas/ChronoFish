// @vitest-environment happy-dom

import { indexedDB as fakeIndexedDB } from "fake-indexeddb";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Batches } from "../src/pages/batches";
import { Fish } from "../src/pages/fish";
import { Controls, Promotions, Timing } from "../src/pages/settings";
import { text } from "../src/types";
import { withoutIndexedDB } from "./helpers";

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

describe("lab workflow forms", () => {
  beforeEach(() => {
    withoutIndexedDB();
    sessionStorage.setItem("chronofish.operator_id", "operator-1");
  });
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("exposes required batch fields and foreign-key selectors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith("/batches")) return json({ items: [] });
        if (path.endsWith("/sites")) return json({ items: [{ id: "site-1", code: "LAB" }] });
        if (path.endsWith("/treatment-groups")) return json({ items: [{ id: "treatment-1", code: "SCNT" }] });
        if (path.endsWith("/recipient-egg-lots")) return json({ items: [] });
        if (path.endsWith("/csof-lots")) return json({ items: [] });
        if (path.endsWith("/donor-cell-lines")) return json({ items: [{ id: "donor-1", strain: "AB" }] });
        return json({ items: [] });
      }),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Batches t={text.en} />);
      await Promise.resolve();
    });
    document.querySelector("button.button--primary")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Recipient egg lot");
    expect(document.body.textContent).toContain("CSOF lot");
    expect(document.body.textContent).toContain("Treatment group");
    root.unmount();
  });

  it("offers activation for copied injection-lot drafts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith("/batches"))
          return json({ items: [{ id: "batch-1", batchCode: "B-1", experimentDate: "2026-08-23" }] });
        if (path.endsWith("/batches/batch-1"))
          return json({
            id: "batch-1",
            batchCode: "B-1",
            experimentDate: "2026-08-23",
            injectionLots: [{ id: "lot-1", lotNo: "1", donorCellLineId: "donor-1", activatedAt: null, nActivated: 0 }],
          });
        if (path.includes("/injection-lots/lot-1/embryos")) return json({ items: [] });
        if (path.endsWith("/donor-cell-lines")) return json({ items: [{ id: "donor-1", strain: "AB" }] });
        return json({ items: [] });
      }),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Batches t={text.en} />);
      await Promise.resolve();
    });
    await act(async () => {
      (document.querySelector(".list-row") as HTMLButtonElement)?.click();
      await Promise.resolve();
    });
    const activate = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Activate template"),
    );
    expect(activate).not.toBeUndefined();
    await act(async () => {
      activate?.click();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Activate injection lot template");
    root.unmount();
  });

  it("shows a 96-well planner, mobile fallback, and confirms before creating a lot", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/batches"))
        return json({ items: [{ id: "batch-1", batchCode: "B-1", experimentDate: "2026-08-23" }] });
      if (path.endsWith("/batches/batch-1"))
        return json({ id: "batch-1", batchCode: "B-1", experimentDate: "2026-08-23", injectionLots: [] });
      if (path.includes("/donor-cell-lines?")) return json({ items: [{ id: "donor-1", strain: "AB", active: true }] });
      return json({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Batches t={text.en} />);
      await Promise.resolve();
    });
    await act(async () => {
      (document.querySelector(".list-row") as HTMLButtonElement)?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Add injection lot"))
        ?.click();
      await Promise.resolve();
    });

    expect(document.querySelectorAll(".well-grid--plate .well")).toHaveLength(96);
    expect(document.querySelector(".well-list--mobile")).not.toBeNull();
    const lotForm = Array.from(document.querySelectorAll("form")).find((form) =>
      form.textContent?.includes("Injection lot"),
    );
    await act(async () => {
      lotForm?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
    root.unmount();
  });

  it("resolves inactive master data in historical batch details without offering it for new records", async () => {
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
                experimentDate: "2026-08-23",
                siteId: "site-old",
                operatorId: "operator-old",
                treatmentGroupId: "treatment-old",
              },
            ],
          });
        if (path.endsWith("/batches/batch-1"))
          return json({
            id: "batch-1",
            batchCode: "B-1",
            experimentDate: "2026-08-23",
            siteId: "site-old",
            operatorId: "operator-old",
            treatmentGroupId: "treatment-old",
            injectionLots: [
              {
                id: "lot-1",
                lotNo: "1",
                donorCellLineId: "donor-old",
                activatedAt: "2026-08-23T01:00:00Z",
                nActivated: 1,
              },
            ],
          });
        if (path.includes("/injection-lots/lot-1/embryos")) return json({ items: [] });
        if (path.endsWith("/sites?includeInactive=true"))
          return json({ items: [{ id: "site-old", code: "OLD", name: "Archived Lab", active: false }] });
        if (path.endsWith("/operators?includeInactive=true"))
          return json({ items: [{ id: "operator-old", name: "Archived Operator", active: false }] });
        if (path.endsWith("/treatment-groups?includeInactive=true"))
          return json({ items: [{ id: "treatment-old", code: "OLD-TX", name: "Archived Treatment", active: false }] });
        if (path.endsWith("/donor-cell-lines?includeInactive=true"))
          return json({ items: [{ id: "donor-old", strain: "Archived Donor", active: false }] });
        return json({ items: [] });
      }),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Batches t={text.en} />);
      await Promise.resolve();
    });
    await act(async () => {
      (document.querySelector(".list-row") as HTMLButtonElement)?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.body.textContent).toContain("Archived Lab");
    expect(document.body.textContent).toContain("Archived Operator");
    expect(document.body.textContent).toContain("Archived Treatment");
    expect(document.body.textContent).toContain("Archived Donor");
    expect(
      Array.from(document.querySelectorAll("option")).some((option) => option.textContent === "Archived Donor"),
    ).toBe(false);
    root.unmount();
  });

  it("never renders internal master IDs while batch names are loading", async () => {
    let resolveMasters: ((value: Response) => void) | undefined;
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
                experimentDate: "2026-08-23",
                siteId: "site-secret-id",
                operatorId: "operator-secret-id",
                treatmentGroupId: "treatment-secret-id",
              },
            ],
          });
        if (path.endsWith("/batches/batch-1"))
          return json({
            id: "batch-1",
            batchCode: "B-1",
            experimentDate: "2026-08-23",
            siteId: "site-secret-id",
            operatorId: "operator-secret-id",
            treatmentGroupId: "treatment-secret-id",
            injectionLots: [],
          });
        if (path.includes("?includeInactive=true"))
          return new Promise<Response>((resolve) => {
            resolveMasters = resolve;
          });
        return json({ items: [] });
      }),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Batches t={text.en} />);
      await Promise.resolve();
    });
    await act(async () => {
      (document.querySelector(".list-row") as HTMLButtonElement)?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain("site-secret-id");
    expect(document.body.textContent).not.toContain("operator-secret-id");
    expect(document.body.textContent).toContain("Loading");
    resolveMasters?.(json({ items: [] }));
    root.unmount();
  });

  it("edits the complete mutable batch record through the shared batch form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        const batch = {
          id: "batch-1",
          batchCode: "B-1",
          dayNo: 2,
          experimentDate: "2026-08-23",
          siteId: "site-1",
          operatorId: "operator-1",
          protocolId: "protocol-1",
          treatmentGroupId: "treatment-1",
          recipientEggLotId: "egg-1",
          csofLotId: "csof-1",
          clutchCode: "C-1",
          replicateNo: 2,
          incubationTempC: 28.5,
          notes: "baseline",
        };
        if (path.endsWith("/batches")) return json({ items: [batch] });
        if (path.endsWith("/batches/batch-1")) return json({ ...batch, injectionLots: [] });
        if (path.includes("/sites")) return json({ items: [{ id: "site-1", code: "LAB" }] });
        if (path.includes("/operators")) return json({ items: [{ id: "operator-1", name: "Tech" }] });
        if (path.includes("/protocols")) return json({ items: [{ id: "protocol-1", name: "SCNT" }] });
        if (path.includes("/treatment-groups")) return json({ items: [{ id: "treatment-1", code: "SCNT" }] });
        if (path.includes("/recipient-egg-lots")) return json({ items: [{ id: "egg-1", lotCode: "EGG-1" }] });
        if (path.includes("/csof-lots")) return json({ items: [{ id: "csof-1", lotCode: "CSOF-1" }] });
        if (path.includes("/donor-cell-lines")) return json({ items: [] });
        return json({ items: [] });
      }),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Batches t={text.en} />);
      await Promise.resolve();
    });
    await act(async () => {
      (document.querySelector(".list-row") as HTMLButtonElement)?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const edit = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Edit batch");
    await act(async () => {
      edit?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect((document.querySelector('[data-testid="batch-day-no"]') as HTMLInputElement).value).toBe("2");
    expect(document.body.textContent).toContain("Recipient egg lot");
    expect(document.body.textContent).toContain("Incubation");
    root.unmount();
  });

  it("exposes Bangkok roll-call outcomes and registry filters", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("/fish/roll-call"))
          return json({ items: [{ fishId: "fish-1", fishCode: "F-1", status: "ALIVE", condition: "NORMAL" }] });
        if (path.endsWith("/fish?includeInactive=true") || path.endsWith("/fish")) return json({ items: [] });
        return json({ items: [] });
      }),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Fish t={text.en} />);
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Bangkok date");
    expect(document.body.textContent).toContain("Frozen");
    const registryTab = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Fish registry",
    );
    await act(async () => {
      registryTab?.click();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("DOB from");
    expect(document.body.textContent).toContain("Treatment");
    root.unmount();
  });

  it("confirms selected pending promotions in one bulk request", async () => {
    const candidate = {
      embryoId: "embryo-1",
      embryoCode: "B-1_1_1",
      dob: "2026-08-18",
      strain: "AB",
      condition: "ABNORMAL",
      firstAbnormalStageLabel: "Day 5",
      suggestedFishCode: "No.1_Clone1-AB cell-18",
      suggestedRunningNo: 1,
    };
    let posted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/promotions/pending")) return json({ items: posted ? [] : [candidate] });
      if (path.includes("/fish-boxes")) return json({ items: [{ id: "box-1", boxCode: "A1" }] });
      if (path.endsWith("/promotions") && init?.method === "POST") {
        posted = true;
        return json({ items: [{ status: "created", fish: { id: "fish-1" } }] });
      }
      return json({ items: [] });
    });
    vi.stubGlobal("indexedDB", fakeIndexedDB);
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Promotions t={text.en} />);
      await Promise.resolve();
    });
    const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      checkbox.click();
      await Promise.resolve();
    });
    expect(document.querySelector('input[aria-label="Fish code B-1_1_1"]')?.hasAttribute("required")).toBe(true);
    const confirm = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Confirm selected"),
    );
    await act(async () => {
      confirm?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input, init]) => String(input).includes("/promotions") && init?.method === "POST"),
      ).toBe(true),
    );

    const post = fetchMock.mock.calls.find(
      ([input, init]) => String(input).includes("/promotions") && init?.method === "POST",
    );
    expect(post).not.toBeUndefined();
    expect(JSON.parse(String(post?.[1]?.body)).promotions).toHaveLength(1);
    await vi.waitFor(() => expect(document.body.textContent).toContain("No eligible embryo promotions"));
    root.unmount();
  });

  it("sends the daily roll-call draft in one request", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/fish/roll-call"))
        return json({
          items: [
            { fishId: "fish-1", fishCode: "F-1", status: "ALIVE", condition: "NORMAL", alreadyRecorded: false },
            { fishId: "fish-2", fishCode: "F-2", status: "ALIVE", condition: "ABNORMAL", alreadyRecorded: false },
          ],
        });
      return json({ items: [] });
    });
    vi.stubGlobal("indexedDB", fakeIndexedDB);
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Fish t={text.en} />);
      await Promise.resolve();
    });
    const save = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Save 2 fish");
    await act(async () => {
      save?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([input, init]) => String(input).includes("/observations/fish") && init?.method === "POST",
        ),
      ).toHaveLength(1),
    );

    const posts = fetchMock.mock.calls.filter(
      ([input, init]) => String(input).includes("/observations/fish") && init?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1]?.body)).observations).toHaveLength(2);
    root.unmount();
  });

  it("corrects an already-recorded roll-call outcome through the audit endpoint", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/fish/roll-call"))
        return json({
          items: [
            {
              fishId: "fish-1",
              fishCode: "F-1",
              status: "ALIVE",
              condition: "NORMAL",
              alreadyRecorded: true,
              observationId: "observation-1",
              recordedOutcome: "ALIVE",
            },
          ],
        });
      return json({ items: [] });
    });
    vi.stubGlobal("indexedDB", fakeIndexedDB);
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Fish t={text.en} />);
      await Promise.resolve();
    });

    const dead = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Dead");
    await act(async () => {
      dead?.click();
      await Promise.resolve();
    });
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => String(input).includes("/observations/fish/observation-1") && init?.method === "PATCH",
      ),
    ).toBe(false);
    const reason = document.querySelector('input[name="rollCallCorrectionReason"]') as HTMLInputElement;
    const setReason = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setReason?.call(reason, "corrected after review");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    const save = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Save 1 fish");
    await act(async () => {
      save?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) => String(input).includes("/observations/fish/observation-1") && init?.method === "PATCH",
        ),
      ).toBe(true),
    );

    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) => String(input).includes("/observations/fish/observation-1") && init?.method === "PATCH",
    );
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
      outcome: "DEAD",
      overrideReason: "corrected after review",
    });
    root.unmount();
  });

  it("sends a backdated roll-call range with an audit reason in one request", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/fish/roll-call")) {
        return json({
          items: [{ fishId: "fish-1", fishCode: "F-1", status: "ALIVE", condition: "NORMAL", alreadyRecorded: false }],
        });
      }
      return json({ items: [] });
    });
    vi.stubGlobal("indexedDB", fakeIndexedDB);
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Fish t={text.en} />);
      await Promise.resolve();
    });

    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    const start = document.querySelector('input[name="rollCallStart"]') as HTMLInputElement;
    const end = document.querySelector('input[name="rollCallEnd"]') as HTMLInputElement;
    await act(async () => {
      setInput?.call(start, "2026-08-20");
      start.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
      setInput?.call(end, "2026-08-22");
      end.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    const reason = document.querySelector('input[name="rollCallOverrideReason"]') as HTMLInputElement;
    await act(async () => {
      setInput?.call(reason, "weekend closure");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    const save = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Save 1 fish");
    await act(async () => {
      save?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) => String(input).includes("/observations/fish") && init?.method === "POST",
        ),
      ).toBe(true),
    );

    const post = fetchMock.mock.calls.find(
      ([input, init]) => String(input).includes("/observations/fish") && init?.method === "POST",
    );
    const observations = JSON.parse(String(post?.[1]?.body)).observations;
    expect(observations.map((item: { observedOn: string }) => item.observedOn)).toEqual([
      "2026-08-20",
      "2026-08-21",
      "2026-08-22",
    ]);
    expect(observations.every((item: { overrideReason?: string }) => item.overrideReason === "weekend closure")).toBe(
      true,
    );
    root.unmount();
  });

  it("collects an audit reason when manually registering an older fish", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/donor-cell-lines")) return json({ items: [{ id: "donor-1", strain: "AB" }] });
      if (path.includes("/fish/roll-call")) return json({ items: [] });
      return json({ items: [] });
    });
    vi.stubGlobal("indexedDB", fakeIndexedDB);
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Fish t={text.en} />);
      await Promise.resolve();
    });
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Register fish")
        ?.click();
      await Promise.resolve();
    });

    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    const form = Array.from(document.querySelectorAll("form")).find((item) =>
      item.textContent?.includes("Register clone fish"),
    ) as HTMLFormElement;
    const fishCode = Array.from(form.querySelectorAll("label"))
      .find((label) => label.textContent?.startsWith("Fish code"))
      ?.querySelector("input") as HTMLInputElement;
    const dob = Array.from(form.querySelectorAll("label"))
      .find((label) => label.textContent?.startsWith("DOB"))
      ?.querySelector("input") as HTMLInputElement;
    const donor = Array.from(form.querySelectorAll("label"))
      .find((label) => label.textContent?.startsWith("Donor"))
      ?.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      setInput?.call(fishCode, "legacy-fish");
      fishCode.dispatchEvent(new Event("input", { bubbles: true }));
      setInput?.call(dob, "2026-08-20");
      dob.dispatchEvent(new Event("input", { bubbles: true }));
      setSelect?.call(donor, "donor-1");
      donor.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    const reason = form.querySelector('input[name="manualFishOverrideReason"]') as HTMLInputElement;
    await act(async () => {
      setInput?.call(reason, "migrated paper record");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/fish") && init?.method === "POST"),
      ).toBe(true),
    );

    const post = fetchMock.mock.calls.find(
      ([input, init]) => String(input).endsWith("/fish") && init?.method === "POST",
    );
    expect(JSON.parse(String(post?.[1]?.body)).overrideReason).toBe("migrated paper record");
    root.unmount();
  });

  it("shows timing version history, old/new values, and confirms a new version", async () => {
    const current = {
      id: "profile-2",
      version: 2,
      name: "Current profile",
      isCurrent: true,
      createdAt: "2026-08-23T01:00:00Z",
      createdByOperatorId: "operator-1",
      entries: [
        { id: "stage-1", stageCode: "stage_01_1C", stageLabel: "Activated (1-cell)", stageOrder: 1, expectedHpa: 2.5 },
      ],
    };
    const archived = {
      id: "profile-1",
      version: 1,
      name: "Archived profile",
      isCurrent: false,
      createdAt: "2026-08-22T01:00:00Z",
      createdByOperatorId: "operator-2",
      entries: current.entries,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/protocols")) return json({ items: [{ id: "protocol-1", name: "Zebrafish SCNT" }] });
      if (path.includes("/operators?"))
        return json({
          items: [
            { id: "operator-1", name: "Tech One" },
            { id: "operator-2", name: "Tech Two" },
          ],
        });
      if (path.includes("/timing-profiles/current")) return json(current);
      if (path.includes("/timing-profiles?")) return json({ items: [current, archived] });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Timing />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.body.textContent).toContain("Protocol");
    expect(document.querySelector("select[required]")).not.toBeNull();
    expect(document.querySelector('input[aria-label="New HPA for stage_01_1C"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Current version 2");
    expect(document.body.textContent).toContain("Archived profile");
    expect(document.body.textContent).toContain("Tech One");
    expect(document.body.textContent).toContain("Current HPA");
    expect(document.body.textContent).toContain("New HPA");

    const input = document.querySelector('input[aria-label="New HPA for stage_01_1C"]') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(input, "2.75");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      document.querySelector("form")?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
    root.unmount();
  });

  it("localizes timing input names for Thai screen readers", async () => {
    const current = {
      id: "profile-1",
      version: 1,
      name: "Current profile",
      isCurrent: true,
      entries: [{ id: "stage-1", stageCode: "stage_01_1C", stageLabel: "Activated", stageOrder: 1, expectedHpa: 2.5 }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith("/protocols")) return json({ items: [{ id: "protocol-1", name: "SCNT" }] });
        if (path.includes("/timing-profiles/current")) return json(current);
        if (path.includes("/timing-profiles?")) return json({ items: [current] });
        return json({});
      }),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Timing t={text.th} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector('input[aria-label="HPA ใหม่ของ stage_01_1C"]')).not.toBeNull();
    root.unmount();
  });

  it("creates a new timing version only from the changed stages", async () => {
    sessionStorage.setItem("chronofish.operator_id", "operator-1");
    const current = {
      id: "profile-2",
      version: 2,
      name: "Current profile",
      isCurrent: true,
      entries: [
        { id: "stage-1", stageCode: "stage_01_1C", stageLabel: "Activated", stageOrder: 1, expectedHpa: 2.5 },
        { id: "stage-2", stageCode: "stage_02_2C", stageLabel: "2-cell", stageOrder: 2, expectedHpa: 3 },
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/protocols")) return json({ items: [{ id: "protocol-1", name: "SCNT" }] });
      if (path.includes("/operators?")) return json({ items: [] });
      if (path.includes("/timing-profiles/current")) return json(current);
      if (path.includes("/timing-profiles?")) return json({ items: [current] });
      if (path.endsWith("/timing-profiles") && init?.method === "POST") return json({ id: "profile-3" });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Timing t={text.en} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const input = document.querySelector('input[aria-label="New HPA for stage_02_2C"]') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(input, "3.5");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("form")?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const save = fetchMock.mock.calls.find(
      ([input, init]) => String(input).endsWith("/timing-profiles") && init?.method === "POST",
    );
    expect(JSON.parse(String(save?.[1]?.body))).toMatchObject({
      protocolId: "protocol-1",
      entries: [{ stageCode: "stage_02_2C", expectedHpa: 3.5 }],
    });
    root.unmount();
  });

  it("previews timing CSV rows before importing them", async () => {
    const current = {
      id: "profile-1",
      version: 1,
      name: "Current profile",
      isCurrent: true,
      entries: [
        { id: "stage-1", stageCode: "stage_01_1C", stageLabel: "Activated (1-cell)", stageOrder: 1, expectedHpa: 0 },
        { id: "stage-2", stageCode: "stage_02_2C", stageLabel: "2-cell", stageOrder: 2, expectedHpa: 0.75 },
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/protocols")) return json({ items: [{ id: "protocol-1", name: "Zebrafish SCNT" }] });
      if (path.includes("/timing-profiles/current")) return json(current);
      if (path.includes("/timing-profiles?")) return json({ items: [current] });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Timing />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(
      ['stage_order,stage_code,label,expected_hpa\n1,stage_01_1C,"Activated ""one""",0\n2,stage_02_2C,2-cell,0.8\n'],
      "timing.csv",
      { type: "text/csv" },
    );
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.body.textContent).toContain("CSV preview");
    expect(document.body.textContent).toContain("2 rows ready");
    expect(document.body.textContent).toContain('Activated "one"');
    expect(document.body.textContent).toContain("Import preview");
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
    root.unmount();
  });

  const invalidTimingCsvCases = [
    ["a wrong header", "wrong-header.csv", "stage,label\n1,Activated\n", "Row 1: expected header"],
    [
      "no data rows",
      "empty.csv",
      "stage_order,stage_code,label,expected_hpa\n",
      "CSV must contain at least one data row",
    ],
    [
      "an unclosed quoted value",
      "unclosed.csv",
      'stage_order,stage_code,label,expected_hpa\n1,"stage_01_1C,Activated,0\n',
      "unclosed quoted value",
    ],
    [
      "the wrong column count",
      "wrong-columns.csv",
      "stage_order,stage_code,label,expected_hpa\n1,stage_01_1C,Activated,0,extra\n",
      "must contain exactly 4 columns",
    ],
    [
      "a non-integer stage order",
      "invalid-stage-order.csv",
      "stage_order,stage_code,label,expected_hpa\nno,stage_01_1C,Activated,0\n",
      "stage_order must be an integer",
    ],
    [
      "a stage code that does not match its order",
      "mismatched-stage.csv",
      "stage_order,stage_code,label,expected_hpa\n2,stage_01_1C,Activated,0\n",
      "stage_code does not match stage_order",
    ],
    [
      "a duplicate stage",
      "duplicate-stage.csv",
      "stage_order,stage_code,label,expected_hpa\n1,stage_01_1C,Activated,0\n1,stage_01_1C,Activated again,0\n",
      "duplicate stage",
    ],
    [
      "a negative expected HPA",
      "negative-hpa.csv",
      "stage_order,stage_code,label,expected_hpa\n1,stage_01_1C,Activated,-1\n",
      "expected_hpa must be a number greater than or equal to 0",
    ],
  ] as const;

  it.each(invalidTimingCsvCases)("does not import a timing CSV with %s", async (_reason, name, body, expected) => {
    const current = {
      id: "profile-1",
      version: 1,
      name: "Current profile",
      isCurrent: true,
      entries: [
        { id: "stage-1", stageCode: "stage_01_1C", stageLabel: "Activated", stageOrder: 1, expectedHpa: 0 },
        { id: "stage-2", stageCode: "stage_02_2C", stageLabel: "2-cell", stageOrder: 2, expectedHpa: 0.75 },
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/protocols")) return json({ items: [{ id: "protocol-1", name: "Zebrafish SCNT" }] });
      if (path.includes("/operators?")) return json({ items: [] });
      if (path.includes("/timing-profiles/current")) return json(current);
      if (path.includes("/timing-profiles?")) return json({ items: [current] });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Timing />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([], name, { type: "text/csv" });
    Object.defineProperty(file, "text", { value: async () => body });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.body.textContent).toContain(expected);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
    root.unmount();
  });

  it("does not import an unreadable timing CSV", async () => {
    const current = {
      id: "profile-1",
      version: 1,
      name: "Current profile",
      isCurrent: true,
      entries: [],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/protocols")) return json({ items: [{ id: "protocol-1", name: "Zebrafish SCNT" }] });
      if (path.includes("/operators?")) return json({ items: [] });
      if (path.includes("/timing-profiles/current")) return json(current);
      if (path.includes("/timing-profiles?")) return json({ items: [current] });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Timing />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const file = new File([], "unreadable.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: async () => Promise.reject(new Error("file cannot be read")) });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.body.textContent).toContain("file cannot be read");
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
    root.unmount();
  });

  it("imports a validated timing CSV as an audited new version", async () => {
    sessionStorage.setItem("chronofish.operator_id", "operator-1");
    const current = {
      id: "profile-1",
      version: 1,
      name: "Current profile",
      isCurrent: true,
      entries: [{ id: "stage-1", stageCode: "stage_01_1C", stageLabel: "Activated", stageOrder: 1, expectedHpa: 0 }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/protocols")) return json({ items: [{ id: "protocol-1", name: "SCNT" }] });
      if (path.includes("/operators?")) return json({ items: [] });
      if (path.includes("/timing-profiles/current")) return json(current);
      if (path.includes("/timing-profiles?")) return json({ items: [current] });
      if (path.includes("/timing-profiles/csv") && init?.method === "POST") return json({ id: "profile-2" });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Timing t={text.en} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new File(["stage_order,stage_code,label,expected_hpa\n1,stage_01_1C,Activated,0.25\n"], "timing.csv")],
    });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Import preview")
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const imported = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).includes("/timing-profiles/csv?protocolId=protocol-1") && init?.method === "POST",
    );
    expect(imported?.[1]?.headers).toMatchObject({ "Content-Type": "text/csv" });
    expect(String(imported?.[1]?.body)).toContain("stage_01_1C");
    expect(document.body.textContent).not.toContain("CSV preview");
    root.unmount();
  });

  it("downloads the current timing standard as CSV", async () => {
    let downloadAttempts = 0;
    const profile = {
      id: "profile-1",
      version: 1,
      name: "Current profile",
      isCurrent: true,
      entries: [{ stageCode: "stage_01_1C", stageLabel: "Activated", expectedHpa: 2.5 }],
    };
    const createObjectURL = vi.fn(() => "blob:timing");
    const revokeObjectURL = vi.fn();
    const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/timing-profiles/current")) return json(profile);
      if (path.includes("/timing-profiles?")) return json({ items: [profile] });
      if (path.endsWith("/protocols")) return json({ items: [{ id: "protocol-1", name: "SCNT" }] });
      if (path.includes("/operators?")) return json({ items: [] });
      if (path.includes("/timing-profiles/csv")) {
        downloadAttempts += 1;
        return downloadAttempts === 1
          ? new Response("stage_order,stage_code,label,expected_hpa\n")
          : new Response("unavailable", { status: 503 });
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Timing t={text.en} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Download CSV")
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("/timing-profiles/csv?protocolId=protocol-1")),
    ).toBe(true);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Download CSV")
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.body.textContent).toContain("HTTP 503");
    if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate);
    else delete (URL as typeof URL & { createObjectURL?: unknown }).createObjectURL;
    if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
    else delete (URL as typeof URL & { revokeObjectURL?: unknown }).revokeObjectURL;
    root.unmount();
  });

  it("loads existing control rows and shows their totals", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith("/batches"))
          return json({ items: [{ id: "batch-1", batchCode: "B-1", protocolId: "protocol-1" }] });
        if (path.endsWith("/protocols")) return json({ items: [{ id: "protocol-1", name: "SCNT" }] });
        if (path.includes("/protocols/protocol-1/stages"))
          return json({ items: [{ code: "stage_19_SH", label: "Shield" }] });
        if (path.includes("/batches/batch-1/control-arm-counts"))
          return json({ items: [{ armType: "IVF", stageCode: "stage_19_SH", nNormal: 4, nAbnormal: 2 }] });
        return json({ items: [] });
      }),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Controls t={text.en} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(Array.from(document.querySelectorAll(".record-fact")).map((item) => item.textContent)).toEqual([
      "Normal total4",
      "Abnormal total2",
      "Grand total6",
    ]);
    expect((document.querySelector('input[type="number"]') as HTMLInputElement).value).toBe("4");
    root.unmount();
  });

  it("adds control arms, saves valid rows, and rejects an empty comparison grid", async () => {
    sessionStorage.setItem("chronofish.operator_id", "operator-1");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/batches"))
        return json({ items: [{ id: "batch-1", batchCode: "B-1", protocolId: "protocol-1" }] });
      if (path.endsWith("/protocols")) return json({ items: [{ id: "protocol-1", name: "SCNT" }] });
      if (path.includes("/protocols/protocol-1/stages"))
        return json({ items: [{ code: "stage_19_SH", label: "Shield" }] });
      if (path.includes("/control-arm-counts") && !init?.method) return json({ items: [] });
      return json({ id: "saved" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Controls t={text.en} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Add arm row")
        ?.click();
      await Promise.resolve();
    });
    const inputs = Array.from(document.querySelectorAll('input[type="number"]')) as HTMLInputElement[];
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      for (const [input, value] of [
        [inputs[0], "4"],
        [inputs[1], "1"],
        [inputs[2], "2"],
        [inputs[3], "0"],
      ] as const) {
        setValue?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      document
        .querySelector("form.control-form")
        ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const save = fetchMock.mock.calls.find(
      ([input, init]) => String(input).endsWith("/batches/batch-1/control-arm-counts") && init?.method === "POST",
    );
    expect(JSON.parse(String(save?.[1]?.body)).items).toEqual([
      { armType: "NATURAL_BREEDING", stageCode: "stage_01_1C", nNormal: 4, nAbnormal: 1 },
      { armType: "IVF", stageCode: "stage_19_SH", nNormal: 2, nAbnormal: 0 },
    ]);
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Remove")
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Remove")
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      document
        .querySelector("form.control-form")
        ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Use one row per arm and stage with non-negative whole counts");
    root.unmount();
  });

  it("saves populated control results with Thai feedback", async () => {
    sessionStorage.setItem("chronofish.operator_id", "operator-1");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/batches"))
        return json({ items: [{ id: "batch-1", batchCode: "B-1", protocolId: "protocol-1" }] });
      if (path.endsWith("/protocols")) return json({ items: [{ id: "protocol-1", name: "SCNT" }] });
      if (path.includes("/protocols/protocol-1/stages"))
        return json({ items: [{ code: "stage_01_1C", label: "Activated" }] });
      if (path.includes("/control-arm-counts") && !init?.method)
        return json({ items: [{ armType: "IVF", stageCode: "stage_01_1C", nNormal: 3, nAbnormal: 1 }] });
      return json({ id: "saved" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Controls t={text.th} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      document
        .querySelector("form.control-form")
        ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => String(input).endsWith("/batches/batch-1/control-arm-counts") && init?.method === "POST",
      ),
    ).toBe(true);
    expect(document.body.textContent).toContain(text.th.controlCountsSaved);
    root.unmount();
  });
});
