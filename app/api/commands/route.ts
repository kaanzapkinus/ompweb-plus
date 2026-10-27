import { NextResponse } from "next/server";
import { statSync } from "node:fs";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { RpcProcess } from "@/lib/omp/rpc-process";
import type { RpcAvailableSlashCommand } from "@/lib/pi-types";

export const dynamic = "force-dynamic";

/** Discover workspace commands without creating or switching a conversation. */
export async function GET(request: Request) {
  const cwd = new URL(request.url).searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  try {
    if (!statSync(cwd).isDirectory() || !isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) {
      return NextResponse.json({ error: "Workspace is not allowed" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Workspace is not allowed" }, { status: 403 });
  }
  const process = new RpcProcess({ cwd, extraArgs: ["--no-session", "--no-lsp"] });
  const timeout = Promise.withResolvers<never>();
  const deadline = setTimeout(() => timeout.reject(new Error("Workspace command discovery timed out")), 40_000);
  try {
    const result = await Promise.race([
      (async () => {
        const ready = await process.waitReady(20_000);
        await process.negotiateProtocol(ready);
        return process.sendCommand<{ commands?: RpcAvailableSlashCommand[] }>({ type: "get_available_commands" }, 20_000);
      })(),
      timeout.promise,
    ]);
    return NextResponse.json({ commands: result.commands ?? [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  } finally {
    clearTimeout(deadline);
    await process.dispose();
  }
}
