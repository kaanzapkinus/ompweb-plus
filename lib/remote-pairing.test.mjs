import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { PairingService, deviceNameFromUserAgent, isRemoteRequest, DEFAULT_IDLE_EXPIRE_MS } = await jiti.import("./remote-pairing.ts");

function makeStore(initialNow = 1_000_000) {
  let now = initialNow;
  let serial = 0;
  return {
    now: () => now,
    advance(ms) { now += ms; },
    randomToken: () => `tok${String(serial++).padStart(8, "0")}`,
  };
}

test("invalid numeric configuration cannot poison existing durable pairing authority", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-pair-config-"));
  const file = join(dir, "remote-pairing.json");
  const clock = makeStore();
  const service = new PairingService({}, clock, file);
  try {
    const device = service.accept(service.issue().token, null, true);
    const before = readFileSync(file, "utf8");
    assert.throws(() => service.updateConfig({ tokenTtlMs: 0, requirePairingForLan: false }), RangeError);
    assert.equal(readFileSync(file, "utf8"), before);
    const reloaded = new PairingService({}, clock, file);
    assert.equal(reloaded.getConfig().requirePairingForLan, true);
    assert.equal(reloaded.getDevice(device.id).id, device.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("issue() replaces the previous token; the old one is refused", () => {
  const store = makeStore();
  const service = new PairingService({}, store);
  const first = service.issue();
  const second = service.issue();
  assert.notEqual(first.token, second.token);
  assert.equal(service.accept(first.token, null, false), null, "old token must be invalidated");
  assert.ok(service.accept(second.token, null, false));
});

test("a token is single-use and expires", () => {
  const store = makeStore();
  const service = new PairingService({ tokenTtlMs: 1000 }, store);
  const { token } = service.issue();
  assert.ok(service.accept(token, null, false), "first accept succeeds");
  assert.equal(service.accept(token, null, false), null, "reuse refused");
  const service2 = new PairingService({ tokenTtlMs: 1000 }, store);
  const { token: t2 } = service2.issue();
  store.advance(2000);
  assert.equal(service2.accept(t2, null, false), null, "expired token refused");
});

test("max-device cap evicts the oldest session", () => {
  const store = makeStore();
  const service = new PairingService({ maxDevices: 2 }, store);
  const { token: t1 } = service.issue();
  const d1 = service.accept(t1, "Mozilla/5.0 (Windows NT 10.0)", false);
  const { token: t2 } = service.issue();
  const d2 = service.accept(t2, "Mozilla/5.0 (Macintosh)", false);
  const { token: t3 } = service.issue();
  const d3 = service.accept(t3, "Mozilla/5.0 (X11; Linux)", false);
  assert.ok(d1 && d2 && d3);
  assert.equal(service.getDevice(d1.id), null, "oldest device evicted");
  assert.ok(service.getDevice(d2.id));
  assert.ok(service.getDevice(d3.id));
});

test("offline detection follows the heartbeat window", () => {
  const store = makeStore();
  const service = new PairingService({ offlineAfterMs: 25_000 }, store);
  const { token } = service.issue();
  const device = service.accept(token, null, false);
  assert.ok(device);
  assert.equal(service.isOnline(device), true);
  store.advance(30_000);
  assert.equal(service.isOnline(service.getDevice(device.id)), false);
  store.advance(1);
  assert.equal(service.touch(device.id), true);
  assert.equal(service.isOnline(service.getDevice(device.id)), true);
});

test("idle expiry deletes stale sessions on read", () => {
  const store = makeStore();
  const service = new PairingService({ idleExpireMs: 1000 }, store);
  const { token } = service.issue();
  const device = service.accept(token, null, false);
  assert.ok(device);
  store.advance(5000);
  assert.equal(service.getDevice(device.id), null, "idle device expired");
});

test("stop() revokes everything and clears the token", () => {
  const store = makeStore();
  const service = new PairingService({}, store);
  const { token } = service.issue();
  assert.ok(service.accept(token, null, false));
  service.stop();
  assert.equal(service.listDevices().length, 0);
  assert.equal(service.activeToken(), null);
  const { token: t2 } = service.issue();
  assert.ok(service.accept(t2, null, false), "after stop a fresh token still pairs");
});

test("device names are inferred from the UA, never raw", () => {
  assert.equal(deviceNameFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", false), "Windows PC");
  assert.equal(deviceNameFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)", true), "Phone");
  assert.equal(deviceNameFromUserAgent(null, false), "Paired device");
});

test("persistence round-trips an active token and devices atomically", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-pairing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "pairing.json");
  const store = makeStore();
  const service = new PairingService({}, store, file);
  const { token } = service.issue();

  // Unconsumed token survives a reload.
  const reloaded = new PairingService({}, store, file);
  assert.equal(reloaded.activeToken()?.value, token);

  // Devices survive too, after the token is consumed.
  const device = reloaded.accept(token, "Mozilla/5.0 (Macintosh)", false);
  assert.ok(device);
  const reloaded2 = new PairingService({}, store, file);
  assert.equal(reloaded2.activeToken(), null, "consumed token must not persist");
  assert.equal(reloaded2.getDevice(device.id)?.name, "Mac");
});

test("stale services cannot replay consumed tokens or resurrect revoked devices", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-pairing-authority-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "pairing.json");
  const clock = makeStore();
  const service = new PairingService({}, clock, file);
  const { token } = service.issue();
  const stale = new PairingService({}, clock, file);
  const device = service.accept(token, null, true);
  assert.ok(device);
  assert.equal(stale.accept(token, null, true), null);
  assert.equal(stale.touch(device.id), true, "newly committed device is visible to another service");
  assert.equal(service.revoke(device.id), true);
  assert.equal(stale.touch(device.id), false, "heartbeat cannot restore a revoked device");
  stale.issue();
  assert.equal(new PairingService({}, clock, file).getDevice(device.id), null);
});

for (const operation of ["accept", "revoke", "stop"]) {
  test(`${operation} persistence failure throws and leaves all authority fail-closed after reload`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "omp-pairing-write-error-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "pairing.json");
    const clock = makeStore();
    const service = new PairingService({}, clock, file);
    const device = service.accept(service.issue().token, null, true);
    const { token } = service.issue();
    // A real filesystem write error, without replacing the authority file.
    mkdirSync(`${file}.tmp`);
    const mutate = () => operation === "accept" ? service.accept(token, null, true)
      : operation === "revoke" ? service.revoke(device.id) : service.stop();
    assert.throws(mutate, /pairing.*storage/i);
    const { readPairingState } = await jiti.import("./remote-pairing.ts");
    assert.throws(() => readPairingState(file), /pairing.*storage/i);
    assert.throws(() => new PairingService({}, clock, file).issue(), /pairing.*storage/i);
  });
}

test("corrupt existing state stays preserved and cannot be replaced by a fresh token", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-pairing-corrupt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "pairing.json");
  writeFileSync(file, "{corrupt");
  assert.throws(() => new PairingService({}, makeStore(), file).issue(), /pairing.*storage/i);
  assert.equal(readFileSync(file, "utf8"), "{corrupt");
});

test("heartbeat persists at a bounded interval below even a short idle expiry", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-pairing-heartbeat-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "pairing.json");
  const clock = makeStore();
  const service = new PairingService({ idleExpireMs: 100 }, clock, file);
  const device = service.accept(service.issue().token, null, true);
  const initial = readFileSync(file, "utf8");
  clock.advance(10);
  assert.equal(service.touch(device.id), true);
  assert.equal(readFileSync(file, "utf8"), initial, "heartbeat does not sync-write every time");
  clock.advance(40);
  assert.equal(service.touch(device.id), true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).devices[0].lastActiveAt, 1_000_050);
  const reloaded = new PairingService({}, clock, file);
  clock.advance(40);
  assert.equal(reloaded.touch(device.id), true);
  clock.advance(20);
  assert.ok(new PairingService({}, clock, file).getDevice(device.id), "active device survives original expiry");
});

test("heartbeat cannot revive a device whose durable idle window already expired", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-pairing-expired-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "pairing.json");
  const clock = makeStore();
  const service = new PairingService({ idleExpireMs: 100 }, clock, file);
  const device = service.accept(service.issue().token, null, true);
  clock.advance(101);
  assert.equal(service.touch(device.id), false);
});

test("default heartbeats stay write-bounded and stop cannot be undone by stale presence", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-pairing-default-heartbeat-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "pairing.json");
  const clock = makeStore();
  const service = new PairingService({}, clock, file);
  const device = service.accept(service.issue().token, null, true);
  const stale = new PairingService({}, clock, file);
  const initial = readFileSync(file, "utf8");
  for (let i = 0; i < 5; i++) {
    clock.advance(10_000);
    assert.equal(service.touch(device.id), true);
  }
  assert.equal(readFileSync(file, "utf8"), initial);
  clock.advance(10_000);
  assert.equal(service.touch(device.id), true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).devices[0].lastActiveAt, 1_060_000);
  service.stop();
  assert.equal(stale.touch(device.id), false);
  assert.equal(stale.activeToken(), null);
  assert.equal(new PairingService({}, clock, file).listDevices().length, 0);
});

test("isRemoteRequest distinguishes loopback from LAN/public hosts", () => {
  assert.equal(isRemoteRequest("127.0.0.1"), false);
  assert.equal(isRemoteRequest("localhost:30178"), false);
  assert.equal(isRemoteRequest("192.168.1.5:30178"), true);
  assert.equal(isRemoteRequest("omp.example.com"), true);
  assert.equal(isRemoteRequest(null), false);
});

test("DEFAULT_IDLE_EXPIRE_MS is seven days", () => {
  assert.equal(DEFAULT_IDLE_EXPIRE_MS, 7 * 24 * 60 * 60 * 1000);
});

test("lanAddress skips virtual adapters and prefers physical NICs", async () => {
  const { lanAddress } = await jiti.import("./remote-pairing.ts");
  const interfaces = {
    "vEthernet (WSL)": [{ address: "172.20.0.1", family: "IPv4", internal: false }],
    "VirtualBox Host-Only": [{ address: "192.168.56.1", family: "IPv4", internal: false }],
    "Wi-Fi": [{ address: "192.168.1.50", family: "IPv4", internal: false }],
  };
  assert.equal(lanAddress(interfaces), "192.168.1.50");
  const onlyVirtuals = { "vEthernet (WSL)": [{ address: "172.20.0.1", family: "IPv4", internal: false }] };
  assert.equal(lanAddress(onlyVirtuals), null);
  assert.equal(lanAddress({}), null);
});

test("pairingBase prefers LAN/public Host, then publicUrl, then lanAddress", async () => {
  const { pairingBase } = await jiti.import("./remote-pairing.ts");
  const req = (host) => ({ headers: { get: (name) => (name === "host" ? host : null) } });
  // Non-loopback host wins.
  assert.equal(pairingBase(req("192.168.1.50:30179"), undefined), "http://192.168.1.50:30179");
  // publicUrl beats loopback host.
  assert.equal(pairingBase(req("127.0.0.1:30179"), "https://omp.example.com/"), "https://omp.example.com");
  // Loopback + no publicUrl falls back to lanAddress with the request port.
  assert.match(pairingBase(req("127.0.0.1:30179"), undefined, "30178"), /^http:\/\/\d+\.\d+\.\d+\.\d+:30179$/);
  // Crafted host with CR/LF is rejected (falls through to lanAddress).
  assert.match(pairingBase(req("evil.com\r\nx:30179"), "https://fallback.test"), /^https:\/\/fallback\.test/);
});
