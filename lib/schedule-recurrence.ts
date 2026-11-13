/**
 * When a scheduled task runs. Pure and client-safe: the server computes the
 * next run with it and the settings form validates with the same rules.
 *
 * Daily/weekly times are wall-clock times of the omp-web server's time zone.
 * `webhook` has no schedule: the task runs when its webhook URL is called.
 */

export type ScheduleRepeat =
  | { kind: "once"; at: number }
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; time: string }
  /** `days`: 0 = Sunday … 6 = Saturday, like `Date#getDay`. */
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "webhook" };

export const MIN_INTERVAL_MINUTES = 5;
/** Suggested port for a webhook's dedicated listener (omp-web itself defaults to 30177). */
export const DEFAULT_WEBHOOK_LISTEN_PORT = 30179;
export const MAX_INTERVAL_MINUTES = 30 * 24 * 60;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE_MS = 60_000;

function parseTime(time: string): { hours: number; minutes: number } | null {
  const match = TIME_RE.exec(time);
  return match ? { hours: Number(match[1]), minutes: Number(match[2]) } : null;
}

/** Validated copy of an untrusted repeat rule, or an error message. */
export function parseScheduleRepeat(raw: unknown): ScheduleRepeat | string {
  if (typeof raw !== "object" || raw === null) return "repeat is required";
  const value = raw as Record<string, unknown>;
  switch (value.kind) {
    case "webhook":
      return { kind: "webhook" };
    case "once":
      return typeof value.at === "number" && Number.isFinite(value.at)
        ? { kind: "once", at: value.at }
        : "repeat.at must be a timestamp in milliseconds";
    case "interval": {
      const minutes = value.minutes;
      if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
        return `repeat.minutes must be a whole number from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}`;
      }
      return { kind: "interval", minutes };
    }
    case "daily":
      return typeof value.time === "string" && parseTime(value.time)
        ? { kind: "daily", time: value.time }
        : "repeat.time must be HH:MM";
    case "weekly": {
      if (typeof value.time !== "string" || !parseTime(value.time)) return "repeat.time must be HH:MM";
      const days = Array.isArray(value.days) ? value.days : [];
      const valid = days.every((day) => typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6);
      const unique = [...new Set(days as number[])].sort((a, b) => a - b);
      if (!valid || unique.length === 0) return "repeat.days must list weekdays 0-6";
      return { kind: "weekly", days: unique, time: value.time };
    }
    default:
      return "repeat.kind must be once, interval, daily, weekly or webhook";
  }
}

/**
 * The first run strictly after `after`, or null when the rule is used up.
 * `previousDue` is the run that just came due (null for a new or edited task):
 * intervals count from it so they do not drift, and a "once" rule runs only
 * while it has not come due yet. Runs missed while omp-web was down collapse
 * into the single catch-up run the caller does at startup.
 */
export function nextRunAfter(repeat: ScheduleRepeat, after: number, previousDue: number | null): number | null {
  switch (repeat.kind) {
    case "webhook":
      return null;
    case "once":
      return previousDue === null ? repeat.at : null;
    case "interval": {
      const step = repeat.minutes * MINUTE_MS;
      const next = (previousDue ?? after) + step;
      return next > after ? next : after + step;
    }
    case "daily":
    case "weekly": {
      const time = parseTime(repeat.time);
      if (!time) return null;
      const start = new Date(after);
      for (let offset = 0; offset <= 7; offset++) {
        const candidate = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset, time.hours, time.minutes);
        if (candidate.getTime() <= after) continue;
        if (repeat.kind === "weekly" && !repeat.days.includes(candidate.getDay())) continue;
        return candidate.getTime();
      }
      return null;
    }
  }
}
