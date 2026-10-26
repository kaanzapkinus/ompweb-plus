import { NextResponse } from "next/server";
import { assignSessionToWorkspace, createWorkspace, deleteWorkspace, loadWorkspacesRegistry, renameWorkspace, WorkspacesError } from "@/lib/workspaces";

export const dynamic = "force-dynamic";
function errorResponse(error: unknown) {
  if (error instanceof WorkspacesError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON request body" }, { status: 400 });
  console.error("[api/workspaces]", error);
  return NextResponse.json({ error: "Workspaces request failed" }, { status: 500 });
}
export async function GET() {
  try { return NextResponse.json(await loadWorkspacesRegistry(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.name !== "string" || typeof body.cwd !== "string") {
      throw new WorkspacesError("Workspace name and cwd are required");
    }
    await createWorkspace(body.name, body.cwd);
    return NextResponse.json(await loadWorkspacesRegistry());
  } catch (error) { return errorResponse(error); }
}
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new WorkspacesError("Expected an object");
    if (body.action === "rename") await renameWorkspace(body.workspaceId, body.name);
    else if (body.action === "delete") await deleteWorkspace(body.workspaceId);
    else if (body.action === "assign") await assignSessionToWorkspace(body.sessionId, body.workspaceId);
    else throw new WorkspacesError("Invalid action");
    return NextResponse.json(await loadWorkspacesRegistry());
  } catch (error) { return errorResponse(error); }
}
