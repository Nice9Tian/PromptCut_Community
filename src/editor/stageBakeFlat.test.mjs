/**
 * 浏览器替剪辑段里的卡产流(〔裁〕R02):生成快照的活(`stageBake.ts`)给剪辑段里的卡(摊平出来的虚拟片段)灌带着剪辑段链的隔离工程、
 * 每一帧的请求带 `frameBase`(本地帧 0 是项目的第几帧);顶层的卡照旧(隔离单卡工程、不带 `frameBase`)。不起浏览器,舞台是假的。
 *
 *   QM-FLAT-01 剪辑段里的卡:灌的工程顶层只有剪辑段、被引用剪辑里只有目标卡(时间不平移);请求带 frameBase = 卡的第一帧
 *   QM-FLAT-02 顶层的卡:灌的是隔离单卡工程,请求不带 frameBase(与原来逐字相同)
 *
 * 跑:npm test -- src/editor/stageBakeFlat.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { createStageBaker } = await import("./stageBake.ts");

const PROJECT = {
  id: "p", fps: 30, duration: 10, width: 1280, height: 720, activeCutId: "A",
  tracks: [
    { id: "t1", clips: [{ id: "top", cardId: "punch-pill", start: 0, end: 4, params: { text: "top" } }] },
    { id: "t2", clips: [{ id: "S", cardId: "", cutId: "B", start: 1, end: 5, cutOffset: 0.5, params: {}, frame: { x: 0, y: 0, w: 640, h: 360 } }] },
  ],
  cuts: [
    { id: "A", name: "主" },
    { id: "B", name: "里", duration: 8, tracks: [
      { id: "b1", clips: [{ id: "m", cardId: "punch-pill", start: 0, end: 8, params: { text: "m" }, opacity: 0.5 }] },
      { id: "b2", clips: [{ id: "n", cardId: "caption-track", start: 0, end: 8, params: {} }] },
    ] },
  ],
};

function harness() {
  const pushed = [], requests = [];
  let listener = null;
  const stage = {
    async bakeFrame(req) {
      requests.push(req);
      const ev = { type: "bake-frame", session: req.session, clipId: req.clipId, localFrame: req.localFrame, hash: `h${req.localFrame}`, bytes: 1 };
      listener?.(ev);
      return { ok: true, localFrame: req.localFrame, hash: `h${req.localFrame}`, bytes: 1, small: null, ms: 1, pausedMs: 0, remounted: false, smallMs: 0, readyMs: 0 };
    },
    async bakeCancel() { return { ok: true }; },
  };
  const baker = createStageBaker({
    runBackJob: async (_kind, run) => run({ stage, signal: new AbortController().signal }),
    backStage: () => stage,
    pushProject: async (_role, project) => { pushed.push(project); },
    onStageEvent: (l) => { listener = l; return () => { listener = null; }; },
    onUrgent: () => {}, isIdle: () => false, mode: "seq", small: false,
  });
  return { baker, pushed, requests };
}
const taskOf = (clipId, bake) => ({ id: `stream:k:${clipId}`, kind: "stream", range: { unit: "segment", from: 0, to: 0 }, input: { clipId, bake } });

test("QM-FLAT-01 剪辑段里的卡:灌带剪辑段链的隔离工程,请求带 frameBase", async () => {
  const { baker, pushed, requests } = harness();
  const task = taskOf("S~m", { start: 1, end: 5, count: 120, sampling: { firstFrame: 30, phase: { numerator: "0", denominator: "1" } } });
  const signal = new AbortController().signal;
  await baker.bakeFrame({ task, project: PROJECT, localFrame: 0, signal, ahead: null });
  await baker.bakeFrame({ task, project: PROJECT, localFrame: 5, signal, ahead: null });
  baker.close();
  assert.equal(pushed.length, 1, "同一段只灌一次");
  const iso = pushed[0];
  assert.deepEqual(iso.tracks.filter((t) => !t.hidden).flatMap((t) => t.clips).map((c) => [c.id, c.start]), [["S", 1]], "顶层只有剪辑段,时间不平移");
  const inner = iso.cuts.find((c) => c.id === "B").tracks.filter((t) => !t.hidden).flatMap((t) => t.clips);
  assert.deepEqual(inner.map((c) => c.id), ["m"], "被引用剪辑里只有目标卡");
  assert.equal(inner[0].opacity, undefined, "目标卡自己的外观拿掉(由舞台上它的包裹层加)");
  assert.deepEqual(requests.map((r) => [r.clipId, r.localFrame, r.frameBase]), [["S~m", 0, 30], ["S~m", 5, 30]]);
});

test("QM-FLAT-02 顶层的卡:隔离单卡工程,请求不带 frameBase", async () => {
  const { baker, pushed, requests } = harness();
  const task = taskOf("top", { start: 0, end: 4, count: 120, sampling: { firstFrame: 0, phase: { numerator: "0", denominator: "1" } } });
  await baker.bakeFrame({ task, project: PROJECT, localFrame: 3, signal: new AbortController().signal, ahead: null });
  baker.close();
  assert.deepEqual(pushed[0].tracks.filter((t) => !t.hidden).flatMap((t) => t.clips).map((c) => c.id), ["top"]);
  assert.equal(requests.length, 1);
  assert.equal("frameBase" in requests[0], false, "顶层的卡请求里没有 frameBase");
});
