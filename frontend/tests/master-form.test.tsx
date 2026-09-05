// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Master, MasterCatalog } from "../src/pages/master";
import { text } from "../src/types";
import { withoutIndexedDB } from "./helpers";

describe("master data form", () => {
  beforeEach(() => {
    withoutIndexedDB();
    sessionStorage.setItem("chronofish.operator_id", "operator-1");
  });
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("blocks an empty required master field before submission", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [] }))),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Master t={text.en} />);
      await Promise.resolve();
    });

    const form = document.querySelector<HTMLFormElement>(".master-catalog form");
    expect(form?.checkValidity()).toBe(false);
    expect(document.querySelectorAll('.admin-toolbar [aria-pressed="true"]')).toHaveLength(1);
    root.unmount();
  });

  it("recovers from master loading and queued-write failures", async () => {
    let rejectOperators: (error: Error) => void = () => undefined;
    let operatorRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (!String(input).endsWith("/operators")) return new Response(JSON.stringify({ items: [] }));
        operatorRequests += 1;
        if (operatorRequests === 1)
          return new Promise<Response>((_resolve, reject) => {
            rejectOperators = reject;
          });
        return new Response(JSON.stringify({ items: [{ id: "operator-1", name: "Operator A" }] }));
      }),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    act(() => root.render(<MasterCatalog />));

    expect(document.querySelector('[role="status"]')?.textContent).toContain("Loading");
    await act(async () => {
      rejectOperators(new Error("Network unavailable"));
      await Promise.resolve();
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Network unavailable");

    const retry = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Retry");
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Operator A");
    expect(operatorRequests).toBe(2);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("chronofish:queue-rejected", {
          detail: { path: "/operators/operator-1", lastError: "Operator changed on the server" },
        }),
      );
      await Promise.resolve();
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Operator changed on the server");
    expect(operatorRequests).toBe(3);
    root.unmount();
  });

  it("renders every configured resource with its allowed enum fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [{ id: "site-1", code: "KU", active: true }] }))),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<MasterCatalog t={text.en} />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const expected = [
      ["Operators", ["Name"]],
      ["Donor cell lines", ["Strain", "Preparation", "Batch code"]],
      ["Recipient egg lots", ["Breed", "Lot date", "Label"]],
      ["CSOF lots", ["Lot code"]],
      ["Treatment groups", ["Code", "Name", "Arm type"]],
      ["Fish boxes", ["Box code", "Site ID"]],
    ];
    for (const [tab, fields] of expected) {
      await act(async () => {
        Array.from(document.querySelectorAll(".admin-toolbar button"))
          .find((button) => button.textContent === tab)
          ?.click();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      for (const field of fields) expect(document.body.textContent).toContain(field);
    }
    expect(Array.from(document.querySelectorAll("option")).map((option) => option.textContent)).toEqual(
      expect.arrayContaining(["Select", "KU"]),
    );
    root.unmount();
  });

  it("creates, edits, and retires a lab site through its audited mutation paths", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/sites") && !init?.method)
        return new Response(JSON.stringify({ items: [{ id: "site-1", code: "KU", name: "KUVTH", active: true }] }));
      return new Response(JSON.stringify({ id: "ok" }));
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
      root.render(<Master t={text.en} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    const siteForm = document.querySelector(".admin-layout > section form") as HTMLFormElement;
    const [code, name] = Array.from(siteForm.querySelectorAll("input")) as HTMLInputElement[];
    await act(async () => {
      setValue?.call(code, "VET");
      code.dispatchEvent(new Event("input", { bubbles: true }));
      setValue?.call(name, "Veterinary Lab");
      name.dispatchEvent(new Event("input", { bubbles: true }));
      siteForm.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const create = fetchMock.mock.calls.find(
      ([input, init]) => String(input).endsWith("/sites") && init?.method === "POST",
    );
    expect(JSON.parse(String(create?.[1]?.body))).toEqual({ code: "VET", name: "Veterinary Lab" });
    expect(document.body.textContent).toContain("Saved");

    const siteRow = Array.from(document.querySelectorAll(".admin-layout > section .list-row")).find((row) =>
      row.textContent?.includes("KUVTH"),
    ) as HTMLElement;
    await act(async () => {
      Array.from(siteRow.querySelectorAll("button"))
        .find((button) => button.textContent === "Edit")
        ?.click();
      await Promise.resolve();
    });
    const editForm = Array.from(document.querySelectorAll("form")).find((form) =>
      form.textContent?.includes("Editing code"),
    ) as HTMLFormElement;
    const editName = editForm.querySelectorAll("input")[1] as HTMLInputElement;
    await act(async () => {
      setValue?.call(editName, "KUVTH Updated");
      editName.dispatchEvent(new Event("input", { bubbles: true }));
      editForm.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/sites/site-1") && init?.method === "PATCH"),
    ).toBe(true);

    await act(async () => {
      Array.from(siteRow.querySelectorAll("button"))
        .find((button) => button.textContent === "Inactivate")
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) => String(input).endsWith("/sites/site-1") && init?.method === "PATCH",
      ),
    ).toHaveLength(2);
    expect(siteRow.textContent).toContain("inactive");
    root.unmount();
  });

  it("creates a treatment group using its enum and site-backed catalog controls", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/treatment-groups") && init?.method === "POST")
        return new Response(JSON.stringify({ id: "treatment-1" }));
      if (String(input).endsWith("/sites"))
        return new Response(JSON.stringify({ items: [{ id: "site-1", code: "KU" }] }));
      return new Response(JSON.stringify({ items: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<MasterCatalog t={text.en} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      Array.from(document.querySelectorAll(".admin-toolbar button"))
        .find((button) => button.textContent === "Treatment groups")
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const form = document.querySelector(".master-catalog form") as HTMLFormElement;
    const [code, name] = Array.from(form.querySelectorAll("input")) as HTMLInputElement[];
    const arm = form.querySelector("select") as HTMLSelectElement;
    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    await act(async () => {
      setInput?.call(code, "SCNT");
      code.dispatchEvent(new Event("input", { bubbles: true }));
      setInput?.call(name, "Cloning");
      name.dispatchEvent(new Event("input", { bubbles: true }));
      setSelect?.call(arm, "SCNT");
      arm.dispatchEvent(new Event("change", { bubbles: true }));
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const create = fetchMock.mock.calls.find(
      ([input, init]) => String(input).endsWith("/treatment-groups") && init?.method === "POST",
    );
    expect(JSON.parse(String(create?.[1]?.body))).toEqual({ code: "SCNT", name: "Cloning", armType: "SCNT" });
    root.unmount();
  });

  it("edits and retires reusable master records without deleting history", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/operators") && !init?.method)
        return new Response(JSON.stringify({ items: [{ id: "operator-1", name: "Tech One", active: true }] }));
      return new Response(JSON.stringify({ id: "ok" }));
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
      root.render(<MasterCatalog t={text.en} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const row = document.querySelector(".list-row") as HTMLElement;
    await act(async () => {
      Array.from(row.querySelectorAll("button"))
        .find((button) => button.textContent === "Edit")
        ?.click();
      await Promise.resolve();
    });
    const edit = Array.from(document.querySelectorAll("form")).find((form) =>
      form.textContent?.includes("Edit Operators"),
    ) as HTMLFormElement;
    const input = edit.querySelector("input") as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(input, "Tech Two");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      edit.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const update = fetchMock.mock.calls.find(
      ([input, init]) => String(input).endsWith("/operators/operator-1") && init?.method === "PATCH",
    );
    expect(JSON.parse(String(update?.[1]?.body))).toEqual({ name: "Tech Two" });
    await act(async () => {
      Array.from(row.querySelectorAll("button"))
        .find((button) => button.textContent === "Inactivate")
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(row.textContent).toContain("inactive");
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) => String(input).endsWith("/operators/operator-1") && init?.method === "PATCH",
      ),
    ).toHaveLength(2);
    root.unmount();
  });

  it("keeps Thai site and catalog editing controls reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith("/sites"))
          return new Response(JSON.stringify({ items: [{ id: "site-1", code: "KU", name: "KUVTH", active: true }] }));
        if (path.endsWith("/operators"))
          return new Response(JSON.stringify({ items: [{ id: "operator-1", name: "Tech One", active: true }] }));
        if (path.endsWith("/treatment-groups"))
          return new Response(JSON.stringify({ items: [{ id: "treatment-1", code: "SCNT", armType: "SCNT" }] }));
        return new Response(JSON.stringify({ items: [] }));
      }),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<Master t={text.th} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      (document.querySelector(".admin-layout > section .inline-action") as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(document.querySelectorAll(".admin-layout > section form").length).toBeGreaterThan(2);
    await act(async () => {
      (document.querySelectorAll(".admin-toolbar button")[4] as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelectorAll(".master-catalog select")).toHaveLength(1);
    root.unmount();
  });
});
