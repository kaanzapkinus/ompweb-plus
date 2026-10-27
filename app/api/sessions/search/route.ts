import { NextResponse } from "next/server";
import { searchSessions } from "@/lib/session-discovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store", Vary: "Cookie" } as const;

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const query = params.get("q") ?? "";
  const offsetValue = params.get("offset") ?? "0";
  const limitValue = params.get("limit") ?? "50";
  const offset = Number(offsetValue);
  const limit = Number(limitValue);
  if ([...params.keys()].some(key => (key !== "q" && key !== "offset" && key !== "limit") || params.getAll(key).length !== 1)
    || query.length > 2048
    || !/^\d+$/.test(offsetValue) || !Number.isSafeInteger(offset) || offset < 0
    || !/^\d+$/.test(limitValue) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return NextResponse.json({ error: "Invalid search parameters", code: "invalid_request" }, { status: 400, headers: HEADERS });
  }
  try {
    return NextResponse.json(await searchSessions(query, { offset, limit, signal: req.signal }), { headers: HEADERS });
  } catch (error) {
    if (req.signal.aborted) return new NextResponse(null, { status: 499, headers: HEADERS });
    console.error("Session search failed", error);
    return NextResponse.json({ error: "Unable to search sessions", code: "internal_error" }, { status: 500, headers: HEADERS });
  }
}
