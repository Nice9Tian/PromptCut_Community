/**
 * Prerender process entry guard unit tests
 * Run: node --test server/test/prerender-gate.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isPrerenderRequestAllowed, prerenderGatePlugin, PRERENDER_DENY_BODY } from "../prerender-gate.mjs";

test("PRERENDER-GATE-01 blocks requests from the stage port (Origin / Referer / x-pc-stage-client)", () => {
  const oldPorts = process.env.PROMPTCUT_STAGE_PORTS;
  const oldCors = process.env.PROMPTCUT_CORS_ORIGINS;
  const oldTok = process.env.PROMPTCUT_INTERNAL_TOKEN;
  try {
    process.env.PROMPTCUT_STAGE_PORTS = "5191,5192";
    process.env.PROMPTCUT_CORS_ORIGINS = "http://127.0.0.1:5190,http://localhost:5190";
    process.env.PROMPTCUT_INTERNAL_TOKEN = "secret-tok";

    // 1. x-pc-stage-client: reject all non-stream/snapshot endpoints, allow read-only stream/snapshot
    assert.deepEqual(isPrerenderRequestAllowed({ method: "POST", url: "/api/frames/render-node", headers: { "x-pc-stage-client": "127.0.0.1" } }), { ok: false, reason: "stage-client-header" });
    assert.deepEqual(isPrerenderRequestAllowed({ method: "GET", url: "/api/frames/stream/k1/manifest", headers: { "x-pc-stage-client": "127.0.0.1" } }), { ok: true });

    // 2. Stage Origin: calls to prerender control/render endpoints blocked, read-only pull
    // stream/snapshot bytes allowed
    assert.deepEqual(isPrerenderRequestAllowed({ method: "POST", url: "/api/frames/see", headers: { origin: "http://127.0.0.1:5191" } }), { ok: false, reason: "stage-origin" });
    assert.deepEqual(isPrerenderRequestAllowed({ method: "GET", url: "/api/frames/ready", headers: { origin: "http://localhost:5192" } }), { ok: false, reason: "stage-origin" });
    assert.deepEqual(isPrerenderRequestAllowed({ method: "POST", url: "/api/frames/stream/k1/manifest", headers: { origin: "http://127.0.0.1:5191" } }), { ok: false, reason: "stage-origin" });
    assert.deepEqual(isPrerenderRequestAllowed({ method: "GET", url: "/api/frames/stream/k1/manifest", headers: { origin: "http://127.0.0.1:5191" } }), { ok: true });
    assert.deepEqual(isPrerenderRequestAllowed({ method: "GET", url: "/api/frames/snapshot/png/k1/0", headers: { origin: "http://localhost:5192" } }), { ok: true });

    // 3. Stage Referer: non-stream/snapshot endpoints blocked
    assert.deepEqual(isPrerenderRequestAllowed({ method: "GET", url: "/api/frames/diagnostics", headers: { referer: "http://127.0.0.1:5191/?stage=1&id=A" } }), { ok: false, reason: "stage-referer" });
    assert.deepEqual(isPrerenderRequestAllowed({ method: "POST", url: "/api/frames/preload", headers: { referer: "http://localhost:5192/stage.html" } }), { ok: false, reason: "stage-referer" });

    // 4. Malicious cross-origin (no token)
    assert.deepEqual(isPrerenderRequestAllowed({ method: "GET", url: "/api/frames/ready", headers: { origin: "http://evil.com", host: "127.0.0.1:54321" } }), { ok: false, reason: "cross-origin-no-token" });

    // 5. Cross-origin with valid internal token
    assert.deepEqual(isPrerenderRequestAllowed({ method: "POST", url: "/api/frames/see", headers: { origin: "http://other-service.local", "x-pc-internal-token": "secret-tok" } }), { ok: true });

    // 6. Editor valid origin is same-origin with prerender process itself (headless Chrome loads /?export=1)
    assert.deepEqual(isPrerenderRequestAllowed({ method: "GET", url: "/api/frames/ready", headers: { origin: "http://127.0.0.1:5190" } }), { ok: true });
    assert.deepEqual(isPrerenderRequestAllowed({ method: "GET", url: "/api/frames/ready", headers: { origin: "http://localhost:5190" } }), { ok: true });
    assert.deepEqual(isPrerenderRequestAllowed({ method: "GET", url: "/src/main.tsx", headers: { origin: "http://127.0.0.1:54321", host: "127.0.0.1:54321" } }), { ok: true });

    // 7. Local internal request (no Origin/Referer)
    assert.deepEqual(isPrerenderRequestAllowed({ headers: {} }), { ok: true });
  } finally {
    process.env.PROMPTCUT_STAGE_PORTS = oldPorts || "";
    process.env.PROMPTCUT_CORS_ORIGINS = oldCors || "";
    process.env.PROMPTCUT_INTERNAL_TOKEN = oldTok || "";
  }
});

test("PRERENDER-GATE-02 middleware responds 403 and returns the standard rejection message", () => {
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

  // 1. From stage: blocked
  middleware({ headers: { origin: "http://127.0.0.1:5191" } }, mockRes, () => { nextCalled = true; });
  assert.equal(statusCode, 403);
  assert.equal(body, PRERENDER_DENY_BODY);
  assert.equal(nextCalled, false);

  // 2. Normal request: allowed
  statusCode = 200;
  body = "";
  nextCalled = false;
  middleware({ headers: {} }, mockRes, () => { nextCalled = true; });
  assert.equal(statusCode, 200);
  assert.equal(nextCalled, true);
});
