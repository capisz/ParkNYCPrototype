import { describe, expect, it } from "vitest";
import { evaluateMeterGeometryPilot } from "./meterGeometryPolicy";

function input(overrides: Partial<Parameters<typeof evaluateMeterGeometryPilot>[0]> = {}) {
  return {
    segmentSource: "meters:e7yp-wx55",
    configuredDatasetId: "e7yp-wx55",
    sideOfStreet: "W",
    paidHours: "Monday-Saturday 9 AM-7 PM",
    meterRate: "Zone M1",
    sourceRunId: "active-run",
    activeDatasetVersion: "active-run",
    datasetState: "fresh" as const,
    signsDatasetState: "missing" as const,
    classification: {
      status: "paid" as const,
      coverage: "full" as const,
      confidence: 0.78,
      evidence: [{ source: "nyc-meters", reason: "Metered parking.", confidence: 0.78 }]
    },
    ...overrides
  };
}

describe("bounded ParkNYC meter geometry policy", () => {
  it("allows fresh, active, side-specific meter geometry for yellow display only", () => {
    expect(evaluateMeterGeometryPilot(input())).toMatchObject({
      usableForPaidDisplay: true,
      usableForReferenceDisplay: true,
      displayStatus: "paid",
      geometryBasis: "official_meter_blockface",
      recommendationEligible: false
    });
  });

  it.each([
    ["prohibited status", { classification: { ...input().classification, status: "cannot_park" as const } }],
    ["partial interval", { classification: { ...input().classification, coverage: "partial" as const } }],
    ["stale snapshot", { datasetState: "stale" as const }],
    ["old run", { sourceRunId: "superseded-run" }],
    ["unknown side", { sideOfStreet: "C" }],
    ["missing schedule", { paidHours: "N/A" }],
    ["off-street facility", { meterRate: "Off-Street Parking" }]
  ])("rejects %s", (_label, overrides) => {
    expect(evaluateMeterGeometryPilot(input(overrides))).toMatchObject({
      usableForPaidDisplay: false,
      usableForReferenceDisplay: false,
      geometryBasis: "unvalidated",
      recommendationEligible: false
    });
  });

  it("allows a full-interval green public-data reference when both source snapshots are fresh", () => {
    const classification = {
      ...input().classification,
      status: "free" as const,
      confidence: 0.65,
      evidence: [{
        source: "nyc-sign-meter-free-reference",
        reason: "All linked public records resolve the interval.",
        confidence: 0.65
      }]
    };
    expect(evaluateMeterGeometryPilot(input({
      signsDatasetState: "fresh",
      classification
    }))).toMatchObject({
      usableForPaidDisplay: false,
      usableForProhibitedDisplay: false,
      usableForFreeDisplay: true,
      usableForReferenceDisplay: true,
      displayStatus: "free",
      geometryBasis: "official_meter_blockface",
      recommendationEligible: false
    });
  });

  it.each([
    ["stale signs", { signsDatasetState: "stale" as const }],
    ["missing explicit baseline", { classification: {
      ...input().classification,
      status: "free" as const,
      evidence: [{ source: "nyc-meters", reason: "Metered parking.", confidence: 0.78 }]
    } }],
    ["unresolved evidence", { classification: {
      ...input().classification,
      status: "free" as const,
      evidence: [
        { source: "nyc-sign-meter-free-reference", reason: "Resolved baseline.", confidence: 0.65 },
        { source: "nyc-signs", reason: "Unknown restriction.", confidence: 0.2 }
      ]
    } }]
  ])("keeps free gray with %s", (_label, overrides) => {
    const baseClassification = {
      ...input().classification,
      status: "free" as const,
      evidence: [{ source: "nyc-sign-meter-free-reference", reason: "Resolved baseline.", confidence: 0.65 }]
    };
    expect(evaluateMeterGeometryPilot(input({
      signsDatasetState: "fresh",
      classification: baseClassification,
      ...overrides
    }))).toMatchObject({
      usableForFreeDisplay: false,
      usableForReferenceDisplay: false,
      displayStatus: null
    });
  });

  it("rejects a paid result that depends on sign interpretation", () => {
    const classification = {
      ...input().classification,
      evidence: [
        ...input().classification.evidence,
        { source: "nyc-signs", reason: "Linked sign.", confidence: 0.7 }
      ]
    };
    expect(evaluateMeterGeometryPilot(input({ classification })).usableForPaidDisplay).toBe(false);
  });

  it("allows only a fresh, supported, high-confidence prohibition as reference red", () => {
    const classification = {
      ...input().classification,
      status: "cannot_park" as const,
      evidence: [
        input().classification.evidence[0],
        { source: "nyc-signs", reason: "NO STANDING MON-FRI 7AM-10AM", confidence: 0.9 }
      ]
    };
    expect(evaluateMeterGeometryPilot(input({
      signsDatasetState: "fresh",
      classification
    }))).toMatchObject({
      usableForPaidDisplay: false,
      usableForProhibitedDisplay: true,
      usableForReferenceDisplay: true,
      displayStatus: "cannot_park",
      geometryBasis: "official_meter_blockface",
      recommendationEligible: false
    });
  });

  it.each([
    ["stale signs", "stale", 0.9, "NO STANDING MON-FRI 7AM-10AM"],
    ["low-confidence sign", "fresh", 0.89, "NO STANDING"],
    ["unsupported sign", "fresh", 0.95, "AUTHORIZED VEHICLES ONLY"]
  ] as const)("keeps %s gray", (_label, signsDatasetState, confidence, reason) => {
    const classification = {
      ...input().classification,
      status: "cannot_park" as const,
      evidence: [{ source: "nyc-signs", reason, confidence }]
    };
    expect(evaluateMeterGeometryPilot(input({ signsDatasetState, classification }))).toMatchObject({
      usableForReferenceDisplay: false,
      displayStatus: null,
      geometryBasis: "unvalidated"
    });
  });
});
