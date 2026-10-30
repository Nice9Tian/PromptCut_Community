/**
 * 放云端的时序缺口(`docs/reports/AGENT-upload-timing.md`):打开共享项目后、编辑器进程拿到上传目标
 * (远程素材服务的地址与 rw 票据)之前导入的素材,编辑器进程的上传队列看到的是本机目标、当空操作丢掉。
 * 页面一侧先记下,上传目标就绪后按哈希补交给上传队列(与后台补上哈希后入队同一条路)。
 *
 *   UT-1  上传目标就绪之前导入的素材先记下,就绪后补交(图片、音频、视频都交,视频带两档)
 *   UT-2  上传目标已经就绪时导入的:当场按哈希交一次(服务端 prepareImport 入队与此重复无妨,队列按素材去重)
 *   UT-3  不是共享项目:什么都不做;就绪之前离开共享项目:记下的丢掉,不交给别的项目
 *   UT-4  本机就是主机(挑不到远程素材服务):不记;补交失败的留着,下一次就绪(续签)再交
 *   UT-5  补交时本机内容库里没有的(队列回 missing):列给用户
 *
 * 跑:node --test src/editor/io/uploadTiming.test.mjs
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { applyUploadedMedia, resetTierBackfillForTest, startTierBackfill } = await import(srcUrl("editor/io/mediaUpload.ts"));
const T = await import(srcUrl("editor/media/assetTiers.ts"));

const H = (c) => c.repeat(64);
const flush = () => new Promise((r) => setTimeout(r, 20));
const waitFor = async (cond, ms = 3000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); };

let realFetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  // 页面里这几个口子都打到编辑器进程;单测里一律 404,不让真的 fetch 出去
  globalThis.fetch = async () => new Response(null, { status: 404 });
  resetTierBackfillForTest();
  T.resetAssetTiersForTest();
});
afterEach(() => { globalThis.fetch = realFetch; resetTierBackfillForTest(); T.resetAssetTiersForTest(); });

/**
 * 可控的上传目标:`link.request` 签票据前先等 `release()`,模拟打开共享项目后签 rw 票据要一会儿。
 * 回 { stop, release, renew }:`renew()` 触发下一次续签(定时器拿在手里)。
 */
function slowUploadTarget(base = "http://cloud/api/asset") {
  let open;
  let gate = new Promise((r) => { open = r; });
  let pendingTimer = null;
  const link = { request: async () => { await gate; return { type: "auth.ticket.ok", ticket: "rw-1", exp: Date.now() + 15 * 60_000 }; } };
  const stop = T.startUploadTarget(link, base, {
    post: async () => {},
    setTimer: (fn) => { pendingTimer = fn; return 1; },
    clearTimer: () => { pendingTimer = null; },
  });
  return {
    stop,
    release: () => open(),
    renew: () => { const fn = pendingTimer; pendingTimer = null; fn?.(); },
    link,
  };
}

/** 页面导入完一条素材:addMedia(pending)→ 入库回包 → applyUploadedMedia(所有导入路径的汇合处) */
function importOne({ kind, name, hash, small }) {
  const m = actions.addMedia({ kind, name, url: "", pending: true });
  applyUploadedMedia(m.id, {
    hash, ext: name.split(".").pop(), name, url: `/@media/${hash}`, bytes: 10,
    ...(kind === "video" ? { tiers: { original: hash, small: small ?? null }, smallState: small ? "ready" : "none" } : {}),
  });
  return m.id;
}

function sharedHooks({ shared = () => true, respond = (body) => ({ queued: body.items.map((i) => i.original), missing: [] }) } = {}) {
  const bodies = [];
  const notified = [];
  const deps = {
    post: async (body) => { bodies.push(body); return respond(body); },
    shared,
    notify: (names) => notified.push(names),
  };
  const hooks = { shared, afterImport: (media) => T.queueImportedMedia(media, deps) };
  return { bodies, notified, deps, hooks };
}

test("UT-1 上传目标就绪之前导入的素材先记下,就绪后补交给上传队列(图片、音频、视频都交)", async () => {
  actions.newProject("云端项目");
  const target = slowUploadTarget();
  const { bodies, hooks } = sharedHooks();
  const stop = startTierBackfill(hooks);
  try {
    importOne({ kind: "image", name: "still.png", hash: H("1") });
    importOne({ kind: "audio", name: "voice.mp3", hash: H("2") });
    importOne({ kind: "video", name: "clip.mp4", hash: H("3"), small: H("4") });
    await flush();
    assert.equal(bodies.length, 0, "上传目标还没就绪:先不交(交了编辑器进程也会当本机目标丢掉)");
    target.release();
    await waitFor(() => bodies.length > 0);
    assert.equal(bodies.length, 1, "就绪后一次补交");
    assert.deepEqual(bodies[0], { items: [
      { name: "still.png", original: H("1") },
      { name: "voice.mp3", original: H("2") },
      { name: "clip.mp4", original: H("3"), small: H("4") },
    ] });
    // 续签再推一次上传目标:已经交过的不再交
    target.renew();
    await flush();
    assert.equal(bodies.length, 1);
  } finally { stop(); target.stop(); }
});

test("UT-2 上传目标已经就绪时导入的:当场按哈希交一次", async () => {
  actions.newProject("云端项目");
  const target = slowUploadTarget();
  target.release();
  await waitFor(() => T.uploadTargetReadyForTest() !== null);
  const { bodies, hooks } = sharedHooks();
  const stop = startTierBackfill(hooks);
  try {
    importOne({ kind: "audio", name: "late.mp3", hash: H("5") });
    await waitFor(() => bodies.length > 0);
    assert.deepEqual(bodies, [{ items: [{ name: "late.mp3", original: H("5") }] }]);
  } finally { stop(); target.stop(); }
});

test("UT-3 不是共享项目:什么都不做;就绪之前离开共享项目:记下的丢掉", async () => {
  actions.newProject("本机项目");
  {
    const { bodies, hooks } = sharedHooks({ shared: () => false });
    const stop = startTierBackfill(hooks);
    importOne({ kind: "image", name: "local.png", hash: H("6") });
    const target = slowUploadTarget();
    target.release();
    await waitFor(() => T.uploadTargetReadyForTest() !== null);
    await flush();
    assert.equal(bodies.length, 0, "本机项目的素材不交");
    stop(); target.stop();
  }
  T.resetAssetTiersForTest();
  {
    const target = slowUploadTarget();
    const { bodies, hooks } = sharedHooks();
    const stop = startTierBackfill(hooks);
    importOne({ kind: "image", name: "left-behind.png", hash: H("7") });
    // 离开共享项目(syncManager → disconnectSharedAssets):上传目标回到本机
    target.stop();
    T.disconnectSharedAssets();
    // 之后进了另一个共享项目、目标就绪:上一个项目里记下的不交过去
    const next = slowUploadTarget("http://other/api/asset");
    next.release();
    await waitFor(() => T.uploadTargetReadyForTest() !== null);
    await flush();
    assert.equal(bodies.length, 0, "离开前记下的丢掉");
    stop(); next.stop(); target.release();
  }
});

test("UT-4 本机就是主机:不记;补交失败的留着,下一次就绪(续签)再交", async () => {
  actions.newProject("云端项目");
  {
    // 本机就是主机:挑不到远程素材服务,startUploadTarget(link, null)
    const link = { request: async () => ({ type: "auth.ticket.ok", ticket: "rw", exp: Date.now() + 60_000 }) };
    const stopLocal = T.startUploadTarget(link, null, { post: async () => {} });
    const { bodies, hooks } = sharedHooks();
    const stop = startTierBackfill(hooks);
    importOne({ kind: "image", name: "host.png", hash: H("8") });
    assert.equal(T.deferredImportsForTest().length, 0, "本机就是主机:导入就是写进这个项目的素材服务,不用记");
    assert.equal(bodies.length, 0);
    stop(); stopLocal();
  }
  T.resetAssetTiersForTest();
  {
    const target = slowUploadTarget();
    let fail = true;
    const { bodies, hooks } = sharedHooks({ respond: (body) => (fail ? null : { queued: body.items.map((i) => i.original), missing: [] }) });
    const stop = startTierBackfill(hooks);
    importOne({ kind: "audio", name: "retry.mp3", hash: H("9") });
    target.release();
    await waitFor(() => bodies.length === 1);
    await flush();
    assert.deepEqual(T.deferredImportsForTest(), [H("9")], "补交没成(编辑器进程没回):留着");
    fail = false;
    target.renew();
    await waitFor(() => bodies.length === 2);
    await flush();
    assert.deepEqual(bodies[1], { items: [{ name: "retry.mp3", original: H("9") }] });
    assert.equal(T.deferredImportsForTest().length, 0);
    stop(); target.stop();
  }
});

test("UT-5 补交时本机内容库里没有的:列给用户", async () => {
  actions.newProject("云端项目");
  const target = slowUploadTarget();
  const { notified, hooks } = sharedHooks({ respond: () => ({ queued: [], missing: [H("a")] }) });
  const stop = startTierBackfill(hooks);
  try {
    importOne({ kind: "image", name: "gone.png", hash: H("a") });
    target.release();
    await waitFor(() => notified.length > 0);
    assert.deepEqual(notified, [["gone.png"]]);
  } finally { stop(); target.stop(); }
});
