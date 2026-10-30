/**
 * 时间轴工具回显与删除门槛的单测。跑：node --test src/mcp/tools/toolEcho.test.mjs
 *
 * 钉住的是一份真实对话复盘里的三个失败形状（见 toolEcho.ts 头注释）：
 * 删自己刚建的卡、连删一串清空重铺、拿着已删的 clipId 继续操作。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createClipGuard, timelineDigest, lookHint } from "./toolEcho.ts";

test("刚建的卡不让直接删：那是推倒重来，不是清理", () => {
  const g = createClipGuard();
  g.noteCreated("c1");
  assert.throws(() => g.checkRemove({ clipId: "c1" }), /update_clip/);
});

test("刚建的卡带 force + reason 才放行，理由原样回显", () => {
  const g = createClipGuard();
  g.noteCreated("c1");
  assert.deepEqual(g.checkRemove({ clipId: "c1", force: true, reason: "用户要求删掉" }), { reason: "用户要求删掉" });
});

test("force 不带 reason 不放行", () => {
  const g = createClipGuard();
  g.noteCreated("c1");
  assert.throws(() => g.checkRemove({ clipId: "c1", force: true }), /reason/);
  assert.throws(() => g.checkRemove({ clipId: "c1", force: true, reason: "   " }), /reason/);
});

test("建了很久的卡（窗口之外）可以直接删", () => {
  const g = createClipGuard({ freshWindow: 3 });
  g.noteCreated("c1");
  g.noteMutation();
  g.noteMutation();
  g.noteMutation();
  assert.deepEqual(g.checkRemove({ clipId: "c1" }), {});
});

test("不是自己建的卡（用户原有的测试内容）可以删", () => {
  const g = createClipGuard();
  assert.deepEqual(g.checkRemove({ clipId: "old-1" }), {});
});

test("连删到第 N 张要停：这就是第 2 轮删光重建的形状", () => {
  const g = createClipGuard({ deleteStreakMax: 3 });
  for (const id of ["a", "b", "c"]) {
    g.checkRemove({ clipId: id });
    g.noteRemoved(id);
  }
  assert.throws(() => g.checkRemove({ clipId: "d" }), /连续删了 3 张/);
  // 中间做了别的改动就重新计数
  g.noteMutation();
  assert.deepEqual(g.checkRemove({ clipId: "d" }), {});
});

test("删掉之后再建同名 id，按新建的算", () => {
  const g = createClipGuard({ freshWindow: 2 });
  g.noteCreated("x");
  g.noteMutation();
  g.noteMutation();
  g.checkRemove({ clipId: "x" });
  g.noteRemoved("x");
  g.noteCreated("x");
  assert.throws(() => g.checkRemove({ clipId: "x" }), /刚用 add_clip 建的/);
});

test("timelineDigest 只带 id/卡或素材/起止，不带 params，秒数保留两位", () => {
  const d = timelineDigest({
    version: 1, name: "p", width: 1, height: 1, fps: 30, duration: 10, media: [],
    tracks: [
      { id: "t1", name: "字幕", clips: [{ id: "c1", cardId: "caption-track", start: 0, end: 13.7333, params: { lines: "很长很长" } }] },
      { id: "v1", name: "视频", clips: [{ id: "m1", mediaId: "med", start: 0, end: 13.7333 }] },
    ],
  });
  assert.deepEqual(d.tracks, [
    { trackId: "t1", name: "字幕", clips: [{ id: "c1", cardId: "caption-track", start: 0, end: 13.73 }] },
    { trackId: "v1", name: "视频", clips: [{ id: "m1", mediaId: "med", start: 0, end: 13.73 }] },
  ]);
  assert.equal(JSON.stringify(d).includes("params"), false);
});

/*
 * 项目时长和内容实际结束的位置**一起回显**。
 *
 * 时长缺省跟着内容走,两者平时相等;duration 比 contentEnd 小是被截断了
 * (kernel/duration.ts)。回显只照实报两个数,不互相推。
 */
test("timelineDigest 带上项目时长和内容实际的结束位置", () => {
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
  assert.equal(multi.contentEnd, 18.67, "和 clip 的起止一样保留两位");

  // 空时间轴是 0,不是 -Infinity(Math.max 空数组的坑)
  assert.equal(p(30, []).contentEnd, 0);
  assert.equal(p(30, [{ id: "t1", name: "空", clips: [] }]).contentEnd, 0);
});

test("lookHint 是一个现成的 see_frames 调用", () => {
  const h = lookHint("c9");
  assert.equal(h.tool, "see_frames");
  assert.deepEqual(h.args, { source: "timeline", clipId: "c9" });
  assert.match(h.why, /真实画面/);
});
