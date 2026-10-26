import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { groupWorkspaceSessions, newWorkspaceDraftKey, workspaceCreationTarget } = await jiti.import("./workspace-view.ts");

const workspaces = [
  { id: "d-directory", name: "Project", cwd: "/project", order: 0, createdAt: "2026-10-26" },
  { id: "companion", name: "Companion", cwd: "/project", order: 1, createdAt: "2026-10-26" },
  { id: "empty", name: "Empty topic", cwd: "/project", order: 2, createdAt: "2026-10-26" },
  { id: "other", name: "Other", cwd: "/other", order: 3, createdAt: "2026-10-26" },
];
const session = (id, cwd = "/project", extra = {}) => ({ id, path: `/sessions/${id}.jsonl`, cwd, modified: "2026-10-26", ...extra });

test("logical workspace membership is independent of cwd and native ancestry", () => {
  const sessions = [session("root"), session("child", "/other", { parentSessionId: "root" }), session("default"), session("orphan")];
  const original = structuredClone(sessions);
  const groups = groupWorkspaceSessions(workspaces, sessions, { root: "companion", child: "companion", orphan: "deleted" });
  assert.deepEqual(groups.map(({ workspace, sessions }) => [workspace.id, sessions.map(s => s.id)]), [
    ["d-directory", ["default", "orphan"]], ["companion", ["root", "child"]], ["empty", []], ["other", []],
  ]);
  assert.deepEqual(groups.flatMap(g => g.sessions).map(s => s.id).sort(), sessions.map(s => s.id).sort());
  assert.deepEqual(sessions, original, "membership must never rewrite cwd, ancestry or transcript paths");
});

test("moving one chat changes only its membership and never duplicates descendants", () => {
  const sessions = [session("root"), session("child", "/project", { parentSessionId: "root" })];
  const groups = groupWorkspaceSessions(workspaces, sessions, { child: "companion" });
  assert.deepEqual(groups.find(g => g.workspace.id === "d-directory").sessions.map(s => s.id), ["root"]);
  assert.deepEqual(groups.find(g => g.workspace.id === "companion").sessions.map(s => s.id), ["child"]);
});

test("same-cwd workspace selection keeps native target cwd and distinct creation identity", () => {
  assert.deepEqual(workspaceCreationTarget(workspaces, "companion"), { cwd: "/project", workspaceId: "companion" });
  assert.deepEqual(workspaceCreationTarget(workspaces, "d-directory"), { cwd: "/project", workspaceId: "d-directory" });
  assert.equal(workspaceCreationTarget(workspaces, "missing"), null);
  assert.notEqual(newWorkspaceDraftKey("/project", "d-directory"), newWorkspaceDraftKey("/project", "companion"));
  assert.equal(newWorkspaceDraftKey("/project", "companion"), newWorkspaceDraftKey("/project", "companion"));
});

test("a just-discovered conversation remains visible while registry refresh catches up", () => {
  const sessions = [session("not-yet-assigned", "/new-native-directory")];
  const groups = groupWorkspaceSessions(workspaces, sessions, {});
  assert.deepEqual(groups.flatMap(group => group.sessions), sessions);
});

test("explicit linked-worktree creation keeps membership separate from the chosen real cwd", () => {
  assert.deepEqual(workspaceCreationTarget(workspaces, "companion", "/linked-worktree"), { cwd: "/linked-worktree", workspaceId: "companion" });
  assert.deepEqual(workspaceCreationTarget(workspaces, "companion"), { cwd: "/project", workspaceId: "companion" });
});
