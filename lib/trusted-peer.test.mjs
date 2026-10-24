import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { networkInterfaces } from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { attestIncomingPeer, isTrustedLocalRequest, registerTrustedPeerIngress, TRUSTED_PEER_HEADER } = await jiti.import("./trusted-peer.ts");
const { pinWebAuthSecretForTests } = await jiti.import("./web-auth-secret.ts");
const secret = { salt: "a".repeat(43), key: "b".repeat(43) };

function incoming(peer, headers = {}, url = "/api/pair/token", method = "POST") {
  return { socket: { remoteAddress: peer }, headers: { host: "localhost:30178", ...headers }, url, method };
}
function webRequest(request) {
  return new Request(`http://${request.headers.host}${request.url}`, { method: request.method, headers: request.headers });
}

test("native peer attestation ignores forged Host and forwarding claims", (t) => {
  pinWebAuthSecretForTests(secret);
  t.after(() => pinWebAuthSecretForTests());
  for (const peer of ["192.0.2.20", "::ffff:192.0.2.20", undefined]) {
    const req = incoming(peer, { [TRUSTED_PEER_HEADER]: "forged", "x-forwarded-for": "127.0.0.1" });
    attestIncomingPeer(req);
    assert.equal(isTrustedLocalRequest(webRequest(req)), false);
  }
  for (const peer of ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1"]) {
    const req = incoming(peer);
    attestIncomingPeer(req);
    // Next adds these after the native boundary; they must not erase locality.
    req.headers["x-forwarded-for"] = peer;
    req.headers["x-forwarded-host"] = req.headers.host;
    assert.equal(isTrustedLocalRequest(webRequest(req)), true);
  }
});

test("original forwarding headers keep local tunnel/reverse-proxy sockets remote", (t) => {
  pinWebAuthSecretForTests(secret);
  t.after(() => pinWebAuthSecretForTests());
  for (const name of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-original-host", "cf-connecting-ip"]) {
    const req = incoming("127.0.0.1", { [name]: "" });
    attestIncomingPeer(req);
    assert.equal(isTrustedLocalRequest(webRequest(req)), false, name);
  }
});

test("missing, tampered, expired and differently signed attestations fail closed", (t) => {
  pinWebAuthSecretForTests(secret);
  t.after(() => pinWebAuthSecretForTests());
  assert.equal(isTrustedLocalRequest(new Request("http://localhost/api/pair/token")), false);
  const req = incoming("127.0.0.1");
  const issuedAt = 1_700_000_000_000;
  attestIncomingPeer(req, issuedAt);
  assert.equal(isTrustedLocalRequest(webRequest(req), issuedAt + 1), true);
  assert.equal(isTrustedLocalRequest(webRequest(req), issuedAt + 3_600_001), false);
  const tampered = { ...req, headers: { ...req.headers, [TRUSTED_PEER_HEADER]: `${req.headers[TRUSTED_PEER_HEADER]}x` } };
  assert.equal(isTrustedLocalRequest(webRequest(tampered), issuedAt + 1), false);
  // Binding to a raw URL/Host would reject legitimate Next normalization.
  assert.equal(isTrustedLocalRequest(webRequest({ ...req, url: "/normalized" }), issuedAt + 1), true);
  pinWebAuthSecretForTests({ ...secret, key: "c".repeat(43) });
  assert.equal(isTrustedLocalRequest(webRequest(req), issuedAt + 1), false);
});

test("real Node HTTP ingress overwrites caller attestation before request listeners and Next-like normalization", async (t) => {
  pinWebAuthSecretForTests(secret);
  const unregister = registerTrustedPeerIngress();
  t.after(() => { unregister(); pinWebAuthSecretForTests(); });
  const server = createServer((req, res) => {
    // Simulate precisely the injected headers that broke native loopback QR.
    req.headers["x-forwarded-for"] ??= req.socket.remoteAddress;
    req.headers["x-forwarded-host"] ??= req.headers.host;
    const local = isTrustedLocalRequest(webRequest(req));
    res.end(JSON.stringify({ local, overwritten: req.headers[TRUSTED_PEER_HEADER] !== "forged" }));
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const send = (headers, host = "127.0.0.1") => new Promise((resolve, reject) => {
    const req = httpRequest({ host, port: server.address().port, path: "/api/pair/token", method: "POST", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve(JSON.parse(body)));
    });
    req.on("error", reject);
    req.end();
  });
  assert.deepEqual(await send({ [TRUSTED_PEER_HEADER]: "forged" }), { local: true, overwritten: true });
  assert.deepEqual(await send({ [TRUSTED_PEER_HEADER]: "forged", "x-forwarded-for": "127.0.0.1" }), { local: false, overwritten: true });
  const lanAddress = Object.values(networkInterfaces()).flat().find((address) => address
    && address.family === "IPv4" && !address.internal)?.address;
  if (lanAddress) {
    for (const forwarding of [{}, { "x-forwarded-for": "" }, { "x-forwarded-for": "127.0.0.1" }]) {
      assert.deepEqual(await send({
        host: "localhost:30178", [TRUSTED_PEER_HEADER]: "forged", ...forwarding,
      }, lanAddress), { local: false, overwritten: true }, "actual nonloopback socket cannot forge localhost");
    }
  } else {
    t.diagnostic("No nonloopback IPv4 interface: native nonloopback transport subcase unavailable");
  }
});
