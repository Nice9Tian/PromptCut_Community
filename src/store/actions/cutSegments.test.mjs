/**
 * 剪辑段在 store 里的编辑规则:放置、修头带偏移、出点不能超出被引用剪辑、切分累加偏移、复制、独立静音、
 * 删除被引用剪辑一步撤销。跑:npm test -- src/store/actions/cutSegments.test.mjs
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { actions, getState } = await import(srcUrl("store/project.ts"));

function load() {
  const p = {
    version: 1, id: "p-test", name: "t", width: 1280, height: 720, fps: 30, duration: 20, themeId: "midnight", media: [],
    tracks: [{ id: "ta", name: "序列 1", clips: [] }, { id: "ta2", name: "序列 2", clips: [] }],
    cuts: [
      { id: "A", name: "剪辑A" },
      { id: "B", name: "剪辑B", tracks: [{ id: "tb", name: "序列 1", clips: [{ id: "b1", cardId: "", mediaId: "m", start: 0, end: 8, params: {} }] }], duration: 8, transitions: [] },
    ],
    activeCutId: "A",
  };
  actions.loadProject(p);
}
const seg = () => getState().project.tracks.flatMap((t) => t.clips).find((c) => c.cutId);

test("放置:默认长度 = 被引用剪辑总长;循环引用拒绝", () => {
  load();
  const c = actions.addCutSegment("B", 2, { trackId: "ta" });
  assert.deepEqual([c.start, c.end, c.cutId, c.cardId], [2, 10, "B", ""]);
  assert.throws(() => actions.addCutSegment("A", 0, { trackId: "ta2" }), /放进它自己/);
  assert.equal(actions.cutCycleReason("A"), "不能把剪辑「剪辑A」放进它自己");
});

test("修头:偏移跟着走,不能往前越过被引用剪辑开头;出点不能超出剩下的长度", () => {
  load();
  const c = actions.addCutSegment("B", 2, { trackId: "ta" });
  actions.moveClip(c.id, { start: 3, end: c.end });
  assert.deepEqual([seg().start, seg().end, seg().cutOffset], [3, 10, 1]);
  actions.moveClip(c.id, { start: 0.5, end: 10 });
  assert.deepEqual([seg().start, seg().cutOffset ?? 0], [2, 0], "往前拉不能越过被引用剪辑的开头");
  actions.moveClip(c.id, { start: 2, end: 15 });
  assert.equal(seg().end, 10, "出点不能超出被引用剪辑的总长");
  actions.moveClip(c.id, { start: 5, end: 13 });
  assert.deepEqual([seg().start, seg().end, seg().cutOffset ?? 0], [5, 13, 0], "整段平移不动偏移");
});

test("切分:后半段偏移累加;复制带着引用;独立静音", () => {
  load();
  const c = actions.addCutSegment("B", 2, { trackId: "ta" });
  const right = actions.splitClip(c.id, 5);
  assert.equal(right.cutOffset, 3);
  assert.equal(right.mediaOffset, undefined);
  const dup = actions.duplicateClip(right.id);
  assert.equal(dup.cutId, "B");
  assert.equal(dup.cutOffset, 3);
  const r = actions.setClipMuted(c.id, true);
  assert.equal(r.ok, true);
  assert.equal(getState().project.tracks[0].clips.find((x) => x.id === c.id).audioMuted, true);
});

test("删被引用的剪辑:连同剪辑段一起删,一步撤销全回来", () => {
  load();
  actions.addCutSegment("B", 2, { trackId: "ta" });
  const { removedSegments } = actions.removeCut("B");
  assert.equal(removedSegments.length, 1);
  assert.equal(seg(), undefined);
  assert.equal(getState().project.cuts.length, 1);
  actions.undo();
  assert.equal(getState().project.cuts.length, 2);
  assert.ok(seg(), "剪辑段回来了");
});
