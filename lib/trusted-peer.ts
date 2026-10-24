import { createHmac, timingSafeEqual } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { resolveWebAuthSecret } from "./web-auth-secret";

export const TRUSTED_PEER_HEADER = "x-omp-web-peer";
const MAX_ATTESTATION_AGE_MS = 60 * 60 * 1000;
const FORWARDING_HEADERS = [
  "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
  "x-original-host", "x-real-ip", "cf-connecting-ip", "true-client-ip",
];
const SUBSCRIBER = Symbol.for("omp-web.trusted-peer-subscriber");
type Subscriber = (message: unknown) => void;
type PeerGlobal = typeof globalThis & { [SUBSCRIBER]?: Subscriber };

function signature(payload: string): Buffer {
  const secret = resolveWebAuthSecret();
  return createHmac("sha256", Buffer.from(secret.key, "base64url"))
    .update(`omp-web-native-peer-v1\0${secret.salt}\0${payload}`, "utf8").digest();
}

function isLoopback(peer: string): boolean {
  return (isIP(peer) === 4 && peer.startsWith("127.")) || peer === "::1"
    || (isIP(peer) === 6 && peer.startsWith("::ffff:127."));
}

/** Called only at Node's native HTTP boundary, before Next adds forwarding headers. */
export function attestIncomingPeer(request: Pick<IncomingMessage, "headers" | "socket">, now = Date.now()): void {
  // Never let caller-supplied metadata survive, including on signing failure.
  delete request.headers[TRUSTED_PEER_HEADER];
  try {
    const peer = request.socket.remoteAddress ?? "";
    const forwarded = FORWARDING_HEADERS.some((name) => Object.hasOwn(request.headers, name));
    const payload = `v1.${now}.${forwarded ? "1" : "0"}.${Buffer.from(peer).toString("base64url")}`;
    request.headers[TRUSTED_PEER_HEADER] = `${payload}.${signature(payload).toString("base64url")}`;
  } catch {
    // A diagnostics subscriber must not throw (Node treats that as uncaught).
    // Missing metadata is remote at the verifier, never a loopback exception.
  }
}

/** Unknown, unsigned or stale transport metadata cannot authorize local-only APIs. */
export function isTrustedLocalRequest(request: { headers: { get(name: string): string | null } }, now = Date.now()): boolean {
  const value = request.headers.get(TRUSTED_PEER_HEADER);
  if (!value) return false;
  const match = /^v1\.(\d{13})\.([01])\.([A-Za-z0-9_-]{0,64})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return false;
  const issuedAt = Number(match[1]);
  if (issuedAt > now || now - issuedAt > MAX_ATTESTATION_AGE_MS || match[2] !== "0") return false;
  try {
    const expected = signature(value.slice(0, value.lastIndexOf(".")));
    const supplied = Buffer.from(match[4], "base64url");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
      && isLoopback(Buffer.from(match[3], "base64url").toString("utf8"));
  } catch {
    return false;
  }
}

/**
 * Node publishes this public channel synchronously before emitting `request`.
 * The HTTP channel is experimental in Node 22/24: keep the native integration
 * regression when upgrading Node. Instrumentation covers dev, CLI, standalone
 * and desktop without patching Next or introducing a second HTTP listener.
 */
export function registerTrustedPeerIngress(): () => void {
  resolveWebAuthSecret();
  const g = globalThis as PeerGlobal;
  const previous = g[SUBSCRIBER];
  if (previous) unsubscribe("http.server.request.start", previous);
  const subscriber: Subscriber = (message) => {
    const { request } = message as { request: IncomingMessage };
    attestIncomingPeer(request);
  };
  g[SUBSCRIBER] = subscriber;
  subscribe("http.server.request.start", subscriber);
  return () => {
    unsubscribe("http.server.request.start", subscriber);
    if (g[SUBSCRIBER] === subscriber) delete g[SUBSCRIBER];
  };
}
