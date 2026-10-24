import type { ChatDraftFile, ChatDraftImage } from "@/lib/draft-store";
import type { AttachedFileData } from "@/lib/chat-attachments";
import { isBase64ImageWithinLimits } from "@/lib/image-attachments";

export interface AttachedImage {
  data: string;   // base64, no prefix
  mimeType: string;
  previewUrl: string; // object URL for display
}

export type AttachedFile = AttachedFileData;

export function imageToDraftImage(image: AttachedImage): ChatDraftImage {
  return { data: image.data, mimeType: image.mimeType };
}

export function draftImageToAttachedImage(image: ChatDraftImage): AttachedImage {
  return {
    ...image,
    previewUrl: `data:${image.mimeType};base64,${image.data}`,
  };
}

/** Every image comes back, even past MAX_ATTACHED_IMAGES (recovered queue
 *  messages can exceed it); sending enforces the cap, so the user chooses. */
export function draftImagesToAttachedImages(images: ChatDraftImage[] | undefined): AttachedImage[] {
  return (images ?? [])
    .filter(isBase64ImageWithinLimits)
    .map(draftImageToAttachedImage);
}

export function fileToDraftFile(file: AttachedFile): ChatDraftFile {
  return { name: file.name, mimeType: file.mimeType, path: file.path, size: file.size };
}

/** Recover every saved path; the composer must never silently lose a queued file. */
export function draftFilesToAttachedFiles(files: ChatDraftFile[] | undefined): AttachedFile[] {
  return (files ?? []).filter((file) => typeof file.name === "string"
    && typeof file.mimeType === "string"
    && typeof file.path === "string" && (file.path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(file.path))
    && Number.isFinite(file.size) && file.size >= 0).map(fileToDraftFile);
}

export function revokeImagePreview(image: AttachedImage): void {
  if (image.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(image.previewUrl);
  }
}
