import { NextResponse } from "next/server";
import { readRecentModels, recordRecentModel } from "@/lib/omp/recent-models";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    const recentKeys = readRecentModels();
    return NextResponse.json({ recentKeys });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { provider?: unknown; modelId?: unknown };
    if (typeof body.provider !== "string" || typeof body.modelId !== "string" || !body.provider.trim() || !body.modelId.trim()) {
      return NextResponse.json({ error: "provider and modelId are required strings" }, { status: 400 });
    }
    const recentKeys = recordRecentModel(body.provider.trim(), body.modelId.trim());
    return NextResponse.json({ success: true, recentKeys });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}
