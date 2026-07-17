export type RuleStatus = "free" | "paid" | "no_parking" | "unknown";
export type ParsedRule = { status: RuleStatus; dayMask: number; startMinute: number; endMinute: number; confidence: number; reason: string; source: string };

const DAYS: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const ALL_DAYS = 127;
const TIME_TOKEN = "(?:\\d{1,2}(?::\\d{2})?\\s*(?:A|P)\\.?M\\.?|NOON|MIDNIGHT)";
const TIME_RANGE = new RegExp(`(${TIME_TOKEN})\\s*(?:-|TO)\\s*(${TIME_TOKEN})`);

function dayMask(text: string): number {
  const upper = text.toUpperCase();
  if (/MON(?:DAY)?\s*(?:-|TO|THRU)\s*FRI(?:DAY)?/.test(upper)) return 62;
  if (/MON(?:DAY)?\s*(?:-|TO|THRU)\s*SAT(?:URDAY)?/.test(upper)) return 126;
  let mask = 0;
  for (const [day, index] of Object.entries(DAYS)) {
    const full = day === "SUN" ? "SUNDAY" : day === "MON" ? "MONDAY" : day === "TUE" ? "TUESDAY" :
      day === "WED" ? "WEDNESDAY" : day === "THU" ? "THURSDAY" : day === "FRI" ? "FRIDAY" : "SATURDAY";
    if (new RegExp(`\\b(?:${day}|${full})\\b`).test(upper)) mask |= 1 << index;
  }
  return mask || ALL_DAYS;
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

export function parseParkingRule(raw: string, source = "nyc-signs"): ParsedRule {
  const text = raw.replace(/\s+/g, " ").trim().toUpperCase();
  if (!text) return { status: "unknown", dayMask: ALL_DAYS, startMinute: 0, endMinute: 1440, confidence: 0.1, reason: "Empty rule text.", source };
  const prohibited = /NO (?:STOPPING|STANDING|PARKING)/.test(text);
  const paid = /METER|PAY(?:MENT)?/.test(text);
  const explicitlyAllowed = /PARKING PERMITTED|FREE PARKING/.test(text);
  const anytime = /\bANY\s*TIME\b|\bAT ALL TIMES\b/.test(text);
  const match = text.match(TIME_RANGE);
  const hasTemporalCue = /\b(?:SUN|MON|TUE|WED|THU|FRI|SAT)(?:DAY|SDAY|NESDAY|RSDAY|URDAY)?\b|\b(?:NOON|MIDNIGHT)\b|\d{1,2}(?::\d{2})?\s*[AP]\.?M\.?/.test(text);
  let status: RuleStatus = "unknown";
  if (prohibited && (match || anytime || !hasTemporalCue)) status = "no_parking";
  else if (paid && match) status = "paid";
  else if (explicitlyAllowed && (match || !hasTemporalCue)) status = "free";
  const startMinute = match ? minute(match[1]) : 0;
  const parsedEnd = match ? minute(match[2]) : 1440;
  const endMinute = match && parsedEnd === 0 ? 1440 : parsedEnd;
  const confidence = status === "unknown" ? 0.2 : anytime ? 0.95 : match ? 0.9 : 0.55;
  return { status, dayMask: dayMask(text), startMinute, endMinute, confidence, reason: status === "unknown" ? `Unrecognized parking rule: ${raw}` : raw.trim(), source };
}

export function statusAt(rules: ParsedRule[], day: number, minuteOfDay: number): RuleStatus {
  const active = rules.filter(rule => (rule.dayMask & (1 << day)) !== 0 && (rule.startMinute <= rule.endMinute ? minuteOfDay >= rule.startMinute && minuteOfDay < rule.endMinute : minuteOfDay >= rule.startMinute || minuteOfDay < rule.endMinute));
  const rank: Record<RuleStatus, number> = { no_parking: 4, paid: 3, free: 2, unknown: 1 };
  return active.sort((a, b) => rank[b.status] - rank[a.status] || b.confidence - a.confidence)[0]?.status ?? "unknown";
}
