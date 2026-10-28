import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { clearDraft } = await jiti.import("@/lib/draft-store");
afterEach(() => { cleanup(); clearDraft("viewport-proof"); });

function mount(t, { offsetTop = 0, height = 844 } = {}) {
  const viewport = new window.EventTarget();
  Object.assign(viewport, { offsetTop, height });
  const saved = Object.getOwnPropertyDescriptor(window, "visualViewport");
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  t.after(() => { if (saved) Object.defineProperty(window, "visualViewport", saved); else delete window.visualViewport; });
  const previousMedia = window.matchMedia;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  t.after(() => { if (previousMedia) window.matchMedia = previousMedia; else delete window.matchMedia; });
  const previousScroll = window.HTMLElement.prototype.scrollIntoView;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  t.after(() => { if (previousScroll) window.HTMLElement.prototype.scrollIntoView = previousScroll; else delete window.HTMLElement.prototype.scrollIntoView; });
  const style = globalThis.getComputedStyle;
  t.mock.method(globalThis, "getComputedStyle", (node) => new Proxy(style(node), {
    get(target, key) { return key === "overflowY" ? target.overflowY || "visible" : Reflect.get(target, key); },
  }));
  let anchorTop = 600;
  t.mock.method(window.HTMLElement.prototype, "getBoundingClientRect", function () {
    return this.dataset.boundary ? new window.DOMRect(0, 80, 390, 764) : new window.DOMRect(16, anchorTop, 358, 90);
  });
  render(React.createElement("div", { "data-boundary": true, style: { overflowY: "auto" } },
    React.createElement(ChatInput, { draftKey: "viewport-proof", isStreaming: false, onSend() {} })));
  const editor = screen.getByRole("textbox");
  fireEvent.change(editor, { target: { value: "/", selectionStart: 1 } });
  const menu = () => screen.getByRole("listbox").parentElement;
  const assertFits = () => {
    const maxHeight = Number.parseFloat(menu().style.maxHeight);
    assert.ok(maxHeight > 40, "commands must remain usable");
    const space = menu().style.top
      ? Math.min(844, viewport.offsetTop + viewport.height) - (anchorTop + 90 + 8) - 8
      : anchorTop - 8 - Math.max(80, viewport.offsetTop) - 8;
    assert.ok(maxHeight <= space,
      `menu height ${maxHeight} must fit beside the editor inside the visible viewport`);
  };
  return { viewport, menu, assertFits, move: (top) => { anchorTop = top; } };
}

test("new-chat slash commands fit the keyboard-panned visual viewport", (t) => {
  const ui = mount(t, { offsetTop: 250, height: 390 });
  ui.assertFits();
});

test("an open slash menu stays visible when the keyboard resizes the viewport", (t) => {
  const ui = mount(t);
  ui.move(320);
  ui.viewport.height = 390;
  act(() => { ui.viewport.dispatchEvent(new window.Event("resize")); });
  ui.assertFits();
});

test("an open slash menu follows its scrolled new-chat editor", (t) => {
  const ui = mount(t);
  ui.move(250);
  act(() => { document.querySelector("[data-boundary]").dispatchEvent(new window.Event("scroll")); });
  ui.assertFits();
});
