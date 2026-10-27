import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { SessionDiscovery } = await jiti.import("./SessionSidebar-discovery.tsx");
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
const session = id => ({ id, path: `/sessions/${id}.jsonl`, cwd: "/native/worktree", name: `Chat ${id}`, firstMessage: "opening", messageCount: 4, created: "2026-10-26", modified: "2026-10-27" });
const workspaces = [{ id: "alpha", name: "Alpha workspace", cwd: "/logical/alpha", order: 0, createdAt: "2026-10-26" }, { id: "beta", name: "Beta workspace", cwd: "/logical/beta", order: 1, createdAt: "2026-10-26" }];
const noop = () => {};
function props(overrides = {}) {
  return { workspaces, assignments: { one: "beta", two: "alpha" }, selectedSessionId: null, runningSessionIds: new Set(), unreadSessionIds: new Set(), exitedSessions: new Map(), runningOnly: false, onRunningOnlyChange: noop, onSelectSession: noop, refreshKey: 0, children: React.createElement("button", null, "Original workspace navigation"), ...overrides };
}
function requests() {
  const pending = [];
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => pending.push({ url: String(url), options, resolve, reject }));
  return pending;
}
async function respond(request, body, status = 200) {
  await act(async () => { request.resolve({ ok: status === 200, status, json: async () => body }); });
}
const results = (...ids) => ({ results: ids.map(id => ({ session: session(id), excerpt: `A later assistant message for ${id}`, role: "assistant", entryId: `entry-${id}` })), total: ids.length, hasMore: false, unavailable: 0 });
async function searchRequest(pending, query, offset = 0) {
  let request;
  await waitFor(() => {
    request = pending.find(item => { const url = new URL(item.url, "https://omp.test"); return url.pathname === "/api/sessions/search" && url.searchParams.get("q") === query && Number(url.searchParams.get("offset")) === offset; });
    assert.ok(request, `request for ${query} at offset ${offset}`);
  });
  return request;
}

test("new-query results survive a previous query completing after abort", async () => {
  const pending = requests();
  const view = render(React.createElement(SessionDiscovery, props()));
  const input = view.getByRole("searchbox", { name: "Search all chats" });
  fireEvent.change(input, { target: { value: "old phrase" } });
  const old = await searchRequest(pending, "old phrase");
  fireEvent.change(input, { target: { value: "new phrase" } });
  assert.equal(old.options.signal.aborted, true);
  const current = await searchRequest(pending, "new phrase");
  await respond(current, results("two"));
  await respond(old, results("one"));
  assert.ok(view.getByRole("button", { name: /Chat two/ }));
  assert.equal(view.queryByRole("button", { name: /Chat one/ }), null);
  assert.equal(view.queryByText("Original workspace navigation"), null);
});

test("clearing restores workspace navigation and rejects late results and errors", async () => {
  const pending = requests();
  const view = render(React.createElement(SessionDiscovery, props()));
  const input = view.getByRole("searchbox");
  fireEvent.change(input, { target: { value: "first" } });
  const first = await searchRequest(pending, "first");
  fireEvent.click(view.getByRole("button", { name: "Clear search" }));
  await respond(first, results("one"));
  assert.equal(input.value, "");
  assert.ok(view.getByRole("button", { name: "Original workspace navigation" }));
  assert.equal(view.queryByRole("button", { name: /Chat one/ }), null);
  fireEvent.change(input, { target: { value: "second" } });
  const second = await searchRequest(pending, "second");
  fireEvent.keyDown(input, { key: "Escape" });
  await act(async () => { second.reject(new Error("late failure")); });
  assert.equal(view.queryByRole("alert"), null);
  assert.ok(view.getByRole("button", { name: "Original workspace navigation" }));
});

test("flattened search rows show matching text and assigned workspace and select the unmodified native session", async () => {
  const pending = requests();
  const selected = [];
  const view = render(React.createElement(SessionDiscovery, props({ onSelectSession: value => selected.push(value), selectedSessionId: "one", unreadSessionIds: new Set(["one"]) })));
  fireEvent.change(view.getByRole("searchbox"), { target: { value: "later assistant" } });
  const response = results("one");
  await respond(await searchRequest(pending, "later assistant"), response);
  const row = view.getByRole("button", { name: /Chat one/ });
  assert.ok(within(row).getByText("Beta workspace"));
  assert.ok(within(row).getByText("A later assistant message for one"));
  assert.equal(row.getAttribute("aria-current"), "true");
  fireEvent.click(row);
  assert.deepEqual(selected, [response.results[0].session]);
  assert.equal(selected[0].cwd, "/native/worktree");
  assert.equal(selected[0].workspaceId, undefined);
});

test("pagination appends distinct chats without losing selection and retries the failed page", async () => {
  const pending = requests();
  const selected = [];
  const view = render(React.createElement(SessionDiscovery, props({ onSelectSession: value => selected.push(value.id) })));
  fireEvent.change(view.getByRole("searchbox"), { target: { value: "needle" } });
  await respond(await searchRequest(pending, "needle"), { ...results("one"), total: 2, hasMore: true });
  fireEvent.click(view.getByRole("button", { name: "Load more chats" }));
  const next = await searchRequest(pending, "needle", 1);
  await respond(next, {}, 503);
  assert.ok(view.getByRole("button", { name: /Chat one/ }));
  assert.ok(view.getByRole("alert"));
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  await waitFor(() => assert.equal(pending.filter(item => item.url.includes("offset=1")).length, 2));
  await respond(pending.filter(item => item.url.includes("offset=1"))[1], { ...results("two"), total: 2, hasMore: false });
  assert.equal(view.queryByRole("button", { name: "Load more chats" }), null);
  assert.ok(view.getByRole("button", { name: /Chat one/ }));
  fireEvent.click(view.getByRole("button", { name: /Chat two/ }));
  assert.deepEqual(selected, ["two"]);
});

test("recents keep server message order, collapse independently, and retain workspace navigation", async () => {
  const pending = requests();
  const selected = [];
  const view = render(React.createElement(SessionDiscovery, props({ onSelectSession: value => selected.push(value.id) })));
  await respond(pending[0], { sessions: [{ ...session("two"), lastMessageAt: "2026-10-27T02:00:00Z", modified: "2026-10-25" }, { ...session("one"), lastMessageAt: "2026-10-27T01:00:00Z", modified: "2026-10-28" }], unavailable: 1 });
  const toggle = view.getByRole("button", { name: /Recent chats/ });
  if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
  const region = view.getByRole("region", { name: "Recent chats" });
  assert.deepEqual(within(region).getAllByRole("button", { name: /^Chat/ }).map(row => row.querySelector(".sidebar-discovery-title").textContent), ["Chat two", "Chat one"]);
  assert.ok(view.getByText(/1 chat file could not be read/));
  fireEvent.click(within(region).getByRole("button", { name: /Chat one/ }));
  assert.deepEqual(selected, ["one"]);
  fireEvent.click(toggle);
  assert.equal(view.queryByRole("button", { name: /Chat one/ }), null);
  assert.ok(view.getByRole("button", { name: "Original workspace navigation" }));
});

test("running-only filters both discovery lists and still allows paging through nonrunning matches", async () => {
  const pending = requests();
  const view = render(React.createElement(SessionDiscovery, props({ runningOnly: true, runningSessionIds: new Set(["two"]) })));
  await respond(pending[0], { sessions: [{ ...session("one"), lastMessageAt: "2026-10-27" }, { ...session("two"), lastMessageAt: "2026-10-26" }], unavailable: 0 });
  const toggle = view.getByRole("button", { name: /Recent chats/ });
  if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
  assert.equal(view.queryByRole("button", { name: /Chat one/ }), null);
  assert.ok(view.getByRole("button", { name: /Chat two/ }));
  fireEvent.change(view.getByRole("searchbox"), { target: { value: "needle" } });
  await respond(await searchRequest(pending, "needle"), { ...results("one"), total: 2, hasMore: true });
  assert.equal(view.queryByRole("button", { name: /Chat one/ }), null);
  assert.ok(view.getByRole("button", { name: "Load more chats" }));
  fireEvent.click(view.getByRole("button", { name: "Load more chats" }));
  await respond(await searchRequest(pending, "needle", 1), { ...results("two"), total: 2, hasMore: false });
  assert.ok(view.getByRole("button", { name: /Chat two/ }));
});

test("refresh invalidation reloads recents without re-fetching on unrelated renders", async () => {
  const pending = requests();
  const view = render(React.createElement(SessionDiscovery, props()));
  await respond(pending[0], { sessions: [{ ...session("one"), lastMessageAt: "2026-10-26" }], unavailable: 0 });
  view.rerender(React.createElement(SessionDiscovery, props({ selectedSessionId: "one" })));
  assert.equal(pending.length, 1);
  view.rerender(React.createElement(SessionDiscovery, props({ refreshKey: 1 })));
  await waitFor(() => assert.equal(pending.length, 2));
  await respond(pending[1], { sessions: [{ ...session("two"), lastMessageAt: "2026-10-27" }], unavailable: 0 });
  const toggle = view.getByRole("button", { name: /Recent chats/ });
  if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
  assert.ok(view.getByRole("button", { name: /Chat two/ }));
  assert.equal(view.queryByRole("button", { name: /Chat one/ }), null);
});

test("search errors retry, while unreadable files are not presented as a complete no-match result", async () => {
  const pending = requests();
  const view = render(React.createElement(SessionDiscovery, props()));
  fireEvent.change(view.getByRole("searchbox"), { target: { value: "missing" } });
  await respond(await searchRequest(pending, "missing"), {}, 500);
  assert.ok(view.getByRole("alert"));
  assert.equal(view.queryByText("No matching chats"), null);
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  await waitFor(() => assert.equal(pending.filter(item => item.url.includes("/search?")).length, 2));
  await respond(pending.filter(item => item.url.includes("/search?"))[1], { results: [], total: 0, hasMore: false, unavailable: 2 });
  assert.ok(view.getByText("No matches in readable chats"));
  assert.ok(view.getByText(/2 chat files could not be read/));
});

test("unmount aborts pending discovery requests", async () => {
  const pending = requests();
  const view = render(React.createElement(SessionDiscovery, props()));
  view.unmount();
  assert.equal(pending[0].options.signal.aborted, true);
  await respond(pending[0], { sessions: [], unavailable: 0 });
});

test("typing debounces requests and normalizes phrase whitespace without changing Unicode", async () => {
  const pending = requests();
  const view = render(React.createElement(SessionDiscovery, props()));
  const input = view.getByRole("searchbox");
  fireEvent.change(input, { target: { value: "superseded" } });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
  assert.equal(pending.filter(item => item.url.includes("/search?")).length, 0);
  fireEvent.change(input, { target: { value: "  日本語   exact phrase  " } });
  const request = await searchRequest(pending, "日本語 exact phrase");
  await respond(request, results("one"));
  assert.equal(pending.filter(item => item.url.includes("/search?")).length, 1);
  assert.ok(view.getByRole("button", { name: /Chat one/ }));
});

test("query changes restore the top of the shared scroll flow", async () => {
  const pending = requests();
  const view = render(React.createElement(SessionDiscovery, props()));
  const scroll = view.container.querySelector(".sidebar-discovery-scroll");
  scroll.scrollTop = 400;
  fireEvent.change(view.getByRole("searchbox"), { target: { value: "needle" } });
  assert.equal(scroll.scrollTop, 0);
  await respond(await searchRequest(pending, "needle"), results("one"));
  scroll.scrollTop = 200;
  fireEvent.click(view.getByRole("button", { name: "Clear search" }));
  assert.equal(scroll.scrollTop, 0);
});

test("background refresh retains loaded search pages and scroll until their full window is replaced", async () => {
  const pending = requests();
  const view = render(React.createElement(SessionDiscovery, props()));
  fireEvent.change(view.getByRole("searchbox"), { target: { value: "needle" } });
  await respond(await searchRequest(pending, "needle"), { ...results("one"), total: 2, hasMore: true });
  fireEvent.click(view.getByRole("button", { name: "Load more chats" }));
  await respond(await searchRequest(pending, "needle", 1), { ...results("two"), total: 2 });
  const scroll = view.container.querySelector(".sidebar-discovery-scroll");
  scroll.scrollTop = 120;
  view.rerender(React.createElement(SessionDiscovery, props({ refreshKey: 1 })));
  assert.ok(view.getByRole("button", { name: /Chat one/ }));
  assert.ok(view.getByRole("button", { name: /Chat two/ }), "already loaded matches must remain available during background refresh");
  const atOffset = offset => pending.filter(item => {
    const url = new URL(item.url, "https://omp.test");
    return url.pathname.endsWith("/search") && Number(url.searchParams.get("offset")) === offset;
  });
  await waitFor(() => assert.equal(atOffset(0).length, 2));
  await respond(atOffset(0)[1], { ...results("one"), total: 2, hasMore: true });
  await waitFor(() => assert.equal(atOffset(1).length, 2));
  await respond(atOffset(1)[1], { ...results("two"), total: 2 });
  assert.ok(view.getByRole("button", { name: /Chat two/ }));
  assert.equal(scroll.scrollTop, 120);
});
