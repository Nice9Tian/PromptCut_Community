/**
 * 账号云端项目里卡片源码同步的票据(`accountCardSync.ts`)与 Agent 服务端的绑定(`agentSideBinding.ts`)。报告 `docs/reports/AGENT-v18-cardsync.md`。
 * 跑:npm test -- src/editor/sync/accountCardSync.test.mjs
 *
 *   ACS-01 还在项目里:凭登录取一份会话,交出其中的连接票据与它的到期时刻;每次要都现取
 *   ACS-02 已经不在项目里(换了项目、换了账号):不取会话,解绑
 *   ACS-03 会话接口回 401 / 403 / 404:解绑并抛;断网、503 只抛不解绑
 *   ACS-04 取票据的途中离开:票据不交出去,解绑
 *   ASB-01 复现原问题:服务端还绑着上一个本机项目、页面整页重载后什么都不记得,直接进账号项目 —— 必须发解绑
 *   ASB-02 绑定还在路上时解绑:解绑排在后面,不会被盖回去;之后回同一个本机项目会重新绑
 */
import "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const A = await import("./accountCardSync.ts");
const TICKET = "t".repeat(43);

function harness({ current = true, session } = {}) {
  const calls = { session: 0, stop: 0 };
  const state = { current };
  const ticket = A.accountCardTicket({
    session: async (projectId) => { calls.session++; return (session ?? (async () => ({ connectionTicket: `${TICKET.slice(0, 42)}${calls.session}`, expiresAt: 1000 + calls.session })))(projectId, state); },
    isCurrent: () => state.current,
    stop: () => { calls.stop++; },
  });
  return { ticket, calls, state };
}

test("ACS-01 还在项目里:每次现取一份会话,交出连接票据", async () => {
  const h = harness();
  assert.deepEqual(await h.ticket("sp_x"), { ticket: `${TICKET.slice(0, 42)}1`, expiresAt: 1001 });
  assert.deepEqual(await h.ticket("sp_x"), { ticket: `${TICKET.slice(0, 42)}2`, expiresAt: 1002 });
  assert.deepEqual(h.calls, { session: 2, stop: 0 });
});

test("ACS-02 已经不在项目里:不取会话,解绑", async () => {
  const h = harness({ current: false });
  await assert.rejects(h.ticket("sp_x"), /不在这个云端项目/);
  assert.deepEqual(h.calls, { session: 0, stop: 1 });
});

test("ACS-03 401 / 403 / 404 解绑并抛;断网与 503 只抛", async () => {
  for (const status of [401, 403, 404]) {
    const h = harness({ session: async () => { throw Object.assign(new Error("x"), { status, code: "c" }); } });
    await assert.rejects(h.ticket("sp_x"), (e) => e.status === status);
    assert.equal(h.calls.stop, 1, `status ${status}`);
  }
  for (const status of [0, 503]) {
    const h = harness({ session: async () => { throw Object.assign(new Error("x"), { status }); } });
    await assert.rejects(h.ticket("sp_x"));
    assert.equal(h.calls.stop, 0, `status ${status}`);
  }
  assert.equal(A.isTerminalAccountFailure(new Error("plain")), false);
});

test("ACS-04 取票据的途中离开:票据不交出去", async () => {
  const h = harness({ session: async (_p, state) => { state.current = false; return { connectionTicket: TICKET, expiresAt: 1 }; } });
  await assert.rejects(h.ticket("sp_x"), /不在这个云端项目/);
  assert.deepEqual(h.calls, { session: 1, stop: 1 });
});

/** 编辑器进程里 Agent 服务端的绑定状态(`server/agent/service/instance.mjs` 的 agentBinding)的替身:只认 bind / unbind 两个接口 */
function fakeAgentServer(initial = null) {
  const server = { bound: initial, log: [], gate: null };
  globalThis.fetch = async (path, init) => {
    if (server.gate) await server.gate;
    const body = JSON.parse(init.body);
    server.log.push(path);
    if (path === "/api/agent/bind") server.bound = body.projectId;
    else if (path === "/api/agent/unbind") server.bound = null;
    return { json: async () => ({ ok: true }) };
  };
  return server;
}

test("ASB-01 服务端还绑着上一个本机项目、页面重载后直接进账号项目:必须解绑", async () => {
  const realFetch = globalThis.fetch;
  try {
    // 重载前的页面绑过本机项目 local-1;重载后的页面是一份全新的模块状态(这里用新载入的模块实例表示)
    const server = fakeAgentServer("local-1");
    const S = await import(`./agentSideBinding.ts?fresh=${Date.now()}`);
    // 改之前:进账号项目时既不绑也不解,服务端一直是 local-1,side: "agent" 的工具读写的就是它
    assert.equal(server.bound, "local-1");
    S.releaseAgentSide();
    await S.agentSideSettled();
    assert.equal(server.bound, null, "进账号项目后服务端不再绑着别的项目");
    assert.deepEqual(server.log, ["/api/agent/unbind"]);
  } finally { globalThis.fetch = realFetch; }
});

test("ASB-02 绑定还在路上时解绑不会被盖回去;之后回同一个本机项目重新绑", async () => {
  const realFetch = globalThis.fetch;
  try {
    const server = fakeAgentServer(null);
    const S = await import(`./agentSideBinding.ts?fresh2=${Date.now()}`);
    let open;
    server.gate = new Promise((r) => { open = r; });
    S.bindAgentSide("local", "local-1", "ws://127.0.0.1/docservice");
    S.releaseAgentSide();
    server.gate = null; open();
    await S.agentSideSettled();
    assert.deepEqual(server.log, ["/api/agent/bind", "/api/agent/unbind"]);
    assert.equal(server.bound, null);
    S.bindAgentSide("local", "local-1", "ws://127.0.0.1/docservice");
    await S.agentSideSettled();
    assert.equal(server.bound, "local-1", "同一个绑定在解绑之后会重发");
    S.bindAgentSide("local", "local-1", "ws://127.0.0.1/docservice");
    await S.agentSideSettled();
    assert.equal(server.log.length, 3, "同样的绑定不重发");
  } finally { globalThis.fetch = realFetch; }
});
