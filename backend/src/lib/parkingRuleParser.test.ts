import { describe, expect, it } from "vitest";
import { parseParkingRule, parseParkingRules, statusAt } from "./parkingRuleParser";

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

  it("preserves separate weekday and Saturday meter windows", () => {
    expect(parseParkingRules("METER Monday-Friday 4 PM-10 PM, Saturday 8 AM-10 PM")).toMatchObject([
      { status: "paid", dayMask: 62, startMinute: 960, endMinute: 1320 },
      { status: "paid", dayMask: 64, startMinute: 480, endMinute: 1320 }
    ]);
  });

  it("preserves multiple rush-hour windows without punctuation", () => {
    expect(parseParkingRules("NO STANDING MONDAY-FRIDAY 7AM-10AM 4PM-7PM")).toMatchObject([
      { status: "no_parking", dayMask: 62, startMinute: 420, endMinute: 600 },
      { status: "no_parking", dayMask: 62, startMinute: 960, endMinute: 1140 }
    ]);
  });

  it("recognizes NYC HMP signs as paid parking and applies except days", () => {
    expect(parseParkingRules("2 HMP 9AM-7PM EXCEPT SUNDAY")).toMatchObject([
      { status: "paid", dayMask: 126, startMinute: 540, endMinute: 1140 }
    ]);
  });

  it("carries distinct day windows when commas are omitted", () => {
    expect(parseParkingRules("2 HMP MONDAY-FRIDAY 6PM-10PM SATURDAY 8AM-10PM")).toMatchObject([
      { status: "paid", dayMask: 62, startMinute: 1080, endMinute: 1320 },
      { status: "paid", dayMask: 64, startMinute: 480, endMinute: 1320 }
    ]);
  });

  it("keeps school-day restrictions unknown without a school calendar", () => {
    expect(parseParkingRule("NO STANDING SCHOOL DAYS 7AM-4PM")).toMatchObject({
      status: "unknown",
      dayMask: 127,
      confidence: 0.1
    });
  });

  it("recognizes scheduled alternate-side rules and tags them for calendar evaluation", () => {
    expect(parseParkingRule("NO PARKING STREET CLEANING MON 9AM-10:30AM")).toMatchObject({
      status: "no_parking",
      dayMask: 2,
      startMinute: 540,
      endMinute: 630,
      source: "nyc-signs:alternate-side"
    });
    expect(parseParkingRule("STREET CLEANING")).toMatchObject({
      status: "unknown",
      source: "nyc-signs:alternate-side"
    });
  });

  it("fails closed for rules that need external context", () => {
    for (const text of [
      "NO PARKING EXCEPT COMMERCIAL VEHICLES 7AM-10AM",
      "TEMPORARY NO STANDING",
      "NO PARKING RIGHT OF SIGN",
      "NO PARKING EXCEPT HOLIDAYS"
    ]) {
      expect(parseParkingRule(text).status).toBe("unknown");
    }
  });
});
