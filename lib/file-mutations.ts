import fs from "fs";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { isExistingFilePathAllowed, isFilePathAllowed } from "./file-access";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import { validateUploadFileNames } from "./file-upload";

export class FileMutationError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}

function fail(code: string, status: number, message: string): never {
  throw new FileMutationError(code, status, message);
}

function authorizedPath(filePath: string, roots: Set<string>): string {
  if (!isFilePathAllowed(filePath, roots) || !isExistingFilePathAllowed(path.dirname(filePath), roots)) {
    fail("access_denied", 403, "Writes are restricted to authorized workspaces");
  }
  return path.join(fs.realpathSync(path.dirname(filePath)), path.basename(filePath));
}

function checkEntry(filePath: string): fs.Stats {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    fail("file_edit_unsupported", 400, "Symbolic links and special files cannot be modified here");
  }
  return stat;
}

function protectRoots(filePath: string, roots: Set<string>): void {
  for (const root of roots) {
    let realRoot: string;
    try { realRoot = fs.realpathSync(root); } catch { continue; }
    if (isFilePathAllowed(realRoot, new Set([filePath]))) {
      fail("file_root_protected", 403, "Cannot rename or delete a workspace root or its ancestor");
    }
  }
}

function entryName(value: unknown): string {
  if (typeof value !== "string" || validateUploadFileNames([value]) ||
      (process.platform === "win32" && (/[<>:"|?*\x00-\x1f]|[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)))) {
    fail("file_invalid_name", 400, "Enter a single valid file or folder name");
  }
  return value;
}

function requireAbsent(filePath: string): void {
  try { fs.lstatSync(filePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fail("file_exists", 409, "A file or folder with that name already exists");
}

function revision(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readText(filePath: string) {
  const stat = checkEntry(filePath);
  if (!stat.isFile() || stat.nlink > 1) fail("file_edit_unsupported", 400, "Only regular, non-hardlinked UTF-8 text files can be edited");
  if (stat.size > TEXT_PREVIEW_MAX_BYTES) fail("file_too_large_preview", 413, "File exceeds the 2 MiB editor limit");
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const current = fs.fstatSync(fd);
    if (!current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev) fail("file_edit_conflict", 409, "File changed while opening it");
    // Read at most the observed size plus one: growth never causes an unbounded allocation.
    bytes = Buffer.allocUnsafe(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size) fail("file_edit_conflict", 409, "File changed while reading it");
    bytes = bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail("file_edit_unsupported", 400, "Only UTF-8 text files can be edited"); }
  if (content.includes("\0")) fail("file_edit_unsupported", 400, "Binary files cannot be edited");
  return { content, revision: revision(bytes), stat };
}

export function readEditableFile(filePath: string, roots: Set<string>) {
  const target = authorizedPath(filePath, roots);
  fs.accessSync(target, fs.constants.W_OK);
  const { content, revision } = readText(target);
  return { content: content.replace(/\r\n/g, "\n"), revision };
}

export function saveTextFile(filePath: string, content: unknown, expectedRevision: unknown, roots: Set<string>) {
  if (typeof content !== "string" || content.includes("\0") || typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
    fail("file_edit_invalid", 400, "Content and the loaded file revision are required");
  }
  const target = authorizedPath(filePath, roots);
  fs.accessSync(target, fs.constants.W_OK);
  const original = readText(target);
  if (original.revision !== expectedRevision) fail("file_edit_conflict", 409, "File changed on disk. Your edits have not been saved");
  const text = original.content.includes("\r\n") ? content.replace(/\r?\n/g, "\r\n") : content;
  const bytes = Buffer.from(text, "utf-8");
  if (bytes.length > TEXT_PREVIEW_MAX_BYTES) fail("file_too_large_preview", 413, "File exceeds the 2 MiB editor limit");
  const temporary = path.join(path.dirname(target), `.omp-edit-${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: original.stat.mode & 0o777 });
    fs.chmodSync(temporary, original.stat.mode & 0o777);
    // Recheck after preparing the atomic replacement, including path replacement by another writer.
    const latest = readText(target);
    if (latest.revision !== expectedRevision || latest.stat.ino !== original.stat.ino || latest.stat.dev !== original.stat.dev) {
      fail("file_edit_conflict", 409, "File changed on disk. Your edits have not been saved");
    }
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return { content: text.replace(/\r\n/g, "\n"), revision: revision(bytes) };
}

export function createFileEntry(directory: string, name: unknown, isDirectory: boolean, roots: Set<string>): string {
  const target = authorizedPath(path.join(directory, entryName(name)), roots);
  if (isDirectory) fs.mkdirSync(target);
  else fs.writeFileSync(target, "", { flag: "wx" });
  return path.join(directory, name as string);
}

export function renameFileEntry(filePath: string, name: unknown, roots: Set<string>): string {
  const target = authorizedPath(filePath, roots);
  checkEntry(target);
  protectRoots(target, roots);
  const destination = path.join(path.dirname(target), entryName(name));
  requireAbsent(destination);
  fs.renameSync(target, destination);
  return path.join(path.dirname(filePath), name as string);
}

export async function deleteFileEntry(filePath: string, roots: Set<string>): Promise<void> {
  const target = authorizedPath(filePath, roots);
  const stat = checkEntry(target);
  protectRoots(target, roots);
  if (stat.isDirectory()) await fs.promises.rm(target, { recursive: true });
  else fs.unlinkSync(target);
}
