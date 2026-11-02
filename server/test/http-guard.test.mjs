/**
 * /api 卡口的路径归一化。跑:node --test server/test/http-guard.test.mjs
 *
 * 这条测试是为一个真事故立的:守卫用 `url.startsWith("/api/")` 判断「这是不是 API 请求」,
 * 而 connect(vite 的中间件层)匹配路由时**不区分大小写**。于是
 *
 *     POST /aPi/ai/config    Content-Type: text/plain    Origin: http://evil.example
 *
 * 在守卫看来「不是 /api/ 开头」→ 放行;在 connect 看来就是 /api/ai/config → 照常处理。
 * Origin 和 Content-Type 两道全部绕过。实测这一发真的把 ai.json 里的 baseUrl 改成了
 * 攻击者的地址 —— 卡口等于不存在。
 *
 * 所以这里钉死的不是「函数返回什么」,而是**守卫看到的路径必须和 connect 看到的一致**。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { apiPath, originOk, jsonContentType, isLoopbackAddress, clientAddressOf, fromLocalClient, STAGE_CLIENT_HEADER } from "../http-guard.mjs";

/** connect 的判据,照抄 node_modules/vite/dist/node/chunks/node.js:7059 */
const connectMatches = (url, route) =>
  url.split("?")[0].toLowerCase().substr(0, route.length) === route.toLowerCase();

test("whatever connect can match, the guard must also recognize", () => {
  const sneaky = [
    "/api/ai/config",
    "/aPi/ai/config",     // ← 真实事故里用的就是这一条
    "/API/ai/config",
    "/Api/AI/config",
    "/ApI/aI/CoNfIg",
    "/api//ai/config",
    "/api/ai/config?x=1",
  ];
  for (const url of sneaky) {
    // 先确认前提:connect 确实会把它交给 /api 的处理函数。前提不成立的话,
    // 这条用例证明不了任何事 —— 所以把它也断言出来。
    assert.ok(connectMatches(url, "/api"), `precondition does not hold: connect should not match ${url}`);
    assert.ok(
      apiPath(url).startsWith("/api/"),
      `the guard missed ${url}: connect would hand it to the /api handler, but the guard thinks it is not its business`,
    );
  }
});

test("leading duplicate slashes: connect cannot route them anyway, so an extra block by the guard does no harm", () => {
  // `//api/...` 在 connect 那里 substr(0,4) 是 "//ap",匹配不上 —— 它不是绕过向量。
  // 但守卫把重复斜杠折掉之后会认出它并按 API 处理(实测回 403 而不是放行),
  // 属于「宁可多挡」。这里把这个事实钉住,免得以后有人以为折斜杠是必需的判据。
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
  // connect 也不解码,/%61pi/... 在它那儿同样匹配不上(实测回 404)。
  // 两边都不认,才不会出现「一边认一边不认」的缝。这里钉住这个一致性。
  assert.equal(connectMatches("/%61pi/ai/config", "/api"), false);
  assert.equal(apiPath("/%61pi/ai/config").startsWith("/api/"), false);
});

test("originOk: same-origin allowed, cross-origin rejected, a missing Origin counts as our own", () => {
  const req = (headers) => ({ headers });
  assert.equal(originOk(req({ host: "127.0.0.1:5190", origin: "http://127.0.0.1:5190" })), true);
  assert.equal(originOk(req({ host: "127.0.0.1:5190", origin: "https://127.0.0.1:5190" })), true);
  assert.equal(originOk(req({ host: "127.0.0.1:5190", origin: "http://evil.example" })), false);
  // 端口不同也是跨源
  assert.equal(originOk(req({ host: "127.0.0.1:5190", origin: "http://127.0.0.1:3000" })), false);
  // curl / sidecar / MCP 脚本不带 Origin
  assert.equal(originOk(req({ host: "127.0.0.1:5190" })), true);
});

test("jsonContentType: only application/json is recognized, with a charset also counts", () => {
  const req = (ct) => ({ headers: ct === undefined ? {} : { "content-type": ct } });
  assert.equal(jsonContentType(req("application/json")), true);
  assert.equal(jsonContentType(req("application/json; charset=utf-8")), true);
  assert.equal(jsonContentType(req("APPLICATION/JSON")), true);
  // 下面这三种正是「简单请求」——不预检、能跨站直接打进来的那些
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
  // 局域网设备直连 vite、自己填舞台代理头冒充本机:对端不是回环,头不被采信
  assert.equal(fromLocalClient({ socket: { remoteAddress: "192.168.1.50" }, headers: { [STAGE_CLIENT_HEADER]: "127.0.0.1" } }), false);
});

test("requests coming in through the stage port proxy: the peer is loopback, so judge by the real peer written by the proxy", () => {
  const viaProxy = (client) => ({ socket: { remoteAddress: "127.0.0.1" }, headers: { [STAGE_CLIENT_HEADER]: client } });
  assert.equal(clientAddressOf(viaProxy("192.168.1.50")), "192.168.1.50");
  assert.equal(fromLocalClient(viaProxy("192.168.1.50")), false);
  assert.equal(fromLocalClient(viaProxy("::ffff:127.0.0.1")), true);
});
