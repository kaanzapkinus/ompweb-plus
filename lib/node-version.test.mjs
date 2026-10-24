import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
const {
  MIN_NODE_VERSION,
  getUnsupportedNodeVersionMessage,
  isNodeVersionSupported,
} = require("../bin/node-version.js");

test("accepts the minimum supported Node.js version and newer versions", () => {
  for (const version of ["24.0.0", "v24.0.0", "24.0.1", "26.11.1"]) {
    assert.equal(isNodeVersionSupported(version), true, version);
  }
});

test("rejects older and invalid Node.js versions", () => {
  for (const version of ["22.19.0", "23.11.1", "invalid"]) {
    assert.equal(isNodeVersionSupported(version), false, version);
  }
});

test("keeps the package engine aligned with the startup check", () => {
  assert.equal(packageJson.engines.node, `>=${MIN_NODE_VERSION}`);
});

test("reports both the required and current Node.js versions", () => {
  const message = getUnsupportedNodeVersionMessage("22.19.0");
  assert.match(message, /requires Node\.js 24\.0\.0 or newer/);
  assert.match(message, /Current Node\.js version: 22\.19\.0/);
});
