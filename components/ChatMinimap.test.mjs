import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatMinimap, extractPreviewText } = await jiti.import("./ChatMinimap.tsx");

afterEach(cleanup);

test("extractPreviewText extracts clean text from user string content", () => {
  const preview = extractPreviewText({
    role: "user",
    content: "move Explorer to right panel",
  });
  assert.equal(preview, "move Explorer to right panel");
});

test("extractPreviewText cleans markdown formatting, code fences, and extra whitespace", () => {
  const preview = extractPreviewText({
    role: "user",
    content: "## Refactor Minimap\n```ts\nconst a = 1;\n```\n  Can we simplify the context bar?  ",
  });
  assert.equal(preview, "Refactor Minimap Can we simplify the context bar?");
});

test("extractPreviewText truncates excessively long prompts with ellipsis", () => {
  const longPrompt = "This is a very long prompt that exceeds sixty characters and should be truncated with an ellipsis cleanly";
  const preview = extractPreviewText({
    role: "user",
    content: longPrompt,
  });
  assert.ok(preview.length <= 60);
  assert.ok(preview.endsWith("…"));
});

test("uses assistant context only when there are no user prompts, and removes empty navigation", () => {
  const props = {
    messages: [
      { role: "assistant", content: [{ type: "text", text: "Welcome to the agent" }] },
      { role: "assistant", content: [{ type: "text", text: "Ready for tasks" }] },
    ],
    scrollContainer: { current: null },
    messageRefs: { current: [] },
  };
  const view = render(React.createElement(ChatMinimap, props));
  assert.ok(screen.getByRole("button", { name: "Jump to: Welcome to the agent" }));
  assert.ok(screen.getByRole("button", { name: "Jump to: Ready for tasks" }));
  view.rerender(React.createElement(ChatMinimap, {
    ...props,
    messages: [...props.messages, { role: "user", content: "first question" }],
  }));
  assert.ok(screen.getByRole("button", { name: "Jump to: first question" }));
  assert.equal(screen.queryByRole("button", { name: "Jump to: Welcome to the agent" }), null);
  view.rerender(React.createElement(ChatMinimap, { ...props, messages: [] }));
  assert.equal(screen.queryByRole("navigation"), null);
});

test("bounds an overflowing rail and its scrolled preview to the resized conversation, not the viewport", () => {
  const previousResizeObserver = globalThis.ResizeObserver;
  const observers = new Set();
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.add(this); }
    observe() {}
    disconnect() { observers.delete(this); }
  };
  const conversation = document.createElement("div");
  let conversationHeight = 148;
  let scale = 1;
  Object.defineProperties(conversation, {
    clientHeight: { get: () => conversationHeight },
    scrollHeight: { value: 1000 },
  });
  conversation.getBoundingClientRect = () => ({ height: conversationHeight * scale });
  const jumps = [];
  conversation.scrollTo = (options) => { jumps.push(options); };
  document.body.append(conversation);
  const resize = () => act(() => {
    for (const observer of observers) observer.callback([]);
  });
  try {
    render(React.createElement(ChatMinimap, {
      messages: Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `Question ${i + 1}` })),
      scrollContainer: { current: conversation },
      messageRefs: { current: [] },
    }));
    const rail = screen.getByRole("navigation");
    assert.equal(rail.parentElement.style.height, "148px");
    assert.equal(rail.style.overflowY, "auto", "short conversations can overflow even with fewer than 25 nodes");
    const lastNode = screen.getByRole("button", { name: "Jump to: Question 20" });
    assert.equal(lastNode.style.flexShrink, "0", "overflow must not collapse the hit targets");
    fireEvent.mouseEnter(lastNode);
    const preview = screen.getByRole("tooltip");
    Object.defineProperty(preview, "offsetHeight", { value: 30, configurable: true });
    resize();
    assert.equal(preview.style.top, "133px", "the preview's bottom stays inside the conversation");
    rail.scrollTop = 300;
    fireEvent.scroll(rail);
    assert.equal(preview.style.top, "57px", "the preview follows the visible row after rail scrolling");
    scale = 1.2;
    conversationHeight = 72;
    resize();
    assert.equal(rail.parentElement.style.height, "72px", "wrapped headers or a taller composer resize the rail");
    assert.equal(preview.style.top, "57px");
    Object.defineProperty(rail, "clientHeight", { get: () => conversationHeight });
    rail.getBoundingClientRect = () => ({ top: 100, height: conversationHeight * scale });
    rail.scrollTo = ({ top }) => { rail.scrollTop = top; };
    fireEvent.mouseDown(rail, { clientY: 128.8 });
    assert.equal(preview.textContent, "Question 18", "scrubbing hits the visible row in the scrolled rail");
    fireEvent.mouseMove(window, { clientY: 107.2 });
    assert.equal(preview.textContent, "Question 17");
    fireEvent.mouseLeave(rail);
    fireEvent.mouseUp(window);
    assert.equal(screen.queryByRole("tooltip"), null, "released outside drags leave no stuck preview");
    const jumpCount = jumps.length;
    fireEvent.mouseMove(window, { clientY: 124 });
    fireEvent.mouseDown(rail, { button: 2, clientY: 124 });
    assert.equal(jumps.length, jumpCount, "released drags and right clicks do not navigate");
    fireEvent.mouseEnter(lastNode);
    const newPreview = screen.getByRole("tooltip");
    Object.defineProperty(newPreview, "offsetHeight", { value: 30, configurable: true });
    rail.scrollTop = 400;
    fireEvent.scroll(rail);
    resize();
    assert.equal(newPreview.style.top, "15px", "the preview's top stays below the headers");
    fireEvent.keyDown(lastNode, { key: "Enter" });
    assert.equal(jumps.at(-1).top, 928, "keyboard navigation still targets the last message");
    conversationHeight = 0;
    resize();
    assert.equal(rail.parentElement.style.height, "0px");
  } finally {
    cleanup();
    conversation.remove();
    globalThis.ResizeObserver = previousResizeObserver;
  }
});
