/**
 * Desktop app automatically becomes render node for shared projects: page side (`renderNodeHandoff.ts`).
 * Report `docs/archive/agent-reports/AGENT-desktop-auto-node.md`.
 * Run: node --test src/editor/sync/renderNodeHandoff.test.mjs
 *
 *   RNH-01 Connect to shared project: wait until page selects asset service before handoff (with
 *          asset base URL and render ticket signed by this page); no duplicate handoff on reconnecting
 *          to same project
 *   RNH-05 Cannot select asset service: wait at most ASSET_WAIT_MS then hand off without base URL
 *          as usual; leaving while waiting revokes as usual
 *   RNH-02 Project document id arrives late, asset base URL selected: hand off again for same
 *          project, no new ticket signed
 *   RNH-03 Ticket round-trip: answer only for the project connected to this page; return error if
 *          signing fails
 *   RNH-04 Leave: revoke only for the same project; ignore subsequent ticket requests after revocation
 */
import "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const H = await import("./renderNodeHandoff.ts");
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

const posts = [];
const timers = [];
H.setRenderNodeDeps({ post: async (path, body) => { posts.push({ path, body }); return { ok: true }; },
  setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; }, clearTimer: (t) => { if (t) t.cleared = true; } });
let signed = 0;
let refuse = false;
const hooks = { ticket: async (projectId) => { if (refuse) throw new Error("This page is not connected to this shared project"); signed++; return `v1.t${signed}-${projectId}.s`; } };
const B = { url: "wss://site.example/hosted/", projectId: "P1", contentId: "doc-1" };

test("RNH-01 Connecting to a shared project: wait until an asset service is picked, then hand off with the base URL and ticket; connecting again does not hand off again", async () => {
  H.bindRenderNode(B, hooks);
  await flush();
  assert.equal(posts.length, 0, "Still waiting for this page to pick an asset service");
  assert.equal(timers.at(-1).ms, H.ASSET_WAIT_MS);
  H.noteRenderNodeAssetBase("https://site.example/media/api/asset/");
  await flush();
  assert.equal(timers.at(-1).cleared, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, "/api/render-node/bind");
  assert.deepEqual(posts[0].body, { url: B.url, projectId: "P1", contentId: "doc-1", assetBase: "https://site.example/media/api/asset", ticket: "v1.t1-P1.s" });
  H.bindRenderNode({ ...B }, hooks);
  await flush();
  assert.equal(posts.length, 1);
  assert.deepEqual(H.renderNodeHandoffDiag().bound, { url: B.url, projectId: "P1", contentId: "doc-1" });
  assert.ok(!JSON.stringify(H.renderNodeHandoffDiag()).includes("v1.t1"), "The diagnostics do not include the ticket");
});

test("RNH-02 The document id arrives late and the asset base URL is picked: hand off once more without signing another ticket", async () => {
  const before = signed;
  H.bindRenderNode({ ...B, contentId: "doc-2" }, hooks);
  await flush();
  assert.deepEqual(posts.at(-1).body, { url: B.url, projectId: "P1", contentId: "doc-2", assetBase: "https://site.example/media/api/asset" });
  H.noteRenderNodeAssetBase("https://other.example/api/asset");
  await flush();
  assert.deepEqual(posts.at(-1).body, { url: B.url, projectId: "P1", contentId: "doc-2", assetBase: "https://other.example/api/asset" });
  const n = posts.length;
  H.noteRenderNodeAssetBase("https://other.example/api/asset");
  H.noteRenderNodeAssetBase(null); // This machine as host: do not hand off (prerender process pushes local)
  await flush();
  assert.equal(posts.length, n);
  assert.equal(signed, before, "No additional ticket was signed");
});

test("RNH-03 Ticket round trip: only answer for the project this page is connected to", async () => {
  const n = posts.length;
  await H.answerRenderNodeTicket({ type: "ticket", reqId: "rn1", projectId: "OTHER" });
  assert.equal(posts.length, n, "Other projects get no answer");
  await H.answerRenderNodeTicket({ type: "ticket", reqId: "rn2", projectId: "P1" });
  assert.deepEqual(posts.at(-1), { path: "/api/render-node/ticket", body: { reqId: "rn2", ticket: `v1.t${signed}-P1.s` } });
  refuse = true;
  await H.answerRenderNodeTicket({ type: "ticket", reqId: "rn3", projectId: "P1" });
  assert.deepEqual(posts.at(-1), { path: "/api/render-node/ticket", body: { reqId: "rn3", error: "This page is not connected to this shared project" } });
  refuse = false;
});

test("RNH-04 Leaving: only withdraw the handoff for the same project", async () => {
  const n = posts.length;
  H.unbindRenderNode("OTHER");
  await flush();
  assert.equal(posts.length, n);
  H.unbindRenderNode("P1", "left");
  await flush();
  assert.deepEqual(posts.at(-1), { path: "/api/render-node/unbind", body: { projectId: "P1", reason: "left" } });
  assert.equal(H.renderNodeHandoffDiag().bound, null);
  const m = posts.length;
  await H.answerRenderNodeTicket({ type: "ticket", reqId: "rn4", projectId: "P1" });
  H.unbindRenderNode("P1");
  await flush();
  assert.equal(posts.length, m, "After withdrawing, no more ticket answers and no repeated withdrawal");
  // Connect to another project: sign tickets again for handoff
  H.bindRenderNode({ url: "ws://192.168.1.5:5190/docservice", projectId: "P2", contentId: "doc-9" }, hooks);
  H.noteRenderNodeAssetBase(null); // LAN host has not registered asset service: hand off as usual without base URL (prerender process selects from registry or local)
  await flush();
  assert.equal(posts.at(-1).path, "/api/render-node/bind");
  assert.equal("assetBase" in posts.at(-1).body, false);
  assert.equal(posts.at(-1).body.projectId, "P2");
  assert.match(posts.at(-1).body.ticket, /-P2\.s$/);
});

test("RNH-05 No asset service can be picked: hand off anyway once the wait is up; leaving during the wait still withdraws", async () => {
  H.unbindRenderNode("P2");
  await flush();
  H.bindRenderNode({ url: B.url, projectId: "P3", contentId: "doc-3" }, hooks);
  await flush();
  const n = posts.length;
  const t = timers.at(-1);
  assert.equal(t.ms, H.ASSET_WAIT_MS);
  t.fn();
  await flush();
  assert.equal(posts.length, n + 1);
  assert.deepEqual(Object.keys(posts.at(-1).body).sort(), ["contentId", "projectId", "ticket", "url"]);
  // Leave while waiting
  H.bindRenderNode({ url: B.url, projectId: "P4", contentId: "doc-4" }, hooks);
  const t4 = timers.at(-1);
  H.unbindRenderNode("P4");
  await flush();
  assert.equal(t4.cleared, true);
  assert.deepEqual(posts.at(-1), { path: "/api/render-node/unbind", body: { projectId: "P4", reason: "page-left" } });
});

test("RNH-06 An old binding that was already sent completes late: leaving and the new room must take effect last", async () => {
  let release;
  let backend = null;
  const started = [];
  H.setRenderNodeDeps({ post: async (path, body) => {
    started.push({ path, body });
    if (path.endsWith("/bind") && body.projectId === "SLOW") {
      await new Promise(r => { release = r; });
    }
    if (path.endsWith("/bind")) backend = body.projectId;
    if (path.endsWith("/unbind") && backend === body.projectId) backend = null;
    return { ok: true };
  }, setTimer: () => 0, clearTimer: () => {} });
  H.bindRenderNode({ ...B, projectId: "SLOW" }, hooks);
  H.noteRenderNodeAssetBase(null);
  await flush();
  assert.equal(typeof release, "function");
  H.unbindRenderNode("SLOW");
  H.bindRenderNode({ ...B, projectId: "NEW" }, hooks);
  H.noteRenderNodeAssetBase(null);
  await flush();
  release();
  await flush();
  assert.equal(backend, "NEW", "A late old HTTP response must not bind the node back to the old room");
  assert.deepEqual(started.map(x => [x.path.split("/").at(-1), x.body.projectId]), [
    ["bind", "SLOW"], ["unbind", "SLOW"], ["bind", "NEW"],
  ]);
  H.unbindRenderNode("NEW");
  await flush();
  assert.equal(backend, null);
});

test("RNH-07 When leaving and re-entering the same room while the old room is signing a ticket, the old ticket must not be handed to the new connection", async () => {
  const late = [];
  let release;
  H.setRenderNodeDeps({ post: async (path, body) => { late.push({ path, body }); return { ok: true }; },
    setTimer: () => 0, clearTimer: () => {} });
  H.bindRenderNode({ ...B, projectId: "SAME" }, { ticket: async () => new Promise(r => { release = r; }) });
  H.noteRenderNodeAssetBase(null);
  await flush();
  H.unbindRenderNode("SAME");
  H.bindRenderNode({ ...B, projectId: "SAME" }, hooks);
  H.noteRenderNodeAssetBase(null);
  await flush();
  release("old-session-ticket");
  await flush();
  assert.equal(late.filter(x => x.path.endsWith("/bind")).length, 1);
  assert.ok(!JSON.stringify(late).includes("old-session-ticket"));
  H.unbindRenderNode("SAME");
  await flush();
});

test("RNH-08 After leaving, a ticket round trip of the old connection must not hand back or overwrite the diagnostics", async () => {
  const replies = [];
  let release;
  H.setRenderNodeDeps({ post: async (path, body) => { replies.push({ path, body }); return { ok: true }; },
    setTimer: () => 0, clearTimer: () => {} });
  H.bindRenderNode({ ...B, projectId: "OLD-REPLY" }, { ticket: async () => new Promise(r => { release = r; }) });
  const before = H.renderNodeHandoffDiag().counters.tickets;
  const pending = H.answerRenderNodeTicket({ reqId: "late-request", projectId: "OLD-REPLY" });
  await flush();
  H.unbindRenderNode("OLD-REPLY");
  release("old-reply-ticket");
  await pending;
  await flush();
  assert.equal(replies.filter(x => x.path.endsWith("/ticket")).length, 0);
  assert.equal(H.renderNodeHandoffDiag().counters.tickets, before);
});
