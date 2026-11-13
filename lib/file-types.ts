/** Text files up to this size load automatically and can be edited. */
export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
/** Larger text files load only on request (`force=1`), read-only, up to this size. */
export const TEXT_PREVIEW_FORCE_MAX_BYTES = 50 * 1024 * 1024;
/** Above this the viewer shows plain text instead of syntax highlighting (it would stall the page). */
export const TEXT_HIGHLIGHT_MAX_BYTES = 512 * 1024;
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
export const DOCX_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

export type DocumentPreviewKind = "pdf" | "docx";

export const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

export const AUDIO_EXT_TO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  weba: "audio/webm",
};

/** Containers browsers can play in <video>; codecs inside may still be unsupported (the viewer then offers a download). */
export const VIDEO_EXT_TO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ogv: "video/ogg",
  mkv: "video/x-matroska",
};

export const DOCUMENT_EXT_TO_MIME: Record<DocumentPreviewKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function getBaseName(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").pop() ?? "";
}

export function getFileExt(filePath: string): string {
  return getBaseName(filePath).toLowerCase().split(".").pop() ?? "";
}

export function getImageMime(filePath: string): string | null {
  return IMAGE_EXT_TO_MIME[getFileExt(filePath)] ?? null;
}

export function getAudioMime(filePath: string): string | null {
  return AUDIO_EXT_TO_MIME[getFileExt(filePath)] ?? null;
}

export function getDocumentMime(filePath: string): string | null {
  return DOCUMENT_EXT_TO_MIME[getFileExt(filePath) as DocumentPreviewKind] ?? null;
}

export function documentPreviewKind(filePath: string): DocumentPreviewKind | null {
  const ext = getFileExt(filePath);
  if (ext === "pdf" || ext === "docx") return ext;
  return null;
}

/**
 * SVG is the only streamed preview type a browser executes as a document.
 * Serving it without a restrictive Content-Security-Policy would let a
 * repo-controlled SVG, opened as a direct navigation, run script in the
 * omp-web origin where every /api route is reachable. These headers only
 * affect document rendering; <img> preview embedding ignores them. The
 * directives mirror the DOCX preview policy in app/api/files/[...path]/route.ts
 * so legit SVGs keep inline styles and data-URI images.
 */
export function getStreamSecurityHeaders(contentType: string): Record<string, string> {
  if (contentType !== "image/svg+xml") return {};
  return {
    "Content-Security-Policy":
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  };
}

export function isImagePath(filePath: string): boolean {
  return getImageMime(filePath) !== null;
}

export function getVideoMime(filePath: string): string | null {
  return VIDEO_EXT_TO_MIME[getFileExt(filePath)] ?? null;
}

export function isVideoPath(filePath: string): boolean {
  return getVideoMime(filePath) !== null;
}

/** Bytes inspected to tell text from binary before a text preview is sent. */
export const BINARY_SNIFF_BYTES = 8192;

/**
 * Whether a file sample is binary: it contains NUL, or it is not UTF-8. When the sample is
 * only the start of the file (`truncated`), a multi-byte character cut at the end is allowed.
 * UTF-16 text (which contains NULs) counts as binary; the viewer offers it as a download.
 */
export function looksBinary(sample: Uint8Array, truncated: boolean): boolean {
  if (sample.includes(0)) return true;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  // Up to 3 trailing bytes may be the start of a character cut off by the sample end.
  for (let cut = 0; cut <= Math.min(truncated ? 3 : 0, sample.length); cut++) {
    try {
      decoder.decode(sample.subarray(0, sample.length - cut));
      return false;
    } catch {
      // Try with one more trailing byte dropped.
    }
  }
  return true;
}

export function isAudioPath(filePath: string): boolean {
  return getAudioMime(filePath) !== null;
}

export function isDocumentPreviewPath(filePath: string): boolean {
  return documentPreviewKind(filePath) !== null;
}
