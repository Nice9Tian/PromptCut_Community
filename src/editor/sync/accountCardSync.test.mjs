/**
 * Tickets for card source sync in account cloud projects (`accountCardSync.ts`) and Agent server
 * bindings (`agentSideBinding.ts`). Report `docs/reports/AGENT-v18-cardsync.md`.
 * Run: npm test -- src/editor/sync/accountCardSync.test.mjs
 *
 *   ACS-01 Still in project: fetch a session based on login, return connection ticket and its
 *     expiration time; fetch fresh whenever needed
 *   ACS-02 No longer in project (switched project, switched account): do not fetch session, unbind
 *   ACS-03 Session API returns 401 / 403 / 404: unbind and throw; network disconnect or 503 only
 *     throws without unbinding
 *   ACS-04 Leave while fetching ticket: ticket is not returned, unbind
 *   ASB-01 Reproduce original issue: server still bound to previous local project, page remembers
 *     nothing after full reload and enters account project directly: must send unbind
 *   ASB-02 Unbind while bind is in flight: unbind queues behind, will not be overwritten; rebinds
 *     when returning to the same local project afterwards
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

test("ACS-01 still in the project: fetch a fresh session each time and hand out the connection ticket", async () => {
  const h = harness();
  assert.deepEqual(await h.ticket("sp_x"), { ticket: `${TICKET.slice(0, 42)}1`, expiresAt: 1001 });
  assert.deepEqual(await h.ticket("sp_x"), { ticket: `${TICKET.slice(0, 42)}2`, expiresAt: 1002 });
  assert.deepEqual(h.calls, { session: 2, stop: 0 });
});

test("ACS-02 no longer in the project: do not fetch a session, unbind", async () => {
  const h = harness({ current: false });
  await assert.rejects(h.ticket("sp_x"), /no longer in this cloud project/);
  assert.deepEqual(h.calls, { session: 0, stop: 1 });
});

test("ACS-03 401 / 403 / 404 unbind and throw; network loss and 503 only throw", async () => {
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

test("ACS-04 leaving while the ticket is being fetched: the ticket is not handed out", async () => {
  const h = harness({ session: async (_p, state) => { state.current = false; return { connectionTicket: TICKET, expiresAt: 1 }; } });
  await assert.rejects(h.ticket("sp_x"), /no longer in this cloud project/);
  assert.deepEqual(h.calls, { session: 1, stop: 1 });
});

/**
 * Test double for Agent server binding state (agentBinding in `server/agent/service/instance.mjs`)
 * in editor process: only recognizes the two interfaces bind / unbind
 */
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

test("ASB-01 the server is still bound to the previous local project and the page reloads straight into an account project: it must unbind", async () => {
  const realFetch = globalThis.fetch;
  try {
    // The page before reload was bound to local project local-1; the page after reload is a fresh
    // module state (represented here by a newly loaded module instance)
    const server = fakeAgentServer("local-1");
    const S = await import(`./agentSideBinding.ts?fresh=${Date.now()}`);
    // Before the change: entering an account project neither bound nor unbound, the server remained
    // local-1, and tools with side: "agent" read and wrote to it
    assert.equal(server.bound, "local-1");
    S.releaseAgentSide();
    await S.agentSideSettled();
    assert.equal(server.bound, null, "after entering an account project the server is no longer bound to another project");
    assert.deepEqual(server.log, ["/api/agent/unbind"]);
  } finally { globalThis.fetch = realFetch; }
});

test("ASB-02 an unbind issued while a bind is still in flight is not overwritten; afterwards, returning to the same local project binds again", async () => {
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
    assert.equal(server.bound, "local-1", "the same bind is resent after an unbind");
    S.bindAgentSide("local", "local-1", "ws://127.0.0.1/docservice");
    await S.agentSideSettled();
    assert.equal(server.log.length, 3, "an identical bind is not resent");
  } finally { globalThis.fetch = realFetch; }
});
