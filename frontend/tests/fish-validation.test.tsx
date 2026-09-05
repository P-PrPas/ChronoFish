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

describe("fish record validation", () => {
  beforeEach(() => {
    withoutIndexedDB();
    sessionStorage.setItem("chronofish.operator_id", "operator-1");
  });
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("requires a correction reason before overwriting a recorded daily outcome", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/fish/roll-call"))
        return json({
          items: [
            {
              fishId: "fish-1",
              fishCode: "F-1",
              condition: "NORMAL",
              alreadyRecorded: true,
              observationId: "observation-1",
              recordedOutcome: "ALIVE",
            },
          ],
        });
      return json({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Fish t={text.en} />);
      await settle();
    });
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Dead")
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Save 1 fish")
        ?.click();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Correction reason is required");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    root.unmount();
  });

  it("registers a new clone fish through the live mutation path", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/fish/roll-call")) return json({ items: [] });
      if (path.endsWith("/donor-cell-lines")) return json({ items: [{ id: "donor-1", strain: "AB" }] });
      if (path.endsWith("/sites")) return json({ items: [{ id: "site-1", code: "KU" }] });
      if (path.endsWith("/fish-boxes")) return json({ items: [{ id: "box-1", boxCode: "A-01" }] });
      if (path.endsWith("/fish") && init?.method === "POST") return json({ id: "fish-1" });
      return json({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Fish t={text.en} />);
      await settle();
    });
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Register fish")
        ?.click();
      await settle();
    });
    const form = document.querySelector("form") as HTMLFormElement;
    const fishCode = Array.from(form.querySelectorAll("label"))
      .find((label) => label.textContent?.startsWith("Fish code"))
      ?.querySelector("input") as HTMLInputElement;
    const donor = Array.from(form.querySelectorAll("label"))
      .find((label) => label.textContent?.startsWith("Donor"))
      ?.querySelector("select") as HTMLSelectElement;
    const site = Array.from(form.querySelectorAll("label"))
      .find((label) => label.textContent?.startsWith("Site"))
      ?.querySelector("select") as HTMLSelectElement;
    const box = Array.from(form.querySelectorAll("label"))
      .find((label) => label.textContent?.startsWith("Fish box"))
      ?.querySelector("select") as HTMLSelectElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(fishCode, "F-100");
      fishCode.dispatchEvent(new Event("input", { bubbles: true }));
      for (const [select, value] of [
        [donor, "donor-1"],
        [site, "site-1"],
        [box, "box-1"],
      ] as const) {
        setSelect?.call(select, value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      await settle();
    });
    const create = fetchMock.mock.calls.find(
      ([input, init]) => String(input).endsWith("/fish") && init?.method === "POST",
    );
    expect(JSON.parse(String(create?.[1]?.body))).toMatchObject({
      fishCode: "F-100",
      donorCellLineId: "donor-1",
      siteId: "site-1",
      fishBoxId: "box-1",
    });
    root.unmount();
  });
});
