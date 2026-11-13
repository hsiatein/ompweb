import type { StatusItem, StatusItemState, StatusSession } from "./status-board-types";

/**
 * Layout rules of the status board, kept out of the component so they are
 * testable: which session comes first, item order, progress rate/ETA and
 * staleness. Callers only describe items; these rules decide presentation.
 */

/** A running item without updates for this long is shown as stale. */
export const STALE_AFTER_MS = 10 * 60_000;
/** Progress rate is measured over this much recent history. */
const RATE_WINDOW_MS = 10 * 60_000;

const STATE_ORDER: Record<StatusItemState, number> = { failed: 0, running: 1, paused: 2, info: 3, done: 4 };

export function isFinished(item: StatusItem): boolean {
  return item.state === "done" || item.state === "failed";
}

/** Failed first (needs attention), then running, paused, notes, done; stable by creation. */
export function orderItems(items: StatusItem[]): StatusItem[] {
  return [...items].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.createdAt - b.createdAt);
}

/** The open chat first, then sessions with live items, newest activity first. */
export function orderSessions(sessions: StatusSession[], currentSessionId: string | null): StatusSession[] {
  const live = (session: StatusSession) => session.items.some((item) => !isFinished(item));
  return [...sessions].sort((a, b) =>
    Number(b.sessionId === currentSessionId) - Number(a.sessionId === currentSessionId)
    || Number(live(b)) - Number(live(a))
    || b.updatedAt - a.updatedAt);
}

export interface ProgressInfo {
  /** 0–100, clamped. */
  percent: number;
  /** Units per second over the recent window, when measurable. */
  rate?: number;
  /** Milliseconds to completion at that rate. */
  etaMs?: number;
}

export function progressInfo(item: StatusItem, now: number): ProgressInfo | null {
  if (item.kind !== "progress" || item.value === undefined || item.max === undefined || item.max <= 0) return null;
  const percent = Math.min(100, Math.max(0, (item.value / item.max) * 100));
  const recent = item.history.filter(([time]) => time >= now - RATE_WINDOW_MS);
  if (item.state !== "running" || recent.length < 2) return { percent };
  const [t0, v0] = recent[0];
  const [t1, v1] = recent[recent.length - 1];
  if (t1 <= t0 || v1 <= v0) return { percent };
  const rate = ((v1 - v0) / (t1 - t0)) * 1000;
  const remaining = item.max - item.value;
  return { percent, rate, ...(remaining > 0 ? { etaMs: (remaining / rate) * 1000 } : {}) };
}

export function isStale(item: StatusItem, now: number): boolean {
  return item.state === "running" && now - item.updatedAt > STALE_AFTER_MS;
}

/** Tab badge: live items and whether any failed. */
export function boardSummary(sessions: StatusSession[]): { live: number; failed: boolean } {
  let live = 0;
  let failed = false;
  for (const session of sessions) {
    for (const item of session.items) {
      if (item.state === "running" || item.state === "paused") live += 1;
      if (item.state === "failed") failed = true;
    }
  }
  return { live, failed };
}

/** "3m 20s", "1h 05m", "2d 4h". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Compact number: 1234 → 1.23k, 0.000123 → 1.23e-4. */
export function formatNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e9)) return value.toExponential(2);
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
  if (Number.isInteger(value)) return String(value);
  const fixed = value.toPrecision(abs >= 1 ? 4 : 3);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}
