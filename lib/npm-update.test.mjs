import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { checkNpmUpdate } = await jiti.import("./npm-update.ts");

test("source releases never contact npm or offer registry installation", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let calls = 0;
  t.after(() => { globalThis.fetch = originalFetch; process.env = originalEnv; });
  delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ version: "999.0.0" });
  };
  const status = await checkNpmUpdate(true);
  assert.equal(calls, 0);
  assert.equal(status.updateAvailable, false);
  assert.equal(status.availableVersion, null);
  assert.equal(status.updatesDisabled, true);
  assert.match(status.updateCommand, /git pull --ff-only/);
  assert.match(status.updateCommand, /npm ci/);
  assert.match(status.updateCommand, /npm run build/);
  assert.doesNotMatch(status.updateCommand, /install -g|bun add|@kahme247/);
});
