export type RuleStatus = "free" | "paid" | "no_parking" | "unknown";
export type ParsedRule = { status: RuleStatus; dayMask: number; startMinute: number; endMinute: number; confidence: number; reason: string; source: string };

const DAYS: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const ALL_DAYS = 127;

function dayMask(text: string): number {
  const upper = text.toUpperCase();
  if (/MON(?:DAY)?\s*(?:-|TO|THRU)\s*FRI(?:DAY)?/.test(upper)) return 62;
  if (/MON(?:DAY)?\s*(?:-|TO|THRU)\s*SAT(?:URDAY)?/.test(upper)) return 126;
  let mask = 0;
  for (const [day, index] of Object.entries(DAYS)) if (upper.includes(day)) mask |= 1 << index;
  return mask || ALL_DAYS;
}

function minute(hourText: string, minuteText: string | undefined, suffix: string): number {
  let hour = Number(hourText) % 12;
  if (suffix.toUpperCase() === "P") hour += 12;
  return hour * 60 + Number(minuteText ?? 0);
}

export function parseParkingRule(raw: string, source = "nyc-signs"): ParsedRule {
  const text = raw.replace(/\s+/g, " ").trim().toUpperCase();
  if (!text) return { status: "unknown", dayMask: ALL_DAYS, startMinute: 0, endMinute: 1440, confidence: 0.1, reason: "Empty rule text.", source };
  const prohibited = /NO (?:STOPPING|STANDING|PARKING)/.test(text);
  const paid = /METER|PAY(?:MENT)?/.test(text);
  const explicitlyAllowed = /PARKING PERMITTED|FREE PARKING/.test(text);
  const status: RuleStatus = prohibited ? "no_parking" : paid ? "paid" : explicitlyAllowed ? "free" : "unknown";
  const match = text.match(/(\d{1,2})(?::(\d{2}))?\s*([AP])M?\s*(?:-|TO)\s*(\d{1,2})(?::(\d{2}))?\s*([AP])M?/);
  const startMinute = match ? minute(match[1], match[2], match[3]) : 0;
  const endMinute = match ? minute(match[4], match[5], match[6]) || 1440 : 1440;
  const confidence = status === "unknown" ? 0.2 : match ? 0.9 : 0.55;
  return { status, dayMask: dayMask(text), startMinute, endMinute, confidence, reason: status === "unknown" ? `Unrecognized parking rule: ${raw}` : raw.trim(), source };
}

export function statusAt(rules: ParsedRule[], day: number, minuteOfDay: number): RuleStatus {
  const active = rules.filter(rule => (rule.dayMask & (1 << day)) !== 0 && (rule.startMinute <= rule.endMinute ? minuteOfDay >= rule.startMinute && minuteOfDay < rule.endMinute : minuteOfDay >= rule.startMinute || minuteOfDay < rule.endMinute));
  const rank: Record<RuleStatus, number> = { no_parking: 4, paid: 3, free: 2, unknown: 1 };
  return active.sort((a, b) => rank[b.status] - rank[a.status] || b.confidence - a.confidence)[0]?.status ?? "unknown";
}
