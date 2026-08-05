import { describe, expect, it } from "vitest";
import { parkingServiceInternals, ViewportFeature } from "./parkingService";

const mondayMorning = new Date("2026-07-20T09:00:00-04:00");
const mondayNoon = new Date("2026-07-20T12:00:00-04:00");

function rule(status: "free" | "paid" | "no_parking" | "unknown", startMinute = 0, endMinute = 1440) {
  return { status, confidence: 0.95, reason: status, source: "golden-test", dayMask: 127, startMinute, endMinute };
}

describe("interval parking classification", () => {
  it("requires explicit evidence covering the complete interval before returning free", () => {
    expect(parkingServiceInternals.classifyInterval(
      [rule("free")], mondayMorning, mondayNoon
    )).toMatchObject({ status: "free", coverage: "full" });
    expect(parkingServiceInternals.classifyInterval(
      [rule("free", 540, 600)], mondayMorning, mondayNoon
    )).toMatchObject({ status: "unknown" });
  });

  it("returns cannot park when any confirmed prohibition overlaps", () => {
    expect(parkingServiceInternals.classifyInterval([
      rule("free"), rule("no_parking", 600, 660)
    ], mondayMorning, mondayNoon).status).toBe("cannot_park");
  });

  it("returns unknown when unresolved evidence overlaps otherwise paid time", () => {
    expect(parkingServiceInternals.classifyInterval([
      rule("paid"), rule("unknown")
    ], mondayMorning, mondayNoon).status).toBe("unknown");
  });

  it("returns paid when the complete legal interval is resolved and any portion is paid", () => {
    expect(parkingServiceInternals.classifyInterval([
      rule("free", 0, 600), rule("paid", 600, 1440)
    ], mondayMorning, mondayNoon)).toMatchObject({ status: "paid", coverage: "full" });
  });

  it("uses an explicit public-data baseline outside paid hours while preserving paid precedence", () => {
    const freeBaseline = { ...rule("free"), source: "nyc-sign-meter-free-reference", confidence: 0.65 };
    const paidWindow = { ...rule("paid", 540, 1140), source: "nyc-meters" };
    expect(parkingServiceInternals.classifyInterval([
      freeBaseline, paidWindow
    ], new Date("2026-07-20T20:00:00-04:00"), new Date("2026-07-20T22:00:00-04:00")))
      .toMatchObject({ status: "free", coverage: "full" });
    expect(parkingServiceInternals.classifyInterval([
      freeBaseline, paidWindow
    ], mondayMorning, mondayNoon)).toMatchObject({ status: "paid", coverage: "full" });
  });

  it("suspends paid sign text with the meter calendar on Sunday", () => {
    const sunday = new Date("2026-07-19T12:00:00-04:00");
    const sundayEnd = new Date("2026-07-19T13:00:00-04:00");
    expect(parkingServiceInternals.classifyInterval([
      { ...rule("free"), source: "nyc-sign-meter-free-reference" },
      { ...rule("paid"), source: "nyc-signs" }
    ], sunday, sundayEnd)).toMatchObject({ status: "free", coverage: "full" });
  });

  it("uses the NYC DOT calendar to suspend only tagged alternate-side rules", () => {
    const start = new Date("2026-07-23T09:00:00-04:00");
    const end = new Date("2026-07-23T10:00:00-04:00");
    const alternateSide = { ...rule("no_parking"), source: "nyc-signs:alternate-side" };
    expect(parkingServiceInternals.classifyInterval([
      rule("free"), alternateSide
    ], start, end)).toMatchObject({ status: "free", coverage: "full" });
    expect(parkingServiceInternals.classifyInterval([
      rule("free"), { ...rule("no_parking"), source: "nyc-signs" }
    ], start, end).status).toBe("cannot_park");
  });

  it("keeps seven-day restrictions active on a major legal holiday", () => {
    const start = new Date("2026-07-03T09:00:00-04:00");
    const end = new Date("2026-07-03T10:00:00-04:00");
    const weekdaysOnly = { ...rule("no_parking"), dayMask: 32, source: "nyc-signs" };
    expect(parkingServiceInternals.classifyInterval([rule("free"), weekdaysOnly], start, end).status).toBe("free");
    expect(parkingServiceInternals.classifyInterval([
      rule("free"), { ...rule("no_parking"), source: "nyc-signs" }
    ], start, end).status).toBe("cannot_park");
  });
});

describe("viewport performance policy", () => {
  it("caps broad zoom levels before querying and keeps more detail only at street zoom", () => {
    expect(parkingServiceInternals.viewportSegmentLimit(15)).toBe(500);
    expect(parkingServiceInternals.viewportSegmentLimit(16)).toBe(800);
    expect(parkingServiceInternals.viewportSegmentLimit(17)).toBe(1_100);
    expect(parkingServiceInternals.viewportSegmentLimit(18)).toBe(1_500);
    expect(parkingServiceInternals.viewportGeometryTolerance(16)).toBe(0.00001);
    expect(parkingServiceInternals.viewportGeometryTolerance(18)).toBe(0.0000025);
  });

  it("reuses a proximity request when only its redundant bounding box changes", () => {
    const base = {
      minLat: 40.73, minLng: -74, maxLat: 40.76, maxLng: -73.97,
      centerLat: 40.7484, centerLng: -73.9857, radiusMeters: 800, zoom: 16,
      start: mondayMorning, end: mondayNoon
    };
    expect(parkingServiceInternals.viewportCacheKey(base)).toBe(
      parkingServiceInternals.viewportCacheKey({
        ...base, minLat: 40.72, minLng: -74.01, maxLat: 40.77, maxLng: -73.96
      })
    );
  });

  it("removes evidence-heavy detail fields from the map transport contract", () => {
    const feature: ViewportFeature = {
      type: "Feature",
      id: "segment-1",
      geometry: { type: "LineString", coordinates: [[-73.98, 40.75], [-73.979, 40.751]] },
      properties: {
        blockfaceKey: "MN|A|B|N", status: "paid", color: "#F2C14E", confidence: 0.9,
        coverage: "full", geometryValidated: true, geometryBasis: "dot_approved_curb",
        recommendationEligible: true, ruleSummary: "Paid for the interval.",
        evidence: [{ source: "nyc-meters", reason: "Metered parking.", confidence: 0.9 }],
        sourceVersion: "run-1", sourceUpdatedAt: mondayMorning.toISOString(),
        interpretationVersion: "parking-rules-v3-public-reference", changes: [{ at: mondayMorning.toISOString(), status: "paid" }],
        nextChange: null, verifyPostedSigns: true, onStreet: "5 AVENUE", fromStreet: "A",
        toStreet: "B", sideOfStreet: "W", paidHours: "9 AM-7 PM", meterRate: "Zone M1"
      }
    };
    const compact = parkingServiceInternals.compactMapFeature(feature);
    expect(compact.properties).toMatchObject({ status: "paid", onStreet: "5 AVENUE" });
    expect(compact.properties).not.toHaveProperty("evidence");
    expect(compact.properties).not.toHaveProperty("changes");
    expect(compact.properties).not.toHaveProperty("sourceVersion");
  });
});
