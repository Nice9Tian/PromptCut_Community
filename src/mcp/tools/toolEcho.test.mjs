/**
 * 时间轴工具回显与删除门槛的单测。跑：node --test src/mcp/tools/toolEcho.test.mjs
 *
 * 钉住的是一份真实对话复盘里的三个失败形状（见 toolEcho.ts 头注释）：
 * 删自己刚建的卡、连删一串清空重铺、拿着已删的 clipId 继续操作。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createClipGuard, timelineDigest, lookHint } from "./toolEcho.ts";

test("A just-created card cannot be deleted directly: that is starting over, not cleaning up", () => {
  const g = createClipGuard();
  g.noteCreated("c1");
  assert.throws(() => g.checkRemove({ clipId: "c1" }), /update_clip/);
});

test("A just-created card is let through only with force + reason, and the reason is echoed back verbatim", () => {
  const g = createClipGuard();
  g.noteCreated("c1");
  assert.deepEqual(g.checkRemove({ clipId: "c1", force: true, reason: "The user asked to delete it" }), { reason: "The user asked to delete it" });
});

test("force without reason is not let through", () => {
  const g = createClipGuard();
  g.noteCreated("c1");
  assert.throws(() => g.checkRemove({ clipId: "c1", force: true }), /reason/);
  assert.throws(() => g.checkRemove({ clipId: "c1", force: true, reason: "   " }), /reason/);
});

test("A card created long ago (outside the window) can be deleted directly", () => {
  const g = createClipGuard({ freshWindow: 3 });
  g.noteCreated("c1");
  g.noteMutation();
  g.noteMutation();
  g.noteMutation();
  assert.deepEqual(g.checkRemove({ clipId: "c1" }), {});
});

test("A card not created by the agent itself (the user's original test content) can be deleted", () => {
  const g = createClipGuard();
  assert.deepEqual(g.checkRemove({ clipId: "old-1" }), {});
});

test("Stop at the Nth consecutive deletion: this is the shape of round 2 deleting everything and rebuilding", () => {
  const g = createClipGuard({ deleteStreakMax: 3 });
  for (const id of ["a", "b", "c"]) {
    g.checkRemove({ clipId: id });
    g.noteRemoved(id);
  }
  assert.throws(() => g.checkRemove({ clipId: "d" }), /3 cards have been deleted in a row/);
  // 中间做了别的改动就重新计数
  g.noteMutation();
  assert.deepEqual(g.checkRemove({ clipId: "d" }), {});
});

test("After deleting, re-creating the same id counts as newly created", () => {
  const g = createClipGuard({ freshWindow: 2 });
  g.noteCreated("x");
  g.noteMutation();
  g.noteMutation();
  g.checkRemove({ clipId: "x" });
  g.noteRemoved("x");
  g.noteCreated("x");
  assert.throws(() => g.checkRemove({ clipId: "x" }), /just created by you with add_clip/);
});

test("timelineDigest carries only id / card or asset / start and end, without params, and seconds keep two decimals", () => {
  const d = timelineDigest({
    version: 1, name: "p", width: 1, height: 1, fps: 30, duration: 10, media: [],
    tracks: [
      { id: "t1", name: "Captions", clips: [{ id: "c1", cardId: "caption-track", start: 0, end: 13.7333, params: { lines: "Very very long" } }] },
      { id: "v1", name: "Video", clips: [{ id: "m1", mediaId: "med", start: 0, end: 13.7333 }] },
    ],
  });
  assert.deepEqual(d.tracks, [
    { trackId: "t1", name: "Captions", clips: [{ id: "c1", cardId: "caption-track", start: 0, end: 13.73 }] },
    { trackId: "v1", name: "Video", clips: [{ id: "m1", mediaId: "med", start: 0, end: 13.73 }] },
  ]);
  assert.equal(JSON.stringify(d).includes("params"), false);
});

/*
 * 项目时长和内容实际结束的位置**一起回显**。
 *
 * 时长缺省跟着内容走,两者平时相等;duration 比 contentEnd 小是被截断了
 * (kernel/duration.ts)。回显只照实报两个数,不互相推。
 */
test("timelineDigest carries the project duration and the actual end position of the content", () => {
  const p = (duration, tracks) => timelineDigest({
    version: 1, name: "p", width: 1, height: 1, fps: 30, duration, media: [], tracks,
  });

  // 两个数各报各的,不拿一个去推另一个
  const shrunk = p(30, [{ id: "t1", name: "s", clips: [{ id: "c1", cardId: "x", start: 0, end: 12, params: {} }] }]);
  assert.equal(shrunk.duration, 30);
  assert.equal(shrunk.contentEnd, 12);

  // 截断:duration 比内容末尾短
  const overflow = p(30, [{ id: "t1", name: "s", clips: [{ id: "c1", cardId: "x", start: 0, end: 42.5, params: {} }] }]);
  assert.equal(overflow.contentEnd, 42.5);

  // 跨轨道取最大值,不是只看第一条
  const multi = p(60, [
    { id: "t1", name: "a", clips: [{ id: "c1", cardId: "x", start: 0, end: 5, params: {} }] },
    { id: "t2", name: "b", clips: [{ id: "c2", cardId: "y", start: 5, end: 18.666, params: {} }] },
  ]);
  assert.equal(multi.contentEnd, 18.67, "Keeps two decimals, same as the start and end of a clip");

  // 空时间轴是 0,不是 -Infinity(Math.max 空数组的坑)
  assert.equal(p(30, []).contentEnd, 0);
  assert.equal(p(30, [{ id: "t1", name: "empty", clips: [] }]).contentEnd, 0);
});

test("lookHint is a ready-made see_frames call", () => {
  const h = lookHint("c9");
  assert.equal(h.tool, "see_frames");
  assert.deepEqual(h.args, { source: "timeline", clipId: "c9" });
  assert.match(h.why, /actual frame/);
});
