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

test("connect 能匹配上的,守卫也必须认出来", () => {
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
    assert.ok(connectMatches(url, "/api"), `前提不成立:connect 不该匹配 ${url}`);
    assert.ok(
      apiPath(url).startsWith("/api/"),
      `守卫漏掉了 ${url} —— connect 会把它交给 /api 的处理函数,守卫却认为不归自己管`,
    );
  }
});

test("开头的重复斜杠:connect 本来就路由不过去,守卫多挡一道也无妨", () => {
  // `//api/...` 在 connect 那里 substr(0,4) 是 "//ap",匹配不上 —— 它不是绕过向量。
  // 但守卫把重复斜杠折掉之后会认出它并按 API 处理(实测回 403 而不是放行),
  // 属于「宁可多挡」。这里把这个事实钉住,免得以后有人以为折斜杠是必需的判据。
  assert.equal(connectMatches("//api/ai/config", "/api"), false);
  assert.equal(apiPath("//api/ai/config"), "/api/ai/config");
});

test("确实不是 API 的路径不能被误判成 API", () => {
  for (const url of ["/", "/index.html", "/src/main.tsx", "/apiary/x", "/notapi/x", "/@vite/client"]) {
    assert.equal(apiPath(url).startsWith("/api/"), false, `${url} 不该被当成 API`);
  }
});

test("查询串不参与判断", () => {
  assert.equal(apiPath("/api/ai/config?a=/evil/"), "/api/ai/config");
  assert.equal(apiPath("/API/x?B=C"), "/api/x");
});

test("百分号编码不解码 —— 和 connect 保持一致", () => {
  // connect 也不解码,/%61pi/... 在它那儿同样匹配不上(实测回 404)。
  // 两边都不认,才不会出现「一边认一边不认」的缝。这里钉住这个一致性。
  assert.equal(connectMatches("/%61pi/ai/config", "/api"), false);
  assert.equal(apiPath("/%61pi/ai/config").startsWith("/api/"), false);
});

test("originOk:同源放行、跨源拒、没有 Origin 当自己人", () => {
  const req = (headers) => ({ headers });
  assert.equal(originOk(req({ host: "127.0.0.1:5190", origin: "http://127.0.0.1:5190" })), true);
  assert.equal(originOk(req({ host: "127.0.0.1:5190", origin: "https://127.0.0.1:5190" })), true);
  assert.equal(originOk(req({ host: "127.0.0.1:5190", origin: "http://evil.example" })), false);
  // 端口不同也是跨源
  assert.equal(originOk(req({ host: "127.0.0.1:5190", origin: "http://127.0.0.1:3000" })), false);
  // curl / sidecar / MCP 脚本不带 Origin
  assert.equal(originOk(req({ host: "127.0.0.1:5190" })), true);
});

test("jsonContentType:只认 application/json,带 charset 也算", () => {
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

test("isAssetServicePath:只认素材服务那几种路径,判的是归一化之后的形式", async () => {
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

test("回环地址:127.0.0.0/8、::1、::ffff:127.x;局域网地址不算", () => {
  for (const a of ["127.0.0.1", "127.5.6.7", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopbackAddress(a), true, a);
  for (const a of ["192.168.1.50", "10.0.0.2", "::ffff:192.168.1.50", "fe80::1", "", undefined]) assert.equal(isLoopbackAddress(a), false, String(a));
});

test("本机判据:没有 socket 算本机;对端是局域网就不是本机,伪造舞台代理头也没用", () => {
  assert.equal(fromLocalClient({ headers: {} }), true);
  assert.equal(fromLocalClient({ socket: { remoteAddress: "127.0.0.1" }, headers: {} }), true);
  assert.equal(fromLocalClient({ socket: { remoteAddress: "192.168.1.50" }, headers: {} }), false);
  // 局域网设备直连 vite、自己填舞台代理头冒充本机:对端不是回环,头不被采信
  assert.equal(fromLocalClient({ socket: { remoteAddress: "192.168.1.50" }, headers: { [STAGE_CLIENT_HEADER]: "127.0.0.1" } }), false);
});

test("经舞台端口代理进来的请求:对端是回环,按代理写的真实对端判", () => {
  const viaProxy = (client) => ({ socket: { remoteAddress: "127.0.0.1" }, headers: { [STAGE_CLIENT_HEADER]: client } });
  assert.equal(clientAddressOf(viaProxy("192.168.1.50")), "192.168.1.50");
  assert.equal(fromLocalClient(viaProxy("192.168.1.50")), false);
  assert.equal(fromLocalClient(viaProxy("::ffff:127.0.0.1")), true);
});
