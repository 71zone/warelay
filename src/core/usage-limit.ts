/**
 * Source of the regular expression the page scripts use to recognise a provider's usage-limit notice. It is embedded in browser scripts, so it must stay a
 * single self-contained pattern. Matches ChatGPT ("You've reached the current usage cap", "You've hit the usage limit", "try again after 3:45 PM") and
 * Claude ("You've reached your usage limit", "5-hour limit reached", "You are out of free messages until 3 PM", "Your limit will reset at 3 PM").
 */
export const usageLimitSource = String.raw`(?:(?:reached|hit|exceeded|used up)\b[^.\n]{0,60}\b(?:usage|message|messages|rate|plan|daily|weekly|hourly|\d+-hour|free)?\s*(?:limit|cap|quota)s?\b|(?:usage|message|rate|\d+-hour|weekly|daily)\s+(?:limit|cap)\s+(?:reached|hit|exceeded)|out of (?:free )?(?:messages|usage)|limit\s+(?:will\s+)?reset|(?:try again|come back)\s+(?:in|after|at|on|later)\b[^.\n]{0,40}\b(?:limit|usage)|(?:limit|cap)[^.\n]{0,40}\b(?:try again|resets?)\b)`;
export const usageLimitPattern = new RegExp(usageLimitSource, 'i');

/** True when `text` reads like a provider telling the user the usage limit is reached. */
export function isUsageLimitText(text: string): boolean { return usageLimitPattern.test(text); }

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };

/** Words that introduce the time a limit lifts; anything before the last one is ignored so unrelated numbers in the text are never read. */
const CUE = /(?:reset(?:s|ting)?|try again|available again|come back|until|after)\b/gi;

/** Milliseconds of a "in 2 hours 5 minutes" style wait that opens the text, null when the text does not start with one. */
function relative(text: string): number | null {
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/gi)];
  if (parts.length === 0 || !/^\s*(?:in\s+)?(?:about\s+|around\s+|~)?\d/i.test(text)) return null;
  let total = 0;
  for (const part of parts) total += Number(part[1]) * (UNIT_MS[(part[2] ?? 'm')[0]!.toLowerCase()] ?? 0);
  return total > 0 ? total : null;
}

/**
 * The epoch ms at which the provider says a usage limit lifts, read from its own wording and resolved against `now` in the local time zone; null when it names no time.
 * Relative ("in 2 hours", "in 3 days 4 hours"), clock times ("3:45 PM", "3pm", "15:30"; today, or tomorrow when that time has passed), a weekday ("Mon 9:00 AM") and
 * a date ("Nov 28 at 10am", "November 28, 3:00 PM") are understood. A time zone name in parentheses is ignored: the dashboard shows local time.
 */
export function parseResetAt(text: string, now: number): number | null {
  const cues = [...text.matchAll(CUE)];
  for (let index = cues.length - 1; index >= 0; index--) {
    const cue = cues[index]!;
    const tail = text.slice(cue.index + cue[0].length).replace(/\([^)]*\)/g, ' ').replace(/^\s*(?:on|at|by)\b/i, '').split(/[.!?\n]/)[0] ?? '';
    const wait = relative(tail);
    if (wait !== null && !/\d\s*(?::\d|[ap]\.?m\b)/i.test(tail)) return now + wait;
    const clock = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b\.?|\b([01]?\d|2[0-3]):([0-5]\d)\b/i.exec(tail);
    if (!clock) continue;
    let hour: number;
    let minute: number;
    if (clock[3]) {
      hour = Number(clock[1]) % 12 + (clock[3].toLowerCase() === 'p' ? 12 : 0);
      minute = Number(clock[2] ?? 0);
    } else { hour = Number(clock[4]); minute = Number(clock[5]); }
    const base = new Date(now);
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    const before = tail.slice(0, clock.index).toLowerCase();
    const month = MONTHS.findIndex(name => new RegExp(`\\b${name}[a-z]*\\.?\\s+\\d{1,2}\\b`).test(before));
    const dated = month >= 0 ? new RegExp(`\\b${MONTHS[month]}[a-z]*\\.?\\s+(\\d{1,2})\\b`).exec(before) : null;
    const weekday = DAYS.findIndex(name => new RegExp(`\\b${name.slice(0, 3)}(?:${name.slice(3)})?\\b`).test(before));
    if (dated) {
      target.setMonth(month, Number(dated[1]));
      if (target.getTime() <= now) target.setFullYear(base.getFullYear() + 1);
    } else if (weekday >= 0) {
      target.setDate(base.getDate() + ((weekday - base.getDay() + 7) % 7));
      if (target.getTime() <= now) target.setDate(target.getDate() + 7);
    } else if (/\btomorrow\b/.test(before)) target.setDate(base.getDate() + 1);
    else if (target.getTime() <= now) target.setDate(target.getDate() + 1);
    return target.getTime();
  }
  return null;
}
