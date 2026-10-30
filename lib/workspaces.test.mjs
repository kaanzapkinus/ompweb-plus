import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) } });
const store = await jiti.import("./workspaces.ts");
const route = await jiti.import("../app/api/workspaces/route.ts");
const reader = await jiti.import("./session-reader.ts");
const authorization = await jiti.import("./file-authorization.ts");
async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "omp-workspaces-"));
  const agent = join(root, "agent"), project = join(root, "project"), other = join(root, "other");
  for (const path of [agent, project, other]) mkdirSync(path);
  const previous = process.env.PI_CODING_AGENT_DIR;
  const paths = globalThis.__piSessionPathCache, ids = globalThis.__piPathToSessionIdCache;
  const allowed = globalThis.__piAllowedRootsCache, additional = globalThis.__piAdditionalAllowedRoots;
  globalThis.__piAllowedRootsCache = undefined;
  globalThis.__piAdditionalAllowedRoots = new Set();
  process.env.PI_CODING_AGENT_DIR = agent;
  globalThis.__piSessionPathCache = new Map(); globalThis.__piPathToSessionIdCache = new Map();
  reader.invalidateSessionListCache();
  function session(id, cwd = project, parentSession) {
    const dir = join(agent, "sessions", "-fixture"); mkdirSync(dir, { recursive: true });
    const file = join(dir, `2026-01-01_${id}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: "2026-01-01T00:00:00.000Z", ...(parentSession ? { parentSession } : {}) })}\n`);
    reader.cacheSessionPath(id, file); reader.invalidateSessionListCache(); return file;
  }
  try { await run({ root, agent, project, other, session, file: join(agent, "workspaces.json"), legacy: join(agent, "session-folders.json") }); }
  finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    globalThis.__piSessionPathCache = paths; globalThis.__piPathToSessionIdCache = ids;
    globalThis.__piAllowedRootsCache = allowed; globalThis.__piAdditionalAllowedRoots = additional;
    reader.invalidateSessionListCache(); rmSync(root, { recursive: true, force: true });
  }
}
const request = (method, body) => new Request("http://localhost/api/workspaces", { method, body: JSON.stringify(body) });
const folder = (id, name, projectPath, order = 0) => ({ id, name, projectPath, order, createdAt: "2026-01-01T00:00:00.000Z" });

test("legacy same-name folders merge across directories and materialize descendant inheritance without transcript writes", () => fixture(async ({ project, other, session, legacy, file }) => {
  const parent = session("parent"), child = session("child", project, parent), grandchild = session("grandchild", project, "child");
  const explicit = session("explicit", other, parent), cousin = session("cousin", other);
  const originals = new Map([parent, child, grandchild, explicit, cousin].map(p => [p, readFileSync(p, "utf8")]));
  const old = JSON.stringify({ version: 1, folders: [folder("a", "Research", project), folder("b", " research ", other, 1), folder("c", "Companion", project, 2)], assignments: { parent: "a", cousin: "b", explicit: "c", "missing-old-session": "b" } });
  writeFileSync(legacy, old);
  const result = await store.loadWorkspacesRegistry();
  assert.equal(result.workspaces.length, 2);
  const research = result.workspaces.find(w => w.name === "Research"), companion = result.workspaces.find(w => w.name === "Companion");
  assert.ok(research && companion);
  assert.deepEqual(result.assignments, { parent: research.id, child: research.id, grandchild: research.id, cousin: research.id, explicit: companion.id, "missing-old-session": research.id });
  assert.equal(readFileSync(legacy, "utf8"), old);
  for (const [path, bytes] of originals) assert.equal(readFileSync(path, "utf8"), bytes);
  const saved = readFileSync(file, "utf8");
  assert.deepEqual(await store.loadWorkspacesRegistry(), result); assert.equal(readFileSync(file, "utf8"), saved);
}));

test("hidden projects with unassigned chats become directory defaults, but hidden empty projects do not", () => fixture(async ({ agent, project, other, session }) => {
  session("hidden-chat", project);
  writeFileSync(join(agent, "projects.json"), JSON.stringify({ version: 1, projects: [{ path: project, hidden: true, addedAt: "2026-01-01T00:00:00Z", alias: "Hidden with chat" }, { path: other, hidden: true, addedAt: "2026-01-01T00:00:00Z" }] }));
  const response = await route.GET(); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json(); assert.equal(result.workspaces.length, 1);
  assert.equal(result.workspaces[0].cwd, realpathSync.native(project)); assert.equal(result.assignments["hidden-chat"], result.workspaces[0].id);
}));

test("empty workspaces authorize document access before any chat and after server-root recovery", () => fixture(async ({ project, other }) => {
  const document = join(project, "unsent-document.txt"), unrelated = join(other, "outside.txt");
  writeFileSync(document, "Original document bytes"); writeFileSync(unrelated, "Unrelated workspace bytes");
  const segments = file => realpathSync.native(file).replace(/\\/g, "/").split("/").filter(Boolean);
  const created = await route.POST(request("POST", { name: "Empty attachment workspace", cwd: project }));
  assert.equal(created.status, 200);
  assert.equal((await authorization.authorizeFileAccess(segments(document), null, false)).ok, true, "creating an empty workspace must authorize its document directory");
  globalThis.__piAllowedRootsCache = undefined; globalThis.__piAdditionalAllowedRoots = new Set();
  assert.equal((await route.GET()).status, 200);
  assert.equal((await authorization.authorizeFileAccess(segments(document), null, false)).ok, true, "reopening persisted empty workspaces must recover file-root authority");
  assert.equal((await authorization.authorizeFileAccess(segments(unrelated), null, false)).ok, false);
  assert.deepEqual(await reader.listAllSessions(), []);
  assert.equal(readFileSync(document, "utf8"), "Original document bytes");
}));

test("independent same-cwd workspaces accept cross-directory memberships and unassignment returns to directory default", () => fixture(async ({ project, other, session }) => {
  const native = session("chat", other), bytes = readFileSync(native, "utf8");
  const first = await store.createWorkspace("First", project), second = await store.createWorkspace("Second", project);
  assert.notEqual(first.id, second.id); assert.equal(first.cwd, second.cwd);
  await store.assignSessionToWorkspace("chat", first.id);
  assert.equal((await store.loadWorkspacesRegistry()).assignments.chat, first.id);
  const renamed = await route.PATCH(request("PATCH", { action: "rename", workspaceId: first.id, name: "Renamed" }));
  assert.equal(renamed.status, 200); assert.equal((await renamed.json()).workspaces.find(w => w.id === first.id).name, "Renamed");
  await store.assignSessionToWorkspace("chat", null);
  let result = await store.loadWorkspacesRegistry(); assert.equal(result.workspaces.find(w => w.id === result.assignments.chat).cwd, realpathSync.native(other));
  await store.assignSessionToWorkspace("chat", second.id);
  assert.equal((await route.PATCH(request("PATCH", { action: "delete", workspaceId: second.id }))).status, 200);
  result = await store.loadWorkspacesRegistry(); assert.ok(!result.workspaces.some(w => w.id === second.id)); assert.ok(result.assignments.chat);
  assert.equal(readFileSync(native, "utf8"), bytes);
}));

test("unknown and unsafe identities never modify persisted membership", () => fixture(async ({ project, session, file }) => {
  const workspace = await store.createWorkspace("Valid", project); session("chat");
  await store.loadWorkspacesRegistry(); const before = readFileSync(file, "utf8");
  for (const [sessionId, workspaceId, status] of [["chat", "missing", 404], ["missing", workspace.id, 404], ["__proto__", workspace.id, 400], ["chat", "__proto__", 400]]) {
    const response = await route.PATCH(request("PATCH", { action: "assign", sessionId, workspaceId }));
    assert.equal(response.status, status); assert.equal(readFileSync(file, "utf8"), before);
  }
}));

test("corrupt workspace or legacy storage fails closed instead of being replaced", () => fixture(async ({ project, file, legacy }) => {
  for (const path of [legacy, file]) {
    for (const bytes of ["{broken", "null", JSON.stringify({ version: 1, workspaces: [], assignments: { chat: "missing" } })]) {
      writeFileSync(path, bytes);
      await assert.rejects(store.loadWorkspacesRegistry(), { status: 500 });
      await assert.rejects(store.createWorkspace("New", project), { status: 500 });
      assert.throws(() => store.saveWorkspacesRegistry({ version: 1, workspaces: [], assignments: {} }), { status: 500 });
      assert.equal((await route.GET()).status, 500); assert.equal(readFileSync(path, "utf8"), bytes);
      if (path === legacy) assert.equal(existsSync(file), false);
    }
    rmSync(path);
  }
}));

test("legacy invalid cwd falls back to member cwd and symlink creation retains the actual directory rather than repository root", () => fixture(async ({ root, project, session, legacy }) => {
  session("member"); writeFileSync(legacy, JSON.stringify({ version: 1, folders: [folder("old", "Topic", join(root, "gone"))], assignments: { member: "old" } }));
  const migrated = await store.loadWorkspacesRegistry(); assert.equal(migrated.workspaces[0].cwd, realpathSync.native(project));
  const nested = join(project, "nested"); mkdirSync(nested); const alias = join(root, "alias"); symlinkSync(nested, alias, "dir");
  const response = await route.POST(request("POST", { name: "Nested", cwd: alias })); assert.equal(response.status, 200);
  assert.equal((await response.json()).workspaces.find(w => w.name === "Nested").cwd, realpathSync.native(nested));
}));

test("concurrent workspace edits retain both memberships and native identity moves preserve logical membership", () => fixture(async ({ project, session }) => {
  session("one"); session("two");
  const a = await store.createWorkspace("A", project), b = await store.createWorkspace("B", project);
  await Promise.all([store.assignSessionToWorkspace("one", a.id), store.assignSessionToWorkspace("two", b.id)]);
  store.moveSessionWorkspace("one", "moved");
  const result = await store.loadWorkspacesRegistry(); assert.equal(result.assignments.moved, a.id); assert.equal(result.assignments.two, b.id);
}));

test("new-session route assigns the real native ID for ensure_session and never forwards workspace metadata", () => fixture(async ({ project, session }) => {
  const newRoute = await jiti.import("../app/api/agent/new/route.ts");
  const workspace = await store.createWorkspace("Selected", project);
  const nativeFile = session("real-native");
  const previous = globalThis.__ompStartLocks, previousSessions = globalThis.__ompSessions;
  const commands = [];
  const native = { sessionId: "real-native", sessionFile: nativeFile, send: async command => { commands.push(command); return {}; }, destroyAndWait: async () => {} };
  globalThis.__ompSessions = new Map();
  globalThis.__ompStartLocks = { get: key => key.startsWith("__new__") ? Promise.resolve({ session: native, realSessionId: "real-native" }) : undefined };
  try {
    const ensured = await newRoute.POST(request("POST", { cwd: project, workspaceId: workspace.id, type: "ensure_session" }));
    assert.equal(ensured.status, 200); assert.equal((await ensured.json()).sessionId, "real-native");
    assert.equal((await store.loadWorkspacesRegistry()).assignments["real-native"], workspace.id);
    const prompted = await newRoute.POST(request("POST", { cwd: project, workspaceId: workspace.id, type: "prompt", message: "Hello", sessionId: "forged" }));
    assert.equal(prompted.status, 200); assert.deepEqual(commands, [{ type: "prompt", message: "Hello" }]);
  } finally { globalThis.__ompStartLocks = previous; globalThis.__ompSessions = previousSessions; }
}));

test("new-session workspace selection rejects unknown IDs and a different execution cwd before spawning", () => fixture(async ({ project, other }) => {
  const newRoute = await jiti.import("../app/api/agent/new/route.ts");
  const workspace = await store.createWorkspace("Selected", project);
  assert.equal((await newRoute.POST(request("POST", { cwd: other, workspaceId: workspace.id, type: "ensure_session" }))).status, 400);
  assert.equal((await newRoute.POST(request("POST", { cwd: project, workspaceId: "missing", type: "ensure_session" }))).status, 404);
}));

test("registered directories represented by logical workspaces do not create extra empty default rows", () => fixture(async ({ agent, project, file }) => {
  writeFileSync(join(agent, "projects.json"), JSON.stringify({ version: 1, projects: [{ path: project, hidden: false, addedAt: "2026-01-01T00:00:00Z" }] }));
  writeFileSync(file, JSON.stringify({ version: 1, workspaces: [{ id: "logical", name: "Topic", cwd: realpathSync.native(project), createdAt: "2026-01-01T00:00:00Z", order: 0 }], assignments: {} }));
  const registry = await store.loadWorkspacesRegistry();
  assert.deepEqual(registry.workspaces.map(item => item.id), ["logical"]);
}));

test("empty selected-workspace runtimes are persisted through native new_session before membership is attached", () => fixture(async ({ project, session }) => {
  const newRoute = await jiti.import("../app/api/agent/new/route.ts");
  const workspace = await store.createWorkspace("Empty chat", project);
  const previous = globalThis.__ompStartLocks, previousSessions = globalThis.__ompSessions;
  let persisted = 0;
  const native = {
    sessionId: "unpersisted", sessionFile: "",
    async send(command) {
      assert.equal(command.type, "new_session");
      persisted += 1; native.sessionId = "persisted-native"; native.sessionFile = session(native.sessionId);
      return { cancelled: false, newSessionId: native.sessionId };
    }, destroyAndWait: async () => {},
  };
  globalThis.__ompSessions = new Map();
  globalThis.__ompStartLocks = { get: () => Promise.resolve({ session: native, realSessionId: "unpersisted" }) };
  try {
    const response = await newRoute.POST(request("POST", { cwd: project, workspaceId: workspace.id, type: "ensure_session" }));
    assert.equal(response.status, 200); assert.equal((await response.json()).sessionId, "persisted-native"); assert.equal(persisted, 1);
    assert.equal((await store.loadWorkspacesRegistry()).assignments["persisted-native"], workspace.id);
  } finally { globalThis.__ompStartLocks = previous; globalThis.__ompSessions = previousSessions; }
}));

test("workspace creation accepts a genuine linked Git worktree but rejects foreign, sibling and inferred leftover directories", () => fixture(async ({ root, project, other, session }) => {
  const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  for (const cwd of [project, other]) {
    git(cwd, ["init"]);
    git(cwd, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
  }
  const linked = join(root, "linked");
  git(project, ["worktree", "add", "-b", "fixture-linked", linked]);
  const workspace = await store.createWorkspace("Repository topic", project);
  const transcript = session("existing-chat", project), bytes = readFileSync(transcript, "utf8");
  assert.equal(await store.workspaceCreationCwd(project, workspace.id), realpathSync.native(project));
  assert.equal(await store.workspaceCreationCwd(linked, workspace.id), realpathSync.native(linked));
  const alias = join(root, "linked-alias"); symlinkSync(linked, alias, "dir");
  assert.equal(await store.workspaceCreationCwd(alias, workspace.id), realpathSync.native(linked));
  const sibling = join(root, "sibling"), nested = join(project, "nested"), leftover = join(`${project}-worktrees`, "leftover");
  for (const cwd of [sibling, nested, leftover]) mkdirSync(cwd, { recursive: true });
  for (const cwd of [other, sibling, nested, leftover]) await assert.rejects(store.workspaceCreationCwd(cwd, workspace.id), { status: 400 });
  // Both creation routes share validation, so native execution receives the
  // explicitly selected real worktree while logical membership remains stable.
  assert.equal(readFileSync(transcript, "utf8"), bytes);
  assert.equal((await store.loadWorkspacesRegistry()).workspaces.find(item => item.id === workspace.id).cwd, realpathSync.native(project));
}));

test("filesystem root remains a usable execution directory", () => fixture(async ({ project }) => {
  const root = parse(project).root;
  const workspace = await store.createWorkspace("Root", root);
  assert.equal(workspace.cwd, realpathSync.native(root));
  assert.equal(await store.workspaceCreationCwd(root, workspace.id), realpathSync.native(root));
}));

test("consolidating every conversation removes the old empty directory workspace", () => fixture(async ({ agent, project, other, session }) => {
  session("consolidated-chat", project);
  writeFileSync(join(agent, "projects.json"), JSON.stringify({ version: 1, projects: [{ path: project, hidden: false, addedAt: "2026-01-01T00:00:00Z" }] }));
  const topic = await store.createWorkspace("Selected topic", other);
  await store.assignSessionToWorkspace("consolidated-chat", topic.id);
  const registry = await store.loadWorkspacesRegistry();
  assert.deepEqual(registry.workspaces.map(workspace => workspace.id), [topic.id]);
  assert.equal(registry.assignments["consolidated-chat"], topic.id);
  assert.deepEqual(await store.loadWorkspacesRegistry(), registry);
}));

test("a linked-worktree workspace can create a chat in its repository main checkout", () => fixture(async ({ root, project }) => {
  const git = args => execFileSync("git", ["-C", project, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
  const linked = join(root, "linked");
  git(["worktree", "add", "-b", "fixture-linked", linked]);
  const workspace = await store.createWorkspace("Linked topic", linked);
  assert.equal(await store.workspaceCreationCwd(project, workspace.id), realpathSync.native(project));
}));
