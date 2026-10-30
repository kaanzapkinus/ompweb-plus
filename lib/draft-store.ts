import { readRemoteDraft, saveRemoteDraft, sameDraftPayload, subscribeRemoteDraftChanges } from "./durable-draft-client";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraftFile {
  name: string;
  mimeType: string;
  path: string;
  size: number;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  files: ChatDraftFile[];
}

/** Content to put back in a composer. `replace` merges a later recovery with
 *  an earlier one in order: while the draft still starts with `lead` (the
 *  earlier block), it becomes `text`; otherwise only `fallback` is prepended.
 *  `images` and saved-path `files` are appended to the draft's attachments. */
export interface DraftRecovery {
  text: string;
  replace?: { lead: string; fallback: string };
  images?: ChatDraftImage[];
  files?: ChatDraftFile[];
}

/** The `{ data, mimeType }` images in an omp RPC payload; anything else is dropped. */
export function toDraftImages(value: unknown): ChatDraftImage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((image: unknown) => (
    image && typeof image === "object" && "data" in image && "mimeType" in image
      && typeof image.data === "string" && typeof image.mimeType === "string"
      ? [{ data: image.data, mimeType: image.mimeType }]
      : []
  ));
}

export function mergeRecoveredText(current: string, { text, replace }: DraftRecovery): string {
  if (!text) return current;
  if (replace && current.startsWith(replace.lead)) return text + current.slice(replace.lead.length);
  const lead = replace ? replace.fallback : text;
  return current ? `${lead}\n\n${current}` : lead;
}

// globalThis so dev Fast Refresh doesn't wipe drafts mid-typing.
declare global {
  var __ompChatDrafts: Map<string, ChatDraft> | undefined;
  var __ompChatDraftListeners: Set<() => void> | undefined;
  var __ompChatDraftRecoveryListeners: Set<(key: string, recovery: DraftRecovery) => void> | undefined;
}

const STORAGE_PREFIX = "omp-draft-";
const drafts: Map<string, ChatDraft> = (globalThis.__ompChatDrafts ??= readStoredDrafts());

function readStoredDrafts(): Map<string, ChatDraft> {
  const stored = new Map<string, ChatDraft>();
  try {
    const storageKeys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    for (const storageKey of storageKeys) {
      if (!storageKey?.startsWith(STORAGE_PREFIX)) continue;
      const value = localStorage.getItem(storageKey);
      if (value) {
        stored.set(storageKey.slice(STORAGE_PREFIX.length), { value, images: [], files: [] });
      }
    }
  } catch {
    // Storage may be unavailable (SSR or browser policy); keep drafts in memory.
  }
  try {
    const legacyKeys = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i));
    for (const storageKey of legacyKeys) {
      if (!storageKey?.startsWith(STORAGE_PREFIX)) continue;
      const value = sessionStorage.getItem(storageKey);
      if (!value) continue;
      const key = storageKey.slice(STORAGE_PREFIX.length);
      let durableValue: string | null = null;
      let canMigrate = false;
      try {
        durableValue = localStorage.getItem(storageKey);
        canMigrate = true;
      } catch {
        // Never overwrite a durable draft we could not read.
      }
      if (durableValue !== null) {
        // An empty durable value marks a clear, including for older legacy tabs.
        if (durableValue) stored.set(key, { value: durableValue, images: [], files: [] });
        else stored.delete(key);
        continue;
      }
      if (!stored.has(key)) stored.set(key, { value, images: [], files: [] });
      if (canMigrate) {
        try {
          localStorage.setItem(storageKey, value);
          sessionStorage.removeItem(storageKey);
        } catch {
          // Keep the legacy copy until its text has been saved durably.
        }
      }
    }
  } catch {
    // Legacy storage can be denied independently of durable storage.
  }
  return stored;
}

const listeners = (globalThis.__ompChatDraftListeners ??= new Set<() => void>());
const recoveryListeners = (globalThis.__ompChatDraftRecoveryListeners ??= new Set<(key: string, recovery: DraftRecovery) => void>());

export function hasUnsentDrafts(): boolean {
  return drafts.size > 0;
}

export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function subscribeDraftRecovery(listener: (key: string, recovery: DraftRecovery) => void): () => void {
  recoveryListeners.add(listener);
  return () => { recoveryListeners.delete(listener); };
}

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
    files: draft.files.map((file) => ({ ...file })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0 && draft.files.length === 0;
}

export function getDraft(key: string): ChatDraft | null {
  const remote = readRemoteDraft(key);
  if (remote) {
    const payload = remote.payload;
    if (payload && typeof payload.value === "string" && Array.isArray(payload.images) && Array.isArray(payload.files)) {
      const draft: ChatDraft = { value: payload.value, images: toDraftImages(payload.images), files: payload.files as ChatDraftFile[] };
      if (!isEmptyDraft(draft)) {
        drafts.set(key, draft);
        return cloneDraft(draft);
      }
    }
    drafts.delete(key);
    return null;
  }
  const draft = drafts.get(key);
  if (draft) return cloneDraft(draft);
  // Another tab may have written to localStorage after this tab's module loaded
  // its snapshot.  Check live storage so we never overwrite a cross-tab save.
  try {
    const liveText = localStorage.getItem(STORAGE_PREFIX + key);
    if (liveText) {
      const live: ChatDraft = { value: liveText, images: [], files: [] };
      drafts.set(key, live);
      return cloneDraft(live);
    }
  } catch {
    // Storage unavailable; cross-tab reconciliation is best-effort only.
  }
  return null;
}

export function recoverDraft(key: string, recovery: DraftRecovery): void {
  if (key) {
    const draft = getDraft(key) ?? { value: "", images: [], files: [] };
    setDraft(key, {
      ...draft,
      value: mergeRecoveredText(draft.value, recovery),
      images: [...draft.images, ...(recovery.images ?? [])],
      files: [...draft.files, ...(recovery.files ?? [])],
    });
  }
  // Publish the recovery intent separately: ordinary persistence must not
  // reapply it, and the mounted composer may have React updates still queued.
  for (const listener of recoveryListeners) listener(key, recovery);
}

export function getDraftSummary(key: string): { text: string; hasAttachments: boolean } {
  const draft = drafts.get(key);
  if (!draft) return { text: "", hasAttachments: false };
  return {
    text: draft.value,
    hasAttachments: draft.images.length > 0 || draft.files.length > 0,
  };
}

/** Hydration/restoration notifications; ordinary edits keep their existing path. */
export function subscribeDraftChanges(key: string, listener: () => void): () => void {
  const cached = readRemoteDraft(key);
  const legacy = drafts.get(key);
  if (!cached && legacy && !isEmptyDraft(legacy)) saveRemoteDraft(key, { ...cloneDraft(legacy) });
  return subscribeRemoteDraftChanges(key, () => {
    const draft = getDraft(key);
    if (draft) drafts.set(key, cloneDraft(draft));
    else drafts.delete(key);
    if (draft?.value) {
      try { localStorage.setItem(STORAGE_PREFIX + key, draft.value); } catch { /* The shared cache keeps the other durable copy. */ }
    } else clearStoredText(key);
    for (const callback of listeners) callback();
    listener();
  });
}

export function setDraft(key: string, draft: ChatDraft): void {
  const current = getDraft(key);
  if (sameDraftPayload(current, isEmptyDraft(draft) ? null : draft)) return;
  if (isEmptyDraft(draft)) {
    clearDraft(key);
    return;
  }
  // Keep every conversation's unsent text; storage quota failures must never
  // evict another draft from memory or from durable storage.
  drafts.set(key, cloneDraft(draft));
  if (draft.value) {
    try {
      // Small synchronous fallback; full attachments are persisted by the client.
      localStorage.setItem(STORAGE_PREFIX + key, draft.value);
      sessionStorage.removeItem(STORAGE_PREFIX + key);
    } catch {
      // Preserve the in-memory draft and any legacy copy if storage is full/denied.
    }
  } else {
    clearStoredText(key);
  }
  saveRemoteDraft(key, { ...cloneDraft(draft) });
  for (const listener of listeners) listener();
}

function clearStoredText(key: string): void {
  const storageKey = STORAGE_PREFIX + key;
  try {
    // Keep a small empty marker: deleting the key could let another tab's
    // still-unmigrated session draft resurrect text that was already cleared.
    localStorage.setItem(storageKey, "");
  } catch {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // Storage is unavailable; the in-memory clear still takes effect.
    }
  }
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // The durable empty marker masks legacy text when cleanup is denied.
  }
}

export function clearDraft(key: string, submitted?: ChatDraft): boolean {
  const current = getDraft(key);
  if (submitted && !sameDraftPayload(current, submitted)) return false;
  const deleted = drafts.delete(key);
  clearStoredText(key);
  if (current) saveRemoteDraft(key, null);
  if (deleted || current) {
    for (const listener of listeners) listener();
  }
  return true;
}
