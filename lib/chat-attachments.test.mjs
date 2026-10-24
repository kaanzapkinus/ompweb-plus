import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { composeMessageWithFileAttachments, uploadAttachmentFile, MAX_ATTACHED_FILE_BYTES, MAX_ATTACHED_FILES } = await jiti.import("./chat-attachments.ts");

test("prompts carry exact quoted paths and require full faithful inspection without embedding contents", () => {
  const path = '/workspace/a "quoted"\nfile.docx';
  const prompt = composeMessageWithFileAttachments("  Inspect this  ", [{ name: "file.docx", path, mimeType: "application/octet-stream", size: 10 }]);
  assert.ok(prompt.startsWith("Inspect this\n\n"));
  assert.ok(prompt.includes(JSON.stringify(path)));
  assert.ok(prompt.includes("Read each attached file in full at its exact path"));
  assert.ok(prompt.includes("unsupported format, truncation, or otherwise"));
  assert.equal(composeMessageWithFileAttachments(" unchanged ", []), " unchanged ");
});

test("uploads original DOCX and arbitrary binary bytes without reading document text", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const bytes = new Uint8Array([0x50, 0x4b, 0, 0xff, 0x80, 13, 10]);
  for (const [name, type] of [["document.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"], ["raw.bin", "application/octet-stream"], ["source.ts", "text/plain"]]) {
    const file = new File([bytes], name, { type });
    file.text = () => { throw new Error("Document contents must not be decoded"); };
    const controller = new AbortController();
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "/api/files/work%20space?type=upload&conflict=error");
      assert.equal(options.method, "POST");
      assert.equal(options.signal, controller.signal);
      const parts = options.body.getAll("files");
      assert.equal(parts.length, 1);
      assert.equal(parts[0].name, name);
      assert.deepEqual(new Uint8Array(await parts[0].arrayBuffer()), bytes);
      return Response.json({ uploaded: [name] });
    };
    const saved = await uploadAttachmentFile(file, "/work space", controller.signal);
    assert.deepEqual(saved, { name, mimeType: type, path: `/work space/${name}`, size: bytes.length });
    assert.equal("content" in saved, false);
  }
});

test("enforces 10 MiB per file before uploading and requires a workspace", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  let uploads = 0;
  globalThis.fetch = async () => { uploads++; return Response.json({ uploaded: ["max.bin"] }); };
  assert.equal(MAX_ATTACHED_FILES, 10);
  assert.equal(MAX_ATTACHED_FILE_BYTES, 10 * 1024 * 1024);
  await assert.rejects(uploadAttachmentFile({ name: "too-big", size: MAX_ATTACHED_FILE_BYTES + 1 }, "/workspace"), /10 MiB/);
  await assert.rejects(uploadAttachmentFile({ name: "no-workspace", size: 1 }, ""), /workspace/);
  assert.equal(uploads, 0);
  await uploadAttachmentFile(new File([new Uint8Array(MAX_ATTACHED_FILE_BYTES)], "max.bin"), "/workspace");
  assert.equal(uploads, 1);
});

test("surfaces conflicts, partial failures, missing confirmations, and network failures", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const file = new File(["bytes"], "notes.txt");
  for (const [response, message] of [
    [Response.json({ error: "conflict" }, { status: 409 }), /already exists/],
    [Response.json({ error: "denied" }, { status: 403 }), /denied/],
    [Response.json({ uploaded: [], errors: [{ name: file.name, error: "disk full" }] }), /disk full/],
    [Response.json({ uploaded: [] }), /did not confirm/],
  ]) {
    globalThis.fetch = async () => response;
    await assert.rejects(uploadAttachmentFile(file, "/workspace"), message);
  }
  globalThis.fetch = async () => { throw new TypeError("offline"); };
  await assert.rejects(uploadAttachmentFile(file, "/workspace"), /network connection/);
});
