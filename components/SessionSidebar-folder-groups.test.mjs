import test from "node:test";
import assert from "node:assert/strict";
import { bindSessionFolderActions, groupSessionTreeByFolder } from "./SessionSidebar-folder-groups.ts";

function node(id, children = [], path = `/sessions/${id}.jsonl`) {
  return { session: { id, path, cwd: "/workspace", modified: "2026-10-22T12:00:00Z", firstMessage: id }, children };
}
function flatten(nodes) {
  return nodes.flatMap((entry) => [entry.session.path, ...flatten(entry.children)]);
}

test("folder view keeps roots beyond five and every fork exactly once", () => {
  const fork = node("fork", [node("grandchild")]);
  fork.session.parentSessionId = "root-0";
  const tree = Array.from({ length: 12 }, (_, index) => node(`root-${index}`, index === 0 ? [fork] : []));
  const original = structuredClone(tree);
  const grouped = groupSessionTreeByFolder(tree, ["topic", "empty"], { "root-9": "topic", fork: "topic", grandchild: "topic" });
  const paths = [...flatten(grouped.unassigned), ...[...grouped.byFolder.values()].flatMap(flatten)];
  assert.deepEqual(paths.toSorted(), flatten(tree).toSorted());
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(grouped.byFolder.get("topic").length, 2);
  assert.equal(grouped.counts.get("topic"), 3);
  assert.equal(grouped.unassignedCount, 11);
  assert.deepEqual(grouped.byFolder.get("empty"), []);
  assert.equal(grouped.separatedParents.get(fork.session.path), tree[0].session);
  assert.equal(grouped.nativeParentPaths.has(tree[0].session.path), true, "cross-folder forks must still protect native parents from leaf-only actions");
  assert.equal(grouped.byFolder.get("topic").find((entry) => entry.session.id === "root-9").session, tree[9].session);
  assert.deepEqual(tree, original, "grouping must not rewrite native ancestry or cwd");
});

test("moving a child or root only changes that chat's presentation group", () => {
  const child = node("child", [node("grandchild")]);
  child.session.parentSessionId = "root";
  const root = node("root", [child]);
  const childMoved = groupSessionTreeByFolder([root], ["topic"], { child: "topic" });
  assert.deepEqual(flatten(childMoved.byFolder.get("topic")), [child.session.path]);
  assert.deepEqual(flatten(childMoved.unassigned), [root.session.path, child.children[0].session.path]);
  assert.equal(childMoved.separatedParents.get(child.children[0].session.path), child.session);
  const rootMoved = groupSessionTreeByFolder([root], ["topic"], { root: "topic" });
  assert.deepEqual(flatten(rootMoved.byFolder.get("topic")), [root.session.path]);
  assert.deepEqual(flatten(rootMoved.unassigned), flatten([child]));
  assert.equal(rootMoved.separatedParents.get(child.session.path), root.session);
  const returned = groupSessionTreeByFolder([root], ["topic"], {});
  assert.deepEqual(flatten(returned.unassigned), flatten([root]));
  assert.equal(returned.unassigned[0].children[0].session.parentSessionId, "root");
});

test("deleted or foreign folder assignments fall back to unassigned without dropping duplicate fixture IDs", () => {
  const tree = [node("duplicate", [], "/one.jsonl"), node("duplicate", [], "/two.jsonl")];
  const grouped = groupSessionTreeByFolder(tree, ["empty"], { duplicate: "missing" });
  assert.deepEqual(flatten(grouped.unassigned), ["/one.jsonl", "/two.jsonl"]);
  assert.equal(grouped.unassignedCount, 2);
  assert.equal(grouped.counts.get("empty"), 0);
  assert.deepEqual(groupSessionTreeByFolder([], ["empty"], {}).byFolder.get("empty"), []);
});

test("session-first move/create callbacks bind each leaf ID and propagate failures", async () => {
  const calls = [];
  const assign = async (...args) => { calls.push(["assign", ...args]); };
  const create = async (...args) => { calls.push(["create", ...args]); };
  const root = bindSessionFolderActions("root", assign, create);
  const child = bindSessionFolderActions("child", assign, create);
  await root.onAssignFolder("topic");
  await child.onAssignFolder("other");
  await child.onAssignFolder(null);
  await child.onCreateFolderAndAssign("New topic");
  assert.deepEqual(calls, [["assign", "root", "topic"], ["assign", "child", "other"], ["assign", "child", null], ["create", "child", "New topic"]]);
  const failing = bindSessionFolderActions("child", async () => { throw new Error("write refused"); });
  await assert.rejects(failing.onAssignFolder("topic"), /write refused/);
});
