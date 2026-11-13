import { NextResponse } from "next/server";
import { readBytesWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { MAX_CHAT_UPLOAD_BYTES, pruneChatUploads, storeChatUpload } from "@/lib/chat-uploads";
import { validateUploadFileNames } from "@/lib/file-upload";

// POST /api/uploads?name=<file name> - raw body: one chat attachment that
// cannot be inlined as text. Returns {name, path, size}; the client puts the
// path in the prompt (lib/uploaded-files.ts). One file per request keeps the
// body a plain byte stream (React Native has no reliable multipart Blob).
export async function POST(request: Request) {
  const name = new URL(request.url).searchParams.get("name") ?? "";
  const invalid = validateUploadFileNames([name]);
  if (invalid) return NextResponse.json({ error: invalid, code: "invalid_file_name" }, { status: 400 });
  let bytes: Uint8Array;
  try {
    bytes = await readBytesWithinLimit(request, MAX_CHAT_UPLOAD_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Each upload must be 25MB or smaller", code: "upload_file_too_large" }, { status: 413 });
    }
    throw error;
  }
  pruneChatUploads();
  const filePath = storeChatUpload(name, bytes);
  return NextResponse.json({ name, path: filePath, size: bytes.byteLength }, { headers: { "Cache-Control": "no-store" } });
}
