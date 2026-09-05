// @vitest-environment happy-dom

import { indexedDB as fakeIndexedDB } from "fake-indexeddb";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { markInvalidFields } from "../src/App";
import { drainQueue, putQueue, rejectedQueueCount } from "../src/offline";
import { text } from "../src/types";
import { withoutIndexedDB } from "./helpers";

describe("browser shell workflows", () => {
  beforeEach(withoutIndexedDB);
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.location.hash = "";
  });

  it("keeps the lab navigation keyboard reachable and switches language", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("KUVTH Zebrafish LIMS");
    const navigation = document.querySelector('nav[aria-label="เมนูหลัก"]')!;
    expect(navigation).not.toBeNull();
    expect(navigation.querySelector("details summary")?.textContent).toContain("งานต่อเนื่องและรายงาน");
    expect(Array.from(navigation.querySelectorAll("button")).every((button) => button.tabIndex >= 0)).toBe(true);
    expect(document.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
    const language = document.querySelector<HTMLButtonElement>('[aria-label="เปลี่ยนภาษาเป็นอังกฤษ"]');
    expect(language?.textContent).toBe("EN");
    await act(async () => {
      language?.click();
      await Promise.resolve();
    });
    expect(document.querySelector("nav")?.textContent).toContain("Research results");
    root.unmount();
  });

  it("announces route changes and restores focus for history navigation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    vi.stubGlobal("scrollTo", vi.fn());
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
    });

    const batches = Array.from(document.querySelectorAll<HTMLButtonElement>("nav button")).find(
      (button) => button.textContent?.trim() === "การทดลอง",
    );
    await act(async () => {
      batches?.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(document.title).toBe("การทดลอง · KUVTH Zebrafish LIMS");
    expect(document.activeElement?.id).toBe("main-content");

    await act(async () => {
      window.history.pushState(null, "", `${window.location.pathname}#audit`);
      window.dispatchEvent(new PopStateEvent("popstate"));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(document.title).toBe("ตรวจสอบการแก้ไข · KUVTH Zebrafish LIMS");
    expect(document.activeElement?.id).toBe("main-content");
    const current = document.querySelector<HTMLButtonElement>('[aria-current="page"]')!;
    const pushState = vi.spyOn(window.history, "pushState");
    await act(async () => {
      current.click();
      await Promise.resolve();
    });
    expect(pushState).not.toHaveBeenCalled();
    await act(async () => {
      window.history.replaceState(null, "", `${window.location.pathname}#not-a-page`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await Promise.resolve();
    });
    expect(document.querySelector('[aria-current="page"]')?.textContent).toBe(current.textContent);
    root.unmount();
  });

  it("keeps a dropdown selection between its native input and change events", async () => {
    sessionStorage.setItem("chronofish.operator_id", "operator-1");
    window.location.hash = "#batches";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith("/operators"))
          return new Response(JSON.stringify({ items: [{ id: "operator-1", name: "Tech" }] }));
        if (path.endsWith("/sites"))
          return new Response(JSON.stringify({ items: [{ id: "site-1", code: "LAB", name: "Lab" }] }));
        if (path.endsWith("/protocols"))
          return new Response(JSON.stringify({ items: [{ id: "protocol-1", name: "SCNT" }] }));
        if (path.endsWith("/treatment-groups"))
          return new Response(JSON.stringify({ items: [{ id: "group-1", code: "SCNT" }] }));
        return new Response(JSON.stringify({ items: [] }));
      }),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>(".page-heading .button--primary")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(document.querySelector('option[value="site-1"]')).not.toBeNull());
    const site = document.querySelector<HTMLSelectElement>('select:has(option[value="site-1"])')!;

    await act(async () => {
      site.value = "site-1";
      site.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      site.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(site.value).toBe("site-1");
    root.unmount();
  });

  it("marks invalid required fields and links them to the error summary", () => {
    const form = document.createElement("form");
    form.innerHTML = "<label>รหัสสถานที่<input required></label><label>ชื่อสถานที่<input required></label>";
    document.body.append(form);
    const invalid = form.querySelector<HTMLInputElement>("input[required]");
    expect(markInvalidFields(form, "master", "th")).toHaveLength(2);
    expect(invalid?.getAttribute("aria-invalid")).toBe("true");
    expect(invalid?.getAttribute("aria-describedby")).toContain(`${invalid?.id}-error`);
    expect(invalid?.parentElement?.getAttribute("data-field-error")).toBe("กรุณากรอกหรือแก้ไขข้อมูลในช่องนี้");
    const secondForm = form.cloneNode(true) as HTMLFormElement;
    secondForm.querySelectorAll("input").forEach((input) => {
      input.removeAttribute("id");
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    });
    document.body.append(secondForm);
    const secondErrors = markInvalidFields(secondForm, "master", "th");
    expect(secondErrors[0]?.id).not.toBe(invalid?.id);
  });

  it("keeps existing accessibility references and gives English fallback labels to invalid fields", () => {
    const reservedId = document.createElement("span");
    reservedId.id = "invalid-fish-2";
    document.body.append(reservedId);
    const form = document.createElement("form");
    form.innerHTML = [
      '<input id="existing-code" required aria-label="Fish code" aria-describedby="format-hint">',
      '<textarea required aria-label="Observation notes"></textarea>',
      '<select required><option value="">Choose</option></select>',
      '<input required value="already valid">',
    ].join("");
    document.body.append(form);

    const errors = markInvalidFields(form, "fish", "en");
    const existing = form.querySelector<HTMLInputElement>("#existing-code")!;
    const generated = form.querySelector<HTMLSelectElement>("select")!;
    expect(errors.map((error) => error.label)).toEqual(["Fish code", "Observation notes", "Field 3"]);
    expect(existing.getAttribute("aria-describedby")).toBe("format-hint existing-code-error");
    expect(generated.id).toBe("invalid-fish-4");
    expect(errors.every((error) => error.message === "Enter or correct this field.")).toBe(true);
    expect(form.querySelector('input[value="already valid"]')?.hasAttribute("aria-invalid")).toBe(false);
  });

  it("keeps every workflow route and its Thai and English navigation label in sync", async () => {
    sessionStorage.setItem("chronofish.operator_id", "operator-1");
    localStorage.setItem("chronofish.language", "en");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const pages = [
      "dashboard",
      "due",
      "batches",
      "fish",
      "promotions",
      "controls",
      "timing",
      "master",
      "audit",
      "export",
    ] as const;
    const navigate = async (page: (typeof pages)[number]) => {
      await act(async () => {
        window.history.pushState(null, "", `/#${page}`);
        window.dispatchEvent(new PopStateEvent("popstate"));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      return Array.from(document.querySelectorAll('[aria-current="page"]'));
    };
    for (const page of pages) {
      const current = await navigate(page);
      expect(current.some((item) => item.textContent?.includes(text.en[page]))).toBe(true);
    }

    await act(async () => {
      document.querySelector<HTMLButtonElement>(".language")?.click();
      await Promise.resolve();
    });
    for (const page of pages) {
      const current = await navigate(page);
      expect(current.some((item) => item.textContent?.includes(text.th[page]))).toBe(true);
    }
    root.unmount();
  });

  it("renders populated Thai work queues across the connected laboratory workflows", async () => {
    sessionStorage.setItem("chronofish.operator_id", "operator-1");
    window.history.replaceState(null, "", "/#dashboard");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes("/analytics/dashboard"))
          return new Response(
            JSON.stringify({
              reportMeta: { generatedAt: "2026-09-02T01:00:00Z", timingProfileVersions: [1] },
              kpi: { stage1: { nActivated: 2, nPromoted: 1, controlComparison: [] }, stage2: { nAlive: 1 } },
              funnel: { items: [{ step: "Activated", count: 2 }] },
              survival: { items: [] },
              timingDeviation: { items: [] },
              abnormalityOnset: { items: [] },
              fishSurvival: { items: [] },
              observationGaps: { items: [] },
              pipeline: { items: [] },
            }),
          );
        if (path.includes("/fish/roll-call"))
          return new Response(JSON.stringify({ items: [{ fishId: "fish-1", fishCode: "F-1", condition: "NORMAL" }] }));
        if (path.includes("/promotions/pending"))
          return new Response(
            JSON.stringify({ items: [{ embryoId: "embryo-1", embryoCode: "B-1_1_1", condition: "ABNORMAL" }] }),
          );
        if (path.includes("/timing-profiles/current"))
          return new Response(
            JSON.stringify({
              id: "profile-1",
              version: 1,
              entries: [{ stageCode: "stage_01_1C", stageLabel: "Activated", expectedHpa: 2.5 }],
            }),
          );
        if (path.includes("/timing-profiles?")) return new Response(JSON.stringify({ items: [] }));
        if (path.includes("/control-arm-counts"))
          return new Response(
            JSON.stringify({ items: [{ armType: "IVF", stageCode: "stage_01_1C", nNormal: 1, nAbnormal: 0 }] }),
          );
        if (path.includes("/protocols/") && path.includes("/stages"))
          return new Response(JSON.stringify({ items: [{ code: "stage_01_1C", label: "Activated" }] }));
        if (path.endsWith("/batches"))
          return new Response(
            JSON.stringify({
              items: [{ id: "batch-1", batchCode: "B-1", experimentDate: "2026-09-01", protocolId: "protocol-1" }],
            }),
          );
        if (path.endsWith("/fish"))
          return new Response(
            JSON.stringify({ items: [{ id: "fish-1", fishCode: "F-1", status: "ALIVE", condition: "NORMAL" }] }),
          );
        if (path.endsWith("/sites"))
          return new Response(JSON.stringify({ items: [{ id: "site-1", code: "KU", name: "KUVTH" }] }));
        if (path.endsWith("/operators") || path.includes("/operators?"))
          return new Response(JSON.stringify({ items: [{ id: "operator-1", name: "Tech One" }] }));
        if (path.endsWith("/protocols"))
          return new Response(JSON.stringify({ items: [{ id: "protocol-1", name: "SCNT" }] }));
        if (path.endsWith("/fish-boxes"))
          return new Response(JSON.stringify({ items: [{ id: "box-1", boxCode: "A-01" }] }));
        return new Response(JSON.stringify({ items: [] }));
      }),
    );
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    for (const page of ["batches", "fish", "promotions", "controls", "timing", "master", "audit", "export"] as const) {
      await act(async () => {
        window.history.pushState(null, "", `/#${page}`);
        window.dispatchEvent(new PopStateEvent("popstate"));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(
        Array.from(document.querySelectorAll('[aria-current="page"]')).some((item) =>
          item.textContent?.includes(text.th[page]),
        ),
      ).toBe(true);
    }
    expect(document.body.textContent).toContain("B-1");
    root.unmount();
  });

  it("keeps rejected writes visible until the user reviews or discards them", async () => {
    vi.stubGlobal("indexedDB", fakeIndexedDB);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    localStorage.setItem("chronofish.operator_id", "operator-a");
    localStorage.setItem("chronofish.device_id", "device-a");
    await putQueue("/batches", { batchCode: "REJECTED" });

    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "invalid business state" } }), {
            status: 422,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    await drainQueue(true);
    expect(await rejectedQueueCount()).toBe(1);

    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    const root = createRoot(rootElement);
    await act(async () => {
      root.render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const language = document.querySelector<HTMLButtonElement>('[aria-label="เปลี่ยนภาษาเป็นอังกฤษ"]');
    await act(async () => {
      language?.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(document.querySelector(".queue")?.textContent).toBe("Pending 1"));
    expect(document.body.textContent).toContain("invalid business state");
    const review = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Open related page",
    );
    await act(async () => {
      review?.click();
      await Promise.resolve();
    });
    expect(document.querySelector('[aria-current="page"]')?.textContent).toBe("Experiments");
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const discard = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Discard rejected change",
    );
    await act(async () => {
      discard?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(document.querySelector(".queue")?.textContent).toBe("Saved"));
    expect(await rejectedQueueCount()).toBe(0);
    root.unmount();
  });
});
