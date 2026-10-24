import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./omp/paths";
import type { ExecutionJob, ExecutionMode, ExecutionModel, ExecutionSnapshot } from "./session-execution-types";

export class ExecutionError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
export interface StoredExecutionJob extends ExecutionJob {
  sessionId: string;
  requestId?: string;
  continuation?: boolean;
  ownerPid?: number;
  ownerToken?: string;
  stage?: "preparing" | "dispatching" | "active";
  notBefore?: number;
}
export interface ScheduledChatDraft {
  cwd: string;
  prompt: string;
  runAt: number;
  provider: string;
  modelId: string;
  requestId: string;
}
export interface ScheduledChatCreation {
  draft: ScheduledChatDraft;
  phase: "reserved" | "creating" | "created";
  sessionId?: string;
  sessionFile?: string;
}
interface Store {
  version: 1;
  policies: Record<string, { mode: ExecutionMode; model?: ExecutionModel }>;
  jobs: StoredExecutionJob[];
  creations: Record<string, ScheduledChatCreation>;
}
interface ExecutionReceipt {
  sessionId: string;
  message?: Record<string, unknown>;
  receivedAt: number;
  jobId?: string | null;
  model?: ExecutionModel;
  resumeJobId?: string;
  automaticResumeCancelled?: boolean;
}
const globals = globalThis as unknown as {
  __ompExecutionToken?: string;
  __ompExecutionErrors?: Map<string, Record<string, unknown>>;
  __ompExecutionReceipts?: Map<string, ExecutionReceipt[]>;
};
const token = globals.__ompExecutionToken ??= randomUUID();
const errors = globals.__ompExecutionErrors ??= new Map<string, Record<string, unknown>>();
const pendingReceipts = globals.__ompExecutionReceipts ??= new Map<string, ExecutionReceipt[]>();
const statuses = new Set(["pending", "waiting", "running", "completed", "cancelled", "failed", "uncertain"]);
const file = () => join(getAgentDir(), "web-session-execution.json");
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }
function load(): Store {
  if (!existsSync(file())) return { version: 1, policies: {}, jobs: [], creations: {} };
  const value = JSON.parse(readFileSync(file(), "utf8")) as Store;
  // Version 1 stores predating the creation journal retain every policy/job.
  value.creations ??= {};
  if (value.version !== 1 || !value.policies || typeof value.policies !== "object" || Array.isArray(value.policies) || !Array.isArray(value.jobs)
    || Object.values(value.policies).some(p => !p || (p.mode !== "wait" && p.mode !== "fallback"))
    || value.jobs.some(j => !j || typeof j.id !== "string" || typeof j.sessionId !== "string" || typeof j.provider !== "string" || typeof j.modelId !== "string" || typeof j.prompt !== "string" || !Number.isFinite(j.createdAt) || (j.runAt !== null && !Number.isFinite(j.runAt)) || !statuses.has(j.status) || (j.kind !== "prompt" && j.kind !== "resume"))) {
    throw new ExecutionError("Invalid execution metadata; restore or repair web-session-execution.json before making changes", 500);
  }
  if (!value.creations || typeof value.creations !== "object" || Array.isArray(value.creations)
    || Object.entries(value.creations).some(([requestId, creation]) => !creation || !creation.draft || creation.draft.requestId !== requestId
      || typeof creation.draft.cwd !== "string" || typeof creation.draft.prompt !== "string" || typeof creation.draft.provider !== "string" || typeof creation.draft.modelId !== "string" || !Number.isFinite(creation.draft.runAt)
      || !["reserved", "creating", "created"].includes(creation.phase)
      || (creation.phase === "created" && (typeof creation.sessionId !== "string" || !creation.sessionId || typeof creation.sessionFile !== "string" || !creation.sessionFile)))) {
    throw new ExecutionError("Invalid execution metadata; restore or repair web-session-execution.json before making changes", 500);
  }
  return value;
}
function change<T>(run: (store: Store, dirty: () => void) => T): T {
  const target = file();
  const lock = `${target}.lock`;
  const owner = `owner-${randomUUID()}`;
  const candidate = `${lock}.candidate-${owner}`;
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  let acquired = false;
  mkdirSync(getAgentDir(), { recursive: true });
  try {
    // Publish a populated directory: a live owner is never represented by an
    // empty canonical lock while its marker is being written.
    mkdirSync(candidate, { mode: 0o700 });
    writeFileSync(join(candidate, owner), String(process.pid), { mode: 0o600, flag: "wx" });
    for (let attempt = 0; attempt < 2 && !acquired; attempt++) {
      let entries: string[] | undefined;
      try { entries = readdirSync(lock); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (entries) {
        const observed = entries[0];
        if (entries.length !== 1 || (observed !== "pid" && !/^owner-[a-f0-9-]{36}$/.test(observed))) {
          throw new ExecutionError("Execution lock has no verifiable owner. Stop all omp-web processes and inspect/repair web-session-execution.json.lock before retrying.", 409);
        }
        let pid: number;
        try {
          const encodedPid = readFileSync(join(lock, observed), "utf8").trim();
          pid = /^[1-9]\d*$/.test(encodedPid) ? Number(encodedPid) : NaN;
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ExecutionError("Execution state is busy; retry the operation", 409);
          throw error;
        }
        if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) throw new ExecutionError("Execution lock owner is invalid. Stop all omp-web processes and inspect/repair web-session-execution.json.lock before retrying.", 409);
        if (alive(pid)) throw new ExecutionError("Execution state is busy; retry the operation", 409);
        // A stale contender may only unlink the marker it actually observed.
        // If another process replaced the directory, its unique marker survives.
        try { unlinkSync(join(lock, observed)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ExecutionError("Execution state is busy; retry the operation", 409);
          throw error;
        }
        try { rmdirSync(lock); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EEXIST" || code === "ENOTEMPTY") throw new ExecutionError("Execution state is busy; retry the operation", 409);
          if (code !== "ENOENT") throw error;
        }
      }
      try { renameSync(candidate, lock); acquired = true; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      }
    }
    if (!acquired) throw new ExecutionError("Execution state is busy; retry the operation", 409);
    const store = load();
    let dirty = false;
    const result = run(store, () => { dirty = true; });
    if (dirty) { writeFileSync(temp, `${JSON.stringify(store)}\n`, { mode: 0o600, flag: "wx" }); renameSync(temp, target); }
    return result;
  } finally {
    try {
      rmSync(temp, { force: true });
      // This UUID-private staging path is never another process's lock.
      rmSync(candidate, { recursive: true, force: true });
    } finally {
      if (acquired) {
        let removedOwnMarker = false;
        try { unlinkSync(join(lock, owner)); removedOwnMarker = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (removedOwnMarker) {
          try { rmdirSync(lock); }
          catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
          }
        }
      }
    }
  }
}
export function getExecutionSnapshot(sessionId: string): ExecutionSnapshot {
  const store = load();
  return { policy: { mode: store.policies[sessionId]?.mode ?? "fallback" }, jobs: store.jobs.filter(j => j.sessionId === sessionId).map(({ id, kind, status, runAt, prompt, provider, modelId, createdAt, error }) => ({ id, kind, status, runAt, prompt, provider, modelId, createdAt, ...(error ? { error } : {}) })) };
}

/** Recover a new-chat creation whose successful response was lost. */
export function findExecutionRequest(requestId: string): StoredExecutionJob | undefined {
  const job = load().jobs.find(job => job.requestId === requestId);
  return job ? { ...job } : undefined;
}

export function findExecutionJob(jobId: string): StoredExecutionJob | undefined {
  const job = load().jobs.find(job => job.id === jobId);
  return job ? { ...job } : undefined;
}

function sameScheduledPrompt(left: Pick<ExecutionJob, "prompt" | "runAt" | "provider" | "modelId">, right: Pick<ExecutionJob, "prompt" | "runAt" | "provider" | "modelId">): boolean {
  return left.prompt === right.prompt && left.runAt === right.runAt && left.provider === right.provider && left.modelId === right.modelId;
}

/** Persist intent before crossing the native creation boundary. */
export function reserveScheduledChatRequest(draft: ScheduledChatDraft): ScheduledChatCreation {
  return change((store, dirty) => {
    const previous = store.creations[draft.requestId];
    if (previous) {
      if (previous.draft.cwd !== draft.cwd || !sameScheduledPrompt(previous.draft, draft)) throw new ExecutionError("Request ID belongs to a different scheduled prompt or workspace", 409);
      return { ...previous, draft: { ...previous.draft } };
    }
    if (!Number.isFinite(draft.runAt) || draft.runAt <= Date.now()) throw new ExecutionError("Choose a future execution time");
    const creation: ScheduledChatCreation = { draft: { ...draft }, phase: "reserved" };
    store.creations[draft.requestId] = creation;
    dirty();
    return { ...creation, draft: { ...draft } };
  });
}

export function beginScheduledChatCreation(requestId: string): void {
  change((store, dirty) => {
    const creation = store.creations[requestId];
    if (!creation) throw new ExecutionError("Scheduled creation request was not saved", 500);
    if (creation.phase !== "reserved") {
      throw new ExecutionError(`Native conversation creation was not confirmed for request ${requestId}. No prompt was sent and this request will not create another conversation. Check the workspace's recent conversations before scheduling a separate new request.`, 409);
    }
    creation.phase = "creating";
    dirty();
  });
}

/** Save the native identity before naming, permissions, or job metadata can fail. */
export function recordScheduledChatSession(requestId: string, sessionId: string, sessionFile: string): void {
  change((store, dirty) => {
    const creation = store.creations[requestId];
    if (!creation || !sessionId || !sessionFile) throw new ExecutionError("Native conversation identity could not be journaled", 500);
    if (creation.phase === "created" && creation.sessionId !== sessionId) throw new ExecutionError("Scheduled creation belongs to another conversation", 409);
    creation.phase = "created";
    creation.sessionId = sessionId;
    creation.sessionFile = sessionFile;
    dirty();
  });
}

/** Only a native persistence move may transfer execution ownership. */
export function moveSessionExecution(oldId: string, newId: string, sessionFile?: string): void {
  if (!oldId || oldId === newId) return;
  if (existsSync(file())) change((store, dirty) => {
    const policy = store.policies[oldId];
    if (policy) {
      const target = store.policies[newId];
      if (target && JSON.stringify(target) !== JSON.stringify(policy)) throw new ExecutionError("The moved conversation has conflicting execution policies; execution state was preserved for repair", 409);
      store.policies[newId] = policy;
      delete store.policies[oldId];
      dirty();
    }
    for (const job of store.jobs) if (job.sessionId === oldId) { job.sessionId = newId; dirty(); }
    for (const creation of Object.values(store.creations)) if (creation.sessionId === oldId) {
      creation.sessionId = newId;
      if (sessionFile) creation.sessionFile = sessionFile;
      dirty();
    }
  });
  // No await separates the committed store move and its process-local receipt.
  const oldKey = `${getAgentDir()}:${oldId}`;
  const newKey = `${getAgentDir()}:${newId}`;
  const receipt = errors.get(oldKey);
  if (receipt) { errors.set(newKey, receipt); errors.delete(oldKey); }
  const pending = pendingReceipts.get(oldKey);
  if (pending) {
    for (const item of pending) item.sessionId = newId;
    pendingReceipts.set(newKey, [...(pendingReceipts.get(newKey) ?? []), ...pending].sort((a, b) => a.receivedAt - b.receivedAt));
    pendingReceipts.delete(oldKey);
  }
}
export function executionWaitEnabled(sessionId: string): boolean { return load().policies[sessionId]?.mode === "wait"; }
export function cancelAutomaticResumes(sessionId: string): void {
  if (!existsSync(file())) return;
  change((store, dirty) => { for (const job of store.jobs) if (job.sessionId === sessionId && job.kind === "resume" && (job.status === "pending" || job.status === "waiting")) { job.status = "cancelled"; dirty(); } });
  for (const receipt of pendingReceipts.get(`${getAgentDir()}:${sessionId}`) ?? []) receipt.automaticResumeCancelled = true;
  errors.delete(`${getAgentDir()}:${sessionId}`);
}
export function setExecutionMode(sessionId: string, mode: ExecutionMode, model?: ExecutionModel): void {
  if (mode !== "wait" && mode !== "fallback") throw new ExecutionError("Invalid execution mode");
  change((store, dirty) => {
    store.policies[sessionId] = { mode, ...(model ? { model } : {}) };
    if (mode === "fallback") for (const job of store.jobs) if (job.sessionId === sessionId && job.kind === "resume" && (job.status === "waiting" || job.status === "pending")) job.status = "cancelled";
    dirty();
  });
  if (mode === "fallback") for (const receipt of pendingReceipts.get(`${getAgentDir()}:${sessionId}`) ?? []) receipt.automaticResumeCancelled = true;
}
export function createExecutionJob(sessionId: string, body: { prompt: string; runAt: number; provider: string; modelId: string; requestId?: string }): StoredExecutionJob {
  return change((store, dirty) => {
    if (body.requestId) {
      const existing = store.jobs.find(j => j.requestId === body.requestId);
      if (existing) {
        if (existing.sessionId !== sessionId || !sameScheduledPrompt(existing, body)) throw new ExecutionError("Request ID already belongs to a different scheduled prompt", 409);
        return { ...existing };
      }
    }
    if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 65_536) throw new ExecutionError("Prompt must contain between 1 and 65536 characters");
    const creation = body.requestId ? store.creations[body.requestId] : undefined;
    if (creation && (creation.phase !== "created" || creation.sessionId !== sessionId || !sameScheduledPrompt(creation.draft, body))) throw new ExecutionError("Request ID belongs to a different or unconfirmed native conversation", 409);
    const acceptedCreation = creation?.phase === "created" && creation.sessionId === sessionId && sameScheduledPrompt(creation.draft, body);
    if (!Number.isFinite(body.runAt) || (body.runAt <= Date.now() && !acceptedCreation)) throw new ExecutionError("Choose a future execution time");
    if (typeof body.provider !== "string" || !body.provider.trim() || typeof body.modelId !== "string" || !body.modelId.trim()) throw new ExecutionError("A provider and model are required");
    if (body.requestId !== undefined && (typeof body.requestId !== "string" || body.requestId.length > 128 || !body.requestId)) throw new ExecutionError("Invalid request ID");
    const job: StoredExecutionJob = { id: randomUUID(), sessionId, kind: "prompt", status: "pending", runAt: body.runAt, prompt: body.prompt, provider: body.provider, modelId: body.modelId, createdAt: Date.now(), ...(body.requestId ? { requestId: body.requestId } : {}) };
    store.jobs.push(job); dirty(); return { ...job };
  });
}
export function cancelExecutionJob(sessionId: string, jobId: string): void {
  change((store, dirty) => {
    const job = store.jobs.find(j => j.sessionId === sessionId && j.id === jobId);
    if (!job) throw new ExecutionError("Scheduled job not found", 404);
    if (job.status === "cancelled") return;
    if (job.status !== "pending" && job.status !== "waiting") throw new ExecutionError("This job has already started or finished; use the chat Stop button for a running turn", 409);
    job.status = "cancelled"; dirty();
  });
}
export function setExecutionTime(sessionId: string, runAt: number, jobId?: string): void {
  if (!Number.isFinite(runAt) || runAt <= Date.now()) throw new ExecutionError("Choose a future execution time");
  change((store, dirty) => {
    const job = store.jobs.find(j => j.sessionId === sessionId && (jobId ? j.id === jobId : j.kind === "resume") && (j.status === "waiting" || j.status === "pending"));
    if (!job) throw new ExecutionError("No pending job found", 404);
    job.runAt = runAt; job.notBefore = undefined; job.error = undefined; dirty();
  });
}
export function updateExecutionJob(jobId: string, patch: Partial<Pick<StoredExecutionJob, "status" | "error" | "stage" | "notBefore" | "continuation" | "runAt">>): void {
  change((store, dirty) => {
    const job = store.jobs.find(j => j.id === jobId);
    if (!job || job.status !== "running") return;
    Object.assign(job, patch); dirty();
  });
}
export function hasRunningExecution(sessionId: string): boolean { return load().jobs.some(j => j.sessionId === sessionId && j.status === "running"); }
export function getUnknownQuotaWaits(): StoredExecutionJob[] {
  return load().jobs.filter(job => job.status === "waiting" && job.runAt === null && job.continuation && job.error && isQuotaError(job.error)).map(job => ({ ...job }));
}
export function resolveQuotaWait(jobId: string, runAt: number): void {
  if (!Number.isFinite(runAt) || runAt <= Date.now()) return;
  change((store, dirty) => {
    const job = store.jobs.find(job => job.id === jobId);
    // Usage lookup happens outside this transaction. A cancellation or manual
    // time selected while it was pending must win over the automatic result.
    if (job?.status !== "waiting" || job.runAt !== null || !job.continuation) return;
    job.runAt = runAt;
    dirty();
  });
}
export function executionSpawnArgs(sessionId: string): string[] {
  if (!executionWaitEnabled(sessionId) && !hasRunningExecution(sessionId)) return [];
  const overlay = join(getAgentDir(), "web-execution-no-fallback.yml");
  const content = "retry:\n  enabled: false\n  modelFallback: false\n";
  mkdirSync(getAgentDir(), { recursive: true });
  if (!existsSync(overlay) || readFileSync(overlay, "utf8") !== content) writeFileSync(overlay, content, { mode: 0o600 });
  return ["--config", overlay];
}
export function claimExecutionJob(now = Date.now()): StoredExecutionJob | null {
  if (!existsSync(file())) return null;
  return change((store, dirty) => {
    for (const job of store.jobs) if (job.status === "running" && (!job.ownerPid || !alive(job.ownerPid) || (job.ownerPid === process.pid && job.ownerToken !== token))) {
      job.status = job.stage === "preparing" ? "pending" : "uncertain";
      job.error = job.status === "uncertain" ? "Server stopped before completion was confirmed. Check the conversation before sending again." : undefined;
      dirty();
    }
    const running = new Set(store.jobs.filter(j => j.status === "running").map(j => j.sessionId));
    const job = store.jobs.filter(j => (j.status === "pending" || j.status === "waiting") && j.runAt !== null && j.runAt <= now && (j.notBefore ?? 0) <= now && !running.has(j.sessionId)).sort((a, b) => (a.runAt! - b.runAt!) || a.createdAt - b.createdAt)[0];
    if (!job) return null;
    job.status = "running"; job.ownerPid = process.pid; job.ownerToken = token; job.stage = "preparing"; job.error = undefined; dirty(); return { ...job };
  });
}
export function quotaResetTime(message: string, now = Date.now(), explicit?: unknown): number | null {
  if (typeof explicit === "number" && Number.isFinite(explicit)) { const time = explicit < 1e12 ? explicit * 1000 : explicit; if (time > now) return time; }
  const advertised = message.match(/(?:try again in|retry after|resets? in)\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i);
  if (advertised) return now + Number(advertised[1]) * (/^h/i.test(advertised[2]) ? 3_600_000 : /^m/i.test(advertised[2]) ? 60_000 : 1000);
  const timestamp = message.match(/(?:retry[_ -]?after|resets?[_ -]?at|resetsAtSec)["\s:]+(\d+(?:\.\d+)?)/i);
  if (timestamp) { const value = Number(timestamp[1]); if (value >= 1e9) return quotaResetTime("", now, value); if (/retry/i.test(timestamp[0])) return now + value * 1000; }
  return null;
}
export function isQuotaError(message: string): boolean { return /\b429\b|rate.?limit|usage.?limit|quota|insufficient_quota|credits? (?:exhausted|depleted)/i.test(message); }
export function recordExecutionEvent(sessionId: string, event: Record<string, unknown>): void {
  if (process.env.OMP_WEB_SCHEDULER_DISABLED === "1" || !sessionId) return;
  const key = `${getAgentDir()}:${sessionId}`;
  if (event.type === "message_end") {
    const message = event.message as Record<string, unknown> | undefined;
    if (message?.role === "assistant") errors.set(key, message);
    return;
  }
  if (event.type === "prompt_error") errors.set(key, {
    errorMessage: typeof event.errorMessage === "string" ? event.errorMessage
      : typeof event.error === "string" ? event.error
        : typeof event.message === "string" ? event.message : JSON.stringify(event.error ?? "Prompt failed"),
    stopReason: "error", provider: event.provider, model: event.model, deliveryUncertain: event.deliveryUncertain === true,
    resetsAtSec: event.resetsAtSec,
  });
  if ((event.type !== "agent_end" || event.isTerminal === false) && event.type !== "prompt_error" && event.type !== "prompt_result") return;
  const message = errors.get(key);
  const receipts = pendingReceipts.get(key) ?? [];
  // agent_end and prompt_result may describe the same terminal message.
  if (!receipts.some(receipt => receipt.message === message)) receipts.push({ sessionId, message, receivedAt: Date.now() });
  pendingReceipts.set(key, receipts);
  flushPendingExecutionReceipts(key);
}

function captureExecutionReceiptOwners(store: Store, receipts: ExecutionReceipt[]): void {
  for (const receipt of receipts) if (receipt.jobId === undefined) {
    const job = store.jobs.find(job => job.sessionId === receipt.sessionId && job.status === "running");
    receipt.jobId = job?.id ?? null;
    receipt.model = job ? { provider: job.provider, modelId: job.modelId } : store.policies[receipt.sessionId]?.model;
  }
}

function flushPendingExecutionReceipts(key: string): void {
  const receipts = pendingReceipts.get(key);
  if (!receipts) return;
  if (existsSync(file())) {
    try {
      change((store, dirty) => {
        captureExecutionReceiptOwners(store, receipts);
        for (const receipt of receipts) {
          const { sessionId, message } = receipt;
          const error = typeof message?.errorMessage === "string" ? message.errorMessage : "";
          const quota = error && isQuotaError(error);
          let job = receipt.jobId ? store.jobs.find(job => job.id === receipt.jobId && job.sessionId === sessionId) : undefined;
          // A retained native receipt can resolve a dispatch marked uncertain,
          // but cannot overwrite a later user cancellation or reschedule.
          if (receipt.jobId && (!job || (job.status !== "running" && job.status !== "uncertain"))) continue;
          if (quota && (job || (!receipt.automaticResumeCancelled && store.policies[sessionId]?.mode === "wait"))) {
            if (!job) {
              receipt.resumeJobId ??= randomUUID();
              if (store.jobs.some(job => job.id === receipt.resumeJobId)) continue;
              const provider = typeof message?.provider === "string" ? message.provider : receipt.model?.provider;
              const modelId = typeof message?.model === "string" ? message.model : receipt.model?.modelId;
              if (!provider || !modelId) throw new ExecutionError("Quota reached but the selected model could not be identified", 500);
              job = { id: receipt.resumeJobId, sessionId, kind: "resume", status: "waiting", runAt: null, prompt: "", provider, modelId, createdAt: receipt.receivedAt };
              store.jobs.push(job);
            }
            job.status = "waiting"; job.continuation = true; job.runAt = quotaResetTime(error, receipt.receivedAt, message?.resetsAtSec); job.notBefore = undefined; job.error = error;
            dirty();
          } else if (job) {
            job.status = message?.deliveryUncertain ? "uncertain" : message?.stopReason === "aborted" ? "cancelled" : error ? "failed" : "completed";
            job.error = error || undefined; dirty();
          }
        }
      });
    } catch (error) {
      // A busy lock fails before loading the store. Freeze the current job/model
      // now, before dispatch bookkeeping can change a running claim to uncertain.
      if (receipts.some(receipt => receipt.jobId === undefined)) {
        try { captureExecutionReceiptOwners(load(), receipts); }
        catch { /* Keep the receipts intact until metadata can be loaded again. */ }
      }
      throw error;
    }
  }
  // Only retire native evidence after the metadata transaction committed.
  pendingReceipts.delete(key);
  for (const receipt of receipts) if (errors.get(key) === receipt.message) errors.delete(key);
}

/** Retry execution metadata only; this never sends or replays a native prompt. */
export function flushExecutionReceipts(): void {
  if (process.env.OMP_WEB_SCHEDULER_DISABLED === "1") return;
  const prefix = `${getAgentDir()}:`;
  for (const key of pendingReceipts.keys()) if (key.startsWith(prefix)) flushPendingExecutionReceipts(key);
}
