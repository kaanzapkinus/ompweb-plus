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
