import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildSessionTree } = await jiti.import("./SessionSidebar-helpers.ts");
const session = (id, path, parentSessionId) => ({
  id, path, parentSessionId, cwd: "/workspace", modified: "2026-10-01T00:00:00Z",
  created: "2026-10-01T00:00:00Z", messageCount: 1, firstMessage: "hello",
});
const flatten = (nodes) => nodes.flatMap((node) => [node.session.path, ...flatten(node.children)]);

test("sessions with repeated native IDs retain every distinct transcript", () => {
  const input = [session("same", "/a.jsonl"), session("same", "/b.jsonl"), session("child", "/c.jsonl", "same")];
  const tree = buildSessionTree(input);
  assert.deepEqual(flatten(tree).sort(), input.map((s) => s.path).sort());
  assert.equal(tree.find((n) => n.session.id === "child").children.length, 0);
  assert.equal(tree.length, 3, "ambiguous parent IDs must not attach a fork to an arbitrary transcript");
});

test("forks retain ancestry and cycles cannot hide sessions or recurse forever", () => {
  const input = [session("parent", "/parent.jsonl"), session("fork", "/fork.jsonl", "parent"),
    session("cycle-a", "/cycle-a.jsonl", "cycle-b"), session("cycle-b", "/cycle-b.jsonl", "cycle-a")];
  const tree = buildSessionTree(input);
  assert.deepEqual(flatten(tree).sort(), input.map((s) => s.path).sort());
  assert.deepEqual(tree.find((n) => n.session.id === "parent").children.map((n) => n.session.id), ["fork"]);
  assert.equal(tree.filter((n) => n.session.id.startsWith("cycle-")).length, 2);
});
