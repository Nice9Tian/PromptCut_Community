/**
 * 桌面应用自动成为共享项目的渲染节点:页面一侧(`renderNodeHandoff.ts`)。报告 `docs/archive/agent-reports/AGENT-desktop-auto-node.md`。
 * 跑:node --test src/editor/sync/renderNodeHandoff.test.mjs
 *
 *   RNH-01 接上共享项目:等本页面挑到素材服务再交(带素材基址与本页面签的 render 票据);同一个项目重复接不再交
 *   RNH-05 挑不到素材服务:最多等 ASSET_WAIT_MS 就不带基址照交;在等的时候离开照样撤
 *   RNH-02 项目文档 id 晚到、素材基址挑到:同一个项目再交一次,不另签票据
 *   RNH-03 票据往返:只答本页面连着的那个项目;签不出就交回错误
 *   RNH-04 离开:只撤同一个项目的;撤完再有票据请求不答
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
const hooks = { ticket: async (projectId) => { if (refuse) throw new Error("本页面没有连着这个共享项目"); signed++; return `v1.t${signed}-${projectId}.s`; } };
const B = { url: "wss://site.example/hosted/", projectId: "P1", contentId: "doc-1" };

test("RNH-01 接上共享项目:等挑到素材服务再交,带基址与票据;重复接不再交", async () => {
  H.bindRenderNode(B, hooks);
  await flush();
  assert.equal(posts.length, 0, "还在等本页面挑素材服务");
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
  assert.ok(!JSON.stringify(H.renderNodeHandoffDiag()).includes("v1.t1"), "诊断里不带票据");
});

test("RNH-02 文档 id 晚到、素材基址挑到:再交一次,不另签票据", async () => {
  const before = signed;
  H.bindRenderNode({ ...B, contentId: "doc-2" }, hooks);
  await flush();
  assert.deepEqual(posts.at(-1).body, { url: B.url, projectId: "P1", contentId: "doc-2", assetBase: "https://site.example/media/api/asset" });
  H.noteRenderNodeAssetBase("https://other.example/api/asset");
  await flush();
  assert.deepEqual(posts.at(-1).body, { url: B.url, projectId: "P1", contentId: "doc-2", assetBase: "https://other.example/api/asset" });
  const n = posts.length;
  H.noteRenderNodeAssetBase("https://other.example/api/asset");
  H.noteRenderNodeAssetBase(null); // 本机当主机:不交(预渲染进程推本机的)
  await flush();
  assert.equal(posts.length, n);
  assert.equal(signed, before, "没有另签票据");
});

test("RNH-03 票据往返:只答本页面连着的项目", async () => {
  const n = posts.length;
  await H.answerRenderNodeTicket({ type: "ticket", reqId: "rn1", projectId: "OTHER" });
  assert.equal(posts.length, n, "别的项目不答");
  await H.answerRenderNodeTicket({ type: "ticket", reqId: "rn2", projectId: "P1" });
  assert.deepEqual(posts.at(-1), { path: "/api/render-node/ticket", body: { reqId: "rn2", ticket: `v1.t${signed}-P1.s` } });
  refuse = true;
  await H.answerRenderNodeTicket({ type: "ticket", reqId: "rn3", projectId: "P1" });
  assert.deepEqual(posts.at(-1), { path: "/api/render-node/ticket", body: { reqId: "rn3", error: "本页面没有连着这个共享项目" } });
  refuse = false;
});

test("RNH-04 离开:只撤同一个项目的", async () => {
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
  assert.equal(posts.length, m, "撤完不再答票据、不重复撤");
  // 再接别的项目:重新签票据交接
  H.bindRenderNode({ url: "ws://192.168.1.5:5190/docservice", projectId: "P2", contentId: "doc-9" }, hooks);
  H.noteRenderNodeAssetBase(null); // 局域网主机没登记素材服务:照交,不带基址(预渲染进程按登记或本机挑)
  await flush();
  assert.equal(posts.at(-1).path, "/api/render-node/bind");
  assert.equal("assetBase" in posts.at(-1).body, false);
  assert.equal(posts.at(-1).body.projectId, "P2");
  assert.match(posts.at(-1).body.ticket, /-P2\.s$/);
});

test("RNH-05 挑不到素材服务:等满就照交;等的时候离开照样撤", async () => {
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
  // 在等的时候离开
  H.bindRenderNode({ url: B.url, projectId: "P4", contentId: "doc-4" }, hooks);
  const t4 = timers.at(-1);
  H.unbindRenderNode("P4");
  await flush();
  assert.equal(t4.cleared, true);
  assert.deepEqual(posts.at(-1), { path: "/api/render-node/unbind", body: { projectId: "P4", reason: "page-left" } });
});

test("RNH-06 已发出的旧绑定延迟完成，离开与新房间必须最后生效", async () => {
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
  assert.equal(backend, "NEW", "旧 HTTP 不能晚到后把节点绑回旧房间");
  assert.deepEqual(started.map(x => [x.path.split("/").at(-1), x.body.projectId]), [
    ["bind", "SLOW"], ["unbind", "SLOW"], ["bind", "NEW"],
  ]);
  H.unbindRenderNode("NEW");
  await flush();
  assert.equal(backend, null);
});

test("RNH-07 旧房间签票据期间离开并重入同房间，旧票据不能交给新连接", async () => {
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

test("RNH-08 旧连接的票据往返离开后不能交回或覆盖诊断", async () => {
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
