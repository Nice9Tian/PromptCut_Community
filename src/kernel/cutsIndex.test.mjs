/**
 * 停放剪辑的片段索引(`agentScopes.mjs` 末尾的 `parkedCutsIndex` / `otherCutsHint`):Agent 先读的 get_project / list_cuts / 工具回包用它把别的剪辑里的 clipId 摆出来,
 * 模型不必为了「看进」剪辑2 而 switch_cut(线上 2026-10-21 两次尝试两次 switch_cut -> update_clip -> switch_cut)。
 * 跑:node --test src/kernel/cutsIndex.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parkedCutsIndex, otherCutsHint, CUTS_INDEX_LIMITS, PARKED_EDIT_NOTE } from "./agentScopes.mjs";

const clip = (id, start, end, extra = {}) => ({ id, cardId: "particles", start, end, params: { count: 50 }, ...extra });
const proj = (over = {}) => ({
  tracks: [{ id: "ta", name: "A序列", clips: [clip("a1", 0, 5)] }],
  duration: 5,
  cuts: [
    { id: "cutA", name: "剪辑1" },
    { id: "cutB", name: "剪辑2", duration: 8, tracks: [
      { id: "tb1", name: "B序列1", clips: [clip("b1", 0, 4, { label: "粒子背景" }), { id: "bm", cardId: "", mediaId: "m1", start: 4.123, end: 8 }] },
      { id: "tb2", name: "B序列2", clips: [{ id: "bs", cardId: "", cutId: "cutA", start: 0, end: 3 }] },
    ] },
    { id: "cutC", name: "剪辑3", tracks: [] },
  ],
  activeCutId: "cutA",
  ...over,
});

test("只有一条剪辑(或没有 cuts)时没有索引、没有提示", () => {
  assert.equal(parkedCutsIndex({ tracks: [], cuts: [{ id: "x", name: "剪辑1" }], activeCutId: "x" }), null);
  assert.equal(parkedCutsIndex({ tracks: [] }), null);
  assert.equal(otherCutsHint({ tracks: [], cuts: [{ id: "x", name: "剪辑1" }], activeCutId: "x" }), null);
});

test("索引只列没激活的剪辑;片段带 id / trackId / 卡或素材或被引用剪辑 / 标签 / 起止", () => {
  const idx = parkedCutsIndex(proj());
  assert.equal(idx.activeCutId, "cutA");
  assert.deepEqual(idx.cuts.map((c) => c.cutId), ["cutB", "cutC"], "激活的 cutA 不在里面");
  const b = idx.cuts[0];
  assert.deepEqual([b.name, b.duration, b.trackCount, b.clipCount], ["剪辑2", 8, 2, 3]);
  assert.deepEqual(b.clips, [
    { id: "b1", trackId: "tb1", cardId: "particles", label: "粒子背景", start: 0, end: 4 },
    { id: "bm", trackId: "tb1", mediaId: "m1", start: 4.12, end: 8 },
    { id: "bs", trackId: "tb2", cutSegmentOf: "cutA", start: 0, end: 3 },
  ]);
  assert.equal("params" in b.clips[0], false, "不带 params,省 token");
  assert.deepEqual(idx.cuts[1].clips, [], "空剪辑也列出来,clips 为空");
  assert.equal(idx.cuts[1].duration, 30, "缺 duration 的停放剪辑用兜底 30");
  assert.match(idx.note, /不用 user_interface_switch_cut/);
  assert.match(idx.note, /see_frames 传 cutId/);
  assert.equal(idx.note, PARKED_EDIT_NOTE);
});

test("激活的是 cutB 时,列的是 cutA 和 cutC(以 activeCutId 为准,缺省退到第一条)", () => {
  const idx = parkedCutsIndex(proj({ activeCutId: "cutB" }));
  assert.deepEqual(idx.cuts.map((c) => c.cutId), ["cutA", "cutC"]);
  const idx2 = parkedCutsIndex(proj({ activeCutId: "不存在" }));
  assert.equal(idx2.activeCutId, "cutA");
});

test("cardName:有注册表的一侧可以多带卡片显示名;长标签截断", () => {
  const p = proj();
  p.cuts[1].tracks[0].clips[0].label = "一".repeat(40);
  const idx = parkedCutsIndex(p, { cardName: (id) => (id === "particles" ? "粒子" : undefined) });
  assert.equal(idx.cuts[0].clips[0].cardName, "粒子");
  assert.equal(idx.cuts[0].clips[0].label, `${"一".repeat(CUTS_INDEX_LIMITS.labelMax)}…`);
  assert.equal("cardName" in idx.cuts[0].clips[1], false, "素材段没有 cardName");
});

test("有上限:每条剪辑和总量都封顶,超出的给计数并指路 list_cuts({ cutId })", () => {
  const many = (n, prefix) => Array.from({ length: n }, (_, i) => clip(`${prefix}${i}`, i, i + 1));
  const p = proj();
  p.cuts[1].tracks = [{ id: "tb1", name: "x", clips: many(100, "b") }];
  p.cuts[2].tracks = [{ id: "tc1", name: "y", clips: many(100, "c") }];
  const idx = parkedCutsIndex(p);
  const [b, c] = idx.cuts;
  assert.equal(b.clips.length, CUTS_INDEX_LIMITS.perCutMax);
  assert.equal(b.clipCount, 100);
  assert.equal(b.omitted, 100 - CUTS_INDEX_LIMITS.perCutMax);
  assert.match(b.more, /list_cuts\(\{ cutId: "cutB" \}\)/);
  assert.equal(c.clips.length, CUTS_INDEX_LIMITS.maxClips - CUTS_INDEX_LIMITS.perCutMax, "总量用完后剩下的名额");
  assert.equal(b.clips.length + c.clips.length, CUTS_INDEX_LIMITS.maxClips);
  assert.equal(c.omitted, 100 - c.clips.length);
  const tiny = parkedCutsIndex(p, { maxClips: 2, perCutMax: 5 });
  assert.equal(tiny.cuts[0].clips.length, 2);
  assert.equal(tiny.cuts[1].clips.length, 0);
  assert.ok(JSON.stringify(idx).length < 20000, "输出大小有界");
});

test("坏数据不抛:停放条目没 tracks、序列没 clips", () => {
  const p = proj();
  p.cuts[1].tracks = [{ id: "t", name: "t" }, null].filter(Boolean);
  p.cuts.push({ id: "cutD", name: "坏", tracks: "x" });
  const idx = parkedCutsIndex(p);
  assert.equal(idx.cuts.find((c) => c.cutId === "cutD").clipCount, 0);
});

test("otherCutsHint:只列有内容的别的剪辑的计数,不列片段;没有有内容的别的剪辑时为 null", () => {
  const h = otherCutsHint(proj());
  assert.deepEqual(h.cuts, [{ cutId: "cutB", name: "剪辑2", clipCount: 3 }]);
  assert.match(h.hint, /不用 user_interface_switch_cut/);
  assert.match(h.hint, /parkedCuts/);
  const empty = proj();
  empty.cuts[1].tracks = [];
  assert.equal(otherCutsHint(empty), null);
});
