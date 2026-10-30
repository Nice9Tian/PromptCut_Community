/**
 * 开启「放云端」时页面把项目里已有的素材交给上传队列(C10a 集成返工,`assetTiers.ts` 的 `enqueueExistingMedia`)。
 * 跑:node --test src/editor/media/enqueueExisting.test.mjs
 */
import "../../testing/registerTs.mjs";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

const T = await import("./assetTiers.ts");
const h = (c) => c.repeat(64);
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
beforeEach(() => T.resetAssetTiersForTest());

test("EQE-1 请求体:一个素材一项,视频两档、图片音频一档;没有哈希的不算;同一素材原尺寸只列一次", () => {
  const { items } = T.existingMediaItems([
    { name: "v.mp4", hash: h("a"), tiers: { original: h("a"), small: h("b") } },
    { name: "i.png", hash: h("c") },
    { name: "s.m4a", hash: h("d"), tiers: { original: h("d") } },
    { name: "old.mp4", hash: "" },
    { name: "dup.mp4", hash: h("a"), tiers: { original: h("a"), small: h("b") } },
  ]);
  assert.deepEqual(items, [
    { name: "v.mp4", original: h("a"), small: h("b") },
    { name: "i.png", original: h("c") },
    { name: "s.m4a", original: h("d") },
  ]);
});

test("EQE-2 等编辑器进程拿到带 rw 票据的上传目标之后才入队", async () => {
  const bodies = [];
  const link = { request: async () => ({ type: "auth.ticket.ok", ticket: "rw-1", exp: Date.now() + 15 * 60_000 }) };
  const pending = T.enqueueExistingMedia([{ name: "v", hash: h("a"), tiers: { original: h("a"), small: h("b") } }], {
    post: async (b) => { bodies.push(b); return { queued: [h("a")], missing: [] }; },
    timeoutMs: 5_000,
  });
  await flush();
  assert.equal(bodies.length, 0, "上传目标还没设好:不发");
  const targets = [];
  const stop = T.startUploadTarget(link, "http://h/api/asset", { post: async (b) => { targets.push(b); }, setTimer: () => 0, clearTimer: () => {} });
  const r = await pending;
  assert.deepEqual(targets, [{ base: "http://h/api/asset", ticket: "rw-1" }]);
  assert.deepEqual(bodies, [{ items: [{ name: "v", original: h("a"), small: h("b") }] }]);
  assert.deepEqual(r, { queued: [h("a")], missing: [], skipped: [] });
  stop();
});

test("EQE-3 等不到上传目标(签不到 rw 票据)就不入队,回 null;没有素材直接回空", async () => {
  const bodies = [];
  const link = { request: async () => ({ type: "error", reason: "forbidden" }) };
  const stop = T.startUploadTarget(link, "http://h/api/asset", { post: async () => {}, setTimer: () => 0, clearTimer: () => {} });
  const r = await T.enqueueExistingMedia([{ hash: h("a") }], { post: async (b) => { bodies.push(b); return null; }, timeoutMs: 50 });
  assert.equal(r, null);
  assert.equal(bodies.length, 0);
  assert.deepEqual(await T.enqueueExistingMedia([], { post: async () => null, timeoutMs: 50 }), { queued: [], missing: [], skipped: [] });
  assert.equal(await T.enqueueExistingMedia([{ hash: h("a") }], { post: null }), null, "没有入队的口子(在线构建):不做");
  stop();
});

test("EQE-4 守门:没有哈希的素材不许悄悄跳过——出现在 skipped 里(还在导入的标 pending),入队结果也带着它们", async () => {
  const media = [
    { id: "v", name: "v.mp4", hash: h("a") },
    { id: "old", name: "voice-old.mp3", hash: "" },
    { id: "bad", name: "bad.mp3", hash: "xyz" },
    { id: "up", name: "uploading.mp3", pending: true },
  ];
  const { items, skipped } = T.existingMediaItems(media);
  assert.deepEqual(items, [{ name: "v.mp4", original: h("a") }]);
  assert.deepEqual(skipped, [
    { id: "old", name: "voice-old.mp3" },
    { id: "bad", name: "bad.mp3" },
    { id: "up", name: "uploading.mp3", pending: true },
  ]);
  // 只有没哈希的:不等上传目标,直接回空队列 + skipped
  const onlyOld = await T.enqueueExistingMedia([media[1]], { post: async () => { throw new Error("不该发"); }, timeoutMs: 50 });
  assert.deepEqual(onlyOld, { queued: [], missing: [], skipped: [{ id: "old", name: "voice-old.mp3" }] });
  // 有可入队的:发完之后结果里照样带 skipped
  const link = { request: async () => ({ type: "auth.ticket.ok", ticket: "rw-1", exp: Date.now() + 15 * 60_000 }) };
  const stop = T.startUploadTarget(link, "http://h/api/asset", { post: async () => {}, setTimer: () => 0, clearTimer: () => {} });
  const r = await T.enqueueExistingMedia(media, { post: async () => ({ queued: [h("a")], missing: [] }), timeoutMs: 5_000 });
  assert.deepEqual(r.skipped.map((x) => x.id), ["old", "bad", "up"]);
  stop();
});
