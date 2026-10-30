import type { ExecutionModel, ExecutionPromptOptions } from "./session-execution-types";
import type { ChatDraftFile, ChatDraftImage } from "./draft-store";
import { draftTextCache, readRemoteDraft, saveRemoteDraft, sameDraftPayload, subscribeRemoteDraftChanges } from "./durable-draft-client";

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
// Synchronous attachment access; IndexedDB/server persistence is shared by both adapters.
const attachments = new WeakMap<StorageLike, Map<string, {
  serialized: string;
  images?: ChatDraftImage[];
  requestImages?: ChatDraftImage[];
}>>();

function serializedDraft(draft: ScheduleDraft): string {
  return JSON.stringify(draftTextCache({ ...draft }));
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage; } catch { return null; }
}

export function scheduleDraftKey(sessionId?: string, cwd?: string | null, workspaceId?: string | null): string | null {
  return sessionId ? `omp-web:schedule-draft:${JSON.stringify(["session", sessionId])}`
    : cwd ? `omp-web:schedule-draft:${JSON.stringify(workspaceId ? ["workspace", workspaceId, cwd] : ["workspace", cwd])}` : null;
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

function parseDraft(value: ScheduleDraft | null): ScheduleDraft | null {
  try {
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
    return value;
  } catch { return null; }
}

function localScheduleDraft(key: string, storage: StorageLike | null): ScheduleDraft | null {
  try {
    const serialized = storage?.getItem(key) ?? "null";
    const value = parseDraft(JSON.parse(serialized) as ScheduleDraft | null);
    const memory = storage ? attachments.get(storage)?.get(key) : undefined;
    if (value && memory?.serialized === serialized) {
      if (memory.images) value.images = memory.images.map(image => ({ ...image }));
      if (value.request && memory.requestImages) value.request.body.images = memory.requestImages.map(image => ({ ...image }));
    }
    return value;
  } catch { return null; }
}

export function readScheduleDraft(key: string | null, storage = browserStorage()): ScheduleDraft | null {
  if (!key) return null;
  if (typeof window !== "undefined" && storage === browserStorage()) {
    const remote = readRemoteDraft(key);
    if (remote) return parseDraft(remote.payload as ScheduleDraft | null);
  }
  return localScheduleDraft(key, storage);
}

export function subscribeScheduleDraft(key: string | null, listener: () => void): () => void {
  if (!key) return () => {};
  const storage = browserStorage();
  if (!readRemoteDraft(key)) {
    const legacy = localScheduleDraft(key, storage);
    if (legacy) saveRemoteDraft(key, { ...legacy });
  }
  return subscribeRemoteDraftChanges(key, () => {
    const draft = readScheduleDraft(key);
    if (draft) writeLocalDraft(key, draft, storage);
    else {
      try { storage?.removeItem(key); } catch { /* The shared cache remains authoritative. */ }
      if (storage) attachments.get(storage)?.delete(key);
    }
    listener();
  });
}

function sameScheduleDraft(left: ScheduleDraft | null, right: ScheduleDraft): boolean {
  return Boolean(left && serializedDraft(left) === serializedDraft(right)
    && sameDraftPayload(left.images, right.images)
    && sameDraftPayload(left.request?.body.images, right.request?.body.images));
}

function writeLocalDraft(key: string, draft: ScheduleDraft, storage: StorageLike | null): void {
  if (!storage) return;
  const serialized = serializedDraft(draft);
  let memory = attachments.get(storage);
  if (!memory) attachments.set(storage, memory = new Map());
  memory.set(key, { serialized, images: draft.images, requestImages: draft.request?.body.images });
  try { storage.setItem(key, serialized); } catch { /* The shared cache persists browser drafts independently. */ }
}

export function writeScheduleDraft(key: string | null, draft: ScheduleDraft, storage = browserStorage()): void {
  if (!key) return;
  const current = readScheduleDraft(key, storage);
  if (sameScheduleDraft(current, draft)) return;
  writeLocalDraft(key, draft, storage);
  if (typeof window !== "undefined" && storage === browserStorage()) saveRemoteDraft(key, { ...draft });
}

export function clearScheduleDraft(key: string | null, submitted: ScheduleDraft, storage = browserStorage()): boolean {
  if (!key) return true;
  const current = readScheduleDraft(key, storage);
  const comparable = parseDraft({
    ...submitted,
    request: submitted.request ? { ...submitted.request, body: { ...submitted.request.body } } : null,
  }) ?? submitted;
  if (current && !sameScheduleDraft(current, comparable)) return false;
  if (!current) {
    try {
      const stored = storage?.getItem(key);
      if (stored != null && stored !== serializedDraft(submitted)) return false;
    } catch { /* Preserve the existing best-effort clear when storage is denied. */ }
  }
  try { storage?.removeItem(key); } catch { /* The shared cache remains authoritative. */ }
  if (storage) attachments.get(storage)?.delete(key);
  if (current && typeof window !== "undefined" && storage === browserStorage()) saveRemoteDraft(key, null);
  return true;
}
