import { NextResponse } from "next/server";
import { getPairingService, pairingStorageErrorResponse } from "@/lib/remote-pairing-store";
import { pairingBase } from "@/lib/remote-pairing";
import { getTunnelUrl } from "@/lib/tunnel";
import { isTrustedLocalRequest } from "@/lib/trusted-peer";

export const dynamic = "force-dynamic";

/**
 * Issue (or refresh) a one-time pairing token. Any previous token is
 * immediately invalidated, so a refreshed QR kills the old link.
 * The returned URLs are derived from the request Host header so the QR
 * works for LAN IPs and public tunnels alike.
 */
export async function POST(request: Request) {
  if (!isTrustedLocalRequest(request)) {
    return NextResponse.json({ error: "Pairing tokens can only be issued from this computer", code: "token_loopback_only" }, { status: 403 });
  }
  try {
    const service = getPairingService();
    const { token, expiresAt } = service.issue();
    const base = pairingBase(request, service.getConfig().publicUrl || getTunnelUrl() || undefined, process.env.PORT);
    return NextResponse.json({
      token,
      expiresAt,
      qrData: `${base}/remote?token=${token}`,
      phoneUrl: `${base}/remote?token=${token}`,
      desktopUrl: base,
    });
  } catch (error) {
    return pairingStorageErrorResponse(error);
  }
}
