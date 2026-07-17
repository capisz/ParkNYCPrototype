import { describe, expect, it } from "vitest";
import { parseParkingRule, statusAt } from "./parkingRuleParser";

describe("parking rule parser", () => {
  it("parses weekday restriction windows", () => {
    expect(parseParkingRule("NO PARKING MON-FRI 8AM-6PM")).toMatchObject({ status: "no_parking", dayMask: 62, startMinute: 480, endMinute: 1080 });
  });
  it("parses overnight windows", () => {
    expect(parseParkingRule("NO STANDING SAT 10PM-6AM")).toMatchObject({ status: "no_parking", startMinute: 1320, endMinute: 360 });
  });
  it("uses restriction precedence", () => {
    const rules = [parseParkingRule("METER MON-FRI 8AM-6PM"), parseParkingRule("NO PARKING MON-FRI 9AM-10AM")];
    expect(statusAt(rules, 1, 570)).toBe("no_parking");
  });
  it("never infers free from unknown text", () => expect(parseParkingRule("TRUCK LOADING ARROW").status).toBe("unknown"));
});
