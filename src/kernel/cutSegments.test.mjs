/**
 * kernel/cutSegments.ts 与 cuts.ts 里剪辑段相关部分的单测。跑:npm test -- src/kernel/cutSegments.test.mjs
 *
 * 钉死:
 *   - 新项目 / 没有 cuts 的老文件只有「剪辑1」;带着 cuts 的项目原样不动;
 *   - 循环引用(自己、A→B→A、A→B→C→A)在放置时拒绝,原因说得清;
 *   - 悬空引用、协作合并造出来的环:渲染侧跳过,不抛;
 *   - 删被引用的剪辑:引用它的剪辑段连同转场一起删;
 *   - 渲染子项目、预卷、flattenOverlay 交出的剪辑段片段;
 *   - 声音那份派生项目:平移、裁窗、偏移、静音、音量、包络。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createEmptyProject, flattenOverlay, opacityAt } from "./project.ts";
import { normalizeCuts, listCuts, removeCut, placeCutSegment, addCut } from "./cuts.ts";
import {
  cutCycleReason, cutCycles, cutReferences, cutSubProject, cutSegmentRender, audioProjectOf, cutContent,
  stripCutReferences, setCutClipFrameMode, cutPreroll, CUT_SEGMENT_CARD, isCutSegment,
} from "./cutSegments.ts";

const track = (id, clips) => ({ id, name: id, clips });
const card = (id, start, end, extra = {}) => ({ id, cardId: "x", start, end, params: {}, ...extra });
const media = (id, start, end, extra = {}) => ({ id, cardId: "", mediaId: "m1", mediaOffset: 0, start, end, params: {}, ...extra });
const seg = (id, cutId, start, end, extra = {}) => ({ id, cardId: "", cutId, start, end, params: {}, ...extra });

/** 三条剪辑:A(激活)、B、C;内容按参数给 */
function proj({ a = [], b = [], c = [], bDur = 10, cDur = 10 } = {}) {
  const p = createEmptyProject("t");
  return {
    ...p,
    media: [{ id: "m1", kind: "audio", name: "m", url: "/m.wav", duration: 60 }],
    tracks: [track("ta", a)],
    duration: 20,
    cuts: [
      { id: "A", name: "剪辑A" },
      { id: "B", name: "剪辑B", tracks: [track("tb", b)], duration: bDur, transitions: [] },
      { id: "C", name: "剪辑C", tracks: [track("tc", c)], duration: cDur, transitions: [] },
    ],
    activeCutId: "A",
  };
}

test("新项目、没有 cuts 的老文件只有剪辑1;带 cuts 的原样", () => {
  const fresh = normalizeCuts(createEmptyProject());
  assert.deepEqual(fresh.cuts.map((c) => c.name), ["剪辑1"]);
  const old = proj();
  assert.equal(normalizeCuts(old).cuts.length, 3, "已有的三条不删");
});

test("循环引用:自己、直接、间接都拒绝,原因写明", () => {
  assert.match(cutCycleReason(proj(), "A", "A"), /放进它自己/);
  const ab = proj({ b: [seg("s1", "A", 0, 5)] });
  assert.match(cutCycleReason(ab, "A", "B"), /已经引用了「剪辑A」/);
  const abc = proj({ b: [seg("s1", "C", 0, 5)], c: [seg("s2", "A", 0, 5)] });
  assert.match(cutCycleReason(abc, "A", "B"), /间接引用了「剪辑A」/);
  assert.equal(cutCycleReason(proj({ b: [seg("s1", "C", 0, 5)] }), "A", "B"), null);
  assert.throws(() => placeCutSegment(ab, "B", 0), /循环引用/);
  assert.throws(() => placeCutSegment(proj(), "A", 0), /放进它自己/);
});

test("放置剪辑段:默认长度 = 被引用剪辑剩下的长度,不能超出;重叠拒绝", () => {
  const p = proj({ bDur: 8 });
  const r = placeCutSegment(p, "B", 2);
  assert.equal(r.clip.cutId, "B");
  assert.equal(r.clip.end - r.clip.start, 8);
  assert.equal(r.clip.cardId, "");
  const r2 = placeCutSegment(p, "B", 0, { offset: 3, duration: 100 });
  assert.equal(r2.clip.end - r2.clip.start, 5, "从第 3 秒起只剩 5 秒");
  assert.equal(r2.clip.cutOffset, 3);
  assert.throws(() => placeCutSegment(r.project, "C", 3), /已经有片段/);
  assert.throws(() => placeCutSegment(p, "Z", 0), /找不到剪辑/);
});

test("list_cuts 带引用关系", () => {
  const p = proj({ a: [seg("s1", "B", 0, 5)], c: [seg("s2", "B", 0, 5)] });
  const rows = listCuts(p);
  const b = rows.find((r) => r.id === "B");
  assert.deepEqual(b.referencedBy.map((r) => r.cutId).sort(), ["A", "C"]);
  assert.deepEqual(rows.find((r) => r.id === "A").references, ["B"]);
});

test("删被引用的剪辑:引用它的剪辑段与转场一起删,另一头的淡化擦掉", () => {
  const p = {
    ...proj({ a: [card("c1", 0, 4, { fadeOut: 1 }), seg("s1", "B", 3, 8, { fadeIn: 1 })], c: [seg("s2", "B", 0, 5)] }),
    transitions: [{ id: "x1", kind: "crossfade", aId: "c1", bId: "s1", dur: 1 }],
  };
  const r = removeCut(p, "B", 0);
  assert.deepEqual(r.removedSegments.map((x) => x.cutId).sort(), ["A", "C"]);
  assert.equal(r.project.cuts.length, 2);
  assert.deepEqual(r.project.tracks[0].clips.map((c) => c.id), ["c1"]);
  assert.equal(r.project.tracks[0].clips[0].fadeOut, 0, "转场另一头的淡出擦掉");
  assert.equal(r.project.transitions.length, 0);
  assert.equal(r.project.cuts.find((c) => c.id === "C").tracks[0].clips.length, 0);
  assert.throws(() => removeCut(normalizeCuts(createEmptyProject()), "cut-1", 0), /最后一条/);
});

test("悬空引用与成环:子项目为 null,flattenOverlay 跳过,不抛", () => {
  const dangling = proj({ a: [seg("s1", "Z", 0, 5)] });
  assert.equal(cutSubProject(dangling, "Z"), null);
  assert.equal(flattenOverlay(dangling).clips.length, 0);
  // 协作合并出来的环 B→C→B:从 A 渲 B,B 里的 C 里又指回 B,那一层跳过
  const loop = proj({ a: [seg("s1", "B", 0, 5)], b: [seg("s2", "C", 0, 5)], c: [seg("s3", "B", 0, 5)] });
  assert.deepEqual(cutCycles(loop).map((c) => c.sort()), [["B", "C"]]);
  const b = cutSubProject(loop, "B");
  const c = cutSubProject(b, "C");
  assert.ok(b && c);
  assert.equal(cutSubProject(c, "B"), null, "路径上已经有 B");
  assert.equal(flattenOverlay(c).clips.length, 0);
  // 指回根(激活剪辑)同样跳过
  const root = proj({ a: [seg("s1", "B", 0, 5)], b: [seg("s2", "A", 0, 5)] });
  assert.equal(cutSubProject(cutSubProject(root, "B"), "A"), null);
});

test("flattenOverlay 把剪辑段交成一张 @cut 卡,带子项目;子项目记忆化", () => {
  const p = proj({ a: [seg("s1", "B", 2, 7, { opacity: 0.5, frame: { x: 10, y: 20 } })], b: [card("b1", 0, 3)] });
  const tl = flattenOverlay(p);
  assert.equal(tl.clips.length, 1);
  const c = tl.clips[0];
  assert.equal(c.cardId, CUT_SEGMENT_CARD);
  assert.equal(c.start, 2);
  assert.equal(c.cut.offset, 0);
  assert.equal(c.cut.from, 2);
  assert.equal(c.cut.duration, 10);
  assert.equal(c.opacity, 0.5);
  assert.deepEqual(c.cut.project.tracks, p.cuts[1].tracks);
  assert.equal(c.cut.project.activeCutId, "B");
  // 同一份 cuts 再算一次,拿到同一个子项目对象(舞台的 memo 不白算)
  assert.equal(flattenOverlay({ ...p, tracks: [...p.tracks] }).clips[0].cut.project, c.cut.project);
});

test("预卷:偏移切进了要按历史推进的卡,时间轴片段起点提前到那张卡的起点", () => {
  setCutClipFrameMode((clip) => (clip.params?.direct ? "direct" : "stateful"));
  try {
    const p = proj({ a: [seg("s1", "B", 5, 9, { cutOffset: 3 })], b: [card("b1", 1, 6), card("b2", 4, 8)] });
    assert.equal(cutPreroll(p, p.tracks[0].clips[0]), 2, "b1 从 1 秒起,偏移 3 秒:预卷 2 秒");
    const c = flattenOverlay(p).clips[0];
    assert.equal(c.start, 3);
    assert.equal(c.cut.offset, 1);
    assert.equal(c.cut.from, 5);
    assert.equal(c.cut.frameMode, "stateful");
    // 贴着时间轴开头:预卷截到段起点
    const q = proj({ a: [seg("s1", "B", 1, 5, { cutOffset: 3 })], b: [card("b1", 0, 6)] });
    assert.equal(cutPreroll(q, q.tracks[0].clips[0]), 1);
    // 都是直接求值的卡:不预卷,口径 direct
    const d = proj({ a: [seg("s1", "B", 5, 9, { cutOffset: 3 })], b: [card("b1", 1, 6, { params: { direct: true } })] });
    assert.equal(cutPreroll(d, d.tracks[0].clips[0]), 0);
    assert.equal(flattenOverlay(d).clips[0].cut.frameMode, "direct");
  } finally {
    setCutClipFrameMode(null);
  }
});

test("声音派生项目:平移、裁到窗口、素材偏移跟着走、包络、音量、静音", () => {
  const p = proj({
    a: [seg("s1", "B", 10, 16, { cutOffset: 2, audioVolume: 0.5, fadeIn: 1 })],
    b: [media("v1", 0, 5, { fadeOut: 1 }), media("v2", 6, 9, { audioVolume: 0.8 })],
  });
  const q = audioProjectOf(p);
  assert.notEqual(q, p);
  assert.equal(audioProjectOf(p), q, "记忆化");
  const clips = q.tracks.flatMap((t) => t.clips).filter((c) => !isCutSegment(c));
  const v1 = clips.find((c) => c.cutOrigin?.clipId === "v1");
  const v2 = clips.find((c) => c.cutOrigin?.clipId === "v2");
  // 子时间 τ ↔ 父时间 τ + 8;v1 原本 0~5 → 8~13,裁到窗口 10~16 → 10~13,素材偏移 +2
  assert.deepEqual([v1.start, v1.end, v1.mediaOffset], [10, 13, 2]);
  assert.equal(v1.audioVolume, 0.5);
  assert.equal(v1.fadeOut, undefined, "自己的淡化挪进包络");
  // v2 原本 6~9 → 14~17,裁到 14~16
  assert.deepEqual([v2.start, v2.end], [14, 16]);
  assert.ok(Math.abs(v2.audioVolume - 0.4) < 1e-9);
  // 包络:段的淡入 1 秒(10~11)、v1 自己按原起止 8~13 的淡出 1 秒(12~13)
  assert.ok(Math.abs(opacityAt(v1, 10.5) - 0.5) < 1e-9);
  assert.ok(Math.abs(opacityAt(v1, 12.5) - 0.5) < 1e-9);
  assert.equal(opacityAt(v1, 11.5), 1);
  // 段静音 → 展开的都静音
  const m = audioProjectOf(proj({ a: [seg("s1", "B", 0, 5, { audioMuted: true })], b: [media("v1", 0, 5)] }));
  assert.ok(m.tracks.flatMap((t) => t.clips).filter((c) => c.cutOrigin).every((c) => c.audioMuted));
  // 被引用剪辑事后变短:窗口截到它的总时长
  const short = audioProjectOf(proj({ a: [seg("s1", "B", 0, 10)], b: [media("v1", 0, 10)], bDur: 4 }));
  const v = short.tracks.flatMap((t) => t.clips).find((c) => c.cutOrigin);
  assert.equal(v.end, 4);
  // 没有剪辑段:原样返回同一个对象
  const plain = proj({ a: [media("v1", 0, 5)] });
  assert.equal(audioProjectOf(plain), plain);
});

test("嵌套两层的声音:偏移逐层累加,id 带路径前缀", () => {
  const p = proj({
    a: [seg("s1", "B", 10, 20, { cutOffset: 1 })],
    b: [seg("s2", "C", 2, 8, { cutOffset: 3 })],
    c: [media("v1", 0, 10)],
  });
  const clips = audioProjectOf(p).tracks.flatMap((t) => t.clips).filter((c) => c.cutOrigin);
  assert.equal(clips.length, 1);
  const v = clips[0];
  // B 时间 τB ↔ 父 τB + 9;C 时间 τC ↔ B 时间 τC − 1(s2 起点 2、偏移 3)↔ 父 τC + 8
  // s2 在父上 11~17;v1 在 C 里 0~10 → 父 8~18,裁到 11~17,素材偏移 3
  assert.deepEqual([v.start, v.end, v.mediaOffset], [11, 17, 3]);
  assert.equal(v.id, "s1/s2/v1");
  assert.deepEqual(v.cutOrigin.segments, ["s1", "s2"]);
});

test("cutContent:激活的在 tracks 上,停放的在条目里", () => {
  const p = proj({ a: [card("a1", 0, 1)], b: [card("b1", 0, 1)] });
  assert.equal(cutContent(p, "A").tracks[0].clips[0].id, "a1");
  assert.equal(cutContent(p, "B").tracks[0].clips[0].id, "b1");
  assert.equal(cutContent(p, "nope"), null);
  assert.deepEqual(cutReferences(proj({ a: [seg("s", "B", 0, 1)] }), "B"), [{ cutId: "A", name: "剪辑A", clipIds: ["s"] }]);
  assert.equal(stripCutReferences(proj(), "B").tracks[0].clips.length, 0);
  const added = addCut(normalizeCuts(createEmptyProject())).project;
  assert.equal(added.cuts.length, 2);
});

test("导出混音清单:剪辑段展开后进 audioPlanOf,包络进 gainCurve", async () => {
  const { audioPlanOf, gainCurve, needsGainCurve, fadeEnvelope } = await import("./audioPlan.mjs");
  const p = proj({ a: [seg("s1", "B", 10, 14, { fadeIn: 2 })], b: [media("v1", 0, 4)] });
  const plan = audioPlanOf(p);
  assert.equal(plan.length, 1);
  const e = plan[0];
  assert.equal(e.clipId, "s1/v1");
  assert.deepEqual([e.start, e.dur, e.offset], [10, 4, 0]);
  assert.ok(needsGainCurve(e));
  const curve = gainCurve(e, 5); // 10, 11, 12, 13, 14
  assert.ok(Math.abs(curve[0]) < 1e-6 && Math.abs(curve[1] - 0.5) < 1e-6 && Math.abs(curve[2] - 1) < 1e-6);
  // 没有包络:和 fadeEnvelope 逐点一样
  const plainEntry = { volume: 0.7, fadeIn: 1, fadeOut: 1, dur: 3, start: 0 };
  assert.deepEqual([...gainCurve(plainEntry, 7)], [...fadeEnvelope(0.7, 1, 1, 3, 7)]);
  // 没有剪辑段的项目:清单和以前一样(没有 env 键)
  assert.equal("env" in audioPlanOf(proj({ a: [media("v1", 0, 4)] }))[0], false);
});
