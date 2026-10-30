/**
 * kernel/cuts.ts 的单测。跑:node --test src/kernel/cuts.test.mjs
 *
 * 多剪辑的模型只有一条不变量:**每条剪辑的内容只存一份** —— 激活的在 Project.tracks,
 * 停放的在各自条目里。切换、删除、老文件加载都不能把内容弄丢或弄成两份。钉死:
 *   - 老文件(没有 cuts)加载后:tracks 原样是「剪辑1」,只此一条(2026-10-20 用户定:默认只留一个);
 *   - 切换是 round-trip:A→B→A 后 tracks / duration / 播放头逐项相同;
 *   - 激活条目永远不带 tracks;
 *   - 删最后一条拒绝;删激活那条自动切到相邻;
 *   - 删素材要清到停放的剪辑里。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createEmptyProject } from "./project.ts";
import {
  normalizeCuts, listCuts, switchCut, addCut, renameCut, removeCut, nextCutName, resolveCut,
  stripMediaFromCuts,
} from "./cuts.ts";

const clip = (id, extra = {}) => ({ id, cardId: "x", start: 0, end: 1, params: {}, ...extra });
const legacy = () => ({ ...createEmptyProject("老项目"), tracks: [{ id: "t-1", name: "序列 1", clips: [clip("a")] }], duration: 12 });
const empty = (id) => [{ id: `${id}-1`, name: "序列 1", clips: [] }, { id: `${id}-2`, name: "序列 2", clips: [] }];
/** 0.7.18 之前新建的项目:默认三条剪辑已经存在 cuts 里(加载时原样保留) */
const three = () => ({
  ...legacy(),
  cuts: [
    { id: "cut-1", name: "剪辑1" },
    { id: "cut-2", name: "剪辑2", tracks: empty("t2"), duration: 30, transitions: [] },
    { id: "cut-3", name: "剪辑3", tracks: empty("t3"), duration: 30, transitions: [] },
  ],
  activeCutId: "cut-1",
});

test("老文件加载:当前 tracks 就是剪辑1,只此一条,激活条目不带 tracks", () => {
  const p = normalizeCuts(legacy());
  assert.equal(p.cuts.length, 1);
  assert.deepEqual(p.cuts.map((c) => c.name), ["剪辑1"]);
  assert.equal(p.activeCutId, "cut-1");
  assert.equal(p.cuts[0].tracks, undefined);
  assert.equal(p.tracks[0].clips[0].id, "a");
  assert.equal(p.duration, 12);
});

test("已经带着三条剪辑的项目:原样保留,一条不删", () => {
  const p = normalizeCuts(three());
  assert.deepEqual(p.cuts.map((c) => c.name), ["剪辑1", "剪辑2", "剪辑3"]);
  assert.equal(p.cuts[1].tracks.length, 2);
  assert.equal(p.cuts[1].duration, 30);
});

test("normalizeCuts 幂等", () => {
  const once = normalizeCuts(three());
  assert.deepEqual(normalizeCuts(once), once);
});

test("新项目经 loadProject 的规范化后只有剪辑1", () => {
  const p = normalizeCuts(createEmptyProject("新"));
  assert.equal(listCuts(p).length, 1);
  assert.equal(listCuts(p)[0].name, "剪辑1");
  assert.equal(listCuts(p)[0].active, true);
  assert.deepEqual(p.tracks.map((t) => t.name), ["序列 1", "序列 2"], "剪辑1 的内容就是 createEmptyProject 给的两条序列");
});

test("listCuts:激活那条的计数来自 Project.tracks", () => {
  const l = listCuts(three());
  assert.deepEqual(l[0], { id: "cut-1", name: "剪辑1", active: true, trackCount: 1, clipCount: 1, duration: 12, referencedBy: [], references: [] });
  assert.equal(l[1].clipCount, 0);
});

test("切换 round-trip:A→B→A 内容和播放头都回来", () => {
  const p0 = normalizeCuts(three());
  const s1 = switchCut(p0, "cut-2", 7.5);
  assert.equal(s1.project.activeCutId, "cut-2");
  assert.equal(s1.t, 0, "剪辑2 没看过,播放头从 0 起");
  assert.equal(s1.project.tracks.length, 2, "换进来的是剪辑2 的两条空序列");
  assert.equal(s1.project.duration, 30);
  const parked = s1.project.cuts.find((c) => c.id === "cut-1");
  assert.equal(parked.tracks[0].clips[0].id, "a", "剪辑1 的内容停放在它的条目里");
  assert.equal(parked.t, 7.5);
  assert.equal(s1.project.cuts.find((c) => c.id === "cut-2").tracks, undefined, "激活条目不带 tracks");

  const s2 = switchCut(s1.project, "cut-1", 3);
  assert.equal(s2.t, 7.5, "切回来接着上次的播放头");
  assert.deepEqual(s2.project.tracks, p0.tracks);
  assert.equal(s2.project.duration, 12);
});

test("切到当前这条:原样", () => {
  const p = normalizeCuts(three());
  assert.deepEqual(switchCut(p, "cut-1", 2), { project: p, t: 2 });
});

test("addCut:默认名按 剪辑N 递增,停放不切换", () => {
  const p = normalizeCuts(three());
  const a = addCut(p);
  assert.equal(a.cut.name, "剪辑4");
  assert.equal(a.project.activeCutId, "cut-1");
  assert.equal(a.project.cuts.length, 4);
  assert.equal(a.cut.tracks.length, 2);
  const b = addCut(a.project, "  片头  ");
  assert.equal(b.cut.name, "片头");
  assert.equal(nextCutName(b.project.cuts), "剪辑5");
});

test("renameCut:去空白,空名拒", () => {
  const p = renameCut(normalizeCuts(three()), "cut-2", " 花絮 ");
  assert.equal(p.cuts[1].name, "花絮");
  assert.throws(() => renameCut(p, "cut-2", "  "), /不能为空/);
  assert.throws(() => renameCut(p, "nope", "x"), /找不到剪辑/);
});

test("resolveCut:按 id 或名字,找不到时列出现有的", () => {
  const p = normalizeCuts(three());
  assert.equal(resolveCut(p, { name: "剪辑2" }).id, "cut-2");
  assert.equal(resolveCut(p, { cutId: "cut-3" }).name, "剪辑3");
  assert.throws(() => resolveCut(p, { name: "剪辑9" }), /剪辑1\(cut-1\)/);
});

test("removeCut:删停放的直接删;删激活的先切到左邻;最后一条拒", () => {
  const p = normalizeCuts(three());
  const r1 = removeCut(p, "cut-3", 1);
  assert.equal(r1.switchedTo, null);
  assert.equal(r1.project.cuts.length, 2);

  const s = switchCut(r1.project, "cut-2", 4);
  const r2 = removeCut(s.project, "cut-2", 9);
  assert.equal(r2.switchedTo, "cut-1");
  assert.equal(r2.project.activeCutId, "cut-1");
  assert.equal(r2.project.tracks[0].clips[0].id, "a", "切回剪辑1,内容还在");
  assert.equal(r2.t, 4, "剪辑1 上次离开时的播放头");
  assert.equal(r2.project.cuts.length, 1);

  assert.throws(() => removeCut(r2.project, "cut-1", 0), /最后一条/);
});

test("stripMediaFromCuts:停放剪辑里引用该素材的段也清掉", () => {
  const p = normalizeCuts(three());
  p.cuts[1].tracks[0].clips.push({ id: "m1", mediaId: "vid", start: 0, end: 2, params: {} }, clip("keep"));
  const q = stripMediaFromCuts(p, "vid");
  assert.deepEqual(q.cuts[1].tracks[0].clips.map((c) => c.id), ["keep"]);
});
