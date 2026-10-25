import type { ExecutionModel, ExecutionPromptOptions } from "./session-execution-types";
import type { ChatDraftFile, ChatDraftImage } from "./draft-store";

export type SchedulePromptRequest = ExecutionModel & ExecutionPromptOptions & { prompt: string; runAt: number; requestId: string };
export type ScheduleDraft = ExecutionPromptOptions & {
  prompt: string;
  model: ExecutionModel | null;
  timingMode: "quota" | "relative" | "exact";
  resetKey: string;
  delayHours: string;
  delayMinutes: string;
  date: string;
  files?: ChatDraftFile[];
  imageKeys?: string[];
  missingImageCount?: number;
  request: { signature: string; body: SchedulePromptRequest; imageCount?: number } | null;
};
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
// Attachment bytes live only for the lifetime of this browser document.
const attachments = new WeakMap<StorageLike, Map<string, {
  serialized: string;
  images?: ChatDraftImage[];
  requestImages?: ChatDraftImage[];
}>>();

function serializedDraft(draft: ScheduleDraft): string {
  const { images, ...fields } = draft;
  const request = draft.request;
  const requestFields = request ? (({ images: _images, ...body }) => ({
    ...request,
    body,
    imageCount: request.body.images?.length || request.imageCount || undefined,
  }))(request.body) : null;
  return JSON.stringify({
    ...fields,
    missingImageCount: images?.length || draft.missingImageCount || undefined,
    request: requestFields,
  });
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage; } catch { return null; }
}

export function scheduleDraftKey(sessionId?: string, cwd?: string | null): string | null {
  return sessionId ? `omp-web:schedule-draft:${JSON.stringify(["session", sessionId])}`
    : cwd ? `omp-web:schedule-draft:${JSON.stringify(["workspace", cwd])}` : null;
}

export function emptyScheduleDraft(model: ExecutionModel | null): ScheduleDraft {
  return { prompt: "", model: model ? { provider: model.provider, modelId: model.modelId } : null, timingMode: "relative", resetKey: "", delayHours: "3", delayMinutes: "0", date: "", request: null };
}

export function schedulePromptSignature(draft: ScheduleDraft): string {
  const hours = Number(draft.delayHours);
  const minutes = Number(draft.delayMinutes);
  const total = Number.isInteger(hours) && hours >= 0 && Number.isInteger(minutes) && minutes >= 0 ? hours * 60 + minutes : NaN;
  const extras = {
    thinkingLevel: draft.thinkingLevel, toolPreset: draft.toolPreset,
    fastMode: draft.fastMode, slowMode: draft.slowMode, advisorEnabled: draft.advisorEnabled,
    files: draft.files?.length ? draft.files : undefined,
    imageKeys: draft.imageKeys?.length ? draft.imageKeys : undefined,
  };
  const identity: unknown[] = [draft.prompt.trim(), draft.timingMode, draft.timingMode === "relative" ? total : draft.timingMode === "quota" ? draft.resetKey : draft.date, draft.model?.provider, draft.model?.modelId];
  if (Object.values(extras).some(value => value !== undefined)) identity.push(extras);
  return JSON.stringify(identity);
}

function isModel(value: unknown): value is ExecutionModel {
  return Boolean(value && typeof value === "object" && "provider" in value && typeof value.provider === "string" && "modelId" in value && typeof value.modelId === "string");
}

function expiredReset(key: string): boolean {
  if (!key) return false;
  try {
    const value: unknown = JSON.parse(key);
    return Array.isArray(value) && typeof value[6] === "number" && value[6] <= Date.now();
  } catch { return false; }
}

export function readScheduleDraft(key: string | null, storage = browserStorage()): ScheduleDraft | null {
  if (!key || !storage) return null;
  try {
    const serialized = storage.getItem(key) ?? "null";
    const value = JSON.parse(serialized) as ScheduleDraft | null;
    if (!value || typeof value !== "object" || typeof value.prompt !== "string" || (value.model !== null && !isModel(value.model))
      || !["quota", "relative", "exact"].includes(value.timingMode)
      || ![value.resetKey, value.delayHours, value.delayMinutes, value.date].every((field) => typeof field === "string")) return null;
    const request = value.request;
    if (request !== null && (!request || typeof request.signature !== "string" || !isModel(request.body)
      || typeof request.body.prompt !== "string" || !Number.isFinite(request.body.runAt)
      || typeof request.body.requestId !== "string" || !/^[a-f0-9]{32}$/.test(request.body.requestId))) return null;
    // A stale quota choice is never replaced with a guessed reset. Reconciliation
    // still uses the durable body, even after its displayed choice has expired.
    if (expiredReset(value.resetKey)) value.resetKey = "";
    if (request) {
      const signature: unknown = JSON.parse(request.signature);
      if (!Array.isArray(signature) || (signature.length !== 5 && signature.length !== 6)) return null;
      if (signature[1] === "quota" && typeof signature[2] === "string" && expiredReset(signature[2])) {
        signature[2] = "";
        request.signature = JSON.stringify(signature);
      }
    }
    const memory = attachments.get(storage)?.get(key);
    if (memory?.serialized === serialized) {
      if (memory.images) value.images = memory.images;
      if (request && memory.requestImages) request.body.images = memory.requestImages;
    }
    return value;
  } catch { return null; }
}

export function writeScheduleDraft(key: string | null, draft: ScheduleDraft, storage = browserStorage()): void {
  if (!key || !storage) return;
  const serialized = serializedDraft(draft);
  let memory = attachments.get(storage);
  if (!memory) attachments.set(storage, memory = new Map());
  memory.set(key, { serialized, images: draft.images, requestImages: draft.request?.body.images });
  try { storage.setItem(key, serialized); } catch { /* Best effort when browser storage is unavailable or full. */ }
}

export function clearScheduleDraft(key: string | null, submitted: ScheduleDraft, storage = browserStorage()): boolean {
  if (!key || !storage) return true;
  try {
    const stored = storage.getItem(key);
    if (stored !== null && stored !== serializedDraft(submitted)) return false;
    storage.removeItem(key);
    attachments.get(storage)?.delete(key);
  } catch { /* The in-memory draft remains usable when storage is blocked. */ }
  return true;
}
