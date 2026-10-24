import { NextResponse } from "next/server";
import { existsSync, realpathSync, statSync } from "node:fs";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { allowFileRoot } from "@/lib/file-access";
import { startRpcSession, type AgentSessionWrapper } from "@/lib/rpc-manager";
import { runUtilityCommand } from "@/lib/omp/rpc-utility";
import { invalidateSessionListCache, listAllSessions, readSessionHeader, resolveSessionPath } from "@/lib/session-reader";
import { beginScheduledChatCreation, createExecutionJob, ExecutionError, findExecutionRequest, getExecutionSnapshot, recordScheduledChatSession, reserveScheduledChatRequest, type ScheduledChatCreation, type ScheduledChatDraft } from "@/lib/session-execution";
import { getAgentDir } from "@/lib/omp/paths";
import type { ExecutionSnapshot } from "@/lib/session-execution-types";
import type { SessionInfo } from "@/lib/types";

export const dynamic = "force-dynamic";
type Draft = ScheduledChatDraft;
type Result = ExecutionSnapshot & { session: SessionInfo };
type Creation = { sessionId?: string; sessionFile?: string; inFlight?: Promise<Result> };
const runtime = globalThis as unknown as { __ompScheduledChats?: Map<string, Creation> };
const creations = runtime.__ompScheduledChats ??= new Map<string, Creation>();

async function responseFor(sessionId: string) {
  invalidateSessionListCache();
  const session = (await listAllSessions()).find(item => item.id === sessionId);
  if (!session) throw new ExecutionError("The saved conversation could not be loaded. Retry to recover the scheduled prompt.", 500);
  return { ...getExecutionSnapshot(sessionId), session };
}

async function create(draft: Draft, creation: Creation, journal: ScheduledChatCreation): Promise<Result> {
  // If the native response was known but its journal write failed, a same-process
  // retry can still save that exact identity. A restart cannot guess this outcome.
  if (journal.phase !== "created" && creation.sessionId && creation.sessionFile) {
    recordScheduledChatSession(draft.requestId, creation.sessionId, creation.sessionFile);
    journal = reserveScheduledChatRequest(draft);
  }
  let session: AgentSessionWrapper | undefined;
  try {
    if (journal.phase === "created") {
      const file = await resolveSessionPath(journal.sessionId!) ?? journal.sessionFile!;
      const header = existsSync(file) ? readSessionHeader(file) : null;
      if (!header || header.id !== journal.sessionId || realpathSync(header.cwd) !== draft.cwd) {
        throw new ExecutionError("The previously created conversation could not be recovered. Restore its native file before retrying this request; no second conversation was created.", 409);
      }
      ({ session } = await startRpcSession(journal.sessionId!, file, draft.cwd));
      if (reserveScheduledChatRequest(draft).sessionId !== session.sessionId) throw new ExecutionError("Conversation identity changed without a native persistence move; no prompt was scheduled.", 409);
    } else {
      if (journal.phase === "reserved") {
        const available = await runUtilityCommand<{ models?: { provider: string; id: string }[] }>({ type: "get_available_models" });
        if (!available.models?.some(model => model.provider === draft.provider && model.id === draft.modelId)) throw new ExecutionError("Selected model is unavailable");
      }
      // Native new_session has response correlation, not durable request-ID
      // deduplication. Journal the boundary first; an unknown outcome is not replayed.
      beginScheduledChatCreation(draft.requestId);
      ({ session } = await startRpcSession(`__scheduled__${draft.requestId}`, "", draft.cwd));
      // startRpcSession may already have issued new_session to escape native
      // auto-resume. Reuse that fresh persisted identity instead of creating two.
      if (!session.sessionFile || !existsSync(session.sessionFile)) {
        const result = await session.send({ type: "new_session" }) as { cancelled?: boolean };
        if (result.cancelled) throw new ExecutionError("Native session creation was cancelled", 409);
      }
      if (!session.sessionId || !session.sessionFile) throw new ExecutionError("Native session creation returned no recoverable identity", 500);
      creation.sessionId = session.sessionId;
      creation.sessionFile = session.sessionFile;
      recordScheduledChatSession(draft.requestId, creation.sessionId, creation.sessionFile);
      if (!existsSync(creation.sessionFile)) throw new ExecutionError("The native conversation file was not persisted. Restore it before retrying this request.", 500);
    }
    await session.send({ type: "set_session_name", name: draft.prompt.slice(0, 80) });
    // Naming a resumed native file can itself trigger an ownership move.
    // Reconcile that supported state boundary before attaching the job.
    await session.send({ type: "get_state" });
    allowFileRoot(draft.cwd);
    createExecutionJob(session.sessionId, draft);
    return await responseFor(session.sessionId);
  } catch (error) {
    await session?.destroyAndWait();
    throw error;
  }
}

export async function POST(req: Request) {
  try {
    if (process.env.OMP_WEB_SCHEDULER_DISABLED === "1") throw new ExecutionError("Execution is disabled on this verification server", 503);
    const body = await parseJsonWithinLimit(req, 128 * 1024) as Partial<Draft>;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ExecutionError("Expected an object");
    if (typeof body.cwd !== "string" || !body.cwd || !existsSync(body.cwd) || !statSync(body.cwd).isDirectory()) throw new ExecutionError("Choose an existing workspace directory");
    if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 65_536) throw new ExecutionError("Prompt must contain between 1 and 65536 characters");
    if (typeof body.provider !== "string" || !body.provider.trim() || typeof body.modelId !== "string" || !body.modelId.trim()) throw new ExecutionError("A provider and model are required");
    if (typeof body.requestId !== "string" || !/^[a-f0-9]{32}$/.test(body.requestId)) throw new ExecutionError("A valid schedule request ID is required");
    const draft: Draft = { cwd: realpathSync(body.cwd), prompt: body.prompt.trim(), runAt: body.runAt as number, provider: body.provider, modelId: body.modelId, requestId: body.requestId };
    const previous = findExecutionRequest(draft.requestId);
    if (previous) {
      const file = await resolveSessionPath(previous.sessionId);
      const header = file ? readSessionHeader(file) : null;
      if (!header || realpathSync(header.cwd) !== draft.cwd) throw new ExecutionError("Request ID belongs to another workspace", 409);
      // Deduplication deliberately precedes the deadline check, recovering a
      // saved request even if its response was lost until after execution time.
      createExecutionJob(previous.sessionId, draft);
      return NextResponse.json(await responseFor(previous.sessionId));
    }
    const journal = reserveScheduledChatRequest(draft);
    const key = `${getAgentDir()}:${draft.requestId}`;
    let creation = creations.get(key);
    if (!creation) { creation = {}; creations.set(key, creation); }
    if (!creation.inFlight) creation.inFlight = create(draft, creation, journal);
    try {
      const result = await creation.inFlight;
      creations.delete(key);
      return NextResponse.json(result);
    } finally {
      creation.inFlight = undefined;
      // Keep a known identity if its durable write failed; unknown native
      // outcomes remain explicitly uncertain in the journal after restart.
      if (!creation.sessionId) creations.delete(key);
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof ExecutionError ? error.status : error instanceof RequestBodyTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 500 });
  }
}
