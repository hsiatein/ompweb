import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAgentDir } from "./omp/paths";
import { isValidSessionId } from "./session-file-references-core";
import { isRecord } from "./type-guards";
import { loadWebServerSettings } from "./web-settings";

/** Sent to each session that was mid-run when omp-web stopped. */
export const RESUME_PROMPT = "Session interrupted and resumed. Continue as you would have done without the interruption.";

/** How long a session whose omp process died stays recorded. A stop signal
 *  reaches every process in the service at once, so a child can die just
 *  before omp-web's own shutdown handler runs; a crash while omp-web keeps
 *  running is dropped after this window instead of resumed on the next start. */
export const EXIT_GRACE_MS = 2_000;

export interface InterruptibleSession {
  id: string;
  /** The child's spawn-time --advisor flag, restored on resume. */
  advisor: boolean;
}

interface TrackerState {
  /** The list the previous run left behind, claimed before this run writes. */
  leftover: InterruptibleSession[];
  sessions: Map<string, InterruptibleSession>;
  drops: Map<string, NodeJS.Timeout>;
  shuttingDown: boolean;
}

declare global {
  var __ompResumeTracker: TrackerState | undefined;
}

// A dev server (`next dev`) usually shares the agent dir with the installed
// service. The list on disk is then the live service's, not a previous run's:
// claiming it would delete it and start a second omp on sessions the service
// is running (omp forks a locked session, so each start left a duplicate
// session behind). Only a production server tracks and resumes.
function resumeEnabled(): boolean {
  return process.env.NODE_ENV === "production";
}

// On globalThis so it survives Next.js hot-reload and is shared by every
// bundle that imports this module. Created on first use, which claims the
// previous run's list before anything in this run can overwrite it.
function tracker(): TrackerState {
  globalThis.__ompResumeTracker ??= { leftover: resumeEnabled() ? readLeftover() : [], sessions: new Map(), drops: new Map(), shuttingDown: false };
  return globalThis.__ompResumeTracker;
}

function readLeftover(): InterruptibleSession[] {
  const path = interruptedPath();
  if (!existsSync(path)) return [];
  let sessions: InterruptibleSession[] = [];
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const list = isRecord(raw) && Array.isArray(raw.sessions) ? raw.sessions : [];
    sessions = list.flatMap((entry) =>
      isRecord(entry) && typeof entry.id === "string" && isValidSessionId(entry.id)
        ? [{ id: entry.id, advisor: entry.advisor === true }]
        : []);
  } catch {
    // A corrupt list resumes nothing.
  }
  rmSync(path, { force: true });
  return sessions;
}

function interruptedPath(): string {
  return resolve(getAgentDir(), "omp-web-interrupted-sessions.json");
}

function writeInterrupted(sessions: InterruptibleSession[]): void {
  const path = interruptedPath();
  try {
    if (sessions.length === 0) {
      rmSync(path, { force: true });
      return;
    }
    mkdirSync(resolve(path, ".."), { recursive: true });
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temp, `${JSON.stringify({ sessions }, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  } catch (error) {
    console.warn(`[omp-web] could not record running sessions for resume: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Keep the on-disk list of running sessions current. A session leaves the list
 * when its run ends normally (its process is still alive), or EXIT_GRACE_MS
 * after its process died unless omp-web is shutting down by then.
 */
export function recordRunningSessions(running: InterruptibleSession[], isAlive: (id: string) => boolean): void {
  const state = tracker();
  if (state.shuttingDown || !resumeEnabled()) return;
  if (!loadWebServerSettings().autoResumeSessions) {
    if (state.sessions.size > 0 || state.drops.size > 0) {
      for (const timer of state.drops.values()) clearTimeout(timer);
      state.drops.clear();
      state.sessions.clear();
      writeInterrupted([]);
    }
    return;
  }
  let changed = false;
  const runningIds = new Set<string>();
  for (const session of running) {
    runningIds.add(session.id);
    const drop = state.drops.get(session.id);
    if (drop) {
      clearTimeout(drop);
      state.drops.delete(session.id);
    }
    const previous = state.sessions.get(session.id);
    if (previous?.advisor !== session.advisor) {
      state.sessions.set(session.id, session);
      changed = true;
    }
  }
  for (const id of state.sessions.keys()) {
    if (runningIds.has(id)) continue;
    if (isAlive(id)) {
      state.sessions.delete(id);
      changed = true;
    } else if (!state.drops.has(id)) {
      const timer = setTimeout(() => {
        state.drops.delete(id);
        if (state.shuttingDown || !state.sessions.delete(id)) return;
        writeInterrupted([...state.sessions.values()]);
      }, EXIT_GRACE_MS);
      timer.unref?.();
      state.drops.set(id, timer);
    }
  }
  if (changed) writeInterrupted([...state.sessions.values()]);
}

/** Freeze the list: from here on, dying children are shutdown, not run ends. */
export function markShuttingDown(): void {
  tracker().shuttingDown = true;
}

/**
 * Hand out the list left by the previous run, once. Returns nothing when the
 * setting is off, so a stale list never resumes sessions later.
 */
export function takeInterruptedSessions(): InterruptibleSession[] {
  const state = tracker();
  const sessions = state.leftover;
  state.leftover = [];
  return loadWebServerSettings().autoResumeSessions ? sessions : [];
}
