import type { ChatDraftFile, ChatDraftImage } from "@/lib/draft-store";
import {
  MAX_ATTACHED_TEXT_FILES,
  selectTextAttachments,
  type AttachedTextFileData,
} from "@/lib/chat-attachments";
import {
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "@/lib/image-attachments";

export interface AttachedImage {
  data: string;   // base64, no prefix
  mimeType: string;
  previewUrl: string; // object URL for display
}

export type AttachedTextFile = AttachedTextFileData;

export function imageToDraftImage(image: AttachedImage): ChatDraftImage {
  return { data: image.data, mimeType: image.mimeType };
}

export function draftImageToAttachedImage(image: ChatDraftImage): AttachedImage {
  return {
    ...image,
    previewUrl: `data:${image.mimeType};base64,${image.data}`,
  };
}

export function draftImagesToAttachedImages(images: ChatDraftImage[] | undefined): AttachedImage[] {
  return (images ?? [])
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(draftImageToAttachedImage);
}

export function textFileToDraftFile(file: AttachedTextFile): ChatDraftFile {
  return { name: file.name, mimeType: file.mimeType, content: file.content, size: file.size, ...(file.uploadedPath ? { uploadedPath: file.uploadedPath } : {}) };
}

export function draftFilesToAttachedFiles(files: ChatDraftFile[] | undefined): AttachedTextFile[] {
  const shaped = (files ?? []).filter((file) => typeof file.name === "string"
    && typeof file.mimeType === "string"
    && typeof file.content === "string"
    && Number.isFinite(file.size)
    && (file.uploadedPath === undefined || typeof file.uploadedPath === "string"));
  // Uploaded files only take a slot; the text budget covers inlined content.
  const inline = selectTextAttachments(shaped.filter((file) => !file.uploadedPath), { usedBytes: 0, usedSlots: 0 }).accepted;
  const uploaded = shaped.filter((file) => file.uploadedPath).slice(0, Math.max(0, MAX_ATTACHED_TEXT_FILES - inline.length));
  return [...inline, ...uploaded];
}

export function revokeImagePreview(image: AttachedImage): void {
  if (image.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(image.previewUrl);
  }
}
