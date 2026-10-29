import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { clearDraft, getDraft, setDraft, recoverDraft } = await jiti.import("@/lib/draft-store");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const image = { data: PNG, mimeType: "image/png" };
const file = { name: "notes.txt", mimeType: "text/plain", path: "/workspace/notes.txt", size: 5 };
const empty = () => ({ value: "", images: [], files: [] });
const previousFetch = globalThis.fetch;

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  globalThis.fetch = async () => Response.json({ skills: [], files: [] });
});
afterEach(() => {
  cleanup();
  clearDraft("schedule-owner");
  clearDraft("normal-owner");
  clearDraft("new:unassigned");
  localStorage.clear();
  delete window.matchMedia;
  delete window.HTMLElement.prototype.scrollIntoView;
  globalThis.fetch = previousFetch;
});

function Composer({ initial = empty(), onSend = () => {}, onChange = () => {}, ...props }) {
  const [draft, setValue] = React.useState(initial);
  return React.createElement(ChatInput, {
    draftKey: "schedule-owner", draft, deferCommands: true, submitLabel: "Schedule", inputLabel: "Prompt",
    onDraftChange: (next) => { setValue(next); onChange(next); },
    onSend, onAbort() {}, isStreaming: false, ...props,
  });
}

for (const outcome of ["refused", "rejected"]) {
  test(`an asynchronously ${outcome} schedule retains text and every attachment`, async () => {
    let settle;
    const pending = new Promise((resolve, reject) => { settle = () => outcome === "refused" ? resolve(false) : reject(new Error("Scheduling unavailable")); });
    let current;
    const sent = [];
    render(React.createElement(Composer, {
      initial: { value: "scheduled question", images: [image], files: [file] },
      onChange: (next) => { current = next; },
      onSend: (...args) => { sent.push(args); return pending; },
    }));
    fireEvent.click(screen.getByRole("button", { name: "Schedule", exact: true }));
    assert.equal(sent.length, 1);
    assert.ok(sent[0][0].includes("/workspace/notes.txt"));
    assert.equal(sent[0][1][0].data, PNG);
    assert.equal(screen.getByRole("button", { name: "Schedule", exact: true }).disabled, true);
    await act(async () => { settle(); });
    assert.equal(screen.getByRole("textbox", { name: "Prompt" }).value, "scheduled question");
    assert.equal(document.querySelectorAll("img").length, 1);
    assert.ok(screen.getByTitle("Saved to /workspace/notes.txt"));
    assert.equal(current?.value ?? "scheduled question", "scheduled question");
    assert.equal(getDraft("schedule-owner"), null);
    assert.equal(localStorage.getItem("omp-draft-schedule-owner"), null);
  });
}

test("accepted async submission cannot clear newer text or attachment removals", async () => {
  let accept;
  let current;
  const pending = new Promise((resolve) => { accept = () => resolve(true); });
  render(React.createElement(Composer, {
    initial: { value: "original", images: [image], files: [file] },
    onSend: () => pending,
    onChange: (next) => { current = next; },
  }));
  fireEvent.click(screen.getByRole("button", { name: "Schedule", exact: true }));
  fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "newer draft" } });
  fireEvent.click(screen.getByRole("button", { name: /remove image/i }));
  await act(async () => { accept(); });
  assert.equal(screen.getByRole("textbox", { name: "Prompt" }).value, "newer draft");
  assert.deepEqual(current.images, []);
  assert.deepEqual(current.files, [file]);
});

test("attachment-only changes during async submission cannot be cleared", async () => {
  let accept;
  let current;
  const pending = new Promise((resolve) => { accept = resolve; });
  render(React.createElement(Composer, {
    initial: { value: "same text", images: [image], files: [file] },
    onSend: () => pending,
    onChange: (next) => { current = next; },
  }));
  fireEvent.click(screen.getByRole("button", { name: "Schedule", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: /remove file/i }));
  await act(async () => { accept(true); });
  assert.equal(screen.getByRole("textbox", { name: "Prompt" }).value, "same text");
  assert.deepEqual(current.files, []);
  assert.deepEqual(current.images, [image]);
});

test("accepted unchanged submission clears the parent-owned draft", async () => {
  let current;
  render(React.createElement(Composer, {
    initial: { value: "original", images: [image], files: [file] },
    onSend: async () => true,
    onChange: (next) => { current = next; },
  }));
  fireEvent.click(screen.getByRole("button", { name: "Schedule", exact: true }));
  await waitFor(() => assert.equal(screen.getByRole("textbox", { name: "Prompt" }).value, ""));
  assert.deepEqual(current, empty());
});

test("deferred /btw with attachments is scheduled, never live-dispatched", async () => {
  const sent = [];
  const commands = [];
  render(React.createElement(Composer, {
    initial: { value: "/btw investigate tomorrow", images: [image], files: [file] },
    onBuiltinCommand: async (command) => { commands.push(command); return { handled: false }; },
    onSend: (...args) => { sent.push(args); },
  }));
  fireEvent.click(screen.getByRole("button", { name: "Schedule", exact: true }));
  await waitFor(() => assert.equal(sent.length, 1));
  assert.ok(sent[0][0].startsWith("/btw investigate tomorrow"));
  assert.equal(sent[0][1][0].data, PNG);
  assert.deepEqual(commands, [], "attachments must not route through the live side-question dispatcher");
});

test("deferred attachment-free /btw never invokes a live builtin callback", async () => {
  const sent = [];
  const commands = [];
  render(React.createElement(Composer, {
    initial: { value: "/btw investigate tomorrow", images: [], files: [] },
    onBuiltinCommand: async (command) => { commands.push(command); return { handled: true }; },
    onSend: (message) => { sent.push(message); },
  }));
  fireEvent.click(screen.getByRole("button", { name: "Schedule", exact: true }));
  await waitFor(() => assert.deepEqual(sent, ["/btw investigate tomorrow"]));
  assert.deepEqual(commands, []);
});

test("deferred web commands expand as scheduled prompts with their attachments", async () => {
  const sent = [];
  render(React.createElement(Composer, {
    initial: { value: "/goal ship it", images: [image], files: [file] },
    onSend: (...args) => { sent.push(args); },
  }));
  fireEvent.click(screen.getByRole("button", { name: "Schedule", exact: true }));
  await waitFor(() => assert.equal(sent.length, 1));
  assert.ok(sent[0][0].startsWith("Work toward this goal for the rest of the session:\n\nship it\n\n"));
  assert.ok(sent[0][0].includes("/workspace/notes.txt"));
  assert.equal(sent[0][1][0].data, PNG);
});

test("local schedule commands may update configuration without scheduling a prompt", async () => {
  const sent = [];
  const commands = [];
  render(React.createElement(Composer, {
    initial: { value: "/fast on", images: [], files: [] },
    onBuiltinCommand: async (command) => { commands.push(command); return { handled: true }; },
    onSend: (message) => { sent.push(message); },
  }));
  fireEvent.click(screen.getByRole("button", { name: "Schedule", exact: true }));
  await waitFor(() => assert.equal(screen.getByRole("textbox", { name: "Prompt" }).value, ""));
  assert.deepEqual(commands, ["/fast on"]);
  assert.deepEqual(sent, []);
});

test("external updates preserve cursor on echoes and restore drafts without touching normal owners", async () => {
  setDraft("normal-owner", { value: "ordinary unsent message", images: [], files: [] });
  let retained = { value: "scheduled", images: [image], files: [file] };
  const props = () => ({ draft: retained, onDraftChange: (next) => { retained = next; }, draftKey: "normal-owner", deferCommands: true, inputLabel: "Prompt", onSend() {}, onAbort() {}, isStreaming: false });
  let view = render(React.createElement(ChatInput, props()));
  const input = screen.getByRole("textbox", { name: "Prompt" });
  fireEvent.change(input, { target: { value: "scheduled edit" } });
  input.setSelectionRange(3, 3);
  view.rerender(React.createElement(ChatInput, props()));
  assert.equal(input.selectionStart, 3);
  assert.equal(getDraft("normal-owner").value, "ordinary unsent message");
  await act(async () => { recoverDraft("normal-owner", { text: "normal recovery" }); });
  assert.equal(input.value, "scheduled edit");
  view.unmount();
  view = render(React.createElement(ChatInput, props()));
  assert.equal(screen.getByRole("textbox", { name: "Prompt" }).value, "scheduled edit");
  assert.equal(document.querySelectorAll("img").length, 1);
  retained = { value: "programmatically restored", images: [], files: [] };
  view.rerender(React.createElement(ChatInput, props()));
  assert.equal(screen.getByRole("textbox", { name: "Prompt" }).value, "programmatically restored");
  assert.equal(document.querySelectorAll("img").length, 0);
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Prompt" }), { key: "Enter" });
  assert.equal(getDraft("normal-owner").value, "normal recovery\n\nordinary unsent message");
  assert.deepEqual(retained, empty());
});

test("a pending old owner cannot clear a programmatically selected draft", async () => {
  let accept;
  const pending = new Promise((resolve) => { accept = resolve; });
  const first = { value: "owner one", images: [], files: [] };
  const second = { value: "owner two", images: [], files: [] };
  const changes = [];
  const chat = (draft, draftKey) => React.createElement(ChatInput, {
    draft, draftKey, onDraftChange: (next) => changes.push(next), deferCommands: true,
    submitLabel: "Schedule", onSend: () => pending, onAbort() {}, isStreaming: false,
  });
  const view = render(chat(first, "owner-one"));
  fireEvent.click(screen.getByRole("button", { name: "Schedule", exact: true }));
  view.rerender(chat(second, "owner-two"));
  await act(async () => { accept(true); });
  assert.equal(screen.getByRole("textbox").value, "owner two");
  assert.deepEqual(changes, []);
});

test("composer controls never submit a containing scheduling form", () => {
  let submitted = 0;
  render(React.createElement("form", { onSubmit: (event) => { event.preventDefault(); submitted++; } },
    React.createElement(Composer, { initial: { value: "draft", images: [image], files: [file] }, thinkingLevel: "high", onThinkingLevelChange() {}, model: { provider: "test", modelId: "model" } })));
  for (const button of document.querySelectorAll("button")) {
    assert.equal(button.type, "button", `${button.title || button.textContent} must not implicitly submit`);
  }
  fireEvent.click(screen.getByRole("button", { name: /remove image/i }));
  assert.equal(submitted, 0);
});

test("failed async submission after unmount restores the parent snapshot on remount", async () => {
  let reject;
  const pending = new Promise((_resolve, fail) => { reject = fail; });
  let retained = { value: "", images: [image], files: [file] };
  const chat = () => React.createElement(ChatInput, {
    draft: retained, onDraftChange: (next) => { retained = next; },
    draftKey: "schedule-owner", deferCommands: true, submitLabel: "Schedule", inputLabel: "Prompt",
    onSend: () => pending, onAbort() {}, isStreaming: false,
  });
  let view = render(chat());
  fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "saved before navigation" } });
  fireEvent.click(screen.getByRole("button", { name: "Schedule", exact: true }));
  view.unmount();
  await act(async () => { reject(new Error("offline")); });
  view = render(chat());
  assert.equal(screen.getByRole("textbox", { name: "Prompt" }).value, "saved before navigation");
  assert.equal(document.querySelectorAll("img").length, 1);
  assert.deepEqual(retained.files, [file]);
});

test("schedule composer shortcuts do not bubble to the background chat", () => {
  const background = [];
  const listener = (event) => { background.push(event.key); };
  window.addEventListener("keydown", listener);
  try {
    render(React.createElement(Composer, { initial: { value: "scheduled", images: [], files: [] } }));
    const input = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "k", ctrlKey: true });
    assert.deepEqual(background, []);
  } finally {
    window.removeEventListener("keydown", listener);
  }
});

test("external restoration and ordinary typing share textarea auto-growth", () => {
  let draft = { value: "", images: [], files: [] };
  const chat = () => React.createElement(ChatInput, {
    draft, onDraftChange: (next) => { draft = next; }, draftKey: "schedule-owner",
    deferCommands: true, inputLabel: "Prompt", onSend() {}, onAbort() {}, isStreaming: false,
  });
  const view = render(chat());
  const input = screen.getByRole("textbox", { name: "Prompt" });
  Object.defineProperty(input, "scrollHeight", { configurable: true, value: 180 });
  draft = { value: "restored\nmultiline\nprompt", images: [], files: [] };
  view.rerender(chat());
  assert.equal(input.style.height, "180px");
  Object.defineProperty(input, "scrollHeight", { configurable: true, value: 250 });
  fireEvent.change(input, { target: { value: "restored\nmultiline\nprompt\nlonger" } });
  assert.equal(input.style.height, "200px");
});

test("schedule prompt commands use the shared slash palette and submit only after selection", async () => {
  const sent = [];
  render(React.createElement(Composer, { onSend: (message) => { sent.push(message); } }));
  const input = screen.getByRole("textbox", { name: "Prompt" });
  fireEvent.change(input, { target: { value: "/go", selectionStart: 3 } });
  const option = await screen.findByRole("option", { name: /\/goal\b/ });
  fireEvent.mouseDown(option);
  assert.equal(input.value, "/goal ");
  assert.deepEqual(sent, [], "palette selection must only edit the schedule draft");
  fireEvent.change(input, { target: { value: "/goal finish tomorrow", selectionStart: 21 } });
  fireEvent.click(screen.getByRole("button", { name: "Schedule", exact: true }));
  await waitFor(() => assert.equal(sent.length, 1));
  assert.ok(sent[0].startsWith("Work toward this goal for the rest of the session:\n\nfinish tomorrow"));
});

test("pending admission retains the disabled send action rather than offering queue or stop", async (t) => {
  let accept;
  let queued = 0;
  let aborted = 0;
  const pending = new Promise(resolve => { accept = resolve; });
  t.after(() => accept(false));
  const props = { initial: { ...empty(), value: "Send only once" }, onSend: () => pending, onFollowUp: () => { queued++; }, onAbort: () => { aborted++; } };
  const view = render(React.createElement(Composer, props));
  fireEvent.click(screen.getByRole("button", { name: "Schedule", exact: true }));
  view.rerender(React.createElement(Composer, { ...props, isStreaming: true }));
  assert.ok(screen.queryByRole("button", { name: "Queue", exact: true }) === null, "pending admission is not a queued follow-up");
  assert.ok(screen.queryByRole("button", { name: "Stop", exact: true }) === null, "a pending send is not an acknowledged run");
  const sending = screen.getByRole("button", { name: "Schedule", exact: true });
  assert.equal(sending.disabled, true);
  fireEvent.click(sending);
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Prompt" }), { key: "Enter", code: "Enter" });
  assert.equal(queued, 0);
  assert.equal(aborted, 0);
  await act(async () => { accept(true); });
  assert.equal(screen.getByRole("button", { name: "Stop", exact: true }).disabled, false);
});

test("a running shell command remains cancellable while its send awaits completion", async (t) => {
  let finish;
  let aborted = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  t.after(() => finish(false));
  const props = {
    initial: { ...empty(), value: "!sleep 600" }, deferCommands: false, submitLabel: undefined,
    onSend: () => pending, onAbort: () => { aborted++; }, onFollowUp() {},
  };
  const view = render(React.createElement(Composer, props));
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
  view.rerender(React.createElement(Composer, { ...props, isStreaming: true }));
  const stop = screen.queryByRole("button", { name: "Stop", exact: true });
  assert.ok(stop && !stop.disabled, "running shell work must remain cancellable before completion");
  fireEvent.click(stop);
  assert.equal(aborted, 1);
  await act(async () => { finish(true); });
});

test("a file dropped on the controlled composer belongs to it, not its ancestor", async (t) => {
  const previousReader = globalThis.FileReader;
  globalThis.FileReader = window.FileReader;
  const reads = [];
  const readAsDataURL = window.FileReader.prototype.readAsDataURL;
  t.mock.method(window.FileReader.prototype, "readAsDataURL", function (file) {
    reads.push(new Promise((resolve) => this.addEventListener("loadend", resolve, { once: true })));
    return readAsDataURL.call(this, file);
  });
  t.mock.method(URL, "createObjectURL", () => "blob:schedule-drop");
  t.after(() => {
    if (previousReader === undefined) delete globalThis.FileReader;
    else globalThis.FileReader = previousReader;
  });
  let ancestorDrops = 0;
  render(React.createElement("div", { onDrop: () => { ancestorDrops++; } }, React.createElement(Composer)));
  const dropped = new window.File([Uint8Array.from(Buffer.from(PNG, "base64"))], "schedule.png", { type: "image/png" });
  fireEvent.drop(screen.getByRole("textbox", { name: "Prompt" }), { dataTransfer: { files: [dropped], types: ["Files"] } });
  // Wait for the complete native read lifecycle before the shared DOM closes.
  await act(async () => { await Promise.all(reads); });
  await waitFor(() => assert.ok(screen.getByRole("button", { name: /remove image/i })));
  assert.equal(ancestorDrops, 0);
});
