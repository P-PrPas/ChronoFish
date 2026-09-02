// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceId, mutationHeaders, operatorId, request } from "../src/api/client";

describe("API write context", () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("persists one UUID v7 device identifier", () => {
    const first = deviceId();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deviceId()).toBe(first);
    expect(localStorage.getItem("chronofish.device_id")).toBe(first);
  });

  it("keeps the selected operator in the browser session and sends both identifiers", () => {
    sessionStorage.setItem("chronofish.operator_id", "operator-a");
    localStorage.setItem("chronofish.device_id", "device-a");

    expect(operatorId()).toBe("operator-a");
    expect(mutationHeaders("request-a")).toEqual({
      "X-Operator-Id": "operator-a",
      "X-Device-Id": "device-a",
      "X-Idempotency-Key": "request-a",
    });
  });

  it("rejects every mutation before network access when no operator is selected", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(request("/batches", { method: "POST", body: "{}" })).rejects.toThrow("OPERATOR_REQUIRED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves structured API error details for row-level feedback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { message: "CSV needs changes", details: { rows: [{ row: 3, message: "duplicate stage" }] } },
            }),
            { status: 422, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    await expect(request("/timing-profiles/csv")).rejects.toMatchObject({
      message: "CSV needs changes",
      status: 422,
      details: { rows: [{ row: 3, message: "duplicate stage" }] },
    });
  });
});
