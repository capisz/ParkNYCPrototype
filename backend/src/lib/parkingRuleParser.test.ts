import { describe, expect, it } from "vitest";
import { parseParkingRule, statusAt } from "./parkingRuleParser";

describe("parking rule parser", () => {
  it("parses weekday restriction windows", () => {
    expect(parseParkingRule("NO PARKING MON-FRI 8AM-6PM")).toMatchObject({ status: "no_parking", dayMask: 62, startMinute: 480, endMinute: 1080 });
  });
  it("parses overnight windows", () => {
    expect(parseParkingRule("NO STANDING SAT 10PM-6AM")).toMatchObject({ status: "no_parking", startMinute: 1320, endMinute: 360 });
  });
  it("parses NYC noon and midnight schedule formats", () => {
    expect(parseParkingRule("NO PARKING TUESDAY MIDNIGHT-3AM")).toMatchObject({ status: "no_parking", startMinute: 0, endMinute: 180 });
    expect(parseParkingRule("NO PARKING FRIDAY 10:30AM-NOON")).toMatchObject({ status: "no_parking", startMinute: 630, endMinute: 720 });
  });
  it("does not treat locator labels or incomplete meter evidence as all-day paid parking", () => {
    expect(parseParkingRule("PAY-BY-CELL LOCATOR NUMBER").status).toBe("unknown");
    expect(parseParkingRule("METER").status).toBe("unknown");
  });
  it("recognizes explicit anytime restrictions", () => {
    expect(parseParkingRule("NO STANDING ANYTIME")).toMatchObject({ status: "no_parking", startMinute: 0, endMinute: 1440, confidence: 0.95 });
  });
  it("uses restriction precedence", () => {
    const rules = [parseParkingRule("METER MON-FRI 8AM-6PM"), parseParkingRule("NO PARKING MON-FRI 9AM-10AM")];
    expect(statusAt(rules, 1, 570)).toBe("no_parking");
  });
  it("never infers free from unknown text", () => expect(parseParkingRule("TRUCK LOADING ARROW").status).toBe("unknown"));
});
