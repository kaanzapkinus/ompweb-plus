import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const store = await jiti.import("./session-folders.ts");
const route = await jiti.import("../app/api/session-folders/route.ts");
const { cacheSessionPath, invalidateSessionListCache } = await jiti.import("./session-reader.ts");
const empty = { version: 1, folders: [], assignments: {} };

async function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "omp-web-folders-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const otherProject = join(root, "other-project");
  for (const dir of [agentDir, project, otherProject]) mkdirSync(dir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousPaths = globalThis.__piSessionPathCache;
  const previousIds = globalThis.__piPathToSessionIdCache;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.__piSessionPathCache = new Map();
  globalThis.__piPathToSessionIdCache = new Map();
  invalidateSessionListCache();
  const file = join(agentDir, "session-folders.json");
  function session(id, cwd = project, parentSession) {
    const dir = join(agentDir, "sessions", "-project");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `2026-01-01_${id}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: "2026-01-01T00:00:00.000Z", ...(parentSession ? { parentSession } : {}) })}\n`);
    cacheSessionPath(id, path);
    return path;
  }
  try {
    await run({ root, agentDir, project, otherProject, file, session });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    globalThis.__piSessionPathCache = previousPaths;
    globalThis.__piPathToSessionIdCache = previousIds;
    invalidateSessionListCache();
    rmSync(root, { recursive: true, force: true });
  }
}

function request(method, body) {
  return new Request("http://localhost/api/session-folders", { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
}

function registry(project) {
  return {
    version: 1,
    folders: [
      { id: "folder-first", name: "First", projectPath: project, createdAt: "2026-01-01T00:00:00.000Z", order: 0 },
      { id: "folder-second", name: "Second", projectPath: project, createdAt: "2026-01-01T00:00:00.000Z", order: 1 },
    ],
    assignments: { "session-one": "folder-first", "session-two": "folder-second" },
  };
}

test("missing registry is fresh, empty and never seeded or persisted by GET", async () => {
  await withFixture(async ({ file }) => {
    const first = store.loadSessionFoldersRegistry();
    assert.deepEqual(first, empty);
    first.assignments.changed = "changed";
    first.folders.push({});
    assert.deepEqual(store.loadSessionFoldersRegistry(), empty);
    const response = await route.GET();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), empty);
    assert.equal(existsSync(file), false);
  });
});

test("existing version-one registry stays readable and untouched", async () => {
  await withFixture(async ({ project, file }) => {
    const expected = registry(project);
    delete expected.folders[1].order;
    const original = JSON.stringify(expected);
    writeFileSync(file, original);
    assert.deepEqual(store.loadSessionFoldersRegistry(), expected);
    assert.deepEqual(await (await route.GET()).json(), expected);
    assert.equal(readFileSync(file, "utf8"), original);
  });
});

test("corrupt JSON or shape fails explicitly and cannot be overwritten by a mutation", async () => {
  await withFixture(async ({ project, file }) => {
    const valid = registry(project);
    const cases = [
      "{truncated", "null", "[]", JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, folders: [null] }),
      JSON.stringify({ ...valid, folders: [valid.folders[0], valid.folders[0]] }),
      JSON.stringify({ ...valid, folders: [{ ...valid.folders[0], projectPath: "relative" }] }),
      JSON.stringify({ ...valid, folders: [{ ...valid.folders[0], createdAt: "invalid" }] }),
      JSON.stringify({ ...valid, assignments: [] }),
      JSON.stringify({ ...valid, assignments: { "session-one": "missing-folder" } }),
      JSON.stringify({ ...valid, assignments: JSON.parse('{"__proto__":"folder-first"}') }),
    ];
    for (const original of cases) {
      writeFileSync(file, original);
      assert.throws(() => store.loadSessionFoldersRegistry(), { status: 500 });
      assert.throws(() => store.saveSessionFoldersRegistry(empty), { status: 500 });
      await assert.rejects(store.createSessionFolder("New", project), { status: 500 });
      assert.equal((await route.GET()).status, 500);
      assert.equal(readFileSync(file, "utf8"), original);
    }
  });
});

test("creation, rename, assignment and unassignment persist without changing session bytes", async () => {
  await withFixture(async ({ project, file, session }) => {
    const sessionFile = session("session-one");
    const original = readFileSync(sessionFile, "utf8");
    const created = await route.POST(request("POST", { name: "  Research  ", projectPath: project }));
    assert.equal(created.status, 200);
    const { folder, registry: createdRegistry } = await created.json();
    assert.equal(folder.name, "Research");
    assert.deepEqual(createdRegistry.folders, [folder]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), createdRegistry);
    const renamed = await route.PATCH(request("PATCH", { action: "rename", folderId: folder.id, name: " Notes " }));
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).folders[0].name, "Notes");
    const assigned = await route.PATCH(request("PATCH", { action: "assign", sessionId: "session-one", folderId: folder.id }));
    assert.equal(assigned.status, 200);
    assert.deepEqual((await assigned.json()).assignments, { "session-one": folder.id });
    const unassigned = await route.PATCH(request("PATCH", { action: "assign", sessionId: "session-one", folderId: null }));
    assert.equal(unassigned.status, 200);
    assert.deepEqual((await unassigned.json()).assignments, {});
    assert.equal(readFileSync(sessionFile, "utf8"), original);
  });
});

test("invalid assignment identities are rejected without writing", async () => {
  await withFixture(async ({ project, otherProject, file, session }) => {
    const folder = await store.createSessionFolder("Valid", project);
    session("session-one");
    session("other-session", otherProject);
    const stalePath = session("actual-session");
    cacheSessionPath("wrong-session", stalePath);
    const before = readFileSync(file, "utf8");
    for (const [sessionId, folderId, status] of [
      ["session-one", "missing-folder", 404], ["absent-session", folder.id, 404],
      ["other-session", folder.id, 400], ["wrong-session", folder.id, 404],
      ["__proto__", folder.id, 400], ["constructor", folder.id, 400],
      ["session-one", "__proto__", 400], ["session-one", "", 400],
      ["session-one", false, 400], ["session-one", {}, 400],
    ]) {
      const response = await route.PATCH(request("PATCH", { action: "assign", sessionId, folderId }));
      assert.equal(response.status, status, `${String(sessionId)} -> ${String(folderId)}`);
      assert.equal(readFileSync(file, "utf8"), before);
    }
    await assert.rejects(store.assignSessionToFolder("session-one", "missing-folder"), { status: 404 });
    assert.equal(Object.prototype.polluted, undefined);
  });
});

test("folder deletion only removes its memberships and preserves every native session and ancestry", async () => {
  await withFixture(async ({ project, file, session }) => {
    const parent = session("session-one");
    const child = session("session-two", project, parent);
    const originals = new Map([parent, child].map((path) => [path, readFileSync(path, "utf8")]));
    writeFileSync(file, JSON.stringify(registry(project)));
    const response = await route.PATCH(request("PATCH", { action: "delete", folderId: "folder-first" }));
    assert.equal(response.status, 200);
    const remaining = await response.json();
    assert.deepEqual(remaining.folders.map((folder) => folder.id), ["folder-second"]);
    assert.deepEqual(remaining.assignments, { "session-two": "folder-second" });
    assert.deepEqual(store.loadSessionFoldersRegistry(), remaining);
    for (const [path, original] of originals) assert.equal(readFileSync(path, "utf8"), original);
    assert.equal((await route.PATCH(request("PATCH", { action: "delete", folderId: "missing" }))).status, 404);
  });
});

test("malformed JSON and invalid action shapes return 400 without creating a registry", async () => {
  await withFixture(async ({ file, project }) => {
    for (const method of ["POST", "PATCH"]) {
      const malformed = new Request("http://localhost/api/session-folders", { method, body: "{" });
      assert.equal((await route[method](malformed)).status, 400);
      for (const body of [null, [], "text", 42, {}, { action: "unknown" }]) {
        assert.equal((await route[method](request(method, body))).status, 400);
      }
    }
    for (const body of [
      { action: "rename", folderId: "folder-first", name: 1 },
      { action: "rename", folderId: [], name: "Name" },
      { action: "delete", folderId: {} },
      { action: "assign", sessionId: {} },
    ]) assert.equal((await route.PATCH(request("PATCH", body))).status, 400);
    assert.equal((await route.POST(request("POST", { name: " ", projectPath: project }))).status, 400);
    assert.equal((await route.POST(request("POST", { name: "Name", projectPath: join(project, "missing") }))).status, 400);
    assert.equal(existsSync(file), false);
  });
});

test("project aliases canonicalize and concurrent assignments retain both memberships", async () => {
  await withFixture(async ({ root, project, session }) => {
    const alias = join(root, "project-alias");
    symlinkSync(project, alias, "dir");
    const folder = await store.createSessionFolder("Alias", alias);
    const canonicalFolder = await store.createSessionFolder("Canonical", project);
    assert.equal(folder.projectPath, canonicalFolder.projectPath);
    session("session-one", project);
    session("session-two", alias);
    await Promise.all([
      store.assignSessionToFolder("session-one", folder.id),
      store.assignSessionToFolder("session-two", canonicalFolder.id),
    ]);
    assert.deepEqual(store.loadSessionFoldersRegistry().assignments, { "session-one": folder.id, "session-two": canonicalFolder.id });
  });
});

test("filesystem read failure is explicit rather than an empty writable registry", async () => {
  await withFixture(async ({ file }) => {
    mkdirSync(file);
    assert.throws(() => store.loadSessionFoldersRegistry(), { code: "EISDIR" });
    assert.throws(() => store.saveSessionFoldersRegistry(empty), { code: "EISDIR" });
    assert.deepEqual(readdirSync(file), []);
  });
});

test("filesystem write failure propagates and preserves the complete prior registry", {
  // Unix directory permissions do not constrain root and are not portable to Windows.
  skip: process.getuid?.() === 0 || process.platform === "win32",
}, async () => {
  await withFixture(async ({ agentDir, file, project }) => {
    writeFileSync(file, JSON.stringify(registry(project)));
    const original = readFileSync(file, "utf8");
    chmodSync(agentDir, 0o500);
    try {
      assert.throws(
        () => store.renameSessionFolder("folder-first", "Changed"),
        (error) => error.code === "EACCES" || error.code === "EPERM",
      );
      assert.equal(readFileSync(file, "utf8"), original);
      assert.deepEqual(readdirSync(agentDir), ["session-folders.json"]);
    } finally {
      chmodSync(agentDir, 0o700);
    }
  });
});
