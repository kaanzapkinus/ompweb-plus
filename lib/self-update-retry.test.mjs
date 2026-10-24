import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";

test("a failed native runtime update permits an immediate new attempt and retains its terminal status", { skip: process.platform === "win32" }, async (t) => {
  const environment = { ...process.env };
  const temporary = mkdtempSync(path.join(tmpdir(), "ompweb-native-retry-"));
  t.after(() => { process.env = environment; rmSync(temporary, { recursive: true, force: true }); });
  const binary = path.join(temporary, "omp");
  writeFileSync(binary, '#!/bin/sh\nif [ "$1" = update ] && [ "$2" = --check ]; then\n  printf "Current version: 1.0.0\\nNew version available: 2.0.0\\n"\n  exit 0\nfi\nexit 7\n', { mode: 0o755 });
  process.env.TMPDIR = temporary;
  process.env.OMP_WEB_OMP_BIN = binary;
  delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
  const jiti = createJiti(import.meta.url, { alias: { "@/": new URL("../", import.meta.url).pathname } });
  const { prepareSelfUpdate, commitSelfUpdate, getSelfUpdateStatus } = await jiti.import("./self-update.ts");
  const first = await prepareSelfUpdate("omp");
  commitSelfUpdate(first.attemptId, "omp");
  let status;
  const deadline = Date.now() + 4_000;
  do {
    await sleep(20);
    status = getSelfUpdateStatus("omp");
  } while (status?.state !== "failed" && Date.now() < deadline);
  assert.equal(status?.state, "failed");
  assert.equal(status.attemptId, first.attemptId);
  assert.match(status.error, /7/);
  assert.equal(getSelfUpdateStatus("omp").state, "failed");
  let workerRunning = true;
  while (workerRunning && Date.now() < deadline) {
    try { process.kill(status.workerPid, 0); } catch { workerRunning = false; }
    if (workerRunning) await sleep(20);
  }
  assert.equal(workerRunning, false, "native update worker must exit before retry");
  const retry = await prepareSelfUpdate("omp");
  assert.notEqual(retry.attemptId, first.attemptId);
  assert.equal(retry.targetVersion, "2.0.0");
});
