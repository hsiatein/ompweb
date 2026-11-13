import { randomUUID } from "crypto";
import { existsSync, statSync } from "fs";
import { homedir } from "os";
import path from "path";
import type { IPty } from "node-pty";
import { accountProxyEnvironment } from "./account-proxy";
import { preferForOomKill } from "./system-stats";

/**
 * Integrated terminals: real shells on PTYs (node-pty) owned by the omp-web
 * server, so they keep running across page reloads and are shared by every
 * tab. Output goes to the browser over SSE, keystrokes come back as POSTs
 * (`/api/terminals/**`); a bounded scrollback is replayed when a view attaches.
 * node-pty is an optional native dependency: without it the feature reports
 * itself unavailable instead of breaking the app.
 */

export interface TerminalInfo {
  id: string;
  cwd: string;
  shell: string;
  createdAt: number;
  /** Set once the shell has exited; the entry stays until closed. */
  exitCode?: number;
}

export type TerminalEvent =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number };

type Listener = (event: TerminalEvent) => void;

interface TerminalEntry {
  info: TerminalInfo;
  pty: IPty;
  /** Recent output chunks, oldest first, at most SCROLLBACK_CHARS in total. */
  scrollback: string[];
  scrollbackChars: number;
  listeners: Set<Listener>;
}

export const MAX_TERMINALS = 8;
const SCROLLBACK_CHARS = 512 * 1024;
export const MIN_COLS = 2;
export const MAX_COLS = 1000;
export const MIN_ROWS = 1;
export const MAX_ROWS = 500;
/** Largest single input frame (a big paste); xterm sends typed keys one by one. */
export const MAX_INPUT_CHARS = 64 * 1024;

declare global {
  // Survives Next.js hot reload; a plain module Map would orphan live shells.
  var __ompWebTerminals: Map<string, TerminalEntry> | undefined;
}

function registry(): Map<string, TerminalEntry> {
  if (!globalThis.__ompWebTerminals) {
    globalThis.__ompWebTerminals = new Map();
    const killAll = () => {
      for (const entry of globalThis.__ompWebTerminals?.values() ?? []) {
        try { entry.pty.kill(); } catch { /* already gone */ }
      }
    };
    process.once("exit", killAll);
    process.once("SIGINT", killAll);
    process.once("SIGTERM", killAll);
  }
  return globalThis.__ompWebTerminals;
}

type PtyModule = typeof import("node-pty");
let ptyModule: Promise<PtyModule | null> | undefined;

/** node-pty's exports, whether the loader returns them directly or under CJS-interop `default`. */
function ptyExports(value: unknown): PtyModule | null {
  if (!value || typeof value !== "object") return null;
  if ("spawn" in value && typeof value.spawn === "function") {
    // Checked above: `spawn` is the only member used.
    const exports = value as PtyModule;
    return exports;
  }
  return "default" in value ? ptyExports(value.default) : null;
}

/**
 * node-pty, or null when the optional native module is not installed/built.
 * A dynamic import of a `serverExternalPackages` entry stays a runtime load,
 * so a missing module is a catchable rejection instead of a broken route.
 */
function loadPty(): Promise<PtyModule | null> {
  ptyModule ??= import("node-pty").then(ptyExports, () => null);
  return ptyModule;
}

export async function terminalsAvailable(): Promise<boolean> {
  return (await loadPty()) !== null;
}

export class TerminalError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function defaultShell(): string {
  if (process.platform === "win32") return process.env.COMSPEC || "powershell.exe";
  return process.env.SHELL || "/bin/bash";
}

// The server's own settings (password, port, Next internals) are not the
// user's shell environment.
const STRIPPED_ENV = /^(OMP_WEB_|__NEXT|NEXT_|PORT$|NODE_ENV$|HOSTNAME$)/;

/** The user's environment without omp-web's own variables (password, port, Next internals). */
export function userEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !STRIPPED_ENV.test(key)) env[key] = value;
  }
  return env;
}

export function terminalEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = userEnv(source);
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "omp-web";
  // `omp` started in this shell routes each account through its own proxy, like chats do.
  try { Object.assign(env, accountProxyEnvironment()); } catch { /* Unreadable agent dir: the shell still starts. */ }
  return env;
}

function startDirectory(cwd: string | undefined): string {
  try {
    if (cwd && path.isAbsolute(cwd) && existsSync(cwd) && statSync(cwd).isDirectory()) return cwd;
  } catch {
    // fall through to home
  }
  return homedir();
}

export function clampSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const int = (value: unknown, min: number, max: number, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
  return { cols: int(cols, MIN_COLS, MAX_COLS, 80), rows: int(rows, MIN_ROWS, MAX_ROWS, 24) };
}

export function listTerminals(): TerminalInfo[] {
  return [...registry().values()].map((entry) => ({ ...entry.info })).sort((a, b) => a.createdAt - b.createdAt);
}

/** Running shells (pid = the shell; what it runs are its descendants). */
export function getTerminalProcesses(): Array<{ id: string; pid: number; cwd: string }> {
  return [...registry().values()]
    .filter((entry) => entry.info.exitCode === undefined)
    .map((entry) => ({ id: entry.info.id, pid: entry.pty.pid, cwd: entry.info.cwd }));
}

/** Print an omp-web message into a terminal (dim, on its own line). */
export function noticeTerminal(id: string, text: string): void {
  const entry = registry().get(id);
  if (!entry) return;
  const data = `\r\n\x1b[2;33m${text}\x1b[0m\r\n`;
  entry.scrollback.push(data);
  entry.scrollbackChars += data.length;
  emit(entry, { type: "output", data });
}

function getEntry(id: string): TerminalEntry {
  const entry = registry().get(id);
  if (!entry) throw new TerminalError("Terminal not found", "terminal_not_found", 404);
  return entry;
}

function emit(entry: TerminalEntry, event: TerminalEvent): void {
  for (const listener of entry.listeners) {
    try { listener(event); } catch { /* a broken stream must not stop the others */ }
  }
}

export async function createTerminal(options: { cwd?: string; cols?: unknown; rows?: unknown }): Promise<TerminalInfo> {
  const pty = await loadPty();
  if (!pty) throw new TerminalError("The terminal needs the node-pty module, which is not installed", "terminal_unavailable", 501);
  const terminals = registry();
  if (terminals.size >= MAX_TERMINALS) {
    throw new TerminalError(`At most ${MAX_TERMINALS} terminals can be open`, "terminal_limit", 409);
  }
  const shell = defaultShell();
  const cwd = startDirectory(options.cwd);
  const { cols, rows } = clampSize(options.cols, options.rows);
  const child = pty.spawn(shell, [], { name: "xterm-256color", cols, rows, cwd, env: terminalEnv() });
  preferForOomKill(child.pid);
  const entry: TerminalEntry = {
    info: { id: randomUUID(), cwd, shell, createdAt: Date.now() },
    pty: child,
    scrollback: [],
    scrollbackChars: 0,
    listeners: new Set(),
  };
  child.onData((data) => {
    entry.scrollback.push(data);
    entry.scrollbackChars += data.length;
    while (entry.scrollbackChars > SCROLLBACK_CHARS && entry.scrollback.length > 1) {
      entry.scrollbackChars -= entry.scrollback.shift()!.length;
    }
    emit(entry, { type: "output", data });
  });
  child.onExit(({ exitCode }) => {
    entry.info.exitCode = exitCode;
    emit(entry, { type: "exit", exitCode });
  });
  terminals.set(entry.info.id, entry);
  return { ...entry.info };
}

export function writeTerminal(id: string, data: string): void {
  const entry = getEntry(id);
  if (entry.info.exitCode !== undefined) throw new TerminalError("The shell has exited", "terminal_exited", 409);
  entry.pty.write(data);
}

export function resizeTerminal(id: string, cols: unknown, rows: unknown): void {
  const entry = getEntry(id);
  if (entry.info.exitCode !== undefined) return;
  const size = clampSize(cols, rows);
  entry.pty.resize(size.cols, size.rows);
}

/** Kill the shell (if still running) and forget the terminal. */
export function closeTerminal(id: string): void {
  const entry = getEntry(id);
  registry().delete(id);
  if (entry.info.exitCode === undefined) {
    try { entry.pty.kill(); } catch { /* already gone */ }
  }
  entry.listeners.clear();
}

/**
 * Attach a view: returns the scrollback to replay (and the exit code if the
 * shell already ended), then streams new events until unsubscribed.
 */
export function attachTerminal(id: string, listener: Listener): { replay: string; exitCode?: number; detach: () => void } {
  const entry = getEntry(id);
  entry.listeners.add(listener);
  return {
    replay: entry.scrollback.join(""),
    ...(entry.info.exitCode !== undefined ? { exitCode: entry.info.exitCode } : {}),
    detach: () => { entry.listeners.delete(listener); },
  };
}
