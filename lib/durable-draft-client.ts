import type { DraftPayload, DraftRecord, DraftVersion } from "./durable-draft-types";

export type DraftSyncState = {
  status: "loading" | "saving" | "saved" | "offline" | "conflict" | "error";
  error?: string;
  uploading?: boolean;
};
type Mutation = { mutationId: string; baseRevision: number; payload: DraftPayload | null; sent?: boolean };
type Cache = {
  key: string;
  record: DraftRecord | null;
  payload: DraftPayload | null;
  queue: Mutation[];
  conflict: boolean;
  stamp: string;
  needsImages?: boolean;
  writerId?: string;
  foreignPending?: boolean;
};
type Entry = Cache & {
  known: boolean;
  state: DraftSyncState;
  listeners: Set<() => void>;
  changes: Set<() => void>;
  ready: Promise<void>;
  persistence: Promise<void>;
  refresh?: Promise<void>;
  sending?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  poll?: ReturnType<typeof setInterval>;
  generation: number;
  cacheError?: string;
  etag?: string;
  choosing?: boolean;
  imageIds: Map<string, Map<string, string>>;
  foreignPending: boolean;
  recovering?: Promise<void>;
  imageRecovery?: Promise<void>;
  uploading?: boolean;
  pendingCache?: Cache;
  persistenceRunning?: boolean;
};

const PREFIX = "omp-web:durable-draft:";
const DATABASE = "omp-web-durable-drafts";
const STORE = "drafts";
const IMAGE_STORE = "images";
const JOURNAL_STORE = "journals";
const IMAGE_OWNER_STORE = "imageOwners";
const JOURNAL_PREFIX = "omp-web:durable-draft-writer:";
const LOCAL_IMAGE = "localDraftImageId";
const writerId = id();
const localPhotoIds = new Map<string, Map<string, string>>();
const localPhotoData = new Map<string, string>();
const photoWrites = new Map<string, Promise<boolean>>();
const photoReads = new Map<string, Promise<string>>();
const DEBOUNCE_MS = 450;
const POLL_MS = 5_000;
const entries = new Map<string, Entry>();
let database: Promise<IDBDatabase | null> | undefined;
let watching = false;
let discovered = false;
let stopWatching: (() => void) | undefined;

function browser(): boolean { return typeof window !== "undefined"; }
function offline(): boolean { return typeof navigator !== "undefined" && navigator.onLine === false; }
function id(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => clone(item)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  return value;
}
export function sameDraftPayload(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.keys(left).filter(key => (left as Record<string, unknown>)[key] !== undefined);
  const b = Object.keys(right).filter(key => (right as Record<string, unknown>)[key] !== undefined);
  return a.length === b.length && a.every(key => Object.prototype.hasOwnProperty.call(right, key)
    && sameDraftPayload((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

// Copy only the two image-bearing fields before JSON serialization. Never hand
// base64 to JSON.stringify/localStorage, including when a durable request exists.
export function draftTextCache(payload: DraftPayload | null): DraftPayload | null {
  if (!payload) return null;
  const result = { ...payload };
  if (Array.isArray(payload.images) && payload.images.length) {
    result.images = [];
    result.missingImageCount = payload.images.length;
  }
  const request = payload.request as { body?: Record<string, unknown>; imageCount?: number } | null | undefined;
  if (request?.body && Array.isArray(request.body.images) && request.body.images.length) {
    result.request = { ...request, body: { ...request.body, images: [] }, imageCount: request.body.images.length };
  }
  return result;
}
function hasImages(payload: DraftPayload | null): boolean {
  const request = payload?.request as { body?: { images?: unknown[] } } | undefined;
  return Boolean((Array.isArray(payload?.images) && payload.images.length) || request?.body?.images?.length);
}
function withImages(payload: DraftPayload | null, full: DraftPayload | null): DraftPayload | null {
  if (!payload || !full) return payload;
  const result = { ...payload };
  if (Number(payload.missingImageCount) > 0 && Array.isArray(full.images) && full.images.length) {
    const incoming = Array.isArray(payload.images) ? payload.images : [];
    const saved = full.images;
    result.images = [...clone(saved), ...incoming.filter(image => !saved.some(existing => sameDraftPayload(image, existing)))];
    if (!full.missingImageCount) delete result.missingImageCount;
  }
  const request = payload.request as { body?: Record<string, unknown>; imageCount?: number } | undefined;
  const source = full.request as { body?: { images?: unknown[] }; imageCount?: number } | undefined;
  if (request?.body && request.imageCount && source?.body?.images?.length) {
    const incoming = Array.isArray(request.body.images) ? request.body.images : [];
    const saved = source.body.images;
    result.request = { ...request, body: { ...request.body, images: [
      ...clone(saved), ...incoming.filter(image => !saved.some(existing => sameDraftPayload(image, existing))),
    ] } };
    if (!source.imageCount) delete (result.request as Record<string, unknown>).imageCount;
  }
  return result;
}
function mapImages(payload: DraftPayload | null, convert: (image: Record<string, unknown>, index: number, request: boolean) => Record<string, unknown>): DraftPayload | null {
  if (!payload) return null;
  const result = { ...payload };
  const images = (value: unknown[], request: boolean) => value.map((image, index) => image && typeof image === "object" ? convert(image as Record<string, unknown>, index, request) : image);
  if (Array.isArray(payload.images)) result.images = images(payload.images, false);
  const request = payload.request as { body?: Record<string, unknown> } | null | undefined;
  if (request?.body && Array.isArray(request.body.images)) result.request = { ...request, body: { ...request.body, images: images(request.body.images, true) } };
  return result;
}
function journalId(key: string, owner = writerId): string { return `${owner}:${encodeURIComponent(key)}`; }
function localPayload(payload: DraftPayload | null): DraftPayload | null {
  return mapImages(payload, image => {
    if (typeof image.data !== "string" || typeof image.mimeType !== "string") return { ...image };
    let mimeIds = localPhotoIds.get(image.data);
    if (!mimeIds) localPhotoIds.set(image.data, mimeIds = new Map());
    let imageId = mimeIds.get(image.mimeType);
    if (!imageId) {
      imageId = id();
      mimeIds.set(image.mimeType, imageId);
      localPhotoData.set(imageId, image.data);
      photoWrites.set(imageId, writePhoto(imageId, image.data).catch(() => false));
    }
    const fields: Record<string, unknown> = { ...image, [LOCAL_IMAGE]: imageId };
    delete fields.data;
    return fields;
  });
}
function cache(entry: Entry): Cache {
  return {
    key: entry.key, writerId, foreignPending: entry.foreignPending,
    record: entry.record && { ...entry.record, payload: localPayload(entry.record.payload) },
    payload: localPayload(entry.payload),
    queue: entry.queue.map(item => ({ ...item, payload: localPayload(item.payload) })),
    conflict: entry.conflict, stamp: entry.stamp,
    needsImages: Boolean(entry.needsImages || hasImages(entry.payload) || hasImages(entry.record?.payload ?? null) || entry.queue.some(item => hasImages(item.payload))),
  };
}
function readCache(key: string): Cache | null {
  try {
    const value = JSON.parse(localStorage.getItem(PREFIX + key) ?? "null") as Cache | null;
    if (value?.key === key && Array.isArray(value.queue) && typeof value.stamp === "string") return value;
  } catch { /* A blocked/corrupt cache must not prevent in-memory editing. */ }
  return null;
}
function openDatabase(): Promise<IDBDatabase | null> {
  if (database) return database;
  let resolve!: (value: IDBDatabase | null) => void;
  let reject!: (reason: unknown) => void;
  const opening = new Promise<IDBDatabase | null>((fulfill, fail) => { resolve = fulfill; reject = fail; });
  database = opening;
  try {
    if (typeof indexedDB === "undefined") { resolve(null); return opening; }
    const request = indexedDB.open(DATABASE, 3);
    let rejected = false;
    const fail = (error: Error) => {
      rejected = true;
      if (database === opening) database = undefined;
      reject(error);
    };
    request.onupgradeneeded = () => {
      for (const name of [STORE, IMAGE_STORE, JOURNAL_STORE, IMAGE_OWNER_STORE]) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      }
    };
    request.onsuccess = () => {
      const connection = request.result;
      if (rejected) { connection.close(); return; }
      connection.onversionchange = () => {
        connection.close();
        if (database === opening) database = undefined;
      };
      resolve(connection);
    };
    request.onerror = () => fail(request.error ?? new Error("Cannot open the local photo cache"));
    request.onblocked = () => fail(new Error("The local photo cache is blocked by another tab"));
  } catch (error) {
    if (database === opening) database = undefined;
    reject(error);
  }
  void opening.catch(() => { if (database === opening) database = undefined; });
  return opening;
}
async function databaseRead<T>(store: string, key: string): Promise<T | null> {
  const db = await openDatabase();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, "readonly").objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error ?? new Error("Cannot read locally saved photos"));
  });
}
async function databaseRows(store: string): Promise<Cache[]> {
  const db = await openDatabase();
  if (!db) return [];
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, "readonly").objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(request.error ?? new Error("Cannot read locally saved draft queues"));
  });
}
async function writePhoto(imageId: string, data: string): Promise<boolean> {
  const db = await openDatabase();
  if (!db) return false;
  return new Promise<boolean>((resolve, reject) => {
    const transaction = db.transaction(IMAGE_STORE, "readwrite");
    transaction.objectStore(IMAGE_STORE).put(data, imageId);
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error ?? new Error("Cannot save photos on this device"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Local photo save was interrupted"));
  });
}
async function hydratePayload(payload: DraftPayload | null): Promise<DraftPayload | null> {
  const pending: Promise<void>[] = [];
  const hydrated = mapImages(payload, image => {
    const imageId = image[LOCAL_IMAGE];
    if (typeof imageId !== "string") return { ...image };
    const result = { ...image };
    delete result[LOCAL_IMAGE];
    const read = localPhotoData.has(imageId) ? Promise.resolve(localPhotoData.get(imageId)!) : (photoReads.get(imageId) ?? (() => {
      const promise: Promise<string> = databaseRead<string>(IMAGE_STORE, imageId).then(data => {
        if (typeof data !== "string") throw new Error("Locally saved photo bytes are missing");
        return data;
      }).catch(error => {
        if (photoReads.get(imageId) === promise) photoReads.delete(imageId);
        throw error;
      });
      photoReads.set(imageId, promise);
      return promise;
    })());
    pending.push(read.then(data => {
      result.data = data;
      localPhotoData.set(imageId, data);
      if (typeof result.mimeType === "string") {
        let mimeIds = localPhotoIds.get(data);
        if (!mimeIds) localPhotoIds.set(data, mimeIds = new Map());
        mimeIds.set(result.mimeType, imageId);
        photoWrites.set(imageId, Promise.resolve(true));
      }
    }));
    return result;
  });
  await Promise.all(pending);
  return hydrated;
}
async function hydrateCache(value: Cache, entry?: Entry): Promise<Cache> {
  const hydrate = async (): Promise<Cache> => {
    const [payload, recordPayload, queue] = await Promise.all([
      hydratePayload(value.payload), hydratePayload(value.record?.payload ?? null),
      Promise.all(value.queue.map(async mutation => ({ ...mutation, payload: await hydratePayload(mutation.payload) }))),
    ]);
    return { ...value, payload, record: value.record && { ...value.record, payload: recordPayload }, queue, needsImages: false };
  };
  try { return await hydrate(); }
  catch (error) {
    if (!entry || offline() || !value.record || value.record.revision <= 0) throw error;
    // Acknowledged checkpoints are immutable. Repair only their proven local
    // references; never install the server head over a queued newer payload.
    const response = await fetch(endpoint(value.key, `&revision=${value.record.revision}`), { cache: "no-store" });
    if (!response.ok) throw new Error(`Cannot recover saved draft photos (${response.status})`);
    const checkpoint = await responseRecord(response, entry, false);
    if (checkpoint.key !== value.key || checkpoint.revision !== value.record.revision) throw new Error("Saved draft photo checkpoint does not match the cached revision");
    const metadata = (source: Record<string, unknown>) => {
      const fields = { ...source };
      delete fields[LOCAL_IMAGE]; delete fields.draftImageId; delete fields.data;
      return fields;
    };
    const recovered = new Map<string, string>();
    mapImages(value.record.payload, (image, index, request) => {
      const imageId = image[LOCAL_IMAGE];
      const source = request
        ? (checkpoint.payload?.request as { body?: { images?: unknown[] } } | undefined)?.body?.images
        : checkpoint.payload?.images;
      const saved = (Array.isArray(source) ? source[index] : undefined) as Record<string, unknown> | undefined;
      if (typeof imageId !== "string" || typeof saved?.data !== "string" || image.mimeType !== saved.mimeType) return image;
      if (!sameDraftPayload(metadata(image), metadata(saved))) return image;
      const previous = recovered.get(imageId);
      if (previous !== undefined && previous !== saved.data) throw new Error("Saved draft photo slots disagree");
      recovered.set(imageId, saved.data);
      return image;
    });
    for (const [imageId, data] of recovered) {
      if (localPhotoData.has(imageId)) continue;
      localPhotoData.set(imageId, data);
      photoReads.delete(imageId);
      photoWrites.set(imageId, writePhoto(imageId, data).catch(() => false));
    }
    return hydrate();
  }
}
function synchronousCache(value: Cache): boolean {
  let saved = false, journalSaved = false;
  try {
    localStorage.setItem(PREFIX + value.key, JSON.stringify(value));
    saved = true;
  } catch { /* The independent journal and IndexedDB are separate durable copies. */ }
  try {
    const key = JOURNAL_PREFIX + journalId(value.key);
    if (value.queue.length) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
    journalSaved = true;
  } catch { /* IndexedDB below retains this writer's queue independently. */ }
  return value.queue.length ? journalSaved : saved;
}
type ImageOwners = { key: string; imageIds: string[] };
function imageReferences(value: Cache | null | undefined, references = new Set<string>()): Set<string> {
  if (!value) return references;
  const inspect = (payload: DraftPayload | null) => mapImages(payload, image => {
    if (typeof image[LOCAL_IMAGE] === "string") references.add(image[LOCAL_IMAGE]);
    return image;
  });
  inspect(value.payload); inspect(value.record?.payload ?? null);
  for (const mutation of value.queue ?? []) inspect(mutation.payload);
  return references;
}
async function writeDatabase(value: Cache): Promise<boolean> {
  const db = await openDatabase();
  if (!db) return false;
  const required = imageReferences(value);
  for (const imageId of required) {
    const written = await photoWrites.get(imageId);
    if (written === false) throw new Error("Local photo storage is unavailable");
  }
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE, JOURNAL_STORE, IMAGE_STORE, IMAGE_OWNER_STORE], "readwrite");
    transaction.objectStore(STORE).put(value, value.key);
    const journals = transaction.objectStore(JOURNAL_STORE);
    if (value.queue.length) journals.put(value, journalId(value.key));
    else journals.delete(journalId(value.key));
    const images = transaction.objectStore(IMAGE_STORE);
    for (const imageId of required) {
      const request = images.getKey(imageId);
      request.onsuccess = () => {
        if (typeof request.result === "string") return;
        const data = localPhotoData.get(imageId);
        if (typeof data === "string") images.put(data, imageId);
        else {
          reject(new Error("Locally saved photo bytes are missing"));
          transaction.abort();
        }
      };
    }
    const owners = transaction.objectStore(IMAGE_OWNER_STORE);
    const ownership = owners.get(value.key);
    ownership.onsuccess = () => {
      const current = ownership.result as ImageOwners | undefined;
      const known = current?.imageIds ?? [];
      if ([...required].some(imageId => !known.includes(imageId))) owners.put({ key: value.key, imageIds: [...new Set([...known, ...required])] } satisfies ImageOwners, value.key);
    };
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error ?? new Error("Cannot save the draft queue on this device"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Local draft save was interrupted"));
  });
}
function notify(entry: Entry, changed = false): void {
  if (changed) for (const listener of entry.changes) listener();
  for (const listener of entry.listeners) listener();
}
function status(entry: Entry, value: DraftSyncState["status"], error?: string): void {
  const state: DraftSyncState = { status: value };
  if (error) state.error = error;
  if (entry.uploading && value === "saving") state.uploading = true;
  if (entry.state.status === state.status && entry.state.error === state.error && entry.state.uploading === state.uploading) return;
  entry.state = state;
  notify(entry);
}
function failure(entry: Entry, error: unknown): void {
  status(entry, offline() || error instanceof TypeError ? "offline" : "error", error instanceof Error ? error.message : "Draft sync failed");
}
function persist(entry: Entry): void {
  entry.pendingCache = cache(entry);
  const textSaved = synchronousCache(entry.pendingCache);
  if (entry.persistenceRunning) return;
  entry.persistenceRunning = true;
  entry.persistence = (async () => {
    while (entry.pendingCache) {
      const snapshot = entry.pendingCache;
      entry.pendingCache = undefined;
      try {
        const fullSaved = await writeDatabase(snapshot);
        if (!fullSaved && (snapshot.needsImages || !textSaved)) throw new Error(snapshot.needsImages
          ? "Photos are only in memory until server upload; local photo storage is unavailable"
          : "Draft is only in memory until server upload; local storage is unavailable");
        if (!entry.needsImages) entry.cacheError = undefined;
      } catch (error) {
        entry.cacheError = error instanceof Error ? error.message : "Cannot save the draft on this device";
        if (entry.queue.length) status(entry, offline() ? "offline" : "error", entry.cacheError);
      }
    }
    entry.persistenceRunning = false;
  })();
}
function install(entry: Entry, value: Cache): void {
  entry.record = value.record;
  entry.payload = value.payload;
  const foreign = Boolean(value.writerId && value.writerId !== writerId && value.queue.length);
  entry.queue = foreign ? [] : value.queue;
  entry.foreignPending = Boolean(value.foreignPending || foreign);
  entry.conflict = value.conflict;
  entry.stamp = value.stamp;
  entry.needsImages = value.needsImages;
  entry.known = true;
}
async function load(entry: Entry): Promise<void> {
  try {
    const stored = await databaseRead<Cache>(STORE, entry.key);
    if (stored && !entry.known) install(entry, stored);
    if (entry.needsImages && stored && !stored.writerId) {
      entry.payload = withImages(entry.payload, stored.payload);
      entry.queue = entry.queue.map(mutation => ({ ...mutation, payload: withImages(mutation.payload, stored.queue.find(old => old.mutationId === mutation.mutationId)?.payload ?? stored.payload) }));
      if (entry.record && stored.record?.revision === entry.record.revision) entry.record = stored.record;
    }
    // Keep the latest text and queue while asynchronous photo reads finish.
    // Photo references remain in the internal payload until every byte arrives.
    while (entry.needsImages) {
      const generation = entry.generation;
      const full = await hydrateCache(cache(entry), entry);
      if (Number(full.payload?.missingImageCount) > 0) throw new Error("Locally saved photo bytes are missing");
      if (generation !== entry.generation) continue;
      entry.record = full.record;
      entry.payload = full.payload;
      entry.queue = full.queue;
      entry.needsImages = false;
      entry.cacheError = undefined;
      notify(entry, true);
    }
    if (stored && !entry.generation) notify(entry, true);
  } catch (error) {
    entry.cacheError = error instanceof Error ? error.message : "Cannot load locally saved photos";
    if (entry.needsImages) status(entry, "error", entry.cacheError);
  }
}
function getEntry(key: string): Entry {
  let entry = entries.get(key);
  if (entry) return entry;
  const stored = readCache(key);
  entry = {
    key, record: null, payload: null, queue: [], conflict: false, stamp: id(), known: false,
    state: { status: offline() ? "offline" : "loading" }, listeners: new Set(), changes: new Set(),
    imageIds: new Map(),
    foreignPending: false,
    ready: Promise.resolve(), persistence: Promise.resolve(), generation: 0,
  };
  if (stored) install(entry, stored);
  entries.set(key, entry);
  entry.ready = load(entry);
  return entry;
}
function watch(): void {
  if (!browser() || watching) return;
  watching = true;
  const wake = () => {
    for (const entry of entries.values()) {
      if (entry.listeners.size || entry.changes.size || entry.queue.length || entry.foreignPending) void synchronize(entry);
    }
  };
  const target = window;
  const wentOffline = () => {
    for (const entry of entries.values()) if (entry.queue.length || entry.listeners.size || entry.changes.size) status(entry, "offline");
  };
  const storageChanged = (event: Event) => {
    const key = (event as StorageEvent).key;
    if (key?.startsWith(PREFIX)) {
      const entry = entries.get(key.slice(PREFIX.length));
      if (entry) void synchronize(entry);
    } else if (key?.startsWith(JOURNAL_PREFIX)) {
      try {
        const value = JSON.parse((event as StorageEvent).newValue ?? "null") as Cache | null;
        const entry = value && entries.get(value.key);
        if (entry && value.writerId !== writerId) void synchronize(entry);
      } catch { /* Invalid external cache data is not installed. */ }
    }
  };
  target.addEventListener("online", wake);
  target.addEventListener("focus", wake);
  target.addEventListener("offline", wentOffline);
  target.addEventListener("storage", storageChanged);
  stopWatching = () => {
    target.removeEventListener("online", wake);
    target.removeEventListener("focus", wake);
    target.removeEventListener("offline", wentOffline);
    target.removeEventListener("storage", storageChanged);
    watching = false;
    stopWatching = undefined;
  };
}
function discover(): void {
  if (!browser() || discovered) return;
  discovered = true;
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    for (const key of keys) {
      if (key?.startsWith(JOURNAL_PREFIX)) {
        const value = JSON.parse(localStorage.getItem(key) ?? "null") as Cache | null;
        if (value?.queue?.length) void synchronize(getEntry(value.key));
        continue;
      }
      if (!key?.startsWith(PREFIX)) continue;
      const entry = getEntry(key.slice(PREFIX.length));
      void entry.ready.then(() => { if (entry.queue.length || entry.foreignPending) void synchronize(entry); });
    }
  } catch { /* The current draft can still sync when storage is denied. */ }
  void databaseRows(JOURNAL_STORE).then(rows => {
    const keys = new Set(rows.filter(value => value?.queue?.length).map(value => value.key));
    for (const key of keys) void synchronize(getEntry(key));
  }).catch(() => { /* Active drafts surface local persistence failures. */ });
}
function endpoint(key: string, suffix = ""): string { return `/api/drafts?key=${encodeURIComponent(key)}${suffix}`; }

async function journalRows(key: string): Promise<Cache[]> {
  const rows = new Map<string, Cache>();
  try {
    for (const value of await databaseRows(JOURNAL_STORE)) {
      if (value?.key === key && typeof value.writerId === "string" && Array.isArray(value.queue)) rows.set(journalId(key, value.writerId), value);
    }
  } catch { /* Text journals remain durable in localStorage if IndexedDB is denied. */ }
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    for (const storageKey of keys) {
      if (!storageKey?.startsWith(JOURNAL_PREFIX)) continue;
      const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Cache | null;
      if (value?.key === key && typeof value.writerId === "string" && Array.isArray(value.queue)) rows.set(journalId(key, value.writerId), value);
    }
  } catch { /* IndexedDB journals remain usable when localStorage is denied. */ }
  return [...rows.values()];
}
export type DraftJournalSnapshot = { id: string; stamp: string }[];
export async function snapshotLocalDraftJournals(key: string): Promise<DraftJournalSnapshot> {
  return (await journalRows(key)).map(value => ({ id: journalId(key, value.writerId), stamp: value.stamp }));
}
export async function forgetLocalDraftJournals(key: string, snapshot?: DraftJournalSnapshot): Promise<void> {
  const observed = snapshot ?? await snapshotLocalDraftJournals(key);
  const db = await openDatabase().catch(() => null);
  if (db && observed.length) await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(JOURNAL_STORE, "readwrite");
    const store = transaction.objectStore(JOURNAL_STORE);
    for (const version of observed) {
      const request = store.get(version.id);
      request.onsuccess = () => {
        const current = request.result as Cache | undefined;
        if (current?.key === key && current.stamp === version.stamp) store.delete(version.id);
      };
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Cannot remove local draft journals"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Local draft cleanup was interrupted"));
  });
  for (const version of observed) {
    const storageKey = JOURNAL_PREFIX + version.id;
    try {
      const current = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Cache | null;
      if (current?.key === key && current.stamp === version.stamp) localStorage.removeItem(storageKey);
    } catch { /* Never remove a journal whose exact current stamp cannot be read. */ }
  }
}
async function snapshotLocalDraftPhotos(entry: Entry): Promise<Set<string>> {
  const owners = await databaseRead<ImageOwners>(IMAGE_OWNER_STORE, entry.key).catch(() => null);
  const references = new Set(owners?.imageIds ?? []);
  imageReferences(cache(entry), references);
  imageReferences(readCache(entry.key), references);
  imageReferences(await databaseRead<Cache>(STORE, entry.key).catch(() => null), references);
  for (const value of await journalRows(entry.key)) imageReferences(value, references);
  return references;
}
async function forgetLocalDraftPhotos(key: string, candidates: Set<string>): Promise<void> {
  if (!candidates.size) return;
  const db = await openDatabase();
  if (!db) throw new Error("Local photo storage is unavailable for cleanup");
  const live = [...entries.values()].map(entry => cache(entry));
  const removed: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([STORE, JOURNAL_STORE, IMAGE_STORE, IMAGE_OWNER_STORE], "readwrite");
    const requests = [STORE, JOURNAL_STORE, IMAGE_OWNER_STORE].map(store => transaction.objectStore(store).getAll());
    let remaining = requests.length;
    const removeUnreferenced = () => {
      if (--remaining) return;
      try {
        const retained = new Set<string>(), retainedHere = new Set<string>();
        const rows = [...requests[0].result, ...requests[1].result, ...live] as Cache[];
        const storageKeys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
        for (const storageKey of storageKeys) {
          if (storageKey?.startsWith(PREFIX) || storageKey?.startsWith(JOURNAL_PREFIX)) {
            const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Cache | null;
            if (value) rows.push(value);
          }
        }
        for (const value of rows) {
          imageReferences(value, retained);
          if (value.key === key) imageReferences(value, retainedHere);
        }
        const owners = transaction.objectStore(IMAGE_OWNER_STORE);
        for (const ownership of requests[2].result as ImageOwners[]) {
          if (ownership.key !== key) for (const imageId of ownership.imageIds) retained.add(imageId);
          else {
            const preserved = ownership.imageIds.filter(imageId => !candidates.has(imageId) || retainedHere.has(imageId));
            if (preserved.length) owners.put({ key, imageIds: preserved } satisfies ImageOwners, key);
            else owners.delete(key);
          }
        }
        const images = transaction.objectStore(IMAGE_STORE);
        for (const imageId of candidates) if (!retained.has(imageId)) {
          images.delete(imageId);
          removed.push(imageId);
        }
      } catch (error) {
        reject(error);
        transaction.abort();
      }
    };
    for (const request of requests) request.onsuccess = removeUnreferenced;
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Cannot remove locally saved photos"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Local photo cleanup was interrupted"));
  });
  const deleted = new Set(removed);
  for (const imageId of deleted) {
    localPhotoData.delete(imageId);
    photoWrites.delete(imageId);
    photoReads.delete(imageId);
  }
  for (const [data, mimeIds] of localPhotoIds) {
    for (const [mime, imageId] of mimeIds) if (deleted.has(imageId)) mimeIds.delete(mime);
    if (!mimeIds.size) localPhotoIds.delete(data);
  }
}
async function recoverForeignJournals(entry: Entry): Promise<void> {
  if (entry.recovering) return entry.recovering;
  entry.recovering = (async () => {
    const rows = (await journalRows(entry.key)).filter(value => value.writerId !== writerId && value.queue.length);
    if (!rows.length) { entry.foreignPending = false; return; }
    entry.foreignPending = true;
    let conflict = false;
    for (const snapshot of rows) {
      const full = await hydrateCache(snapshot, entry);
      let revision: number | undefined;
      let rejected = false;
      for (const mutation of full.queue) {
        if (offline()) return;
        const baseRevision = rejected ? (entry.record?.revision === 0 ? 1 : 0) : revision ?? mutation.baseRevision;
        const response = await sendMutation(entry, baseRevision, mutation.mutationId, mutation.payload);
        if (!response.ok && response.status !== 409) throw new Error(`Cannot recover another tab's draft (${response.status})`);
        const record = await responseRecord(response, entry, true, response.ok ? mutation.payload : undefined);
        if (!entry.record || record.revision >= entry.record.revision) entry.record = record;
        if (response.status === 409) { rejected = true; conflict = true; }
        else revision = record.revision;
      }
      await forgetLocalDraftJournals(entry.key, [{ id: journalId(entry.key, snapshot.writerId), stamp: snapshot.stamp }]);
    }
    entry.foreignPending = false;
    entry.conflict ||= conflict;
    entry.stamp = id();
    persist(entry);
    if (entry.conflict) status(entry, "conflict");
  })().finally(() => { entry.recovering = undefined; });
  return entry.recovering;
}
function imageTransport(entry: Entry, payload: DraftPayload | null, references: boolean, rawPhoto?: () => void, referencePhoto?: () => void): DraftPayload | null {
  if (!payload) return null;
  const convert = (image: unknown, requestImage = false): unknown => {
    if (!image || typeof image !== "object") return image;
    const fields = { ...image } as Record<string, unknown>;
    const data = fields.data, mime = fields.mimeType, imageId = fields.draftImageId;
    delete fields.draftImageId;
    if (!references && typeof imageId === "string" && (typeof data !== "string" || typeof mime !== "string")) {
      throw new Error("Draft photo bytes are missing from the server response");
    }
    if (typeof data !== "string" || typeof mime !== "string") return fields;
    if (!references && typeof imageId === "string") {
      let ids = entry.imageIds.get(data);
      if (!ids) entry.imageIds.set(data, ids = new Map());
      ids.set(mime, imageId);
    }
    if (references) {
      const known = entry.imageIds.get(data)?.get(mime);
      if (known) { delete fields.data; fields.draftImageId = known; referencePhoto?.(); }
      else if (requestImage && Array.isArray(payload.images)) {
        const index = payload.images.findIndex(candidate => candidate && typeof candidate === "object"
          && (candidate as Record<string, unknown>).data === data
          && (candidate as Record<string, unknown>).mimeType === mime);
        if (index >= 0) { delete fields.data; fields.draftImageIndex = index; }
      }
    }
    if (references && typeof fields.data === "string") rawPhoto?.();
    return fields;
  };
  const result = { ...payload };
  if (Array.isArray(payload.images)) result.images = payload.images.map(image => convert(image));
  const request = payload.request as { body?: Record<string, unknown> } | null | undefined;
  if (request?.body && Array.isArray(request.body.images)) {
    result.request = { ...request, body: { ...request.body, images: request.body.images.map(image => convert(image, true)) } };
  }
  return result;
}

async function sendMutation(entry: Entry, baseRevision: number, mutationId: string, payload: DraftPayload | null, recoverReferences = true): Promise<Response> {
  let uploading = false, usedReferences = false;
  const transport = imageTransport(entry, payload, true, () => { uploading = true; }, () => { usedReferences = true; });
  entry.uploading = uploading;
  status(entry, "saving", entry.cacheError);
  let response: Response;
  try {
    response = await fetch("/api/drafts", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: entry.key, baseRevision, mutationId, payload: transport }),
    });
  } finally {
    entry.uploading = false;
    status(entry, entry.state.status, entry.state.error);
  }
  if (recoverReferences && usedReferences && response.status === 400) {
    const body = await response.clone().json().catch(() => null) as { error?: string } | null;
    if (body?.error === "Referenced image is not available in this draft") {
      const current = await fetch(endpoint(entry.key), { cache: "no-store" });
      if (!current.ok) throw new Error(`Cannot check draft after unavailable photo reference (${current.status})`);
      const head = await responseRecord(current, entry, false);
      // Cleanup can remove acknowledged blobs, then another device can recreate
      // the draft. Retrying raw bytes is safe only against this same stale CAS:
      // it checkpoints the local photo as a conflict, never replaces the head.
      if (head.key === entry.key && head.revision > baseRevision) {
        entry.imageIds.clear();
        return sendMutation(entry, baseRevision, mutationId, payload, false);
      }
    }
  }
  return response;
}

async function responseRecord(response: Response, entry: Entry, current = true, pending?: DraftPayload | null): Promise<DraftRecord> {
  const body = await response.json() as { record?: DraftRecord; error?: string };
  if (!body.record || typeof body.record.revision !== "number") throw new Error(body.error ?? "Invalid draft response");
  const etag = response.headers.get("ETag");
  if (current && entry.record && body.record.revision < entry.record.revision) entry.imageIds.clear();
  let incoming = body.record.payload;
  if (pending !== undefined) {
    const requestImages = (value: DraftPayload | null) => (value?.request as { body?: { images?: unknown[] } } | undefined)?.body?.images ?? [];
    const rootImages = (value: DraftPayload | null) => value && Array.isArray(value.images) ? value.images : [];
    if (rootImages(incoming).length !== rootImages(pending).length || requestImages(incoming).length !== requestImages(pending).length) throw new Error("Saved draft photo receipt does not match the pending upload");
    incoming = mapImages(incoming, (image, index, request) => {
      if (typeof image.data === "string") return image;
      const original = (request ? requestImages(pending) : rootImages(pending))[index] as Record<string, unknown> | undefined;
      if (typeof image.draftImageId !== "string" || typeof image.mimeType !== "string"
        || original?.mimeType !== image.mimeType || typeof original.data !== "string") throw new Error("Saved draft photo receipt does not match the pending upload");
      const known = entry.imageIds.get(original.data)?.get(image.mimeType);
      if (known && known !== image.draftImageId) throw new Error("Saved draft photo identity does not match the pending upload");
      return { ...image, data: original.data };
    });
  }
  const payload = imageTransport(entry, incoming, false);
  if (current && etag) entry.etag = etag;
  return { ...body.record, payload };
}
async function refresh(entry: Entry): Promise<void> {
  if (entry.refresh) return entry.refresh;
  entry.refresh = (async () => {
    const previous = entry.record;
    const response = await fetch(endpoint(entry.key), {
      cache: "no-store", headers: entry.etag ? { "If-None-Match": entry.etag } : undefined,
    });
    if (response.status === 304) {
      if (!entry.queue.length && !entry.foreignPending && !entry.conflict) status(entry, "saved");
      return;
    }
    if (!response.ok) throw new Error(`Cannot load draft (${response.status})`);
    const record = await responseRecord(response, entry);
    // An earlier GET can finish after a PUT; never rewind that acknowledged save.
    if (entry.record !== previous && entry.record && record.revision < entry.record.revision) return;
    entry.etag = response.headers.get("ETag") ?? undefined;
    const unchanged = entry.record?.revision === record.revision && entry.known
      && !entry.needsImages && sameDraftPayload(entry.payload, record.payload);
    entry.record = record;
    if (!entry.queue.length && !entry.foreignPending && !entry.conflict) {
      const changed = !entry.known || !sameDraftPayload(entry.payload, record.payload);
      entry.payload = record.payload;
      entry.known = true;
      entry.needsImages = false;
      if (!unchanged) {
        entry.stamp = id();
        persist(entry);
        notify(entry, changed);
      }
      status(entry, "saved");
    }
  })().finally(() => { entry.refresh = undefined; });
  return entry.refresh;
}
async function flush(entry: Entry): Promise<void> {
  if (entry.sending) return entry.sending;
  entry.sending = (async () => {
    await entry.ready;
    if (entry.needsImages) throw new Error(entry.cacheError ?? "Waiting for locally saved photos");
    while (entry.queue.length && !entry.conflict) {
      if (offline()) { status(entry, "offline", entry.cacheError); return; }
      const mutation = entry.queue[0];
      mutation.sent = true;
      entry.stamp = id();
      persist(entry);
      await entry.persistence;
      const response = await sendMutation(entry, mutation.baseRevision, mutation.mutationId, mutation.payload);
      if (response.status === 409) {
        entry.record = await responseRecord(response, entry);
        entry.conflict = true;
        entry.stamp = id();
        persist(entry);
        status(entry, "conflict");
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `Cannot save draft (${response.status})`);
      }
      const record = await responseRecord(response, entry, true, mutation.payload);
      if (!entry.record || record.revision >= entry.record.revision) entry.record = record;
      // A request whose response was lost is retried with its original ID/body.
      if (entry.queue[0]?.mutationId === mutation.mutationId) entry.queue.shift();
      if (entry.queue.length) entry.queue[0].baseRevision = record.revision;
      else if (entry.record.revision > record.revision) {
        entry.payload = entry.record.payload;
        notify(entry, true);
      }
      entry.known = true;
      entry.stamp = id();
      persist(entry);
    }
    if (!entry.queue.length) status(entry, "saved");
  })().catch(error => { failure(entry, error); }).finally(() => { entry.sending = undefined; });
  return entry.sending;
}
async function synchronize(entry: Entry): Promise<void> {
  await entry.ready;
  if (entry.choosing) return;
  if (offline()) { status(entry, "offline", entry.cacheError); return; }
  try {
    if (entry.sending) await entry.sending;
    if (entry.needsImages) {
      entry.imageRecovery ??= load(entry).finally(() => { entry.imageRecovery = undefined; });
      await entry.imageRecovery;
      if (entry.needsImages) throw new Error(entry.cacheError ?? "Waiting for locally saved photos");
    }
    await recoverForeignJournals(entry);
    if (entry.queue.length && !entry.conflict) await flush(entry);
    else {
      await refresh(entry);
      if (entry.conflict) status(entry, "conflict");
    }
  } catch (error) { failure(entry, error); }
}
function schedule(entry: Entry): void {
  if (!browser()) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => { entry.timer = undefined; void synchronize(entry); }, DEBOUNCE_MS);
  if (typeof entry.timer === "object") entry.timer.unref();
}
function subscribe(key: string, listener: () => void, changes: boolean): () => void {
  const entry = getEntry(key);
  const set = changes ? entry.changes : entry.listeners;
  set.add(listener);
  if (changes && entry.known && !entry.needsImages) listener();
  if (browser()) {
    watch(); discover();
    if (!entry.poll) {
      entry.poll = setInterval(() => { void synchronize(entry); }, POLL_MS);
      if (typeof entry.poll === "object") entry.poll.unref();
    }
    void synchronize(entry);
  }
  return () => {
    set.delete(listener);
    if (!entry.listeners.size && !entry.changes.size && entry.poll) {
      clearInterval(entry.poll); entry.poll = undefined;
    }
    if (![...entries.values()].some(candidate => candidate.listeners.size || candidate.changes.size)) stopWatching?.();
  };
}

export function getDraftSyncState(key: string): DraftSyncState { return getEntry(key).state; }
export function subscribeDraftSync(key: string, listener: () => void): () => void { return subscribe(key, listener, false); }
/** Adapter-only change stream: local saves do not echo into a mounted composer. */
export function subscribeRemoteDraftChanges(key: string, listener: () => void): () => void { return subscribe(key, listener, true); }
export function hasPendingDraftImages(key: string): boolean {
  const entry = getEntry(key);
  const request = entry.payload?.request as { imageCount?: number } | undefined;
  return Boolean(entry.needsImages || Number(entry.payload?.missingImageCount) > 0 || Number(request?.imageCount) > 0);
}
export function readRemoteDraft(key: string): DraftRecord | null {
  const entry = getEntry(key);
  return entry.known ? { key, revision: entry.record?.revision ?? 0, updatedAt: entry.record?.updatedAt ?? "", payload: clone(entry.needsImages ? draftTextCache(entry.payload) : entry.payload) } : null;
}
export function saveRemoteDraft(key: string, payload: DraftPayload | null): void {
  const entry = getEntry(key);
  if ((!entry.known && payload === null) || (entry.known && sameDraftPayload(entry.payload, payload))) return;
  // A remount writes the synchronous text-only snapshot back before its photos
  // have loaded. That identical write is not an intentional photo deletion.
  if (entry.needsImages && sameDraftPayload(draftTextCache(entry.payload), draftTextCache(payload))) return;
  const value = clone(payload);
  if (value && entry.needsImages && entry.payload) {
    const hiddenCount = (images: unknown) => Array.isArray(images) ? images.filter(image => image && typeof image === "object" && typeof image[LOCAL_IMAGE] === "string").length : 0;
    // Only remove a marker synthesized by our text-only view when its original
    // images are represented by preserved references. An independent legacy
    // missing-photo count cannot be resolved by loading a newly added image.
    if (!Number(entry.payload.missingImageCount) && Number(value.missingImageCount) > 0 && hiddenCount(entry.payload.images) >= Number(value.missingImageCount)) delete value.missingImageCount;
    const retain = (incoming: unknown, previous: unknown) => {
      const hidden = Array.isArray(previous) ? previous.filter(image => image && typeof image === "object" && typeof image[LOCAL_IMAGE] === "string") : [];
      return hidden.length ? [...hidden, ...(Array.isArray(incoming) ? incoming : [])] : incoming;
    };
    value.images = retain(value.images, entry.payload.images);
    const previousRequest = entry.payload.request as { body?: Record<string, unknown>; imageCount?: number } | undefined;
    const request = value.request as { body?: Record<string, unknown>; imageCount?: number } | undefined;
    if (request?.body && previousRequest?.body) {
      if (!previousRequest.imageCount && request.imageCount && hiddenCount(previousRequest.body.images) >= request.imageCount) delete request.imageCount;
      request.body.images = retain(request.body.images, previousRequest.body.images);
    }
  }
  entry.payload = value;
  entry.known = true;
  entry.generation++;
  const last = entry.queue.at(-1);
  const mutation = { mutationId: id(), baseRevision: last?.baseRevision ?? entry.record?.revision ?? 0, payload: value };
  if (last && !last.sent && last.payload !== null && value !== null) entry.queue[entry.queue.length - 1] = mutation;
  else entry.queue.push(mutation);
  // Conflict edits remain durably local until the user chooses a version.
  // Preserve save/clear queue boundaries: an accepted send must not erase an
  // unacknowledged photo checkpoint, and typing must never rebase implicitly.
  entry.stamp = id();
  synchronousCache(cache(entry));
  void entry.ready.then(() => { persist(entry); schedule(entry); });
  status(entry, entry.conflict ? "conflict" : offline() ? "offline" : "saving");
  notify(entry);
}
export async function listRemoteDraftHistory(key: string): Promise<DraftVersion[]> {
  const response = await fetch(endpoint(key, "&history=1"), { cache: "no-store" });
  if (!response.ok) throw new Error(`Cannot load draft history (${response.status})`);
  const body = await response.json() as { versions: DraftVersion[] };
  return body.versions;
}
async function retainLocal(entry: Entry): Promise<void> {
  if (!entry.queue.length) return;
  if (entry.needsImages) throw new Error(entry.cacheError ?? "Locally saved photos are not available");
  // A deliberately stale CAS checkpoints every displaced queue boundary (a
  // save followed by accepted clear must not lose its checkpoint on restore).
  const pending = entry.queue.map(mutation => mutation.payload);
  for (const payload of pending) {
    if (sameDraftPayload(payload, entry.record?.payload ?? null)) continue;
    const response = await sendMutation(entry, entry.record?.revision === 0 ? 1 : 0, id(), payload);
    if (response.status !== 409) throw new Error(`Cannot retain displaced draft (${response.status})`);
    entry.record = await responseRecord(response, entry);
  }
}
async function prepareChoice(entry: Entry, generation: number): Promise<void> {
  if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
  await entry.ready;
  if (entry.sending) await entry.sending;
  await recoverForeignJournals(entry);
  await refresh(entry);
  if (entry.generation !== generation) throw new Error("Draft changed while choosing a version; try again");
  await retainLocal(entry);
  if (entry.generation !== generation) throw new Error("Draft changed while choosing a version; try again");
}
function installChoice(entry: Entry, payload: DraftPayload | null): void {
  entry.queue = [];
  entry.conflict = false;
  entry.foreignPending = false;
  entry.needsImages = false;
  entry.payload = clone(payload);
  entry.known = true;
  entry.generation++;
  entry.stamp = id();
  persist(entry);
  notify(entry, true);
}
async function saveChoice(entry: Entry, payload: DraftPayload | null): Promise<void> {
  installChoice(entry, payload);
  entry.queue.push({ mutationId: id(), baseRevision: entry.record?.revision ?? 0, payload: clone(payload) });
  persist(entry);
  status(entry, "saving");
  await flush(entry);
  if (entry.state.status !== "saved") throw new Error(entry.state.error ?? (entry.conflict ? "Another device changed the draft; choose a version again" : "Draft could not be saved"));
}
export async function restoreRemoteDraft(key: string, revision: number): Promise<void> {
  const entry = getEntry(key), generation = entry.generation;
  if (entry.choosing) throw new Error("A draft version change is already in progress");
  entry.choosing = true;
  try {
    const response = await fetch(endpoint(key, `&revision=${revision}`), { cache: "no-store" });
    if (!response.ok) throw new Error(`Cannot load draft version (${response.status})`);
    const restored = await responseRecord(response, entry, false);
    await prepareChoice(entry, generation);
    await saveChoice(entry, restored.payload);
  } catch (error) { if (!entry.conflict) failure(entry, error); throw error; }
  finally { entry.choosing = false; if (entry.queue.length) schedule(entry); }
}
export async function resolveRemoteDraftConflict(key: string, choice: "local" | "server"): Promise<void> {
  const entry = getEntry(key), generation = entry.generation;
  if (entry.choosing) throw new Error("A draft version change is already in progress");
  entry.choosing = true;
  try {
    await prepareChoice(entry, generation);
    if (choice === "local") await saveChoice(entry, entry.payload);
    else { installChoice(entry, entry.record?.payload ?? null); status(entry, "saved"); }
  } catch (error) { if (!entry.conflict) failure(entry, error); throw error; }
  finally { entry.choosing = false; if (entry.queue.length) schedule(entry); }
}
export function discardRemoteDraftConflict(key: string): void {
  void resolveRemoteDraftConflict(key, "server").catch(() => { /* Error is published through the sync state. */ });
}
export async function deleteRemoteDraft(key: string): Promise<void> {
  const entry = getEntry(key), generation = entry.generation;
  if (entry.choosing) throw new Error("A draft version change is already in progress");
  entry.choosing = true;
  try {
    await entry.ready;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    if (entry.sending) await entry.sending;
    await refresh(entry);
    if (entry.generation !== generation) throw new Error("Draft changed before cleanup; try again");
    const journals = await snapshotLocalDraftJournals(key);
    const photos = await snapshotLocalDraftPhotos(entry);
    const response = await fetch(endpoint(key, `&baseRevision=${entry.record?.revision ?? 0}`), { method: "DELETE" });
    if (!response.ok) throw new Error(response.status === 409 ? "Another device changed the draft; cleanup was not applied" : `Cannot delete draft data (${response.status})`);
    const tombstone = await responseRecord(response, entry);
    entry.record = tombstone;
    entry.imageIds.clear();
    entry.etag = undefined;
    if (entry.generation === generation) await forgetLocalDraftJournals(key, journals);
    if (entry.generation !== generation) {
      // Server deletion was authorized for the captured revision, not newer local
      // typing. Preserve that queue against the monotonic deletion tombstone.
      if (entry.queue.length) entry.queue[0].baseRevision = tombstone.revision;
      persist(entry);
      await entry.persistence;
      await forgetLocalDraftPhotos(key, photos);
      schedule(entry); return;
    }
    installChoice(entry, null);
    await entry.persistence;
    if (entry.cacheError) throw new Error(`Server draft data was deleted, but local cleanup failed: ${entry.cacheError}`);
    await forgetLocalDraftPhotos(key, photos);
    if (!entry.queue.length) status(entry, "saved");
  } catch (error) { failure(entry, error); throw error; }
  finally { entry.choosing = false; if (entry.queue.length) schedule(entry); }
}
