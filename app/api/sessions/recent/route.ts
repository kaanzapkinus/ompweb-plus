import { NextResponse } from "next/server";
import { listRecentSessions } from "@/lib/session-discovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store", Vary: "Cookie" } as const;

export async function GET(req: Request) {
  if (new URL(req.url).searchParams.size) {
    return NextResponse.json({ error: "Recent sessions accepts no query parameters", code: "invalid_request" }, { status: 400, headers: HEADERS });
  }
  try {
    return NextResponse.json(await listRecentSessions({ signal: req.signal }), { headers: HEADERS });
  } catch (error) {
    if (req.signal.aborted) return new NextResponse(null, { status: 499, headers: HEADERS });
    console.error("Recent session discovery failed", error);
    return NextResponse.json({ error: "Unable to list recent sessions", code: "internal_error" }, { status: 500, headers: HEADERS });
  }
}
