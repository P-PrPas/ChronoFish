import { describe, expect, it } from "vitest";
import { uuidv7 } from "../src/uuidv7";

describe("uuidv7 client identifiers", () => {
  it("encodes the timestamp, version, and RFC variant", () => {
    const id = uuidv7(1700000000123, (bytes) => bytes.fill(0));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id.replaceAll("-", "").slice(0, 12)).toBe("018bcfe5687b");
  });

  it("generates unique values when called repeatedly", () => {
    const ids = new Set(Array.from({ length: 100 }, () => uuidv7()));
    expect(ids.size).toBe(100);
  });

  it("falls back to Math.random when crypto is unavailable", () => {
    const crypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    try {
      expect(uuidv7(1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: crypto });
    }
  });

  it("clamps a negative or fractional clock to a valid timestamp", () => {
    const timestamp = (value: string) => Number.parseInt(value.replaceAll("-", "").slice(0, 12), 16);
    expect(timestamp(uuidv7(-1))).toBe(0);
    expect(timestamp(uuidv7(1.9))).toBe(1);
  });
});
