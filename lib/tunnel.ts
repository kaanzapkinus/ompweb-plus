import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { createChildProcessEnvironment } from "./project-command-env";

interface TunnelState { child: ChildProcess; url: string | null }
const tunnelGlobal = globalThis as typeof globalThis & { __ompWebTunnelState__?: TunnelState };

/** Absolute overrides work even when launchd supplies no interactive PATH. */
export function resolveCloudflaredBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.OMP_WEB_CLOUDFLARED_BIN;
  const executable = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const candidates = override
    ? (isAbsolute(override) ? [override] : [])
    : [...(env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, executable)),
      "/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", join(homedir(), ".local", "bin", executable)];
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Try the next installation. */ }
  }
  return null;
}

export function getTunnelUrl(): string | null {
  return tunnelGlobal.__ompWebTunnelState__?.url ?? null;
}

export function stopTunnel(): void {
  const state = tunnelGlobal.__ompWebTunnelState__;
  delete tunnelGlobal.__ompWebTunnelState__;
  state?.child.kill("SIGTERM");
}

export async function startTunnel(port: number): Promise<string> {
  if (tunnelGlobal.__ompWebTunnelState__) throw new Error("tunnel_running");
  const binary = resolveCloudflaredBinary();
  if (!binary) throw new Error("cloudflared_missing");
  const child = spawn(binary, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
    stdio: ["ignore", "pipe", "pipe"], env: createChildProcessEnvironment(),
  });
  const state: TunnelState = { child, url: null };
  tunnelGlobal.__ompWebTunnelState__ = state;
  const clear = () => {
    if (tunnelGlobal.__ompWebTunnelState__ === state) delete tunnelGlobal.__ompWebTunnelState__;
  };
  child.once("exit", clear);
  child.once("error", clear);
  const { promise, resolve } = Promise.withResolvers<string | null>();
  let buffer = "";
  const finish = (value: string | null) => {
    clearTimeout(timer);
    child.stderr?.off("data", onData);
    child.stdout?.off("data", onData);
    child.off("exit", onExit);
    child.off("error", onExit);
    resolve(value);
  };
  const onData = (chunk: Buffer) => {
    buffer = (buffer + chunk.toString()).slice(-8192);
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/.exec(buffer);
    if (match) finish(match[0]);
  };
  const onExit = () => finish(null);
  const timer = setTimeout(onExit, 20_000);
  child.stderr?.on("data", onData);
  child.stdout?.on("data", onData);
  child.once("exit", onExit);
  child.once("error", onExit);
  const url = await promise;
  if (!url || tunnelGlobal.__ompWebTunnelState__ !== state) {
    child.kill("SIGTERM");
    clear();
    throw new Error("tunnel_failed");
  }
  state.url = url;
  return url;
}
