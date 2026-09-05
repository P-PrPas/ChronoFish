import { describe, expect, it } from "vitest";
import { dateTimeLocalToRFC3339, formatBangkokDateTime, rfc3339ToDateTimeLocal } from "../src/time";

describe("Bangkok datetime payloads", () => {
  it("submits datetime-local with an explicit +07:00 offset", () => {
    expect(dateTimeLocalToRFC3339("2026-08-21T09:30")).toBe("2026-08-21T09:30:00+07:00");
  });

  it("round-trips persisted RFC3339 timestamps into browser input format", () => {
    expect(rfc3339ToDateTimeLocal("2026-08-21T02:30:00Z")).toBe("2026-08-21T09:30");
  });

  it("displays persisted timestamps in Bangkok 24-hour time", () => {
    expect(formatBangkokDateTime("2026-08-21T17:30:00Z")).toBe("22/08/2026 00:30");
  });

  it("passes through a value that already carries an offset", () => {
    expect(dateTimeLocalToRFC3339("2026-01-01T01:30:00Z")).toBe("2026-01-01T01:30:00.000Z");
  });

  it("accepts seconds precision and empty datetime-local values", () => {
    expect(dateTimeLocalToRFC3339("2026-01-01T08:30:45")).toBe("2026-01-01T08:30:45+07:00");
    expect(dateTimeLocalToRFC3339("   ")).toBe("");
  });

  it("rejects malformed datetime-local values", () => {
    expect(() => dateTimeLocalToRFC3339("2026-1-1")).toThrow("Invalid datetime-local value");
    expect(() => dateTimeLocalToRFC3339("abc")).toThrow("Invalid datetime-local value");
  });

  it("round-trips across a Bangkok midnight boundary and formats blanks", () => {
    const local = "2026-01-02T00:05";
    expect(rfc3339ToDateTimeLocal(dateTimeLocalToRFC3339(local))).toBe(local);
    expect(formatBangkokDateTime("")).toBe("");
  });
});
