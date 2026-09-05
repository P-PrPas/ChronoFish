// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Fish } from "../src/pages/fish";
import { text } from "../src/types";
import { withoutIndexedDB } from "./helpers";

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

const settle = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("fish record detail", () => {
  beforeEach(() => {
    withoutIndexedDB();
    sessionStorage.setItem("chronofish.operator_id", "operator-1");
  });
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens a registry record, traverses accessible tabs, and saves a specimen", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/fish?includeInactive=true"))
        return json({
          items: [
            {
              id: "fish-1",
              fishCode: "F-001",
              strain: "AB",
              dob: "2026-08-01",
              condition: "NORMAL",
              status: "ALIVE",
            },
          ],
        });
      if (path.endsWith("/fish/fish-1") && !init?.method)
        return json({
          id: "fish-1",
          fishCode: "F-001",
          strain: "AB",
          ageDays: 32,
          condition: "NORMAL",
          status: "ALIVE",
          fishBoxId: "box-1",
          observations: [{ id: "observation-1", observedOn: "2026-09-01", outcome: "ALIVE", condition: "NORMAL" }],
          specimens: [],
        });
      if (path.endsWith("/fish/fish-1/specimens") && init?.method === "POST") return json({ id: "specimen-1" });
      if (path.includes("/fish/roll-call")) return json({ items: [] });
      if (path.endsWith("/fish-boxes")) return json({ items: [{ id: "box-1", boxCode: "A-01" }] });
      return json({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "prompt",
      vi.fn(() => "transcription correction"),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);

    await act(async () => {
      root.render(<Fish t={text.en} />);
      await settle();
    });
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Fish registry")
        ?.click();
      await settle();
    });
    await act(async () => {
      (document.querySelector(".list-row") as HTMLButtonElement).click();
      await settle();
    });

    expect(document.body.textContent).toContain("F-001");
    expect(document.body.textContent).toContain("A-01");
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Correct")
        ?.click();
      await settle();
    });
    const correction = Array.from(document.querySelectorAll("form")).find((form) =>
      form.textContent?.includes("Correct"),
    ) as HTMLFormElement;
    const correctionReason = correction.querySelector("input") as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(correctionReason, "reviewed paper log");
      correctionReason.dispatchEvent(new Event("input", { bubbles: true }));
      correction.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      await settle();
    });
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => String(input).endsWith("/observations/fish/observation-1") && init?.method === "PATCH",
      ),
    ).toBe(true);
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Delete")
        ?.click();
      await settle();
    });
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).includes("/observations/fish/observation-1?reason=transcription%20correction") &&
          init?.method === "DELETE",
      ),
    ).toBe(true);
    const history = document.getElementById("fish-detail-tab-history") as HTMLButtonElement;
    await act(async () => {
      history.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      await settle();
    });
    expect(document.getElementById("fish-detail-tab-details")?.getAttribute("aria-selected")).toBe("true");

    const fishCode = Array.from(document.querySelectorAll("label"))
      .find((label) => label.textContent?.startsWith("Fish code"))
      ?.querySelector("input") as HTMLInputElement;
    await act(async () => {
      setValue?.call(fishCode, "F-009");
      fishCode.dispatchEvent(new Event("input", { bubbles: true }));
      fishCode.closest("form")?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      await settle();
    });
    expect(
      fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/fish/fish-1") && init?.method === "PATCH"),
    ).toBe(true);

    await act(async () => {
      (document.getElementById("fish-detail-tab-specimens") as HTMLButtonElement).click();
      await settle();
    });
    expect(document.body.textContent).toContain("No samples from this fish");
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Add specimen")
        ?.click();
      await settle();
    });
    const specimenCode = Array.from(document.querySelectorAll("label"))
      .find((label) => label.textContent?.startsWith("Specimen code"))
      ?.querySelector("input") as HTMLInputElement;
    await act(async () => {
      setValue?.call(specimenCode, "CL-F-001");
      specimenCode.dispatchEvent(new Event("input", { bubbles: true }));
      specimenCode.closest("form")?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      await settle();
    });

    expect(document.body.textContent).toContain("CL-F-001");
    const post = fetchMock.mock.calls.find(
      ([input, init]) => String(input).endsWith("/fish/fish-1/specimens") && init?.method === "POST",
    );
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      specimenCode: "CL-F-001",
      specimenType: "CAUDAL_FIN_CLIP",
    });
    root.unmount();
  });

  it("filters the registry client-side and supports arrow-key switching between care views", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("/fish/roll-call")) return json({ items: [] });
        if (path.includes("/fish?"))
          return json({
            items: [
              {
                id: "fish-1",
                fishCode: "F-001",
                strain: "AB",
                status: "ALIVE",
                condition: "NORMAL",
                dob: "2026-08-01",
              },
              {
                id: "fish-2",
                fishCode: "F-002",
                strain: "TU",
                status: "DEAD",
                condition: "ABNORMAL",
                dob: "2026-07-01",
              },
            ],
          });
        return json({ items: [] });
      }),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Fish t={text.en} />);
      await settle();
    });
    await act(async () => {
      (document.getElementById("fish-tab-registry") as HTMLButtonElement).click();
      await settle();
    });
    expect(document.body.textContent).toContain("F-001");
    expect(document.body.textContent).toContain("F-002");
    const search = Array.from(document.querySelectorAll("label"))
      .find((label) => label.textContent === "Search")
      ?.querySelector("input") as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(search, "F-001");
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("F-001");
    expect(document.body.textContent).not.toContain("F-002");
    await act(async () => {
      setValue?.call(search, "missing");
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("No fish match these filters");
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Clear filters")
        ?.click();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("F-002");
    await act(async () => {
      (document.getElementById("fish-tab-registry") as HTMLButtonElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
      await settle();
    });
    expect(document.getElementById("fish-tab-rollcall")?.getAttribute("aria-selected")).toBe("true");
    root.unmount();
  });

  it("renders Thai identity, observation, and specimen details for a clone fish", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("/fish/roll-call")) return json({ items: [] });
        if (path.includes("/fish?"))
          return json({
            items: [{ id: "fish-1", fishCode: "F-001", strain: "AB", status: "ALIVE", condition: "NORMAL" }],
          });
        if (path.endsWith("/fish/fish-1"))
          return json({
            id: "fish-1",
            fishCode: "F-001",
            strain: "AB",
            ageDays: 30,
            sex: "F",
            status: "ALIVE",
            condition: "NORMAL",
            fishBoxId: "box-1",
            observations: [
              { id: "observation-1", observedOn: "2026-09-01", outcome: "ALIVE", condition: "NORMAL", ageDays: 30 },
            ],
            specimens: [
              {
                id: "specimen-1",
                specimenCode: "CL-F-001",
                specimenKind: "CL",
                specimenType: "CAUDAL_FIN_CLIP",
                collectedOn: "2026-09-01",
                storage: "-80",
              },
            ],
          });
        if (path.endsWith("/fish-boxes")) return json({ items: [{ id: "box-1", boxCode: "A-01" }] });
        return json({ items: [] });
      }),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Fish t={text.th} />);
      await settle();
    });
    await act(async () => {
      (document.getElementById("fish-tab-registry") as HTMLButtonElement).click();
      await settle();
    });
    await act(async () => {
      (document.querySelector(".list-row") as HTMLButtonElement).click();
      await settle();
    });
    await act(async () => {
      (document.getElementById("fish-detail-tab-specimens") as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("CL-F-001");
    expect(document.body.textContent).toContain("A-01");
    root.unmount();
  });
});
