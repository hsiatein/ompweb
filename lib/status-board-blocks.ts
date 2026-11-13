import { isRecord } from "./type-guards";
import type { StatusBlock, StatusCell, StatusItemState } from "./status-board-types";

/**
 * Validation of status item `blocks` (rich content under an item's head).
 * Input is what an agent or a script writes in JSON or YAML; the output is the
 * normalized shape the panel renders. Friendly shorthands are accepted (a bare
 * string is a markdown block, kv entries and chart series may be maps, table
 * rows may be objects) so YAML stays short. Limits keep one item small enough
 * to ride every `/api/events` snapshot.
 */

export const MAX_BLOCKS = 20;
export const MAX_ITEM_BLOCK_BYTES = 48 * 1024;
const MAX_MARKDOWN_CHARS = 8_000;
const MAX_CODE_CHARS = 8_000;
const MAX_LABEL_CHARS = 120;
const MAX_CELL_CHARS = 300;
const MAX_KV_ENTRIES = 40;
const MAX_COLUMNS = 12;
const MAX_ROWS = 200;
const MAX_SERIES = 6;
const MAX_POINTS = 500;
const STATES = new Set<StatusItemState>(["running", "paused", "done", "failed", "info"]);
export const BLOCK_TYPES = ["markdown", "kv", "table", "progress", "chart", "code"] as const;

type Fail = (message: string) => never;

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function label(value: unknown, field: string, fail: Fail, limit = MAX_LABEL_CHARS): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string`);
  return clip((value as string).trim(), limit);
}

function optionalLabel(value: unknown, field: string, fail: Fail): string | undefined {
  return value === undefined || value === null ? undefined : label(value, field, fail);
}

function finite(value: unknown, field: string, fail: Fail): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field} must be a finite number`);
  return value as number;
}

function cell(value: unknown, field: string, fail: Fail): StatusCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return clip(value, MAX_CELL_CHARS);
  return fail(`${field} must be a string, number, boolean or null`);
}

function state(value: unknown, field: string, fail: Fail): StatusItemState | undefined {
  if (value === undefined || value === null) return undefined;
  if (!STATES.has(value as StatusItemState)) fail(`${field} must be running, paused, done, failed or info`);
  return value as StatusItemState;
}

function longText(value: unknown, field: string, limit: number, fail: Fail): string {
  const text = Array.isArray(value) && value.every((line) => typeof line === "string") ? value.join("\n") : value;
  if (typeof text !== "string") fail(`${field} must be a string`);
  return clip(text as string, limit);
}

function kvEntries(raw: unknown, at: string, fail: Fail): Extract<StatusBlock, { type: "kv" }>["entries"] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) ? Object.entries(raw).map(([key, value]) => (isRecord(value) ? { label: key, ...value } : { label: key, value })) : fail(`${at}.entries must be a list or a map`);
  if (list.length > MAX_KV_ENTRIES) fail(`${at}.entries: at most ${MAX_KV_ENTRIES}`);
  return list.map((entry, index) => {
    const where = `${at}.entries[${index}]`;
    if (!isRecord(entry)) fail(`${where} must be an object`);
    const unit = optionalLabel(entry.unit, `${where}.unit`, fail);
    const entryState = state(entry.state, `${where}.state`, fail);
    return {
      label: label(entry.label, `${where}.label`, fail),
      value: cell(entry.value, `${where}.value`, fail),
      ...(unit ? { unit } : {}),
      ...(entryState ? { state: entryState } : {}),
    };
  });
}

function table(raw: Record<string, unknown>, at: string, fail: Fail): Extract<StatusBlock, { type: "table" }> {
  if (!Array.isArray(raw.rows)) fail(`${at}.rows must be a list`);
  const rowsIn = raw.rows as unknown[];
  if (rowsIn.length > MAX_ROWS) fail(`${at}.rows: at most ${MAX_ROWS}`);
  let columns: string[];
  if (Array.isArray(raw.columns)) {
    columns = raw.columns.map((column, index) => label(column, `${at}.columns[${index}]`, fail));
  } else {
    // Object rows without columns: the keys in first-seen order.
    const keys: string[] = [];
    for (const row of rowsIn) if (isRecord(row)) for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
    columns = keys.map((key) => clip(key, MAX_LABEL_CHARS));
  }
  if (columns.length === 0) fail(`${at}.columns must not be empty`);
  if (columns.length > MAX_COLUMNS) fail(`${at}.columns: at most ${MAX_COLUMNS}`);
  const rows = rowsIn.map((row, index) => {
    const where = `${at}.rows[${index}]`;
    if (Array.isArray(row)) {
      if (row.length > columns.length) fail(`${where} has more cells than columns`);
      return columns.map((_, column) => cell(row[column], `${where}[${column}]`, fail));
    }
    if (isRecord(row)) return columns.map((column) => cell(row[column], `${where}.${column}`, fail));
    return fail(`${where} must be a list or an object`);
  });
  const title = optionalLabel(raw.title, `${at}.title`, fail);
  return { type: "table", ...(title ? { title } : {}), columns, rows };
}

function chart(raw: Record<string, unknown>, at: string, fail: Fail): Extract<StatusBlock, { type: "chart" }> {
  const kind = raw.chart ?? "line";
  if (kind !== "line" && kind !== "bar") fail(`${at}.chart must be line or bar`);
  const seriesIn = Array.isArray(raw.series)
    ? raw.series
    : isRecord(raw.series) ? Object.entries(raw.series).map(([name, points]) => ({ name, points })) : fail(`${at}.series must be a list or a map`);
  if (seriesIn.length === 0) fail(`${at}.series must not be empty`);
  if (seriesIn.length > MAX_SERIES) fail(`${at}.series: at most ${MAX_SERIES}`);
  const series = seriesIn.map((entry, index) => {
    const where = `${at}.series[${index}]`;
    if (!isRecord(entry) || !Array.isArray(entry.points)) fail(`${where} needs points (a list)`);
    const pointsIn = (entry as Record<string, unknown>).points as unknown[];
    if (pointsIn.length > MAX_POINTS) fail(`${where}.points: at most ${MAX_POINTS}`);
    // Plain numbers are y values at x = 0, 1, 2, ...
    const points = pointsIn.map((point, n): [number, number] => (Array.isArray(point)
      ? [finite(point[0], `${where}.points[${n}][0]`, fail), finite(point[1], `${where}.points[${n}][1]`, fail)]
      : [n, finite(point, `${where}.points[${n}]`, fail)]));
    return { name: label((entry as Record<string, unknown>).name ?? `series ${index + 1}`, `${where}.name`, fail), points };
  });
  const title = optionalLabel(raw.title, `${at}.title`, fail);
  const xLabel = optionalLabel(raw.xLabel, `${at}.xLabel`, fail);
  const yLabel = optionalLabel(raw.yLabel, `${at}.yLabel`, fail);
  return { type: "chart", ...(title ? { title } : {}), chart: kind as "line" | "bar", ...(xLabel ? { xLabel } : {}), ...(yLabel ? { yLabel } : {}), series };
}

function block(raw: unknown, at: string, fail: Fail): StatusBlock {
  if (typeof raw === "string") return { type: "markdown", text: clip(raw, MAX_MARKDOWN_CHARS) };
  if (!isRecord(raw)) fail(`${at} must be an object or a markdown string`);
  const entry = raw as Record<string, unknown>;
  const title = () => optionalLabel(entry.title, `${at}.title`, fail);
  switch (entry.type) {
    case "markdown":
      return { type: "markdown", text: longText(entry.text, `${at}.text`, MAX_MARKDOWN_CHARS, fail) };
    case "kv": {
      const kvTitle = title();
      return { type: "kv", ...(kvTitle ? { title: kvTitle } : {}), entries: kvEntries(entry.entries, at, fail) };
    }
    case "table":
      return table(entry, at, fail);
    case "progress": {
      const max = finite(entry.max, `${at}.max`, fail);
      if (max <= 0) fail(`${at}.max must be greater than 0`);
      const unit = optionalLabel(entry.unit, `${at}.unit`, fail);
      const barState = state(entry.state, `${at}.state`, fail);
      return {
        type: "progress",
        label: label(entry.label, `${at}.label`, fail),
        value: finite(entry.value, `${at}.value`, fail),
        max,
        ...(unit ? { unit } : {}),
        ...(barState ? { state: barState } : {}),
      };
    }
    case "chart":
      return chart(entry, at, fail);
    case "code": {
      const codeTitle = title();
      return { type: "code", ...(codeTitle ? { title: codeTitle } : {}), text: longText(entry.text, `${at}.text`, MAX_CODE_CHARS, fail) };
    }
    default:
      return fail(`${at}.type must be one of ${BLOCK_TYPES.join(", ")}`);
  }
}

/** Normalized blocks; `fail` throws the caller's input error. */
export function parseStatusBlocks(raw: unknown, fail: Fail): StatusBlock[] {
  if (!Array.isArray(raw)) fail("blocks must be a list");
  const list = raw as unknown[];
  if (list.length > MAX_BLOCKS) fail(`blocks: at most ${MAX_BLOCKS}`);
  const blocks = list.map((entry, index) => block(entry, `blocks[${index}]`, fail));
  if (Buffer.byteLength(JSON.stringify(blocks)) > MAX_ITEM_BLOCK_BYTES) fail(`blocks are larger than ${MAX_ITEM_BLOCK_BYTES / 1024} KiB`);
  return blocks;
}
