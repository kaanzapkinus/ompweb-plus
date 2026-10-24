import { NextResponse } from "next/server";
import { getPairingService, pairingStorageErrorResponse } from "@/lib/remote-pairing-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const service = getPairingService();
    const devices = service.listDevices().map((device) => ({
      ...device,
      online: service.isOnline(device),
    }));
    return NextResponse.json({ devices, config: service.getConfig() });
  } catch (error) {
    return pairingStorageErrorResponse(error);
  }
}
