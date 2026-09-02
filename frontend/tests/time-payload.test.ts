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
});
