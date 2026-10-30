import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { useSidebarHistory } = await jiti.import("@/hooks/useSidebarHistory");
const { clearDraft, getDraft, setDraft } = await jiti.import("@/lib/draft-store");
const previousFetch = globalThis.fetch;

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = async (_url, options) => {
    const files = options?.body instanceof FormData ? options.body.getAll("files") : [];
    return Response.json({ uploaded: files.map((file) => file.name) });
  };
});
afterEach(() => {
  cleanup();
  clearDraft("new:unassigned");
  clearDraft("draft-a");
  clearDraft("draft-b");
  localStorage.clear();
  delete window.matchMedia;
  globalThis.fetch = previousFetch;
});

function warnsOnExit() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function Guard() {
  // The actual history protocol is exercised in useSidebarHistory.test.mjs.
  // This mounts the same document guard with the real composer/draft store.
  useSidebarHistory({ active: false, ready: false, sidebarOpen: true, setSidebarOpen() {}, url: "" });
  return null;
}

test("no-key composer text survives minimization and warns on document exit until sent", async () => {
  const user = userEvent.setup();
  const sent = [];
  function Shell({ minimized = false }) {
    return React.createElement(React.Fragment, null,
      React.createElement(Guard),
      React.createElement("div", { style: { display: minimized ? "none" : undefined } },
        React.createElement(ChatInput, { onSend: (text) => sent.push(text), onAbort() {}, isStreaming: false })),
    );
  }
  const { rerender } = render(React.createElement(Shell));
  assert.equal(warnsOnExit(), false);
  await user.type(screen.getByRole("textbox"), "unsent in a new composer");
  assert.equal(warnsOnExit(), true);
  rerender(React.createElement(Shell, { minimized: true }));
  assert.equal(warnsOnExit(), true);
  assert.equal(screen.getByRole("textbox", { hidden: true }).value, "unsent in a new composer");
  rerender(React.createElement(Shell));
  await user.click(screen.getByRole("textbox"));
  await user.keyboard("{Enter}");
  assert.deepEqual(sent, ["unsent in a new composer"]);
  assert.equal(warnsOnExit(), false);
});

test("attachment-only drafts stay protected across live draft-key changes and restore without warning on internal picks", async () => {
  const user = userEvent.setup();
  const ref = React.createRef();
  const sent = [];
  function Shell({ session }) {
    return React.createElement(React.Fragment, null,
      React.createElement(Guard),
      React.createElement(ChatInput, { draftKey: session, cwd: "/workspace", ref, onSend: (text) => sent.push(text), onAbort() {}, isStreaming: false }),
    );
  }
  const { rerender } = render(React.createElement(Shell, { session: "draft-a" }));
  await act(async () => {
    ref.current.addFiles([new File(["important attachment"], "notes.txt", { type: "text/plain" })]);
  });
  await waitFor(() => assert.equal(getDraft("draft-a")?.files[0]?.path, "/workspace/notes.txt"));
  assert.equal(warnsOnExit(), true);
  rerender(React.createElement(Shell, { session: "draft-b" }));
  assert.equal(screen.getByRole("textbox").value, "");
  assert.equal(getDraft("draft-a")?.files[0]?.path, "/workspace/notes.txt");
  assert.equal(warnsOnExit(), true);
  rerender(React.createElement(Shell, { session: "draft-a" }));
  await user.click(screen.getByRole("textbox"));
  await user.keyboard("{Enter}");
  assert.ok(sent[0].includes("/workspace/notes.txt"));
  assert.ok(!sent[0].includes("important attachment"));
  assert.equal(warnsOnExit(), false);
});

for (const outcome of ["accepted", "refused", "newer old-scope edit"]) {
  test(`new-chat promotion preserves draft ownership after ${outcome}`, async () => {
    let settle;
    const pending = new Promise(resolve => { settle = resolve; });
    const chat = draftKey => React.createElement(ChatInput, {
      draftKey, onSend: () => pending, onAbort() {}, isStreaming: false,
    });
    const view = render(chat("draft-a"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Submitted workspace prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
    view.rerender(chat("draft-b"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsent new conversation text" } });
    if (outcome === "newer old-scope edit") setDraft("draft-a", { value: "Newer workspace edit", images: [], files: [] });
    await act(async () => { settle(outcome !== "refused"); });
    assert.equal(getDraft("draft-a")?.value ?? null, outcome === "accepted" ? null : outcome === "refused" ? "Submitted workspace prompt" : "Newer workspace edit");
    assert.equal(getDraft("draft-b")?.value, "Unsent new conversation text");
    assert.equal(screen.getByRole("textbox").value, "Unsent new conversation text");
  });
}

test("accepted sending clears the submitted draft after its composer unmounts", async () => {
  let settle;
  const pending = new Promise(resolve => { settle = resolve; });
  const view = render(React.createElement(ChatInput, { draftKey: "draft-a", onSend: () => pending, onAbort() {}, isStreaming: false }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Accepted before closure" } });
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
  view.unmount();
  await act(async () => { settle(true); });
  assert.equal(getDraft("draft-a"), null);
});

test("typed text autosaves immediately and stays isolated through chat switches, remounts and send", () => {
  const sent = [];
  const chat = (draftKey) => React.createElement(ChatInput, {
    draftKey, onSend: (text) => sent.push(text), onAbort() {}, isStreaming: false,
  });
  let view = render(chat("draft-a"));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "unsent A" } });
  assert.equal(localStorage.getItem("omp-draft-draft-a"), "unsent A");
  view.rerender(chat("draft-b"));
  assert.equal(screen.getByRole("textbox").value, "");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "unsent B" } });
  assert.equal(localStorage.getItem("omp-draft-draft-b"), "unsent B");
  view.rerender(chat("draft-a"));
  assert.equal(screen.getByRole("textbox").value, "unsent A");
  assert.equal(localStorage.getItem("omp-draft-draft-b"), "unsent B");
  view.unmount();
  view = render(chat("draft-b"));
  assert.equal(screen.getByRole("textbox").value, "unsent B");
  assert.deepEqual(sent, [], "saving or navigating never submits a prompt");
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", code: "Enter" });
  assert.deepEqual(sent, ["unsent B"]);
  assert.equal(getDraft("draft-b"), null);
  view.unmount();
  render(chat("draft-b"));
  assert.equal(screen.getByRole("textbox").value, "");
  assert.equal(getDraft("draft-a")?.value, "unsent A");
});

// The removed message's images, as omp returns them with `removed: true`.
const QUEUED_IMAGES = [{ data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", mimeType: "image/png" }];

for (const navigation of ["draft-key change", "unmount"]) {
  test(`queued Edit recovers the old draft after ${navigation} while cancellation is pending`, async () => {
    const oldKey = `edit-old-${navigation}`;
    const newKey = `edit-new-${navigation}`;
    const ref = React.createRef();
    let release;
    const cancellation = new Promise((resolve) => { release = resolve; });
    const queuedMessages = { steering: [], followUp: ["queued question"] };
    const chat = (draftKey) => React.createElement(ChatInput, {
      ref, draftKey, queuedMessages, isStreaming: true,
      cwd: "/workspace",
      onSend() {}, onAbort() {}, onRemoveQueuedMessage: () => cancellation,
    });
    let view = render(chat(oldKey));
    try {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "original draft" } });
      await act(async () => {
        ref.current.addFiles([new File(["keep this attachment"], "notes.txt", { type: "text/plain" })]);
      });
      const originalFiles = getDraft(oldKey).files;
      fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "draft updated while waiting" } });
      assert.equal(getDraft(oldKey).value, "draft updated while waiting", "Edit must wait for cancellation acknowledgement");

      if (navigation === "unmount") {
        view.unmount();
        view = render(chat(newKey));
      } else {
        view.rerender(chat(newKey));
      }
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "new session draft" } });
      await act(async () => {
        release(QUEUED_IMAGES);
        await cancellation;
      });
      assert.equal(screen.getByRole("textbox").value, "new session draft");
      assert.equal(getDraft(newKey).value, "new session draft");
      assert.equal(getDraft(oldKey).value, "queued question\n\ndraft updated while waiting");
      assert.deepEqual(getDraft(oldKey).files, originalFiles);
      assert.deepEqual(getDraft(oldKey).images, QUEUED_IMAGES, "the queued message's images come back with its text");

      if (navigation === "unmount") {
        view.unmount();
        view = render(chat(oldKey));
      } else {
        view.rerender(chat(oldKey));
      }
      assert.equal(screen.getByRole("textbox").value, "queued question\n\ndraft updated while waiting");
      assert.equal(getDraft(newKey).value, "new session draft", "returning to the old chat preserves the new chat's draft");
    } finally {
      view.unmount();
      clearDraft(oldKey);
      clearDraft(newKey);
    }
  });
}

for (const navigation of ["original composer", "same-key remount"]) {
  test(`queued Edit restores ${navigation} without losing batched typing or duplicating recalled text`, async () => {
    const draftKey = `edit-recovery-${navigation}`;
    const ref = React.createRef();
    let release;
    const cancellation = new Promise((resolve) => { release = resolve; });
    const chat = () => React.createElement(ChatInput, {
      ref, draftKey, queuedMessages: { steering: [], followUp: ["queued question"] }, isStreaming: true,
      cwd: "/workspace",
      onSend() {}, onAbort() {}, onRemoveQueuedMessage: () => cancellation,
    });
    let view = render(chat());
    try {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "original draft" } });
      await act(async () => {
        ref.current.addFiles([new File(["keep this attachment"], "notes.txt", { type: "text/plain" })]);
      });
      const originalFiles = getDraft(draftKey).files;
      fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
      if (navigation === "same-key remount") {
        view.unmount();
        view = render(chat());
      }
      await act(async () => {
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "typed while waiting" } });
        ref.current.insertText("and queued insertion");
        release(QUEUED_IMAGES);
        await cancellation;
      });
      const recovered = "queued question\n\ntyped while waiting and queued insertion";
      assert.equal(screen.getByRole("textbox").value, recovered);
      assert.equal(getDraft(draftKey).value, recovered);
      assert.deepEqual(getDraft(draftKey).files, originalFiles);
      assert.deepEqual(getDraft(draftKey).images, QUEUED_IMAGES, "the queued message's images come back with its text");

      fireEvent.change(screen.getByRole("textbox"), { target: { value: `${recovered}\nnext user edit` } });
      assert.equal(screen.getByRole("textbox").value, `${recovered}\nnext user edit`);
      assert.equal(getDraft(draftKey).value, `${recovered}\nnext user edit`);
      assert.deepEqual(getDraft(draftKey).files, originalFiles);
    } finally {
      view.unmount();
      clearDraft(draftKey);
    }
  });
}
