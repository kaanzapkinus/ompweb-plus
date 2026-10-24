import { NextResponse } from "next/server";
import { getPairingService, pairingStorageErrorResponse } from "@/lib/remote-pairing-store";
import { stopTunnel } from "@/lib/tunnel";

export const dynamic = "force-dynamic";

/** Revoke every paired device and clear the active token. */
export async function POST() {
  try {
    getPairingService().stop();
    stopTunnel();
    return NextResponse.json({ success: true });
  } catch (error) {
    return pairingStorageErrorResponse(error);
  }
}
