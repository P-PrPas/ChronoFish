import { describe, expect, it } from "vitest";
import { analyticsFilters, filterQuery, parseFilters, updateFilterURL, withFilters } from "../src/filters";

describe("dashboard filter state", () => {
  it("round-trips supported URL filters and ignores unknown values", () => {
    const filters = parseFilters("?siteId=site-1&dateFrom=2026-01-01&unknown=discard");
    expect(filters).toEqual({ siteId: "site-1", dateFrom: "2026-01-01" });
    expect(filterQuery(filters)).toBe("siteId=site-1&dateFrom=2026-01-01");
    expect(withFilters("/analytics/kpi", filters)).toBe("/analytics/kpi?siteId=site-1&dateFrom=2026-01-01");
  });

  it("keeps only filters implemented by analytics endpoints", () => {
    expect(analyticsFilters(parseFilters("?siteId=site-1&status=DEAD&boxId=box-1"))).toEqual({ siteId: "site-1" });
  });

  it("trims whitespace, keeps declared query order, and appends with the correct separator", () => {
    expect(parseFilters("?siteId=%20%20&batchId=batch-1")).toEqual({ batchId: "batch-1" });
    expect(filterQuery({ siteId: "site-1", batchId: "batch-1", strain: "AB" })).toBe(
      "batchId=batch-1&siteId=site-1&strain=AB",
    );
    expect(withFilters("/analytics/kpi?summary=1", { siteId: "site-1" })).toBe(
      "/analytics/kpi?summary=1&siteId=site-1",
    );
    expect(withFilters("/analytics/kpi", {})).toBe("/analytics/kpi");
  });

  it("replaces filters without touching the hash", () => {
    window.history.pushState(null, "", "/dashboard#fish");
    updateFilterURL({ siteId: "site-1" });
    expect(window.location.search).toBe("?siteId=site-1");
    expect(window.location.hash).toBe("#fish");
  });
});
