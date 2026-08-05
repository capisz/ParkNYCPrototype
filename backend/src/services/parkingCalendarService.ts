import { config } from "../config";

export type ParkingCalendarState = {
  date: string;
  alternateSideParking: "in_effect" | "suspended" | "unknown";
  meterRules: "in_effect" | "suspended" | "unknown";
  reason: string;
  majorLegalHoliday: boolean;
};

export type ParkingCalendarContext = {
  source: {
    agency: "NYC DOT";
    name: "Alternate Side Parking Suspension Calendar";
    year: number;
    url: string;
  };
  days: ParkingCalendarState[];
  advisory: string;
};

type Suspension = { reason: string; majorLegalHoliday?: boolean };

// Versioned from the NYC DOT 2026 Alternate Side Parking Suspension Calendar.
// The planner fails to "unknown" for years without a reviewed calendar snapshot.
const SUSPENSIONS_2026: Record<string, Suspension> = {
  "2026-01-01": { reason: "New Year's Day", majorLegalHoliday: true },
  "2026-01-06": { reason: "Three Kings' Day" },
  "2026-01-19": { reason: "Martin Luther King, Jr.'s Birthday" },
  "2026-02-12": { reason: "Lincoln's Birthday" },
  "2026-02-16": { reason: "Washington's Birthday and Lunar New Year's Eve" },
  "2026-02-17": { reason: "Lunar New Year" },
  "2026-02-18": { reason: "Ash Wednesday and Losar" },
  "2026-03-03": { reason: "Purim" },
  "2026-03-20": { reason: "Idul-Fitr" },
  "2026-03-21": { reason: "Idul-Fitr" },
  "2026-04-02": { reason: "Holy Thursday and Passover" },
  "2026-04-03": { reason: "Good Friday and Passover" },
  "2026-04-08": { reason: "Passover (7th Day)" },
  "2026-04-09": { reason: "Passover (8th Day) and Orthodox Holy Thursday" },
  "2026-04-10": { reason: "Orthodox Good Friday" },
  "2026-05-14": { reason: "Solemnity of the Ascension" },
  "2026-05-22": { reason: "Shavuoth (1st Day)" },
  "2026-05-23": { reason: "Shavuoth (2nd Day)" },
  "2026-05-25": { reason: "Memorial Day", majorLegalHoliday: true },
  "2026-05-27": { reason: "Idul-Adha" },
  "2026-05-28": { reason: "Idul-Adha" },
  "2026-06-19": { reason: "Juneteenth" },
  "2026-07-03": { reason: "Independence Day (observed)", majorLegalHoliday: true },
  "2026-07-04": { reason: "Independence Day", majorLegalHoliday: true },
  "2026-07-23": { reason: "Tisha B'Av" },
  "2026-08-15": { reason: "Feast of the Assumption" },
  "2026-09-07": { reason: "Labor Day", majorLegalHoliday: true },
  "2026-09-12": { reason: "Rosh Hashanah" },
  "2026-09-13": { reason: "Rosh Hashanah" },
  "2026-09-21": { reason: "Yom Kippur" },
  "2026-09-26": { reason: "Succoth (1st Day)" },
  "2026-09-27": { reason: "Succoth (2nd Day)" },
  "2026-10-03": { reason: "Shemini Atzereth" },
  "2026-10-04": { reason: "Simchas Torah" },
  "2026-10-12": { reason: "Columbus Day" },
  "2026-11-01": { reason: "All Saints' Day" },
  "2026-11-03": { reason: "Election Day" },
  "2026-11-08": { reason: "Diwali" },
  "2026-11-11": { reason: "Veterans Day" },
  "2026-11-26": { reason: "Thanksgiving Day", majorLegalHoliday: true },
  "2026-12-08": { reason: "Immaculate Conception" },
  "2026-12-25": { reason: "Christmas Day", majorLegalHoliday: true }
};

function dateParts(at: Date): { key: string; weekday: string; year: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short"
  }).formatToParts(at);
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  const year = Number(value("year"));
  return { key: `${value("year")}-${value("month")}-${value("day")}`, weekday: value("weekday"), year };
}

export function parkingCalendarStateAt(at: Date): ParkingCalendarState {
  const { key, weekday, year } = dateParts(at);
  if (year !== 2026) {
    return {
      date: key,
      alternateSideParking: "unknown",
      meterRules: "unknown",
      reason: "No reviewed NYC DOT calendar snapshot is loaded for this year.",
      majorLegalHoliday: false
    };
  }

  const suspension = SUSPENSIONS_2026[key];
  if (suspension) {
    return {
      date: key,
      alternateSideParking: "suspended",
      meterRules: suspension.majorLegalHoliday ? "suspended" : "in_effect",
      reason: suspension.reason,
      majorLegalHoliday: suspension.majorLegalHoliday === true
    };
  }

  if (weekday === "Sun") {
    return {
      date: key,
      alternateSideParking: "suspended",
      meterRules: "suspended",
      reason: "Sunday",
      majorLegalHoliday: false
    };
  }

  return {
    date: key,
    alternateSideParking: "in_effect",
    meterRules: "in_effect",
    reason: "No scheduled suspension",
    majorLegalHoliday: false
  };
}

export function getParkingCalendarContext(start: Date, end: Date): ParkingCalendarContext {
  const dates = new Map<string, ParkingCalendarState>();
  const finalInstant = Math.max(start.getTime(), end.getTime() - 1);
  for (let instant = start.getTime(); instant <= finalInstant; instant += 60 * 60 * 1_000) {
    const state = parkingCalendarStateAt(new Date(instant));
    dates.set(state.date, state);
  }
  const last = parkingCalendarStateAt(new Date(finalInstant));
  dates.set(last.date, last);
  const year = Number([...dates.keys()][0]?.slice(0, 4) ?? new Date().getFullYear());
  return {
    source: {
      agency: "NYC DOT",
      name: "Alternate Side Parking Suspension Calendar",
      year,
      url: `https://www.nyc.gov/html/dot/html/motorist/alternate-side-parking.shtml`
    },
    days: [...dates.values()],
    advisory: "Calendar context changes only the rules NYC DOT says are suspended. Other signs, hydrants, physical exclusions, and temporary restrictions still apply."
  };
}

export function parkingCalendarWarnings(start: Date, end: Date): Array<{ code: string; message: string }> {
  const context = getParkingCalendarContext(start, end);
  const affected = context.days.filter(day => day.alternateSideParking !== "in_effect");
  if (affected.length === 0) {
    return [{
      code: "nyc_calendar_checked",
      message: "NYC DOT's scheduled parking calendar was checked for this interval. No scheduled alternate-side suspension overlaps it; emergency changes may still be announced through NYC 311."
    }];
  }
  return affected.map(day => {
    if (day.alternateSideParking === "unknown") {
      return {
        code: `nyc_calendar_unknown_${day.date}`,
        message: `${day.date}: ${day.reason} Check NYC 311 before relying on alternate-side or meter rules.`
      };
    }
    if (day.majorLegalHoliday) {
      return {
        code: `nyc_calendar_major_${day.date}`,
        message: `${day.reason}: NYC DOT lists alternate-side parking, meters, and eligible non-seven-day restrictions as suspended. Seven-day and physical restrictions still apply.`
      };
    }
    if (day.reason === "Sunday") {
      return {
        code: `nyc_calendar_sunday_${day.date}`,
        message: "Sunday calendar: alternate-side parking and meters are not in effect. Other signs, hydrants, and physical restrictions still apply."
      };
    }
    return {
      code: `nyc_calendar_asp_${day.date}`,
      message: `${day.reason}: alternate-side street-cleaning rules are suspended. Meters and all other restrictions remain in effect.`
    };
  });
}
