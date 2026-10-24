import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const worker = fileURLToPath(new URL("./omp-web-update-worker.js", import.meta.url));
const attempt = "11111111-1111-4111-8111-111111111111";
function runWorker(t, kind, exitCode = 0, leaseOwner = attempt) {
  const root = mkdtempSync(path.join(tmpdir(), "ompweb-source-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, "command.log");
  const binary = path.join(root, "omp");
  writeFileSync(binary, `#!/bin/sh\nprintf '%s' "$*" > "$UPDATE_TEST_LOG"\nexit ${exitCode}\n`, { mode: 0o755 });
  writeFileSync(path.join(root, `${attempt}.go`), "{}");
  writeFileSync(path.join(root, "status.json"), JSON.stringify({ attemptId: attempt, state: "prepared" }));
  const lease = path.join(root, "lease.json");
  writeFileSync(lease, JSON.stringify({ attemptId: leaseOwner, expiresAt: Date.now() + 30 * 60_000 }));
  const result = spawnSync(process.execPath, [worker, "--attempt", attempt, "--root", root, "--package-dir", root, "--target", "999.0.0", "--kind", kind], {
    encoding: "utf8", timeout: 4000,
    env: { ...process.env, HOME: root, OMP_WEB_OMP_BIN: binary, UPDATE_TEST_LOG: log },
  });
  return { result, log, lease, status: JSON.parse(readFileSync(path.join(root, "status.json"), "utf8")) };
}

test("legacy app update workers fail closed without installing another package", { skip: process.platform === "win32" }, (t) => {
  const { result, log, status } = runWorker(t, "app");
  assert.equal(result.error, undefined, "app update must reject before stopping services");
  assert.equal(status.state, "failed");
  assert.match(status.error, /source/i);
  assert.equal(existsSync(log), false);
});

test("native runtime worker still invokes omp update and exits after success", { skip: process.platform === "win32" }, (t) => {
  const { result, log, status } = runWorker(t, "omp");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(log, "utf8"), "update");
  assert.equal(status.state, "succeeded");
});

test("native runtime worker records an unsuccessful omp update as failed", { skip: process.platform === "win32" }, (t) => {
  const { result, log, status } = runWorker(t, "omp", 7);
  assert.equal(result.error, undefined);
  assert.equal(readFileSync(log, "utf8"), "update");
  assert.equal(status.state, "failed");
  assert.match(status.error, /7/);
});

test("failed native workers release their matching lease without deleting terminal status", { skip: process.platform === "win32" }, (t) => {
  const { result, lease, status } = runWorker(t, "omp", 7);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(status.state, "failed");
  assert.equal(status.attemptId, attempt);
  assert.equal(existsSync(lease), false);
});

test("terminal native workers preserve a different attempt's lease", { skip: process.platform === "win32" }, (t) => {
  const owner = "22222222-2222-4222-8222-222222222222";
  const { result, lease, status } = runWorker(t, "omp", 7, owner);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(status.state, "failed");
  assert.equal(JSON.parse(readFileSync(lease, "utf8")).attemptId, owner);
});
