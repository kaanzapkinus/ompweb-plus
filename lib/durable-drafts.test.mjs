import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { tryNative: false, alias: { "@/": root } });
const image = { data: "aGVsbG8=", mimeType: "image/png" };
const chat = (value, images = []) => ({ value, images, files: [] });
const draftDir = (dir, key) => join(dir, "omp-web", "drafts", createHash("sha256").update(key).digest("hex"));
const semanticPayload = value => JSON.parse(JSON.stringify(value, (key, child) => key === "draftImageId" ? undefined : child));

async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-durable-draft-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try { await run(await jiti.import("./durable-drafts.ts"), dir); }
  finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

function childSave(dir, mutationId, value, ready = () => {}) {
  return new Promise((resolve, reject) => {
    const source = `const { createJiti } = require('jiti'); const jiti = createJiti(${JSON.stringify(join(root, "package.json"))});
      (async () => { const m = await jiti.import(${JSON.stringify(join(root, "lib/durable-drafts.ts"))});
        process.send?.({ ready: true });
        try { const record = await m.saveDurableDraft({ key: 'race', baseRevision: 0, mutationId: process.argv[1], payload: { value: process.argv[2], images: [], files: [] } }); console.log(JSON.stringify({record})); }
        catch (error) { if (!error.record) throw error; console.log(JSON.stringify({ conflict: true, record: error.record })); }
      })().catch(error => { console.error(error); process.exitCode = 1; });`;
    const child = spawn(process.execPath, ["-e", source, mutationId, value], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: dir }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", value => { stdout += value; });
    child.stderr.on("data", value => { stderr += value; });
    child.on("message", message => { if (message.ready) ready(); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `Child exited ${code}`)));
  });
}

test("drafts reopen after a module restart with private content-addressed images, not inline metadata", () => fixture(async (m, dir) => {
  const payload = { ...chat("Keep this photo", [image, image]), files: [{ name: "notes.pdf", mimeType: "application/pdf", size: 7, path: "/workspace/notes.pdf" }] };
  const saved = await m.saveDurableDraft({ key: "../../normal:phone", baseRevision: 0, mutationId: "first", payload });
  assert.equal(saved.revision, 1);
  const folder = draftDir(dir, "../../normal:phone");
  for (const name of readdirSync(folder, { recursive: true }).filter(name => name.endsWith(".json"))) {
    assert.ok(!readFileSync(join(folder, name), "utf8").includes(image.data), "base64 must not live in draft metadata/history");
  }
  const blobs = readdirSync(join(folder, "blobs"));
  assert.equal(blobs.length, 1, "equal photos share their draft-owned content blob");
  assert.equal(readFileSync(join(folder, "blobs", blobs[0]), "utf8"), "hello");
  if (process.platform !== "win32") {
    assert.equal(statSync(folder).mode & 0o777, 0o700);
    assert.equal(statSync(join(folder, "metadata.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(folder, "blobs", blobs[0])).mode & 0o777, 0o600);
  }
  const restarted = createJiti(import.meta.url, { moduleCache: false })("./durable-drafts.ts");
  assert.deepEqual(semanticPayload((await restarted.readDurableDraft("../../normal:phone")).payload), payload);
  assert.equal((await restarted.readDurableDraft("unknown")).revision, 0);
  assert.equal((await restarted.readDurableDraft("unknown")).payload, null);
  assert.equal(existsSync(join(dir, "normal:phone")), false);
}));

test("schedule images and the original nested request attachments survive restart unchanged", () => fixture(async (m) => {
  const payload = {
    prompt: "Scheduled photo", model: { provider: "p", modelId: "m" }, timingMode: "relative", resetKey: "", delayHours: "3", delayMinutes: "0", date: "",
    images: [image], files: [{ name: "file.txt", path: "/workspace/file.txt", mimeType: "text/plain", size: 4 }], imageKeys: ["photo-1"],
    request: { signature: '["Scheduled photo","relative",180,"p","m"]', body: { prompt: "Scheduled photo", provider: "p", modelId: "m", requestId: "a".repeat(32), runAt: 12345, images: [{ type: "image", ...image }] } },
  };
  await m.saveDurableDraft({ key: "schedule", baseRevision: 0, mutationId: "schedule-save", payload });
  const restarted = createJiti(import.meta.url, { moduleCache: false })("./durable-drafts.ts");
  assert.deepEqual(semanticPayload((await restarted.readDurableDraft("schedule")).payload), payload);
}));

test("stale writes retain a recoverable conflict checkpoint and cannot overwrite the active draft", () => fixture(async (m) => {
  const first = await m.saveDurableDraft({ key: "one", baseRevision: 0, mutationId: "winner", payload: chat("On desktop") });
  await assert.rejects(m.saveDurableDraft({ key: "one", baseRevision: 0, mutationId: "loser", payload: chat("On phone", [image]) }), error => error instanceof m.DraftConflictError && error.record.revision === first.revision && error.record.payload.value === "On desktop");
  assert.equal((await m.readDurableDraft("one")).payload.value, "On desktop");
  const history = await m.listDurableDraftHistory("one");
  assert.equal(history.length, 2);
  const conflict = history.find(version => version.reason === "conflict");
  assert.ok(conflict.preview.includes("On phone"));
  const rejected = await m.readDurableDraft("one", conflict.revision);
  assert.deepEqual(semanticPayload(rejected.payload), chat("On phone", [image]));
  await assert.rejects(m.saveDurableDraft({ key: "one", baseRevision: 0, mutationId: "loser", payload: chat("On phone", [image]) }), m.DraftConflictError);
  assert.equal((await m.listDurableDraftHistory("one")).length, 2, "retrying a rejected mutation must not duplicate the checkpoint");
  const restored = await m.saveDurableDraft({ key: "one", baseRevision: first.revision, mutationId: "restore", payload: rejected.payload });
  assert.ok(restored.revision > conflict.revision);
  assert.equal(restored.payload.value, "On phone");
}));

test("idempotent successful retries return the original receipt without reviving content after a clear", () => fixture(async (m) => {
  const request = { key: "one", baseRevision: 0, mutationId: "save", payload: chat("Do not lose", [image]) };
  const first = await m.saveDurableDraft(request);
  assert.deepEqual(await m.saveDurableDraft(request), first);
  const cleared = await m.saveDurableDraft({ key: "one", baseRevision: first.revision, mutationId: "clear", payload: null });
  assert.equal(cleared.payload, null);
  assert.deepEqual(await m.saveDurableDraft(request), first);
  assert.equal((await m.readDurableDraft("one")).payload, null);
  assert.deepEqual(semanticPayload((await m.readDurableDraft("one", first.revision)).payload), request.payload);
  assert.deepEqual((await m.listDurableDraftHistory("one")).map(version => version.reason), ["clear", "save"]);
  await assert.rejects(m.saveDurableDraft({ ...request, payload: chat("Reused ID") }), error => error.status === 400);
  await assert.rejects(m.saveDurableDraft({ key: "one", baseRevision: first.revision, mutationId: "stale-clear", payload: null }), m.DraftConflictError);
}));

test("two independent processes cannot both commit the same starting revision", () => fixture(async (m, dir) => {
  const outcomes = await Promise.all([childSave(dir, "desktop", "Desktop text"), childSave(dir, "phone", "Phone text")]);
  assert.equal(outcomes.filter(result => !result.conflict).length, 1);
  assert.equal(outcomes.filter(result => result.conflict).length, 1);
  const current = await m.readDurableDraft("race");
  const winning = outcomes.find(result => !result.conflict);
  assert.equal(current.payload.value, winning.record.payload.value);
  const history = await m.listDurableDraftHistory("race");
  assert.equal(history.length, 2);
  const conflict = await m.readDurableDraft("race", history.find(version => version.reason === "conflict").revision);
  assert.notEqual(conflict.payload.value, current.payload.value);
}));

test("explicit revision-guarded cleanup removes only the chosen draft's owned files", () => fixture(async (m, dir) => {
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const document = join(workspace, "keep.txt");
  writeFileSync(document, "workspace content");
  const payload = { ...chat("One", [image]), files: [{ name: "keep.txt", path: document, mimeType: "text/plain", size: 17 }] };
  const saved = await m.saveDurableDraft({ key: "one", baseRevision: 0, mutationId: "save-one", payload });
  await m.saveDurableDraft({ key: "two", baseRevision: 0, mutationId: "save-two", payload: chat("Two", [image]) });
  await assert.rejects(m.deleteDurableDraft("one", 0), m.DraftConflictError);
  assert.deepEqual(semanticPayload((await m.readDurableDraft("one")).payload), payload);
  const cleared = await m.deleteDurableDraft("one", saved.revision);
  assert.ok(cleared.revision > saved.revision);
  assert.equal(cleared.payload, null);
  assert.equal(existsSync(join(draftDir(dir, "one"), "blobs")), false);
  assert.equal(existsSync(join(draftDir(dir, "one"), "checkpoints")), false);
  assert.equal(existsSync(join(draftDir(dir, "one"), "receipts")), false);
  assert.equal((await m.readDurableDraft("one")).payload, null);
  assert.deepEqual(await m.listDurableDraftHistory("one"), []);
  assert.deepEqual(semanticPayload((await m.readDurableDraft("two")).payload.images), [image]);
  assert.equal(readFileSync(document, "utf8"), "workspace content");
}));

test("corrupt metadata or missing/corrupt image bytes fail visibly without replacing retained content", () => fixture(async (m, dir) => {
  await m.saveDurableDraft({ key: "broken", baseRevision: 0, mutationId: "first", payload: chat("Keep", [image]) });
  const folder = draftDir(dir, "broken");
  const metadata = join(folder, "metadata.json");
  const original = readFileSync(metadata, "utf8");
  writeFileSync(metadata, "{broken");
  await assert.rejects(m.readDurableDraft("broken"), error => error.status === 500);
  await assert.rejects(m.saveDurableDraft({ key: "broken", baseRevision: 1, mutationId: "replace", payload: chat("New") }), error => error.status === 500);
  assert.equal(readFileSync(metadata, "utf8"), "{broken");
  writeFileSync(metadata, original);
  const blob = join(folder, "blobs", readdirSync(join(folder, "blobs"))[0]);
  writeFileSync(blob, "jello");
  await assert.rejects(m.readDurableDraft("broken"), error => error.status === 500);
  rmSync(blob);
  await assert.rejects(m.readDurableDraft("broken"), error => error.status === 500);
  await assert.rejects(m.saveDurableDraft({ key: "broken", baseRevision: 1, mutationId: "clear", payload: null }), error => error.status === 500);
  assert.equal(readFileSync(metadata, "utf8"), original);
}));

test("a substituted storage symlink cannot turn explicit cleanup into workspace deletion", () => fixture(async (m, dir) => {
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "keep.txt"), "keep");
  const folder = draftDir(dir, "linked");
  mkdirSync(join(dir, "omp-web", "drafts"), { recursive: true });
  symlinkSync(workspace, folder, "dir");
  await assert.rejects(m.deleteDurableDraft("linked", 0), error => error.status === 500);
  assert.equal(lstatSync(folder).isSymbolicLink(), true);
  assert.equal(readFileSync(join(workspace, "keep.txt"), "utf8"), "keep");
}));

test("invalid shapes, image budgets, reserved references, keys and revisions are rejected before persistence", () => fixture(async (m, dir) => {
  const invalid = [[], "text", { images: "bad" }, { images: [{ data: "invalid", mimeType: "image/png" }] }, { images: [{ data: image.data, mimeType: "text/plain" }] }, { images: Array.from({ length: 11 }, () => image) }, { request: { body: { images: [{ data: "", mimeType: "image/png" }] } } }, { $durableDraftImage: { hash: "a".repeat(64), bytes: 5 } }];
  for (const payload of invalid) await assert.rejects(m.saveDurableDraft({ key: "bad", baseRevision: 0, mutationId: "bad", payload }), error => error.status === 400);
  for (const key of ["", "a".repeat(2049)]) await assert.rejects(m.readDurableDraft(key), error => error.status === 400);
  for (const baseRevision of [-1, 1.5, "0", Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(m.saveDurableDraft({ key: "bad", baseRevision, mutationId: "bad", payload: null }), error => error.status === 400);
  await assert.rejects(m.saveDurableDraft({ key: "bad", baseRevision: 0, mutationId: "", payload: null }), error => error.status === 400);
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");
  await assert.rejects(m.saveDurableDraft({ key: "bad", baseRevision: 0, mutationId: "large", payload: chat("", [{ data: oversized, mimeType: "image/png" }]) }), error => error.status === 400);
  assert.equal(existsSync(draftDir(dir, "bad")), false);
  const ten = Array.from({ length: 10 }, () => image);
  assert.equal((await m.saveDurableDraft({ key: "ten", baseRevision: 0, mutationId: "ten", payload: chat("", ten) })).payload.images.length, 10);
}));

test("revision zero is the empty origin rather than the currently active record", () => fixture(async (m) => {
  await m.saveDurableDraft({ key: "one", baseRevision: 0, mutationId: "first", payload: chat("Current") });
  const origin = await m.readDurableDraft("one", 0);
  assert.equal(origin.revision, 0);
  assert.equal(origin.payload, null);
}));

test("damaged active-revision metadata never silently rolls a draft back to an older checkpoint", () => fixture(async (m, dir) => {
  await m.saveDurableDraft({ key: "one", baseRevision: 0, mutationId: "first", payload: chat("Old") });
  await m.saveDurableDraft({ key: "one", baseRevision: 1, mutationId: "second", payload: chat("New") });
  const path = join(draftDir(dir, "one"), "metadata.json");
  const metadata = JSON.parse(readFileSync(path, "utf8"));
  metadata.revision = 1;
  writeFileSync(path, JSON.stringify(metadata));
  await assert.rejects(m.readDurableDraft("one"), error => error.status === 500);
  await assert.rejects(m.saveDurableDraft({ key: "one", baseRevision: 1, mutationId: "third", payload: chat("Overwrite") }), error => error.status === 500);
}));

test("live cross-process owners serialize writes and a provably dead owner's lock is recoverable", () => fixture(async (m, dir) => {
  const rootDir = join(dir, "omp-web", "drafts");
  mkdirSync(rootDir, { recursive: true });
  const lock = `${draftDir(dir, "race")}.lock`;
  const owner = `owner-${randomUUID()}`;
  mkdirSync(lock);
  writeFileSync(join(lock, owner), String(process.pid));
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  let finished = false;
  const pending = childSave(dir, "waiting", "Waiting text", ready).then(value => { finished = true; return value; });
  try {
    await Promise.race([started, pending.then(() => { throw new Error("Writer finished before announcing readiness"); })]);
    await delay(100);
    assert.equal(finished, false, "a live owner must not be stolen even when no metadata exists");
  } finally { rmSync(lock, { recursive: true, force: true }); }
  assert.equal((await pending).record.payload.value, "Waiting text");
  const dead = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.equal(dead.status, 0);
  mkdirSync(lock);
  writeFileSync(join(lock, `owner-${randomUUID()}`), String(dead.pid));
  const saved = await m.saveDurableDraft({ key: "race", baseRevision: 1, mutationId: "recover", payload: chat("Recovered") });
  assert.equal(saved.payload.value, "Recovered");
  assert.equal(existsSync(lock), false);
}));

test("an interrupted empty lock release does not prevent later saves or cleanup", () => fixture(async (m, dir) => {
  const first = await m.saveDurableDraft({ key: "empty-lock", baseRevision: 0, mutationId: "first", payload: chat("Retained before interruption") });
  const lock = `${draftDir(dir, "empty-lock")}.lock`;
  mkdirSync(lock);
  const saved = await m.saveDurableDraft({ key: "empty-lock", baseRevision: first.revision, mutationId: "after-release", payload: chat("Saved after interrupted release") });
  assert.equal((await m.readDurableDraft("empty-lock")).payload.value, "Saved after interrupted release");
  mkdirSync(lock);
  const cleared = await m.deleteDurableDraft("empty-lock", saved.revision);
  assert.equal(cleared.payload, null);
  assert.ok(cleared.revision > saved.revision);
  assert.equal(existsSync(lock), false);
}));

test("all ten full-size 10MiB images remain valid and reopen without shrinking the attachment budget", () => fixture(async (m) => {
  const data = Buffer.alloc(10 * 1024 * 1024, 0x61).toString("base64");
  const images = Array.from({ length: 10 }, () => ({ data, mimeType: "image/png" }));
  await m.saveDurableDraft({ key: "full-budget", baseRevision: 0, mutationId: "full", payload: chat("", images) });
  const reopened = await m.readDurableDraft("full-budget");
  assert.equal(reopened.payload.images.length, 10);
  assert.equal(Buffer.from(reopened.payload.images[9].data, "base64").length, 10 * 1024 * 1024);
}));

test("known same-draft photo references save repeatedly without raw data and preserve raw/reference idempotency", () => fixture(async (m, dir) => {
  const initial = await m.saveDurableDraft({ key: "refs", baseRevision: 0, mutationId: "initial", payload: chat("Photo", [image]) });
  const id = initial.payload.images[0].draftImageId;
  assert.match(id, /^[a-f0-9]{64}$/);
  const reference = { mimeType: "image/png", draftImageId: id };
  const request = { key: "refs", baseRevision: initial.revision, mutationId: "edit", payload: chat("Text edit", [reference]) };
  const edited = await m.saveDurableDraft(request);
  assert.equal(edited.payload.images[0].data, image.data);
  assert.equal(edited.payload.images[0].draftImageId, id);
  assert.deepEqual(await m.saveDurableDraft({ ...request, payload: chat("Text edit", [image]) }), edited);
  const again = await m.saveDurableDraft({ key: "refs", baseRevision: edited.revision, mutationId: "again", payload: chat("Another edit", [reference]) });
  assert.equal(again.payload.images[0].data, image.data);
  assert.equal(readdirSync(join(draftDir(dir, "refs"), "blobs")).length, 1);
  await assert.rejects(m.saveDurableDraft({ key: "other", baseRevision: 0, mutationId: "cross-key", payload: chat("Must not borrow", [reference]) }), error => error.status === 400);
  await assert.rejects(m.saveDurableDraft({ key: "refs", baseRevision: again.revision, mutationId: "mismatch", payload: chat("Bad ID", [{ ...image, draftImageId: "a".repeat(64) }]) }), error => error.status === 400);
  const folder = join(draftDir(dir, "refs"), "blobs");
  writeFileSync(join(folder, readdirSync(folder)[0]), "jello");
  await assert.rejects(m.saveDurableDraft({ key: "refs", baseRevision: again.revision, mutationId: "damaged", payload: chat("Broken ref", [reference]) }), error => error.status === 500);
}));

test("nested schedule request references hydrate with their original attachment fields", () => fixture(async (m) => {
  const initial = await m.saveDurableDraft({ key: "schedule-ref", baseRevision: 0, mutationId: "initial", payload: { prompt: "Photo", images: [image], request: { body: { images: [{ type: "image", ...image }] } } } });
  const draftImageId = initial.payload.images[0].draftImageId;
  const next = await m.saveDurableDraft({ key: "schedule-ref", baseRevision: initial.revision, mutationId: "text-edit", payload: { prompt: "Edited", images: [{ mimeType: "image/png", draftImageId }], request: { body: { images: [{ type: "image", mimeType: "image/png", draftImageId }] } } } });
  assert.deepEqual(semanticPayload(next.payload.request.body.images), [{ type: "image", ...image }]);
}));

test("polling and autosave do not reopen old checkpoint payloads", (t) => fixture(async (m, dir) => {
  await m.saveDurableDraft({ key: "bounded", baseRevision: 0, mutationId: "old", payload: chat("Historic-only payload") });
  const folder = draftDir(dir, "bounded");
  const historicalFiles = new Set(readdirSync(folder, { recursive: true }).filter(name => name.endsWith(".json") && readFileSync(join(folder, name), "utf8").includes("Historic-only payload")).map(name => join(folder, name)));
  await m.saveDurableDraft({ key: "bounded", baseRevision: 1, mutationId: "active", payload: chat("Active") });
  const original = fs.readFileSync;
  const guard = t.mock.method(fs, "readFileSync", (path, ...args) => {
    if (historicalFiles.has(String(path))) throw new Error("Old payload was reopened by the autosave/poll fast path");
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await m.readDurableDraft("bounded")).payload.value, "Active");
    const result = await m.saveDurableDraft({ key: "bounded", baseRevision: 2, mutationId: "next", payload: chat("Next") });
    assert.equal(result.payload.value, "Next");
  } finally { guard.mock.restore(); syncBuiltinESMExports(); }
  assert.equal((await m.readDurableDraft("bounded", 1)).payload.value, "Historic-only payload");
}));

test("restart finishes an interrupted checkpoint/head commit once without losing mutation receipts", () => fixture(async (m, dir) => {
  await m.saveDurableDraft({ key: "recover", baseRevision: 0, mutationId: "first", payload: chat("Before") });
  const metadata = join(draftDir(dir, "recover"), "metadata.json");
  const request = { key: "recover", baseRevision: 1, mutationId: "second", payload: chat("Recovered after restart", [image]) };
  // Patch before importing the child module: Jiti snapshots native bindings.
  const source = `
    const fs = require("node:fs"), original = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (String(to) === ${JSON.stringify(metadata)}) throw Object.assign(new Error("Synthetic head commit failure"), { code: "EIO" });
      return original(from, to);
    };
    const { createJiti } = require("jiti");
    const storage = createJiti(${JSON.stringify(join(root, "package.json"))}, { tryNative: false })(${JSON.stringify(join(root, "lib/durable-drafts.ts"))});
    storage.saveDurableDraft(${JSON.stringify(request)}).then(() => process.exit(2), error => {
      if (!/Synthetic head commit failure/.test(error.message)) throw error;
      console.log("interrupted-at-head");
    });
  `;
  const child = spawnSync(process.execPath, ["-e", source], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: dir }, encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /interrupted-at-head/);
  const restarted = createJiti(import.meta.url, { moduleCache: false, tryNative: false })("./durable-drafts.ts");
  const recovered = await restarted.readDurableDraft("recover");
  assert.equal(recovered.payload.value, "Recovered after restart");
  assert.equal(recovered.payload.images[0].data, image.data);
  assert.deepEqual(await restarted.saveDurableDraft(request), recovered);
  assert.equal((await restarted.listDurableDraftHistory("recover")).length, 2);
}));

test("explicit cleanup preserves a monotonic CAS tombstone across restart and recreation", () => fixture(async (m) => {
  const first = await m.saveDurableDraft({ key: "aba", baseRevision: 0, mutationId: "first", payload: chat("Deleted generation", [image]) });
  const tombstone = await m.deleteDurableDraft("aba", first.revision);
  assert.ok(tombstone.revision > first.revision);
  assert.equal(tombstone.payload, null);
  assert.deepEqual(await m.listDurableDraftHistory("aba"), []);
  const restarted = createJiti(import.meta.url, { moduleCache: false, tryNative: false })("./durable-drafts.ts");
  assert.deepEqual(await restarted.readDurableDraft("aba"), tombstone);
  const recreated = await restarted.saveDurableDraft({ key: "aba", baseRevision: tombstone.revision, mutationId: "recreate", payload: chat("New generation") });
  assert.ok(recreated.revision > tombstone.revision);
  await assert.rejects(restarted.saveDurableDraft({ key: "aba", baseRevision: first.revision, mutationId: "offline-old", payload: chat("Must conflict") }), error => error instanceof m.DraftConflictError || error.record?.revision === recreated.revision);
  await assert.rejects(restarted.deleteDurableDraft("aba", first.revision), error => error.record?.revision === recreated.revision);
  assert.equal((await restarted.readDurableDraft("aba")).payload.value, "New generation");
  await assert.rejects(restarted.readDurableDraft("aba", first.revision), error => error.status === 404);
  const history = await restarted.listDurableDraftHistory("aba");
  assert.deepEqual(history.map(version => version.reason), ["conflict", "save"]);
}));

test("failure before the first head is published leaves the key readable and retryable", () => fixture(async (m, dir) => {
  const source = `
    const fs = require("node:fs"), original = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (String(to).endsWith("/metadata.json")) throw Object.assign(new Error("Synthetic first head failure"), { code: "EIO" });
      return original(from, to);
    };
    const { createJiti } = require("jiti");
    const storage = createJiti(${JSON.stringify(join(root, "package.json"))}, { tryNative: false })(${JSON.stringify(join(root, "lib/durable-drafts.ts"))});
    storage.saveDurableDraft({ key: "first-failure", baseRevision: 0, mutationId: "retry", payload: { value: "Kept locally", images: [], files: [] } }).then(() => process.exit(2), error => {
      if (!/Synthetic first head failure/.test(error.message)) throw error;
      console.log("failed-before-publish");
    });
  `;
  const child = spawnSync(process.execPath, ["-e", source], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: dir }, encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /failed-before-publish/);
  assert.equal((await m.readDurableDraft("first-failure")).revision, 0);
  const saved = await m.saveDurableDraft({ key: "first-failure", baseRevision: 0, mutationId: "retry", payload: chat("Kept locally") });
  assert.equal(saved.payload.value, "Kept locally");
  assert.equal((await m.listDurableDraftHistory("first-failure")).length, 1);
}));

test("same-payload image indices are property-order-independent and raw-equivalent for idempotency", () => fixture(async (m) => {
  const indexed = { request: { body: { images: [{ type: "image", mimeType: "image/png", draftImageIndex: 0 }] } }, images: [image], prompt: "Offline schedule" };
  const request = { key: "indexed", baseRevision: 0, mutationId: "initial", payload: indexed };
  const saved = await m.saveDurableDraft(request);
  assert.equal(saved.payload.request.body.images[0].data, image.data);
  assert.equal(Object.hasOwn(saved.payload.request.body.images[0], "draftImageIndex"), false);
  assert.deepEqual(await m.saveDurableDraft({ ...request, payload: { ...indexed, request: { body: { images: [{ type: "image", ...image }] } } } }), saved);
  const known = saved.payload.images[0].draftImageId;
  const changed = await m.saveDurableDraft({ key: "indexed", baseRevision: saved.revision, mutationId: "known", payload: { ...indexed, images: [{ mimeType: "image/png", draftImageId: known }] } });
  assert.equal(changed.payload.request.body.images[0].data, image.data);
  for (const patch of [{ draftImageIndex: -1 }, { draftImageIndex: 1 }, { draftImageIndex: 0.5 }, { draftImageIndex: "0" }, { draftImageIndex: 0, mimeType: "image/jpeg" }, { draftImageIndex: 0, data: image.data }]) {
    await assert.rejects(m.saveDurableDraft({ key: "invalid-index", baseRevision: 0, mutationId: "bad", payload: { images: [image], request: { body: { images: [{ mimeType: "image/png", ...patch }] } } } }), error => error.status === 400);
  }
  await assert.rejects(m.saveDurableDraft({ key: "cyclic-index", baseRevision: 0, mutationId: "bad", payload: { images: [{ mimeType: "image/png", draftImageIndex: 0 }] } }), error => error.status === 400);
}));

test("six full-size offline schedule photos fit the existing body ceiling with nested same-payload indices", () => fixture(async (m) => {
  const data = Buffer.alloc(10 * 1024 * 1024, 0x61).toString("base64");
  const images = Array.from({ length: 6 }, () => ({ mimeType: "image/png", data }));
  const payload = { prompt: "Six offline photos", images, request: { body: { images: images.map((image, draftImageIndex) => ({ type: "image", mimeType: image.mimeType, draftImageIndex })) } } };
  assert.ok(Buffer.byteLength(JSON.stringify({ key: "large-index", baseRevision: 0, mutationId: "save", payload })) < 135 * 1024 * 1024);
  const saved = await m.saveDurableDraft({ key: "large-index", baseRevision: 0, mutationId: "save", payload });
  assert.equal(saved.payload.request.body.images.length, 6);
  assert.equal(Buffer.from(saved.payload.request.body.images[5].data, "base64").length, 10 * 1024 * 1024);
}));

test("restart finishes journaled explicit cleanup after orphan payload removal fails", () => fixture(async (m, dir) => {
  const saved = await m.saveDurableDraft({ key: "cleanup-restart", baseRevision: 0, mutationId: "saved", payload: chat("Explicitly removed", [image]) });
  const blobs = join(draftDir(dir, "cleanup-restart"), "blobs");
  const orphan = join(draftDir(dir, "cleanup-restart"), `.tmp-123-${randomUUID()}`);
  writeFileSync(orphan, JSON.stringify({ payload: chat("Interrupted checkpoint secret"), document: "/workspace/original.txt" }));
  const source = `
    const fs = require("node:fs"), original = fs.rmSync;
    fs.rmSync = (path, ...args) => {
      if (String(path) === ${JSON.stringify(orphan)}) throw Object.assign(new Error("Synthetic cleanup failure"), { code: "EIO" });
      return original(path, ...args);
    };
    const { createJiti } = require("jiti");
    const storage = createJiti(${JSON.stringify(join(root, "package.json"))}, { tryNative: false })(${JSON.stringify(join(root, "lib/durable-drafts.ts"))});
    storage.deleteDurableDraft("cleanup-restart", ${saved.revision}).then(() => process.exit(2), error => {
      if (!/Synthetic cleanup failure/.test(error.message)) throw error;
      console.log("cleanup-interrupted");
    });
  `;
  const child = spawnSync(process.execPath, ["-e", source], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: dir }, encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /cleanup-interrupted/);
  assert.equal(existsSync(orphan), true);
  assert.equal(existsSync(join(draftDir(dir, "cleanup-restart"), "cleanup.json")), true);
  const after = await m.readDurableDraft("cleanup-restart");
  assert.equal(after.payload, null);
  assert.ok(after.revision > saved.revision);
  assert.deepEqual(await m.listDurableDraftHistory("cleanup-restart"), []);
  assert.equal(existsSync(blobs), false);
  assert.equal(existsSync(orphan), false);
  assert.deepEqual(readdirSync(draftDir(dir, "cleanup-restart")), ["metadata.json"]);
}));

test("reference-only PUT receipts omit photo bytes while direct reads, defaults, and conflicts hydrate them", () => fixture(async (m) => {
  const request = { key: "lean-receipt", baseRevision: 0, mutationId: "initial", payload: { ...chat("Initial", [image]), request: { body: { images: [{ mimeType: "image/png", draftImageIndex: 0 }] } } } };
  const lean = await m.saveDurableDraft(request, false);
  assert.equal(Object.hasOwn(lean.payload.images[0], "data"), false);
  assert.equal(Object.hasOwn(lean.payload.request.body.images[0], "data"), false);
  assert.equal(lean.payload.images[0].mimeType, image.mimeType);
  assert.match(lean.payload.images[0].draftImageId, /^[a-f0-9]{64}$/);
  assert.deepEqual(await m.saveDurableDraft(request, false), lean);
  const full = await m.readDurableDraft(request.key);
  assert.equal(full.payload.images[0].data, image.data);
  assert.equal(full.payload.request.body.images[0].data, image.data);
  assert.equal(m.durableDraftRecordEtag(lean), m.durableDraftRecordEtag(full));
  assert.deepEqual(await m.saveDurableDraft(request), full);
  await assert.rejects(m.saveDurableDraft({ ...request, mutationId: "stale" }, false), error => error.record?.payload?.images?.[0]?.data === image.data);
}));

test("explicit cleanup removes orphan plaintext and symlinks without following workspace paths and retains CAS after restart", () => fixture(async (m, dir) => {
  const workspace = join(dir, "original-workspace");
  mkdirSync(workspace);
  const document = join(workspace, "original.txt");
  writeFileSync(document, "Never delete the original document");
  const saved = await m.saveDurableDraft({ key: "orphan-cleanup", baseRevision: 0, mutationId: "save", payload: { ...chat("Saved secret"), files: [{ path: document }] } });
  const folder = draftDir(dir, "orphan-cleanup");
  const orphan = join(folder, `.tmp-123-${randomUUID()}`);
  writeFileSync(orphan, JSON.stringify({ payload: { value: "Orphan checkpoint secret", files: [{ path: document }] } }));
  const abandoned = join(folder, "abandoned-payloads");
  mkdirSync(abandoned);
  writeFileSync(join(abandoned, "plaintext.json"), JSON.stringify({ document, secret: "Abandoned secret" }));
  symlinkSync(workspace, join(folder, "workspace-link"), "dir");
  const tombstone = await m.deleteDurableDraft("orphan-cleanup", saved.revision);
  assert.equal(existsSync(orphan), false);
  assert.equal(existsSync(abandoned), false);
  assert.deepEqual(readdirSync(folder), ["metadata.json"]);
  assert.equal(readFileSync(document, "utf8"), "Never delete the original document");
  const restarted = createJiti(import.meta.url, { moduleCache: false, tryNative: false })("./durable-drafts.ts");
  assert.deepEqual(await restarted.readDurableDraft("orphan-cleanup"), tombstone);
  assert.ok(tombstone.revision > saved.revision);
  assert.deepEqual(await restarted.listDurableDraftHistory("orphan-cleanup"), []);
  const recreated = await restarted.saveDurableDraft({ key: "orphan-cleanup", baseRevision: tombstone.revision, mutationId: "recreate", payload: chat("New content") });
  assert.ok(recreated.revision > tombstone.revision);
  await assert.rejects(restarted.deleteDurableDraft("orphan-cleanup", saved.revision), error => error.record?.revision === recreated.revision);
}));
