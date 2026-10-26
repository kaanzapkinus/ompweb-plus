import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tryNative: false, alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) } });
const route = await jiti.import("../app/api/sessions/schedule/route.ts");
const executionRoute = await jiti.import("../app/api/sessions/[id]/execution/route.ts");
const execution = await jiti.import("./session-execution.ts");
const reader = await jiti.import("./session-reader.ts");

async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-scheduled-route-"));
  const workspace = join(dir, "workspace");
  const sessions = join(dir, "sessions", "-fixture");
  mkdirSync(workspace);
  mkdirSync(sessions, { recursive: true });
  const previous = { dir: process.env.PI_CODING_AGENT_DIR, disabled: process.env.OMP_WEB_SCHEDULER_DISABLED, sessions: globalThis.__ompSessions, utility: globalThis.__ompUtilityRpcState };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.OMP_WEB_SCHEDULER_DISABLED;
  globalThis.__ompSessions = new Map();
  globalThis.__ompScheduledChats?.clear();
  globalThis.__ompUtilityRpcState = { proc: { isAlive: true, sendCommand: async () => ({ models: [{ provider: "p", id: "m" }] }) }, idleTimer: null, queue: Promise.resolve() };
  reader.invalidateSessionListCache();
  const draft = { cwd: realpathSync(workspace), prompt: "Run only at the scheduled time", provider: "p", modelId: "m", runAt: Date.now() + 60_000, requestId: "a".repeat(32) };
  let creations = 0;
  let names = 0;
  const native = {
    sessionId: "startup", sessionFile: "", isAlive: () => true, isRunning: () => false,
    send: async command => {
      if (command.type === "new_session") {
        creations += 1;
        native.sessionId = `native-${creations}`;
        native.sessionFile = join(sessions, `2026-10-23_native-${creations}.jsonl`);
        // A fixture of the external native transcript boundary, not a production writer.
        writeFileSync(native.sessionFile, `${JSON.stringify({ type: "session", version: 3, id: native.sessionId, cwd: workspace, timestamp: "2026-10-23T12:00:00.000Z" })}\n`);
        reader.cacheSessionPath(native.sessionId, native.sessionFile);
        globalThis.__ompSessions.set(native.sessionId, native);
        return { cancelled: false };
      }
      if (command.type === "set_session_name") { names += 1; return onName?.(); }
      if (command.type === "get_state") return { model: { provider: "p", id: "m" } };
      if (command.type === "set_auto_retry") return {};
      throw new Error(`Unexpected native command: ${command.type}`);
    },
    destroyAndWait: async () => {},
  };
  let onName;
  globalThis.__ompSessions.set(`__scheduled__${draft.requestId}`, native);
  const post = async body => route.POST(new Request("http://localhost/api/sessions/schedule", { method: "POST", body: JSON.stringify(body ?? draft), headers: { "content-type": "application/json" } }));
  try { await run({ dir, sessions, draft, native, post, onName: callback => { onName = callback; }, counts: () => ({ creations, names }) }); }
  finally {
    clearTimeout(globalThis.__ompUtilityRpcState?.idleTimer);
    globalThis.__ompSessions = previous.sessions;
    globalThis.__ompUtilityRpcState = previous.utility;
    globalThis.__ompScheduledChats?.clear();
    if (previous.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.dir;
    if (previous.disabled === undefined) delete process.env.OMP_WEB_SCHEDULER_DISABLED; else process.env.OMP_WEB_SCHEDULER_DISABLED = previous.disabled;
    reader.invalidateSessionListCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const failure of ["name", "job"]) {
  test(`a ${failure} write failure followed by restart recovers the same native chat and one job`, (t) => fixture(async ({ dir, sessions, draft, post, onName, counts }) => {
    const lock = join(dir, "web-session-execution.json.lock");
    onName(() => {
      const store = JSON.parse(readFileSync(join(dir, "web-session-execution.json"), "utf8"));
      assert.equal(store.creations[draft.requestId].sessionId, "native-1", "identity is durable before naming or job writes");
      if (failure === "name") throw new Error("Name save failed");
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
    });
    assert.ok((await post()).status >= 400);
    assert.equal(readdirSync(sessions).length, 1);
    assert.equal(execution.findExecutionRequest(draft.requestId), undefined);
    rmSync(lock, { recursive: true, force: true });
    onName(undefined);
    // Discard every request-local hint, as a new web process must do.
    globalThis.__ompScheduledChats?.clear();
    const conflictingRetry = await post({ ...draft, runAt: draft.runAt + 1000 });
    assert.equal(conflictingRetry.status, 409);
    t.mock.method(Date, "now", () => draft.runAt + 100);
    const recovered = await post();
    assert.equal(recovered.status, 200, JSON.stringify(await recovered.clone().json()));
    const result = await recovered.json();
    assert.equal(result.session.id, "native-1");
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].status, "pending");
    assert.equal(readdirSync(sessions).length, 1);
    assert.equal(counts().creations, 1);
    const retry = await post();
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).jobs[0].id, result.jobs[0].id);
    const conflict = await post({ ...draft, prompt: "Different prompt" });
    assert.equal(conflict.status, 409);
    assert.equal(execution.getExecutionSnapshot("native-1").jobs.length, 1);
  }));
}

test("a crash at an unknown native creation outcome surfaces uncertainty without creating another session", () => fixture(async ({ draft, post, counts, sessions }) => {
  execution.reserveScheduledChatRequest(draft);
  execution.beginScheduledChatCreation(draft.requestId);
  globalThis.__ompScheduledChats?.clear();
  const response = await post();
  assert.equal(response.status, 409);
  assert.equal(counts().creations, 0);
  assert.equal(readdirSync(sessions).length, 0);
  assert.equal(execution.findExecutionRequest(draft.requestId), undefined);
}));

test("a new past-deadline request never starts native creation or writes a journal", () => fixture(async ({ dir, draft, post, counts }) => {
  const response = await post({ ...draft, runAt: Date.now() - 1000 });
  assert.equal(response.status, 400);
  assert.equal(counts().creations, 0);
  assert.equal(existsSync(join(dir, "web-session-execution.json")), false);
}));

test("execution controls on a live moved-from tab read and mutate the actual native identity", () => fixture(async ({ draft, native, sessions, post }) => {
  const created = await post();
  assert.equal(created.status, 200);
  const job = (await created.json()).jobs[0];
  execution.setExecutionMode("native-1", "wait", { provider: "p", modelId: "m" });
  const movedFile = join(sessions, "2026-10-23_moved-1.jsonl");
  writeFileSync(movedFile, `${JSON.stringify({ type: "session", version: 3, id: "moved-1", cwd: draft.cwd, timestamp: "2026-10-23T12:00:00.000Z" })}\n`);
  execution.moveSessionExecution("native-1", "moved-1", movedFile);
  native.sessionId = "moved-1";
  native.sessionFile = movedFile;
  reader.cacheSessionPath("moved-1", movedFile);
  globalThis.__ompSessions.set("moved-1", native);
  const context = { params: Promise.resolve({ id: "native-1" }) };
  const request = (method, body) => new Request("http://localhost/api/sessions/native-1/execution", { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
  const snapshot = await executionRoute.GET(request("GET"), context);
  assert.equal((await snapshot.json()).jobs[0].id, job.id);
  const policy = await executionRoute.PUT(request("PUT", { mode: "fallback" }), context);
  assert.equal(policy.status, 200);
  assert.equal(execution.getExecutionSnapshot("moved-1").policy.mode, "fallback");
  const cancelled = await executionRoute.DELETE(request("DELETE", { jobId: job.id }), context);
  assert.equal(cancelled.status, 200);
  assert.equal(execution.getExecutionSnapshot("moved-1").jobs[0].status, "cancelled");
  const next = await executionRoute.POST(request("POST", { prompt: "Later again", runAt: draft.runAt + 1000, provider: "p", modelId: "m", requestId: "b".repeat(32) }), context);
  assert.equal(next.status, 200);
  assert.equal(execution.getExecutionSnapshot("moved-1").jobs.length, 2);
  assert.deepEqual(execution.getExecutionSnapshot("native-1"), { policy: { mode: "fallback" }, jobs: [] });
}));

test("a lost successful response is recoverable with the original request after its deadline", (t) => fixture(async ({ draft, post, counts }) => {
  const firstResponse = await post();
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  globalThis.__ompScheduledChats?.clear();
  t.mock.method(Date, "now", () => draft.runAt + 100);
  const retry = await post();
  assert.equal(retry.status, 200);
  const recovered = await retry.json();
  assert.equal(recovered.session.id, first.session.id);
  assert.equal(recovered.jobs[0].id, first.jobs[0].id);
  assert.equal(counts().creations, 1);
  for (const patch of [{ prompt: "Changed" }, { provider: "other" }, { modelId: "other" }, { runAt: draft.runAt + 1000 }]) {
    const conflict = await post({ ...draft, ...patch });
    assert.equal(conflict.status, 409);
  }
}));

test("scheduled logical membership binds the real native identity and conflicting same-cwd selection cannot replay the request", () => fixture(async ({ draft, post, dir, counts }) => {
  const workspaces = await jiti.import("./workspaces.ts");
  const selected = await workspaces.createWorkspace("Selected", draft.cwd);
  const other = await workspaces.createWorkspace("Same directory, different topic", draft.cwd);
  const body = { ...draft, workspaceId: selected.id };
  const response = await post(body);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const result = await response.json();
  assert.equal(realpathSync(result.session.cwd), realpathSync(draft.cwd));
  assert.equal((await workspaces.loadWorkspacesRegistry()).assignments[result.session.id], selected.id);
  const journal = JSON.parse(readFileSync(join(dir, "web-session-execution.json"), "utf8"));
  assert.equal(journal.creations[draft.requestId].draft.workspaceId, selected.id);
  assert.equal((await post({ ...body, workspaceId: other.id })).status, 409);
  assert.equal((await post(body)).status, 200);
  assert.equal(counts().creations, 1);
}));

test("unknown or inconsistent scheduled workspace selection cannot cross the native creation boundary", () => fixture(async ({ draft, post, dir, counts }) => {
  const workspaces = await jiti.import("./workspaces.ts");
  const selected = await workspaces.createWorkspace("Selected", dir);
  assert.equal((await post({ ...draft, workspaceId: selected.id })).status, 400);
  assert.equal((await post({ ...draft, workspaceId: "missing-workspace" })).status, 404);
  assert.equal(counts().creations, 0);
}));
