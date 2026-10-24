import { NextResponse } from "next/server";
import {
  assignSessionToFolder,
  createSessionFolder,
  deleteSessionFolder,
  loadSessionFoldersRegistry,
  renameSessionFolder,
  SessionFoldersError,
} from "@/lib/session-folders";

function foldersErrorResponse(error: unknown) {
  if (error instanceof SessionFoldersError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body" }, { status: 400 });
  }
  console.error("[api/session-folders]", error);
  return NextResponse.json({ error: "Session folders request failed" }, { status: 500 });
}

export async function GET() {
  try {
    const registry = loadSessionFoldersRegistry();
    return NextResponse.json(registry, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return foldersErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { name?: unknown; projectPath?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Request body must be an object" }, { status: 400 });
    }
    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "Folder name is required" }, { status: 400 });
    }
    if (typeof body.projectPath !== "string" || !body.projectPath.trim()) {
      return NextResponse.json({ error: "projectPath is required" }, { status: 400 });
    }

    const folder = await createSessionFolder(body.name, body.projectPath);
    const registry = loadSessionFoldersRegistry();
    return NextResponse.json({ folder, registry });
  } catch (error) {
    return foldersErrorResponse(error);
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json() as {
      action?: unknown;
      folderId?: unknown;
      sessionId?: unknown;
      name?: unknown;
    } | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Request body must be an object" }, { status: 400 });
    }

    if (body.action === "rename") {
      if (typeof body.folderId !== "string" || typeof body.name !== "string" || !body.name.trim()) {
        return NextResponse.json({ error: "folderId and name are required" }, { status: 400 });
      }
      const ok = renameSessionFolder(body.folderId, body.name);
      if (!ok) return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    } else if (body.action === "assign") {
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) {
        return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
      }
      if (body.folderId !== undefined && body.folderId !== null && typeof body.folderId !== "string") {
        return NextResponse.json({ error: "folderId must be a string or null" }, { status: 400 });
      }
      await assignSessionToFolder(body.sessionId, body.folderId ?? null);
    } else if (body.action === "delete") {
      if (typeof body.folderId !== "string" || !body.folderId.trim()) {
        return NextResponse.json({ error: "folderId is required" }, { status: 400 });
      }
      const ok = deleteSessionFolder(body.folderId);
      if (!ok) return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    } else {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    const registry = loadSessionFoldersRegistry();
    return NextResponse.json(registry);
  } catch (error) {
    return foldersErrorResponse(error);
  }
}
