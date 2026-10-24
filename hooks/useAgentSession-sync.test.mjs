import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, { alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) } });
const { createSessionCatchUp } = await jiti.import("./useAgentSession-sync.ts");

test("a newer user delivery cannot block recovery of an unrelated assistant partial", async (t) => {
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined });
  t.after(() => Object.defineProperty(AbortSignal, "timeout", timeoutDescriptor));
  const context = { messages: [], entryIds: [], thinkingLevel: "off", model: null, todoPhases: [] };
  let displayed = "visible before the gap";
  let release;
  let started;
  const requested = new Promise((resolve) => { started = resolve; });
  t.mock.method(globalThis, "fetch", () => new Promise((resolve) => {
    release = () => resolve({ ok: true, json: async () => ({
      sessionId: "s1", mode: "append", baseEntryId: null, context,
      cursor: { firstEntryId: null, lastEntryId: null }, hasMore: false, leafId: null,
      live: {
        cursor: { streamId: "stream", sequence: 2 }, isStreaming: true, isPromptRunning: true, isCompacting: false,
        streamingMessage: { role: "assistant", content: [{ type: "text", text: "recovered partial" }] }, toolEvents: [],
      },
    }) });
    started();
  }));
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "same-run", history() {}, subscribe: () => false,
    live(snapshot, fields) { if (fields.message) displayed = snapshot.streamingMessage.content[0].text; },
  });
  catchUp.seed(context);
  catchUp.observe({ type: "connected", web: { streamId: "stream", sequence: 1 } });
  const pending = catchUp.request();
  await requested;
  catchUp.observe({ type: "message_end", message: { role: "user", content: "steering" }, web: { streamId: "stream", sequence: 3 } });
  release();
  await pending;
  assert.equal(displayed, "recovered partial");
});

test("a held full response cannot resurrect truncated entries and fresh catch-up recovers later appends", async (t) => {
  let displayed;
  let requests = 0;
  let release;
  let started;
  const following = new Promise((resolve) => { started = resolve; });
  const context = (ids) => ({
    messages: ids.map((id) => ({ role: "user", content: id })),
    entryIds: ids, thinkingLevel: "off", model: null, todoPhases: [],
  });
  t.mock.method(globalThis, "fetch", (url) => {
    requests += 1;
    const page = (ids, mode, baseEntryId) => ({ ok: true, json: async () => ({
      sessionId: "s1", mode, baseEntryId, context: context(ids),
      cursor: { firstEntryId: "a", lastEntryId: ids.at(-1) },
      hasMore: false, leafId: ids.at(-1), live: null,
    }) });
    if (requests === 1) return Promise.resolve(page(["a", "b"], "replace", null));
    assert.equal(JSON.parse(new URL(url, "http://localhost").searchParams.get("cursor")).lastEntryId, "b");
    return new Promise((resolve) => {
      release = () => resolve(page(["d"], "append", "b"));
      started();
    });
  });
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "same-view",
    history(next) { displayed = next; }, live() {}, subscribe: () => false,
  });
  catchUp.seed(context(["a", "b", "c"]));
  const fullReadPosition = catchUp.position();
  await catchUp.request();
  assert.deepEqual(displayed.entryIds, ["a", "b"]);
  catchUp.seed(context(["a", "b", "c"]), fullReadPosition);
  assert.deepEqual(displayed.entryIds, ["a", "b"]);
  await following;
  release();
  await new Promise(setImmediate);
  assert.deepEqual(displayed.entryIds, ["a", "b", "d"]);
  assert.equal(requests, 2);
});

test("expanding compacted history publishes every page atomically without clearing a newer live reply", async (t) => {
  const { selectSessionHistory, parseHistoryCursor } = await jiti.import("../lib/session-sync.ts");
  const context = (ids) => ({
    messages: ids.map((id) => ({ role: "user", content: id })),
    entryIds: ids, thinkingLevel: "off", model: null, todoPhases: [],
  });
  let displayed;
  let liveReply = "reply still streaming";
  let release;
  let started;
  const secondPage = new Promise((resolve) => { started = resolve; });
  const full = context(["earlier-1", "earlier-2", "summary", "kept"]);
  t.mock.method(globalThis, "fetch", async (url) => {
    const params = new URL(url, "http://localhost").searchParams;
    assert.equal(params.get("includePreCompaction"), "1");
    const cursor = parseHistoryCursor(params.get("cursor"));
    const response = { ok: true, json: async () => ({
      ...selectSessionHistory(full, cursor, 2), sessionId: "s1", leafId: "kept",
      live: {
        cursor: { streamId: "stream", sequence: 1 }, isStreaming: true, isPromptRunning: true, isCompacting: false,
        streamingMessage: { role: "assistant", content: [{ type: "text", text: "stale reply" }] }, toolEvents: [],
      },
    }) };
    if (!cursor) return response;
    return new Promise((resolve) => { release = () => resolve(response); started(); });
  });
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "same-run",
    history(next) { displayed = next; }, subscribe: () => false,
    live(snapshot, fields) { if (fields.message) liveReply = snapshot.streamingMessage.content[0].text; },
  });
  catchUp.seed(context(["summary", "kept"]));
  catchUp.observe({ type: "message_update", message: { role: "assistant" }, web: { streamId: "stream", sequence: 2 } });
  const pending = catchUp.expandHistory();
  await secondPage;
  assert.deepEqual(displayed.entryIds, ["summary", "kept"]);
  release();
  assert.deepEqual((await pending).entryIds, ["earlier-1", "earlier-2", "summary", "kept"]);
  assert.deepEqual(displayed.entryIds, ["earlier-1", "earlier-2", "summary", "kept"]);
  assert.equal(liveReply, "reply still streaming");
});

test("a failed earlier-history page keeps the visible transcript and can be retried", async (t) => {
  const { selectSessionHistory, parseHistoryCursor } = await jiti.import("../lib/session-sync.ts");
  const context = (ids) => ({
    messages: ids.map((id) => ({ role: "user", content: id })),
    entryIds: ids, thinkingLevel: "off", model: null, todoPhases: [],
  });
  let displayed;
  let fail = true;
  const full = context(["earlier", "summary", "kept"]);
  t.mock.method(globalThis, "fetch", async (url) => {
    const cursor = parseHistoryCursor(new URL(url, "http://localhost").searchParams.get("cursor"));
    if (cursor && fail) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({
      ...selectSessionHistory(full, cursor, 2), sessionId: "s1", leafId: "kept", live: null,
    }) };
  });
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "same-view",
    history(next) { displayed = next; }, live() {}, subscribe: () => false,
  });
  catchUp.seed(context(["summary", "kept"]));
  assert.equal(await catchUp.expandHistory(), null);
  assert.deepEqual(displayed.entryIds, ["summary", "kept"]);
  fail = false;
  assert.deepEqual((await catchUp.expandHistory()).entryIds, ["earlier", "summary", "kept"]);
  assert.deepEqual(displayed.entryIds, ["earlier", "summary", "kept"]);
});

test("navigation fences an earlier-history response from the previous view", async (t) => {
  const context = { messages: [], entryIds: [], thinkingLevel: "off", model: null, todoPhases: [] };
  const replacement = { ...context, messages: [{ role: "user", content: "other branch" }], entryIds: ["other-branch"] };
  let displayed;
  let release;
  let started;
  const requested = new Promise((resolve) => { started = resolve; });
  t.mock.method(globalThis, "fetch", (url) => {
    if (new URL(url, "http://localhost").searchParams.get("leafId") === "other-branch") {
      return Promise.resolve({ ok: true, json: async () => ({
        sessionId: "s1", mode: "replace", baseEntryId: null, context: replacement,
        cursor: { firstEntryId: "other-branch", lastEntryId: "other-branch" },
        hasMore: false, leafId: "other-branch", live: null,
      }) });
    }
    return new Promise((resolve) => {
      release = () => resolve({ ok: true, json: async () => ({
        sessionId: "s1", mode: "replace", baseEntryId: null, context,
        cursor: { firstEntryId: null, lastEntryId: null }, hasMore: false, leafId: null, live: null,
      }) });
      started();
    });
  });
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "same-view",
    history(next) { displayed = next; }, live() {}, subscribe: () => false,
  });
  catchUp.seed(context);
  const pending = catchUp.expandHistory();
  await requested;
  catchUp.select({ leafId: "other-branch", includePreCompaction: false });
  catchUp.seed(replacement);
  release();
  assert.equal(await pending, null);
  assert.deepEqual(displayed.entryIds, ["other-branch"]);
});
