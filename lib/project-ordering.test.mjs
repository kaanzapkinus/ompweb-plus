import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  deriveWorkspaceEntries,
  filterWorkspaceEntries,
  groupSessionsByProject,
  isTemporaryProjectPath,
  projectActivityCounts,
  sortManagedProjects,
  workspaceCategory,
} = await jiti.import("./project-ordering.ts");
const { comparableProjectPath } = await jiti.import("./comparable-path.ts");

function session(id, overrides = {}) {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd: `/work/${id}`,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hi",
    ...overrides,
  };
}

test("sorts registered projects by most-recently-added, tie-broken by path", () => {
  const projects = [
    { path: "/proj/oldest", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/proj/newest", addedAt: "2026-03-01T00:00:00.000Z" },
    { path: "/proj/middle", addedAt: "2026-02-01T00:00:00.000Z" },
  ];
  const sorted = sortManagedProjects(projects).map((p) => p.path);
  assert.deepEqual(sorted, ["/proj/newest", "/proj/middle", "/proj/oldest"]);
});

test("manual workspace order overrides add time and remains stable", () => {
  const projects = [
    { path: "/proj/new", addedAt: "2026-03-01T00:00:00.000Z", sortOrder: 1 },
    { path: "/proj/old", addedAt: "2026-01-01T00:00:00.000Z", sortOrder: 0 },
  ];
  assert.deepEqual(sortManagedProjects(projects).map((project) => project.path), ["/proj/old", "/proj/new"]);
});

test("project order is stable regardless of session activity", () => {
  const projects = [
    { path: "/proj/a", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/proj/b", addedAt: "2026-02-01T00:00:00.000Z" },
  ];
  const sorted = sortManagedProjects(projects).map((p) => p.path);
  // A session whose modified timestamp is newer than project B's must NOT
  // bump project A above it — rows must never reorder from activity.
  const sessions = [
    session("s-a", { modified: "2026-06-01T00:00:00.000Z", projectRoot: "/proj/a" }),
    session("s-b", { modified: "2026-03-01T00:00:00.000Z", projectRoot: "/proj/b" }),
  ];
  const sortedAfterActivity = sortManagedProjects(projects).map((p) => p.path);
  assert.deepEqual(sorted, ["/proj/b", "/proj/a"]);
  assert.deepEqual(sortedAfterActivity, sorted);
  assert.ok(sessions.length === 2); // sessions are irrelevant to ordering
});

test("session-discovered projects without addedAt sort below registered, by path", () => {
  const projects = [
    { path: "/proj/registered" }, // discovered, no addedAt
    { path: "/proj/active", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/proj/inactive", addedAt: "2026-02-01T00:00:00.000Z" },
    { path: "/proj/zzz" }, // discovered
  ];
  const sorted = sortManagedProjects(projects).map((p) => p.path);
  assert.deepEqual(sorted, ["/proj/inactive", "/proj/active", "/proj/registered", "/proj/zzz"]);
});

test("groups sessions under their project, including worktree sessions", () => {
  const projects = [
    { path: "/repo", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/empty", addedAt: "2026-02-01T00:00:00.000Z" },
    { path: "/other" },
  ];
  const sessions = [
    // Worktree session: cwd differs, projectRoot is the main repo.
    session("wt", { cwd: "/repo-worktrees/feature", projectRoot: "/repo" }),
    // Forked session groups under its project like any other session.
    session("fork", { parentSessionId: "parent", projectRoot: "/other" }),
    session("parent", { projectRoot: "/other" }),
  ];
  const grouped = groupSessionsByProject(projects, sessions);
  assert.deepEqual(grouped.get("/repo").map((s) => s.id), ["wt"]);
  // Empty managed project gets an (empty) bucket.
  assert.deepEqual(grouped.get("/empty"), []);
  assert.deepEqual(grouped.get("/other").map((s) => s.id).sort(), ["fork", "parent"]);
});

test("projectActivityCounts tallies running, unread, and exited sessions per project", () => {
  const sessions = [
    session("running-main", { projectRoot: "/repo" }),
    session("unread-main", { projectRoot: "/repo" }),
    session("exited-main", { projectRoot: "/repo" }),
    session("running-wt", { cwd: "/repo-worktrees/x", projectRoot: "/repo" }),
    session("idle-other", { projectRoot: "/other" }),
  ];
  const counts = projectActivityCounts(sessions, ["running-main", "running-wt"], ["unread-main"], ["exited-main"]);
  // Keys are the case-folded comparable form (see projectActivityCounts docs).
  assert.deepEqual(counts.get(comparableProjectPath("/repo")), { running: 2, unread: 1, exited: 1 });
  assert.deepEqual(counts.get(comparableProjectPath("/other")), { running: 0, unread: 0, exited: 0 });
});

test("casing-only projectRoot differences still group and tally on Windows", { skip: process.platform !== "win32" }, () => {
  // A session file whose cwd casing differs from the registered project path
  // must still land in that project's bucket and its activity row.
  const projects = [{ path: "D:\\OtherProjects\\Waku", addedAt: "2026-01-01T00:00:00.000Z" }];
  const sessions = [session("s1", { projectRoot: "d:\\otherprojects\\waku" })];
  const grouped = groupSessionsByProject(projects, sessions);
  assert.deepEqual(grouped.get("D:\\OtherProjects\\Waku").map((s) => s.id), ["s1"]);
  const counts = projectActivityCounts(sessions, ["s1"], []);
  assert.deepEqual(counts.get(comparableProjectPath("d:\\otherprojects\\waku")), { running: 1, unread: 0, exited: 0 });
});

test("running session placeholders group stably under their own project cwd, not active workspace", () => {
  const projects = [
    { path: "/project-a", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/project-b", addedAt: "2026-02-01T00:00:00.000Z" },
    { path: "/project-c", addedAt: "2026-03-01T00:00:00.000Z" },
  ];
  // Session started in project A (running placeholder with path: "")
  const runningSessionInA = session("running-in-a", {
    path: "",
    cwd: "/project-a",
    projectRoot: "/project-a",
  });
  // Existing sessions in project B and C
  const sessionInB = session("session-b", { projectRoot: "/project-b" });
  const sessionInC = session("session-c", { projectRoot: "/project-c" });

  const visibleSessions = [sessionInB, sessionInC, runningSessionInA];
  const grouped = groupSessionsByProject(projects, visibleSessions);

  assert.deepEqual(grouped.get("/project-a").map((s) => s.id), ["running-in-a"]);
  assert.deepEqual(grouped.get("/project-b").map((s) => s.id), ["session-b"]);
  assert.deepEqual(grouped.get("/project-c").map((s) => s.id), ["session-c"]);
});

test("classifies OS temp and test fixtures, never real user directories", () => {
  const temp = [
    "/tmp",
    "/tmp/ompweb-fork",
    "/var/tmp/x",
    "/private/tmp/omp-rpc-test",
    "/var/folders/demo/example/T/oc-wkr-fixture/wt/444444445555",
    "/Users/example-user/tmp/oc-plg-fixture",
    ".",
    "null",
  ];
  const real = [
    "/Users/example-user/Cloud/demo-sessions",
    "/Users/example-user/Cloud/examples/sample-project",
    "/Users/example-user/homelab",
    "/Users/example-user/homelab/remote/demo-agent",
    "/Users/example-user/Projects/demo-app",
    "/Users/example-user",
    "/Volumes/Example/homelab/backups/demo-archive",
  ];
  for (const p of temp) assert.equal(isTemporaryProjectPath(p), true, `${p} must be temporary`);
  for (const p of real) assert.equal(isTemporaryProjectPath(p), false, `${p} must NOT be temporary`);
  assert.equal(isTemporaryProjectPath(null), false);
  assert.equal(isTemporaryProjectPath(""), false);
});

test("buckets workspaces under their top-level folder category", () => {
  assert.equal(workspaceCategory("/Users/example-user/Cloud/demo-sessions"), "cloud");
  assert.equal(workspaceCategory("/Users/example-user/Cloud/examples/sample-project"), "cloud");
  assert.equal(workspaceCategory("/Users/example-user/homelab"), "homelab");
  assert.equal(workspaceCategory("/Users/example-user/homelab/example-service"), "homelab");
  assert.equal(workspaceCategory("/Users/example-user/homelab-example"), "homelab");
  assert.equal(workspaceCategory("/Users/example-user/Projects/demo-app"), "projects");
  assert.equal(workspaceCategory("/Users/example-user/Projects/demo-integration"), "projects");
  assert.equal(workspaceCategory("/Users/example-user"), "other");
  assert.equal(workspaceCategory("/Users/example-user/omp-test-workspace"), "other");
  assert.equal(workspaceCategory("/tmp"), "temp");
  assert.equal(workspaceCategory("/var/folders/demo/example/T/oc-wkr-fixture/wt/444444445555"), "temp");
  assert.equal(workspaceCategory("/Users/example-user/tmp/oc-plg-fixture"), "temp");
});

test("workspace choices share the sidebar's unfiltered category order and aliases", () => {
  const { entries, workspaceOptions } = deriveWorkspaceEntries(sortManagedProjects([
    { path: "/Users/example-user/Projects/old", alias: "Project", sortOrder: 0 },
    { path: "/Users/example-user/Cloud/later", alias: "Cloud later", sortOrder: 2 },
    { path: "/Users/example-user/homelab", alias: "Home", sortOrder: 3 },
    { path: "/Users/example-user/Cloud/first", alias: "Cloud first", sortOrder: 1 },
    { path: "/Users/example-user", alias: "Personal", sortOrder: 4 },
    { path: "/tmp/empty-fixture", sortOrder: 5 },
    { path: "/tmp/no-transcript", sortOrder: 6 },
  ]), [
    session("fixture", { projectRoot: "/tmp/empty-fixture", messageCount: 0 }),
  ], "Temporary workspaces");

  assert.deepEqual(workspaceOptions.map(({ path, alias }) => ({ path, alias })), [
    { path: "/Users/example-user/Cloud/first", alias: "Cloud first" },
    { path: "/Users/example-user/Cloud/later", alias: "Cloud later" },
    { path: "/Users/example-user/homelab", alias: "Home" },
    { path: "/Users/example-user/Projects/old", alias: "Project" },
    { path: "/Users/example-user", alias: "Personal" },
  ]);
  assert.deepEqual(entries.map(({ project }) => project.path), [
    "/Users/example-user/Cloud/first",
    "/Users/example-user/Cloud/later",
    "/Users/example-user/homelab",
    "/Users/example-user/Projects/old",
    "/Users/example-user",
    "__omp-temp-workspaces__",
  ]);
  assert.equal(entries.at(-1).synthetic, true);
  assert.deepEqual(entries.at(-1).sessions.map(({ id }) => id), ["fixture"]);
});

test("real temporary conversations keep their workspace identity and empty siblings", () => {
  const projects = [
    { path: "/tmp/real-work", alias: "Temporary project" },
    { path: "/Users/example-user/tmp/oc-wkr-fixture" },
  ];
  const realChat = session("real", { projectRoot: "/tmp/real-work" });
  const emptySibling = session("empty", { projectRoot: "/tmp/real-work", messageCount: 0 });
  const fixture = session("fixture", { projectRoot: projects[1].path, messageCount: 0 });
  const { entries, workspaceOptions } = deriveWorkspaceEntries(projects, [realChat, emptySibling, fixture], "Temporary");

  assert.deepEqual(workspaceOptions, [{ path: "/tmp/real-work", alias: "Temporary project" }]);
  assert.deepEqual(entries[0].sessions, [realChat, emptySibling]);
  assert.equal(entries[0].sessions[0], realChat);
  assert.equal(entries[0].synthetic, undefined);
  assert.deepEqual(entries[1].sessions, [fixture]);
});

test("canonical workspace rows retain aliases and worktree chats across Windows path spellings", () => {
  const project = { path: "D:\\Projects\\Waku", alias: "My workspace" };
  const worktreeChat = session("worktree", {
    cwd: "D:\\worktrees\\feature",
    projectRoot: "d:/projects/waku/",
    projectKey: "d:/projects/waku",
  });
  const { entries, workspaceOptions } = deriveWorkspaceEntries([project], [worktreeChat], "Temporary");
  assert.deepEqual(workspaceOptions, [{ path: "D:\\Projects\\Waku", alias: "My workspace" }]);
  assert.deepEqual(entries[0].sessions, [worktreeChat]);
  assert.equal(entries[0].category, "projects");
});

test("search and running filters change rows without shrinking runnable workspace choices", () => {
  const { entries, workspaceOptions } = deriveWorkspaceEntries([
    { path: "/Users/example-user/Cloud/alpha", alias: "Research" },
    { path: "/Users/example-user/Projects/beta", alias: "Build" },
    { path: "/tmp/real-chat", alias: "Scratch" },
  ], [
    session("alpha", { projectRoot: "/Users/example-user/Cloud/alpha", name: "Find me" }),
    session("beta", { projectRoot: "/Users/example-user/Projects/beta" }),
    session("temp", { projectRoot: "/tmp/real-chat", firstMessage: "temporary conversation" }),
  ], "Temporary");
  const label = (path) => path.split("/").at(-1);
  const choices = [
    "/Users/example-user/Cloud/alpha",
    "/Users/example-user/Projects/beta",
    "/tmp/real-chat",
  ];
  for (const [query, runningOnly, runningIds, expected] of [
    ["Find me", false, [], ["/Users/example-user/Cloud/alpha"]],
    ["Research", false, [], ["/Users/example-user/Cloud/alpha"]],
    ["beta", false, [], ["/Users/example-user/Projects/beta"]],
    ["", true, ["beta"], ["/Users/example-user/Projects/beta"]],
    ["missing", true, ["beta"], []],
  ]) {
    const filtered = filterWorkspaceEntries(entries, query, runningOnly, new Set(runningIds), label);
    assert.deepEqual(filtered.map(({ project }) => project.path), expected);
    assert.deepEqual(workspaceOptions.map(({ path }) => path), choices);
  }
  assert.deepEqual(entries.map(({ sessions }) => sessions.map(({ id }) => id)), [["alpha"], ["beta"], ["temp"]]);
});

test("filtering a real temporary workspace never reclassifies its empty chats as fixtures", () => {
  const { entries, workspaceOptions } = deriveWorkspaceEntries([{ path: "/tmp/real" }], [
    session("real", { projectRoot: "/tmp/real", firstMessage: "actual conversation" }),
    session("empty", { projectRoot: "/tmp/real", messageCount: 0, firstMessage: "needle" }),
  ], "Temporary");
  const filtered = filterWorkspaceEntries(entries, "needle", false, new Set(), () => "real");
  assert.equal(filtered[0].project.path, "/tmp/real");
  assert.equal(filtered[0].synthetic, undefined);
  assert.deepEqual(filtered[0].sessions.map(({ id }) => id), ["empty"]);
  assert.deepEqual(workspaceOptions.map(({ path }) => path), ["/tmp/real"]);
});

test("temporary fixture filtering keeps transcripts searchable but never adds runnable paths", () => {
  const { entries, workspaceOptions } = deriveWorkspaceEntries([
    { path: "/tmp/fixture-a" },
    { path: "/var/folders/a/b/T/oc-plg-test" },
  ], [
    session("first", { projectRoot: "/tmp/fixture-a", messageCount: 0, name: "needle" }),
    session("second", { projectRoot: "/var/folders/a/b/T/oc-plg-test", messageCount: 0 }),
  ], "Temporary");
  const filtered = filterWorkspaceEntries(entries, "needle", true, new Set(["first"]), () => "fixture");
  assert.deepEqual(filtered[0].sessions.map(({ id }) => id), ["first"]);
  assert.equal(filtered[0].synthetic, true);
  assert.deepEqual(workspaceOptions, []);
  assert.deepEqual(filterWorkspaceEntries(entries, "missing", false, new Set(), () => "fixture"), []);
});
