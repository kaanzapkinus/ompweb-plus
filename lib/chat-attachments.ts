import { encodeFilePathForApi, joinFilePath } from "@/lib/file-paths";

export const MAX_ATTACHED_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHED_FILES = 10;

export interface AttachedFileData {
  name: string;
  mimeType: string;
  /** Absolute on-disk path containing the unchanged uploaded bytes. */
  path: string;
  size: number;
}

export function formatAttachmentBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / (1024 * 1024))} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

interface UploadResponse {
  uploaded?: string[];
  errors?: Array<{ name: string; error: string }>;
  error?: string;
}

/** Save the original bytes without overwriting or extracting document content. */
export async function uploadAttachmentFile(file: File, cwd: string, signal?: AbortSignal): Promise<AttachedFileData> {
  if (!cwd) throw new Error("A workspace directory is required to save attachments.");
  if (file.size > MAX_ATTACHED_FILE_BYTES) {
    throw new Error(`${file.name}: files up to 10 MiB are supported.`);
  }
  const formData = new FormData();
  formData.append("files", file, file.name);
  let response: Response;
  try {
    response = await fetch(`/api/files/${encodeFilePathForApi(cwd)}?type=upload&conflict=error`, {
      method: "POST", body: formData, signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`${file.name}: could not upload — check the network connection.`);
  }
  let data: UploadResponse = {};
  try { data = await response.json() as UploadResponse; } catch { /* Report HTTP failure below. */ }
  if (!response.ok) {
    if (response.status === 409) {
      throw new Error(`${file.name}: a file with this name already exists in the workspace. Rename it and try again.`);
    }
    throw new Error(`${file.name}: upload failed — ${data.error ?? `HTTP ${response.status}`}.`);
  }
  const error = data.errors?.find((entry) => entry.name === file.name);
  if (error) throw new Error(`${file.name}: ${error.error}`);
  if (!data.uploaded?.includes(file.name)) throw new Error(`${file.name}: upload did not confirm the file was saved.`);
  return { name: file.name, mimeType: file.type, path: joinFilePath(cwd, file.name), size: file.size };
}

/** Only paths enter the prompt; the agent must inspect each full original file. */
export function composeMessageWithFileAttachments(message: string, files: readonly AttachedFileData[]): string {
  if (!files.length) return message;
  const listing = files.map((file) => `- ${JSON.stringify(file.path)}`).join("\n");
  const instruction = "Read each attached file in full at its exact path, then answer. If any part cannot be read faithfully (unsupported format, truncation, or otherwise), state that explicitly instead of omitting it.";
  return [message.trim(), `Attached files:\n${listing}`, instruction].filter(Boolean).join("\n\n");
}
