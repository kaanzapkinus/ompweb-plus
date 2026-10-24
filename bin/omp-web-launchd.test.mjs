import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const launcher = fileURLToPath(new URL("./omp-web-launchd.js", import.meta.url));
const webLauncher = fileURLToPath(new URL("./omp-web.js", import.meta.url));

test("launchd pins the source launcher without downloading a registry package", { skip: process.platform !== "darwin" }, (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "ompweb-source-launchd-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(path.join(home, "launchctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: home, OMP_WEB_NO_OPEN: "1" };
  delete env.OMP_WEB_PKG;
  delete env.OMP_WEB_PASSWORD;
  delete env.OMP_WEB_PASSWORD_HASH;
  const result = spawnSync(process.execPath, [launcher, "install"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const agents = path.join(home, "Library", "LaunchAgents");
  const plist = readFileSync(path.join(agents, readdirSync(agents)[0]), "utf8");
  const program = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
  const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  assert.ok(program);
  assert.match(program, /<string>/);
  assert.ok(program.includes(`<string>${escape(process.execPath)}</string>`));
  assert.ok(program.includes(`<string>${escape(webLauncher)}</string>`));
  assert.doesNotMatch(program, /npx|@kahme247|--yes/);
  const legacy = spawnSync(process.execPath, [launcher, "install", "@kahme247/ompweb@latest"], { encoding: "utf8", env });
  assert.notEqual(legacy.status, 0);
  assert.match(legacy.stderr, /source|package.spec/i);
});
