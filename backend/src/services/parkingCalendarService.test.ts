import { describe, expect, it } from "vitest";
import { getParkingCalendarContext, parkingCalendarStateAt, parkingCalendarWarnings } from "./parkingCalendarService";

describe("NYC parking calendar context", () => {
  it("distinguishes ASP-only suspensions from major legal holidays", () => {
    expect(parkingCalendarStateAt(new Date("2026-07-23T12:00:00-04:00"))).toMatchObject({
      alternateSideParking: "suspended",
      meterRules: "in_effect",
      reason: "Tisha B'Av"
    });
    expect(parkingCalendarStateAt(new Date("2026-07-04T12:00:00-04:00"))).toMatchObject({
      alternateSideParking: "suspended",
      meterRules: "suspended",
      majorLegalHoliday: true
    });
  });

  it("applies the official Sunday status without suppressing other restrictions", () => {
    const warnings = parkingCalendarWarnings(
      new Date("2026-07-19T10:00:00-04:00"),
      new Date("2026-07-19T12:00:00-04:00")
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("Other signs, hydrants, and physical restrictions still apply");
  });

  it("fails unknown outside the reviewed annual snapshot", () => {
    expect(parkingCalendarStateAt(new Date("2027-01-04T10:00:00-05:00"))).toMatchObject({
      alternateSideParking: "unknown",
      meterRules: "unknown"
    });
  });

  it("returns each local date covered by an overnight interval", () => {
    const context = getParkingCalendarContext(
      new Date("2026-07-22T23:30:00-04:00"),
      new Date("2026-07-23T01:30:00-04:00")
    );
    expect(context.days.map(day => day.date)).toEqual(["2026-07-22", "2026-07-23"]);
  });
});
