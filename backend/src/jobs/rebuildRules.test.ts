import { describe, expect, it } from "vitest";
import { rebuildRulesInternals } from "./rebuildRules";

function sign(description: string, arrowDirection: string | null = null) {
  return {
    description,
    arrowDirection,
    distanceFromIntersection: 40,
    xCoord: 996877,
    yCoord: 222815
  };
}

const segment = {
  id: "segment-1",
  paid_hours: "MONDAY-SATURDAY 9AM-7PM",
  has_meter: true,
  signs: [sign("2 HOUR METERED PARKING MONDAY-SATURDAY 9AM-7PM")]
};

describe("public-data free reference rule construction", () => {
  it("adds an explicit free baseline when every regulatory sign and the meter schedule are recognized", () => {
    const rules = rebuildRulesInternals.rulesForSegment(segment);
    expect(rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "paid", source: "nyc-meters" }),
      expect.objectContaining({
        status: "free",
        source: rebuildRulesInternals.PUBLIC_DATA_FREE_REFERENCE_SOURCE,
        dayMask: 127,
        startMinute: 0,
        endMinute: 1440
      })
    ]));
    expect(rules.some(rule => rule.status === "paid" && rule.source === "nyc-signs")).toBe(false);
  });

  it("does not publish free when a linked regulatory sign is unresolved", () => {
    const rules = rebuildRulesInternals.rulesForSegment({
      ...segment,
      signs: [...segment.signs, sign("NO STANDING SCHOOL DAYS 7AM-4PM -->")]
    });
    expect(rules.some(rule => rule.status === "unknown")).toBe(true);
    expect(rules.some(rule => rule.status === "free")).toBe(false);
  });

  it("ignores known informational companions but still requires a regulatory sign", () => {
    expect(rebuildRulesInternals.isInformationalSignPanel("PAY-BY-CELL LOCATOR NUMBER")).toBe(true);
    expect(rebuildRulesInternals.isInformationalSignPanel("BUS STOP SIGN NO STANDING <----->")).toBe(false);
    const rules = rebuildRulesInternals.rulesForSegment({
      ...segment,
      signs: [sign("PAY-BY-CELL LOCATOR NUMBER"), sign("METERS ARE NOT IN EFFECT ABOVE TIMES")]
    });
    expect(rules.some(rule => rule.status === "free")).toBe(false);
  });

  it("adds an assumed-free baseline to a non-metered blockface with complete sign evidence", () => {
    const rules = rebuildRulesInternals.rulesForSegment({
      id: "segment-2",
      paid_hours: null,
      has_meter: false,
      signs: [sign("NO PARKING MON-FRI 8AM-6PM")]
    });
    expect(rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "no_parking", source: "nyc-signs" }),
      expect.objectContaining({
        status: "free",
        source: rebuildRulesInternals.PUBLIC_DATA_ASSUMED_FREE_SOURCE
      })
    ]));
  });

  it("uses supplied arrow metadata without treating the whole day as unknown", () => {
    const rules = rebuildRulesInternals.rulesForSegment({
      ...segment,
      signs: [sign("NO PARKING MON-FRI 8AM-6PM (SINGLE ARROW)", "E")]
    });
    expect(rules.some(rule => rule.status === "unknown")).toBe(false);
    expect(rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "no_parking", startMinute: 480, endMinute: 1080 }),
      expect.objectContaining({ status: "free" })
    ]));
  });

  it("keeps a directional sign gray when its direction metadata is missing", () => {
    const rules = rebuildRulesInternals.rulesForSegment({
      ...segment,
      signs: [sign("NO PARKING MON-FRI 8AM-6PM (SINGLE ARROW)")]
    });
    expect(rules.some(rule => rule.status === "unknown")).toBe(true);
    expect(rules.some(rule => rule.status === "free")).toBe(false);
  });

  it("recognizes the bidirectional ASCII arrow syntax used by NYC signs", () => {
    const parsed = rebuildRulesInternals.parserTextForSign(
      sign("2 HMP SATURDAY 8AM-7PM <->")
    );
    expect(parsed).toEqual({
      text: "2 HMP SATURDAY 8AM-7PM",
      directionalReference: true
    });
  });

  it("requires source direction metadata for a one-way ASCII arrow", () => {
    expect(rebuildRulesInternals.parserTextForSign(
      sign("NO PARKING MON-FRI 8AM-6PM -->")
    )).toMatchObject({ directionalReference: false });
    expect(rebuildRulesInternals.parserTextForSign(
      sign("NO PARKING MON-FRI 8AM-6PM -->", "West")
    )).toEqual({
      text: "NO PARKING MON-FRI 8AM-6PM",
      directionalReference: true
    });
  });
});
