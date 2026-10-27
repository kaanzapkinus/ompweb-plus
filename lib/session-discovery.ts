import { open, stat } from "fs/promises";
import type { FileHandle } from "fs/promises";
import type { BigIntStats } from "fs";
import { join } from "path";
import { StringDecoder } from "string_decoder";
import { getBlobsDir, getSessionsDir } from "./omp/paths";
import { listSessionFiles, MAX_SESSION_LOAD_BYTES, parseBlobRef, parseJsonlLenient, parseTitleSlotLine, readSessionHeaderSync } from "./omp/session-files";
import { cacheSessionPath } from "./session-reader";
import { projectIdentityKey, sessionPathKey } from "./paths";
import { isRecord } from "./type-guards";
import { resolveProject } from "./worktree";
import type { SessionInfo } from "./types";
import type { ChatSearchResult, RecentChatsResponse, SessionSearchResponse } from "./session-discovery-types";

type SearchableMessage = { text: string; role: "user" | "assistant"; entryId?: string };
type BlobVersion = { path: string; version: string };
type DiscoveryRecord = {
  session: SessionInfo;
  parent?: string;
  lastMessageAt?: string;
  messages: SearchableMessage[];
  textComplete: boolean;
  unavailable: boolean;
  blobs: BlobVersion[];
};
type CacheEntry = { version: string; record: DiscoveryRecord; bytes: number };

// Only projected conversation text is cached, never JSON, tools, reasoning or images.
// Oversized projections keep a summary for recents and are streamed again for search.
const CACHE_BYTES = 16 * 1024 * 1024;
const CACHE_ENTRIES = 256;
const SESSION_TEXT_BYTES = 512 * 1024;
const SESSION_MESSAGES = 2048;
const SESSION_BLOBS = 2048;
const READ_BYTES = 64 * 1024;
const EXCERPT_LENGTH = 220;
const FIRST_MESSAGE_LENGTH = 4096;
const cache = new Map<string, CacheEntry>();
let cacheBytes = 0;

function version(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

function normalize(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= 8.64e15 ? parsed : undefined;
}

function dropCache(key: string): void {
  const previous = cache.get(key);
  if (previous) cacheBytes -= previous.bytes;
  cache.delete(key);
}

function storeCache(key: string, fileVersion: string, record: DiscoveryRecord): void {
  dropCache(key);
  if (record.unavailable || record.blobs.length > SESSION_BLOBS) return;
  const bytes = 1024 + key.length * 2 + record.session.firstMessage.length * 2
    + (record.session.name?.length ?? 0) * 2 + record.session.cwd.length * 2
    + record.blobs.reduce((sum, blob) => sum + 160 + blob.path.length * 2, 0)
    + record.messages.reduce((sum, message) => sum + 128 + message.text.length * 2 + (message.entryId?.length ?? 0) * 2, 0);
  if (bytes > CACHE_BYTES) return;
  cache.set(key, { version: fileVersion, record, bytes });
  cacheBytes += bytes;
  while (cacheBytes > CACHE_BYTES || cache.size > CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    dropCache(oldest);
  }
}

async function blobsUnchanged(blobs: BlobVersion[], signal?: AbortSignal): Promise<boolean> {
  for (const blob of blobs) {
    signal?.throwIfAborted();
    try {
      if (version(await stat(blob.path, { bigint: true })) !== blob.version) return false;
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  }
  return true;
}

/** Like the native lenient reader, parse one physical JSONL row at a time.
 * Async 64KiB reads allow cancellation between chunks, including huge image rows.
 * The native 1GiB file ceiling is the only byte limit; no smaller line cutoff.
 */
async function forEachLine(
  handle: FileHandle,
  size: number,
  onLine: (line: string, trailing: boolean) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const buffer = Buffer.allocUnsafe(READ_BYTES);
  const decoder = new StringDecoder("utf8");
  const fragments: string[] = [];
  let position = 0;
  while (position < size) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
    signal?.throwIfAborted();
    if (!bytesRead) break;
    position += bytesRead;
    let start = 0;
    while (start < bytesRead) {
      const next = buffer.indexOf(10, start);
      const end = next >= 0 && next < bytesRead ? next : bytesRead;
      fragments.push(decoder.write(buffer.subarray(start, end)));
      if (end < bytesRead) {
        fragments.push(decoder.end());
        const line = fragments.join("");
        fragments.length = 0;
        await onLine(line, false);
        signal?.throwIfAborted();
      }
      start = end + 1;
    }
  }
  if (fragments.length) {
    fragments.push(decoder.end());
    await onLine(fragments.join(""), true);
  }
}

async function readTextBlob(value: string, record: DiscoveryRecord, signal?: AbortSignal): Promise<string> {
  if (!value.startsWith("blob:sha256:")) return value;
  const hash = parseBlobRef(value);
  if (!hash) {
    record.unavailable = true;
    return "";
  }
  // Native hash validation and profile-aware blob root prohibit path traversal.
  const path = join(getBlobsDir(), hash);
  let handle: FileHandle | undefined;
  try {
    signal?.throwIfAborted();
    handle = await open(path, "r");
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_SESSION_LOAD_BYTES)) {
      record.unavailable = true;
      return "";
    }
    const parts: string[] = [];
    const buffer = Buffer.allocUnsafe(READ_BYTES);
    const decoder = new StringDecoder("utf8");
    let position = 0;
    while (position < Number(before.size)) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - position), position);
      if (!bytesRead) break;
      position += bytesRead;
      parts.push(decoder.write(buffer.subarray(0, bytesRead)));
    }
    parts.push(decoder.end());
    signal?.throwIfAborted();
    const fileVersion = version(before);
    if (version(await handle.stat({ bigint: true })) !== fileVersion || version(await stat(path, { bigint: true })) !== fileVersion) {
      record.unavailable = true;
      return "";
    }
    if (record.blobs.length <= SESSION_BLOBS) record.blobs.push({ path, version: fileVersion });
    return parts.join("");
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof RangeError) && !(isRecord(error) && typeof error.code === "string")) throw error;
    record.unavailable = true;
    return "";
  } finally {
    await handle?.close();
  }
}

async function messageText(content: unknown, record: DiscoveryRecord, signal?: AbortSignal): Promise<string> {
  if (typeof content === "string") return normalize(await readTextBlob(content, record, signal));
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    signal?.throwIfAborted();
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(await readTextBlob(block.text, record, signal));
    }
  }
  return normalize(parts.join(" "));
}

async function discoverFile(path: string, onMessage: ((message: SearchableMessage) => void) | undefined, signal?: AbortSignal): Promise<DiscoveryRecord | undefined> {
  signal?.throwIfAborted();
  const key = sessionPathKey(path);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const before = await handle.stat({ bigint: true });
    const fileVersion = version(before);
    if (!before.isFile() || before.size > BigInt(MAX_SESSION_LOAD_BYTES)) return undefined;
    const cached = cache.get(key);
    if (cached?.version === fileVersion && (!onMessage || cached.record.textComplete) && await blobsUnchanged(cached.record.blobs, signal)) {
      signal?.throwIfAborted();
      if (version(await handle.stat({ bigint: true })) !== fileVersion || version(await stat(path, { bigint: true })) !== fileVersion) return undefined;
      signal?.throwIfAborted();
      cache.delete(key);
      cache.set(key, cached);
      if (onMessage) for (const message of cached.record.messages) onMessage(message);
      return cached.record;
    }
    dropCache(key);
    const header = readSessionHeaderSync(path);
    if (!header || typeof header.id !== "string" || !header.id) return undefined;
    const modified = new Date(Number(before.mtimeMs)).toISOString();
    const created = timestamp(header.timestamp);
    const cwd = typeof header.cwd === "string" ? header.cwd : "";
    const record: DiscoveryRecord = {
      session: {
        path, id: header.id, cwd,
        name: typeof header.title === "string" ? header.title : undefined,
        created: created === undefined ? modified : new Date(created).toISOString(),
        modified, messageCount: 0, firstMessage: "(no messages)",
        projectRoot: cwd, projectKey: projectIdentityKey(cwd),
      },
      parent: typeof header.parentSession === "string" ? header.parentSession : undefined,
      messages: [], textComplete: true, unavailable: false, blobs: [],
    };
    let textBytes = 0;
    let lastMessageAt: number | undefined;
    let firstUser = false;
    let firstLine = true;
    let slotTitle = false;
    let shortSummary: string | undefined;
    await forEachLine(handle, Number(before.size), async (line, trailing) => {
      if (firstLine) {
        firstLine = false;
        slotTitle = parseTitleSlotLine(line) !== undefined;
      }
      if (!line.trim()) return;
      const entry = parseJsonlLenient<unknown>(line)[0];
      if (!isRecord(entry)) {
        // Torn final appends are expected; malformed complete rows are reported.
        if (!trailing) record.unavailable = true;
        return;
      }
      if (!slotTitle) {
        if (entry.type === "session_info" && typeof entry.name === "string") record.session.name = entry.name || undefined;
        if (entry.type === "title_change" && typeof entry.title === "string") record.session.name = entry.title || undefined;
      }
      if (entry.type === "compaction" && typeof entry.shortSummary === "string") shortSummary = entry.shortSummary;
      if (entry.type !== "message" || !isRecord(entry.message)) return;
      const message = entry.message;
      if (message.role !== "user" && message.role !== "assistant") return;
      record.session.messageCount++;
      const at = timestamp(message.timestamp) ?? timestamp(entry.timestamp);
      if (at !== undefined && (lastMessageAt === undefined || at > lastMessageAt)) lastMessageAt = at;
      const text = await messageText(message.content, record, signal);
      if (!text) return;
      if (message.role === "user" && !firstUser) {
        record.session.firstMessage = text.slice(0, FIRST_MESSAGE_LENGTH);
        firstUser = true;
      }
      const searchable: SearchableMessage = { text, role: message.role, ...(typeof entry.id === "string" ? { entryId: entry.id } : {}) };
      onMessage?.(searchable);
      if (record.textComplete) {
        textBytes += 128 + text.length * 2 + (searchable.entryId?.length ?? 0) * 2;
        if (textBytes > SESSION_TEXT_BYTES || record.messages.length >= SESSION_MESSAGES) {
          record.messages = [];
          record.textComplete = false;
        } else record.messages.push(searchable);
      }
    }, signal);
    record.session.name ??= shortSummary;
    if (lastMessageAt !== undefined) record.lastMessageAt = new Date(lastMessageAt).toISOString();
    signal?.throwIfAborted();
    // Never publish or cache a projection of a moving/replaced file. A later
    // query reopens it; aborted queries perform no deferred indexing writes.
    if (version(await handle.stat({ bigint: true })) !== fileVersion || version(await stat(path, { bigint: true })) !== fileVersion) return undefined;
    if (!await blobsUnchanged(record.blobs, signal)) return undefined;
    signal?.throwIfAborted();
    storeCache(key, fileVersion, record);
    return record;
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof RangeError) && !(isRecord(error) && typeof error.code === "string")) throw error;
    dropCache(key);
    return undefined;
  } finally {
    await handle?.close();
  }
}

function excerpt(text: string, query: string): string | undefined {
  const folded = text.toLowerCase();
  const index = folded.indexOf(query);
  if (index < 0) return undefined;
  // Lowercasing can expand Unicode characters (e.g. capital dotted I). Map
  // the folded position back to source code points before slicing excerpts.
  let sourceIndex = index;
  if (folded.length !== text.length) {
    let foldedPosition = 0;
    sourceIndex = 0;
    for (const character of text) {
      if (foldedPosition >= index) break;
      foldedPosition += character.toLowerCase().length;
      sourceIndex += character.length;
    }
  }
  const start = Math.max(0, sourceIndex - 70);
  const end = Math.min(text.length, start + Math.max(EXCERPT_LENGTH, query.length));
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

type Candidate = { record: DiscoveryRecord; match?: Omit<ChatSearchResult, "session"> };

async function discover(query: string | undefined, signal?: AbortSignal): Promise<{ candidates: Candidate[]; unavailable: number }> {
  signal?.throwIfAborted();
  const files = await listSessionFiles(getSessionsDir());
  signal?.throwIfAborted();
  const present = new Set(files.map(path => sessionPathKey(path)));
  for (const key of cache.keys()) if (!present.has(key)) dropCache(key);
  const candidates: Candidate[] = [];
  const counts = new Map<string, number>();
  let unavailable = 0;
  for (const path of files) {
    signal?.throwIfAborted();
    let match: Candidate["match"];
    const record = await discoverFile(path, query === undefined ? undefined : message => {
      if (match) return;
      const found = excerpt(message.text, query);
      if (found !== undefined) match = { excerpt: found, role: message.role, ...(message.entryId ? { entryId: message.entryId } : {}) };
    }, signal);
    if (!record) {
      unavailable++;
      // A valid header can still identify a too-large/moving file. Include it
      // in collision detection even though its body cannot produce results.
      try {
        const header = readSessionHeaderSync(path);
        if (header && typeof header.id === "string" && header.id) counts.set(header.id, (counts.get(header.id) ?? 0) + 1);
      } catch {
        // The failed transcript is already included in unavailable.
      }
      continue;
    }
    counts.set(record.session.id, (counts.get(record.session.id) ?? 0) + 1);
    if (record.unavailable) unavailable++;
    if (query !== undefined && !match) {
      const title = record.session.name ? excerpt(normalize(record.session.name), query) : undefined;
      const first = record.session.firstMessage !== "(no messages)" ? excerpt(record.session.firstMessage, query) : undefined;
      if (title !== undefined || first !== undefined) match = { excerpt: title ?? first!, role: null };
    }
    // Per-request candidates retain only summaries; otherwise a large profile
    // would pin every evicted text projection until the whole query finishes.
    candidates.push({ record: { ...record, session: { ...record.session }, messages: [], blobs: [] }, match });
  }
  // Selection APIs address chats by ID, not path. Ambiguous IDs must never
  // advertise a match that could open a different file in the path resolver.
  const unique = candidates.filter(({ record }) => {
    if (counts.get(record.session.id) === 1) return true;
    if (!record.unavailable) unavailable++;
    return false;
  });
  const byPath = new Map(unique.map(({ record }) => [sessionPathKey(record.session.path), record.session.id]));
  for (const { record } of unique) {
    if (record.parent) record.session.parentSessionId = byPath.get(sessionPathKey(record.parent)) ?? (counts.get(record.parent) === 1 ? record.parent : undefined);
  }
  signal?.throwIfAborted();
  return { candidates: unique, unavailable };
}

async function withProject(session: SessionInfo, signal?: AbortSignal): Promise<SessionInfo> {
  signal?.throwIfAborted();
  const project = session.cwd ? await resolveProject(session.cwd) : undefined;
  signal?.throwIfAborted();
  cacheSessionPath(session.id, session.path);
  return {
    ...session,
    projectRoot: project?.projectRoot ?? session.cwd,
    projectKey: projectIdentityKey(project?.projectRoot ?? session.cwd),
    ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
  };
}

function activityOrder(a: Candidate, b: Candidate): number {
  return (timestamp(b.record.lastMessageAt) ?? -Infinity) - (timestamp(a.record.lastMessageAt) ?? -Infinity)
    || a.record.session.id.localeCompare(b.record.session.id)
    || a.record.session.path.localeCompare(b.record.session.path);
}

export async function searchSessions(query: string, options: { offset?: number; limit?: number; signal?: AbortSignal } = {}): Promise<SessionSearchResponse> {
  options.signal?.throwIfAborted();
  const normalized = normalize(query).toLowerCase();
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Invalid search pagination");
  if (!normalized) return { results: [], total: 0, hasMore: false, unavailable: 0 };
  const { candidates, unavailable } = await discover(normalized, options.signal);
  const matches = candidates.filter(candidate => candidate.match).sort(activityOrder);
  const results: ChatSearchResult[] = [];
  for (const candidate of matches.slice(offset, offset + limit)) {
    results.push({ session: await withProject(candidate.record.session, options.signal), ...candidate.match! });
  }
  return { results, total: matches.length, hasMore: offset + results.length < matches.length, unavailable };
}

export async function listRecentSessions(options: { signal?: AbortSignal } = {}): Promise<RecentChatsResponse> {
  const { candidates, unavailable } = await discover(undefined, options.signal);
  const recent = candidates.filter(candidate => candidate.record.lastMessageAt !== undefined).sort(activityOrder).slice(0, 10);
  const sessions: RecentChatsResponse["sessions"] = [];
  for (const { record } of recent) sessions.push({ ...await withProject(record.session, options.signal), lastMessageAt: record.lastMessageAt! });
  return { sessions, unavailable };
}
