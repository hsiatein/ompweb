import { getSessionEntries, resolveSessionPath } from "./session-reader";
import { readdirSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import path from "path";
import { readSessionHeaderSync } from "./omp/session-files";
import { parseArtifactHref } from "./file-links";
import type { SessionEntry } from "./types";
import {
  isBashOutputPathReferencedByEntries,
  isFilePathReferencedByEntries,
  isValidSessionId,
} from "./session-file-references-core";

export { isFilePathReferencedByEntries } from "./session-file-references-core";

async function isPathReferencedBySession(
  filePath: string,
  sessionId: string | null,
  check: (p: string, entries: SessionEntry[], cwd?: string, home?: string) => boolean,
): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;
  try {
    const sessionPath = await resolveSessionPath(sessionId);
    if (!sessionPath) return false;
    return check(filePath, getSessionEntries(sessionPath), readSessionHeaderSync(sessionPath)?.cwd, homedir());
  } catch {
    return false;
  }
}

export async function isFilePathReferencedBySession(filePath: string, sessionId: string | null): Promise<boolean> {
  if (await isPathReferencedBySession(filePath, sessionId, isFilePathReferencedByEntries)) return true;
  if (!isValidSessionId(sessionId)) return false;
  const id = path.basename(filePath).split(".", 1)[0];
  const artifact = await resolveSessionArtifact(sessionId, id);
  return artifact !== null && path.resolve(filePath) === artifact;
}

export function isBashOutputPathReferencedBySession(filePath: string, sessionId: string | null): Promise<boolean> {
  return isPathReferencedBySession(filePath, sessionId, isBashOutputPathReferencedByEntries);
}

/** Resolve only an artifact named in this session, never a directory or sibling. */
export async function resolveSessionArtifact(sessionId: string, artifactId: string): Promise<string | null> {
  if (!isValidSessionId(sessionId) || parseArtifactHref(`artifact://${artifactId}`) !== artifactId) return null;
  try {
    const sessionPath = await resolveSessionPath(sessionId);
    if (!sessionPath || !isFilePathReferencedByEntries(`artifact://${artifactId}`, getSessionEntries(sessionPath))) return null;
    const directory = sessionPath.replace(/\.jsonl$/, "");
    if (directory === sessionPath) return null;
    const names = readdirSync(directory).filter((name) => name.startsWith(`${artifactId}.`));
    // Do not guess if an ID has several persisted targets.
    if (names.length !== 1) return null;
    const candidate = path.resolve(directory, names[0]);
    const realDirectory = realpathSync(directory);
    const realCandidate = realpathSync(candidate);
    if (path.dirname(realCandidate) !== realDirectory || !statSync(realCandidate).isFile()) return null;
    return candidate;
  } catch {
    return null;
  }
}
