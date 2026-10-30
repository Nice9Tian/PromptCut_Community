/**
 * 共享项目里导入的素材要传到文档服务(C6.6 T9 暴露的缺陷)。跑:node --test src/editor/io/mediaSharedSync.test.mjs
 *
 * 钉的是:store 接在 docsync 上时,入库回包写回素材表(hash / url / ext / size / tiers、清掉 pending)
 * 以及素材小尺寸后到时补写 tiers.small,都要变成 project.op 传到文档服务,另一个页面会话(观察端)看得到;
 * 并且不许原地改 store 里的旧对象(docsync 的本地副本与 store 是同一份,原地改了 diffProject 就看不出变化)。
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { MemDocService } from "../../testing/memDocService.mjs";

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { DocSync, bindStore } = await import(srcUrl("store/docsync.ts"));
const { applyUploadedMedia, backfillSmallTiers } = await import(srcUrl("editor/io/mediaUpload.ts"));

const ORIG = "c".repeat(64);
const SMALL = "d".repeat(64);
const ORIG2 = "e".repeat(64);
const SMALL2 = "f".repeat(64);

/** 创建方 A 接 store,观察方 B 只是另一个 DocSync;回 { svc, A, B, unbind } */
function share(name) {
  actions.newProject(name);
  const p0 = getState().project;
  const svc = new MemDocService({ project: structuredClone(p0), rev: 1 });
  let linkA;
  const A = new DocSync(p0, { projectId: "P", session: "A", send: (m) => linkA.send(m) });
  linkA = svc.connect("A", (m) => A.receive(m));
  const unbind = bindStore(A);
  A.connect();
  let linkB;
  const B = new DocSync(structuredClone(p0), { projectId: "P", session: "B", send: (m) => linkB.send(m) });
  linkB = svc.connect("B", (m) => B.receive(m));
  B.connect();
  svc.drain();
  return { svc, A, B, unbind };
}

const mediaOf = (project, id) => project.media.find((x) => x.id === id);

async function waitFor(pred, ms = 8000) {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
}

test("共享项目:入库回包与后到的素材小尺寸都传到文档服务,观察端看得到;store 里的旧对象不被原地改", async () => {
  const { svc, B, unbind } = share("共享导入");
  const realFetch = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = async (url) => {
    assert.match(String(url), new RegExp(`^/api/media/tiers\\?hashes=${ORIG}$`));
    asked++;
    const item = asked < 2 ? { state: "pending" } : { state: "ready", small: SMALL };
    return new Response(JSON.stringify({ ok: true, items: { [ORIG]: item } }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    const m = actions.addMedia({ kind: "video", name: "clip.mp4", url: "", pending: true });
    svc.drain();
    assert.equal(mediaOf(B.project, m.id)?.pending, true);

    const before = mediaOf(getState().project, m.id);
    const listBefore = getState().project.media;
    applyUploadedMedia(m.id, {
      hash: ORIG, ext: "mp4", name: "clip.mp4", path: "C:/lib/clip.mp4", url: `/@media/${ORIG}`, bytes: 123,
      tiers: { original: ORIG, small: null }, smallState: "pending",
    });
    // 旧对象、旧数组原样不动
    assert.equal(before.pending, true);
    assert.equal(before.hash, undefined);
    assert.equal(before.tiers, undefined);
    assert.equal(listBefore.find((x) => x.id === m.id), before);

    svc.drain();
    for (const [where, project] of [["文档服务", svc.project], ["观察端", B.project]]) {
      const got = mediaOf(project, m.id);
      assert.equal(got.hash, ORIG, `${where} hash`);
      assert.equal(got.url, `/@media/${ORIG}`, `${where} url`);
      assert.equal(got.ext, "mp4", `${where} ext`);
      assert.equal(got.size, 123, `${where} size`);
      assert.equal(got.path, "C:/lib/clip.mp4", `${where} path`);
      assert.deepEqual(got.tiers, { original: ORIG }, `${where} tiers`);
      assert.equal(got.pending, undefined, `${where} pending`);
    }

    // 素材小尺寸后到(watchSmallTier 每 2 s 问一次)
    const beforeSmall = mediaOf(getState().project, m.id);
    await waitFor(() => !!mediaOf(getState().project, m.id)?.tiers?.small);
    assert.deepEqual(beforeSmall.tiers, { original: ORIG }, "素材小尺寸补写不原地改旧对象");
    svc.drain();
    assert.deepEqual(mediaOf(svc.project, m.id).tiers, { original: ORIG, small: SMALL });
    assert.deepEqual(mediaOf(B.project, m.id).tiers, { original: ORIG, small: SMALL });
    assert.equal(JSON.stringify(B.project), JSON.stringify(svc.project));
  } finally {
    globalThis.fetch = realFetch;
    unbind();
  }
});

test("共享项目:入库失败时 pending 清掉也传到文档服务", () => {
  const { svc, B, unbind } = share("共享失败");
  try {
    const m = actions.addMedia({ kind: "video", name: "bad.mp4", url: "", pending: true });
    svc.drain();
    applyUploadedMedia(m.id, null);
    svc.drain();
    assert.equal(mediaOf(B.project, m.id).pending, undefined);
    assert.equal(mediaOf(svc.project, m.id).pending, undefined);
  } finally {
    unbind();
  }
});

test("共享项目:打开项目时补转的素材小尺寸(backfill 回 ready)也传到文档服务", async () => {
  const { svc, B, unbind } = share("共享补转");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "/api/media/tiers/backfill");
    const body = JSON.parse(init.body);
    assert.deepEqual(body.items.map((x) => x.hash), [ORIG2]);
    return new Response(JSON.stringify({ ok: true, items: { [ORIG2]: { state: "ready", small: SMALL2 } } }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    const m = actions.addMedia({ kind: "video", name: "old.mp4", url: `/@media/${ORIG2}`, hash: ORIG2, tiers: { original: ORIG2 } });
    svc.drain();
    const before = mediaOf(getState().project, m.id);
    assert.equal(await backfillSmallTiers(), 1);
    assert.deepEqual(before.tiers, { original: ORIG2 }, "不原地改旧对象");
    svc.drain();
    assert.deepEqual(mediaOf(svc.project, m.id).tiers, { original: ORIG2, small: SMALL2 });
    assert.deepEqual(mediaOf(B.project, m.id).tiers, { original: ORIG2, small: SMALL2 });
  } finally {
    globalThis.fetch = realFetch;
    unbind();
  }
});
