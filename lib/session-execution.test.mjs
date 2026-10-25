import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-execution-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try { await run(await jiti.import("./session-execution.ts"), dir); }
  finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(dir, { recursive: true, force: true }); }
}

test("execution policy is per chat and cancelling a job prevents claiming it", () => fixture((m) => {
  m.setExecutionMode("one", "wait");
  assert.equal(m.getExecutionSnapshot("one").policy.mode, "wait");
  assert.equal(m.getExecutionSnapshot("two").policy.mode, "fallback");
  const job = m.createExecutionJob("one", { prompt: "Do work", provider: "p", modelId: "m", runAt: Date.now() + 1000 });
  m.cancelExecutionJob("one", job.id);
  assert.equal(m.claimExecutionJob(Date.now() + 2000), null);
  assert.equal(m.getExecutionSnapshot("one").jobs[0].status, "cancelled");
}));

test("creation retries reuse the original durable job even after its deadline", (t) => fixture((m) => {
  const body = { prompt: "Once", provider: "p", modelId: "m", runAt: Date.now() + 1000, requestId: "request-1" };
  const first = m.createExecutionJob("one", body);
  t.mock.method(Date, "now", () => body.runAt + 100);
  assert.equal(m.createExecutionJob("one", body).id, first.id);
  assert.equal(m.getExecutionSnapshot("one").jobs.length, 1);
}));

test("scheduled options survive reload and edits while original request retries retain the edited job", () => fixture((m, dir) => {
  const body = {
    prompt: "Original", provider: "p", modelId: "m", runAt: Date.now() + 60_000, requestId: "immutable-intent",
    images: [{ data: "aGVsbG8=", mimeType: "image/png" }], thinkingLevel: "high", toolPreset: "none",
    fastMode: false, slowMode: true, advisorEnabled: false,
  };
  const first = m.createExecutionJob("one", body);
  const reloaded = createJiti(import.meta.url, { moduleCache: false })("./session-execution.ts");
  assert.deepEqual(reloaded.getExecutionSnapshot("one").jobs[0].images, body.images);
  assert.equal(reloaded.getExecutionSnapshot("one").jobs[0].slowMode, true);
  const changed = { ...body, prompt: "Edited", runAt: body.runAt + 60_000, thinkingLevel: "low", images: [{ data: "d29ybGQ=", mimeType: "image/jpeg" }] };
  const edited = reloaded.editExecutionJob("one", first.id, changed, first.updatedAt);
  assert.ok(edited.updatedAt > first.updatedAt);
  assert.equal(reloaded.createExecutionJob("one", body).prompt, "Edited");
  assert.deepEqual(reloaded.createExecutionJob("one", body).images, changed.images);
  assert.throws(() => reloaded.createExecutionJob("one", changed), error => error.status === 409);
  assert.throws(() => reloaded.editExecutionJob("one", first.id, body, first.updatedAt), error => error.status === 409);
  assert.equal(reloaded.getExecutionSnapshot("one").jobs.length, 1);
  const persisted = JSON.parse(readFileSync(join(dir, "web-session-execution.json"), "utf8"));
  assert.equal(persisted.jobs[0].originalRequest.prompt, "Original");
  assert.equal(persisted.jobs[0].prompt, "Edited");
}));

test("editing and dismissing enforce job lifecycle without reviving failed or cancelled requests", () => fixture((m) => {
  const body = { prompt: "Only once", provider: "p", modelId: "m", runAt: Date.now() + 1000, requestId: "dismissed-intent" };
  const first = m.createExecutionJob("one", body);
  assert.throws(() => m.dismissExecutionJob("one", first.id), error => error.status === 409);
  m.claimExecutionJob(body.runAt + 1);
  assert.throws(() => m.editExecutionJob("one", first.id, { ...body, prompt: "Too late" }), error => error.status === 409);
  m.recordExecutionEvent("one", { type: "prompt_error", errorMessage: "Provider rejected the request", provider: "p", model: "m" });
  m.dismissExecutionJob("one", first.id);
  const dismissed = m.getExecutionSnapshot("one").jobs[0];
  assert.equal(dismissed.status, "failed");
  assert.ok(Number.isFinite(dismissed.dismissedAt));
  assert.equal(m.createExecutionJob("one", body).dismissedAt, dismissed.dismissedAt);
  assert.equal(m.claimExecutionJob(body.runAt + 2000), null);
  assert.throws(() => m.editExecutionJob("one", first.id, body), error => error.status === 409);
  assert.throws(() => m.dismissExecutionJob("different", first.id), error => error.status === 404);
  const pending = m.createExecutionJob("one", { ...body, requestId: "cancelled-intent" });
  m.cancelExecutionJob("one", pending.id);
  assert.throws(() => m.editExecutionJob("one", pending.id, body), error => error.status === 409);
}));

test("quota continuations keep original options but reject prompt editing and cancel on manual next turn", () => fixture((m) => {
  const body = { prompt: "Never resend", provider: "p", modelId: "m", runAt: Date.now() + 1000, images: [{ data: "aGVsbG8=", mimeType: "image/png" }] };
  const first = m.createExecutionJob("one", body);
  m.claimExecutionJob(body.runAt + 1);
  m.recordExecutionEvent("one", { type: "prompt_error", errorMessage: "429 quota exhausted", provider: "p", model: "m" });
  const waiting = m.getExecutionSnapshot("one").jobs[0];
  assert.equal(waiting.continuation, true);
  assert.deepEqual(waiting.images, body.images);
  assert.throws(() => m.editExecutionJob("one", first.id, { ...body, runAt: Date.now() + 60_000 }), error => error.status === 409);
  m.setExecutionTime("one", Date.now() + 60_000, first.id);
  m.cancelAutomaticResumes("one");
  assert.equal(m.getExecutionSnapshot("one").jobs[0].status, "cancelled");
}));

for (const action of ["manual", "fallback"]) {
  test(`${action} cancellation wins over an uncommitted scheduled quota receipt`, () => fixture((m, dir) => {
    const job = m.createExecutionJob("one", { prompt: "Never replay", provider: "p", modelId: "m", runAt: Date.now() + 1000 });
    m.claimExecutionJob(Date.now() + 2000);
    const lock = join(dir, "web-session-execution.json.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(process.pid));
    assert.throws(() => m.recordExecutionEvent("one", { type: "prompt_error", errorMessage: "429 quota exhausted", provider: "p", model: "m" }), error => error.status === 409);
    rmSync(lock, { recursive: true });
    if (action === "manual") m.cancelAutomaticResumes("one");
    else m.setExecutionMode("one", "fallback");
    m.flushExecutionReceipts();
    assert.equal(m.findExecutionJob(job.id).status, "cancelled");
    assert.equal(m.claimExecutionJob(Date.now() + 5000), null);
  }));
}

test("scheduled payload validation rejects malformed options and accepts image-only prompts", () => fixture((m) => {
  const body = { prompt: "", provider: "p", modelId: "m", runAt: Date.now() + 60_000, images: [{ data: "aGVsbG8=", mimeType: "image/png" }] };
  assert.equal(m.createExecutionJob("one", body).prompt, "");
  assert.equal(m.createExecutionJob("ten", { ...body, images: Array.from({ length: 10 }, () => body.images[0]) }).images.length, 10);
  for (const patch of [
    { images: [{ data: "invalid", mimeType: "image/png" }] }, { images: Array.from({ length: 11 }, () => body.images[0]) },
    { images: "not images" }, { toolPreset: "arbitrary" }, { fastMode: "false" }, { slowMode: null }, { advisorEnabled: 1 }, { thinkingLevel: "" },
  ]) assert.throws(() => m.createExecutionJob("one", { ...body, ...patch }), error => error.status === 400);
  assert.throws(() => m.createExecutionJob("one", { ...body, prompt: "/compact" }), error => error.status === 400 && /images/.test(error.message));
  assert.throws(() => m.createExecutionJob("one", { ...body, images: [], prompt: "/name" }), error => error.status === 400);
}));

test("native dispatch uses edited options and images, then quota resume sends only the continuation", (t) => fixture(async (m, dir) => {
  const reader = await jiti.import("./session-reader.ts");
  const scheduler = await jiti.import("./execution-scheduler.ts");
  const { RESUME_PROMPT } = await jiti.import("./session-resume.ts");
  const file = join(dir, "options.jsonl");
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "options", cwd: dir, timestamp: "2026-10-25T00:00:00Z" })}\n`);
  reader.cacheSessionPath("options", file);
  const now = Date.now();
  const first = m.createExecutionJob("options", { prompt: "Original", provider: "p", modelId: "m", runAt: now + 1000 });
  m.editExecutionJob("options", first.id, {
    prompt: "", provider: "selected", modelId: "selected-model", runAt: now + 2000,
    images: [{ data: "aGVsbG8=", mimeType: "image/png" }], thinkingLevel: "high", toolPreset: "none",
    fastMode: false, slowMode: true, advisorEnabled: true,
  }, first.updatedAt);
  const previousRegistry = globalThis.__ompSessions;
  const commands = [];
  const acquired = [];
  let quota = true;
  const native = {
    sessionId: "options", sessionFile: file, isAlive: () => true, isRunning: () => false,
    acquireExecution: async (id, options) => { acquired.push({ id, toolPreset: options.toolPreset, advisorEnabled: options.advisorEnabled }); return true; },
    releaseExecution: () => {}, onEvent: () => () => {},
    async send(command) {
      commands.push(command);
      if (command.type === "prompt") m.recordExecutionEvent("options", quota
        ? { type: "prompt_error", errorMessage: "429 quota exhausted", provider: "selected", model: "selected-model" }
        : { type: "agent_end", isTerminal: true });
    },
  };
  globalThis.__ompSessions = new Map([["options", native]]);
  let clock = now + 3000;
  t.mock.method(Date, "now", () => clock);
  try {
    await scheduler.runExecutionTick();
    assert.deepEqual(acquired, [{ id: first.id, toolPreset: "none", advisorEnabled: true }]);
    assert.deepEqual(commands, [
      { type: "set_auto_retry", enabled: false },
      { type: "set_model", provider: "selected", modelId: "selected-model" },
      { type: "set_thinking_level", level: "high" },
      { type: "set_fast_mode", enabled: false },
      { type: "set_slow_mode", enabled: true },
      { type: "prompt", message: "", images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
    ]);
    assert.equal(m.getExecutionSnapshot("options").jobs[0].continuation, true);
    m.setExecutionTime("options", now + 10_000, first.id);
    quota = false;
    clock = now + 11_000;
    await scheduler.runExecutionTick();
    assert.deepEqual(commands.at(-1), { type: "prompt", message: RESUME_PROMPT });
    assert.equal(commands.filter(command => command.images).length, 1);
    assert.equal(m.getExecutionSnapshot("options").jobs[0].status, "completed");
  } finally { globalThis.__ompSessions = previousRegistry; }
}));

test("a dismissed uncertain job cannot be revived by a delayed quota receipt", () => fixture((m, dir) => {
  const job = m.createExecutionJob("one", { prompt: "Never replay", provider: "p", modelId: "m", runAt: Date.now() + 1000 });
  m.claimExecutionJob(Date.now() + 2000);
  const lock = join(dir, "web-session-execution.json.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(process.pid));
  assert.throws(() => m.recordExecutionEvent("one", { type: "prompt_error", errorMessage: "429 quota exhausted", provider: "p", model: "m" }), error => error.status === 409);
  rmSync(lock, { recursive: true });
  m.updateExecutionJob(job.id, { status: "uncertain", error: "Delivery unknown" });
  m.dismissExecutionJob("one", job.id);
  m.flushExecutionReceipts();
  assert.equal(m.getExecutionSnapshot("one").jobs[0].status, "uncertain");
  assert.equal(m.claimExecutionJob(Date.now() + 5000), null);
}));

test("execution API creates, edits, cancels and dismisses durable jobs and recovers an accepted image request", () => fixture(async (m, dir) => {
  const reader = await jiti.import("./session-reader.ts");
  const route = await jiti.import("../app/api/sessions/[id]/execution/route.ts");
  const scheduleRoute = await jiti.import("../app/api/sessions/schedule/route.ts");
  // Match the route's module identity rather than mixing alias and native .ts imports.
  const native = await jiti.import("@/lib/omp/rpc-process");
  const folder = join(dir, "sessions", "-workspace");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "api-scheduled.jsonl");
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "api-scheduled", cwd: dir, timestamp: "2026-10-25T00:00:00Z" })}\n`);
  reader.cacheSessionPath("api-scheduled", file);
  reader.invalidateSessionListCache();
  const oldUtility = globalThis.__ompUtilityRpcState;
  let catalogFailure = false;
  const utility = {
    proc: {
      isAlive: true,
      async sendCommand(command) {
        assert.equal(command.type, "get_available_models");
        if (catalogFailure) throw new native.RpcCommandError(command.type, "Provider catalog failed", "provider_catalog_failed");
        return { models: [{ provider: "p", id: "m" }] };
      },
    },
    idleTimer: null, queue: Promise.resolve(),
  };
  globalThis.__ompUtilityRpcState = utility;
  const context = { params: Promise.resolve({ id: "api-scheduled" }) };
  const invoke = (method, body) => route[method](new Request("http://localhost/api/sessions/api-scheduled/execution", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), context);
  const original = {
    prompt: "", provider: "p", modelId: "m", runAt: Date.now() + 60_000, requestId: "0123456789abcdef0123456789abcdef",
    images: [{ data: "aGVsbG8=", mimeType: "image/png" }], thinkingLevel: "high", toolPreset: "none", fastMode: false, slowMode: true, advisorEnabled: false,
  };
  try {
    const created = await invoke("POST", original);
    assert.equal(created.status, 200);
    const first = (await created.json()).jobs[0];
    assert.equal(first.images, undefined);
    assert.equal(first.imageCount, 1);
    const imageResponse = await route.GET(new Request(`http://localhost/api/sessions/api-scheduled/execution?jobId=${first.id}`), context);
    assert.equal(imageResponse.status, 200);
    assert.deepEqual((await imageResponse.json()).jobs[0].images, original.images);
    assert.equal((await route.GET(new Request("http://localhost/api/sessions/api-scheduled/execution?jobId=another-job"), context)).status, 404);
    assert.equal(first.requestId, original.requestId);
    const changed = await invoke("PUT", { ...original, jobId: first.id, prompt: "Edited", images: [], expectedUpdatedAt: first.updatedAt });
    assert.equal(changed.status, 200);
    const edited = (await changed.json()).jobs[0];
    assert.equal(edited.prompt, "Edited");
    assert.equal(edited.thinkingLevel, "high");
    assert.equal((await invoke("PUT", { ...original, jobId: first.id, expectedUpdatedAt: first.updatedAt })).status, 409);
    catalogFailure = true;
    const retry = await invoke("POST", original);
    assert.equal(retry.status, 200, "recovery must not depend on today's model catalog");
    assert.equal((await retry.json()).jobs[0].prompt, "Edited");
    const providerError = await invoke("POST", { ...original, requestId: "different-request" });
    const providerBody = await providerError.json();
    assert.equal(providerError.status, 400, JSON.stringify(providerBody));
    assert.equal(providerBody.code, "provider_catalog_failed");
    const recovered = await scheduleRoute.GET(new Request(`http://localhost/api/sessions/schedule?requestId=${original.requestId}`));
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).session.id, "api-scheduled");
    assert.equal((await invoke("DELETE", { jobId: first.id })).status, 200);
    const dismissed = await invoke("PUT", { dismissJobId: first.id });
    assert.equal(dismissed.status, 200);
    assert.ok((await dismissed.json()).jobs[0].dismissedAt);
    assert.equal(m.claimExecutionJob(Date.now() + 120_000), null);
    const missing = await scheduleRoute.GET(new Request("http://localhost/api/sessions/schedule?requestId=ffffffffffffffffffffffffffffffff"));
    assert.equal(missing.status, 404);
    catalogFailure = false;
    const queued = await invoke("POST", { ...original, requestId: "running-request" });
    assert.equal(queued.status, 200);
    const running = (await queued.json()).jobs.find(job => job.id !== first.id);
    assert.equal(m.claimExecutionJob(Date.now() + 120_000).id, running.id);
    assert.equal((await invoke("PUT", { ...original, jobId: running.id, expectedUpdatedAt: running.updatedAt })).status, 409);
    assert.equal((await invoke("DELETE", { jobId: running.id })).status, 409);
  } finally {
    clearTimeout(utility.idleTimer);
    globalThis.__ompUtilityRpcState = oldUtility;
  }
}));

for (const [prompt, command] of [
  ["/compact preserve decisions", { type: "compact", customInstructions: "preserve decisions" }],
  ["/reload", { type: "reload" }],
  ["/name New title", { type: "set_session_name", name: "New title" }],
]) {
  test(`scheduled ${command.type} uses its native control and completes without a prompt`, (t) => fixture(async (m, dir) => {
    const reader = await jiti.import("./session-reader.ts");
    const scheduler = await jiti.import("./execution-scheduler.ts");
    const file = join(dir, "control.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "control", cwd: dir, timestamp: "2026-10-25T00:00:00Z" })}\n`);
    reader.cacheSessionPath("control", file);
    const now = Date.now();
    const job = m.createExecutionJob("control", { prompt, provider: "p", modelId: "m", runAt: now + 1000, thinkingLevel: "auto" });
    const commands = [];
    const oldRegistry = globalThis.__ompSessions;
    globalThis.__ompSessions = new Map([["control", {
      sessionId: "control", sessionFile: file, isAlive: () => true, isRunning: () => false,
      acquireExecution: async () => true, releaseExecution: () => {}, onEvent: () => () => {},
      async send(value) { commands.push(value); return {}; },
    }]]);
    t.mock.method(Date, "now", () => now + 2000);
    try {
      await scheduler.runExecutionTick();
      assert.deepEqual(commands.at(-1), command);
      assert.equal(commands.some(value => value.type === "prompt"), false);
      assert.equal(commands.some(value => value.type === "set_thinking_level"), false, "auto means leave native thinking untouched");
      assert.equal(m.findExecutionJob(job.id).status, "completed");
    } finally { globalThis.__ompSessions = oldRegistry; }
  }));
}

test("control receipts do not leave assistant failures for the next scheduled turn", () => fixture((m) => {
  const now = Date.now();
  const control = m.createExecutionJob("one", { prompt: "/compact", provider: "p", modelId: "m", runAt: now + 1000 });
  const next = m.createExecutionJob("one", { prompt: "Next", provider: "p", modelId: "m", runAt: now + 2000 });
  m.claimExecutionJob(now + 1500);
  m.recordExecutionEvent("one", { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "stale internal assistant status" } });
  m.recordExecutionControlResult("one", control.id, "completed");
  m.claimExecutionJob(now + 3000);
  m.recordExecutionEvent("one", { type: "agent_end", isTerminal: true });
  assert.equal(m.findExecutionJob(next.id).status, "completed");
}));

test("scheduled side questions remain active until their own record finishes and never retry quota as a main prompt", (t) => fixture(async (m, dir) => {
  const reader = await jiti.import("./session-reader.ts");
  const scheduler = await jiti.import("./execution-scheduler.ts");
  const file = join(dir, "side.jsonl");
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "side", cwd: dir, timestamp: "2026-10-25T00:00:00Z" })}\n`);
  reader.cacheSessionPath("side", file);
  const now = Date.now();
  const job = m.createExecutionJob("side", { prompt: "/btw How does this work?", provider: "p", modelId: "m", runAt: now + 1000 });
  const commands = [];
  const listeners = new Set();
  const oldRegistry = globalThis.__ompSessions;
  let tracked = false;
  const record = { id: "question", question: "How does this work?", answer: "", status: "running", createdAt: now, updatedAt: now, leafId: null };
  globalThis.__ompSessions = new Map([["side", {
    sessionId: "side", sessionFile: file, isAlive: () => true, isRunning: () => tracked,
    acquireExecution: async () => true, releaseExecution: () => {},
    trackExecutionSideQuestion(_id, active) { tracked = active; },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async send(command) { commands.push(command); return command.type === "btw" ? { record } : {}; },
  }]]);
  t.mock.method(Date, "now", () => now + 2000);
  try {
    await scheduler.runExecutionTick();
    assert.equal(m.findExecutionJob(job.id).status, "running");
    assert.equal(m.findExecutionJob(job.id).btwId, "question");
    assert.equal(tracked, true);
    assert.deepEqual(commands.at(-1), { type: "btw", question: "How does this work?" });
    for (const listener of [...listeners]) listener({ type: "btw_record", record: { ...record, status: "error", error: "429 quota exhausted", updatedAt: now + 3000 } });
    assert.equal(m.findExecutionJob(job.id).status, "failed");
    assert.equal(m.findExecutionJob(job.id).error, "429 quota exhausted");
    assert.equal(tracked, false);
    assert.equal(listeners.size, 0);
    assert.equal(m.claimExecutionJob(now + 10_000), null);
    assert.equal(commands.some(command => command.type === "prompt"), false);
  } finally { globalThis.__ompSessions = oldRegistry; }
}));

test("only one job per chat can be claimed and uncertain delivery is never replayed", () => fixture((m) => {
  const now = Date.now();
  const first = m.createExecutionJob("one", { prompt: "First", provider: "p", modelId: "m", runAt: now + 1000 });
  m.createExecutionJob("one", { prompt: "Second", provider: "p", modelId: "m", runAt: now + 2000 });
  assert.equal(m.claimExecutionJob(now + 3000).id, first.id);
  assert.equal(m.claimExecutionJob(now + 3000), null);
  m.updateExecutionJob(first.id, { status: "uncertain", error: "No receipt" });
  assert.notEqual(m.claimExecutionJob(now + 3000)?.id, first.id);
}));

test("quota resumes keep their model and use advertised reset times without replaying user text", () => fixture((m) => {
  m.setExecutionMode("one", "wait");
  m.recordExecutionEvent("one", { type: "message_end", message: { role: "assistant", provider: "p", model: "m", stopReason: "error", errorMessage: "429 Usage limit reached. Try again in 3 hours." } });
  m.recordExecutionEvent("one", { type: "agent_end", isTerminal: true });
  const job = m.getExecutionSnapshot("one").jobs[0];
  assert.equal(job.kind, "resume");
  assert.equal(job.status, "waiting");
  assert.equal(job.modelId, "m");
  assert.ok(job.runAt > Date.now() + 2.9 * 3600000);
  m.setExecutionMode("one", "fallback");
  assert.equal(m.getExecutionSnapshot("one").jobs[0].status, "cancelled");
}));

test("unknown quota resets wait for manual time while non-quota failures do not schedule retries", () => fixture((m) => {
  m.setExecutionMode("one", "wait");
  m.recordExecutionEvent("one", { type: "message_end", message: { role: "assistant", provider: "p", model: "m", stopReason: "error", errorMessage: "429 quota exhausted" } });
  m.recordExecutionEvent("one", { type: "agent_end" });
  assert.equal(m.getExecutionSnapshot("one").jobs[0].runAt, null);
  m.recordExecutionEvent("two", { type: "message_end", message: { role: "assistant", provider: "p", model: "m", stopReason: "error", errorMessage: "400 invalid request" } });
  m.recordExecutionEvent("two", { type: "agent_end" });
  assert.equal(m.getExecutionSnapshot("two").jobs.length, 0);
}));

test("a dead worker's unacknowledged dispatch is visible and is never automatically replayed", () => fixture((m) => {
  const job = m.createExecutionJob("one", { prompt: "Do not replay tool work", provider: "p", modelId: "m", runAt: Date.now() + 1000 });
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createJiti } from "jiti";
    const m = await createJiti(import.meta.url).import("./lib/session-execution.ts");
    const job = m.claimExecutionJob(Date.now() + 2000);
    m.updateExecutionJob(job.id, { stage: "dispatching" });
  `], { cwd: new URL("..", import.meta.url), env: process.env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(m.claimExecutionJob(Date.now() + 3000), null);
  assert.equal(m.getExecutionSnapshot("one").jobs.find(j => j.id === job.id).status, "uncertain");
}));

test("a prompt-level quota error uses its errorMessage and the resolved native model identity", () => fixture((m) => {
  m.setExecutionMode("cold-chat", "wait");
  m.recordExecutionEvent("cold-chat", { type: "prompt_error", errorMessage: "429 quota exhausted", error: { code: 429 }, provider: "native-provider", model: "native-model" });
  const job = m.getExecutionSnapshot("cold-chat").jobs[0];
  assert.equal(job.status, "waiting");
  assert.equal(job.provider, "native-provider");
  assert.equal(job.modelId, "native-model");
  assert.equal(job.runAt, null);
}));

test("structured prompt quota resets preserve the exact advertised resume time", () => fixture((m) => {
  m.setExecutionMode("structured", "wait", { provider: "openai-codex", modelId: "gpt-6.1-sol" });
  const reset = Date.now() + 3_600_000;
  m.recordExecutionEvent("structured", { type: "prompt_error", errorMessage: "usage_limit_reached", provider: "openai-codex", model: "gpt-6.1-sol", resetsAtSec: reset / 1000 });
  assert.equal(m.getExecutionSnapshot("structured").jobs[0].runAt, reset);
}));

test("provider quota reconciliation preserves exact exhausted reset and user overrides", () => fixture(async (m) => {
  const scheduler = await jiti.import("./execution-scheduler.ts");
  m.setExecutionMode("reported", "wait", { provider: "openai-codex", modelId: "gpt-6.1-sol" });
  m.recordExecutionEvent("reported", { type: "prompt_error", errorMessage: "usage_limit_reached", provider: "openai-codex", model: "gpt-6.1-sol" });
  const reset = Date.now() + 3_600_000;
  const report = { provider: "openai-codex", fiveHour: { percent: 100, resetsAt: reset }, sevenDay: { percent: 31, resetsAt: reset + 86_400_000 } };
  await scheduler.reconcileQuotaWaits(async () => ({ generatedAt: Date.now(), reports: [report] }));
  const job = m.getExecutionSnapshot("reported").jobs[0];
  assert.equal(job.runAt, reset);
  assert.equal(job.modelId, "gpt-6.1-sol");
  m.setExecutionTime("reported", reset + 123_000, job.id);
  await scheduler.reconcileQuotaWaits(async () => ({ generatedAt: Date.now(), reports: [report] }));
  assert.equal(m.getExecutionSnapshot("reported").jobs[0].runAt, reset + 123_000);
}));

test("provider reset lookup never revives a cancelled waiting job", () => fixture(async (m) => {
  const scheduler = await jiti.import("./execution-scheduler.ts");
  m.setExecutionMode("cancelled-lookup", "wait", { provider: "p", modelId: "m" });
  m.recordExecutionEvent("cancelled-lookup", { type: "prompt_error", errorMessage: "429 quota exhausted", provider: "p", model: "m" });
  const job = m.getExecutionSnapshot("cancelled-lookup").jobs[0];
  await scheduler.reconcileQuotaWaits(async () => {
    m.cancelExecutionJob("cancelled-lookup", job.id);
    return { generatedAt: Date.now(), reports: [{ provider: "p", fiveHour: { percent: 100, resetsAt: Date.now() + 60_000 } }] };
  });
  const after = m.getExecutionSnapshot("cancelled-lookup").jobs[0];
  assert.equal(after.status, "cancelled");
  assert.equal(after.runAt, null);
}));

test("a persistence move transfers pending jobs, wait policy, and an in-flight completion together", () => fixture((m) => {
  const now = Date.now();
  m.setExecutionMode("old", "wait", { provider: "p", modelId: "m" });
  const running = m.createExecutionJob("old", { prompt: "Running", provider: "p", modelId: "m", runAt: now + 1000 });
  const pending = m.createExecutionJob("old", { prompt: "Pending", provider: "p", modelId: "m", runAt: now + 5000 });
  m.claimExecutionJob(now + 2000);
  m.recordExecutionEvent("old", { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  m.moveSessionExecution("old", "new");
  m.recordExecutionEvent("new", { type: "agent_end", isTerminal: true });
  assert.deepEqual(m.getExecutionSnapshot("old"), { policy: { mode: "fallback" }, jobs: [] });
  assert.equal(m.getExecutionSnapshot("new").policy.mode, "wait");
  assert.equal(m.getExecutionSnapshot("new").jobs.find(job => job.id === running.id).status, "completed");
  assert.equal(m.claimExecutionJob(now + 6000).id, pending.id);
  assert.equal(m.findExecutionJob(pending.id).sessionId, "new");
}));

test("a quota receipt begun before a persistence move waits on the new identity with its selected model", () => fixture((m) => {
  m.setExecutionMode("old", "wait", { provider: "original-provider", modelId: "original-model" });
  m.recordExecutionEvent("old", { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429 quota exhausted; retry after 60 seconds" } });
  m.moveSessionExecution("old", "new");
  m.recordExecutionEvent("new", { type: "agent_end", isTerminal: true });
  const job = m.getExecutionSnapshot("new").jobs[0];
  assert.equal(job.kind, "resume");
  assert.equal(job.status, "waiting");
  assert.equal(job.provider, "original-provider");
  assert.equal(job.modelId, "original-model");
  assert.ok(job.runAt > Date.now() + 50_000);
  assert.equal(m.getExecutionSnapshot("old").jobs.length, 0);
}));

test("a creation journal preserves its exact request and known native identity across reload and move", (t) => fixture((m) => {
  const draft = { cwd: "/workspace", prompt: "Once", provider: "p", modelId: "m", runAt: Date.now() + 1000, requestId: "durable-create",
    images: [{ data: "aGVsbG8=", mimeType: "image/png" }], thinkingLevel: "high", toolPreset: "none", fastMode: false, slowMode: true, advisorEnabled: true };
  m.reserveScheduledChatRequest(draft);
  m.beginScheduledChatCreation(draft.requestId);
  m.recordScheduledChatSession(draft.requestId, "native-old", "/native-old.jsonl");
  m.moveSessionExecution("native-old", "native-new", "/native-new.jsonl");
  const fresh = createJiti(import.meta.url, { moduleCache: false })("./session-execution.ts");
  assert.equal(fresh.reserveScheduledChatRequest(draft).sessionId, "native-new");
  assert.equal(fresh.reserveScheduledChatRequest(draft).sessionFile, "/native-new.jsonl");
  assert.deepEqual(fresh.reserveScheduledChatRequest(draft).draft.images, draft.images);
  assert.equal(fresh.reserveScheduledChatRequest(draft).draft.advisorEnabled, true);
  t.mock.method(Date, "now", () => draft.runAt + 100);
  const first = fresh.createExecutionJob("native-new", draft);
  assert.equal(fresh.createExecutionJob("native-new", draft).id, first.id);
  assert.equal(fresh.getExecutionSnapshot("native-new").jobs.length, 1);
  assert.throws(() => fresh.reserveScheduledChatRequest({ ...draft, prompt: "Different" }), error => error.status === 409);
  assert.throws(() => fresh.createExecutionJob("other", draft), error => error.status === 409);
}));

test("an interrupted unknown native creation is never retried as a second empty chat", () => fixture((m) => {
  const draft = { cwd: "/workspace", prompt: "Once", provider: "p", modelId: "m", runAt: Date.now() + 1000, requestId: "uncertain-create" };
  m.reserveScheduledChatRequest(draft);
  m.beginScheduledChatCreation(draft.requestId);
  const fresh = createJiti(import.meta.url, { moduleCache: false })("./session-execution.ts");
  assert.throws(() => fresh.beginScheduledChatCreation(draft.requestId), error => error.status === 409 && /creation.*not.*confirmed/i.test(error.message));
  assert.equal(fresh.findExecutionRequest(draft.requestId), undefined);
  assert.throws(() => fresh.reserveScheduledChatRequest({ ...draft, runAt: draft.runAt + 1 }), error => error.status === 409);
  assert.throws(() => fresh.reserveScheduledChatRequest({ ...draft, requestId: "new-past", runAt: Date.now() - 1000 }), error => error.status === 400);
}));

test("the scheduler dispatches a claimed job after its genuine persistence move and records completion", (t) => fixture(async (m, dir) => {
  const reader = await jiti.import("./session-reader.ts");
  const scheduler = await jiti.import("./execution-scheduler.ts");
  const oldFile = join(dir, "old.jsonl");
  const newFile = join(dir, "new.jsonl");
  writeFileSync(oldFile, `${JSON.stringify({ type: "session", version: 3, id: "scheduler-old", cwd: dir, timestamp: "2026-10-23T12:00:00.000Z" })}\n`);
  writeFileSync(newFile, `${JSON.stringify({ type: "session", version: 3, id: "scheduler-new", cwd: dir, timestamp: "2026-10-23T12:00:00.000Z" })}\n`);
  reader.cacheSessionPath("scheduler-old", oldFile);
  reader.cacheSessionPath("scheduler-new", newFile);
  const now = Date.now();
  const first = m.createExecutionJob("scheduler-old", { prompt: "Execute exactly once", provider: "p", modelId: "m", runAt: now + 1000 });
  const pending = m.createExecutionJob("scheduler-old", { prompt: "Keep for later", provider: "p", modelId: "m", runAt: now + 60_000 });
  const previousRegistry = globalThis.__ompSessions;
  const commands = [];
  const native = {
    sessionId: "scheduler-old", sessionFile: oldFile, isAlive: () => true,
    isRunning() {
      m.moveSessionExecution("scheduler-old", "scheduler-new", newFile);
      native.sessionId = "scheduler-new";
      native.sessionFile = newFile;
      return false;
    },
    acquireExecution: async () => true, releaseExecution: () => {}, onEvent: () => () => {},
    async send(command) {
      commands.push(command);
      if (command.type === "prompt") m.recordExecutionEvent(native.sessionId, { type: "agent_end", isTerminal: true });
    },
  };
  globalThis.__ompSessions = new Map([["scheduler-old", native]]);
  t.mock.method(Date, "now", () => now + 2000);
  try {
    await scheduler.runExecutionTick();
    assert.deepEqual(commands, [
      { type: "set_auto_retry", enabled: false },
      { type: "set_model", provider: "p", modelId: "m" },
      { type: "prompt", message: "Execute exactly once" },
    ]);
    assert.equal(m.getExecutionSnapshot("scheduler-new").jobs.find(job => job.id === first.id).status, "completed");
    assert.equal(m.getExecutionSnapshot("scheduler-new").jobs.find(job => job.id === pending.id).status, "pending");
    assert.equal(m.getExecutionSnapshot("scheduler-old").jobs.length, 0);
  } finally { globalThis.__ompSessions = previousRegistry; }
}));

test("a blocked identity move preserves both durable owners and the buffered quota receipt for retry", () => fixture((m, dir) => {
  m.setExecutionMode("old", "wait", { provider: "p", modelId: "m" });
  const job = m.createExecutionJob("old", { prompt: "Keep me", provider: "p", modelId: "m", runAt: Date.now() + 1000 });
  m.claimExecutionJob(Date.now() + 2000);
  m.recordExecutionEvent("old", { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429 quota exhausted" } });
  const lock = join(dir, "web-session-execution.json.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(process.pid));
  assert.throws(() => m.moveSessionExecution("old", "new"), error => error.status === 409);
  assert.equal(m.findExecutionJob(job.id).sessionId, "old");
  assert.equal(m.getExecutionSnapshot("old").policy.mode, "wait");
  rmSync(lock, { recursive: true });
  m.moveSessionExecution("old", "new");
  m.recordExecutionEvent("new", { type: "agent_end", isTerminal: true });
  assert.equal(m.getExecutionSnapshot("new").jobs[0].status, "waiting");
}));

test("adding the request journal to legacy metadata preserves every existing job and policy", () => fixture((m, dir) => {
  const file = join(dir, "web-session-execution.json");
  const legacy = {
    version: 1,
    policies: { untouched: { mode: "wait", model: { provider: "p", modelId: "m" } } },
    jobs: [{ id: "original-job", sessionId: "untouched", kind: "prompt", status: "uncertain", runAt: 1000, prompt: "Never replay", provider: "p", modelId: "m", createdAt: 500 }],
  };
  writeFileSync(file, JSON.stringify(legacy));
  m.reserveScheduledChatRequest({ cwd: "/workspace", prompt: "New work", provider: "p", modelId: "m", runAt: Date.now() + 1000, requestId: "new-request" });
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(saved.policies, legacy.policies);
  assert.deepEqual(saved.jobs, legacy.jobs);
  assert.equal(saved.creations["new-request"].phase, "reserved");
}));

test("a worker restart recovers the journaled native ID before any job existed", () => fixture((m) => {
  const draft = { cwd: "/workspace", prompt: "Recover once", provider: "p", modelId: "m", runAt: Date.now() + 60_000, requestId: "worker-created" };
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createJiti } from "jiti";
    const m = await createJiti(import.meta.url).import("./lib/session-execution.ts");
    const draft = JSON.parse(process.argv[1]);
    m.reserveScheduledChatRequest(draft);
    m.beginScheduledChatCreation(draft.requestId);
    m.recordScheduledChatSession(draft.requestId, "native-worker", "/native-worker.jsonl");
  `, JSON.stringify(draft)], { cwd: new URL("..", import.meta.url), env: process.env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(m.reserveScheduledChatRequest(draft).sessionId, "native-worker");
  const job = m.createExecutionJob("native-worker", draft);
  assert.equal(m.createExecutionJob("native-worker", draft).id, job.id);
  assert.equal(m.getExecutionSnapshot("native-worker").jobs.length, 1);
}));

test("a contender with a cached dead legacy owner cannot steal or release another process's live execution lock", { timeout: 30_000 }, () => fixture(async (m, dir) => {
  const now = Date.now();
  m.setExecutionMode("preserved", "wait", { provider: "p", modelId: "m" });
  const first = m.createExecutionJob("one", { prompt: "Claim once", provider: "p", modelId: "m", runAt: now + 1000 });
  const second = m.createExecutionJob("one", { prompt: "Preserve pending", provider: "p", modelId: "m", runAt: now + 2000 });
  const target = join(dir, "web-session-execution.json");
  const before = readFileSync(target, "utf8");
  const lock = `${target}.lock`;
  const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(dead.status, 0, dead.stderr);
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(dead.pid));
  const script = `
    import fs from "node:fs";
    import { join } from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    import { createJiti } from "jiti";
    const [dir, mode, now] = process.argv.slice(1);
    const target = join(dir, "web-session-execution.json");
    const originalRead = fs.readFileSync;
    let paused = false;
    fs.readFileSync = function(path, ...args) {
      const value = originalRead.call(this, path, ...args);
      const watched = mode === "loser" ? join(target + ".lock", "pid") : target;
      if (!paused && String(path) === watched) {
        paused = true;
        fs.writeFileSync(join(dir, mode + "-observed"), "ready");
        const wait = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 15000;
        while (!fs.existsSync(join(dir, mode + "-release"))) {
          if (Date.now() > deadline) throw new Error("Interleaving gate timed out");
          Atomics.wait(wait, 0, 0, 10);
        }
      }
      return value;
    };
    syncBuiltinESMExports();
    const m = await createJiti(import.meta.url, { tryNative: false }).import("./lib/session-execution.ts");
    let result;
    try { result = { job: m.claimExecutionJob(Number(now)) }; }
    catch (error) { result = { error: error.message, status: error.status }; }
    fs.writeFileSync(join(dir, mode + "-result.json"), JSON.stringify(result));
  `;
  const children = [];
  const start = (mode) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, mode, String(now + 3000)], { cwd: new URL("..", import.meta.url), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const done = new Promise(resolve => {
      child.once("error", error => resolve({ code: -1, stderr: String(error) }));
      child.once("exit", code => resolve({ code, stderr }));
    });
    children.push({ child, done });
    return { child, done };
  };
  const waitForGate = async mode => {
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(dir, `${mode}-observed`))) {
      if (Date.now() > deadline) throw new Error(`${mode} did not reach the lock interleaving`);
      await delay(10);
    }
  };
  try {
    const loser = start("loser");
    await waitForGate("loser");
    const owner = start("owner");
    await waitForGate("owner");
    const markers = readdirSync(lock);
    assert.equal(markers.length, 1);
    assert.equal(Number(readFileSync(join(lock, markers[0]), "utf8")), owner.child.pid);
    writeFileSync(join(dir, "loser-release"), "continue");
    const loserExit = await loser.done;
    assert.equal(loserExit.code, 0, loserExit.stderr);
    assert.deepEqual(readdirSync(lock), markers, "loser must leave the live owner's unique marker untouched");
    assert.equal(readFileSync(target, "utf8"), before, "loser cannot overwrite any execution state");
    const rejected = JSON.parse(readFileSync(join(dir, "loser-result.json"), "utf8"));
    assert.equal(rejected.status, 409);
    assert.equal(rejected.job, undefined);
    writeFileSync(join(dir, "owner-release"), "continue");
    const ownerExit = await owner.done;
    assert.equal(ownerExit.code, 0, ownerExit.stderr);
    const claimed = JSON.parse(readFileSync(join(dir, "owner-result.json"), "utf8")).job;
    assert.equal(claimed.id, first.id);
    assert.equal(m.findExecutionJob(first.id).ownerPid, owner.child.pid);
    assert.equal(m.findExecutionJob(second.id).status, "pending");
    assert.equal(m.getExecutionSnapshot("preserved").policy.mode, "wait");
    assert.equal(existsSync(lock), false);
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(({ done }) => done));
  }
}));

test("an ownerless execution lock fails closed with repair instructions and preserves its directory and state", () => fixture((m, dir) => {
  m.setExecutionMode("preserved", "wait");
  const target = join(dir, "web-session-execution.json");
  const before = readFileSync(target, "utf8");
  const lock = `${target}.lock`;
  mkdirSync(lock);
  assert.throws(() => m.setExecutionMode("new", "wait"), error => error.status === 409 && /owner|repair/i.test(error.message));
  assert.equal(readFileSync(target, "utf8"), before);
  assert.deepEqual(readdirSync(lock), []);
}));

test("a proven-dead uniquely identified execution lock can be reclaimed without losing existing policies", () => fixture((m, dir) => {
  m.setExecutionMode("preserved", "wait");
  const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(dead.status, 0, dead.stderr);
  const lock = join(dir, "web-session-execution.json.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner-00000000-0000-4000-8000-000000000001"), String(dead.pid));
  m.setExecutionMode("new", "wait");
  assert.equal(m.getExecutionSnapshot("preserved").policy.mode, "wait");
  assert.equal(m.getExecutionSnapshot("new").policy.mode, "wait");
  assert.equal(existsSync(lock), false);
}));

for (const terminal of ["completed", "quota", "uncertain"]) {
  test(`a held execution lock retains the ${terminal} receipt through a genuine move and metadata-only flush`, (t) => fixture((m, dir) => {
    const now = Date.now();
    m.setExecutionMode("receipt-old", "wait", { provider: "pinned-provider", modelId: "pinned-model" });
    const first = m.createExecutionJob("receipt-old", { prompt: "Never replay this prompt", provider: "pinned-provider", modelId: "pinned-model", runAt: now + 1000 });
    const next = m.createExecutionJob("receipt-old", { prompt: "Next queued job", provider: "pinned-provider", modelId: "pinned-model", runAt: now + 5000 });
    m.claimExecutionJob(now + 2000);
    t.mock.method(Date, "now", () => now + 2000);
    const lock = join(dir, "web-session-execution.json.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(process.pid));
    if (terminal !== "uncertain") m.recordExecutionEvent("receipt-old", { type: "message_end", message: {
      role: "assistant", provider: "pinned-provider", model: "pinned-model",
      stopReason: terminal === "quota" ? "error" : "stop",
      ...(terminal === "quota" ? { errorMessage: "429 quota exhausted; retry after 60 seconds" } : {}),
    } });
    const event = terminal === "uncertain"
      ? { type: "prompt_error", deliveryUncertain: true, error: "Transport lost its delivery confirmation" }
      : { type: "agent_end", isTerminal: true };
    assert.throws(() => m.recordExecutionEvent("receipt-old", event), error => error.status === 409);
    assert.throws(() => m.flushExecutionReceipts(), error => error.status === 409);
    assert.equal(m.findExecutionJob(first.id).status, "running");
    rmSync(lock, { recursive: true });
    if (terminal === "completed") m.updateExecutionJob(first.id, { status: "uncertain", error: "Dispatch metadata was temporarily unavailable" });
    m.moveSessionExecution("receipt-old", "receipt-new");
    t.mock.method(Date, "now", () => now + 32_000);
    m.flushExecutionReceipts();
    const saved = m.findExecutionJob(first.id);
    assert.equal(saved.sessionId, "receipt-new");
    assert.equal(saved.status, terminal === "quota" ? "waiting" : terminal);
    assert.equal(saved.provider, "pinned-provider");
    assert.equal(saved.modelId, "pinned-model");
    assert.equal(saved.prompt, "Never replay this prompt");
    if (terminal === "quota") assert.equal(saved.runAt, now + 62_000, "metadata contention must not extend the advertised reset window");
    assert.equal(m.claimExecutionJob(now + 32_000).id, next.id, "the old running claim no longer blocks the next queued job");
    assert.equal(m.getExecutionSnapshot("receipt-old").jobs.length, 0);
  }));
}

test("the scheduler tick flushes a retained completion without redispatching the completed prompt", () => fixture(async (m, dir) => {
  const scheduler = await jiti.import("./execution-scheduler.ts");
  const job = m.createExecutionJob("tick-receipt", { prompt: "Do not dispatch again", provider: "p", modelId: "m", runAt: Date.now() + 1000 });
  m.claimExecutionJob(Date.now() + 2000);
  const lock = join(dir, "web-session-execution.json.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(process.pid));
  assert.throws(() => m.recordExecutionEvent("tick-receipt", { type: "agent_end", isTerminal: true }), error => error.status === 409);
  rmSync(lock, { recursive: true });
  await scheduler.runExecutionTick();
  assert.equal(m.findExecutionJob(job.id).status, "completed");
  assert.equal(m.getExecutionSnapshot("tick-receipt").jobs.length, 1);
}));

test("a retained foreground quota receipt keeps the original model when policy metadata changes before flush", () => fixture((m, dir) => {
  m.setExecutionMode("foreground", "wait", { provider: "original-provider", modelId: "original-model" });
  const lock = join(dir, "web-session-execution.json.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(process.pid));
  m.recordExecutionEvent("foreground", { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429 quota exhausted; retry after 60 seconds" } });
  assert.throws(() => m.recordExecutionEvent("foreground", { type: "agent_end", isTerminal: true }), error => error.status === 409);
  rmSync(lock, { recursive: true });
  m.setExecutionMode("foreground", "wait", { provider: "other-provider", modelId: "other-model" });
  m.flushExecutionReceipts();
  m.flushExecutionReceipts();
  const jobs = m.getExecutionSnapshot("foreground").jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, "resume");
  assert.equal(jobs[0].status, "waiting");
  assert.equal(jobs[0].provider, "original-provider");
  assert.equal(jobs[0].modelId, "original-model");
  assert.equal(jobs[0].prompt, "");
}));

test("manual cancellation of automatic resumes also cancels an uncommitted foreground quota resume", () => fixture((m, dir) => {
  m.setExecutionMode("manual-next", "wait", { provider: "p", modelId: "m" });
  const lock = join(dir, "web-session-execution.json.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(process.pid));
  m.recordExecutionEvent("manual-next", { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429 quota exhausted" } });
  assert.throws(() => m.recordExecutionEvent("manual-next", { type: "agent_end", isTerminal: true }), error => error.status === 409);
  rmSync(lock, { recursive: true });
  m.cancelAutomaticResumes("manual-next");
  m.flushExecutionReceipts();
  assert.equal(m.getExecutionSnapshot("manual-next").jobs.length, 0);
}));

test("a pending provider lookup cannot delay an unrelated due conversation", (t) => fixture(async (m, dir) => {
  const scheduler = await jiti.import("./execution-scheduler.ts");
  const reader = await jiti.import("./session-reader.ts");
  const script = join(dir, "usage-cli.cjs");
  const bin = process.platform === "win32" ? join(dir, "usage-cli.cmd") : script;
  const started = join(dir, "started");
  const release = join(dir, "release");
  writeFileSync(script, `#!${process.execPath}\nconst fs = require("node:fs"); const dir = ${JSON.stringify(dir)}; const w = fs.watch(dir, () => { if (fs.existsSync(dir + "/release")) { w.close(); console.log('{"reports":[]}'); } }); fs.writeFileSync(dir + "/started", "1");\n`, { mode: 0o755 });
  if (process.platform === "win32") writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  let startedWatcher;
  const ready = new Promise(resolve => { startedWatcher = watch(dir, () => { if (existsSync(started)) { startedWatcher.close(); resolve(); } }); });
  const oldBin = process.env.OMP_WEB_OMP_BIN;
  const oldRegistry = globalThis.__ompSessions;
  process.env.OMP_WEB_OMP_BIN = bin;
  m.setExecutionMode("blocked-provider", "wait", { provider: "p", modelId: "m" });
  m.recordExecutionEvent("blocked-provider", { type: "prompt_error", errorMessage: "429 quota exhausted", provider: "p", model: "m" });
  const file = join(dir, "due.jsonl");
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "due", cwd: dir, timestamp: "2026-10-24T00:00:00Z" })}\n`);
  reader.cacheSessionPath("due", file);
  const now = Date.now();
  const job = m.createExecutionJob("due", { prompt: "Run now", provider: "other", modelId: "other", runAt: now + 1000 });
  t.mock.method(Date, "now", () => now + 2000);
  globalThis.__ompSessions = new Map([["due", {
    sessionId: "due", sessionFile: file, isAlive: () => true, isRunning: () => false,
    acquireExecution: async () => true, releaseExecution: () => {}, onEvent: () => () => {},
    async send(command) { if (command.type === "prompt") m.recordExecutionEvent("due", { type: "agent_end", isTerminal: true }); },
  }]]);
  const tick = scheduler.runExecutionTick();
  try {
    await Promise.race([
      ready,
      Promise.resolve(globalThis.__ompQuotaReconcile).then(() => { throw new Error("Usage CLI exited before reaching its readiness gate"); }),
    ]);
    assert.equal(m.getExecutionSnapshot("due").jobs.find(item => item.id === job.id).status, "completed");
  } finally {
    startedWatcher.close();
    writeFileSync(release, "1");
    await tick;
    await globalThis.__ompQuotaReconcile;
    globalThis.__ompSessions = oldRegistry;
    if (oldBin === undefined) delete process.env.OMP_WEB_OMP_BIN; else process.env.OMP_WEB_OMP_BIN = oldBin;
  }
}));

test("a scheduled prompt acknowledgement timeout stays uncertain until terminal evidence arrives", (t) => fixture(async (m, dir) => {
  const reader = await jiti.import("./session-reader.ts");
  const scheduler = await jiti.import("./execution-scheduler.ts");
  const { WebRpcError } = await jiti.import("./rpc-manager.ts");
  const file = join(dir, "ack-timeout.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "ack-timeout", cwd: dir, timestamp: "2026-10-25T00:00:00Z" }) + "\n");
  reader.cacheSessionPath("ack-timeout", file);
  const now = Date.now();
  const job = m.createExecutionJob("ack-timeout", { prompt: "May already have acted", provider: "p", modelId: "m", runAt: now + 1000 });
  const previous = globalThis.__ompSessions;
  globalThis.__ompSessions = new Map([["ack-timeout", {
    sessionId: "ack-timeout", sessionFile: file, isAlive: () => true, isRunning: () => false,
    acquireExecution: async () => true, releaseExecution() {},
    async send(command) {
      if (command.type !== "prompt") return;
      m.recordExecutionEvent("ack-timeout", { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
      const lock = join(dir, "web-session-execution.json.lock");
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
      try {
        assert.throws(() => m.recordExecutionEvent("ack-timeout", { type: "agent_end", isTerminal: true }), error => error.status === 409);
      } finally { rmSync(lock, { recursive: true }); }
      throw new WebRpcError("No acknowledgement", "session_unresponsive");
    },
  }]]);
  t.mock.method(Date, "now", () => now + 2000);
  try {
    await scheduler.runExecutionTick();
    assert.equal(m.findExecutionJob(job.id).status, "uncertain", "a timeout cannot prove the accepted prompt did no work");
    m.flushExecutionReceipts();
    assert.equal(m.findExecutionJob(job.id).status, "completed", "retained terminal evidence must still resolve uncertainty");
  } finally { globalThis.__ompSessions = previous; }
}));
