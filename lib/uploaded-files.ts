/**
 * Client-safe: chat attachments that are not inlined as text are uploaded to
 * POST /api/uploads first, then referenced in the prompt by absolute path.
 * The Android app mirrors this format (ompnative src/attachments.ts).
 */

/** Per-file limit of POST /api/uploads. */
export const MAX_CHAT_UPLOAD_BYTES = 25 * 1024 * 1024;
export interface UploadedFile {
  name: string;
  path: string;
  size: number;
}

export function uploadedFileReference(file: UploadedFile): string {
  return `<file name=${JSON.stringify(file.name)} path=${JSON.stringify(file.path)} size="${file.size}">\nAttached file (not inlined). Open it from this path with your tools.\n</file>`;
}

export async function uploadChatFile(file: File): Promise<UploadedFile> {
  const response = await fetch(`/api/uploads?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  const body = await response.json().catch(() => ({})) as Partial<UploadedFile> & { error?: string };
  if (!response.ok || typeof body.path !== "string") throw new Error(body.error || `HTTP ${response.status}`);
  return { name: file.name, path: body.path, size: body.size ?? file.size };
}
