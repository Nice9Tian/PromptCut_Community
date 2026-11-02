/**
 * Path normalization for the /api checkpoint. Run: node --test server/test/http-guard.test.mjs
 *
 * This test was written for a real incident: the guard used `url.startsWith("/api/")` to determine
 * "whether this is an API request", whereas connect (vite's middleware layer) matches routes
 * **case-insensitively**. Thus
 *
 *     POST /aPi/ai/config    Content-Type: text/plain    Origin: http://evil.example
 *
 * In the guard's eyes "does not start with /api/" → allow; in connect's eyes it is /api/ai/config →
 * handled as usual. Both Origin and Content-Type checks were completely bypassed. In testing,
 * this request actually changed baseUrl in ai.json to the attacker's address: the checkpoint was
 * practically non-existent.
 *
 * So what is pinned down here is not "what the function returns", but **the path seen by the guard
 * must match what connect sees**.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { apiPath, originOk, jsonContentType, isLoopbackAddress, clientAddressOf, fromLocalClient, STAGE_CLIENT_HEADER } from "../http-guard.mjs";

/** connect's criteria, copied directly from node_modules/vite/dist/node/chunks/node.js:7059 */
const connectMatches = (url, route) =>
  url.split("?")[0].toLowerCase().substr(0, route.length) === route.toLowerCase();

test("whatever connect can match, the guard must also recognize", () => {
  const sneaky = [
    "/api/ai/config",
    "/aPi/ai/config",     // ← This is the exact one used in the real incident
    "/API/ai/config",
    "/Api/AI/config",
    "/ApI/aI/CoNfIg",
    "/api//ai/config",
    "/api/ai/config?x=1",
  ];
  for (const url of sneaky) {
    // First verify the premise: connect indeed hands it over to the /api handler. If the premise
    // does not hold, this test case proves nothing: so assert this as well.
    assert.ok(connectMatches(url, "/api"), `precondition does not hold: connect should not match ${url}`);
    assert.ok(
      apiPath(url).startsWith("/api/"),
      `the guard missed ${url}: connect would hand it to the /api handler, but the guard thinks it is not its business`,
    );
  }
});

test("leading duplicate slashes: connect cannot route them anyway, so an extra block by the guard does no harm", () => {
  // `//api/...` in connect has substr(0,4) as "//ap", which does not match: it is not a bypass vector.
  // But after stripping duplicate slashes, the guard recognizes it and treats it as an API (testing
  // shows it returns 403 instead of allowing it), falling under "erring on the side of blocking more".
  // This fact is pinned down here so no one later thinks collapsing slashes is a required criterion.
  assert.equal(connectMatches("//api/ai/config", "/api"), false);
  assert.equal(apiPath("//api/ai/config"), "/api/ai/config");
});

test("paths that really are not API paths must not be misjudged as API", () => {
  for (const url of ["/", "/index.html", "/src/main.tsx", "/apiary/x", "/notapi/x", "/@vite/client"]) {
    assert.equal(apiPath(url).startsWith("/api/"), false, `${url} should not be treated as API`);
  }
});

test("the query string does not take part in the decision", () => {
  assert.equal(apiPath("/api/ai/config?a=/evil/"), "/api/ai/config");
  assert.equal(apiPath("/API/x?B=C"), "/api/x");
});

test("percent-encoding is not decoded: consistent with connect", () => {
  // connect does not decode either; /%61pi/... likewise does not match there (testing shows 404
  // returned). Only when neither side recognizes it will there be no seam of "one side recognizes
  // while the other does not". This consistency is pinned down here.
  assert.equal(connectMatches("/%61pi/ai/config", "/api"), false);
  assert.equal(apiPath("/%61pi/ai/config").startsWith("/api/"), false);
});

test("originOk: same-origin allowed, cross-origin rejected, a missing Origin counts as our own", () => {
  const req = (headers) => ({ headers });
  assert.equal(originOk(req({ host: "127.0.0.1:5190", origin: "http://127.0.0.1:5190" })), true);
  assert.equal(originOk(req({ host: "127.0.0.1:5190", origin: "https://127.0.0.1:5190" })), true);
  assert.equal(originOk(req({ host: "127.0.0.1:5190", origin: "http://evil.example" })), false);
  // Different ports are also cross-origin
  assert.equal(originOk(req({ host: "127.0.0.1:5190", origin: "http://127.0.0.1:3000" })), false);
  // curl / sidecar / MCP scripts do not include Origin
  assert.equal(originOk(req({ host: "127.0.0.1:5190" })), true);
});

test("jsonContentType: only application/json is recognized, with a charset also counts", () => {
  const req = (ct) => ({ headers: ct === undefined ? {} : { "content-type": ct } });
  assert.equal(jsonContentType(req("application/json")), true);
  assert.equal(jsonContentType(req("application/json; charset=utf-8")), true);
  assert.equal(jsonContentType(req("APPLICATION/JSON")), true);
  // The following three are precisely "simple requests": those without preflight that can hit
  // directly across sites
  assert.equal(jsonContentType(req("text/plain")), false);
  assert.equal(jsonContentType(req("application/x-www-form-urlencoded")), false);
  assert.equal(jsonContentType(req("multipart/form-data; boundary=x")), false);
  assert.equal(jsonContentType(req(undefined)), false);
});

test("isAssetServicePath: recognizes only the asset service path kinds and judges the normalized form", async () => {
  const { isAssetServicePath } = await import("../http-guard.mjs");
  const h = "0f".repeat(32);
  for (const ok of [`/api/asset/media/${h}`, `/api/asset/media/${h}/chunks`, `/api/asset/media/${h}/complete`,
    `/api/asset/media/${h}/12`, `/API/Asset/media/${h.toUpperCase()}/0?x=1`, `//api//asset/media/${h}/chunks`]) {
    assert.equal(isAssetServicePath(ok), true, ok);
  }
  for (const no of ["/api/asset/", `/api/asset/media/${h}/`, `/api/asset/media/${h}/chunks/1`, `/api/asset/media/${h}/../x`,
    `/api/asset/media/${h.slice(1)}`, `/api/media/upload/${h}`, `/@media/${h}`, `/api/asset/media/${h}/12345678901`]) {
    assert.equal(isAssetServicePath(no), false, no);
  }
});

test("loopback addresses: 127.0.0.0/8, ::1, ::ffff:127.x; LAN addresses do not count", () => {
  for (const a of ["127.0.0.1", "127.5.6.7", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopbackAddress(a), true, a);
  for (const a of ["192.168.1.50", "10.0.0.2", "::ffff:192.168.1.50", "fe80::1", "", undefined]) assert.equal(isLoopbackAddress(a), false, String(a));
});

test("local criterion: no socket counts as local; a LAN peer is not local, and forging the stage proxy header does not help", () => {
  assert.equal(fromLocalClient({ headers: {} }), true);
  assert.equal(fromLocalClient({ socket: { remoteAddress: "127.0.0.1" }, headers: {} }), true);
  assert.equal(fromLocalClient({ socket: { remoteAddress: "192.168.1.50" }, headers: {} }), false);
  // LAN device connects directly to vite and fills in stage proxy header to impersonate local: peer is
  // not loopback, header is not trusted
  assert.equal(fromLocalClient({ socket: { remoteAddress: "192.168.1.50" }, headers: { [STAGE_CLIENT_HEADER]: "127.0.0.1" } }), false);
});

test("requests coming in through the stage port proxy: the peer is loopback, so judge by the real peer written by the proxy", () => {
  const viaProxy = (client) => ({ socket: { remoteAddress: "127.0.0.1" }, headers: { [STAGE_CLIENT_HEADER]: client } });
  assert.equal(clientAddressOf(viaProxy("192.168.1.50")), "192.168.1.50");
  assert.equal(fromLocalClient(viaProxy("192.168.1.50")), false);
  assert.equal(fromLocalClient(viaProxy("::ffff:127.0.0.1")), true);
});
