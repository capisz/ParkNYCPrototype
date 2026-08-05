import { describe, expect, it } from "vitest";
import { sourceNeedsRefresh } from "./refreshSigns";

describe("sign source refresh decisions", () => {
  const upstream = new Date("2026-08-04T15:00:00Z");

  it("refreshes when no published revision exists", () => {
    expect(sourceNeedsRefresh(null, upstream)).toBe(true);
    expect(sourceNeedsRefresh(new Date("invalid"), upstream)).toBe(true);
  });

  it("refreshes when NYC has a newer source revision", () => {
    expect(sourceNeedsRefresh(new Date("2026-08-03T15:00:00Z"), upstream)).toBe(true);
  });

  it("keeps an equal or newer local revision", () => {
    expect(sourceNeedsRefresh(new Date("2026-08-04T15:00:00Z"), upstream)).toBe(false);
    expect(sourceNeedsRefresh(new Date("2026-08-05T15:00:00Z"), upstream)).toBe(false);
  });
});
