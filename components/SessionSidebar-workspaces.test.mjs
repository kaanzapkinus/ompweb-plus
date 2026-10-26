import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { WorkspaceRow } = await jiti.import("./SessionSidebar-rows.tsx");
const { WorkspaceSelector } = await jiti.import("./SessionSidebar-workspaces.tsx");
const { groupWorkspaceSessions } = await jiti.import("../lib/workspace-view.ts");
const noop = () => {};
const workspaces = ["Companion", "Other", "Empty"].map((name, order) => ({ id: name.toLowerCase(), name, cwd: "/same", createdAt: "2026-10-26", order }));
const session = id => ({ id, path: `/sessions/${id}.jsonl`, cwd: "/original", name: `Chat ${id}`, firstMessage: "hello", messageCount: 1, created: "2026-10-26", modified: "2026-10-26" });
afterEach(cleanup);

function rows(sessions, assignments, onNewSession = noop) {
  return groupWorkspaceSessions(workspaces, sessions, assignments).map(({ workspace, sessions }) => React.createElement(WorkspaceRow, {
    key: workspace.id, workspace, workspaces, assignments, project: { path: workspace.cwd },
    tree: sessions.map(session => ({ session, children: [] })), nativeParentIds: new Set(),
    isActive: workspace.id === "companion", isExpanded: true, selectedSessionId: null,
    runningSessionIds: new Set(), unreadSessionIds: new Set(), exitedSessions: new Map(), relativeTimeNow: Date.parse("2026-10-26"),
    onActivate: noop, onNewSession, onToggleExpand: noop, onRemoveWorkspace: noop, onRenameWorkspace: noop,
    onAssignWorkspace: noop, onEditLaunchConfig: noop, onSelectSession: noop,
  }));
}

test("sidebar and fresh-chat selector show identical logical records, including empty same-cwd workspaces", () => {
  const creations = [];
  const sessions = Array.from({ length: 9 }, (_, i) => session(String(i)));
  const assignments = Object.fromEntries(sessions.map(s => [s.id, "companion"]));
  const view = render(React.createElement(React.Fragment, null,
    ...rows(sessions, assignments, workspace => creations.push(workspace)),
    React.createElement(WorkspaceSelector, { workspaces, selectedWorkspaceId: "companion", cwd: "/same", onSelect: workspace => creations.push(workspace), onCreate: noop }),
  ));
  const selector = view.getByRole("combobox");
  assert.deepEqual(within(selector).getAllByRole("option").filter(option => option.value).map(option => option.textContent), workspaces.map(w => w.name));
  for (const workspace of workspaces) assert.ok(view.getByRole("button", { name: workspace.name, exact: true }));
  for (const s of sessions) assert.ok(view.getByRole("button", { name: s.name, exact: true }), "all conversations remain reachable beyond the former cap");
  assert.equal(view.container.querySelector("[data-topic-folders]"), null);
  fireEvent.change(selector, { target: { value: "other" } });
  fireEvent.click(view.getByRole("button", { name: "New chat in Companion" }));
  assert.deepEqual(creations.map(w => ({ workspaceId: w.id, cwd: w.cwd })), [{ workspaceId: "other", cwd: "/same" }, { workspaceId: "companion", cwd: "/same" }]);
});

test("moving an existing chat changes only its visible workspace and renders it once", () => {
  const sessions = [session("one"), session("two")];
  const view = render(React.createElement(React.Fragment, null, ...rows(sessions, { one: "companion", two: "other" })));
  view.rerender(React.createElement(React.Fragment, null, ...rows(sessions, { one: "other", two: "other" })));
  const other = view.container.querySelector('[data-workspace-id="other"]');
  assert.equal(within(other).getAllByRole("button", { name: /^Chat / }).length, 2);
  assert.equal(view.getAllByRole("button", { name: "Chat one", exact: true }).length, 1);
  assert.equal(sessions[0].cwd, "/original");
});
