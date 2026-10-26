import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { emptyScheduleDraft, scheduleDraftKey, readScheduleDraft, writeScheduleDraft, clearScheduleDraft, schedulePromptSignature } = await jiti.import("./schedule-draft.ts");
function storage() {
  const entries = new Map();
  return { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: (key) => entries.delete(key) };
}

test("schedule scopes distinguish conversations, workspaces and absent destinations", () => {
  assert.notEqual(scheduleDraftKey("same", null), scheduleDraftKey(undefined, "same"));
  assert.notEqual(scheduleDraftKey("a", "/one"), scheduleDraftKey("b", "/one"));
  assert.equal(scheduleDraftKey("a", "/one"), scheduleDraftKey("a", "/two"));
  assert.equal(scheduleDraftKey(undefined, null), null);
});

test("same-directory logical workspaces keep separate durable schedule requests", () => {
  const store = storage();
  const companion = scheduleDraftKey(undefined, "/project", "companion");
  const other = scheduleDraftKey(undefined, "/project", "other");
  const draft = { ...emptyScheduleDraft({ provider: "alpha", modelId: "one" }), prompt: "Companion only" };
  writeScheduleDraft(companion, draft, store);
  assert.notEqual(companion, other);
  assert.equal(readScheduleDraft(other, store), null);
  assert.equal(readScheduleDraft(companion, store).prompt, "Companion only");
});

test("schedule storage restores fields and clears expired quota selections without inventing a reset", () => {
  const store = storage();
  const key = scheduleDraftKey("chat", null);
  const draft = { ...emptyScheduleDraft({ provider: "missing", modelId: "retired" }), prompt: "Saved", timingMode: "quota", resetKey: JSON.stringify(["alpha", null, null, null, null, "fiveHour", 10]) };
  writeScheduleDraft(key, draft, store);
  const restored = readScheduleDraft(key, store);
  assert.equal(restored.prompt, "Saved");
  assert.deepEqual(restored.model, { provider: "missing", modelId: "retired" });
  assert.equal(restored.timingMode, "quota");
  assert.equal(restored.resetKey, "");
});

test("expired quota retries keep their exact durable body after restoration", () => {
  const store = storage();
  const key = scheduleDraftKey("chat", null);
  const draft = { ...emptyScheduleDraft({ provider: "alpha", modelId: "one" }), prompt: "Reconcile", timingMode: "quota", resetKey: JSON.stringify(["alpha", null, null, null, null, "fiveHour", 10]) };
  const body = { prompt: "Reconcile", provider: "alpha", modelId: "one", runAt: 10, requestId: "a".repeat(32) };
  draft.request = { signature: schedulePromptSignature(draft), body };
  writeScheduleDraft(key, draft, store);
  const restored = readScheduleDraft(key, store);
  assert.equal(restored.resetKey, "");
  assert.equal(restored.request.signature, schedulePromptSignature(restored));
  assert.deepEqual(restored.request.body, body);
});

test("confirmed creation cannot clear a newer draft in the same scope", () => {
  const store = storage();
  const key = scheduleDraftKey("chat", null);
  const submitted = { ...emptyScheduleDraft(null), prompt: "Old draft" };
  writeScheduleDraft(key, submitted, store);
  writeScheduleDraft(key, { ...submitted, prompt: "New draft" }, store);
  assert.equal(clearScheduleDraft(key, submitted, store), false);
  assert.equal(readScheduleDraft(key, store).prompt, "New draft");
  const current = readScheduleDraft(key, store);
  assert.equal(clearScheduleDraft(key, current, store), true);
  assert.equal(readScheduleDraft(key, store), null);
});

test("invalid storage and unavailable browser storage do not break scheduling", () => {
  const store = storage();
  const key = scheduleDraftKey("chat", null);
  for (const value of ["not json", "null", "[]", '{"prompt":"partial"}']) {
    store.setItem(key, value);
    assert.equal(readScheduleDraft(key, store), null);
  }
  const unavailable = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("full"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(readScheduleDraft(key, unavailable), null);
  assert.doesNotThrow(() => writeScheduleDraft(key, emptyScheduleDraft(null), unavailable));
  assert.doesNotThrow(() => clearScheduleDraft(key, emptyScheduleDraft(null), unavailable));
});

test("scheduled image drafts keep bytes in memory, never browser storage, and retain saved file paths", () => {
  const store = storage();
  const key = scheduleDraftKey("images", null);
  const images = [{ data: "private-image-bytes", mimeType: "image/png" }];
  const draft = { ...emptyScheduleDraft({ provider: "alpha", modelId: "one" }), prompt: "Inspect later", images, imageKeys: ["image-1"], files: [{ name: "notes.txt", path: "/workspace/notes.txt", mimeType: "text/plain", size: 12 }], thinkingLevel: "high" };
  draft.request = { signature: schedulePromptSignature(draft), body: { prompt: draft.prompt, provider: "alpha", modelId: "one", images, runAt: 10, requestId: "b".repeat(32) } };
  writeScheduleDraft(key, draft, store);
  assert.equal(store.getItem(key).includes("private-image-bytes"), false);
  assert.equal(JSON.parse(store.getItem(key)).missingImageCount, 1);
  const restored = readScheduleDraft(key, store);
  assert.deepEqual(restored.images, images);
  assert.deepEqual(restored.request.body.images, images);
  assert.equal(restored.files[0].path, "/workspace/notes.txt");
  assert.equal(restored.thinkingLevel, "high");
});

test("reasoning, saved files and image replacement change scheduled request identity", () => {
  const draft = { ...emptyScheduleDraft(null), prompt: "Same prompt", thinkingLevel: "low", imageKeys: ["original"] };
  const original = schedulePromptSignature(draft);
  assert.notEqual(schedulePromptSignature({ ...draft, thinkingLevel: "high" }), original);
  assert.notEqual(schedulePromptSignature({ ...draft, imageKeys: ["replacement"] }), original);
  assert.notEqual(schedulePromptSignature({ ...draft, files: [{ path: "/workspace/next.txt", name: "next.txt", mimeType: "text/plain", size: 10 }] }), original);
});
