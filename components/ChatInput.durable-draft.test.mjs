import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const previousFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = previousFetch; });
test("opening an unsent conversation recovers the other device's text and photo", async () => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const image = { data: "aGk=", mimeType: "image/png" };
  globalThis.fetch = async (url) => {
    if (!String(url).startsWith("/api/drafts")) return Response.json({});
    return Response.json({ record: { key: "remote-hydration-proof", revision: 1, updatedAt: "2026-10-29T00:00:00Z", payload: { value: "Unsent on another device", images: [image], files: [] } } }, { headers: { ETag: '"1"' } });
  };
  render(React.createElement(ChatInput, { draftKey: "remote-hydration-proof", onSend() {}, onAbort() {}, isStreaming: false }));
  await waitFor(() => assert.equal(screen.getByRole("textbox").value, "Unsent on another device"));
  assert.equal(screen.getByTitle("Remove image").tagName, "BUTTON");
});

for (const running of [false, true]) {
  test(`normal draft photos must hydrate before ${running ? "queueing" : "sending"} cached text`, async () => {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    window.HTMLElement.prototype.scrollIntoView = () => {};
    const key = `pending-photos-${running}`;
    const payload = { value: "Keep the photo with this text", images: [], files: [], missingImageCount: 1 };
    window.localStorage.setItem(`omp-web:durable-draft:${key}`, JSON.stringify({
      key, payload, record: { key, revision: 1, payload, updatedAt: "" },
      queue: [], conflict: false, stamp: "waiting-for-photo-cache", needsImages: true,
    }));
    globalThis.fetch = async () => { throw new TypeError("Offline"); };
    let submitted = 0;
    render(React.createElement(ChatInput, {
      draftKey: key, onSend() { submitted++; return true; }, onAbort() {},
      onFollowUp() { submitted++; return Promise.resolve(true); }, isStreaming: running,
    }));
    const editor = screen.getByRole("textbox");
    assert.equal(editor.value, "Keep the photo with this text");
    await act(async () => { fireEvent.keyDown(editor, { key: "Enter", code: "Enter" }); });
    assert.equal(submitted, 0, "text cannot be admitted while its retained photos are unavailable");
    assert.equal(editor.value, "Keep the photo with this text");
    assert.equal(screen.getByRole("button", { name: running ? "Queue" : "Send", exact: true }).disabled, true);
    window.localStorage.removeItem(`omp-web:durable-draft:${key}`);
  });
}
