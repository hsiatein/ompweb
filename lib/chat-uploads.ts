import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { getAgentDir } from "@/lib/omp/paths";

/**
 * Server store for chat attachments that cannot be inlined as text (PDF,
 * archives, office documents, ...): `<agent dir>/uploads/<date>/<random>/<name>`.
 * The prompt references the absolute path and the agent opens the file with
 * its tools. Not tied to a session, so a new chat can attach before it has an
 * id; files older than UPLOAD_RETENTION_DAYS are pruned on the next upload.
 */
export { MAX_CHAT_UPLOAD_BYTES } from "@/lib/uploaded-files";
export const UPLOAD_RETENTION_DAYS = 30;

export function chatUploadsDir(): string {
  return path.join(getAgentDir(), "uploads");
}

/** Remove day folders (`YYYY-MM-DD`) older than the retention window. */
export function pruneChatUploads(now = Date.now()): void {
  const root = chatUploadsDir();
  let days: string[];
  try {
    days = fs.readdirSync(root);
  } catch {
    return;
  }
  const cutoff = now - UPLOAD_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const day of days) {
    const time = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN;
    if (Number.isFinite(time) && time < cutoff) fs.rmSync(path.join(root, day), { recursive: true, force: true });
  }
}

/** Store one file under a fresh random folder; returns its absolute path. */
export function storeChatUpload(name: string, bytes: Uint8Array, now = new Date()): string {
  const directory = path.join(chatUploadsDir(), now.toISOString().slice(0, 10), randomBytes(6).toString("hex"));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, bytes, { flag: "wx", mode: 0o600 });
  return filePath;
}
