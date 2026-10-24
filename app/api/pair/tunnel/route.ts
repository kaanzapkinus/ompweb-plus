import { NextResponse } from "next/server";
import { getPairingService, pairingStorageErrorResponse } from "@/lib/remote-pairing-store";
import { startTunnel, stopTunnel } from "@/lib/tunnel";
import { PairingStorageError } from "@/lib/remote-pairing";

export const dynamic = "force-dynamic";

/** Start/stop a quick tunnel; a configured public URL needs no local binary. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; port?: unknown };
  if (body.action === "stop") {
    stopTunnel();
    return NextResponse.json({ running: false });
  }
  try {
    const config = getPairingService().getConfig();
    if (config.publicUrl) return NextResponse.json({ url: config.publicUrl, manual: true });
    const port = Number(process.env.PORT || new URL(request.url).port || 30178);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      return NextResponse.json({ error: "Invalid server port", code: "tunnel_failed" }, { status: 500 });
    }
    // Never expose a caller-selected local port through our trusted tunnel.
    return NextResponse.json({ url: await startTunnel(port), manual: false });
  } catch (error) {
    if (error instanceof PairingStorageError) return pairingStorageErrorResponse(error);
    const code = error instanceof Error ? error.message : "tunnel_failed";
    return NextResponse.json({ error: code === "cloudflared_missing"
      ? "cloudflared was not found; configure an absolute OMP_WEB_CLOUDFLARED_BIN or public URL"
      : "cloudflared could not start the tunnel", code }, { status: code === "tunnel_running" ? 409 : 502 });
  }
}
