import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "@/lib/image-attachments";
import { isRecord } from "@/lib/type-guards";
import { deleteDurableDraft, durableDraftRecordEtag, DraftConflictError, DraftStorageError, listDurableDraftHistory, readDurableDraftResponse, saveDurableDraft } from "@/lib/durable-drafts";
import type { SaveDurableDraftInput } from "@/lib/durable-draft-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function failure(error: unknown) {
  return NextResponse.json({
    error: error instanceof Error ? error.message : "Draft storage is unavailable",
    ...(error instanceof DraftConflictError ? { record: error.record } : {}),
  }, { status: error instanceof DraftStorageError ? error.status : error instanceof RequestBodyTooLargeError ? 413 : 500, headers: { "Cache-Control": "no-store", ...(error instanceof DraftConflictError ? { ETag: durableDraftRecordEtag(error.record) } : {}) } });
}
function revision(value: string | null): number {
  if (value === null || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new DraftStorageError("A nonnegative safe integer revision is required", 400);
  return Number(value);
}

export async function GET(req: Request) {
  try {
    const query = new URL(req.url).searchParams;
    const key = query.get("key") ?? "";
    if (query.has("history")) {
      if (query.get("history") !== "1" || query.has("revision")) throw new DraftStorageError("Use history=1 without a revision", 400);
      return NextResponse.json({ versions: await listDurableDraftHistory(key) }, { headers: { "Cache-Control": "no-store" } });
    }
    const selectedRevision = query.has("revision") ? revision(query.get("revision")) : undefined;
    const result = await readDurableDraftResponse(key, selectedRevision, req.headers.get("if-none-match"));
    const headers = { ETag: result.etag, "Cache-Control": "private, no-cache" };
    return result.record === null ? new NextResponse(null, { status: 304, headers }) : NextResponse.json({ record: result.record }, { headers });
  } catch (error) { return failure(error); }
}

export async function PUT(req: Request) {
  try {
    let body: unknown;
    try { body = await parseJsonWithinLimit<unknown>(req, MAX_AGENT_COMMAND_REQUEST_BYTES); }
    catch (error) {
      if (error instanceof RequestBodyTooLargeError) throw error;
      throw new DraftStorageError("Draft request must contain valid UTF-8 JSON", 400);
    }
    if (!isRecord(body)) throw new DraftStorageError("Expected a draft save object", 400);
    const record = await saveDurableDraft(body as unknown as SaveDurableDraftInput, false);
    return NextResponse.json({ record }, { headers: { "Cache-Control": "no-store", ETag: durableDraftRecordEtag(record) } });
  } catch (error) { return failure(error); }
}

/** Explicit whole-draft cleanup only. Clearing after send uses a null PUT and
 * intentionally leaves every history checkpoint and draft-owned image intact. */
export async function DELETE(req: Request) {
  try {
    const query = new URL(req.url).searchParams;
    const record = await deleteDurableDraft(query.get("key") ?? "", revision(query.get("baseRevision")));
    return NextResponse.json({ deleted: true, record }, { headers: { "Cache-Control": "no-store", ETag: durableDraftRecordEtag(record) } });
  } catch (error) { return failure(error); }
}
