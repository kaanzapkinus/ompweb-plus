/**
 * Remote-access pairing state machine for omp-web, re-implemented from the
 * semantics of @linxin666/dsh-remote-web-ui (which is Cordis-coupled):
 * one active one-time token, a device-session table, presence tracking.
 *
 * Security invariants (mirror the plugin):
 * - One active token at a time; issue() replaces it, so a refreshed QR
 *   immediately invalidates the previous link.
 * - A token is consumed by the first successful accept() — reuse refused.
 * - Tokens expire; accept() on an expired token is refused like an unknown
 *   one (no validity oracle).
 * - stop() revokes every device session and clears the token.
 * - revoke() drops one session; idle sessions older than idleExpireMs are
 *   deleted on sweep/load/next gated request.
 * - Device id is a random 128-bit hex; the device name is inferred from the
 *   User-Agent and never rendered raw.
 */
import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { networkInterfaces } from "os";
import { dirname } from "path";
import { isRecord } from "./type-guards";

export const DEFAULT_IDLE_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_TOKEN_TTL_MS = 600_000;
export const DEFAULT_MAX_DEVICES = 4;
export const DEFAULT_OFFLINE_AFTER_MS = 25_000;
const MAX_USER_AGENT_CHARS = 180;
const HEARTBEAT_PERSIST_INTERVAL_MS = 60_000;
const STORAGE_FAILURE_ENV = "OMP_WEB_PAIRING_STORAGE_FAILED";
const NUMERIC_CONFIG_KEYS = ["tokenTtlMs", "offlineAfterMs", "maxDevices", "idleExpireMs"] as const;

function validatePairingNumbers(config: Partial<PairingConfig> | Record<string, unknown>): void {
  for (const key of NUMERIC_CONFIG_KEYS) {
    if (!(key in config)) continue;
    const value = config[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${key} must be finite and greater than zero`);
    }
  }
}

export class PairingStorageError extends Error {
  constructor(cause?: unknown) {
    super("Pairing storage is unavailable; remote access is disabled", { cause });
    this.name = "PairingStorageError";
  }
}

interface PersistedPairingState {
  config: Partial<PairingConfig>;
  token: PairingSnapshot["token"];
  devices: PairedDevice[];
}

/** A pending/failed commit is never an authorization source, even after restart. */
export function pairingStorageUnavailable(path: string): boolean {
  return process.env[STORAGE_FAILURE_ENV] === path || existsSync(`${path}.pending`);
}

/** Shared by route state and the proxy: disk is the only durable authority. */
export function readPairingState(path: string, committing = false): PersistedPairingState {
  try {
    if (!committing && pairingStorageUnavailable(path)) throw new PairingStorageError();
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(raw) || !isRecord(raw.config) || !Array.isArray(raw.devices)) throw new PairingStorageError();
    const config = pickPairingConfig(raw.config);
    validatePairingNumbers(raw.config);
    const token = raw.token;
    if (token !== null && (!isRecord(token) || typeof token.value !== "string"
      || typeof token.expiresAt !== "number" || !Number.isFinite(token.expiresAt))) throw new PairingStorageError();
    const devices: PairedDevice[] = [];
    for (const device of raw.devices) {
      if (!isRecord(device) || typeof device.id !== "string" || typeof device.name !== "string"
        || typeof device.pairedAt !== "number" || !Number.isFinite(device.pairedAt)
        || typeof device.lastActiveAt !== "number" || !Number.isFinite(device.lastActiveAt)
        || typeof device.mobile !== "boolean") throw new PairingStorageError();
      devices.push({
        id: device.id, name: device.name, pairedAt: device.pairedAt,
        lastActiveAt: device.lastActiveAt, mobile: device.mobile,
        ...(typeof device.userAgent === "string" ? { userAgent: device.userAgent } : {}),
      });
    }
    return { config, token: token as PairingSnapshot["token"], devices };
  } catch (cause) {
    throw cause instanceof PairingStorageError ? cause : new PairingStorageError(cause);
  }
}

export interface PairingConfig {
  tokenTtlMs: number;
  offlineAfterMs: number;
  maxDevices: number;
  idleExpireMs: number;
  /** Cookie name carrying the paired-device id. */
  cookieName: string;
  /** When true, non-loopback /api requests require a paired cookie. */
  requirePairingForLan: boolean;
  /** Manual public URL (e.g. Cloudflare Tunnel). Empty = LAN only. */
  publicUrl?: string;
  /** Auto-start cloudflared quick tunnel. */
  autoTunnel: boolean;
  mobileEnterToSend: boolean;
}

export const DEFAULT_PAIRING_CONFIG: PairingConfig = {
  tokenTtlMs: DEFAULT_TOKEN_TTL_MS,
  offlineAfterMs: DEFAULT_OFFLINE_AFTER_MS,
  maxDevices: DEFAULT_MAX_DEVICES,
  idleExpireMs: DEFAULT_IDLE_EXPIRE_MS,
  cookieName: "dsh_pair",
  requirePairingForLan: true,
  autoTunnel: false,
  mobileEnterToSend: false,
};

export interface PairedDevice {
  id: string;
  name: string;
  pairedAt: number;
  lastActiveAt: number;
  /** Raw UA is stored truncated for diagnostics only; never rendered. */
  userAgent?: string;
  /** True when the device was paired from a mobile surface. */
  mobile: boolean;
}

export interface PairingSnapshot {
  token: { value: string; expiresAt: number } | null;
  devices: PairedDevice[];
}

export interface PairingStore {
  now: () => number;
  randomToken: () => string;
}

export const defaultClock: PairingStore = {
  now: () => Date.now(),
  randomToken: () => randomBytes(16).toString("hex"),
};

/** Infer a short device name from the User-Agent. */
export function deviceNameFromUserAgent(userAgent: string | null | undefined, mobile: boolean): string {
  const ua = (userAgent ?? "").slice(0, MAX_USER_AGENT_CHARS);
  if (mobile) return "Phone";
  if (/Windows/i.test(ua)) return "Windows PC";
  if (/Macintosh|Mac OS/i.test(ua)) return "Mac";
  if (/Linux/i.test(ua)) return "Linux PC";
  if (/iPhone|iPad|Android/i.test(ua)) return "Phone";
  return "Paired device";
}

export class PairingService {
  private config: PairingConfig;
  private store: PairingStore;
  private tokens = new Map<string, number>(); // token -> expiresAt
  private devices = new Map<string, PairedDevice>();
  private persistPath: string | null = null;
  private stopped = false;
  private tokenSerial = 0;
  private durableActivity = new Map<string, number>();
  private hasPersistedState = false;

  constructor(config: Partial<PairingConfig> = {}, store: PairingStore = defaultClock, persistPath: string | null = null) {
    this.config = { ...DEFAULT_PAIRING_CONFIG, ...config };
    validatePairingNumbers(this.config);
    this.store = store;
    this.persistPath = persistPath;
    this.refresh();
  }

  private refresh(committing = false): void {
    if (!this.persistPath) return;
    if (!committing && pairingStorageUnavailable(this.persistPath)) throw new PairingStorageError();
    if (!existsSync(this.persistPath)) {
      if (this.hasPersistedState) throw new PairingStorageError();
      return;
    }
    const data = readPairingState(this.persistPath, committing);
    this.config = { ...DEFAULT_PAIRING_CONFIG, ...data.config };
    const previous = this.devices;
    this.devices = new Map();
    this.durableActivity.clear();
    this.tokens.clear();
    const now = this.store.now();
    if (data.token && data.token.expiresAt > now) this.tokens.set(data.token.value, data.token.expiresAt);
    for (const device of data.devices) {
      // Do not let stale in-memory presence revive a durably expired device.
      if (now - device.lastActiveAt > this.config.idleExpireMs) continue;
      this.durableActivity.set(device.id, device.lastActiveAt);
      const memoryActivity = previous.get(device.id)?.lastActiveAt ?? device.lastActiveAt;
      this.devices.set(device.id, { ...device, lastActiveAt: Math.max(device.lastActiveAt, memoryActivity) });
    }
    this.hasPersistedState = true;
    this.sweep();
  }

  /**
   * Guard before reading/mutating: another bundle/process cannot write stale
   * devices or a consumed token back. A failed commit leaves its durable guard,
   * so the proxy refuses the old file instead of treating revocation as success.
   */
  private commit<T>(change: () => T): T {
    if (!this.persistPath) return change();
    const path = this.persistPath;
    let guarded = false;
    try {
      if (pairingStorageUnavailable(path)) throw new PairingStorageError();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.pending`, "", { flag: "wx", mode: 0o600 });
      guarded = true;
      this.refresh(true);
      const result = change();
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify({
        config: this.config, token: this.currentToken(), devices: [...this.devices.values()],
      }), { mode: 0o600 });
      renameSync(tmp, path);
      unlinkSync(`${path}.pending`);
      this.hasPersistedState = true;
      this.durableActivity = new Map([...this.devices.values()].map((device) => [device.id, device.lastActiveAt]));
      return result;
    } catch (cause) {
      // Covers a read-only directory where even creating the durable guard
      // fails. The running proxy shares process.env across its bundle boundary.
      if (!guarded && !existsSync(`${path}.pending`)) {
        process.env[STORAGE_FAILURE_ENV] = path;
        try { renameSync(path, `${path}.unavailable`); } catch { /* Storage may be entirely read-only. */ }
      }
      throw cause instanceof PairingStorageError ? cause : new PairingStorageError(cause);
    }
  }

  updateConfig(patch: Partial<PairingConfig>): PairingConfig {
    validatePairingNumbers(patch);
    return this.commit(() => {
      this.config = { ...this.config, ...patch };
      return { ...this.config };
    });
  }

  getConfig(): PairingConfig {
    this.refresh();
    return { ...this.config };
  }

  /** Issue a fresh one-time token, invalidating any previous one. */
  issue(): { token: string; expiresAt: number } {
    return this.commit(() => {
      const now = this.store.now();
      const value = `${this.store.randomToken()}${this.tokenSerial++}`;
      const expiresAt = now + this.config.tokenTtlMs;
      this.tokens.clear();
      this.tokens.set(value, expiresAt);
      return { token: value, expiresAt };
    });
  }

  /** Consume a token; returns the paired device or null on any refusal. */
  accept(token: string, userAgent: string | null, mobile: boolean): PairedDevice | null {
    return this.commit(() => {
      const now = this.store.now();
      const expiresAt = this.tokens.get(token);
      if (expiresAt === undefined || expiresAt <= now) return null;
      this.tokens.delete(token);
      const device: PairedDevice = {
        id: this.store.randomToken(),
        name: deviceNameFromUserAgent(userAgent, mobile),
        pairedAt: now,
        lastActiveAt: now,
        ...(userAgent ? { userAgent: userAgent.slice(0, MAX_USER_AGENT_CHARS) } : {}),
        mobile,
      };
      this.devices.set(device.id, device);
      this.sweepDevices(now);
      return { ...device };
    });
  }

  /** Mark a paired device active (heartbeat / gated request). */
  touch(deviceId: string): boolean {
    this.refresh();
    const device = this.devices.get(deviceId);
    const now = this.store.now();
    if (!device || now - device.lastActiveAt > this.config.idleExpireMs) return false;
    device.lastActiveAt = now;
    const interval = Math.min(HEARTBEAT_PERSIST_INTERVAL_MS, this.config.idleExpireMs / 2);
    if (this.persistPath && now - (this.durableActivity.get(deviceId) ?? 0) >= interval) {
      return this.commit(() => {
        const current = this.devices.get(deviceId);
        if (!current) return false;
        current.lastActiveAt = now;
        this.sweepDevices(now);
        return true;
      });
    }
    this.sweepDevices(now);
    return this.devices.has(deviceId);
  }

  revoke(deviceId: string): boolean {
    return this.commit(() => this.devices.delete(deviceId));
  }

  /** Revoke every device and clear the token (Stop). */
  stop(): void {
    this.commit(() => {
      this.tokens.clear();
      this.devices.clear();
      this.stopped = true;
    });
  }

  isStopped(): boolean {
    return this.stopped;
  }

  getDevice(deviceId: string): PairedDevice | null {
    this.refresh();
    const device = this.devices.get(deviceId);
    if (!device) return null;
    // Idle expiry enforced on read, like the plugin's next-gated-request rule.
    const now = this.store.now();
    if (now - device.lastActiveAt > this.config.idleExpireMs) {
      this.devices.delete(deviceId);
      // The persisted timestamp is already expired at the proxy boundary.
      return null;
    }
    return { ...device };
  }

  listDevices(): PairedDevice[] {
    this.refresh();
    this.sweep();
    return [...this.devices.values()].map((d) => ({ ...d }));
  }

  isOnline(device: PairedDevice): boolean {
    return this.store.now() - device.lastActiveAt <= this.config.offlineAfterMs;
  }

  activeToken(): { value: string; expiresAt: number } | null {
    this.refresh();
    return this.currentToken();
  }

  private currentToken(): PairingSnapshot["token"] {
    const now = this.store.now();
    for (const [value, expiresAt] of this.tokens) {
      if (expiresAt >= now) return { value, expiresAt };
      this.tokens.delete(value);
    }
    return null;
  }

  private sweep(): void {
    const now = this.store.now();
    this.sweepDevices(now);
    for (const [value, expiresAt] of this.tokens) {
      if (expiresAt < now) this.tokens.delete(value);
    }
  }

  /** Enforce max-device cap (drop oldest) and idle expiry. */
  private sweepDevices(now: number): void {
    const idleExpired: string[] = [];
    for (const [id, device] of this.devices) {
      if (now - device.lastActiveAt > this.config.idleExpireMs) idleExpired.push(id);
    }
    for (const id of idleExpired) this.devices.delete(id);
    if (this.devices.size > this.config.maxDevices) {
      const sorted = [...this.devices.values()].sort((a, b) => a.lastActiveAt - b.lastActiveAt);
      for (const device of sorted.slice(0, sorted.length - this.config.maxDevices)) {
        this.devices.delete(device.id);
      }
    }
  }
}

/** Adopt only known PairingConfig keys from untrusted JSON. */
function pickPairingConfig(raw: Record<string, unknown>): Partial<PairingConfig> {
  const out: Partial<PairingConfig> = {};
  if (typeof raw.tokenTtlMs === "number") out.tokenTtlMs = raw.tokenTtlMs;
  if (typeof raw.offlineAfterMs === "number") out.offlineAfterMs = raw.offlineAfterMs;
  if (typeof raw.maxDevices === "number") out.maxDevices = raw.maxDevices;
  if (typeof raw.idleExpireMs === "number") out.idleExpireMs = raw.idleExpireMs;
  if (typeof raw.cookieName === "string") out.cookieName = raw.cookieName;
  if (typeof raw.requirePairingForLan === "boolean") out.requirePairingForLan = raw.requirePairingForLan;
  if (typeof raw.publicUrl === "string") out.publicUrl = raw.publicUrl;
  if (typeof raw.autoTunnel === "boolean") out.autoTunnel = raw.autoTunnel;
  if (typeof raw.mobileEnterToSend === "boolean") out.mobileEnterToSend = raw.mobileEnterToSend;
  return out;
}

/** Host classification for reachable QR URLs only; never an access-control decision. */
export function isRemoteRequest(host: string | null | undefined): boolean {
  // Missing Host falls back to the configured URL/LAN discovery in pairingBase.
  if (!host) return false;
  // A malformed Host cannot be proven loopback — fail closed.
  if (!PAIRING_HOST_RE.test(host)) return true;
  try {
    const url = new URL(`http://${host}`);
    return !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// QR base-URL derivation (shared with app/api/pair/token/route.ts).
// ---------------------------------------------------------------------------

/** Host names / IP literals / ports are the only characters reflected into
 *  a pairing URL — anything else (CR/LF, path, scheme) is rejected so a
 *  crafted Host header cannot turn the QR into a phishing link. */
export const PAIRING_HOST_RE = /^[A-Za-z0-9.:\-[\]]{1,255}$/;

export const PAIRING_LOOPBACK_RE = /^127\.|^::1$|^\[::1\]$/;

/** Virtual adapters whose addresses a phone can never reach (WSL/Hyper-V
 *  vEthernet, VirtualBox/VMware host-only, Docker, Tailscale, ZeroTier...).
 *  Mirrors bin/network-addresses.js isVirtualBridge. */
const VIRTUAL_IFACE_RE = /vEthernet|VirtualBox|VMware|vboxnet|tap\d|tun\d|docker|tailscale|zerotier|virbr/i;

type NetIfaces = Record<string, Array<{ address: string; family: string | number; internal?: boolean }>>;

/** First physical-NIC IPv4 address (skips loopback/link-local/virtuals). */
export function lanAddress(interfaces: NetIfaces = networkInterfaces0()): string | null {
  const seen = new Set<string>();
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (VIRTUAL_IFACE_RE.test(name)) continue;
    for (const info of addrs ?? []) {
      if (info.family !== "IPv4" && (info.family as string | number) !== 4) continue;
      const addr = info.address;
      if (seen.has(addr)) continue;
      seen.add(addr);
      if (info.internal) continue;
      if (PAIRING_LOOPBACK_RE.test(addr)) continue;
      if (addr.startsWith("169.254.")) continue;
      return addr;
    }
  }
  return null;
}

function networkInterfaces0(): NetIfaces {
  return networkInterfaces() as NetIfaces;
}

/** The QR base URL must be reachable from the phone. A request coming from
 *  localhost advertises a LAN address (or the configured public URL); a
 *  request that already arrived over the LAN/public host keeps its Host. */
export function pairingBase(
  request: { headers: { get(name: string): string | null } },
  fallbackUrl: string | undefined,
  portFallback = "30178",
): string {
  const rawHost = request.headers.get("host") ?? "";
  const host = PAIRING_HOST_RE.test(rawHost) ? rawHost : "";
  const scheme = request.headers.get("x-forwarded-proto") === "https" ? "https" : "http";
  let hostname = "";
  let port = portFallback;
  try {
    const url = new URL(`http://${host}`);
    hostname = url.hostname;
    port = url.port || portFallback;
  } catch {
    // An invalid authority must never be reflected into the QR.
  }

  if (host && hostname && isRemoteRequest(host)) {
    return `${scheme}://${host}`;
  }
  if (fallbackUrl) {
    try {
      const url = new URL(fallbackUrl);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password
        && url.pathname === "/" && !url.search && !url.hash) return url.origin;
    } catch {
      // Invalid public configuration falls back to the local LAN, not a link.
    }
  }
  const lan = lanAddress();
  if (lan) return `${scheme}://${lan}:${port}`;
  return `${scheme}://${host || "127.0.0.1"}`;
}
