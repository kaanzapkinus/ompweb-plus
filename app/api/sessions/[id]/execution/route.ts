import { NextResponse } from "next/server";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { getRpcSession, WebRpcError } from "@/lib/rpc-manager";
import { RpcCommandError } from "@/lib/omp/rpc-process";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "@/lib/image-attachments";
import { runUtilityCommand } from "@/lib/omp/rpc-utility";
import { cancelExecutionJob, createExecutionJob, dismissExecutionJob, editExecutionJob, executionPromptPayload, ExecutionError, findExecutionRequest, getExecutionResponseSnapshot, getExecutionSnapshot, setExecutionMode, setExecutionTime, type ExecutionPromptPayload } from "@/lib/session-execution";
import type { ExecutionMode } from "@/lib/session-execution-types";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
function failure(error: unknown) {
  return NextResponse.json({
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof WebRpcError || error instanceof RpcCommandError ? { code: error.code ?? "rpc_command_failed" } : {}),
  }, { status: error instanceof ExecutionError ? error.status : error instanceof RequestBodyTooLargeError ? 413 : error instanceof SyntaxError || error instanceof WebRpcError || error instanceof RpcCommandError ? 400 : 500 });
}
async function handle(req: Request, context: Context) {
  try {
    const { id: requestedId } = await context.params;
    // Native persistence moves keep a live registry alias for old tabs. Never
    // let those tabs recreate execution ownership on the obsolete identity.
    const resolved = await resolveSessionPathOr404(getRpcSession(requestedId)?.sessionId || requestedId);
    if ("response" in resolved) return resolved.response;
    if (req.method !== "GET") {
      if (process.env.OMP_WEB_SCHEDULER_DISABLED === "1") throw new ExecutionError("Execution is disabled on this verification server", 503);
      const body = await parseJsonWithinLimit(req, MAX_AGENT_COMMAND_REQUEST_BYTES) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ExecutionError("Expected an object");
      let id = getRpcSession(requestedId)?.sessionId || requestedId;
      if (req.method === "POST") {
        const payload = executionPromptPayload(body as unknown as ExecutionPromptPayload);
        // An accepted request remains recoverable after the catalog changes,
        // its deadline passes, or its editable job changes.
        if (typeof body.requestId !== "string" || !findExecutionRequest(body.requestId)) {
          const available = await runUtilityCommand<{ models?: { provider: string; id: string }[] }>({ type: "get_available_models" });
          if (!available.models?.some(model => model.provider === payload.provider && model.id === payload.modelId)) throw new ExecutionError("Selected model is unavailable");
        }
        id = getRpcSession(requestedId)?.sessionId || requestedId;
        createExecutionJob(id, { ...payload, requestId: body.requestId as string | undefined });
      } else if (req.method === "DELETE") {
        if (typeof body.jobId !== "string") throw new ExecutionError("Job ID is required");
        cancelExecutionJob(id, body.jobId);
      } else if ("dismissJobId" in body) {
        if (typeof body.dismissJobId !== "string") throw new ExecutionError("Job ID is required");
        dismissExecutionJob(id, body.dismissJobId);
      } else if ("resumeAt" in body) {
        if (body.jobId !== undefined && typeof body.jobId !== "string") throw new ExecutionError("Invalid job ID");
        setExecutionTime(id, body.resumeAt as number, body.jobId as string | undefined);
      } else if ("jobId" in body && "prompt" in body) {
        if (typeof body.jobId !== "string") throw new ExecutionError("Job ID is required");
        if (body.expectedUpdatedAt !== undefined && typeof body.expectedUpdatedAt !== "number") throw new ExecutionError("Invalid expected update time");
        const payload = executionPromptPayload(body as unknown as ExecutionPromptPayload);
        const available = await runUtilityCommand<{ models?: { provider: string; id: string }[] }>({ type: "get_available_models" });
        if (!available.models?.some(model => model.provider === payload.provider && model.id === payload.modelId)) throw new ExecutionError("Selected model is unavailable");
        id = getRpcSession(requestedId)?.sessionId || requestedId;
        editExecutionJob(id, body.jobId, payload, body.expectedUpdatedAt as number | undefined);
      } else {
        if (body.mode !== "fallback" && body.mode !== "wait") throw new ExecutionError("Invalid execution mode");
        const session = getRpcSession(id);
        const previousId = id;
        const state = session?.isAlive() ? await session.send({ type: "get_state" }) as { model?: { provider: string; id: string } } : null;
        id = session?.sessionId || id;
        if (id !== previousId && getRpcSession(requestedId) !== session) throw new ExecutionError("Conversation changed; reload its execution controls", 409);
        const previous = getExecutionSnapshot(id).policy.mode;
        const model = state?.model ? { provider: state.model.provider, modelId: state.model.id } : undefined;
        setExecutionMode(id, body.mode as ExecutionMode, model);
        try {
          if (body.mode === "wait" && session?.isAlive()) await session.send({ type: "set_auto_retry", enabled: false });
        } catch (error) {
          const rollbackId = getRpcSession(requestedId) === session ? session?.sessionId || id : id;
          setExecutionMode(rollbackId, previous, model);
          throw error;
        }
      }
    }
    const imageJobId = req.method === "GET" ? new URL(req.url).searchParams.get("jobId") ?? undefined : undefined;
    return NextResponse.json(getExecutionResponseSnapshot(getRpcSession(requestedId)?.sessionId || requestedId, imageJobId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
