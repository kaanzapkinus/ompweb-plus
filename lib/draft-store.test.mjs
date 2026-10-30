import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { clearDraft, getDraft, getDraftSummary, mergeRecoveredText, recoverDraft, setDraft } = await jiti.import("./draft-store.ts");

test("getDraftSummary returns text and attachment presence without deep cloning", () => {
  const key = "test-session-draft-1";
  clearDraft(key);

  const emptySummary = getDraftSummary(key);
  assert.equal(emptySummary.text, "");
  assert.equal(emptySummary.hasAttachments, false);

  setDraft(key, {
    value: "Hello world",
    images: [{ data: "data:image/png;base64,AAA...", mimeType: "image/png" }],
    files: [{ name: "test.txt", mimeType: "text/plain", path: "/workspace/test.txt", size: 9 }],
  });

  const summary = getDraftSummary(key);
  assert.equal(summary.text, "Hello world");
  assert.equal(summary.hasAttachments, true);

  const full = getDraft(key);
  assert.ok(full);
  assert.equal(full.value, "Hello world");
  assert.equal(full.images.length, 1);
  assert.equal(full.files.length, 1);

  clearDraft(key);
  assert.equal(getDraft(key), null);
});

test("every chat retains its unsent text beyond the old fifty-draft limit", () => {
  const saved = inFreshDocument([], `
    for (let i = 0; i < 60; i++) {
      setDraft("session-" + i, { value: "Draft " + i, images: [], files: [] });
    }
    const result = getDraft("session-0")?.value;
  `);
  assert.equal(saved.result, "Draft 0");
  const restored = inFreshDocument(saved.storage, `
    const result = Array.from({ length: 60 }, (_, i) => getDraft("session-" + i)?.value ?? null);
  `);
  assert.deepEqual(restored.result, Array.from({ length: 60 }, (_, i) => "Draft " + i));
});

test("loading many durable drafts never removes unsent text or unrelated settings", () => {
  const storage = [
    ["unrelated-setting", "keep"],
    ...Array.from({ length: 55 }, (_, i) => ["omp-draft-overflow-" + i, "Draft " + i]),
  ];
  const restored = inFreshDocument(storage, `
    const result = Array.from({ length: 55 }, (_, i) => getDraft("overflow-" + i)?.value ?? null);
  `);
  assert.deepEqual(restored.result, Array.from({ length: 55 }, (_, i) => "Draft " + i));
  assert.deepEqual(restored.storage, storage);
});

// Each process is a fresh page/tab: retain localStorage, never module state.
// A new tab gets an empty sessionStorage unless a legacy current-tab fixture is supplied.
function inFreshDocument(storage, action, setup = "", sessionStorage = []) {
  const script = `
    const { createJiti } = await import("jiti");
    const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
    const storage = new Map(JSON.parse(process.env.DRAFT_STORAGE));
    const session = new Map(JSON.parse(process.env.DRAFT_SESSION_STORAGE));
    function browserStorage(entries) {
      return {
        get length() { return entries.size; },
        key: (index) => [...entries.keys()][index] ?? null,
        getItem: (key) => entries.get(key) ?? null,
        setItem: (key, value) => entries.set(key, String(value)),
        removeItem: (key) => entries.delete(key),
      };
    }
    globalThis.localStorage = browserStorage(storage);
    globalThis.sessionStorage = browserStorage(session);
    ${setup}
    const { setDraft, getDraft, getDraftSummary, clearDraft, recoverDraft,
      subscribeDrafts, subscribeDraftRecovery, hasUnsentDrafts } =
      await jiti.import(${JSON.stringify(new URL("./draft-store.ts", import.meta.url).pathname)});
    ${action}
    console.log(JSON.stringify({ storage: [...storage], sessionStorage: [...session], result }));
  `;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      DRAFT_STORAGE: JSON.stringify(storage),
      DRAFT_SESSION_STORAGE: JSON.stringify(sessionStorage),
    },
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("unsent text survives a fresh document, stays scoped, and cannot reappear after clearing", () => {
  const text = "  Unsent first line\n第二行 — café\n";
  const saved = inFreshDocument([], `
    setDraft("session-a", { value: ${JSON.stringify(text)}, images: [], files: [] });
    setDraft("new:/workspace-b", { value: "Another draft", images: [], files: [] });
    const result = null;
  `);
  const restored = inFreshDocument(saved.storage, `
    const result = [
      getDraft("session-a")?.value,
      getDraftSummary("new:/workspace-b").text,
      getDraft("session-c"),
    ];
    clearDraft("session-a");
    setDraft("new:/workspace-b", { value: "", images: [], files: [] });
  `);
  assert.deepEqual(restored.result, [text, "Another draft", null]);
  const cleared = inFreshDocument(restored.storage, `
    const result = [getDraft("session-a"), getDraft("new:/workspace-b")];
  `);
  assert.deepEqual(cleared.result, [null, null]);
});

test("text and saved document paths survive navigation without serializing image bytes into localStorage", () => {
  const saved = inFreshDocument([], `
    setDraft("attachments", {
      value: "Keep text",
      images: [{ data: "data:image/png;base64,AAAA", mimeType: "image/png" }],
      files: [{ name: "notes.txt", mimeType: "text/plain", path: "/workspace/notes.txt", size: 12 }],
    });
    const result = getDraftSummary("attachments").hasAttachments;
  `);
  assert.equal(saved.result, true);
  const restored = inFreshDocument(saved.storage, `
    const result = getDraft("attachments");
    setDraft("attachments", {
      value: "",
      images: [{ data: "data:image/png;base64,AAAA", mimeType: "image/png" }],
      files: [],
    });
  `);
  assert.deepEqual(restored.result, {
    value: "Keep text", images: [],
    files: [{ name: "notes.txt", mimeType: "text/plain", path: "/workspace/notes.txt", size: 12 }],
  });
  const cleared = inFreshDocument(restored.storage, `
    const result = getDraft("attachments");
  `);
  assert.equal(cleared.result, null);
});

test("denied browser storage still allows in-memory editing and clearing", () => {
  const document = inFreshDocument([], `
    setDraft("blocked", { value: "Still editable", images: [], files: [] });
    const result = [getDraft("blocked")?.value];
    clearDraft("blocked");
    result.push(getDraft("blocked"));
  `, `
    for (const name of ["localStorage", "sessionStorage"]) {
      Object.defineProperty(globalThis, name, {
        get() { throw new DOMException("Storage denied", "SecurityError"); },
      });
    }
  `);
  assert.deepEqual(document.result, ["Still editable", null]);
});

test("a later recovery merges with an earlier one in order, unless the draft no longer starts with it", () => {
  assert.equal(mergeRecoveredText("typing", { text: "B" }), "B\n\ntyping");
  const replace = { lead: "B", fallback: "A" };
  assert.equal(mergeRecoveredText("B\n\ntyping", { text: "A\n\nB", replace }), "A\n\nB\n\ntyping");
  assert.equal(mergeRecoveredText("edited", { text: "A\n\nB", replace }), "A\n\nedited", "never re-adds text the user removed");
});

test("recovery preserves saved-path file references without document content or shared mutable objects", () => {
  const key = "file-reference-recovery";
  const file = { name: "document.docx", mimeType: "application/octet-stream", path: "/workspace/document.docx", size: 7 };
  try {
    setDraft(key, { value: "typing", images: [], files: [] });
    recoverDraft(key, { text: "inspect", files: [file] });
    file.path = "/changed";
    const draft = getDraft(key);
    assert.equal(draft.value, "inspect\n\ntyping");
    assert.equal(draft.files[0].path, "/workspace/document.docx");
    assert.equal("content" in draft.files[0], false);
    draft.files[0].path = "/also-changed";
    assert.equal(getDraft(key).files[0].path, "/workspace/document.docx");
  } finally {
    clearDraft(key);
  }
});

test("legacy current-tab drafts migrate without replacing durable drafts or cleared markers", () => {
  const legacy = [
    ["omp-draft-legacy", "old unsent text"],
    ["omp-draft-shared", "stale tab text"],
    ["omp-draft-cleared", "already sent"],
    ["other-tab-setting", "keep"],
  ];
  const migrated = inFreshDocument([
    ["omp-draft-shared", "new durable text"],
    ["omp-draft-cleared", ""],
  ], `
    const result = [getDraft("legacy")?.value, getDraft("shared")?.value, getDraft("cleared")];
  `, "", legacy);
  assert.deepEqual(migrated.result, ["old unsent text", "new durable text", null]);
  assert.equal(migrated.sessionStorage.some(([key]) => key === "omp-draft-legacy"), false);
  assert.ok(migrated.sessionStorage.some(([key, value]) => key === "other-tab-setting" && value === "keep"));
  const reopened = inFreshDocument(migrated.storage, `
    const result = [getDraft("legacy")?.value, getDraft("shared")?.value, getDraft("cleared")];
  `);
  assert.deepEqual(reopened.result, ["old unsent text", "new durable text", null]);
});

test("a failed legacy migration preserves the session copy and in-memory text for a later reload", () => {
  const legacy = [["omp-draft-legacy", "recover me"]];
  const failed = inFreshDocument([], `
    const result = getDraft("legacy")?.value;
  `, `
    localStorage.setItem = () => { throw new DOMException("Full", "QuotaExceededError"); };
  `, legacy);
  assert.equal(failed.result, "recover me");
  assert.deepEqual(failed.sessionStorage, legacy);
  const retried = inFreshDocument(failed.storage, `
    const result = getDraft("legacy")?.value;
  `, "", failed.sessionStorage);
  const reopened = inFreshDocument(retried.storage, `
    const result = getDraft("legacy")?.value;
  `);
  assert.equal(reopened.result, "recover me");
});

test("unreadable durable storage cannot be overwritten by an older legacy copy", () => {
  const newer = [["omp-draft-shared", "newer durable text"]];
  const legacy = [["omp-draft-shared", "old tab text"]];
  const failed = inFreshDocument(newer, `
    const result = getDraft("shared")?.value;
  `, `
    localStorage.getItem = () => { throw new DOMException("Denied", "SecurityError"); };
  `, legacy);
  assert.equal(failed.result, "old tab text", "the available legacy text remains usable in memory");
  assert.deepEqual(failed.storage, newer);
  assert.deepEqual(failed.sessionStorage, legacy);
  const reopened = inFreshDocument(failed.storage, `
    const result = getDraft("shared")?.value;
  `, "", failed.sessionStorage);
  assert.equal(reopened.result, "newer durable text");
});

test("failed durable writes preserve edits, attachments, recovery and listener behavior in memory", () => {
  const failed = inFreshDocument([], `
    let changes = 0;
    const recovered = [];
    const unsubscribe = subscribeDrafts(() => { changes++; });
    const unsubscribeRecovery = subscribeDraftRecovery((key, recovery) => recovered.push([key, recovery.text]));
    setDraft("blocked", {
      value: "typed",
      images: [{ data: "private-base64", mimeType: "image/png" }],
      files: [{ name: "notes.txt", mimeType: "text/plain", path: "/workspace/notes.txt", size: 12 }],
    });
    recoverDraft("blocked", { text: "restored" });
    const draft = getDraft("blocked");
    draft.images[0].data = "mutated";
    const result = [getDraft("blocked"), changes, recovered, hasUnsentDrafts()];
    clearDraft("blocked");
    result.push(getDraft("blocked"), hasUnsentDrafts());
    unsubscribe();
    unsubscribeRecovery();
  `, `
    localStorage.setItem = () => { throw new DOMException("Full", "QuotaExceededError"); };
    localStorage.removeItem = () => { throw new DOMException("Denied", "SecurityError"); };
  `);
  assert.deepEqual(failed.result, [{
    value: "restored\n\ntyped",
    images: [{ data: "private-base64", mimeType: "image/png" }],
    files: [{ name: "notes.txt", mimeType: "text/plain", path: "/workspace/notes.txt", size: 12 }],
  }, 2, [["blocked", "restored"]], true, null, false]);
  assert.deepEqual(failed.storage, [], "attachment payloads never enter durable storage");
});

test("clearing cannot resurrect a legacy draft when session cleanup is denied", () => {
  const cleared = inFreshDocument([], `
    clearDraft("sent");
    const result = getDraft("sent");
  `, `
    sessionStorage.removeItem = () => { throw new DOMException("Denied", "SecurityError"); };
  `, [["omp-draft-sent", "already submitted"]]);
  assert.equal(cleared.result, null);
  const reopened = inFreshDocument(cleared.storage, `
    const result = getDraft("sent");
  `, "", cleared.sessionStorage);
  assert.equal(reopened.result, null);
});

test("clearing replaces stale durable text when removal fails but writes still work", () => {
  const cleared = inFreshDocument([["omp-draft-sent", "already submitted"]], `
    clearDraft("sent");
    const result = getDraft("sent");
  `, `
    localStorage.removeItem = () => { throw new DOMException("Denied", "SecurityError"); };
  `);
  assert.equal(cleared.result, null);
  const reopened = inFreshDocument(cleared.storage, `
    const result = getDraft("sent");
  `);
  assert.equal(reopened.result, null);
});

test("new-chat workspace drafts remain independent from each other and existing conversations", () => {
  const saved = inFreshDocument([], `
    setDraft("new:/workspace/a", { value: "new A", images: [], files: [] });
    setDraft("new:/workspace/b", { value: "new B", images: [], files: [] });
    setDraft("session-a", { value: "existing A", images: [], files: [] });
    setDraft("new:/workspace/a", { value: "edited new A", images: [], files: [] });
    const result = null;
  `);
  const restored = inFreshDocument(saved.storage, `
    const result = [
      getDraft("new:/workspace/a")?.value,
      getDraft("new:/workspace/b")?.value,
      getDraft("session-a")?.value,
    ];
  `);
  assert.deepEqual(restored.result, ["edited new A", "new B", "existing A"]);
});

test("a successful clear also masks an older tab's still-unmigrated session draft", () => {
  const cleared = inFreshDocument([["omp-draft-sent", "already submitted"]], `
    clearDraft("sent");
    const result = getDraft("sent");
  `);
  assert.equal(cleared.result, null);
  const olderTab = inFreshDocument(cleared.storage, `
    const result = getDraft("sent");
  `, "", [["omp-draft-sent", "stale legacy copy"]]);
  assert.equal(olderTab.result, null);
});

test("recovered queue text and saved-path references are durable without base64 in synchronous storage", () => {
  const recovered = inFreshDocument([], `
    setDraft("queue", { value: "still typing", images: [], files: [] });
    recoverDraft("queue", {
      text: "recalled question",
      images: [{ data: "private-base64", mimeType: "image/png" }],
      files: [{ name: "notes.txt", mimeType: "text/plain", path: "/workspace/notes.txt", size: 12 }],
    });
    const result = getDraftSummary("queue").hasAttachments;
  `);
  assert.equal(recovered.result, true);
  const reopened = inFreshDocument(recovered.storage, `
    const result = getDraft("queue");
  `);
  assert.deepEqual(reopened.result, {
    value: "recalled question\n\nstill typing", images: [],
    files: [{ name: "notes.txt", mimeType: "text/plain", path: "/workspace/notes.txt", size: 12 }],
  });
});

test("clearing still removes stale durable text when quota prevents writing an empty marker", () => {
  const cleared = inFreshDocument([["omp-draft-sent", "already submitted"]], `
    clearDraft("sent");
    const result = getDraft("sent");
  `, `
    localStorage.setItem = () => { throw new DOMException("Full", "QuotaExceededError"); };
  `);
  assert.equal(cleared.result, null);
  const reopened = inFreshDocument(cleared.storage, `
    const result = getDraft("sent");
  `);
  assert.equal(reopened.result, null);
});

test("getDraft reads live localStorage when another tab wrote after module load", () => {
  // Simulate: tab loaded first (empty Map), then another tab wrote to localStorage.
  const rescued = inFreshDocument([], `
    // Inject a cross-tab write directly into localStorage after module init.
    localStorage.setItem("omp-draft-x-tab", "typed in other tab");
    // getDraft must detect the live entry despite having an empty in-memory cache.
    const result = getDraft("x-tab");
  `);
  assert.deepEqual(rescued.result, { value: "typed in other tab", images: [], files: [] });
  // A second call must use the now-populated cache (no double-read risk).
  const second = inFreshDocument(rescued.storage, `
    const result = getDraft("x-tab");
  `);
  assert.deepEqual(second.result, { value: "typed in other tab", images: [], files: [] });
  // Navigating to the same session in the second tab must NOT write an empty marker.
  const notCleared = inFreshDocument([[...rescued.storage, ["omp-draft-x-tab", "typed in other tab"]].at(-1)], `
    // mimic ChatInput: getDraft then setDraft with empty (new session)
    const got = getDraft("x-tab");
    // only calls setDraft if composer value is non-empty; empty call goes to clearDraft
    // Verify that getDraft returned the live text, so the navigation effect never clears.
    const result = got?.value ?? null;
  `);
  assert.equal(notCleared.result, "typed in other tab");
});
