/**
 * C6.6 设计稿第 9 节第 2 条的页面一侧:打开项目时,缺 `tiers.small` 的视频请编辑器进程补转,好了补写 `tiers.small`。
 * 跑:node --test src/editor/io/tierBackfill.test.mjs
 * `fetch` 换成假的编辑器进程:`/api/media/tiers/backfill` 与 `/api/media/tiers`。
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { backfillSmallTiers, resetTierBackfillForTest, startTierBackfill } = await import(srcUrl("editor/io/mediaUpload.ts"));

const H = (c) => c.repeat(64);

test("C66-I2-03 打开项目:缺小尺寸的视频请求补转(本地没有原尺寸的不转);ready 当场写 tiers.small,pending 盯到好了再写;同一会话不重复问", async () => {
  resetTierBackfillForTest();
  actions.newProject("补转");
  const a = actions.addMedia({ kind: "video", name: "a.mp4", url: `/@media/${H("1")}`, hash: H("1") });
  const b = actions.addMedia({ kind: "video", name: "b.mov", url: `/@media/${H("2")}`, hash: H("2"), tiers: { original: H("2") } });
  const c = actions.addMedia({ kind: "video", name: "c.mp4", url: `/@media/${H("3")}`, hash: H("3") });
  actions.addMedia({ kind: "video", name: "done.mp4", url: `/@media/${H("4")}`, hash: H("4"), tiers: { original: H("4"), small: H("5") } });
  actions.addMedia({ kind: "image", name: "pic.png", url: `/@media/${H("6")}`, hash: H("6") });
  actions.addMedia({ kind: "video", name: "legacy.mp4", url: "/api/media/file?path=x" });
  const realFetch = globalThis.fetch;
  const calls = [];
  let polls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
    let body;
    if (u === "/api/media/tiers/backfill") {
      body = { ok: true, items: { [H("1")]: { state: "ready", small: H("a") }, [H("2")]: { state: "pending" }, [H("3")]: { state: "absent" } } };
    } else if (u === `/api/media/tiers?hashes=${H("2")}`) {
      polls++;
      body = { ok: true, items: { [H("2")]: polls < 2 ? { state: "pending" } : { state: "ready", small: H("b") } } };
    } else {
      throw new Error(`没料到的请求 ${u}`);
    }
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  };
  try {
    assert.equal(await backfillSmallTiers(), 3);
    const asked = calls.find((x) => x.url === "/api/media/tiers/backfill").body.items.map((i) => i.hash);
    assert.deepEqual(asked, [H("1"), H("2"), H("3")], "只问缺小尺寸、带哈希的视频;已有小尺寸、图片、没有哈希的老素材不问");
    const get = (id) => getState().project.media.find((m) => m.id === id);
    assert.deepEqual(get(a.id).tiers, { original: H("1"), small: H("a") }, "ready:当场写 tiers(老素材没有 tiers 的补上 original)");
    assert.equal(get(c.id).tiers, undefined, "absent:本地没有原尺寸,不写");
    const t0 = Date.now();
    while (!get(b.id).tiers?.small && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(get(b.id).tiers, { original: H("2"), small: H("b") }, "pending:每 2 s 问一次,好了再写");
    const n = calls.length;
    assert.equal(await backfillSmallTiers(), 0, "同一会话里问过的不再问");
    assert.equal(calls.length, n);
  } finally {
    globalThis.fetch = realFetch;
    resetTierBackfillForTest();
  }
});

test("C66-I2-04 没有本机编辑器(请求失败):什么都不写,下次还会再问", async () => {
  resetTierBackfillForTest();
  actions.newProject("补转-离线");
  const a = actions.addMedia({ kind: "video", name: "a.mp4", url: `/@media/${H("7")}`, hash: H("7") });
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => { n++; throw new TypeError("fetch failed"); };
  try {
    assert.equal(await backfillSmallTiers(), 0);
    assert.equal(getState().project.media.find((m) => m.id === a.id).tiers, undefined);
    await backfillSmallTiers();
    assert.equal(n, 2, "失败的不记成问过");
  } finally {
    globalThis.fetch = realFetch;
    resetTierBackfillForTest();
  }
});

test("打开项目后在后台补入库:没有哈希、地址为 /api/media/file?path=… 的老配音经 adopt 补上哈希;补不上的同一会话里后台不再试", async () => {
  resetTierBackfillForTest();
  actions.newProject("后台补入库");
  const ok = actions.addMedia({ kind: "audio", name: "voice-ok.mp3", url: `/api/media/file?path=${encodeURIComponent("C:/m/voice-ok.mp3")}` });
  const gone = actions.addMedia({ kind: "audio", name: "voice-gone.mp3", url: `/api/media/file?path=${encodeURIComponent("C:/m/voice-gone.mp3")}` });
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("/api/media/adopt")) {
      const p = new URL(u, "http://x").searchParams.get("path");
      asked.push(p);
      if (p.endsWith("voice-ok.mp3")) return Response.json({ ok: true, hash: H("9"), ext: "mp3", name: "voice-ok.mp3", path: "C:/store/x.mp3", url: `/@media/${H("9")}`, bytes: 10 });
      return new Response("ENOENT", { status: 500 });
    }
    return new Response(null, { status: 404 });
  };
  const stop = startTierBackfill();
  try {
    const get = (id) => getState().project.media.find((m) => m.id === id);
    const t0 = Date.now();
    while (!get(ok.id).hash && Date.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 50));
    assert.equal(get(ok.id).hash, H("9"));
    assert.equal(get(ok.id).url, `/@media/${H("9")}`);
    assert.equal(get(gone.id).hash, undefined);
    // 补上哈希写回素材表会再触发一轮(1.5 s 后);补不上的那条后台不再去 adopt
    const goneTries = () => asked.filter((p) => p.endsWith("voice-gone.mp3")).length;
    const before = goneTries();
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal(goneTries(), before, "后台补不上的,同一会话里不反复试");
  } finally {
    stop();
    globalThis.fetch = realFetch;
    resetTierBackfillForTest();
  }
});
