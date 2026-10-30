import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "./omp/paths";
import { isBase64ImageWithinLimits, MAX_ATTACHED_IMAGE_BYTES, MAX_ATTACHED_IMAGES, MAX_TOTAL_ATTACHED_IMAGE_BYTES } from "./image-attachments";
import type { DraftPayload, DraftRecord, DraftVersion, SaveDurableDraftInput } from "./durable-draft-types";
import { isRecord } from "./type-guards";

export class DraftStorageError extends Error {
  constructor(message: string, public readonly status = 500) { super(message); }
}

export class DraftConflictError extends DraftStorageError {
  constructor(public readonly record: DraftRecord) {
    super("This draft changed on another device. Reload its saved copy and history before retrying.", 409);
  }
}

interface Checkpoint {
  key: string;
  revision: number;
  updatedAt: string;
  reason: DraftVersion["reason"];
  payload: DraftPayload | null;
  mutationId: string;
  baseRevision: number;
  fingerprint: string;
  etag: string;
  checksum: string;
}
interface Store {
  version: 2;
  key: string;
  revision: number;
  nextRevision: number;
  firstRevision: number;
  updatedAt: string;
  activeChecksum: string | null;
  activeEtag: string;
  checksum: string;
}
interface MutationReceipt {
  version: 1;
  key: string;
  mutationId: string;
  revision: number;
  checkpointChecksum: string;
  checksum: string;
}
interface PendingCommit {
  version: 1;
  key: string;
  before: Store;
  after: Store;
  entry: Checkpoint;
}
interface PendingCleanup {
  version: 1;
  key: string;
  before: Store;
  after: Store;
}
interface ImageReference { hash: string; bytes: number }
interface IncomingImageOptions {
  topLevelImages?: DraftPayload[];
  resolveIndex?: (index: number, mimeType: string) => ImageReference;
}
const IMAGE_REFERENCE = "$durableDraftImage";
const EPOCH = "1970-01-01T00:00:00.000Z";
const HASH = /^[a-f0-9]{64}$/;
const MAX_DEPTH = 128;

function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException).code; }
function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function invalid(message: string): never { throw new DraftStorageError(message, 400); }
function corrupt(message: string): never { throw new DraftStorageError(`Draft storage is damaged: ${message}. Retained files have not been discarded.`, 500); }
function validateKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !key || key.length > 2048) invalid("Draft key must contain 1 to 2048 characters");
}
function validateRevision(revision: unknown): asserts revision is number {
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) invalid("Draft revision must be a nonnegative safe integer");
}
function validateMutationId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !id || id.length > 256) invalid("A mutationId of 1 to 256 characters is required");
}
function location(key: string) {
  const web = join(getAgentDir(), "omp-web");
  const root = join(web, "drafts");
  return { web, root, folder: join(root, digest(key)) };
}
function assertDirectory(path: string): boolean {
  try {
    if (!lstatSync(path).isDirectory()) corrupt("a draft directory was replaced by a non-directory or symlink");
    return true;
  } catch (error) { if (code(error) === "ENOENT") return false; throw error; }
}
function ensureDirectory(path: string) {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if (code(error) !== "EEXIST") throw error; }
  assertDirectory(path);
}
function checkDirectories(key: string): boolean {
  const { web, root, folder } = location(key);
  return assertDirectory(web) && assertDirectory(root) && assertDirectory(folder);
}
function readPrivateFile(path: string): Buffer {
  const info = lstatSync(path);
  if (!info.isFile()) corrupt("a draft file was replaced by a non-file or symlink");
  return readFileSync(path);
}
function syncDirectory(path: string) {
  // Windows does not support opening directories for fsync.
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeAtomic(folder: string, name: string, value: string | Buffer) {
  const temporary = join(folder, `.tmp-${process.pid}-${randomUUID()}`);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, join(folder, name));
    syncDirectory(folder);
  } finally { rmSync(temporary, { force: true }); }
}

/** The populated UUID-marker lock mirrors session-execution's cross-process lock.
 * Live owners never expire, and stale contenders unlink only the marker observed. */
async function withDraftLock<T>(key: string, run: () => T): Promise<T> {
  const { web, root, folder } = location(key);
  mkdirSync(getAgentDir(), { recursive: true, mode: 0o700 });
  ensureDirectory(web);
  ensureDirectory(root);
  const lock = `${folder}.lock`;
  const owner = `owner-${randomUUID()}`;
  const candidate = `${lock}.candidate-${owner}`;
  let acquired = false;
  const deadline = Date.now() + 5000;
  const busy = () => new DraftStorageError("Draft storage is busy; retry saving your retained local edit", 503);
  try {
    mkdirSync(candidate, { mode: 0o700 });
    writeFileSync(join(candidate, owner), String(process.pid), { flag: "wx", mode: 0o600 });
    while (!acquired) {
      let entries: string[] | undefined;
      try { if (!assertDirectory(lock)) entries = undefined; else entries = readdirSync(lock); }
      catch (error) { if (code(error) !== "ENOENT") throw error; }
      // Owners publish populated directories atomically. An empty directory
      // can only remain after interrupted release or dead-owner cleanup.
      if (entries?.length === 0) {
        try { rmdirSync(lock); }
        catch (error) { if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes(code(error) ?? "")) throw error; }
        entries = undefined;
      }
      if (entries) {
        const observed = entries[0];
        if (entries.length !== 1 || !/^owner-[a-f0-9-]{36}$/.test(observed)) {
          throw new DraftStorageError("Draft lock has no verifiable owner; inspect it before retrying", 503);
        }
        let encoded: string | undefined;
        try { encoded = readPrivateFile(join(lock, observed)).toString("utf8").trim(); }
        catch (error) { if (code(error) !== "ENOENT") throw error; }
        if (encoded !== undefined) {
          const pid = /^[1-9]\d*$/.test(encoded) ? Number(encoded) : NaN;
          if (!Number.isSafeInteger(pid) || pid > 2_147_483_647) throw new DraftStorageError("Draft lock owner is invalid; inspect it before retrying", 503);
          let alive = true;
          try { process.kill(pid, 0); }
          catch (error) { if (code(error) === "ESRCH") alive = false; else if (code(error) !== "EPERM") throw error; }
          if (!alive) {
            try {
              unlinkSync(join(lock, observed));
              try { rmdirSync(lock); }
              catch (error) { if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes(code(error) ?? "")) throw error; }
            } catch (error) { if (code(error) !== "ENOENT") throw error; }
          }
        }
      }
      try { renameSync(candidate, lock); acquired = true; }
      catch (error) { if (!["EEXIST", "ENOTEMPTY", "ENOENT"].includes(code(error) ?? "")) throw error; }
      if (!acquired) {
        if (Date.now() >= deadline) throw busy();
        await delay(20);
      }
    }
    return run();
  } finally {
    rmSync(candidate, { recursive: true, force: true });
    if (acquired) {
      let removed = false;
      try { unlinkSync(join(lock, owner)); removed = true; }
      catch (error) { if (code(error) !== "ENOENT") throw error; }
      if (removed) {
        try { rmdirSync(lock); }
        catch (error) { if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes(code(error) ?? "")) throw error; }
      }
    }
  }
}

/** Traverse every images collection, including schedule request.body.images.
 * All other JSON (in particular workspace file paths) remains data, never IO. */
function transformPayload(payload: unknown, stored: boolean, image: (fields: DraftPayload, reference: ImageReference, bytes?: Buffer) => DraftPayload, resolveReference?: (hash: string) => Buffer, incoming?: IncomingImageOptions): DraftPayload | null {
  const fail = (message: string): never => stored ? corrupt(message) : invalid(message);
  if (payload === null) return null;
  if (!isRecord(payload)) return fail("Draft payload must be an object or null");
  function walk(value: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH) return fail("Draft payload is nested too deeply");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(item => walk(item, depth + 1));
    if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail("Draft payload must contain only JSON values");
    if (Object.hasOwn(value, IMAGE_REFERENCE)) return fail("Reserved draft image reference outside an image attachment");
    return Object.fromEntries(Object.entries(value).map(([name, child]) => {
      if (name !== "images") return [name, walk(child, depth + 1)];
      if (!Array.isArray(child) || child.length > MAX_ATTACHED_IMAGES) return fail(`Each images collection must be an array of at most ${MAX_ATTACHED_IMAGES} images`);
      if (!stored && depth === 0 && incoming?.topLevelImages) return [name, incoming.topLevelImages];
      let total = 0;
      const images = child.map(item => {
        if (!isRecord(item) || typeof item.mimeType !== "string" || !item.mimeType.startsWith("image/")) return fail("Each attachment must contain valid image data and an image MIME type");
        let reference: ImageReference;
        let bytes: Buffer | undefined;
        if (stored) {
          const ref = item[IMAGE_REFERENCE];
          if (Object.hasOwn(item, "data") || Object.hasOwn(item, "draftImageId") || Object.hasOwn(item, "draftImageIndex") || !isRecord(ref) || typeof ref.hash !== "string" || !HASH.test(ref.hash)
            || !Number.isSafeInteger(ref.bytes) || (ref.bytes as number) <= 0 || (ref.bytes as number) > MAX_ATTACHED_IMAGE_BYTES) return fail("Invalid stored image reference");
          reference = { hash: ref.hash, bytes: ref.bytes as number };
        } else {
          if (Object.hasOwn(item, IMAGE_REFERENCE)) return fail("Reserved draft image reference supplied by client");
          if (Object.hasOwn(item, "draftImageIndex")) {
            if (Object.hasOwn(item, "data") || Object.hasOwn(item, "draftImageId") || !Number.isSafeInteger(item.draftImageIndex)
              || (item.draftImageIndex as number) < 0 || !incoming?.resolveIndex) return fail("draftImageIndex must reference a validated top-level image");
            reference = incoming.resolveIndex(item.draftImageIndex as number, item.mimeType);
          } else if (Object.hasOwn(item, "data")) {
            if (!isBase64ImageWithinLimits(item)) return fail("Each image must be valid base64 image data of 10MB or smaller");
            bytes = Buffer.from(item.data, "base64");
            if (bytes.toString("base64") !== item.data) return fail("Image data must use canonical base64 encoding");
            reference = { hash: digest(bytes), bytes: bytes.length };
            if (item.draftImageId !== undefined && item.draftImageId !== reference.hash) return fail("draftImageId does not match the supplied image data");
          } else {
            if (typeof item.draftImageId !== "string" || !HASH.test(item.draftImageId) || !resolveReference) return fail("Each image must contain image data or a same-draft draftImageId");
            const resolved = resolveReference(item.draftImageId);
            reference = { hash: item.draftImageId, bytes: resolved.length };
          }
        }
        total += reference.bytes;
        if (total > MAX_TOTAL_ATTACHED_IMAGE_BYTES) return fail("Attached images must total 100MB or less");
        const fields = Object.fromEntries(Object.entries(item).filter(([field]) => field !== "data" && field !== "draftImageId" && field !== "draftImageIndex" && field !== IMAGE_REFERENCE).map(([field, content]) => [field, walk(content, depth + 2)]));
        return image(fields, reference, bytes);
      });
      return [name, images];
    }));
  }
  return walk(payload, 0) as DraftPayload;
}
function extractPayload(payload: unknown, key: string) {
  const blobs = new Map<string, Buffer>();
  const resolved = new Map<string, Buffer>();
  const attach = (fields: DraftPayload, ref: ImageReference, bytes?: Buffer) => {
    if (bytes && !blobs.has(ref.hash)) blobs.set(ref.hash, bytes);
    return { ...fields, [IMAGE_REFERENCE]: ref };
  };
  const resolveReference = (hash: string): Buffer => {
    let bytes = resolved.get(hash);
    if (!bytes) {
      if (!checkDirectories(key)) invalid("Referenced image is not available in this draft");
      bytes = readImage(location(key).folder, hash, true);
      resolved.set(hash, bytes);
    }
    return bytes;
  };
  // Validate top-level images first, regardless of JSON property order. Nested
  // schedule bodies can then point to those exact bytes without another upload.
  const topLevelImages = isRecord(payload) && Object.hasOwn(payload, "images")
    ? transformPayload({ images: payload.images }, false, attach, resolveReference)!.images as DraftPayload[]
    : undefined;
  const extracted = transformPayload(payload, false, attach, resolveReference, {
    topLevelImages,
    resolveIndex: (index, mimeType) => {
      const top = topLevelImages?.[index];
      if (!top || top.mimeType !== mimeType) invalid("draftImageIndex does not match a top-level image and MIME type");
      return top[IMAGE_REFERENCE] as ImageReference;
    },
  });
  return { payload: extracted, blobs };
}
function hydratePayload(payload: DraftPayload | null, folder: string): DraftPayload | null {
  const hydrated = new Map<string, { data: string; bytes: number }>();
  return transformPayload(payload, true, (fields, ref) => {
    let cached = hydrated.get(ref.hash);
    if (cached === undefined) {
      const bytes = readImage(folder, ref.hash);
      if (bytes.length !== ref.bytes) return corrupt("image content does not match its retained reference");
      cached = { data: bytes.toString("base64"), bytes: bytes.length };
      hydrated.set(ref.hash, cached);
    }
    if (cached.bytes !== ref.bytes) return corrupt("inconsistent image byte length");
    return { ...fields, data: cached.data, draftImageId: ref.hash };
  });
}
function referencePayload(payload: DraftPayload | null): DraftPayload | null {
  return transformPayload(payload, true, (fields, ref) => ({ ...fields, draftImageId: ref.hash }));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return corrupt("non-JSON checkpoint content");
  return encoded;
}
function fingerprint(baseRevision: number, payload: DraftPayload | null): string { return digest(canonical({ baseRevision, payload })); }
function readImage(folder: string, hash: string, incomingReference = false): Buffer {
  try {
    if (!assertDirectory(join(folder, "blobs"))) throw Object.assign(new Error("Missing draft image directory"), { code: "ENOENT" });
    const path = join(folder, "blobs", `${hash}.bin`);
    const info = lstatSync(path);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_ATTACHED_IMAGE_BYTES) return corrupt("invalid private image blob");
    const bytes = readFileSync(path);
    if (digest(bytes) !== hash) return corrupt("image content does not match its content address");
    return bytes;
  } catch (error) {
    if (code(error) === "ENOENT") {
      if (incomingReference) return invalid("Referenced image is not available in this draft");
      return corrupt("missing image bytes");
    }
    throw error;
  }
}

function withoutImageData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutImageData);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([name, child]) => [
    name,
    name === "images" && Array.isArray(child)
      ? child.map(image => isRecord(image) ? withoutImageData(Object.fromEntries(Object.entries(image).filter(([field]) => field !== "data"))) : image)
      : withoutImageData(child),
  ]));
}

/** PUT receipts and GET snapshots share an ETag without hashing base64 bytes. */
export function durableDraftRecordEtag(value: DraftRecord): string {
  return `"draft-${digest(canonical({ ...value, payload: withoutImageData(value.payload) }))}"`;
}
function storedEtag(key: string, revision: number, updatedAt: string, payload: DraftPayload | null): string {
  const references = referencePayload(payload);
  return durableDraftRecordEtag({ key, revision, updatedAt, payload: references });
}
function checksummed<T extends object>(value: T): T & { checksum: string } {
  return { ...value, checksum: digest(canonical(value)) };
}
function checksumMatches(value: Record<string, unknown>): boolean {
  const { checksum, ...body } = value;
  return typeof checksum === "string" && HASH.test(checksum) && digest(canonical(body)) === checksum;
}
function emptyStore(key: string): Store {
  return checksummed({ version: 2 as const, key, revision: 0, nextRevision: 1, firstRevision: 1, updatedAt: EPOCH, activeChecksum: null, activeEtag: storedEtag(key, 0, EPOCH, null) });
}
function initializeStore(before: Store) {
  const { root, folder } = location(before.key);
  if (assertDirectory(folder)) return;
  // Publish the directory and its initial head together. An interruption before
  // rename can leave only a private staging directory, never an unreadable key.
  const staging = join(root, `.${digest(before.key)}.initialize.${randomUUID()}`);
  ensureDirectory(staging);
  try {
    writeAtomic(staging, "metadata.json", `${JSON.stringify(before)}\n`);
    renameSync(staging, folder);
    syncDirectory(root);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
function readJson(path: string): unknown {
  try { return JSON.parse(readPrivateFile(path).toString("utf8")); }
  catch (error) {
    if (code(error) === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return corrupt("unreadable metadata or checkpoint");
    throw error;
  }
}
function parseStore(value: unknown, key: string): Store {
  if (!isRecord(value) || value.version !== 2 || value.key !== key
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || !Number.isSafeInteger(value.nextRevision) || (value.nextRevision as number) <= (value.revision as number)
    || !Number.isSafeInteger(value.firstRevision) || (value.firstRevision as number) < 1 || (value.firstRevision as number) > (value.nextRevision as number)
    || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
    || (value.activeChecksum === null ? value.revision !== (value.firstRevision as number) - 1
      : typeof value.activeChecksum !== "string" || !HASH.test(value.activeChecksum) || (value.revision as number) < (value.firstRevision as number))
    || typeof value.activeEtag !== "string" || !/^"draft-[a-f0-9]{64}"$/.test(value.activeEtag)
    || !checksumMatches(value)) return corrupt("invalid draft head");
  if (value.activeChecksum === null && value.activeEtag !== storedEtag(key, value.revision as number, value.updatedAt as string, null)) return corrupt("empty draft does not match its head");
  return value as unknown as Store;
}
function loadHead(key: string): Store {
  if (!checkDirectories(key)) return emptyStore(key);
  return parseStore(readJson(join(location(key).folder, "metadata.json")), key);
}
function parseCheckpoint(value: unknown, key: string): Checkpoint {
  if (!isRecord(value) || value.key !== key || !Number.isSafeInteger(value.revision) || (value.revision as number) <= 0
    || !Number.isSafeInteger(value.baseRevision) || (value.baseRevision as number) < 0
    || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
    || !["save", "clear", "conflict"].includes(value.reason as string)
    || typeof value.mutationId !== "string" || !value.mutationId || value.mutationId.length > 256
    || typeof value.fingerprint !== "string" || !HASH.test(value.fingerprint)
    || typeof value.etag !== "string" || !/^"draft-[a-f0-9]{64}"$/.test(value.etag)
    || (value.reason === "clear" ? value.payload !== null : value.reason === "save" && value.payload === null)) return corrupt("invalid history checkpoint");
  const entry = value as unknown as Checkpoint;
  transformPayload(entry.payload, true, (fields, ref) => ({ ...fields, [IMAGE_REFERENCE]: ref }));
  if (!checksumMatches(value) || fingerprint(entry.baseRevision, entry.payload) !== entry.fingerprint
    || storedEtag(key, entry.revision, entry.updatedAt, entry.payload) !== entry.etag) return corrupt("checkpoint content does not match its integrity digest");
  return entry;
}
function select(store: Store, requestedRevision = store.revision): Checkpoint | undefined {
  if (requestedRevision === 0 || (requestedRevision === store.revision && store.activeChecksum === null)) return undefined;
  if (requestedRevision < store.firstRevision || requestedRevision >= store.nextRevision) throw new DraftStorageError("Draft history revision was not found", 404);
  const folder = join(location(store.key).folder, "checkpoints");
  if (!assertDirectory(folder)) return corrupt("missing history checkpoint directory");
  const entry = parseCheckpoint(readJson(join(folder, `${requestedRevision}.json`)), store.key);
  if (entry.revision !== requestedRevision || (requestedRevision === store.revision
    && (entry.reason === "conflict" || entry.checksum !== store.activeChecksum || entry.etag !== store.activeEtag))) return corrupt("checkpoint does not match the draft head");
  return entry;
}
function record(store: Store, entry: Checkpoint | undefined, origin = false, hydrate = true): DraftRecord {
  const payload = entry?.payload ?? null;
  return { key: store.key, revision: entry?.revision ?? (origin ? 0 : store.revision), updatedAt: entry?.updatedAt ?? (origin ? EPOCH : store.updatedAt), payload: hydrate ? hydratePayload(payload, location(store.key).folder) : referencePayload(payload) };
}
function nextStore(before: Store, entry: Checkpoint): Store {
  const conflict = entry.reason === "conflict";
  return checksummed({
    version: 2 as const, key: before.key, revision: conflict ? before.revision : entry.revision,
    nextRevision: entry.revision + 1, activeChecksum: conflict ? before.activeChecksum : entry.checksum,
    firstRevision: before.firstRevision, updatedAt: conflict ? before.updatedAt : entry.updatedAt,
    activeEtag: conflict ? before.activeEtag : entry.etag,
  });
}
function mutationReceipt(entry: Checkpoint): MutationReceipt {
  return checksummed({ version: 1 as const, key: entry.key, mutationId: entry.mutationId, revision: entry.revision, checkpointChecksum: entry.checksum });
}
function findMutation(store: Store, mutationId: string): Checkpoint | undefined {
  if (!checkDirectories(store.key)) return undefined;
  const folder = join(location(store.key).folder, "receipts");
  if (!assertDirectory(folder)) {
    if (store.nextRevision !== store.firstRevision) return corrupt("missing mutation receipt directory");
    return undefined;
  }
  const value = readJson(join(folder, `${digest(mutationId)}.json`));
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.version !== 1 || value.key !== store.key || value.mutationId !== mutationId
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < store.firstRevision || (value.revision as number) >= store.nextRevision
    || typeof value.checkpointChecksum !== "string" || !HASH.test(value.checkpointChecksum) || !checksumMatches(value)) return corrupt("invalid mutation receipt");
  const entry = select(store, value.revision as number)!;
  if (entry.mutationId !== mutationId || entry.checksum !== value.checkpointChecksum) return corrupt("mutation receipt does not match its checkpoint");
  return entry;
}
function verifyImages(payload: DraftPayload | null, folder: string) {
  const verified = new Map<string, number>();
  transformPayload(payload, true, (fields, ref) => {
    let bytes = verified.get(ref.hash);
    if (bytes === undefined) { bytes = readImage(folder, ref.hash).length; verified.set(ref.hash, bytes); }
    if (bytes !== ref.bytes) return corrupt("inconsistent image byte length");
    return { ...fields, [IMAGE_REFERENCE]: ref };
  });
}
function writeImmutable(folder: string, name: string, value: object) {
  const encoded = `${JSON.stringify(value)}\n`;
  try {
    const previous = readPrivateFile(join(folder, name));
    if (previous.toString("utf8") !== encoded) return corrupt("immutable history or receipt was replaced");
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
    writeAtomic(folder, name, encoded);
  }
}
function applyCommit(commit: PendingCommit) {
  const folder = location(commit.key).folder;
  verifyImages(commit.entry.payload, folder);
  const checkpoints = join(folder, "checkpoints");
  const receipts = join(folder, "receipts");
  ensureDirectory(checkpoints);
  ensureDirectory(receipts);
  writeImmutable(checkpoints, `${commit.entry.revision}.json`, commit.entry);
  writeImmutable(receipts, `${digest(commit.entry.mutationId)}.json`, mutationReceipt(commit.entry));
  // This small atomic head move is the commit point. Readers never need to
  // traverse or reserialize any earlier checkpoint or mutation receipt.
  writeAtomic(folder, "metadata.json", `${JSON.stringify(commit.after)}\n`);
  unlinkSync(join(folder, "pending.json"));
  syncDirectory(folder);
}
function cleanupStore(before: Store, updatedAt: string): Store {
  return checksummed({
    version: 2 as const, key: before.key, revision: before.nextRevision,
    nextRevision: before.nextRevision + 1, firstRevision: before.nextRevision + 1,
    updatedAt, activeChecksum: null, activeEtag: storedEtag(before.key, before.nextRevision, updatedAt, null),
  });
}
function applyCleanup(cleanup: PendingCleanup) {
  const folder = location(cleanup.key).folder;
  if (!checkDirectories(cleanup.key)) return corrupt("missing private draft cleanup directory");
  // Commit the non-reusable CAS tombstone before removing content. The journal
  // makes interruption after either step replayable without resurrecting drafts.
  writeAtomic(folder, "metadata.json", `${JSON.stringify(cleanup.after)}\n`);
  // Every entry in this validated, private hashed directory belongs to this
  // draft, including interrupted writeAtomic files containing full checkpoints.
  // Keep the CAS tombstone and live journal until all content removal is durable.
  // Payload paths are never resolved; rmSync unlinks symlinks rather than
  // following them into workspace directories.
  for (const name of readdirSync(folder)) {
    if (name !== "metadata.json" && name !== "cleanup.json") rmSync(join(folder, name), { recursive: true, force: true });
  }
  syncDirectory(folder);
  unlinkSync(join(folder, "cleanup.json"));
  syncDirectory(folder);
}
function recoverCleanup(key: string, current: Store): Store {
  if (!checkDirectories(key)) return current;
  const cleanup = readJson(join(location(key).folder, "cleanup.json"));
  if (cleanup === undefined) return current;
  if (!isRecord(cleanup) || cleanup.version !== 1 || cleanup.key !== key) return corrupt("invalid pending draft cleanup");
  const before = parseStore(cleanup.before, key);
  const after = parseStore(cleanup.after, key);
  if (!Number.isSafeInteger(before.nextRevision + 1) || cleanupStore(before, after.updatedAt).checksum !== after.checksum
    || (current.checksum !== before.checksum && current.checksum !== after.checksum)) return corrupt("pending cleanup does not match the draft head");
  applyCleanup({ version: 1, key, before, after });
  return after;
}
function recoverCommit(key: string): Store {
  const current = recoverCleanup(key, loadHead(key));
  if (!checkDirectories(key)) return current;
  const pending = readJson(join(location(key).folder, "pending.json"));
  if (pending === undefined) return current;
  if (!isRecord(pending) || pending.version !== 1 || pending.key !== key) return corrupt("invalid pending draft commit");
  const before = parseStore(pending.before, key);
  const after = parseStore(pending.after, key);
  const entry = parseCheckpoint(pending.entry, key);
  if (entry.revision !== before.nextRevision || !Number.isSafeInteger(after.nextRevision)
    || (entry.reason === "conflict" ? entry.baseRevision === before.revision : entry.baseRevision !== before.revision)
    || nextStore(before, entry).checksum !== after.checksum
    || (current.checksum !== before.checksum && current.checksum !== after.checksum)) return corrupt("pending commit does not match the draft head");
  applyCommit({ version: 1, key, before, after, entry });
  return after;
}
async function load(key: string): Promise<Store> {
  if (checkDirectories(key) && (readJson(join(location(key).folder, "pending.json")) !== undefined
    || readJson(join(location(key).folder, "cleanup.json")) !== undefined)) {
    return withDraftLock(key, () => recoverCommit(key));
  }
  return loadHead(key);
}
function persist(before: Store, entry: Checkpoint, blobs: Map<string, Buffer>) {
  const { folder } = location(before.key);
  initializeStore(before);
  if (blobs.size) {
    const blobFolder = join(folder, "blobs");
    ensureDirectory(blobFolder);
    for (const [hash, bytes] of blobs) {
      try {
        const existing = readPrivateFile(join(blobFolder, `${hash}.bin`));
        if (existing.length !== bytes.length || digest(existing) !== hash) return corrupt("existing image content is corrupt");
      } catch (error) {
        if (code(error) !== "ENOENT") throw error;
        writeAtomic(blobFolder, `${hash}.bin`, bytes);
      }
    }
  }
  const commit: PendingCommit = { version: 1, key: before.key, before, after: nextStore(before, entry), entry };
  writeAtomic(folder, "pending.json", `${JSON.stringify(commit)}\n`);
  applyCommit(commit);
  return commit.after;
}

export async function readDurableDraft(key: string, revision?: number): Promise<DraftRecord> {
  validateKey(key);
  if (revision !== undefined) validateRevision(revision);
  const store = await load(key);
  return record(store, select(store, revision), revision === 0);
}

/** An unchanged active GET opens only the small head, never payload history or images. */
export async function readDurableDraftResponse(key: string, revision?: number, ifNoneMatch?: string | null): Promise<{ etag: string; record: DraftRecord | null }> {
  validateKey(key);
  if (revision !== undefined) validateRevision(revision);
  const store = await load(key);
  const selected = revision === undefined ? undefined : select(store, revision);
  const etag = revision === undefined || revision === store.revision ? store.activeEtag : selected?.etag ?? storedEtag(key, 0, EPOCH, null);
  const matches = ifNoneMatch?.split(",").some(value => value.trim() === "*" || value.trim().replace(/^W\//, "") === etag);
  return { etag, record: matches ? null : record(store, revision === undefined ? select(store) : selected, revision === 0) };
}

/** HTTP saves request reference-only receipts; direct storage consumers default to full photos. */
export async function saveDurableDraft(input: SaveDurableDraftInput, hydrate = true): Promise<DraftRecord> {
  if (!isRecord(input)) invalid("Expected a draft save object");
  const { key, baseRevision, mutationId } = input;
  validateKey(key);
  validateRevision(baseRevision);
  validateMutationId(mutationId);
  const outcome = await withDraftLock(key, () => {
    const store = recoverCommit(key);
    const incoming = extractPayload(input.payload, key);
    const incomingFingerprint = fingerprint(baseRevision, incoming.payload);
    const previous = findMutation(store, mutationId);
    if (previous) {
      if (previous.fingerprint !== incomingFingerprint) invalid("mutationId was already used for different draft content");
      return { conflict: previous.reason === "conflict", record: previous.reason === "conflict" ? record(store, select(store)) : record(store, previous, false, hydrate) };
    }
    const active = select(store);
    // A new save must not conceal a damaged active image. Verification does not
    // allocate another base64 copy of the old photos during a successful save.
    verifyImages(active?.payload ?? null, location(key).folder);
    const conflict = store.revision !== baseRevision;
    const revision = store.nextRevision;
    if (!Number.isSafeInteger(revision + 1)) throw new DraftStorageError("Draft revision space is exhausted");
    const updatedAt = new Date().toISOString();
    const entry: Checkpoint = checksummed({
      key, revision, updatedAt, reason: conflict ? "conflict" as const : incoming.payload === null ? "clear" as const : "save" as const,
      payload: incoming.payload, mutationId, baseRevision, fingerprint: incomingFingerprint,
      etag: storedEtag(key, revision, updatedAt, incoming.payload),
    });
    const after = persist(store, entry, incoming.blobs);
    return { conflict, record: conflict ? record(store, active) : record(after, entry, false, hydrate) };
  });
  if (outcome.conflict) throw new DraftConflictError(outcome.record);
  return outcome.record;
}

export async function listDurableDraftHistory(key: string): Promise<DraftVersion[]> {
  validateKey(key);
  const store = await load(key);
  const versions: DraftVersion[] = [];
  const mutations = new Set<string>();
  let activeRevision = store.firstRevision - 1;
  for (let revision = store.firstRevision; revision < store.nextRevision; revision++) {
    const entry = select(store, revision)!;
    if (mutations.has(entry.mutationId) || (entry.reason === "conflict" ? entry.baseRevision === activeRevision : entry.baseRevision !== activeRevision)) return corrupt("inconsistent history ancestry");
    mutations.add(entry.mutationId);
    if (entry.reason !== "conflict") activeRevision = revision;
    const text = typeof entry.payload?.value === "string" ? entry.payload.value : typeof entry.payload?.prompt === "string" ? entry.payload.prompt : "";
    const images = Array.isArray(entry.payload?.images) ? entry.payload.images.length : 0;
    const files = Array.isArray(entry.payload?.files) ? entry.payload.files.length : 0;
    versions.push({ revision, updatedAt: entry.updatedAt, reason: entry.reason, preview: text.replace(/\s+/g, " ").trim().slice(0, 160) || (entry.payload === null ? "Cleared draft" : images || files ? `${images} images, ${files} files` : "Empty draft") });
  }
  if (activeRevision !== store.revision) return corrupt("history does not match the active draft");
  return versions.reverse();
}

export async function deleteDurableDraft(key: string, baseRevision: number): Promise<DraftRecord> {
  validateKey(key);
  validateRevision(baseRevision);
  return withDraftLock(key, () => {
    const store = recoverCommit(key);
    const active = select(store);
    if (store.revision !== baseRevision) throw new DraftConflictError(record(store, active));
    if (!Number.isSafeInteger(store.nextRevision + 1)) throw new DraftStorageError("Draft revision space is exhausted");
    initializeStore(store);
    const commit: PendingCleanup = { version: 1, key, before: store, after: cleanupStore(store, new Date().toISOString()) };
    writeAtomic(location(key).folder, "cleanup.json", `${JSON.stringify(commit)}\n`);
    applyCleanup(commit);
    return record(commit.after, undefined);
  });
}
