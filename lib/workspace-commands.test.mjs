import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

test("workspace discovery disposes a child that stalls during protocol negotiation", { skip: process.platform === "win32" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-command-deadline-"));
  const oldBin = process.env.OMP_WEB_OMP_BIN;
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldRoots = globalThis.__piAllowedRootsCache;
  const bin = join(dir, "fake-omp");
  writeFileSync(bin, `#!${process.execPath}\nconsole.log(JSON.stringify({type:"ready",supportedProtocolVersions:[2]}));process.stdin.resume();\n`, { mode: 0o755 });
  process.env.OMP_WEB_OMP_BIN = bin;
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.__piAllowedRootsCache = { roots: [dir], expiresAt: Date.now() + 60_000 };
  let child;
  t.after(async () => {
    t.mock.timers.reset();
    await child?.dispose();
    if (oldBin === undefined) delete process.env.OMP_WEB_OMP_BIN; else process.env.OMP_WEB_OMP_BIN = oldBin;
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    globalThis.__piAllowedRootsCache = oldRoots;
    rmSync(dir, { recursive: true, force: true });
  });
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { RpcProcess } = await jiti.import("./omp/rpc-process.ts");
  const { GET } = await jiti.import("../app/api/commands/route.ts");
  const entered = Promise.withResolvers();
  const original = RpcProcess.prototype.negotiateProtocol;
  t.mock.method(RpcProcess.prototype, "negotiateProtocol", function (...args) {
    entered.resolve(this);
    return original.apply(this, args);
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = GET(new Request(`http://localhost/api/commands?cwd=${encodeURIComponent(dir)}`));
  child = await entered.promise;
  t.mock.timers.tick(40_000);
  const response = await pending;
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /discovery timed out/);
  assert.equal(child.isAlive, false);
});
