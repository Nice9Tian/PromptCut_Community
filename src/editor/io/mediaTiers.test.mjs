/**
 * C6.6 两档素材在页面这一侧(`mediaUpload.ts`):项目里只记 `tiers` 两个哈希,不记同步状态(验收 T1 / T2 的项目那一半)。
 * 跑:node --test src/editor/io/mediaTiers.test.mjs
 *
 * 服务端(导入、素材小尺寸、上传队列)在 server/test/media-tiers.test.mjs;这里只钉页面把回包写进项目的方式,以及 `.proc` 里的样子。
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { applyUploadedMedia } = await import(srcUrl("editor/io/mediaUpload.ts"));
const { serializeProc } = await import(srcUrl("editor/io/proc.ts"));

const ORIG = "a".repeat(64);
const SMALL = "b".repeat(64);
const SYNC_WORDS = /upload|sync|complete|received|progress|queued|pending/i;

/** 素材记录里不许有任何同步状态字段(`pending` 是会话内的入库占位,入库后清掉,也一并查) */
function assertNoSyncFields(obj, where) {
  const walk = (value, trail) => {
    if (!value || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue; // 已清掉的会话内占位(pending = undefined),不进 JSON
      assert.doesNotMatch(k, SYNC_WORDS, `${where}: ${trail}${k}`);
      walk(v, `${trail}${k}.`);
    }
  };
  walk(obj, "");
}

test("T2-page The import response is written into the project: tiers has only two hashes, original / small; when the small-size asset arrives later, small is filled in; the project and .proc contain no sync fields", async () => {
  actions.newProject("Two tiers");
  const m = actions.addMedia({ kind: "video", name: "clip.mp4", url: "", pending: true });
  const realFetch = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = async (url) => {
    assert.match(String(url), new RegExp(`^/api/media/tiers\\?hashes=${ORIG}$`));
    asked++;
    const item = asked < 2 ? { state: "pending" } : { state: "ready", small: SMALL };
    return new Response(JSON.stringify({ ok: true, items: { [ORIG]: item } }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    applyUploadedMedia(m.id, {
      hash: ORIG, ext: "mp4", name: "clip.mp4", url: `/@media/${ORIG}`, bytes: 123,
      tiers: { original: ORIG, small: null }, smallState: "pending",
    });
    let media = getState().project.media.find((x) => x.id === m.id);
    assert.deepEqual(media.tiers, { original: ORIG });
    assert.equal(media.hash, ORIG);
    assert.equal(media.pending, undefined);
    // 每 2 s 问一次:第一次 pending,第二次 ready
    const t0 = Date.now();
    while (!getState().project.media.find((x) => x.id === m.id)?.tiers?.small && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
    media = getState().project.media.find((x) => x.id === m.id);
    assert.deepEqual(media.tiers, { original: ORIG, small: SMALL });
    assert.equal(asked, 2);
    assertNoSyncFields(media, "project.media");
    const proc = JSON.parse(serializeProc());
    const saved = proc.project.media.find((x) => x.id === m.id);
    assert.deepEqual(saved.tiers, { original: ORIG, small: SMALL });
    assertNoSyncFields(saved, ".proc project.media");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("T1-page Not a video (the response has no tiers): do not write tiers, do not ask about the small-size asset", () => {
  actions.newProject("Images");
  const m = actions.addMedia({ kind: "image", name: "a.png", url: "", pending: true });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Should not have asked about the small-size asset"); };
  try {
    applyUploadedMedia(m.id, { hash: SMALL, ext: "png", name: "a.png", url: `/@media/${SMALL}`, bytes: 10 });
    const media = getState().project.media.find((x) => x.id === m.id);
    assert.equal(media.tiers, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});
