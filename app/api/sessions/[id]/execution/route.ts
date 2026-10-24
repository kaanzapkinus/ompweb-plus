import { NextResponse } from "next/server";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { getRpcSession } from "@/lib/rpc-manager";
import { runUtilityCommand } from "@/lib/omp/rpc-utility";
import { cancelExecutionJob, createExecutionJob, ExecutionError, getExecutionSnapshot, setExecutionMode, setExecutionTime } from "@/lib/session-execution";
import type { ExecutionMode } from "@/lib/session-execution-types";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
function failure(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof ExecutionError ? error.status : error instanceof RequestBodyTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 500 });
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
      const body = await parseJsonWithinLimit(req, 128 * 1024) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ExecutionError("Expected an object");
      let id = getRpcSession(requestedId)?.sessionId || requestedId;
      if (req.method === "POST") {
        const available = await runUtilityCommand<{ models?: { provider: string; id: string }[] }>({ type: "get_available_models" });
        if (!available.models?.some(model => model.provider === body.provider && model.id === body.modelId)) throw new ExecutionError("Selected model is unavailable");
        id = getRpcSession(requestedId)?.sessionId || requestedId;
        createExecutionJob(id, { prompt: body.prompt as string, runAt: body.runAt as number, provider: body.provider as string, modelId: body.modelId as string, requestId: body.requestId as string | undefined });
      } else if (req.method === "DELETE") {
        if (typeof body.jobId !== "string") throw new ExecutionError("Job ID is required");
        cancelExecutionJob(id, body.jobId);
      } else if ("resumeAt" in body) {
        if (body.jobId !== undefined && typeof body.jobId !== "string") throw new ExecutionError("Invalid job ID");
        setExecutionTime(id, body.resumeAt as number, body.jobId as string | undefined);
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
    return NextResponse.json(getExecutionSnapshot(getRpcSession(requestedId)?.sessionId || requestedId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
