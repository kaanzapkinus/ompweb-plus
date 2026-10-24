import { NextResponse, type NextRequest } from "next/server";
import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";
import {
  isTrustedProxyRequest,
  isValidWebSession,
  isWebPasswordEnabled,
  webPasswordConfigurationProblem,
  OMP_WEB_SESSION_COOKIE,
  OMP_WEB_TRUSTED_HEADER,
} from "@/lib/web-auth";
import { join } from "node:path";
import { getAgentDir } from "@/lib/omp/paths";
import { readPairingState, pairingStorageUnavailable } from "@/lib/remote-pairing";
import { isTrustedLocalRequest } from "@/lib/trusted-peer";

function checkPairingGate(request: NextRequest): NextResponse | null {
  if (isTrustedLocalRequest(request)) return null;
  const { pathname } = request.nextUrl;
  if (pathname === "/api/pair/token") {
    return NextResponse.json({ error: "Pairing tokens can only be issued from this computer", code: "token_loopback_only" }, { status: 403 });
  }
  // A fresh phone can accept a QR and sign in, in either order. These routes
  // expose no workspace data; every other page/API needs both credentials.
  if (pathname === "/remote" || pathname === "/api/pair/accept"
    || pathname === "/login" || pathname === "/api/web-auth/session") return null;
  // Proxy and route bundles may not share a JS global. Consult the persisted
  // store so a device/config revocation is effective on the very next request.
  const path = join(getAgentDir(), "remote-pairing.json");
  if (pairingStorageUnavailable(path)) {
    return NextResponse.json({
      error: "Pairing storage is unavailable; remote access is disabled", code: "pairing_storage_unavailable",
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  try {
    const state = readPairingState(path);
    if (state.config?.requirePairingForLan === false) return null;
    const id = request.cookies.get(state.config?.cookieName ?? "dsh_pair")?.value;
    const expiry = state.config?.idleExpireMs ?? 7 * 24 * 60 * 60 * 1000;
    if (id && state.devices?.some((device) => device.id === id
      && typeof device.lastActiveAt === "number"
      && Number.isFinite(expiry) && expiry > 0
      && Date.now() - device.lastActiveAt <= expiry)) return null;
  } catch {
    // Missing or corrupt state never silently opens remote access.
  }
  return NextResponse.json({ error: "Remote access requires a paired device", code: "pairing_required" }, {
    status: 401, headers: { "cache-control": "no-store" },
  });
}

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/") && shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) {
    return NextResponse.json({ error: "Cross-origin API requests are not allowed" }, { status: 403 });
  }
  // A configured-but-unusable password (plaintext, or a truncated hash) must
  // never degrade into an open server: refuse every request with the fix. The
  // problem is also reported once at startup (instrumentation.node.ts), so this
  // deliberately logs nothing — a doomed request loop must not flood the log.
  const passwordProblem = webPasswordConfigurationProblem();
  if (passwordProblem) {
    return new NextResponse(`omp-web password configuration error\n\n${passwordProblem}\n`, {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const pairingDenied = checkPairingGate(request);
  if (pairingDenied) return pairingDenied;
  const { pathname } = request.nextUrl;
  if (pathname === "/remote" || pathname === "/api/pair/accept") return NextResponse.next();
  if (!isWebPasswordEnabled()) {
    return request.nextUrl.pathname === "/login"
      ? NextResponse.redirect(new URL("/", request.url))
      : NextResponse.next();
  }

  // A trusted proxy vouches for password authentication, not device pairing.
  const hasSession = isTrustedProxyRequest(request.headers.get(OMP_WEB_TRUSTED_HEADER))
    || isValidWebSession(request.cookies.get(OMP_WEB_SESSION_COOKIE)?.value);
  if (pathname === "/login") {
    return hasSession ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }
  if (pathname === "/api/web-auth/session") return NextResponse.next();
  if (hasSession) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Password required", code: "password_required" }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  // Keep a deep link to a session (e.g. a notification click) across sign-in.
  if (pathname === "/" && request.nextUrl.search) login.searchParams.set("next", `/${request.nextUrl.search}`);
  return NextResponse.redirect(login);
}

// Public assets contain no workspace data; /api/manifest remains gated by
// authentication and pairing. /_next/image is not exempt: the optimizer can
// fetch URLs that would otherwise require authentication.
export const config = { matcher: "/((?!_next/static|favicon\\.ico|favicon-(?:16|32)\\.png|icon\\.svg|icon\\.png|icon-192\\.png|icon-maskable-(?:192|512)\\.png|apple-touch-icon\\.png|badge-96\\.png|sw\\.js).*)" };
