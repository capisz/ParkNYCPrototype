import { describe, expect, it } from "vitest";
import { rebuildRulesInternals } from "./rebuildRules";

const segment = {
  id: "segment-1",
  paid_hours: "MONDAY-SATURDAY 9AM-7PM",
  has_meter: true,
  signs: ["2 HOUR METERED PARKING MONDAY-SATURDAY 9AM-7PM"]
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
      signs: [...segment.signs, "NO STANDING SCHOOL DAYS 7AM-4PM -->"]
    });
    expect(rules.some(rule => rule.status === "unknown")).toBe(true);
    expect(rules.some(rule => rule.status === "free")).toBe(false);
  });

  it("ignores known informational companions but still requires a regulatory sign", () => {
    expect(rebuildRulesInternals.isInformationalSignPanel("PAY-BY-CELL LOCATOR NUMBER")).toBe(true);
    expect(rebuildRulesInternals.isInformationalSignPanel("BUS STOP SIGN NO STANDING <----->")).toBe(false);
    const rules = rebuildRulesInternals.rulesForSegment({
      ...segment,
      signs: ["PAY-BY-CELL LOCATOR NUMBER", "METERS ARE NOT IN EFFECT ABOVE TIMES"]
    });
    expect(rules.some(rule => rule.status === "free")).toBe(false);
  });
});
