import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) } });
const discovery = await jiti.import("./session-discovery.ts");
const reader = await jiti.import("./session-reader.ts");
const message = (id, role, content, timestamp) => ({ type: "message", id, parentId: null, timestamp, message: { role, content, timestamp: Date.parse(timestamp) } });
async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "omp-chat-discovery-"));
  const agent = join(root, "agent"), project = join(root, "project"), other = join(root, "other");
  for (const path of [agent, project, other]) mkdirSync(path);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  reader.invalidateSessionListCache();
  function session(id, entries, cwd = project, title = id) {
    const folder = join(agent, "sessions", `-${id}`); mkdirSync(folder, { recursive: true });
    const file = join(folder, `2026-01-01_${id}.jsonl`);
    writeFileSync(file, [
      { type: "session", version: 3, id, cwd, timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "session_info", id: `${id}-name`, parentId: null, name: title, timestamp: "2026-01-01T00:00:00.000Z" },
      ...entries,
    ].map(JSON.stringify).join("\n") + "\n");
    reader.invalidateSessionListCache();
    return file;
  }
  try { await run({ root, project, other, session }); }
  finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    reader.invalidateSessionListCache(); rmSync(root, { recursive: true, force: true });
  }
}

test("global search finds later messages and assistant phrases across directories without changing transcripts", () => fixture(async ({ project, other, session }) => {
  const a = session("a", [message("a1", "user", "An unrelated opening", "2026-01-01T01:00:00Z"), message("a2", "assistant", [{ type: "text", text: "The missing deployment sentence is here." }], "2026-01-02T01:00:00Z")], project, "Unrelated title");
  const b = session("b", [message("b1", "user", "Another missing deployment sentence was discussed.", "2026-01-03T01:00:00Z")], other);
  const bytes = [a, b].map(path => readFileSync(path, "utf8"));
  const result = await discovery.searchSessions("MISSING   deployment sentence");
  assert.equal(result.total, 2);
  assert.deepEqual(new Set(result.results.map(item => item.session.id)), new Set(["a", "b"]));
  assert.match(result.results.find(item => item.session.id === "a").excerpt, /missing deployment sentence/);
  assert.equal(result.results.find(item => item.session.id === "a").role, "assistant");
  assert.deepEqual([a, b].map(path => readFileSync(path, "utf8")), bytes);
}));

test("message search excludes tool output, reasoning and image bytes and treats regex punctuation literally", () => fixture(async ({ session }) => {
  session("visible", [message("v", "user", "Search this literal [a.*] and Türkçe bir cümle.", "2026-01-01T01:00:00Z")]);
  session("internal", [message("t", "toolResult", "hiddenneedle", "2026-01-03T01:00:00Z"), message("r", "assistant", [{ type: "thinking", thinking: "hiddenneedle" }, { type: "image", data: "hiddenneedle", mimeType: "image/png" }], "2026-01-03T01:00:00Z")]);
  assert.equal((await discovery.searchSessions("hiddenneedle")).total, 0);
  assert.deepEqual((await discovery.searchSessions("[a.*]")).results.map(item => item.session.id), ["visible"]);
  assert.deepEqual((await discovery.searchSessions("türkçe bir cümle")).results.map(item => item.session.id), ["visible"]);
}));

test("recents use message activity rather than file mtime, title edits or empty chat creation and return ten", () => fixture(async ({ session }) => {
  const old = session("old", [message("o", "user", "An old conversation", "2026-01-01T01:00:00Z")]);
  for (let i = 2; i <= 13; i++) session(`chat-${i}`, [message(`m-${i}`, "user", `Message ${i}`, `2026-01-${String(i).padStart(2, "0")}T01:00:00Z`)]);
  session("empty", []);
  utimesSync(old, new Date("2026-12-31"), new Date("2026-12-31"));
  let recent = await discovery.listRecentSessions();
  assert.equal(recent.sessions.length, 10);
  assert.deepEqual(recent.sessions.map(s => s.id), Array.from({ length: 10 }, (_, i) => `chat-${13-i}`));
  appendFileSync(old, JSON.stringify({ type: "session_info", id: "renamed", name: "Renamed today", timestamp: "2026-12-31T00:00:00Z" }) + "\n");
  reader.invalidateSessionListCache();
  assert.deepEqual((await discovery.listRecentSessions()).sessions.map(s => s.id), recent.sessions.map(s => s.id));
  appendFileSync(old, JSON.stringify(message("new-message", "assistant", "An actual new reply", "2026-02-01T00:00:00Z")) + "\n");
  reader.invalidateSessionListCache();
  recent = await discovery.listRecentSessions();
  assert.equal(recent.sessions[0].id, "old");
  assert.equal(Date.parse(recent.sessions[0].lastMessageAt), Date.parse("2026-02-01T00:00:00Z"));
}));

test("search pagination keeps all matching chats reachable and notices appended and deleted messages", () => fixture(async ({ session }) => {
  const files = Array.from({ length: 4 }, (_, i) => session(`page-${i}`, [message(`p-${i}`, "user", "Shared searchable phrase", `2026-01-0${i+1}T01:00:00Z`)]));
  const first = await discovery.searchSessions("searchable phrase", { limit: 2 });
  const second = await discovery.searchSessions("searchable phrase", { limit: 2, offset: 2 });
  assert.equal(first.total, 4); assert.equal(first.hasMore, true); assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.results, ...second.results].map(r => r.session.id)).size, 4);
  appendFileSync(files[0], JSON.stringify(message("append", "user", "A newly discoverable sentence", "2026-02-01T00:00:00Z")) + "\n");
  reader.invalidateSessionListCache();
  assert.equal((await discovery.searchSessions("newly discoverable")).results[0].session.id, "page-0");
  rmSync(files[0]); reader.invalidateSessionListCache();
  assert.equal((await discovery.searchSessions("newly discoverable")).total, 0);
}));

test("title fallback, inactive branches and malformed trailing writes remain discoverable", () => fixture(async ({ session }) => {
  const file = session("branches", [
    message("root", "user", "First visible question", "2026-01-01T00:00:00Z"),
    { ...message("inactive", "assistant", "An inactive branch phrase", "2026-01-02T00:00:00Z"), parentId: "root" },
    { ...message("active", "assistant", "Another branch", "2026-01-03T00:00:00Z"), parentId: "root" },
  ], undefined, "Special title fallback");
  appendFileSync(file, '{"type":"message","id":"unfinished"');
  const title = await discovery.searchSessions("special title");
  assert.equal(title.results[0].role, null);
  assert.match(title.results[0].excerpt, /Special title fallback/);
  const branch = await discovery.searchSessions("inactive branch");
  assert.equal(branch.results[0].entryId, "inactive");
  assert.equal((await discovery.listRecentSessions()).sessions[0].lastMessageAt, "2026-01-03T00:00:00.000Z");
}));

test("invalid timestamps and non-conversation activity never create recency", () => fixture(async ({ session }) => {
  session("invalid", [message("bad", "user", "No dated activity", "invalid"), message("tool", "toolResult", "Tool activity", "2026-12-01T00:00:00Z")]);
  session("entry-time", [{ type: "message", id: "entry", timestamp: "2026-01-04T00:00:00Z", message: { role: "assistant", content: "Entry timestamp" } }]);
  const result = await discovery.listRecentSessions();
  assert.deepEqual(result.sessions.map(item => item.id), ["entry-time"]);
  assert.equal(result.sessions[0].lastMessageAt, "2026-01-04T00:00:00.000Z");
}));

test("same-size rewrites with restored mtime invalidate cached searchable text", () => fixture(async ({ session }) => {
  const file = session("rewrite", [message("rewrite", "user", "oldneedle", "2026-01-01T00:00:00Z")]);
  const before = readFileSync(file, "utf8");
  assert.equal((await discovery.searchSessions("oldneedle")).total, 1);
  const { statSync } = await import("node:fs");
  const stat = statSync(file);
  writeFileSync(file, before.replace("oldneedle", "newneedle"));
  utimesSync(file, stat.atime, stat.mtime);
  assert.equal((await discovery.searchSessions("newneedle")).total, 1);
  assert.equal((await discovery.searchSessions("oldneedle")).total, 0);
}));

test("text blob references are confined and invalidated while image blobs remain excluded", () => fixture(async ({ root, session }) => {
  const hash = "c".repeat(64);
  const blobs = join(root, "agent", "blobs"); mkdirSync(blobs);
  const blob = join(blobs, hash); writeFileSync(blob, "A blob-backed searchable sentence");
  session("blob", [message("blob-message", "user", [{ type: "text", text: `blob:sha256:${hash}` }], "2026-01-01T00:00:00Z")]);
  session("image", [message("image-message", "user", [{ type: "image", data: `blob:sha256:${hash}` }], "2026-01-02T00:00:00Z")]);
  assert.deepEqual((await discovery.searchSessions("blob-backed searchable")).results.map(item => item.session.id), ["blob"]);
  writeFileSync(blob, "Replacement searchable text");
  assert.equal((await discovery.searchSessions("blob-backed searchable")).total, 0);
  assert.equal((await discovery.searchSessions("Replacement searchable")).total, 1);
  rmSync(blob);
  assert.equal((await discovery.searchSessions("Replacement searchable")).unavailable, 1);
}));

test("duplicate session IDs are unavailable rather than opening the wrong conversation", () => fixture(async ({ root, session }) => {
  const source = session("duplicate", [message("d", "user", "Collision phrase", "2026-01-01T00:00:00Z")]);
  const folder = join(root, "agent", "sessions", "-duplicate-copy"); mkdirSync(folder);
  writeFileSync(join(folder, "copy.jsonl"), readFileSync(source));
  reader.invalidateSessionListCache();
  const result = await discovery.searchSessions("Collision phrase");
  assert.equal(result.total, 0);
  assert.equal(result.unavailable, 2);
  assert.equal((await discovery.listRecentSessions()).sessions.length, 0);
}));

test("aborted discovery rejects without poisoning the next request", () => fixture(async ({ session }) => {
  session("abort", [message("a", "user", "Still discoverable", "2026-01-01T00:00:00Z")]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(discovery.searchSessions("discoverable", { signal: controller.signal }), { name: "AbortError" });
  assert.equal((await discovery.searchSessions("discoverable")).total, 1);
}));

test("HTTP discovery validates pagination and never caches search or recents", () => fixture(async ({ session }) => {
  session("route", [message("route-message", "assistant", "A route-visible phrase", "2026-01-01T00:00:00Z")]);
  const search = await jiti.import("../app/api/sessions/search/route.ts");
  const recent = await jiti.import("../app/api/sessions/recent/route.ts");
  const response = await search.GET(new Request("http://localhost/api/sessions/search?q=route-visible&limit=1&offset=0"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).results[0].session.id, "route");
  for (const query of ["limit=101", "limit=0", "offset=-1", "offset=1.5", "limit=1e2", "path=%2Ftmp", "q=a&q=b"]) {
    assert.equal((await search.GET(new Request(`http://localhost/api/sessions/search?${query}`))).status, 400, query);
  }
  const latest = await recent.GET(new Request("http://localhost/api/sessions/recent"));
  assert.equal(latest.headers.get("cache-control"), "no-store");
  assert.equal((await latest.json()).sessions[0].id, "route");
  assert.equal((await recent.GET(new Request("http://localhost/api/sessions/recent?path=%2Ftmp"))).status, 400);
}));

test("supported large image rows do not hide later text or retain image data as searchable text", () => fixture(async ({ session }) => {
  session("large-image", [
    message("large", "user", [{ type: "image", data: "x".repeat(17 * 1024 * 1024), mimeType: "image/png" }, { type: "text", text: "Large attachment question" }], "2026-01-01T00:00:00Z"),
    message("later", "assistant", "The later attachment answer", "2026-01-02T00:00:00Z"),
  ]);
  const result = await discovery.searchSessions("later attachment answer");
  assert.equal(result.unavailable, 0);
  assert.equal(result.results[0].entryId, "later");
  assert.equal((await discovery.searchSessions("xxxxxxxxxxxx")).total, 0);
}));

test("messages beyond the text cache budget remain searchable on every query", () => fixture(async ({ session }) => {
  session("large-text", [message("large-text", "assistant", "x".repeat(600 * 1024) + " End-of-message cache-budget phrase", "2026-01-01T00:00:00Z")]);
  assert.equal((await discovery.searchSessions("cache-budget phrase")).results[0].entryId, "large-text");
  await discovery.listRecentSessions();
  assert.equal((await discovery.searchSessions("cache-budget phrase")).total, 1);
}));

test("malformed complete records and transcripts beyond the native ceiling are explicitly unavailable", () => fixture(async ({ session }) => {
  const malformed = session("malformed", [message("valid", "user", "A surviving searchable message", "2026-01-01T00:00:00Z")]);
  appendFileSync(malformed, "{not-json}\n");
  const oversized = session("oversized", []);
  const { truncateSync } = await import("node:fs");
  truncateSync(oversized, 1024 * 1024 * 1024 + 1);
  const result = await discovery.searchSessions("surviving searchable");
  assert.equal(result.total, 1);
  assert.equal(result.unavailable, 2);
}));

test("in-flight cancellation leaves subsequent queries able to index the same files", () => fixture(async ({ session }) => {
  session("cancel-mid-read", [message("cancel", "user", "x".repeat(2 * 1024 * 1024) + " After cancellation phrase", "2026-01-01T00:00:00Z")]);
  const controller = new AbortController();
  const request = discovery.searchSessions("After cancellation", { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 0);
  try { await assert.rejects(request, { name: "AbortError" }); }
  finally { clearTimeout(timer); }
  assert.equal((await discovery.searchSessions("After cancellation")).total, 1);
}));

test("a readable duplicate cannot be selected when its colliding transcript exceeds the native ceiling", () => fixture(async ({ root, session }) => {
  const source = session("collision-large", [message("c", "user", "Do not open an ambiguous chat", "2026-01-01T00:00:00Z")]);
  const folder = join(root, "agent", "sessions", "-oversized-copy"); mkdirSync(folder);
  const copy = join(folder, "copy.jsonl"); writeFileSync(copy, readFileSync(source));
  const { truncateSync } = await import("node:fs");
  truncateSync(copy, 1024 * 1024 * 1024 + 1);
  reader.invalidateSessionListCache();
  const result = await discovery.searchSessions("ambiguous chat");
  assert.equal(result.total, 0);
  assert.equal(result.unavailable, 2);
}));

test("unnamed chats preserve the native short-summary title fallback", () => fixture(async ({ session }) => {
  session("summary-title", [
    message("original", "user", "An unrelated first message", "2026-01-01T00:00:00Z"),
    { type: "compaction", id: "compact", shortSummary: "Concise fallback title", summary: "Hidden compacted details", timestamp: "2026-02-01T00:00:00Z" },
  ], undefined, "");
  const result = await discovery.searchSessions("Concise fallback");
  assert.equal(result.results[0].session.name, "Concise fallback title");
  assert.equal(result.results[0].role, null);
  assert.equal((await discovery.searchSessions("Hidden compacted details")).total, 0);
  assert.equal((await discovery.listRecentSessions()).sessions[0].lastMessageAt, "2026-01-01T00:00:00.000Z");
}));
