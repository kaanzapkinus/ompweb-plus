import { existsSync } from "node:fs";
import { resolveSessionPath, readSessionHeader } from "./session-reader";
import { getRpcSession, startRpcSession, resolveSpawnCwdResult } from "./rpc-manager";
import { RESUME_PROMPT } from "./session-resume";
import { claimExecutionJob, findExecutionJob, flushExecutionReceipts, getUnknownQuotaWaits, resolveQuotaWait, updateExecutionJob, type StoredExecutionJob } from "./session-execution";
import { getProviderUsage, providerQuotaResetTime } from "./provider-usage";

const runtime = globalThis as unknown as { __ompExecutionTimer?: NodeJS.Timeout; __ompExecutionTick?: boolean; __ompQuotaReconcile?: Promise<void> };

async function dispatch(job: StoredExecutionJob): Promise<void> {
  let release: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let dispatched = false;
  try {
    const file = await resolveSessionPath(job.sessionId);
    if (!file || !existsSync(file)) {
      updateExecutionJob(job.id, { status: "failed", error: "The conversation was archived or removed; restore it before scheduling again." });
      return;
    }
    const existing = getRpcSession(job.sessionId);
    if (existing?.isRunning()) {
      updateExecutionJob(job.id, { status: "pending", notBefore: Date.now() + 5000, error: "Waiting for the current turn to finish." });
      return;
    }
    const header = readSessionHeader(file);
    const { cwd } = resolveSpawnCwdResult(header?.cwd);
    const { session } = await startRpcSession(job.sessionId, file, cwd, undefined, undefined, header?.cwd);
    // A native persistence move atomically rekeys the durable claim. A branch
    // or session switch does not, so it still fails closed before dispatch.
    if (findExecutionJob(job.id)?.sessionId !== session.sessionId) throw new Error("Conversation identity changed; scheduled prompt was not sent.");
    job.sessionId = session.sessionId;
    if (!await session.acquireExecution(job.id)) {
      updateExecutionJob(job.id, { status: "pending", notBefore: Date.now() + 5000 });
      return;
    }
    release = () => session.releaseExecution(job.id);
    await session.send({ type: "set_auto_retry", enabled: false }, job.id);
    await session.send({ type: "set_model", provider: job.provider, modelId: job.modelId }, job.id);
    unsubscribe = session.onEvent((event) => {
      if ((event.type === "agent_end" && event.isTerminal !== false) || event.type === "prompt_error" || event.type === "prompt_result") {
        unsubscribe?.();
      }
    });
    if (findExecutionJob(job.id)?.sessionId !== session.sessionId) throw new Error("Conversation identity changed; scheduled prompt was not sent.");
    updateExecutionJob(job.id, { stage: "dispatching" });
    dispatched = true;
    await session.send({ type: "prompt", message: job.continuation || job.kind === "resume" ? RESUME_PROMPT : job.prompt }, job.id);
    updateExecutionJob(job.id, { stage: "active" });
    release();
    release = undefined;
  } catch (error) {
    unsubscribe?.();
    updateExecutionJob(job.id, { status: dispatched ? "uncertain" : "failed", error: error instanceof Error ? error.message : String(error) });
  } finally { release?.(); }
}

export async function reconcileQuotaWaits(readUsage: typeof getProviderUsage = getProviderUsage): Promise<void> {
  const snapshots = new Map<string, ReturnType<typeof getProviderUsage>>();
  for (const job of getUnknownQuotaWaits()) {
    let snapshot = snapshots.get(job.provider);
    if (!snapshot) {
      snapshot = readUsage({ provider: job.provider });
      snapshots.set(job.provider, snapshot);
    }
    try {
      const reset = providerQuotaResetTime(await snapshot, job);
      if (reset !== null) resolveQuotaWait(job.id, reset);
    } catch (error) {
      // Preserve manual waiting on unavailable usage data; other scheduled chats
      // must still be dispatched even when one provider's quota lookup fails.
      console.error("[omp-web] quota reset lookup failed:", job.provider, error instanceof Error ? error.message : String(error));
    }
  }
}

export async function runExecutionTick(): Promise<void> {
  if (process.env.OMP_WEB_SCHEDULER_DISABLED === "1" || runtime.__ompExecutionTick) return;
  runtime.__ompExecutionTick = true;
  try {
    // Native terminal evidence may be waiting on a previously busy store lock.
    // Commit that evidence before allowing another job to claim this chat.
    flushExecutionReceipts();
    // Quota collection can wait on a provider CLI. Keep it single-flight, but
    // never hold up ordinary due jobs (or the next scheduler tick) behind it.
    runtime.__ompQuotaReconcile ??= reconcileQuotaWaits()
      .catch(error => console.error("[omp-web] quota wait reconciliation failed:", error instanceof Error ? error.message : String(error)))
      .finally(() => { runtime.__ompQuotaReconcile = undefined; });
    // A tick claims one job at a time; running turns do not occupy the worker.
    // The persistent claim serializes each conversation across server processes.
    for (let count = 0; count < 20; count++) {
      const job = claimExecutionJob();
      if (!job) break;
      await dispatch(job);
    }
  } catch (error) {
    console.error("[omp-web] scheduled execution failed:", error instanceof Error ? error.message : String(error));
  } finally { runtime.__ompExecutionTick = false; }
}

export function startExecutionScheduler(): void {
  if (process.env.OMP_WEB_SCHEDULER_DISABLED === "1" || process.env.NEXT_PHASE === "phase-production-build" || runtime.__ompExecutionTimer) return;
  runtime.__ompExecutionTimer = setInterval(() => void runExecutionTick(), 2000);
  runtime.__ompExecutionTimer.unref();
  void runExecutionTick();
}
