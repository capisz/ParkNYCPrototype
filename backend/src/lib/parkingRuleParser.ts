export type RuleStatus = "free" | "paid" | "no_parking" | "unknown";
export type ParsedRule = { status: RuleStatus; dayMask: number; startMinute: number; endMinute: number; confidence: number; reason: string; source: string };

const DAYS: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const ALL_DAYS = 127;
const TIME_TOKEN = "(?:\\d{1,2}(?::\\d{2})?\\s*(?:A|P)\\.?M\\.?|NOON|MIDNIGHT)";
const TIME_RANGE_SOURCE = `(${TIME_TOKEN})\\s*(?:-|TO)\\s*(${TIME_TOKEN})`;

function dayIndex(token: string): number | null {
  const upper = token.toUpperCase().slice(0, 3);
  return DAYS[upper] ?? null;
}

function dayMaskInfo(text: string): { mask: number; found: boolean } {
  let upper = text.toUpperCase();
  if (/\b(?:ALL DAYS|DAILY|7 DAYS)\b/.test(upper)) return { mask: ALL_DAYS, found: true };

  let excluded = 0;
  upper = upper.replace(/\bEXCEPT\s+(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUN|MON|TUE|WED|THU|FRI|SAT)\b/g, (_match, token: string) => {
    const index = dayIndex(token);
    if (index != null) excluded |= 1 << index;
    return " ";
  });

  let mask = 0;
  let found = false;
  const rangePattern = /\b(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUN|MON|TUE|WED|THU|FRI|SAT)\s*(?:-|TO|THRU)\s*(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUN|MON|TUE|WED|THU|FRI|SAT)\b/g;
  for (const match of upper.matchAll(rangePattern)) {
    const start = dayIndex(match[1]);
    const end = dayIndex(match[2]);
    if (start == null || end == null) continue;
    found = true;
    let cursor = start;
    for (let count = 0; count < 7; count += 1) {
      mask |= 1 << cursor;
      if (cursor === end) break;
      cursor = (cursor + 1) % 7;
    }
  }

  for (const [day, index] of Object.entries(DAYS)) {
    const full = day === "SUN" ? "SUNDAY" : day === "MON" ? "MONDAY" : day === "TUE" ? "TUESDAY" :
      day === "WED" ? "WEDNESDAY" : day === "THU" ? "THURSDAY" : day === "FRI" ? "FRIDAY" : "SATURDAY";
    if (new RegExp(`\\b(?:${day}|${full})\\b`).test(upper)) {
      mask |= 1 << index;
      found = true;
    }
  }

  if (!found && excluded !== 0) return { mask: ALL_DAYS & ~excluded, found: true };
  if (found) return { mask: mask & ~excluded, found: true };
  return { mask: ALL_DAYS, found: false };
}

function dayMask(text: string): number {
  return dayMaskInfo(text).mask;
}

function minute(token: string): number {
  const normalized = token.replace(/[.\s]/g, "").toUpperCase();
  if (normalized === "MIDNIGHT") return 0;
  if (normalized === "NOON") return 720;
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?([AP])M$/);
  if (!match) return 0;
  let hour = Number(match[1]) % 12;
  if (match[3] === "P") hour += 12;
  return hour * 60 + Number(match[2] ?? 0);
}

export function parseParkingRules(raw: string, source = "nyc-signs"): ParsedRule[] {
  const text = raw.replace(/\s+/g, " ").trim().toUpperCase();
  if (!text) return [{ status: "unknown", dayMask: ALL_DAYS, startMinute: 0, endMinute: 1440, confidence: 0.1, reason: "Empty rule text.", source }];
  const alternateSide = /\b(?:STREET CLEANING|ALTERNATE SIDE|ASP|SANITATION|BROOM)\b/.test(text);
  const interpretedSource = alternateSide ? `${source}:alternate-side` : source;
  const requiresExternalContext = [
    /\bSCHOOL DAYS?\b/,
    /\b(?:HOLIDAYS?|SUSPEND(?:ED|SION)?)\b/,
    /\b(?:TEMPORARY|CONSTRUCTION|WORK ZONE|EVENT|SNOW|EMERGENCY)\b/,
    /\b(?:AUTHORIZED|PERMIT|COMMERCIAL VEHICLES?|TRUCKS?|LOADING|BUS (?:STOP|LANE|ONLY))\b/,
    /\b(?:ARROW|LEFT OF SIGN|RIGHT OF SIGN|BEGIN|END)\b|[←→↔]/
  ].find(pattern => pattern.test(text));
  if (requiresExternalContext) {
    return [{
      status: "unknown",
      dayMask: ALL_DAYS,
      startMinute: 0,
      endMinute: 1440,
      confidence: 0.1,
      reason: `Additional calendar, vehicle, permit, temporary-rule, or sign-placement context is required: ${raw}`,
      source: interpretedSource
    }];
  }
  const prohibited = /NO (?:STOPPING|STANDING|PARKING)/.test(text) || alternateSide;
  const paid = /METER|PAY(?:MENT)?|\b\d+\s*HMP\b/.test(text);
  const explicitlyAllowed = /PARKING PERMITTED|FREE PARKING/.test(text);
  const anytime = /\bANY\s*TIME\b|\bAT ALL TIMES\b/.test(text);
  const hasTemporalCue = /\b(?:SUN|MON|TUE|WED|THU|FRI|SAT)(?:DAY|SDAY|NESDAY|RSDAY|URDAY)?\b|\b(?:NOON|MIDNIGHT)\b|\d{1,2}(?::\d{2})?\s*[AP]\.?M\.?/.test(text);
  let status: RuleStatus = "unknown";
  const globalExclusions = dayMaskInfo(text.replace(/^.*?(?=EXCEPT\s)/, "")).mask;
  const rangePattern = new RegExp(TIME_RANGE_SOURCE, "g");
  const windows: Array<{ dayMask: number; startMinute: number; endMinute: number }> = [];
  let cursor = 0;
  let activeDayMask: number | null = null;
  for (const match of text.matchAll(rangePattern)) {
    const prefix = text.slice(cursor, match.index);
    const dayInfo = dayMaskInfo(prefix);
    if (dayInfo.found) activeDayMask = dayInfo.mask;
    if (activeDayMask == null) activeDayMask = ALL_DAYS;
    const parsedEnd = minute(match[2]);
    windows.push({
      dayMask: activeDayMask & globalExclusions,
      startMinute: minute(match[1]),
      endMinute: parsedEnd === 0 ? 1440 : parsedEnd
    });
    cursor = (match.index ?? cursor) + match[0].length;
  }

  if (prohibited && (windows.length > 0 || anytime || (!hasTemporalCue && !alternateSide))) status = "no_parking";
  else if (paid && windows.length > 0) status = "paid";
  else if (explicitlyAllowed && (windows.length > 0 || !hasTemporalCue)) status = "free";

  if (status !== "unknown" && windows.length > 0) {
    return windows.map(window => ({
      status,
      ...window,
      confidence: /\b\d+\s*HMP\b/.test(text) ? 0.86 : 0.9,
      reason: raw.trim(),
      source: interpretedSource
    }));
  }

  return [{
    status,
    dayMask: dayMask(text),
    startMinute: 0,
    endMinute: 1440,
    confidence: status === "unknown" ? 0.2 : anytime ? 0.95 : 0.55,
    reason: status === "unknown"
      ? alternateSide
        ? `Alternate-side rule needs a recognized day and time window: ${raw}`
        : `Unrecognized parking rule: ${raw}`
      : raw.trim(),
    source: interpretedSource
  }];
}

export function parseParkingRule(raw: string, source = "nyc-signs"): ParsedRule {
  return parseParkingRules(raw, source)[0];
}

export function statusAt(rules: ParsedRule[], day: number, minuteOfDay: number): RuleStatus {
  const active = rules.filter(rule => (rule.dayMask & (1 << day)) !== 0 && (rule.startMinute <= rule.endMinute ? minuteOfDay >= rule.startMinute && minuteOfDay < rule.endMinute : minuteOfDay >= rule.startMinute || minuteOfDay < rule.endMinute));
  const rank: Record<RuleStatus, number> = { no_parking: 4, paid: 3, free: 2, unknown: 1 };
  return active.sort((a, b) => rank[b.status] - rank[a.status] || b.confidence - a.confidence)[0]?.status ?? "unknown";
}
