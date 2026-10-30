/**
 * 预渲染进程入口守卫单测
 * 跑: node --test server/test/prerender-gate.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isPrerenderRequestAllowed, prerenderGatePlugin, PRERENDER_DENY_BODY } from "../prerender-gate.mjs";

test("PRERENDER-GATE-01 拦截来自舞台端口的请求 (Origin / Referer / x-pc-stage-client)", () => {
  const oldPorts = process.env.PROMPTCUT_STAGE_PORTS;
  const oldCors = process.env.PROMPTCUT_CORS_ORIGINS;
  const oldTok = process.env.PROMPTCUT_INTERNAL_TOKEN;
  try {
    process.env.PROMPTCUT_STAGE_PORTS = "5191,5192";
    process.env.PROMPTCUT_CORS_ORIGINS = "http://127.0.0.1:5190,http://localhost:5190";
    process.env.PROMPTCUT_INTERNAL_TOKEN = "secret-tok";

    // 1. x-pc-stage-client: 非流/快照接口一律拒，只读流/快照放行
    assert.deepEqual(isPrerenderRequestAllowed({ method: "POST", url: "/api/frames/render-node", headers: { "x-pc-stage-client": "127.0.0.1" } }), { ok: false, reason: "stage-client-header" });
    assert.deepEqual(isPrerenderRequestAllowed({ method: "GET", url: "/api/frames/stream/k1/manifest", headers: { "x-pc-stage-client": "127.0.0.1" } }), { ok: true });

    // 2. Stage Origin: 调预渲染控制/渲染接口被拦，只读拉流/快照字节放行
    assert.deepEqual(isPrerenderRequestAllowed({ method: "POST", url: "/api/frames/see", headers: { origin: "http://127.0.0.1:5191" } }), { ok: false, reason: "stage-origin" });
    assert.deepEqual(isPrerenderRequestAllowed({ method: "GET", url: "/api/frames/ready", headers: { origin: "http://localhost:5192" } }), { ok: false, reason: "stage-origin" });
    assert.deepEqual(isPrerenderRequestAllowed({ method: "POST", url: "/api/frames/stream/k1/manifest", headers: { origin: "http://127.0.0.1:5191" } }), { ok: false, reason: "stage-origin" });
    assert.deepEqual(isPrerenderRequestAllowed({ method: "GET", url: "/api/frames/stream/k1/manifest", headers: { origin: "http://127.0.0.1:5191" } }), { ok: true });
    assert.deepEqual(isPrerenderRequestAllowed({ method: "GET", url: "/api/frames/snapshot/png/k1/0", headers: { origin: "http://localhost:5192" } }), { ok: true });

    // 3. Stage Referer: 非流/快照接口被拦
    assert.deepEqual(isPrerenderRequestAllowed({ method: "GET", url: "/api/frames/diagnostics", headers: { referer: "http://127.0.0.1:5191/?stage=1&id=A" } }), { ok: false, reason: "stage-referer" });
    assert.deepEqual(isPrerenderRequestAllowed({ method: "POST", url: "/api/frames/preload", headers: { referer: "http://localhost:5192/stage.html" } }), { ok: false, reason: "stage-referer" });

    // 4. 恶意跨源（无 token）
    assert.deepEqual(isPrerenderRequestAllowed({ method: "GET", url: "/api/frames/ready", headers: { origin: "http://evil.com", host: "127.0.0.1:54321" } }), { ok: false, reason: "cross-origin-no-token" });

    // 5. 跨源但带合法内部 token
    assert.deepEqual(isPrerenderRequestAllowed({ method: "POST", url: "/api/frames/see", headers: { origin: "http://other-service.local", "x-pc-internal-token": "secret-tok" } }), { ok: true });

    // 6. 编辑器合法源与预渲染进程自身同源（无头 Chrome 加载 /?export=1）
    assert.deepEqual(isPrerenderRequestAllowed({ method: "GET", url: "/api/frames/ready", headers: { origin: "http://127.0.0.1:5190" } }), { ok: true });
    assert.deepEqual(isPrerenderRequestAllowed({ method: "GET", url: "/api/frames/ready", headers: { origin: "http://localhost:5190" } }), { ok: true });
    assert.deepEqual(isPrerenderRequestAllowed({ method: "GET", url: "/src/main.tsx", headers: { origin: "http://127.0.0.1:54321", host: "127.0.0.1:54321" } }), { ok: true });

    // 7. 本机内部请求（无 Origin/Referer）
    assert.deepEqual(isPrerenderRequestAllowed({ headers: {} }), { ok: true });
  } finally {
    process.env.PROMPTCUT_STAGE_PORTS = oldPorts || "";
    process.env.PROMPTCUT_CORS_ORIGINS = oldCors || "";
    process.env.PROMPTCUT_INTERNAL_TOKEN = oldTok || "";
  }
});

test("PRERENDER-GATE-02 中间件回 403 并返回标准拒绝文案", () => {
  const plugin = prerenderGatePlugin();
  let middleware = null;
  const mockServer = {
    middlewares: {
      use(fn) { middleware = fn; },
    },
  };
  plugin.configureServer(mockServer);
  assert.ok(middleware);

  process.env.PROMPTCUT_STAGE_PORTS = "5191";
  let statusCode = 200;
  let headers = {};
  let body = "";
  let nextCalled = false;

  const mockRes = {
    set statusCode(code) { statusCode = code; },
    setHeader(k, v) { headers[k] = v; },
    end(data) { body = data; },
  };

  // 1. 来自舞台：被拦
  middleware({ headers: { origin: "http://127.0.0.1:5191" } }, mockRes, () => { nextCalled = true; });
  assert.equal(statusCode, 403);
  assert.equal(body, PRERENDER_DENY_BODY);
  assert.equal(nextCalled, false);

  // 2. 正常请求：放行
  statusCode = 200;
  body = "";
  nextCalled = false;
  middleware({ headers: {} }, mockRes, () => { nextCalled = true; });
  assert.equal(statusCode, 200);
  assert.equal(nextCalled, true);
});
