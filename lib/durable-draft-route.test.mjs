import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tryNative: false, alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) } });
const image = { data: "aGVsbG8=", mimeType: "image/png" };
const payload = { value: "Phone draft", images: [image], files: [] };
async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-durable-route-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const route = await jiti.import("../app/api/drafts/route.ts");
  const get = (query = "key=normal", headers) => route.GET(new Request(`http://localhost/api/drafts?${query}`, { headers }));
  const put = (body, headers = {}) => route.PUT(new Request("http://localhost/api/drafts", { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }));
  const remove = query => route.DELETE(new Request(`http://localhost/api/drafts?${query}`, { method: "DELETE" }));
  try { await run({ dir, get, put, remove }); }
  finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("draft route reads, saves, lists history, restores full versions, and guards explicit cleanup", () => fixture(async ({ get, put, remove }) => {
  const empty = await get();
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).record.revision, 0);
  const saved = await put({ key: "normal", baseRevision: 0, mutationId: "save", payload });
  assert.equal(saved.status, 200);
  const record = (await saved.json()).record;
  assert.deepEqual(record.payload, { ...payload, images: [{ mimeType: image.mimeType, draftImageId: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" }] });
  const conflict = await put({ key: "normal", baseRevision: 0, mutationId: "phone", payload: { ...payload, value: "Rejected phone edit" } });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).record.revision, record.revision);
  const history = await get("key=normal&history=1");
  const versions = (await history.json()).versions;
  assert.equal(versions.length, 2);
  const rejected = await get(`key=normal&revision=${versions.find(version => version.reason === "conflict").revision}`);
  assert.equal((await rejected.json()).record.payload.value, "Rejected phone edit");
  const staleDelete = await remove("key=normal&baseRevision=0");
  assert.equal(staleDelete.status, 409);
  assert.equal((await staleDelete.json()).record.revision, record.revision);
  const removed = await remove(`key=normal&baseRevision=${record.revision}`);
  assert.equal(removed.status, 200);
  const cleanup = await removed.json();
  assert.equal(cleanup.deleted, true);
  assert.ok(cleanup.record.revision > record.revision);
  assert.equal(cleanup.record.payload, null);
  assert.equal((await (await get()).json()).record.revision, cleanup.record.revision);
  assert.equal((await get("key=normal", { "if-none-match": removed.headers.get("etag") })).status, 304);
  assert.deepEqual((await (await get("key=normal&history=1")).json()).versions, []);
}));

test("conditional GET returns 304 without hydrating image bytes, while an unconditional read exposes missing data", () => fixture(async ({ dir, get, put }) => {
  await put({ key: "normal", baseRevision: 0, mutationId: "save", payload });
  const first = await get();
  const etag = first.headers.get("etag");
  assert.ok(etag);
  assert.equal(first.headers.get("cache-control"), "private, no-cache");
  const blobs = join(dir, "omp-web", "drafts", createHash("sha256").update("normal").digest("hex"), "blobs");
  rmSync(join(blobs, readdirSync(blobs)[0]));
  const unchanged = await get("key=normal", { "if-none-match": etag });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), "");
  assert.equal(unchanged.headers.get("etag"), etag);
  assert.equal((await get("key=normal", { "if-none-match": `W/${etag}` })).status, 304);
  const broken = await get();
  assert.equal(broken.status, 500);
  assert.ok((await broken.json()).error);
}));

test("route rejects invalid JSON, malformed payloads and invalid revision query parameters", () => fixture(async ({ get, put, remove }) => {
  for (const body of ["{", "null", "[]", { key: "normal", baseRevision: 0, mutationId: "bad", payload: [] }, { key: "normal", baseRevision: "0", mutationId: "bad", payload }, { key: "normal", baseRevision: 0, payload }]) {
    assert.equal((await put(body)).status, 400);
  }
  for (const query of ["", "key=", "key=normal&revision=-1", "key=normal&revision=1.5", "key=normal&revision=NaN", "key=normal&revision=1&history=1"]) assert.equal((await get(query)).status, 400);
  assert.equal((await get("key=normal&revision=42")).status, 404);
  for (const query of ["key=normal", "key=normal&baseRevision=-1", "key=normal&baseRevision=", "key=normal&baseRevision=1e3"]) assert.equal((await remove(query)).status, 400);
}));

test("route rejects a declared oversized body without reading it and malformed UTF-8 is a client error", () => fixture(async ({ put }) => {
  const response = await put("unread", { "content-length": String(136 * 1024 * 1024) });
  assert.equal(response.status, 413);
  const route = await jiti.import("../app/api/drafts/route.ts");
  const invalidUtf8 = await route.PUT(new Request("http://localhost/api/drafts", { method: "PUT", body: new Uint8Array([0xff]), headers: { "content-type": "application/json" } }));
  assert.equal(invalidUtf8.status, 400);
}));

test("PUT photo-reference saves and409 replies carry ETags usable by the next conditional poll", () => fixture(async ({ get, put }) => {
  const initial = await put({ key: "normal", baseRevision: 0, mutationId: "initial", payload });
  const first = (await initial.json()).record;
  assert.ok(initial.headers.get("etag"));
  assert.equal((await get("key=normal", { "if-none-match": initial.headers.get("etag") })).status, 304);
  const referencePayload = { ...payload, value: "Edited text only", images: [{ mimeType: "image/png", draftImageId: first.payload.images[0].draftImageId }] };
  const edited = await put({ key: "normal", baseRevision: first.revision, mutationId: "edit", payload: referencePayload });
  assert.equal(edited.status, 200);
  const receipt = (await edited.json()).record;
  assert.equal(Object.hasOwn(receipt.payload.images[0], "data"), false);
  assert.equal(receipt.payload.images[0].draftImageId, first.payload.images[0].draftImageId);
  assert.equal((await (await get()).json()).record.payload.images[0].data, image.data);
  assert.equal((await get("key=normal", { "if-none-match": edited.headers.get("etag") })).status, 304);
  const conflict = await put({ key: "normal", baseRevision: first.revision, mutationId: "stale", payload: referencePayload });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.headers.get("etag"), edited.headers.get("etag"));
  assert.equal((await conflict.json()).record.payload.images[0].data, image.data);
  assert.equal((await get("key=normal", { "if-none-match": conflict.headers.get("etag") })).status, 304);
}));

test("six full-size offline schedule photos upload once, return compact receipts, and hydrate through GET", () => fixture(async ({ get, put }) => {
  const data = Buffer.alloc(10 * 1024 * 1024, 0x61).toString("base64");
  const images = Array.from({ length: 6 }, () => ({ mimeType: "image/png", data }));
  const draft = { prompt: "Six offline schedule photos", images, request: { body: { images: images.map((image, draftImageIndex) => ({ type: "image", mimeType: image.mimeType, draftImageIndex })) } } };
  const response = await put({ key: "six-photos", baseRevision: 0, mutationId: "initial", payload: draft });
  assert.equal(response.status, 200);
  const encodedReceipt = await response.text();
  assert.ok(encodedReceipt.length < 4096);
  const receipt = JSON.parse(encodedReceipt).record;
  assert.equal(receipt.payload.images.length, 6);
  for (const image of [...receipt.payload.images, ...receipt.payload.request.body.images]) {
    assert.equal(Object.hasOwn(image, "data"), false);
    assert.equal(Object.hasOwn(image, "draftImageIndex"), false);
    assert.equal(image.mimeType, "image/png");
    assert.match(image.draftImageId, /^[a-f0-9]{64}$/);
  }
  assert.equal((await get("key=six-photos", { "if-none-match": response.headers.get("etag") })).status, 304);
  const reloaded = await get("key=six-photos");
  assert.equal(reloaded.status, 200);
  const restored = (await reloaded.json()).record;
  assert.equal(restored.payload.images[5].data, data);
  assert.equal(restored.payload.request.body.images[5].data, data);
  assert.equal(reloaded.headers.get("etag"), response.headers.get("etag"));
}));
