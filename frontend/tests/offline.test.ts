import { describe, expect, it } from "vitest";
import { nextAttemptAt, queuedHeaders, retryDelay, writeIdentity } from "../src/offline";

describe("offline retry policy", () => {
  it("uses bounded exponential backoff", () => {
    expect(retryDelay(0)).toBe(1_000);
    expect(retryDelay(1)).toBe(2_000);
    expect(retryDelay(10)).toBe(900_000);
    expect(retryDelay(99)).toBe(900_000);
  });

  it("calculates the next attempt from a supplied clock", () => {
    expect(nextAttemptAt(2, 10_000)).toBe(14_000);
    expect(nextAttemptAt(2, 10_000, () => 1)).toBe(14_400);
  });

  it("replays the original operator, device, and idempotency key", () => {
    expect(
      queuedHeaders({ contentType: "application/json", operatorId: "operator-a", deviceId: "device-a", key: "key-a" }),
    ).toEqual({
      "Content-Type": "application/json",
      "X-Operator-Id": "operator-a",
      "X-Device-Id": "device-a",
      "X-Idempotency-Key": "key-a",
    });
  });

  it("applies bounded jitter and defaults a missing content type", () => {
    expect(retryDelay(0, () => 0)).toBe(900);
    expect(retryDelay(0, () => 1)).toBe(1_100);
    expect(retryDelay(99, () => 1)).toBe(900_000);
    expect(
      queuedHeaders({ contentType: "", operatorId: "operator-a", deviceId: "device-a", key: "key-a" })["Content-Type"],
    ).toBe("application/json");
  });

  it("ignores client UUIDs and object key order while separating operators and devices", () => {
    const first = writeIdentity(
      "/batches",
      "POST",
      { batch: { code: "A", clientUuid: "one" }, rows: [{ id: 1 }] },
      "a",
      "d",
    );
    const same = writeIdentity(
      "/batches",
      "post",
      { rows: [{ id: 1 }], batch: { clientUuid: "two", code: "A" } },
      "a",
      "d",
    );
    expect(first).toBe(same);
    expect(writeIdentity("/batches", "POST", { batch: { code: "A" } }, "b", "d")).not.toBe(first);
    expect(writeIdentity("/batches", "POST", { batch: { code: "A" } }, "a", "other")).not.toBe(first);
  });
});
