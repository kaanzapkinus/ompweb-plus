import { existsSync } from "node:fs";
import { resolveSessionPath, readSessionHeader } from "./session-reader";
import { getRpcSession, startRpcSession, resolveSpawnCwdResult, WebRpcError } from "./rpc-manager";
import { RpcCommandError } from "./omp/rpc-process";
import { isBtwRecord, latestBtwTurn, type BtwRecord } from "./btw";
import { RESUME_PROMPT } from "./session-resume";
import { claimExecutionJob, findExecutionJob, flushExecutionReceipts, getUnknownQuotaWaits, recordExecutionControlResult, resolveQuotaWait, scheduledNativeCommand, updateExecutionJob, type StoredExecutionJob } from "./session-execution";
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
    if (!await session.acquireExecution(job.id, job)) {
      updateExecutionJob(job.id, { status: "pending", notBefore: Date.now() + 5000 });
      return;
    }
    release = () => session.releaseExecution(job.id);
    await session.send({ type: "set_auto_retry", enabled: false }, job.id);
    await session.send({ type: "set_model", provider: job.provider, modelId: job.modelId }, job.id);
    if (job.thinkingLevel !== undefined && job.thinkingLevel !== "auto") await session.send({ type: "set_thinking_level", level: job.thinkingLevel }, job.id);
    if (job.fastMode !== undefined) await session.send({ type: "set_fast_mode", enabled: job.fastMode }, job.id);
    if (job.slowMode !== undefined) await session.send({ type: "set_slow_mode", enabled: job.slowMode }, job.id);
    const continuation = job.continuation || job.kind === "resume";
    const control = continuation ? null : scheduledNativeCommand(job.prompt);
    if (control?.type === "btw") {
      const releaseSideQuestion = release;
      let recordId: string | undefined;
      const records = new Map<string, BtwRecord>();
      const settle = (record: BtwRecord) => {
        const turn = latestBtwTurn(record);
        if (turn.status === "running") return;
        try {
          recordExecutionControlResult(session.sessionId, job.id,
            turn.status === "complete" ? "completed" : turn.status === "cancelled" ? "cancelled" : turn.status === "interrupted" ? "uncertain" : "failed",
            turn.error);
        } finally {
          unsubscribe?.();
          session.trackExecutionSideQuestion(job.id, false);
          releaseSideQuestion();
        }
      };
      unsubscribe = session.onEvent(event => {
        if (event.type === "btw_record" && isBtwRecord(event.record)) {
          records.set(event.record.id, event.record);
          if (event.record.id === recordId) settle(event.record);
        } else if (event.type === "prompt_error") {
          try {
            recordExecutionControlResult(session.sessionId, job.id, event.deliveryUncertain ? "uncertain" : "failed",
              typeof event.errorMessage === "string" ? event.errorMessage : typeof event.error === "string" ? event.error : "The side question failed");
          } finally {
            unsubscribe?.();
            session.trackExecutionSideQuestion(job.id, false);
            releaseSideQuestion();
          }
        }
      });
      if (findExecutionJob(job.id)?.sessionId !== session.sessionId) throw new Error("Conversation identity changed; scheduled side question was not sent.");
      updateExecutionJob(job.id, { stage: "dispatching" });
      session.trackExecutionSideQuestion(job.id, true);
      dispatched = true;
      try {
        const result = await session.send(control, job.id) as { record?: unknown } | null;
        if (!isBtwRecord(result?.record)) throw new Error("The side question was sent but no recoverable native record was returned. Check BTW history before asking again.");
        recordId = result.record.id;
        updateExecutionJob(job.id, { stage: "active", btwId: recordId });
        settle(records.get(recordId) ?? result.record);
        // The record stream now owns release; other turns cannot steal the
        // selected model while this scheduled side question is still running.
        release = undefined;
      } catch (error) {
        session.trackExecutionSideQuestion(job.id, false);
        throw error;
      }
      return;
    }
    if (control) {
      if (findExecutionJob(job.id)?.sessionId !== session.sessionId) throw new Error("Conversation identity changed; scheduled command was not sent.");
      updateExecutionJob(job.id, { stage: "dispatching" });
      dispatched = true;
      await session.send(control, job.id);
      recordExecutionControlResult(session.sessionId, job.id, "completed");
      return;
    }
    if (findExecutionJob(job.id)?.sessionId !== session.sessionId) throw new Error("Conversation identity changed; scheduled prompt was not sent.");
    updateExecutionJob(job.id, { stage: "dispatching" });
    dispatched = true;
    await session.send({
      type: "prompt",
      message: continuation ? RESUME_PROMPT : job.prompt,
      ...(!continuation && job.images?.length ? { images: job.images.map(image => ({ type: "image", ...image })) } : {}),
    }, job.id);
    updateExecutionJob(job.id, { stage: "active" });
    release();
    release = undefined;
  } catch (error) {
    unsubscribe?.();
    const rejected = error instanceof RpcCommandError || (error instanceof WebRpcError && error.code !== "session_unresponsive");
    updateExecutionJob(job.id, { status: dispatched && !rejected ? "uncertain" : "failed", error: error instanceof Error ? error.message : String(error) });
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
