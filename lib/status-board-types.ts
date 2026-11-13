/**
 * Status board shapes shared by the server (lib/status-board.ts) and the
 * right-panel Status tab. Agents and their programs only describe WHAT to show
 * (kind, value, state); the board decides layout, ordering and rates.
 */

export type StatusItemKind = "progress" | "value" | "text";
export type StatusItemState = "running" | "paused" | "done" | "failed" | "info";

export interface StatusItem {
  /** Caller-chosen key, unique within the session; updating it replaces the item. */
  id: string;
  title: string;
  kind: StatusItemKind;
  state: StatusItemState;
  /** progress: current amount; value: the metric. */
  value?: number;
  /** progress only: total amount. */
  max?: number;
  unit?: string;
  /** One extra line (current phase, last log line, ...). */
  detail?: string;
  /** Rich content under the head: markdown, key/values, tables, sub-bars, charts, code. */
  blocks?: StatusBlock[];
  createdAt: number;
  updatedAt: number;
  /** [time ms, value] samples for rate/ETA (progress) and sparklines (value). */
  history: Array<[number, number]>;
}

export type StatusCell = string | number | null;

export type StatusBlock =
  | { type: "markdown"; text: string }
  | { type: "kv"; title?: string; entries: Array<{ label: string; value: StatusCell; unit?: string; state?: StatusItemState }> }
  | { type: "table"; title?: string; columns: string[]; rows: StatusCell[][] }
  | { type: "progress"; label: string; value: number; max: number; unit?: string; state?: StatusItemState }
  | { type: "chart"; title?: string; chart: "line" | "bar"; xLabel?: string; yLabel?: string; series: Array<{ name: string; points: Array<[number, number]> }> }
  | { type: "code"; title?: string; text: string };

export interface StatusSession {
  sessionId: string;
  sessionName?: string;
  cwd?: string;
  updatedAt: number;
  items: StatusItem[];
}

/** `/api/events` frame and `GET /api/status-board` body. */
export interface StatusBoardSnapshot {
  sessions: StatusSession[];
}

export const STATUS_ITEM_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
