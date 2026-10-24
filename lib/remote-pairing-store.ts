/**
 * Process-wide singleton for the remote-access pairing service. Uses
 * globalThis so the state survives Next.js hot reloads (same pattern as
 * lib/rpc-manager.ts). State + config persist to a JSON file next to the
 * omp agent directory (survives restarts). Proxy/route bundles may have separate
 * globals; each consults the same guarded durable authority.
 */
import { join } from "path";
import { PairingService, PairingStorageError, type PairingConfig } from "./remote-pairing";
import { getAgentDir } from "./omp/paths";
import { NextResponse } from "next/server";

/** Storage errors must not produce successful pairing/revocation responses. */
export function pairingStorageErrorResponse(error: unknown): NextResponse {
  if (!(error instanceof PairingStorageError)) throw error;
  return NextResponse.json({
    error: error.message, code: "pairing_storage_unavailable",
  }, { status: 503, headers: { "cache-control": "no-store" } });
}

const GLOBAL_KEY = "__ompWebPairingService__";

type GlobalWithPairing = typeof globalThis & { [GLOBAL_KEY]?: PairingService };

export function getPairingService(): PairingService {
  const g = globalThis as GlobalWithPairing;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new PairingService({}, undefined, join(getAgentDir(), "remote-pairing.json"));
  }
  return g[GLOBAL_KEY];
}

export function updatePairingConfig(patch: Partial<PairingConfig>): PairingConfig {
  return getPairingService().updateConfig(patch);
}

export function getPairingConfig(): PairingConfig {
  return getPairingService().getConfig();
}

/** Reset the singleton (used by tests and the settings UI on demand). */
export function resetPairingService(): PairingService {
  const g = globalThis as GlobalWithPairing;
  delete g[GLOBAL_KEY];
  return getPairingService();
}
