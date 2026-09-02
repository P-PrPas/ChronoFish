// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiBase, deviceId, mutationHeaders, operatorId, request } from "../src/api/client";

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

  it("migrates a legacy localStorage operator into the session once", () => {
    localStorage.setItem("chronofish.operator_id", "legacy-operator");
    expect(operatorId()).toBe("legacy-operator");
    expect(sessionStorage.getItem("chronofish.operator_id")).toBe("legacy-operator");
    expect(localStorage.getItem("chronofish.operator_id")).toBeNull();
  });

  it("sends a fresh idempotency key unless the caller supplies one", () => {
    sessionStorage.setItem("chronofish.operator_id", "operator-a");
    expect(mutationHeaders()["X-Idempotency-Key"]).not.toBe(mutationHeaders()["X-Idempotency-Key"]);
    expect(mutationHeaders("known-key")["X-Idempotency-Key"]).toBe("known-key");
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

  it("adds write context only to mutations and JSON content type only to bodies", async () => {
    sessionStorage.setItem("chronofish.operator_id", "operator-a");
    localStorage.setItem("chronofish.device_id", "device-a");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await request("/health");
    await request("/sites", { method: "POST", body: "{}" });

    const getHeaders = fetchMock.mock.calls[0][1].headers;
    const postHeaders = fetchMock.mock.calls[1][1].headers;
    expect(getHeaders).toEqual({ Accept: "application/json" });
    expect(postHeaders).toMatchObject({
      "Content-Type": "application/json",
      "X-Operator-Id": "operator-a",
      "X-Device-Id": "device-a",
    });
  });

  it("keeps caller supplied headers and falls back for non-JSON errors", async () => {
    sessionStorage.setItem("chronofish.operator_id", "operator-a");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(
        new Response("server unavailable", { status: 500, headers: { "Content-Type": "text/plain" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await request("/timing-profiles/csv", { method: "POST", body: "csv", headers: { "Content-Type": "text/csv" } });
    await expect(request("/health")).rejects.toThrow("HTTP 500");
    expect(fetchMock.mock.calls[0][1].headers["Content-Type"]).toBe("text/csv");
  });

  it("uses the default API base URL in this build", () => {
    expect(apiBase).toBe("/api/v1");
  });
});
