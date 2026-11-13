import { randomBytes, timingSafeEqual } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { parse as parseYaml } from "yaml";
import { getAgentDir } from "./omp/paths";
import { parseStatusBlocks } from "./status-board-blocks";
import { isRecord } from "./type-guards";
import {
  STATUS_ITEM_ID_RE,
  type StatusBlock,
  type StatusBoardSnapshot,
  type StatusItem,
  type StatusItemKind,
  type StatusItemState,
  type StatusSession,
} from "./status-board-types";

/**
 * Status board: live status items (progress bars, metrics, short notes, and
 * rich `blocks`: markdown, key/values, tables, sub-bars, charts, code) that
 * agents publish for their session, shown in the right panel's Status tab.
 * Updates may be written as JSON or YAML (`parseStatusDocument`).
 * Writers: the `status_board` agent tool (lib/agent-status-tool.ts) and
 * programs the agent starts, via `POST /api/status/<token>` (one secret token
 * per session). Callers describe items; the board decides layout, ordering,
 * rates and ETAs. State lives in `omp-web-status-board.json` in the agent dir.
 */

export const MAX_ITEMS_PER_SESSION = 30;
export const MAX_TITLE_CHARS = 120;
export const MAX_DETAIL_CHARS = 500;
const MAX_UNIT_CHARS = 16;
const MAX_HISTORY = 120;
/** Spacing of history samples; faster updates replace the latest sample. */
const HISTORY_SPACING_MS = 2_000;
/** Finished items leave the board after a day, anything idle after a week. */
const FINISHED_TTL_MS = 24 * 3_600_000;
const IDLE_TTL_MS = 7 * 24 * 3_600_000;
const SAVE_DELAY_MS = 1_000;
const NOTIFY_DELAY_MS = 250;
export const STATUS_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

interface SessionRecord {
  sessionId: string;
  sessionName?: string;
  cwd?: string;
  token: string;
  items: StatusItem[];
}

interface BoardState {
  sessions: Map<string, SessionRecord>;
  listeners: Set<(snapshot: StatusBoardSnapshot) => void>;
  saveTimer: NodeJS.Timeout | null;
  notifyTimer: NodeJS.Timeout | null;
}

declare global {
  var __ompStatusBoard: BoardState | undefined;
}

function storePath(): string {
  return resolve(getAgentDir(), "omp-web-status-board.json");
}

const KINDS = new Set<StatusItemKind>(["progress", "value", "text"]);
const STATES = new Set<StatusItemState>(["running", "paused", "done", "failed", "info"]);

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function storedBlocks(raw: unknown): { blocks?: StatusBlock[] } {
  if (!Array.isArray(raw) || raw.length === 0) return {};
  try {
    return { blocks: parseStatusBlocks(raw, (message) => { throw new Error(message); }) };
  } catch {
    return {};
  }
}

function parseStoredItem(raw: unknown): StatusItem | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || !STATUS_ITEM_ID_RE.test(raw.id) || typeof raw.title !== "string") return null;
  const kind = KINDS.has(raw.kind as StatusItemKind) ? raw.kind as StatusItemKind : "text";
  const state = STATES.has(raw.state as StatusItemState) ? raw.state as StatusItemState : "info";
  const history = Array.isArray(raw.history)
    ? raw.history.filter((pair): pair is [number, number] => Array.isArray(pair) && finite(pair[0]) !== undefined && finite(pair[1]) !== undefined).slice(-MAX_HISTORY)
    : [];
  return {
    id: raw.id,
    title: raw.title,
    kind,
    state,
    ...(finite(raw.value) !== undefined ? { value: finite(raw.value) } : {}),
    ...(finite(raw.max) !== undefined ? { max: finite(raw.max) } : {}),
    ...(typeof raw.unit === "string" ? { unit: raw.unit } : {}),
    ...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
    createdAt: finite(raw.createdAt) ?? Date.now(),
    updatedAt: finite(raw.updatedAt) ?? Date.now(),
    history,
    ...storedBlocks(raw.blocks),
  };
}

function load(): Map<string, SessionRecord> {
  const sessions = new Map<string, SessionRecord>();
  try {
    if (!existsSync(storePath())) return sessions;
    const raw: unknown = JSON.parse(readFileSync(storePath(), "utf8"));
    for (const entry of isRecord(raw) && Array.isArray(raw.sessions) ? raw.sessions : []) {
      if (!isRecord(entry) || typeof entry.sessionId !== "string" || typeof entry.token !== "string" || !STATUS_TOKEN_RE.test(entry.token)) continue;
      sessions.set(entry.sessionId, {
        sessionId: entry.sessionId,
        ...(typeof entry.sessionName === "string" ? { sessionName: entry.sessionName } : {}),
        ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
        token: entry.token,
        items: (Array.isArray(entry.items) ? entry.items : []).map(parseStoredItem).filter((item): item is StatusItem => item !== null),
      });
    }
  } catch {
    // A corrupt file starts an empty board.
  }
  return sessions;
}

function state(): BoardState {
  globalThis.__ompStatusBoard ??= { sessions: load(), listeners: new Set(), saveTimer: null, notifyTimer: null };
  return globalThis.__ompStatusBoard;
}

function save(): void {
  const board = state();
  if (board.saveTimer) return;
  board.saveTimer = setTimeout(() => {
    board.saveTimer = null;
    try {
      const path = storePath();
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.tmp-${process.pid}`;
      // Tokens are credentials: owner-only like the rest of the agent dir.
      writeFileSync(temp, `${JSON.stringify({ sessions: [...board.sessions.values()] })}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temp, path);
    } catch (error) {
      console.warn(`[omp-web] could not save the status board: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, SAVE_DELAY_MS);
  board.saveTimer.unref?.();
}

function prune(record: SessionRecord, now: number): void {
  record.items = record.items.filter((item) => {
    const age = now - item.updatedAt;
    if (age > IDLE_TTL_MS) return false;
    return !((item.state === "done" || item.state === "failed") && age > FINISHED_TTL_MS);
  });
}

export function getStatusBoardSnapshot(now = Date.now()): StatusBoardSnapshot {
  const sessions: StatusSession[] = [];
  for (const record of state().sessions.values()) {
    prune(record, now);
    if (record.items.length === 0) continue;
    sessions.push({
      sessionId: record.sessionId,
      ...(record.sessionName ? { sessionName: record.sessionName } : {}),
      ...(record.cwd ? { cwd: record.cwd } : {}),
      updatedAt: Math.max(...record.items.map((item) => item.updatedAt)),
      items: record.items,
    });
  }
  return { sessions };
}

/** Listener gets the snapshot now and after every change (coalesced). */
export function subscribeStatusBoard(listener: (snapshot: StatusBoardSnapshot) => void): () => void {
  state().listeners.add(listener);
  listener(getStatusBoardSnapshot());
  return () => { state().listeners.delete(listener); };
}

function changed(): void {
  save();
  const board = state();
  if (board.notifyTimer) return;
  board.notifyTimer = setTimeout(() => {
    board.notifyTimer = null;
    const snapshot = getStatusBoardSnapshot();
    for (const listener of board.listeners) listener(snapshot);
  }, NOTIFY_DELAY_MS);
  board.notifyTimer.unref?.();
}

export class StatusInputError extends Error {}

function failInput(message: string): never {
  throw new StatusInputError(message);
}

/** A status update written as JSON or YAML text (an item, a list, or {items: [...]}). */
export function parseStatusDocument(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new StatusInputError("empty document");
  try {
    return JSON.parse(trimmed);
  } catch {
    // Not JSON: YAML (aliases capped by the parser's default maxAliasCount).
  }
  try {
    return parseYaml(trimmed);
  } catch (error) {
    throw new StatusInputError(`not valid JSON or YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}

function record(sessionId: string, identity?: { sessionName?: string; cwd?: string }): SessionRecord {
  const board = state();
  let entry = board.sessions.get(sessionId);
  if (!entry) {
    entry = { sessionId, token: randomBytes(32).toString("base64url"), items: [] };
    board.sessions.set(sessionId, entry);
    save();
  }
  if (identity?.sessionName) entry.sessionName = identity.sessionName;
  if (identity?.cwd) entry.cwd = identity.cwd;
  return entry;
}

/** The push token of a session (created on first use; survives restarts). */
export function statusTokenFor(sessionId: string, identity?: { sessionName?: string; cwd?: string }): string {
  return record(sessionId, identity).token;
}

function sessionForToken(token: string): SessionRecord | undefined {
  if (!STATUS_TOKEN_RE.test(token)) return undefined;
  const presented = Buffer.from(token);
  for (const entry of state().sessions.values()) {
    const stored = Buffer.from(entry.token);
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) return entry;
  }
  return undefined;
}

function text(value: unknown, field: string, limit: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new StatusInputError(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

function number(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new StatusInputError(`${field} must be a finite number`);
  return value;
}

/** Apply one item update (create, merge, or `remove: true`). */
function applyUpdate(entry: SessionRecord, raw: unknown, now: number): void {
  if (!isRecord(raw)) throw new StatusInputError("each item must be an object");
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!STATUS_ITEM_ID_RE.test(id)) throw new StatusInputError("id must be 1-64 characters of letters, digits, _ . : -");
  if (raw.remove === true) {
    entry.items = entry.items.filter((item) => item.id !== id);
    return;
  }
  const previous = entry.items.find((item) => item.id === id);
  const value = number(raw.value, "value");
  const max = number(raw.max, "max");
  if (max !== undefined && max <= 0) throw new StatusInputError("max must be greater than 0");
  const kindInput = raw.kind;
  if (kindInput !== undefined && !KINDS.has(kindInput as StatusItemKind)) throw new StatusInputError("kind must be progress, value or text");
  const stateInput = raw.state;
  if (stateInput !== undefined && !STATES.has(stateInput as StatusItemState)) throw new StatusInputError("state must be running, paused, done, failed or info");
  const title = text(raw.title, "title", MAX_TITLE_CHARS) ?? previous?.title ?? id;
  const nextMax = max ?? previous?.max;
  const nextValue = value ?? previous?.value;
  const kind: StatusItemKind = (kindInput as StatusItemKind | undefined)
    ?? previous?.kind
    ?? (nextMax !== undefined ? "progress" : nextValue !== undefined ? "value" : "text");
  let nextState: StatusItemState = (stateInput as StatusItemState | undefined) ?? previous?.state ?? (kind === "text" ? "info" : "running");
  // A progress item that reaches its total is done unless told otherwise.
  if (stateInput === undefined && kind === "progress" && nextValue !== undefined && nextMax !== undefined && nextValue >= nextMax) nextState = "done";
  const history = [...(previous?.history ?? [])];
  if (value !== undefined) {
    const last = history.at(-1);
    if (last && now - last[0] < HISTORY_SPACING_MS) history[history.length - 1] = [last[0], value];
    else history.push([now, value]);
    // A progress counter that went backwards was restarted: its rate starts over.
    if (kind === "progress" && last && value < last[1]) history.splice(0, history.length - 1);
  }
  const unit = raw.unit === undefined ? previous?.unit : text(raw.unit, "unit", MAX_UNIT_CHARS);
  const detail = raw.detail === undefined ? previous?.detail : text(raw.detail, "detail", MAX_DETAIL_CHARS);
  // blocks: omitted keeps them, null or [] clears, a list replaces them whole.
  const blocks = raw.blocks === undefined ? previous?.blocks
    : raw.blocks === null ? undefined : parseStatusBlocks(raw.blocks, failInput);
  const item: StatusItem = {
    id,
    title,
    kind,
    state: nextState,
    ...(nextValue !== undefined ? { value: nextValue } : {}),
    ...(nextMax !== undefined && kind === "progress" ? { max: nextMax } : {}),
    ...(unit ? { unit } : {}),
    ...(detail ? { detail } : {}),
    ...(blocks && blocks.length > 0 ? { blocks } : {}),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    history: history.slice(-MAX_HISTORY),
  };
  if (previous) {
    entry.items = entry.items.map((existing) => (existing.id === id ? item : existing));
  } else {
    if (entry.items.length >= MAX_ITEMS_PER_SESSION) {
      throw new StatusInputError(`at most ${MAX_ITEMS_PER_SESSION} items per session; remove finished ones first`);
    }
    entry.items.push(item);
  }
}

/** Update items of a session: one object, `{items: [...]}`, or an array. All-or-nothing. */
export function updateStatusItems(sessionId: string, body: unknown, identity?: { sessionName?: string; cwd?: string }, now = Date.now()): number {
  const updates = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.items) ? body.items : [body];
  if (updates.length === 0) throw new StatusInputError("no items");
  if (updates.length > MAX_ITEMS_PER_SESSION) throw new StatusInputError(`at most ${MAX_ITEMS_PER_SESSION} items per request`);
  const entry = record(sessionId, identity);
  const working: SessionRecord = { ...entry, items: [...entry.items] };
  for (const update of updates) applyUpdate(working, update, now);
  entry.items = working.items;
  changed();
  return updates.length;
}

/**
 * `POST /api/status/<token>` with the raw JSON/YAML body: null when the token
 * belongs to no session. The token is checked before the body is parsed.
 */
export function updateStatusItemsByToken(token: string, document: string, now = Date.now()): number | null {
  const entry = sessionForToken(token);
  if (!entry) return null;
  return updateStatusItems(entry.sessionId, parseStatusDocument(document), undefined, now);
}

/** Remove items (all of the session's when `ids` is omitted). */
export function removeStatusItems(sessionId: string, ids?: string[]): number {
  const entry = state().sessions.get(sessionId);
  if (!entry) return 0;
  const before = entry.items.length;
  entry.items = ids ? entry.items.filter((item) => !ids.includes(item.id)) : [];
  if (entry.items.length !== before) changed();
  return before - entry.items.length;
}

/** Remove finished (done/failed) items of a session. */
export function clearFinishedStatusItems(sessionId: string): number {
  const entry = state().sessions.get(sessionId);
  if (!entry) return 0;
  return removeStatusItems(sessionId, entry.items.filter((item) => item.state === "done" || item.state === "failed").map((item) => item.id));
}

export function listStatusItems(sessionId: string): StatusItem[] {
  const entry = state().sessions.get(sessionId);
  if (!entry) return [];
  prune(entry, Date.now());
  return entry.items;
}
