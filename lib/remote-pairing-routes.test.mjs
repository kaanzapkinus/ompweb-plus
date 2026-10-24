import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { PairingService } = await jiti.import("./remote-pairing.ts");
const { proxy } = await jiti.import("../proxy.ts");
const acceptRoute = await jiti.import("../app/api/pair/accept/route.ts");
const revokeRoute = await jiti.import("../app/api/pair/devices/[id]/route.ts");
const stopRoute = await jiti.import("../app/api/pair/revoke-all/route.ts");
const heartbeatRoute = await jiti.import("../app/api/pair/heartbeat/route.ts");
const tokenRoute = await jiti.import("../app/api/pair/token/route.ts");
const configRoute = await jiti.import("../app/api/pair/config/route.ts");
const { attestIncomingPeer, TRUSTED_PEER_HEADER } = await jiti.import("./trusted-peer.ts");
const { pinWebAuthSecretForTests } = await jiti.import("./web-auth-secret.ts");

function isolatedPairing(t, idleExpireMs = 1000) {
  const dir = mkdtempSync(join(tmpdir(), "omp-pairing-routes-"));
  const names = ["PI_CODING_AGENT_DIR", "OMP_WEB_PASSWORD", "OMP_WEB_PASSWORD_HASH", "OMP_WEB_PAIRING_STORAGE_FAILED"];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  const previousService = globalThis.__ompWebPairingService__;
  for (const name of names) delete process.env[name];
  process.env.PI_CODING_AGENT_DIR = dir;
  pinWebAuthSecretForTests({ salt: "a".repeat(43), key: "b".repeat(43) });
  let now = Date.now();
  let serial = 0;
  const clock = { now: () => now, randomToken: () => `route${serial++}` };
  const file = join(dir, "remote-pairing.json");
  const service = new PairingService({ idleExpireMs }, clock, file);
  globalThis.__ompWebPairingService__ = service;
  t.after(() => {
    globalThis.__ompWebPairingService__ = previousService;
    pinWebAuthSecretForTests();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const device = service.accept(service.issue().token, null, true);
  const remote = () => new NextRequest("http://192.0.2.10:30178/api/sessions", {
    headers: { cookie: `dsh_pair=${device.id}` },
  });
  return { service, device, file, remote, clock, advance(ms) { now += ms; } };
}

test("an invalid numeric config patch returns 400 without disabling durable pairing", async (t) => {
  const { service, file, remote } = isolatedPairing(t);
  const before = readFileSync(file, "utf8");
  const response = await configRoute.PUT(new Request("http://localhost/api/pair/config", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenTtlMs: 0, requirePairingForLan: false }),
  }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "invalid_config");
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(service.getConfig().requirePairingForLan, true);
  assert.equal(proxy(remote()).status, 200);
});

for (const operation of ["accept", "revoke", "stop", "heartbeat"]) {
  test(`${operation} write failure returns 503, never a success cookie, and closes proxy authority`, async (t) => {
    const { service, device, file, remote, advance } = isolatedPairing(t);
    const token = service.issue().token;
    assert.equal(proxy(remote()).status, 200);
    mkdirSync(`${file}.tmp`);
    advance(500);
    const response = operation === "accept"
      ? await acceptRoute.POST(new Request("http://localhost/api/pair/accept", {
        method: "POST", body: JSON.stringify({ token }),
      }))
      : operation === "revoke"
        ? await revokeRoute.DELETE(new Request("http://localhost"), { params: Promise.resolve({ id: device.id }) })
        : operation === "stop"
          ? await stopRoute.POST()
          : await heartbeatRoute.POST(new NextRequest("http://localhost/api/pair/heartbeat", {
            method: "POST", headers: { cookie: `dsh_pair=${device.id}` },
          }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "pairing_storage_unavailable");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(proxy(remote()).status, 503, "stale disk authorization is not accepted");
  });
}

test("proxy uses persisted heartbeat activity after a route service reload", async (t) => {
  const { service, device, file, remote, clock, advance } = isolatedPairing(t, 100);
  t.mock.method(Date, "now", clock.now);
  advance(50);
  assert.equal(service.touch(device.id), true);
  assert.ok(JSON.parse(readFileSync(file, "utf8")).devices[0].lastActiveAt);
  advance(60);
  const reloaded = new PairingService({}, clock, file);
  assert.ok(reloaded.getDevice(device.id));
  assert.equal(proxy(remote()).status, 200, "proxy sees renewed authority after original idle window");
});

test("token issuance requires verified actual local ingress, not a loopback Host", async (t) => {
  isolatedPairing(t);
  const direct = new Request("http://localhost:30178/api/pair/token", { method: "POST" });
  assert.equal((await tokenRoute.POST(direct)).status, 403);
  for (const peer of ["127.0.0.1", "192.0.2.10"]) {
    const native = { headers: { host: "localhost:30178" }, socket: { remoteAddress: peer } };
    attestIncomingPeer(native);
    const request = new NextRequest("http://localhost:30178/api/pair/token", {
      method: "POST", headers: {
        ...native.headers,
        "x-forwarded-for": peer,
        "x-forwarded-host": "localhost:30178",
        [TRUSTED_PEER_HEADER]: native.headers[TRUSTED_PEER_HEADER],
      },
    });
    assert.equal((await tokenRoute.POST(request)).status, peer === "127.0.0.1" ? 200 : 403);
    assert.equal(proxy(request).status, peer === "127.0.0.1" ? 200 : 403);
  }
});
