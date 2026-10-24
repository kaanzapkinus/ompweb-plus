import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ProjectRow } = await jiti.import("./SessionSidebar-rows.tsx");
const noop = () => {};

test("topic folders remain available when their underlying workspace was collapsed", () => {
  const cwd = "/workspace";
  const sessions = Array.from({ length: 7 }, (_, index) => ({
    id: `chat-${index}`, path: `/sessions/chat-${index}.jsonl`, cwd,
    name: `Conversation ${index}`, firstMessage: "hello", messageCount: 1,
    created: "2026-10-01T00:00:00Z", modified: "2026-10-01T00:00:00Z",
  }));
  const props = {
    project: { path: cwd, alias: "omp-sessions" }, isActive: false, isExpanded: false,
    activity: undefined, tree: sessions.map((session) => ({ session, children: [] })), hiddenCount: 2,
    selectedSessionId: null, runningSessionIds: new Set(), unreadSessionIds: new Set(), exitedSessions: new Map(),
    relativeTimeNow: Date.parse("2026-10-02T00:00:00Z"),
    onActivate: noop, onToggleExpand: noop, onRemoveProject: noop, onEditLaunchConfig: noop,
    onUpdatePresentation: noop, onDragPathChange: noop, onDropProject: noop, onMoveProject: noop,
    isDragTarget: false, removeBusy: false, onSelectSession: noop,
    folders: [{ id: "topic", name: "Topic", projectPath: cwd, createdAt: "2026-10-01T00:00:00Z" }],
    folderAssignments: Object.fromEntries(sessions.slice(0, 6).map((s) => [s.id, "topic"])),
  };
  const view = render(React.createElement(ProjectRow, props));
  try {
    assert.equal(view.queryByRole("button", { name: "omp-sessions", exact: true }), null);
    for (const session of sessions) assert.ok(view.getByRole("button", { name: session.name, exact: true }));
    fireEvent.click(view.container.querySelector(".sidebar-folder-toggle"));
    for (const session of sessions.slice(0, 6)) assert.equal(view.queryByRole("button", { name: session.name, exact: true }), null);
    assert.ok(view.getByRole("button", { name: sessions[6].name, exact: true }), "unassigned chat remains visible");
    fireEvent.click(view.container.querySelector(".sidebar-folder-toggle"));
    for (const session of sessions) assert.ok(view.getByRole("button", { name: session.name, exact: true }));
  } finally { cleanup(); }
});
