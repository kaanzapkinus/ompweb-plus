#!/usr/bin/env node
"use strict";
// Dependency-free worker copied into the private temporary update attempt.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cp = require("node:child_process");

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const attemptId = arg("--attempt");
const root = arg("--root");
const kind = arg("--kind") || "app";

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { fs.renameSync(temporary, file); } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
function markerFile(marker) { return path.join(root, `${attemptId}.${marker}`); }
function updateStatus(patch) {
  const file = path.join(root, "status.json");
  atomicWrite(file, { ...readJson(file), ...patch });
}
function releaseOwnLease() {
  const file = path.join(root, "lease.json");
  if (readJson(file)?.attemptId === attemptId) fs.rmSync(file, { force: true });
}

async function updateRuntime() {
  const bin = process.env.OMP_WEB_OMP_BIN || "omp";
  const windowsScript = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(bin);
  const file = windowsScript ? "cmd.exe" : bin;
  const args = windowsScript ? ["/c", bin, "update"] : ["update"];
  await new Promise((resolve, reject) => {
    const child = cp.spawn(file, args, {
      timeout: 5 * 60 * 1000,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`omp update failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
    });
  });
}

async function main() {
  if (!/^[0-9a-f-]{36}$/i.test(attemptId || "") || !root) process.exit(1);
  try {
    // Fail closed even if a stale app-update attempt invokes this worker.
    if (kind !== "omp") throw new Error("Source installations require a manual checkout update; registry replacement is not supported.");
    const abort = readJson(markerFile("abort.json"));
    if (abort) throw new Error(abort.reason || "aborted");
    if (!fs.existsSync(markerFile("go"))) throw new Error("Update has not been committed");
    updateStatus({ state: "running", stage: "installing", startedAt: new Date().toISOString() });
    // Updating omp does not stop or replace the web app, tray, or services.
    await updateRuntime();
    updateStatus({ state: "succeeded", stage: "finalizing", finishedAt: new Date().toISOString(), cleanupReady: true });
    atomicWrite(markerFile("complete.json"), { attemptId, completedAt: new Date().toISOString() });
  } catch (error) {
    updateStatus({ state: "failed", error: String(error instanceof Error ? error.message : error).slice(0, 240), finishedAt: new Date().toISOString(), cleanupReady: true });
  } finally {
    // Terminal status stays available to the UI; only the active lock ends.
    // A stale worker must never release a newer attempt's lease.
    releaseOwnLease();
  }
}

main().catch((error) => {
  try { updateStatus({ state: "failed", error: String(error).slice(0, 240), finishedAt: new Date().toISOString(), cleanupReady: true }); } catch {}
  process.exit(1);
});
