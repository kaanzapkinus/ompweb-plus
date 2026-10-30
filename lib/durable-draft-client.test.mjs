import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Only browser persistence and HTTP are doubled; each child is a fresh document.
// Retaining both stores across children exercises reload, not module memory.
function document(action, seed = {}) {
  const script = `
    import { createJiti } from "jiti";
    import { createHash } from "node:crypto";
    const seed = JSON.parse(process.env.DRAFT_FIXTURE);
    const storage = new Map(seed.storage ?? []);
    const database = new Map(seed.database ?? []);
    const versions = seed.versions ?? [];
    let record = seed.record ?? { key: "chat", revision: 0, payload: null, updatedAt: "" };
    let online = seed.online !== false;
    const browserStorage = {
      get length() { return storage.size; }, key: i => [...storage.keys()][i] ?? null,
      getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    };
    globalThis.localStorage = browserStorage;
    globalThis.sessionStorage = { ...browserStorage, getItem: () => null, removeItem() {} };
    globalThis.window = new EventTarget();
    window.localStorage = browserStorage;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { get onLine() { return online; } } });
    let releasePhotoReads;
    const photoReadGate = seed.delayPhotoReads ? new Promise(resolve => { releasePhotoReads = resolve; }) : null;
    let photoWrites = 0;
    const connections = [];
    let databaseCloses = 0, databaseOpenAttempts = 0;
    globalThis.indexedDB = {
      open() {
        const attempt = ++databaseOpenAttempts;
        const request = {};
        setTimeout(() => {
          request.result = {
            objectStoreNames: { contains: () => true }, close() { databaseCloses++; },
            transaction(names) {
              let pending = 0, aborted = false;
              const transaction = {
                abort() { aborted = true; queueMicrotask(() => transaction.onabort?.()); },
                objectStore(name = Array.isArray(names) ? names[0] : names) {
                  const prefix = name + "|";
                  const operation = (work, photoRead = false) => {
                    const request = {}; pending++;
                    setTimeout(async () => {
                      if (aborted) return;
                      if (photoRead && photoReadGate) await photoReadGate;
                      if (photoRead && seed.failPhotoReads) {
                        request.error = new Error("Photo cache read denied");
                        request.onerror?.();
                      } else {
                        request.result = structuredClone(work());
                        request.onsuccess?.();
                      }
                      if (--pending === 0 && !aborted) transaction.oncomplete?.();
                    }, 0);
                    return request;
                  };
                  return {
                    get: key => operation(() => database.get(prefix + key) ?? (name === "drafts" ? database.get(key) : undefined), name === "images"),
                    getKey: key => operation(() => database.has(prefix + key) ? key : undefined),
                    getAll: () => operation(() => [...database].filter(([key, value]) => key.startsWith(prefix) || (name === "drafts" && !key.includes("|") && value?.key)).map(([, value]) => value)),
                    put: (value, key) => operation(() => {
                      if (name === "images") photoWrites++;
                      database.set(prefix + (key ?? value.key), structuredClone(value));
                    }),
                    delete: key => operation(() => { database.delete(prefix + key); }),
                  };
                },
              };
              return transaction;
            },
          };
          connections.push(request.result);
          if (seed.errorFirstOpen && attempt === 1) {
            request.error = new Error("Photo cache open failed");
            request.onerror?.();
            return;
          }
          if (seed.blockedFirstOpen && attempt === 1) {
            request.onblocked?.();
            setTimeout(() => request.onsuccess?.(), 10);
          } else request.onsuccess?.();
        }, 0);
        return request;
      },
    };
    if (seed.blockedIndexedDB) globalThis.indexedDB = {
      open() {
        const request = { error: new Error("IndexedDB denied") };
        setTimeout(() => request.onerror?.(), 0);
        return request;
      },
    };
    const calls = [];
    const gets = [];
    let holdGet = null;
    let holdPut = null;
    let holdDelete = null;
    let losePutResponse = false;
    let notModified = 0;
    const applied = new Map();
    const bodies = [];
    const blobs = new Map();
    function imageFields(payload, map) {
      if (!payload) return payload;
      const result = { ...payload };
      if (Array.isArray(payload.images)) result.images = payload.images.map(map);
      if (payload.request?.body?.images) result.request = { ...payload.request, body: { ...payload.request.body, images: payload.request.body.images.map(map) } };
      return result;
    }
    function wire(value, minimal = false) {
      return { ...value, payload: imageFields(value.payload, image => {
        const draftImageId = createHash("sha256").update(image.data).digest("hex");
        blobs.set(draftImageId, image.data);
        return { ...image, mimeType: minimal && seed.mismatchedPutMime ? "image/jpeg" : image.mimeType, data: seed.brokenImageResponses || minimal ? undefined : image.data, draftImageId };
      }) };
    }
    function expand(payload) {
      return imageFields(payload, image => {
        const { draftImageId, draftImageIndex, ...fields } = image;
        const source = Number.isInteger(draftImageIndex) ? payload.images?.[draftImageIndex] : undefined;
        const data = image.data ?? blobs.get(draftImageId) ?? source?.data ?? blobs.get(source?.draftImageId);
        if (typeof data !== "string") throw new Error("Referenced image is not available in this draft");
        return { ...fields, data };
      });
    }
    globalThis.fetch = async (url, options = {}) => {
      if (!online) throw new TypeError("offline");
      const parsed = new URL(url, "http://draft.test");
      assert.equal(parsed.pathname, "/api/drafts");
      const method = options.method ?? "GET";
      calls.push(method);
      if (method === "GET") {
        gets.push({ revision: parsed.searchParams.get("revision"), conditional: Boolean(options.headers?.["If-None-Match"]) });
        if (holdGet) await holdGet;
        if (parsed.searchParams.has("history")) return Response.json({ versions: versions.map(({ payload, ...v }) => v) });
        const revision = parsed.searchParams.get("revision");
        const etag = '"test-' + record.revision + '"';
        if (revision === null && options.headers?.["If-None-Match"] === etag) {
          notModified++; return new Response(null, { status: 304, headers: { ETag: etag } });
        }
        const selected = revision === null || Number(revision) === record.revision ? record : { ...versions.find(v => v.revision === Number(revision)), key: record.key };
        return Response.json({ record: wire(structuredClone(selected)) }, { headers: { ETag: etag } });
      }
      if (method === "DELETE") {
        if (holdDelete) await holdDelete;
        if (Number(parsed.searchParams.get("baseRevision")) !== record.revision) return Response.json({ record, error: "conflict" }, { status: 409 });
        record = { key: record.key, revision: record.revision + 1, payload: null, updatedAt: "2026-10-29T00:00:00Z" };
        versions.splice(0);
        blobs.clear(); applied.clear();
        return Response.json({ deleted: true, record });
      }
      assert.equal(method, "PUT", "clearing must never delete checkpoints");
      const mutation = JSON.parse(options.body);
      bodies.push(structuredClone(mutation));
      if (seed.rejectPut) return Response.json({ error: "Invalid draft settings" }, { status: 400 });
      try { mutation.payload = expand(mutation.payload); }
      catch (error) {
        if (error.message === "Referenced image is not available in this draft") return Response.json({ error: error.message }, { status: 400 });
        throw error;
      }
      if (holdPut) await holdPut;
      if (applied.has(mutation.mutationId)) return Response.json({ record: wire(applied.get(mutation.mutationId), seed.minimalPut) });
      if (mutation.baseRevision !== record.revision) {
        versions.push({ revision: versions.length + 100, reason: "conflict", payload: mutation.payload, updatedAt: "2026-10-29T00:00:00Z", preview: mutation.payload?.value ?? mutation.payload?.prompt ?? "" });
        return Response.json({ record: wire(record), error: "conflict" }, { status: 409 });
      }
      record = { key: mutation.key, revision: record.revision + 1, payload: mutation.payload, updatedAt: "2026-10-29T00:00:00Z" };
      versions.push({ ...record, reason: mutation.payload === null ? "clear" : "save", preview: mutation.payload?.value ?? mutation.payload?.prompt ?? "" });
      applied.set(mutation.mutationId, structuredClone(record));
      if (losePutResponse) { losePutResponse = false; throw new TypeError("response lost"); }
      return Response.json({ record: wire(record, seed.minimalPut) }, { headers: { ETag: '"test-' + record.revision + '"' } });
    };
    import assert from "node:assert/strict";
    const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
    const client = await jiti.import(${JSON.stringify(new URL("./durable-draft-client.ts", import.meta.url).pathname)});
    const normal = await jiti.import(${JSON.stringify(new URL("./draft-store.ts", import.meta.url).pathname)});
    const schedule = await jiti.import(${JSON.stringify(new URL("./schedule-draft.ts", import.meta.url).pathname)});
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async condition => { for (let i = 0; i < 250; i++) { if (condition()) return; await sleep(10); } throw new Error("draft condition timed out: " + JSON.stringify(client.getDraftSyncState(record.key))); };
    const draft = value => ({ value, images: [], files: [] });
    ${action}
    await sleep(20);
    console.log(JSON.stringify({ result, storage: [...storage], database: [...database], record, versions, calls }));
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 15_000,
    env: { ...process.env, DRAFT_FIXTURE: JSON.stringify(seed) },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout);
}

test("offline photos and text survive a fresh document without base64 in synchronous storage", () => {
  const saved = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    client.saveRemoteDraft("chat", { ...draft("Offline"), images: [{ data: "private-photo-bytes", mimeType: "image/png" }] });
    await sleep(80);
    const result = client.getDraftSyncState("chat").status;
    assert.equal(result, "offline");
    stop();
  `, { online: false });
  assert.equal(JSON.stringify(saved.storage).includes("private-photo-bytes"), false);
  assert.equal(JSON.stringify(saved.database).includes("private-photo-bytes"), true);
  const reopened = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.readRemoteDraft("chat")?.payload?.images?.length === 1);
    assert.equal(client.readRemoteDraft("chat").payload.value, "Offline");
    assert.equal(client.getDraftSyncState("chat").status, "offline");
    online = true; window.dispatchEvent(new Event("online"));
    await until(() => client.getDraftSyncState("chat").status === "saved");
    const result = record.payload;
    stop();
  `, { ...saved, online: false });
  assert.deepEqual(reopened.result, { value: "Offline", images: [{ data: "private-photo-bytes", mimeType: "image/png" }], files: [] });
});

test("edits before hydration conflict rather than replacing another device's draft", () => {
  const result = document(`
    let release; holdGet = new Promise(resolve => { release = resolve; });
    const stop = client.subscribeDraftSync("chat", () => {});
    client.saveRemoteDraft("chat", draft("Typed before hydration"));
    release();
    await until(() => client.getDraftSyncState("chat").status === "conflict");
    const result = { local: client.readRemoteDraft("chat").payload.value, remote: record.payload.value, conflict: versions.some(v => v.reason === "conflict" && v.payload.value === "Typed before hydration") };
    stop();
  `, { record: { key: "chat", revision: 4, updatedAt: "2026-10-29T00:00:00Z", payload: { value: "Other device", images: [], files: [] } } });
  assert.deepEqual(result.result, { local: "Typed before hydration", remote: "Other device", conflict: true });
});

test("normal hydration and focus changes notify adapters without echo saves or initial empty clears", () => {
  const result = document(`
    normal.setDraft("chat", draft(""));
    let notifications = 0;
    const stop = normal.subscribeDraftChanges("chat", () => { notifications++; });
    await until(() => normal.getDraft("chat")?.value === "From phone");
    record = { ...record, revision: 3, payload: draft("From laptop") };
    window.dispatchEvent(new Event("focus"));
    await until(() => normal.getDraft("chat")?.value === "From laptop");
    const result = { value: normal.getDraft("chat").value, notifications, puts: calls.filter(c => c === "PUT").length };
    stop();
  `, { record: { key: "chat", revision: 2, updatedAt: "2026-10-29T00:00:00Z", payload: { value: "From phone", images: [], files: [] } } });
  assert.equal(result.result.value, "From laptop");
  assert.ok(result.result.notifications >= 2);
  assert.equal(result.result.puts, 0);
});

test("accepted clear preserves a queued checkpoint and refuses newer normal edits", () => {
  const result = document(`
    const stop = normal.subscribeDraftChanges("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved");
    const sent = draft("Sent before debounce");
    normal.setDraft("chat", sent);
    assert.notEqual(normal.clearDraft("chat", sent), false);
    await until(() => record.revision === 2 && client.getDraftSyncState("chat").status === "saved");
    normal.setDraft("chat", draft("New edits"));
    assert.equal(normal.clearDraft("chat", sent), false);
    const result = { active: normal.getDraft("chat").value, history: versions.map(v => [v.reason, v.payload?.value ?? null]), deleted: calls.includes("DELETE") };
    stop();
  `);
  assert.deepEqual(result.result, { active: "New edits", history: [["save", "Sent before debounce"], ["clear", null]], deleted: false });
});

test("explicit history restore checkpoints dirty displaced content and rehydrates photos", () => {
  const photo = [{ data: "restored-photo", mimeType: "image/png" }];
  const result = document(`
    const stop = normal.subscribeDraftChanges("chat", () => {});
    await until(() => normal.getDraft("chat")?.value === "Current");
    normal.setDraft("chat", draft("Unsaved displaced"));
    await client.restoreRemoteDraft("chat", 1);
    const history = await client.listRemoteDraftHistory("chat");
    const result = { draft: normal.getDraft("chat"), saved: client.getDraftSyncState("chat").status, retained: versions.some(v => v.payload?.value === "Unsaved displaced"), history: history.length };
    stop();
  `, { record: { key: "chat", revision: 2, payload: { value: "Current", images: [], files: [] }, updatedAt: "2026-10-29T00:00:00Z" }, versions: [{ revision: 1, payload: { value: "Old photo", images: photo, files: [] }, reason: "save", updatedAt: "2026-10-28T00:00:00Z", preview: "Old photo" }] });
  assert.deepEqual(result.result.draft, { value: "Old photo", images: photo, files: [] });
  assert.equal(result.result.saved, "saved");
  assert.equal(result.result.retained, true);
  assert.ok(result.result.history >= 3);
});

test("schedule hydration retains request images, settings and image references", () => {
  const image = { data: "schedule-photo", mimeType: "image/png" };
  const key = 'omp-web:schedule-draft:["session","chat"]';
  const payload = { prompt: "Later", model: { provider: "alpha", modelId: "one" }, timingMode: "relative", resetKey: "", delayHours: "2", delayMinutes: "4", date: "", images: [image], imageKeys: ["keep-key"], thinkingLevel: "high", request: { signature: '["Later","relative",124,"alpha","one"]', body: { prompt: "Later", provider: "alpha", modelId: "one", runAt: 10, requestId: "b".repeat(32), images: [image] } } };
  const result = document(`
    const key = ${JSON.stringify(key)};
    let changes = 0;
    const stop = schedule.subscribeScheduleDraft(key, () => { changes++; });
    await until(() => schedule.readScheduleDraft(key)?.images?.length === 1);
    const restoredSchedule = schedule.readScheduleDraft(key);
    const result = { draft: restoredSchedule, changes, puts: calls.filter(c => c === "PUT").length };
    stop();
  `, { record: { key, revision: 1, payload, updatedAt: "2026-10-29T00:00:00Z" } });
  assert.deepEqual(result.result.draft, payload);
  assert.ok(result.result.changes >= 1);
  assert.equal(result.result.puts, 0);
  assert.equal(JSON.stringify(result.storage).includes("schedule-photo"), false);
});

test("a stale second client keeps its offline edits when another client wins", () => {
  const hydrated = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved");
    const result = null; stop();
  `, { record: { key: "chat", revision: 1, payload: { value: "Initial", images: [], files: [] }, updatedAt: "2026-10-29T00:00:00Z" } });
  const first = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved");
    client.saveRemoteDraft("chat", draft("Winner"));
    await until(() => record.revision === 2 && client.getDraftSyncState("chat").status === "saved");
    const result = null; stop();
  `, hydrated);
  const second = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    client.saveRemoteDraft("chat", draft("Offline competitor"));
    await until(() => client.getDraftSyncState("chat").status === "conflict");
    const result = { local: client.readRemoteDraft("chat").payload.value, remote: record.payload.value, retained: versions.some(v => v.reason === "conflict" && v.payload?.value === "Offline competitor") };
    stop();
  `, { ...hydrated, record: first.record, versions: first.versions });
  assert.deepEqual(second.result, { local: "Offline competitor", remote: "Winner", retained: true });
});

test("explicit local conflict resolution saves the chosen version after retaining both competitors", () => {
  const result = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    client.saveRemoteDraft("chat", draft("My version"));
    await until(() => client.getDraftSyncState("chat").status === "conflict");
    await client.resolveRemoteDraftConflict("chat", "local");
    const result = { value: record.payload.value, status: client.getDraftSyncState("chat").status, retained: versions.some(v => v.reason === "conflict" && v.payload?.value === "My version") };
    stop();
  `, { record: { key: "chat", revision: 2, payload: { value: "Server version", images: [], files: [] }, updatedAt: "2026-10-29T00:00:00Z" } });
  assert.deepEqual(result.result, { value: "My version", status: "saved", retained: true });
});

test("explicit server conflict resolution keeps rejected local content in history", () => {
  const result = document(`
    const stop = normal.subscribeDraftChanges("chat", () => {});
    normal.setDraft("chat", draft("My rejected version"));
    await until(() => client.getDraftSyncState("chat").status === "conflict");
    await client.resolveRemoteDraftConflict("chat", "server");
    const result = { value: normal.getDraft("chat").value, status: client.getDraftSyncState("chat").status, retained: versions.some(v => v.payload?.value === "My rejected version") };
    stop();
  `, { record: { key: "chat", revision: 2, payload: { value: "Server version", images: [], files: [] }, updatedAt: "2026-10-29T00:00:00Z" } });
  assert.deepEqual(result.result, { value: "Server version", status: "saved", retained: true });
});

test("conditional focus polling skips unchanged photo hydration and follows explicit remote deletion", () => {
  const result = document(`
    const stop = normal.subscribeDraftChanges("chat", () => {});
    await until(() => normal.getDraft("chat")?.value === "Saved");
    window.dispatchEvent(new Event("focus"));
    await until(() => notModified > 0);
    record = { key: "chat", revision: 0, payload: null, updatedAt: "" };
    window.dispatchEvent(new Event("focus"));
    await until(() => normal.getDraft("chat") === null);
    const result = { unchanged: notModified, puts: calls.filter(c => c === "PUT").length };
    stop();
  `, { record: { key: "chat", revision: 7, payload: { value: "Saved", images: [{ data: "photo", mimeType: "image/png" }], files: [] }, updatedAt: "2026-10-29T00:00:00Z" } });
  assert.ok(result.result.unchanged >= 1);
  assert.equal(result.result.puts, 0);
});

test("a lost save response retries its mutation without duplicate checkpoints", () => {
  const result = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved");
    losePutResponse = true;
    client.saveRemoteDraft("chat", draft("Exactly once"));
    await until(() => client.getDraftSyncState("chat").status === "offline");
    window.dispatchEvent(new Event("focus"));
    await until(() => client.getDraftSyncState("chat").status === "saved");
    const result = { value: record.payload.value, checkpoints: versions.length, conflicts: versions.filter(v => v.reason === "conflict").length };
    stop();
  `);
  assert.deepEqual(result.result, { value: "Exactly once", checkpoints: 1, conflicts: 0 });
});

test("text edits during photo-cache opening preserve both old and newly added photos", () => {
  const saved = document(`
    client.saveRemoteDraft("chat", { ...draft("Old"), images: [{ data: "old-photo", mimeType: "image/png" }] });
    await sleep(80);
    const result = null;
  `, { online: false });
  const reopened = document(`
    const stop = normal.subscribeDraftChanges("chat", () => {});
    normal.setDraft("chat", { ...draft("Edited before cache"), images: [{ data: "new-photo", mimeType: "image/png" }] });
    await until(() => normal.getDraft("chat")?.images?.length === 2);
    const result = normal.getDraft("chat");
    stop();
  `, { ...saved, online: false });
  assert.equal(reopened.result.value, "Edited before cache");
  assert.deepEqual(reopened.result.images.map(image => image.data), ["old-photo", "new-photo"]);
});

test("explicit cleanup is revision guarded and clears adapter photos only after success", () => {
  const result = document(`
    const stop = normal.subscribeDraftChanges("chat", () => {});
    await until(() => normal.getDraft("chat")?.images?.length === 1);
    await client.deleteRemoteDraft("chat");
    const result = { draft: normal.getDraft("chat"), history: versions.length, status: client.getDraftSyncState("chat").status };
    stop();
  `, { record: { key: "chat", revision: 3, payload: { value: "Remove", images: [{ data: "private-cleanup-photo", mimeType: "image/png" }], files: [] }, updatedAt: "2026-10-29T00:00:00Z" }, versions: [{ revision: 3, reason: "save", preview: "Remove", updatedAt: "", payload: { value: "Remove" } }] });
  assert.deepEqual(result.result, { draft: null, history: 0, status: "saved" });
  assert.equal(JSON.stringify(result.database).includes("private-cleanup-photo"), false);
});

test("cleanup refused after another device changes the revision retains local data", () => {
  const result = document(`
    const stop = normal.subscribeDraftChanges("chat", () => {});
    await until(() => normal.getDraft("chat")?.value === "Retain");
    let release; holdDelete = new Promise(resolve => { release = resolve; });
    const deleting = client.deleteRemoteDraft("chat");
    await until(() => calls.includes("DELETE"));
    record = { ...record, revision: 4, payload: draft("Other device") };
    release();
    await assert.rejects(deleting, /changed/);
    const result = { draft: normal.getDraft("chat").value, remote: record.payload.value };
    stop();
  `, { record: { key: "chat", revision: 3, payload: { value: "Retain", images: [], files: [] }, updatedAt: "2026-10-29T00:00:00Z" } });
  assert.deepEqual(result.result, { draft: "Retain", remote: "Other device" });
});

test("acknowledged images use reference-only autosaves while a newly added image uploads once", () => {
  const result = document(`
    const stop = normal.subscribeDraftChanges("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved");
    const photo = { data: "first-photo-bytes", mimeType: "image/png" };
    normal.setDraft("chat", { ...draft("First"), images: [photo] });
    await until(() => record.revision === 1 && client.getDraftSyncState("chat").status === "saved");
    normal.setDraft("chat", { ...draft("Typed again"), images: [photo] });
    await until(() => record.revision === 2 && client.getDraftSyncState("chat").status === "saved");
    const next = { data: "new-photo-bytes", mimeType: "image/jpeg" };
    normal.setDraft("chat", { ...draft("Added photo"), images: [photo, next] });
    await until(() => record.revision === 3 && client.getDraftSyncState("chat").status === "saved");
    const result = { images: bodies.map(body => body.payload.images), draft: normal.getDraft("chat") };
    stop();
  `);
  assert.equal(result.result.images[0][0].data, "first-photo-bytes");
  assert.equal("data" in result.result.images[1][0], false);
  assert.match(result.result.images[1][0].draftImageId, /^[a-f0-9]{64}$/);
  assert.equal("data" in result.result.images[2][0], false);
  assert.equal(result.result.images[2][1].data, "new-photo-bytes");
  assert.equal(result.result.draft.images[0].data, "first-photo-bytes");
  assert.equal("draftImageId" in result.result.draft.images[0], false);
});

test("scheduled request and editable photos reuse hydrated image references without changing semantic drafts", () => {
  const image = { data: "schedule-existing-photo", mimeType: "image/png" };
  const key = 'omp-web:schedule-draft:["session","refs"]';
  const payload = { prompt: "Later", model: { provider: "alpha", modelId: "one" }, timingMode: "relative", resetKey: "", delayHours: "2", delayMinutes: "4", date: "", images: [image], imageKeys: ["keep"], request: { signature: '["Later","relative",124,"alpha","one"]', body: { prompt: "Later", provider: "alpha", modelId: "one", runAt: 10, requestId: "d".repeat(32), images: [image] } } };
  const result = document(`
    const key = ${JSON.stringify(key)};
    const stop = schedule.subscribeScheduleDraft(key, () => {});
    await until(() => schedule.readScheduleDraft(key)?.images?.length === 1);
    const loaded = schedule.readScheduleDraft(key);
    assert.equal("draftImageId" in loaded.images[0], false);
    schedule.writeScheduleDraft(key, { ...loaded, prompt: "Edited later" });
    await until(() => record.revision === 2 && client.getDraftSyncState(key).status === "saved");
    const result = bodies[0].payload;
    stop();
  `, { record: { key, revision: 1, payload, updatedAt: "2026-10-29T00:00:00Z" } });
  assert.equal("data" in result.result.images[0], false);
  assert.equal("data" in result.result.request.body.images[0], false);
  assert.equal(result.result.images[0].draftImageId, result.result.request.body.images[0].draftImageId);
  assert.deepEqual(result.result.imageKeys, ["keep"]);
});

test("the final unsubscribe removes polling and focus/online activity", () => {
  const result = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved");
    stop();
    const before = calls.length;
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    await sleep(30);
    const result = calls.length - before;
  `);
  assert.equal(result.result, 0);
});

test("restoring history retains queued accepted-send and newer draft checkpoints", () => {
  const anchor = { value: "Anchor", images: [], files: [] };
  const result = document(`
    const stop = normal.subscribeDraftChanges("chat", () => {});
    await until(() => normal.getDraft("chat")?.value === "Anchor");
    const sent = draft("Sent while offline queue pending");
    normal.setDraft("chat", sent);
    normal.clearDraft("chat", sent);
    normal.setDraft("chat", draft("New unsent content"));
    await client.restoreRemoteDraft("chat", 1);
    const result = { active: normal.getDraft("chat").value, retained: versions.filter(v => v.reason === "conflict").map(v => v.payload?.value ?? null) };
    stop();
  `, { record: { key: "chat", revision: 1, payload: anchor, updatedAt: "2026-10-29T00:00:00Z" }, versions: [{ revision: 1, reason: "save", preview: "Anchor", updatedAt: "2026-10-29T00:00:00Z", payload: anchor }] });
  assert.equal(result.result.active, "Anchor");
  assert.ok(result.result.retained.includes("Sent while offline queue pending"));
  assert.ok(result.result.retained.includes("New unsent content"));
});

test("a malformed hydrated photo reports an error instead of installing a text-only draft", () => {
  const result = document(`
    const stop = normal.subscribeDraftChanges("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "error");
    const result = { error: client.getDraftSyncState("chat").error, installed: normal.getDraft("chat") };
    stop();
  `, { brokenImageResponses: true, record: { key: "chat", revision: 2, payload: { value: "Must keep photo", images: [{ data: "photo-bytes", mimeType: "image/png" }], files: [] }, updatedAt: "2026-10-29T00:00:00Z" } });
  assert.match(result.result.error, /photo/i);
  assert.equal(result.result.installed, null);
});

test("editing and accepting a conflicted photo draft retains its queue until explicit resolution", () => {
  const result = document(`
    const stop = normal.subscribeDraftChanges("chat", () => {});
    normal.setDraft("chat", draft("First conflicting edit"));
    await until(() => client.getDraftSyncState("chat").status === "conflict");
    const accepted = { ...draft("Accepted while conflicted"), images: [{ data: "conflicted-photo", mimeType: "image/png" }] };
    normal.setDraft("chat", accepted);
    normal.clearDraft("chat", accepted);
    const before = calls.filter(c => c === "PUT").length;
    await sleep(550);
    assert.equal(client.getDraftSyncState("chat").status, "conflict");
    assert.equal(calls.filter(c => c === "PUT").length, before, "editing cannot silently rebase a conflict");
    await client.resolveRemoteDraftConflict("chat", "server");
    const result = { active: normal.getDraft("chat").value, retainedPhoto: versions.some(v => v.payload?.images?.[0]?.data === "conflicted-photo") };
    stop();
  `, { record: { key: "chat", revision: 3, payload: { value: "Other device stays", images: [], files: [] }, updatedAt: "2026-10-29T00:00:00Z" } });
  assert.deepEqual(result.result, { active: "Other device stays", retainedPhoto: true });
});

test("new text after explicit cleanup saves against the monotonic tombstone", () => {
  const result = document(`
    const stop = normal.subscribeDraftChanges("chat", () => {});
    await until(() => normal.getDraft("chat")?.value === "Delete old content");
    await client.deleteRemoteDraft("chat");
    normal.setDraft("chat", draft("New after cleanup"));
    await until(() => ["saved", "conflict"].includes(client.getDraftSyncState("chat").status));
    const result = { active: record.payload?.value, local: normal.getDraft("chat")?.value, status: client.getDraftSyncState("chat").status };
    stop();
  `, { record: { key: "chat", revision: 7, payload: { value: "Delete old content", images: [], files: [] }, updatedAt: "2026-10-29T00:00:00Z" } });
  assert.deepEqual(result.result, { active: "New after cleanup", local: "New after cleanup", status: "saved" });
});

test("offline schedule request recovery uploads new photo bytes only once per payload", () => {
  const result = document(`
    const key = 'omp-web:schedule-draft:["session","chat"]';
    const image = { data: "offline-photo-bytes", mimeType: "image/png" };
    const payload = { prompt: "Offline schedule", model: { provider: "alpha", modelId: "one" }, timingMode: "relative", resetKey: "", delayHours: "2", delayMinutes: "0", date: "", images: [image], imageKeys: ["offline-photo"], request: { signature: JSON.stringify(["Offline schedule", "relative", 120, "alpha", "one"]), body: { prompt: "Offline schedule", provider: "alpha", modelId: "one", runAt: 10, requestId: "e".repeat(32), images: [image] } } };
    schedule.writeScheduleDraft(key, payload);
    await sleep(80);
    online = true;
    window.dispatchEvent(new Event("online"));
    const stop = schedule.subscribeScheduleDraft(key, () => {});
    await until(() => bodies.length === 1 && client.getDraftSyncState(key).status === "saved");
    const result = { rawOccurrences: JSON.stringify(bodies[0]).split("offline-photo-bytes").length - 1, storedImage: record.payload.request.body.images[0], restored: schedule.readScheduleDraft(key) };
    stop();
  `, { online: false });
  assert.equal(result.result.rawOccurrences, 1, "a retained request cannot double the 100MiB image upload budget");
  assert.equal(result.result.storedImage.data, "offline-photo-bytes");
  assert.equal(result.result.restored.images[0].data, "offline-photo-bytes");
  assert.equal(result.result.restored.request.body.images[0].data, "offline-photo-bytes");
});

test("competing offline document journals both survive closing and reopen as an explicit CAS conflict", () => {
  const initial = { key: "chat", revision: 1, payload: { value: "Shared base", images: [], files: [] }, updatedAt: "2026-10-29T00:00:00Z" };
  const a = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved");
    online = false; window.dispatchEvent(new Event("offline"));
    client.saveRemoteDraft("chat", draft("Offline writer A"));
    await sleep(100);
    const result = null; stop();
  `, { record: initial });
  const b = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    client.saveRemoteDraft("chat", draft("Offline writer B"));
    await sleep(100);
    const result = null; stop();
  `, { ...a, online: false });
  const reopened = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "conflict");
    const result = { retained: versions.map(version => version.payload?.value), active: record.payload?.value, local: client.readRemoteDraft("chat").payload?.value };
    stop();
  `, { ...b, online: true });
  assert.ok(reopened.result.retained.includes("Offline writer A"));
  assert.ok(reopened.result.retained.includes("Offline writer B"));
  assert.ok(["Offline writer A", "Offline writer B"].includes(reopened.result.active));
});

test("photo cache hydration readiness blocks text-only reads until all referenced bytes arrive", () => {
  const saved = document(`
    client.saveRemoteDraft("chat", { ...draft("Keep photo"), images: [{ data: "readiness-photo", mimeType: "image/png" }] });
    await sleep(100);
    const result = null;
  `, { online: false });
  const reopened = document(`
    const stop = normal.subscribeDraftChanges("chat", () => {});
    assert.equal(client.hasPendingDraftImages("chat"), true);
    assert.equal(normal.getDraft("chat").images.length, 0);
    releasePhotoReads();
    await until(() => !client.hasPendingDraftImages("chat"));
    const result = normal.getDraft("chat").images[0].data;
    stop();
  `, { ...saved, online: false, delayPhotoReads: true });
  assert.equal(reopened.result, "readiness-photo");
  const failed = document(`
    const stop = normal.subscribeDraftChanges("chat", () => {});
    await sleep(100);
    const result = { pending: client.hasPendingDraftImages("chat"), error: client.getDraftSyncState("chat").error };
    stop();
  `, { ...saved, online: false, failPhotoReads: true });
  assert.equal(failed.result.pending, true);
  assert.match(failed.result.error, /photo/i);
});

test("unchanged photo bytes are written once while draft and request metadata remain reference-only", () => {
  const result = document(`
    const photo = { data: "immutable-local-photo", mimeType: "image/png" };
    const payload = { ...draft("First"), images: [photo], request: { body: { images: [photo] } } };
    client.saveRemoteDraft("chat", payload);
    await sleep(80);
    for (let index = 0; index < 30; index++) client.saveRemoteDraft("chat", { ...payload, value: "Typing " + index });
    await sleep(150);
    const metadata = [...database].filter(([key]) => !key.startsWith("images|"));
    const result = { photoWrites, metadataHasBytes: JSON.stringify(metadata).includes("immutable-local-photo"), value: client.readRemoteDraft("chat").payload.value };
  `, { online: false });
  assert.deepEqual(result.result, { photoWrites: 1, metadataHasBytes: false, value: "Typing 29" });
});

test("reference-only save receipts hydrate the exact pending normal and request photos without another download", () => {
  const result = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved");
    const photo = { data: "receipt-photo", mimeType: "image/png" };
    client.saveRemoteDraft("chat", { ...draft("Initial receipt"), images: [photo], request: { body: { images: [photo] } } });
    await until(() => client.getDraftSyncState("chat").status === "saved" && record.revision === 1);
    client.saveRemoteDraft("chat", { ...client.readRemoteDraft("chat").payload, value: "Text only" });
    await until(() => client.getDraftSyncState("chat").status === "saved" && record.revision === 2);
    const result = { payload: client.readRemoteDraft("chat").payload, secondHasBytes: JSON.stringify(bodies[1]).includes("receipt-photo"), gets: calls.filter(method => method === "GET").length };
    stop();
  `, { minimalPut: true });
  assert.equal(result.result.payload.images[0].data, "receipt-photo");
  assert.equal(result.result.payload.request.body.images[0].data, "receipt-photo");
  assert.equal(result.result.secondHasBytes, false);
  assert.equal(result.result.gets, 1);
});

test("a mismatched minimal receipt cannot mark pending photos saved", () => {
  const result = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved");
    client.saveRemoteDraft("chat", { ...draft("Keep pending photo"), images: [{ data: "receipt-mismatch-photo", mimeType: "image/png" }] });
    await until(() => client.getDraftSyncState("chat").status === "error");
    const result = { state: client.getDraftSyncState("chat"), data: client.readRemoteDraft("chat").payload.images[0].data };
    stop();
  `, { minimalPut: true, mismatchedPutMime: true });
  assert.match(result.result.state.error, /photo/i);
  assert.equal(result.result.data, "receipt-mismatch-photo");
});

test("journal cleanup compares observed stamps and preserves a competing newer writer version", () => {
  const saved = document(`
    client.saveRemoteDraft("chat", draft("Before cleanup"));
    await sleep(100);
    const result = null;
  `, { online: false });
  const cleaned = document(`
    const observed = await client.snapshotLocalDraftJournals("chat");
    const [storageKey, json] = [...storage].find(([key]) => key.startsWith("omp-web:durable-draft-writer:"));
    const newer = JSON.parse(json);
    newer.stamp = "newer-unobserved-version";
    newer.payload = draft("Written during cleanup");
    newer.queue = [{ mutationId: "new-during-cleanup", baseRevision: 0, payload: newer.payload }];
    storage.set(storageKey, JSON.stringify(newer));
    database.set("journals|" + observed[0].id, structuredClone(newer));
    await client.forgetLocalDraftJournals("chat", observed);
    const result = { text: JSON.parse(storage.get(storageKey)).payload.value, durable: database.get("journals|" + observed[0].id).payload.value };
  `, { ...saved, online: false });
  assert.deepEqual(cleaned.result, { text: "Written during cleanup", durable: "Written during cleanup" });
});

test("offline text writer journals recover through localStorage when IndexedDB is denied", () => {
  const saved = document(`
    client.saveRemoteDraft("chat", draft("Text fallback remains durable"));
    await sleep(100);
    const result = null;
  `, { online: false, blockedIndexedDB: true });
  const reopened = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved");
    const result = { local: client.readRemoteDraft("chat").payload.value, server: record.payload.value };
    stop();
  `, { ...saved, online: true, blockedIndexedDB: true });
  assert.deepEqual(reopened.result, { local: "Text fallback remains durable", server: "Text fallback remains durable" });
});

test("hydrating a newly added cached photo does not resolve an unrelated legacy missing-photo marker", () => {
  const saved = document(`
    client.saveRemoteDraft("chat", { ...draft("One old photo is still missing"), missingImageCount: 1, images: [{ data: "new-known-photo", mimeType: "image/png" }] });
    await sleep(100);
    const result = null;
  `, { online: false });
  const reopened = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await sleep(100);
    const result = { missing: client.readRemoteDraft("chat").payload.missingImageCount, pending: client.hasPendingDraftImages("chat") };
    stop();
  `, { ...saved, online: false });
  assert.ok(reopened.result.missing >= 1);
  assert.equal(reopened.result.pending, true);
});

test("text-only cache reads never report pending photos before generic IndexedDB hydration finishes", () => {
  const saved = document(`
    client.saveRemoteDraft("chat", draft("Ready without a photo"));
    await sleep(100);
    const result = null;
  `, { online: false });
  const reopened = document(`
    assert.equal(client.hasPendingDraftImages("chat"), false);
    await sleep(100);
    const result = client.hasPendingDraftImages("chat");
  `, { ...saved, online: false });
  assert.equal(reopened.result, false);
});

test("metadata publication restores a referenced photo removed by another document's cleanup", () => {
  const result = document(`
    const photo = { data: "concurrent-cleanup-photo", mimeType: "image/png" };
    client.saveRemoteDraft("chat", { ...draft("Before cleanup"), images: [photo] });
    await sleep(100);
    for (const [key] of database) if (key.startsWith("images|")) database.delete(key);
    client.saveRemoteDraft("chat", { ...draft("Newer than cleanup"), images: [photo] });
    await sleep(100);
    const result = { restored: [...database].some(([key, data]) => key.startsWith("images|") && data === photo.data), photoWrites };
  `, { online: false });
  assert.deepEqual(result.result, { restored: true, photoWrites: 2 });
});

test("explicit cleanup retains shared photo bytes owned by another draft's displaced history", () => {
  const result = document(`
    const photo = { data: "shared-history-photo", mimeType: "image/png" };
    client.saveRemoteDraft("chat", { ...draft("Delete this copy"), images: [photo] });
    client.saveRemoteDraft("other", { ...draft("Other retained copy"), images: [photo] });
    await sleep(100);
    client.saveRemoteDraft("other", draft("Other draft no longer displays the photo"));
    await sleep(100);
    online = true;
    await client.deleteRemoteDraft("chat");
    const result = { bytesRemain: [...database].some(([key, data]) => key.startsWith("images|") && data === photo.data), deleted: record.payload === null };
  `, { online: false, record: { key: "chat", revision: 1, payload: { value: "Server copy", images: [], files: [] }, updatedAt: "2026-10-29T00:00:00Z" } });
  assert.deepEqual(result.result, { bytesRemain: true, deleted: true });
});

test("a late adapter subscriber receives the snapshot hydrated while its schedule dialog was closed", () => {
  const key = 'omp-web:schedule-draft:["session","late-open"]';
  const payload = { prompt: "Hydrated while closed", model: null, timingMode: "relative", resetKey: "", delayHours: "1", delayMinutes: "17", date: "", request: null, images: [{ data: "late-dialog-photo", mimeType: "image/png" }] };
  const saved = document(`
    const stop = client.subscribeDraftSync(${JSON.stringify(key)}, () => {});
    await until(() => client.getDraftSyncState(${JSON.stringify(key)}).status === "saved");
    const result = null; stop();
  `, { record: { key, revision: 1, payload, updatedAt: "" } });
  const reopened = document(`
    const key = ${JSON.stringify(key)};
    schedule.readScheduleDraft(key);
    await until(() => !client.hasPendingDraftImages(key));
    let observed;
    const stop = schedule.subscribeScheduleDraft(key, () => { observed = schedule.readScheduleDraft(key)?.images?.[0]?.data; });
    assert.equal(observed, "late-dialog-photo", "opening after hydration must not wait for a new server revision");
    const result = observed; stop();
  `, { ...saved, online: false });
  assert.equal(reopened.result, "late-dialog-photo");
});

test("a database version change closes the old connection and a blocked late success cannot leak another connection", () => {
  const result = document(`
    client.readRemoteDraft("first");
    await until(() => connections.length === 1);
    assert.equal(typeof connections[0].onversionchange, "function");
    connections[0].onversionchange();
    client.readRemoteDraft("second");
    await until(() => connections.length === 2);
    const result = databaseCloses;
  `, { online: false });
  assert.equal(result.result, 1);
  const blocked = document(`
    client.readRemoteDraft("blocked");
    await sleep(40);
    client.readRemoteDraft("fresh");
    await until(() => connections.length === 2);
    const result = databaseCloses;
  `, { online: false, blockedFirstOpen: true });
  assert.equal(blocked.result, 1);
});

test("reconnect repairs an evicted acknowledged photo without replacing queued text or original document paths", () => {
  const initial = { key: "chat", revision: 1, payload: { value: "Acknowledged", images: [{ data: "acknowledged-photo", mimeType: "image/png" }], files: [] }, updatedAt: "2026-10-29T00:00:00Z" };
  const saved = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved");
    online = false;
    client.saveRemoteDraft("chat", { ...client.readRemoteDraft("chat").payload, value: "Queued offline text", files: [{ name: "original.txt", mimeType: "text/plain", path: "/workspace/original.txt", size: 7 }] });
    await sleep(100);
    const result = null; stop();
  `, { record: initial });
  const reopened = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved" && record.revision === 2);
    const result = { payload: client.readRemoteDraft("chat").payload, server: record.payload };
    stop();
  `, { ...saved, online: true, database: saved.database.filter(([key]) => !key.startsWith("images|")) });
  assert.equal(reopened.result.payload.value, "Queued offline text");
  assert.equal(reopened.result.payload.images[0].data, "acknowledged-photo");
  assert.equal(reopened.result.payload.files[0].path, "/workspace/original.txt");
  assert.deepEqual(reopened.result.payload, reopened.result.server);
});

test("photo repair uses the acknowledged historical revision, never another device's newer photo", () => {
  const initial = { key: "chat", revision: 1, payload: { value: "Acknowledged old", images: [{ data: "old-acknowledged-photo", mimeType: "image/png" }], files: [] }, updatedAt: "" };
  const saved = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved");
    online = false;
    client.saveRemoteDraft("chat", { ...client.readRemoteDraft("chat").payload, value: "Keep my offline edit" });
    await sleep(100);
    const result = null; stop();
  `, { record: initial });
  const newer = { ...initial, revision: 2, payload: { ...initial.payload, value: "Other device", images: [{ data: "new-other-device-photo", mimeType: "image/png" }] } };
  const reopened = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "conflict");
    const result = { local: client.readRemoteDraft("chat").payload, remote: record.payload };
    stop();
  `, { ...saved, online: true, database: saved.database.filter(([key]) => !key.startsWith("images|")), record: newer, versions: [{ ...initial, reason: "save", preview: "Acknowledged old" }] });
  assert.equal(reopened.result.local.value, "Keep my offline edit");
  assert.equal(reopened.result.local.images[0].data, "old-acknowledged-photo");
  assert.equal(reopened.result.remote.images[0].data, "new-other-device-photo");
});

test("an evicted offline-only photo remains an honest error instead of borrowing acknowledged image bytes", () => {
  const saved = document(`
    client.saveRemoteDraft("chat", { ...draft("Never uploaded"), images: [{ data: "offline-only-photo", mimeType: "image/png" }] });
    await sleep(100);
    const result = null;
  `, { online: false });
  const reopened = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "error");
    const result = { pending: client.hasPendingDraftImages("chat"), puts: calls.filter(method => method === "PUT").length, text: client.readRemoteDraft("chat").payload.value };
    stop();
  `, { ...saved, online: true, database: saved.database.filter(([key]) => !key.startsWith("images|")) });
  assert.deepEqual(reopened.result, { pending: true, puts: 0, text: "Never uploaded" });
});

test("an IndexedDB open error permits a later independent open without a retry loop", () => {
  const result = document(`
    client.readRemoteDraft("failed");
    await sleep(40);
    assert.equal(databaseOpenAttempts, 1);
    client.readRemoteDraft("next");
    await until(() => databaseOpenAttempts === 2);
    await sleep(40);
    const result = databaseOpenAttempts;
  `, { online: false, errorFirstOpen: true });
  assert.equal(result.result, 2);
});

test("change subscribers receive a known snapshot but never local typing or callbacks after unsubscribe", () => {
  const result = document(`
    const syncStop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved");
    let notifications = 0;
    const stop = client.subscribeRemoteDraftChanges("chat", () => { notifications++; });
    assert.equal(notifications, 1);
    client.saveRemoteDraft("chat", draft("Local typing"));
    assert.equal(notifications, 1);
    stop();
    await until(() => client.getDraftSyncState("chat").status === "saved" && record.revision === 2);
    record = { ...record, revision: 3, payload: draft("Remote after unsubscribe") };
    window.dispatchEvent(new Event("focus"));
    await until(() => client.readRemoteDraft("chat").payload.value === "Remote after unsubscribe");
    const result = notifications; syncStop();
  `, { record: { key: "chat", revision: 1, payload: { value: "Known snapshot", images: [], files: [] }, updatedAt: "" } });
  assert.equal(result.result, 1);
});

test("failed photo reads can recover on reconnect while new schedule text settings and photos stay intact", () => {
  const key = 'omp-web:schedule-draft:["session","evicted"]';
  const payload = { prompt: "Old", timingMode: "relative", delayMinutes: "5", images: [{ data: "old-schedule-photo", mimeType: "image/png" }], request: { body: { images: [{ data: "old-schedule-photo", mimeType: "image/png" }] } } };
  const saved = document(`
    const key = ${JSON.stringify(key)};
    const stop = client.subscribeDraftSync(key, () => {});
    await until(() => client.getDraftSyncState(key).status === "saved");
    const result = null; stop();
  `, { record: { key, revision: 4, payload, updatedAt: "" } });
  const reopened = document(`
    const key = ${JSON.stringify(key)};
    const stop = client.subscribeDraftSync(key, () => {});
    await until(() => client.getDraftSyncState(key).error !== undefined);
    client.saveRemoteDraft(key, { ...client.readRemoteDraft(key).payload, prompt: "New offline prompt", delayMinutes: "47", images: [{ data: "new-schedule-photo", mimeType: "image/jpeg" }] });
    seed.failPhotoReads = false;
    online = true; window.dispatchEvent(new Event("online"));
    await until(() => client.getDraftSyncState(key).status === "saved" && record.revision === 5);
    assert.equal(gets.some(get => get.revision === "4" && !get.conditional), true);
    const result = client.readRemoteDraft(key).payload; stop();
  `, { ...saved, online: false, failPhotoReads: true, database: saved.database.filter(([name]) => !name.startsWith("images|")) });
  assert.equal(reopened.result.prompt, "New offline prompt");
  assert.equal(reopened.result.delayMinutes, "47");
  assert.deepEqual(reopened.result.images.map(image => image.data), ["old-schedule-photo", "new-schedule-photo"]);
  assert.equal(reopened.result.request.body.images[0].data, "old-schedule-photo");
});

test("an offline-only missing photo cannot be repaired from a different acknowledged baseline slot", () => {
  const saved = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved");
    online = false;
    client.saveRemoteDraft("chat", { ...draft("New unbacked photo"), images: [{ data: "never-backed-up", mimeType: "image/png" }] });
    await sleep(100);
    const result = null; stop();
  `, { record: { key: "chat", revision: 1, payload: { value: "Backed up", images: [{ data: "different-backed-up-photo", mimeType: "image/png" }], files: [] }, updatedAt: "" } });
  const reopened = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "error");
    await sleep(80);
    const result = { text: client.readRemoteDraft("chat").payload.value, pending: client.hasPendingDraftImages("chat"), puts: bodies.length }; stop();
  `, { ...saved, online: true, database: saved.database.filter(([name]) => !name.startsWith("images|")) });
  assert.deepEqual(reopened.result, { text: "New unbacked photo", pending: true, puts: 0 });
});

test("uploading marks only in-flight raw photo saves and clears on receipts conflicts and errors", () => {
  const result = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved");
    const photo = { data: "upload-state-photo", mimeType: "image/png" };
    let release; holdPut = new Promise(resolve => { release = resolve; });
    client.saveRemoteDraft("chat", { ...draft("Raw"), images: [photo] });
    assert.notEqual(client.getDraftSyncState("chat").uploading, true, "queued photos are not HTTP uploads yet");
    await until(() => bodies.length === 1);
    assert.equal(client.getDraftSyncState("chat").uploading, true);
    client.saveRemoteDraft("chat", { ...draft("Typing during upload"), images: [photo] });
    assert.equal(client.getDraftSyncState("chat").uploading, true);
    release(); holdPut = null;
    await until(() => client.getDraftSyncState("chat").status === "saved" && record.revision === 2);
    assert.notEqual(client.getDraftSyncState("chat").uploading, true);
    holdPut = new Promise(resolve => { release = resolve; });
    client.saveRemoteDraft("chat", { ...draft("References only"), images: [photo] });
    await until(() => bodies.length === 3);
    assert.notEqual(client.getDraftSyncState("chat").uploading, true);
    release(); holdPut = null;
    await until(() => client.getDraftSyncState("chat").status === "saved" && record.revision === 3);
    holdPut = new Promise(resolve => { release = resolve; });
    client.saveRemoteDraft("chat", { ...draft("Raw conflict"), images: [photo, { data: "conflicting-upload", mimeType: "image/jpeg" }] });
    await until(() => bodies.length === 4);
    assert.equal(client.getDraftSyncState("chat").uploading, true);
    record = { ...record, revision: 4, payload: draft("Other writer") };
    release(); holdPut = null;
    await until(() => client.getDraftSyncState("chat").status === "conflict");
    assert.notEqual(client.getDraftSyncState("chat").uploading, true);
    await client.resolveRemoteDraftConflict("chat", "server");
    losePutResponse = true;
    client.saveRemoteDraft("chat", { ...draft("Lost response"), images: [{ data: "failed-upload", mimeType: "image/png" }] });
    await until(() => client.getDraftSyncState("chat").status === "offline");
    const result = client.getDraftSyncState("chat").uploading === true; stop();
  `);
  assert.equal(result.result, false);
});

test("a rejected photo-read promise does not poison an offline-only journal after storage recovers", () => {
  const saved = document(`
    client.saveRemoteDraft("chat", { ...draft("Local bytes remain"), images: [{ data: "retry-local-read", mimeType: "image/png" }] });
    await sleep(100);
    const result = null;
  `, { online: false });
  const reopened = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").error !== undefined);
    seed.failPhotoReads = false;
    online = true; window.dispatchEvent(new Event("online"));
    await until(() => client.getDraftSyncState("chat").status === "saved" && record.revision === 1);
    const result = record.payload.images[0].data; stop();
  `, { ...saved, online: false, failPhotoReads: true });
  assert.equal(reopened.result, "retry-local-read");
});

test("an acknowledged photo-only cache repairs from its full exact checkpoint without conditional GET", () => {
  const saved = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved");
    const result = null; stop();
  `, { record: { key: "chat", revision: 7, payload: { value: "No queued edits", images: [{ data: "checkpoint-only-photo", mimeType: "image/png" }], files: [] }, updatedAt: "" } });
  const reopened = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => !client.hasPendingDraftImages("chat") && client.getDraftSyncState("chat").status === "saved");
    assert.equal(gets.some(get => get.revision === "7" && !get.conditional), true);
    const result = { photo: client.readRemoteDraft("chat").payload.images[0].data, puts: bodies.length }; stop();
  `, { ...saved, database: saved.database.filter(([name]) => !name.startsWith("images|")) });
  assert.deepEqual(reopened.result, { photo: "checkpoint-only-photo", puts: 0 });
});

test("repairing shared acknowledged photos preserves both independent competing writer journals", () => {
  const a = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved");
    online = false;
    client.saveRemoteDraft("chat", { ...client.readRemoteDraft("chat").payload, value: "Photo writer A" });
    await sleep(100);
    const result = null; stop();
  `, { record: { key: "chat", revision: 1, payload: { value: "Shared photo baseline", images: [{ data: "shared-acknowledged-photo", mimeType: "image/png" }], files: [] }, updatedAt: "" } });
  const b = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => !client.hasPendingDraftImages("chat"));
    client.saveRemoteDraft("chat", { ...client.readRemoteDraft("chat").payload, value: "Photo writer B" });
    await sleep(100);
    const result = null; stop();
  `, { ...a, online: false });
  const reopened = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "conflict");
    const result = versions.filter(version => ["Photo writer A", "Photo writer B"].includes(version.payload?.value)).map(version => ({ value: version.payload.value, photo: version.payload.images[0].data }));
    stop();
  `, { ...b, online: true, database: b.database.filter(([name]) => !name.startsWith("images|")) });
  assert.deepEqual(reopened.result.sort((a, b) => a.value.localeCompare(b.value)), [
    { value: "Photo writer A", photo: "shared-acknowledged-photo" },
    { value: "Photo writer B", photo: "shared-acknowledged-photo" },
  ]);
});

for (const recreated of [false, true]) {
test(`stale photo references after another device ${recreated ? "cleans up and recreates the draft" : "cleans up"} retry raw bytes with original CAS and mutation ID`, () => {
  const result = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved");
    const local = { ...client.readRemoteDraft("chat").payload, value: "Keep local photo after remote cleanup" };
    const cleanup = await fetch("/api/drafts?key=chat&baseRevision=1", { method: "DELETE" });
    assert.equal(cleanup.status, 200);
    if (${recreated}) record = { ...record, revision: 3, payload: { ...draft("Recreated by another device"), images: [{ data: "recreated-other-photo", mimeType: "image/jpeg" }] } };
    client.saveRemoteDraft("chat", local);
    await until(() => client.getDraftSyncState("chat").status === "conflict");
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].baseRevision, 1);
    assert.equal(bodies[1].baseRevision, 1);
    assert.equal(bodies[1].mutationId, bodies[0].mutationId);
    assert.equal(bodies[0].payload.images[0].data, undefined);
    assert.equal(bodies[1].payload.images[0].data, "cleaned-up-photo");
    assert.equal(gets.at(-1).conditional, false);
    assert.equal(record.revision, ${recreated ? 3 : 2});
    if (${recreated}) assert.equal(record.payload.images[0].data, "recreated-other-photo");
    else assert.equal(record.payload, null);
    const result = {
      local: client.readRemoteDraft("chat").payload,
      retained: versions.find(version => version.reason === "conflict")?.payload,
      uploading: client.getDraftSyncState("chat").uploading === true,
    }; stop();
  `, { record: { key: "chat", revision: 1, payload: { value: "Acknowledged photo", images: [{ data: "cleaned-up-photo", mimeType: "image/png" }], files: [] }, updatedAt: "" } });
  assert.equal(result.result.local.value, "Keep local photo after remote cleanup");
  assert.equal(result.result.local.images[0].data, "cleaned-up-photo");
  assert.deepEqual(result.result.retained, result.result.local);
  assert.equal(result.result.uploading, false);
});
}

test("unrelated HTTP 400 responses never trigger a raw photo retry or a server-head refresh", () => {
  const result = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved");
    const before = gets.length;
    client.saveRemoteDraft("chat", { ...client.readRemoteDraft("chat").payload, value: "Invalid settings stay local" });
    await until(() => client.getDraftSyncState("chat").status === "error");
    assert.equal(gets.length, before);
    const result = { puts: bodies.length, error: client.getDraftSyncState("chat").error, local: client.readRemoteDraft("chat").payload.value }; stop();
  `, { rejectPut: true, record: { key: "chat", revision: 1, payload: { value: "Known photo", images: [{ data: "valid-photo-ref", mimeType: "image/png" }], files: [] }, updatedAt: "" } });
  assert.deepEqual(result.result, { puts: 1, error: "Invalid draft settings", local: "Invalid settings stay local" });
});

test("a missing photo reference without an advanced head remains an error without a raw retry", () => {
  const result = document(`
    const stop = client.subscribeDraftSync("chat", () => {});
    await until(() => client.getDraftSyncState("chat").status === "saved");
    blobs.clear();
    client.saveRemoteDraft("chat", { ...client.readRemoteDraft("chat").payload, value: "Do not hide damaged storage" });
    await until(() => client.getDraftSyncState("chat").status === "error");
    const result = { puts: bodies.length, revision: record.revision, error: client.getDraftSyncState("chat").error }; stop();
  `, { record: { key: "chat", revision: 1, payload: { value: "Known photo", images: [{ data: "missing-unadvanced-photo", mimeType: "image/png" }], files: [] }, updatedAt: "" } });
  assert.deepEqual(result.result, { puts: 1, revision: 1, error: "Referenced image is not available in this draft" });
});
