/**
 * C6.6 第 4 节:页面这一侧的轮询(每 2 秒问当前素材服务的 `chunks`)、共享项目的素材服务、导出前的拦截。
 * 跑:node --test src/editor/media/assetTiers.test.mjs
 * `fetch` 换成假的:按地址回 `chunks`,记下问了哪些、带没带票据。
 */
import "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const T = await import("./assetTiers.ts");
const { TIERS_KNOWN_LOCAL, TIERS_KNOWN_REMOTE } = await import("../../render/mediaTier.ts");

const h = (c) => c.repeat(64);
const project = {
  media: [
    { id: "a", name: "开场.mov", url: `/@media/${h("1")}`, hash: h("1"), tiers: { original: h("1"), small: h("2") } },
    { id: "b", name: "结尾.mp4", url: `/@media/${h("3")}`, hash: h("3") },
    { id: "legacy", name: "老.mp4", url: "/api/media/file?path=x" },
  ],
  tracks: [{ id: "t", clips: [{ id: "x", mediaId: "a", start: 0, end: 5 }, { id: "y", mediaId: "b", start: 5, end: 6 }] }],
};

function fakeFetch(completeOn) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), auth: init.headers?.Authorization ?? null, method: init.method ?? "GET", body: init.body ?? null });
    const m = /\/media\/([0-9a-f]{64})\/chunks$/.exec(String(url));
    if (m) return new Response(JSON.stringify({ complete: completeOn(String(url), m[1]) }), { headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  };
  return calls;
}
const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; T.resetAssetTiersForTest(); });

test("T5-poll-1:只问还没到顶档的那一档:素材原尺寸到齐的素材不再问;迁移期的不问", () => {
  assert.deepEqual(T.hashesToAsk(project, new Set()), [h("1"), h("2"), h("3")]);
  assert.deepEqual(T.hashesToAsk(project, new Set([h("2")])), [h("1"), h("3")], "素材小尺寸到齐了只问素材原尺寸");
  assert.deepEqual(T.hashesToAsk(project, new Set([h("1"), h("3")])), [], "全到顶档就停");
});

test("T5-poll-2:连本地素材服务时问本机 /api/asset;问过之后集合带本地标记", async () => {
  const calls = fakeFetch((_u, hash) => hash === h("2"));
  assert.deepEqual(T.tierHashes(), [], "还没问过");
  await T.pollOnce(project);
  assert.ok(calls.every((c) => c.url.startsWith("/api/asset/media/")));
  assert.deepEqual(T.tierHashes(), [TIERS_KNOWN_LOCAL, h("2")]);
});

test("T5-poll-3:连远程素材服务时问远程、带票据;换素材服务时集合清空、标记换成远程", async () => {
  const calls = fakeFetch((url, hash) => url.startsWith("http://nas:5460") && hash !== h("3"));
  await T.pollOnce(project);
  assert.deepEqual(T.tierHashes(), [TIERS_KNOWN_LOCAL]);
  T.setRemoteAssets({ base: "http://nas:5460/api/asset/", ticket: async () => "tkt-r" });
  assert.deepEqual(T.tierHashes(), [], "换了素材服务:回到「还没问过」");
  await new Promise((r) => setTimeout(r, 10)); // 推给编辑器进程的那一下
  const pushed = calls.find((c) => c.url === "/api/media/remote" && c.method === "POST");
  assert.ok(pushed, "告诉本机编辑器进程(按需拉取与预取)");
  assert.deepEqual(JSON.parse(pushed.body), { base: "http://nas:5460/api/asset", ticket: "tkt-r" });
  calls.length = 0;
  await T.pollOnce(project);
  assert.ok(calls.length && calls.every((c) => c.url.startsWith("http://nas:5460/api/asset/media/") && c.auth === "Bearer tkt-r"));
  assert.deepEqual(T.tierHashes(), [TIERS_KNOWN_REMOTE, h("1"), h("2")]);
  // 到齐的不再问
  calls.length = 0;
  await T.pollOnce(project);
  assert.deepEqual(calls.map((c) => c.url.split("/media/")[1]), [`${h("3")}/chunks`]);
});

test("T5-poll-4:问不到(网络错)的算没到齐,不抛", async () => {
  globalThis.fetch = async () => { throw new Error("down"); };
  await T.pollOnce(project);
  assert.deepEqual(T.tierHashes(), [TIERS_KNOWN_LOCAL]);
});

test("T5-shared-1:从服务地址登记里挑素材服务:优先和文档服务同主机的,指向本页面自己的不算", () => {
  const eps = [
    { kind: "asset", urls: ["http://10.0.0.9:5460/api/asset"] },
    { kind: "asset", urls: ["http://192.168.1.5:5190/api/asset", "http://127.0.0.1:5190/api/asset"] },
  ];
  assert.equal(T.pickAssetEndpoint(eps, "http://192.168.1.5:5190/", "localhost:5190"), "http://192.168.1.5:5190/api/asset");
  assert.equal(T.pickAssetEndpoint(eps, "https://cloud.example/", "localhost:5190"), "http://10.0.0.9:5460/api/asset");
  assert.equal(T.pickAssetEndpoint([{ kind: "asset", urls: ["http://127.0.0.1:5190/api/asset"] }], "http://x/", "127.0.0.1:5190"), null, "本机就是主机");
  assert.equal(T.pickAssetEndpoint(null, "http://x/", "h"), null);
});

test("T5-shared-1b:在线浏览器模式认同源的素材服务(页面、文档服务、素材服务同在托管端一个源下,c10a)", () => {
  const eps = [{ kind: "asset", urls: ["https://203-0-113-16.sslip.io/media/api/asset"] }];
  const doc = "https://203-0-113-16.sslip.io/hosted/";
  assert.equal(T.pickAssetEndpoint(eps, doc, "203-0-113-16.sslip.io"), null, "桌面运行环境:同主机的算本机自己");
  assert.equal(T.pickAssetEndpoint(eps, doc, "203-0-113-16.sslip.io", { online: true }), "https://203-0-113-16.sslip.io/media/api/asset");
});

test("T5-shared-2:素材票据经文档服务连接取,剩 1/3 有效期才换新的", async () => {
  let now = 0, n = 0;
  const link = { request: async (msg) => { n++; assert.deepEqual(msg, { type: "auth.ticket", kind: "asset", access: "r" }); return { type: "auth.ticket.ok", ticket: `t${n}`, exp: now + 15 * 60_000 }; } };
  const ticket = T.assetTicketSource(link, () => now);
  assert.equal(await ticket(), "t1");
  now += 9 * 60_000;
  assert.equal(await ticket(), "t1", "还剩 6 分钟:不换");
  now += 2 * 60_000;
  assert.equal(await ticket(), "t2", "只剩 4 分钟(不到 1/3):换新的");
  const bad = T.assetTicketSource({ request: async () => ({ type: "error" }) });
  assert.equal(await bad(), null);
});

test("T5-shared-3:进共享项目 → 用 service.watch 里的素材服务;离开 → 回本地", async () => {
  fakeFetch(() => false);
  const link = { request: async (msg) => msg.type === "service.watch" ? { type: "service.endpoints", endpoints: [{ kind: "asset", urls: ["http://10.0.0.9:5460/api/asset"] }] } : { type: "auth.ticket.ok", ticket: "t", exp: Date.now() + 900000 } };
  assert.equal(await T.connectSharedAssets(link, "http://10.0.0.9:5460/"), "http://10.0.0.9:5460/api/asset");
  assert.equal(T.remoteAssetBase(), "http://10.0.0.9:5460/api/asset");
  T.disconnectSharedAssets();
  assert.equal(T.remoteAssetBase(), null);
});

test("T5-shared-4:在线页服务登记请求失败一次后重试，晚到的全量通知也能设地址", async () => {
  fakeFetch(() => false);
  const endpoint = { kind: "asset", urls: ["http://10.0.0.9:5460/api/asset"] };
  let calls = 0;
  const link = { request: async (msg) => {
    if (msg.type !== "service.watch") return { type: "auth.ticket.ok", ticket: "t", exp: Date.now() + 900000 };
    if (++calls === 1) throw new Error("暂时断线");
    return { type: "service.endpoints", endpoints: [endpoint] };
  } };
  try {
    assert.equal(await T.connectSharedAssets(link, "http://10.0.0.9:5460/", { online: true }), null);
    assert.equal(T.remoteAssetBase(), null);
    await new Promise((resolve, reject) => {
      const end = Date.now() + 3500;
      const check = () => T.remoteAssetBase() ? resolve() : Date.now() > end ? reject(new Error("没有重试服务登记")) : setTimeout(check, 20);
      check();
    });
    assert.equal(T.remoteAssetBase(), endpoint.urls[0]);
    T.receiveSharedAssetEndpoints([]);
    assert.equal(T.remoteAssetBase(), null);
    T.receiveSharedAssetEndpoints([endpoint]);
    assert.equal(T.remoteAssetBase(), endpoint.urls[0]);
  } finally {
    T.disconnectSharedAssets();
  }
});

test("T5-shared-5:同一条连接重连后重新登记失败,已挑好的素材服务不退回本地;挑到同一个不重设", async () => {
  fakeFetch(() => false);
  const endpoint = { kind: "asset", urls: ["http://10.0.0.9:5460/api/asset"] };
  let fail = false;
  let changes = 0;
  const link = { request: async (msg) => {
    if (msg.type !== "service.watch") return { type: "auth.ticket.ok", ticket: "t", exp: Date.now() + 900000 };
    if (fail) throw new Error("重连后第一次请求失败");
    return { type: "service.endpoints", endpoints: [endpoint] };
  } };
  const off = T.subscribeRemoteAssets(() => { changes++; });
  try {
    assert.equal(await T.connectSharedAssets(link, "http://10.0.0.9:5460/"), endpoint.urls[0]);
    const after = changes;
    fail = true;
    assert.equal(await T.connectSharedAssets(link, "http://10.0.0.9:5460/"), endpoint.urls[0]);
    assert.equal(T.remoteAssetBase(), endpoint.urls[0]);
    fail = false;
    assert.equal(await T.connectSharedAssets(link, "http://10.0.0.9:5460/"), endpoint.urls[0]);
    assert.equal(changes, after, "同一个素材服务不重设(不重发取档策略、不重启上传目标)");
  } finally {
    off();
    T.disconnectSharedAssets();
  }
});

test("M8-X1-a:放本机项目的素材服务后备地址:先用局域网发现通告的 asset,再按文档服务地址推同一进程的 /api/asset;放云端不推", () => {
  assert.equal(T.lanAssetBaseOf({ where: "lan", base: "http://192.168.1.5:5190/docservice/", asset: "http://192.168.1.5:5190/api/asset" }), "http://192.168.1.5:5190/api/asset");
  assert.equal(T.lanAssetBaseOf({ where: "lan", base: "http://192.168.1.5:5190/docservice/" }), "http://192.168.1.5:5190/api/asset", "手填地址 / 邀请链接没有通告:按文档服务地址推");
  assert.equal(T.lanAssetBaseOf({ where: "lan", base: "https://pc.lan:8443/docservice/" }), "https://pc.lan:8443/api/asset");
  assert.equal(T.lanAssetBaseOf({ where: "hosted", base: "https://203-0-113-16.sslip.io/hosted/" }), null, "放云端:只认托管组合登记的素材服务");
  assert.equal(T.lanAssetBaseOf({ where: "lan", base: "不是地址" }), null);
});

test("M8-X1-b:放本机的主机没登记素材服务时,成员页面用后备地址;有登记时登记优先;后备指向本页面自己时留在本地", async () => {
  fakeFetch(() => false);
  const mk = (endpoints) => ({ request: async (msg) => msg.type === "service.watch" ? { type: "service.endpoints", endpoints } : { type: "auth.ticket.ok", ticket: "t", exp: Date.now() + 900000 } });
  const doc = "http://192.168.1.5:5190/docservice/";
  const fallback = "http://192.168.1.5:5190/api/asset";
  try {
    assert.equal(await T.connectSharedAssets(mk([]), doc, { fallback }), fallback, "登记里没有:用后备");
    assert.equal(T.remoteAssetBase(), fallback);
    T.receiveSharedAssetEndpoints([]);
    assert.equal(T.remoteAssetBase(), fallback, "后续全量通知仍为空:不退回本地");
    T.disconnectSharedAssets();
    const registered = "http://192.168.1.5:5190/api/asset-registered";
    assert.equal(await T.connectSharedAssets(mk([{ kind: "asset", urls: [registered] }]), doc, { fallback }), registered, "登记优先");
    T.disconnectSharedAssets();
    globalThis.location = { host: "127.0.0.1:5190" };
    assert.equal(await T.connectSharedAssets(mk([]), "http://127.0.0.1:5190/docservice/", { fallback: "http://127.0.0.1:5190/api/asset" }), null, "本机就是主机:留在本地素材服务");
  } finally {
    delete globalThis.location;
    T.disconnectSharedAssets();
  }
});

test("T7-gate-2:导出前问当前素材服务:素材原尺寸没到齐的列出来(素材小尺寸到齐不算);都到齐了放行", async () => {
  fakeFetch((_u, hash) => hash === h("2") || hash === h("3"));
  const missing = await T.exportGate(project);
  assert.deepEqual(missing.map((m) => m.name), ["开场.mov"]);
  fakeFetch(() => true);
  assert.deepEqual(await T.exportGate(project), []);
});

test("T7-gate-3:不发请求的快速判断:还没问过给 null,问过就按集合判", async () => {
  assert.equal(T.exportGateNow(project), null);
  fakeFetch((_u, hash) => hash === h("3"));
  await T.pollOnce(project);
  assert.deepEqual(T.exportGateNow(project).map((m) => m.name), ["开场.mov"]);
});
