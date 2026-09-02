import { describe, expect, it } from "vitest";
import { text } from "../src/types";

describe("application copy", () => {
  it("keeps Thai and English copy keys aligned", () => {
    expect(Object.keys(text.th).sort()).toEqual(Object.keys(text.en).sort());
  });

  it("does not contain empty copy values", () => {
    expect([...Object.values(text.th), ...Object.values(text.en)].every((value) => value.trim().length > 0)).toBe(true);
  });
});
