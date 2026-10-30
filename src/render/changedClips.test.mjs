import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  changedClips, applyProjectPatch, isEmptyPatch, projectHash, hashStats, resetHashStats, TOP_FIELDS,
} from "./changedClips.mjs";

/**
 * 两层 diff 与三级哈希缓存(A7)。
 *
 * 这份测试盯的是三件事,少一件镜像就会悄悄错:
 *
 * 1. **补丁能表达每一种改动**(轨道增删改序、`hidden` / `muted`、片段增删改),
 *    而且 `applyProjectPatch` 应用完之后 `projectHash` 和页面手里那份**逐字相等** ——
 *    这是服务端唯一能发现「diff 自己写错了」的地方。
 * 2. **没动过的对象保持同一个引用**:镜像按版本号留 8 份,共享引用是它不吃内存的原因,
 *    也是下一轮 diff 还能按引用比出来的前提。
 * 3. **缓存真的命中**:拖一个片段只重算 1 个片段 + 1 条轨道。退化成整份重算的话,
 *    17 轨 × 10 段的项目每推一次要几十毫秒,拖动就卡了。
 */

let seq = 0;
const clip = (id, over = {}) => ({ id, start: 0, end: 1, kind: "card", cardId: "c", params: { n: seq++ }, ...over });
const track = (id, n, over = {}) => ({ id, name: id, hidden: false, clips: Array.from({ length: n }, (_, i) => clip(`${id}-${i}`)), ...over });

/** 非轨道字段共用同一批引用 —— 编辑器里的 store 就是这样(不可变更新,没动的不换对象) */
const BASE = {
  id: "p", name: "demo", width: 1920, height: 1080, fps: 30, duration: 10, themeId: "dark", camera3dFov: 50,
  media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
};
const project = (tracks) => ({ ...BASE, tracks });

/** 应用补丁,并断言两边的哈希一致(服务端就是这么判「对上了没有」的) */
function roundTrip(prev, next) {
  const patch = changedClips(prev, next);
  const applied = applyProjectPatch(prev, patch);
  assert.equal(projectHash(applied), projectHash(next), `应用补丁后哈希对不上:${JSON.stringify(patch).slice(0, 200)}`);
  return { patch, applied };
}

test("顶层字段表和 frameClient 的签名逐字一致", () => {
  /*
   * 两张表分家会悄悄坏掉:frameClient 那边新加一个字段、这边没跟上的话,
   * 那个字段就不进 `projectHash` —— 镜像的 409 校验从此看不见它,页面和服务端
   * 可以在那个字段上不一致而谁都不报。所以这里直接去读它的源码对。
   */
  const src = readFileSync(new URL("./frameClient.ts", import.meta.url), "utf8");
  const body = /const signatureFields = \(project: Project\) => JSON\.stringify\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(body, "frameClient.ts 里的 signatureFields() 长得和这条正则对不上了,改了形状就同步改这里");
  const fields = body[1].split(",").map((s) => s.trim().replace(/^project\./, ""));
  assert.deepEqual([...TOP_FIELDS], fields);
});

test("没有基线、或 tracks 以外的字段变了 → 整份", () => {
  const a = project([track("t1", 2)]);
  assert.deepEqual(changedClips(null, a), { kind: "full", project: a });
  // 改画幅 / 换主题 / 改素材 / 改卡片节点:一律整份
  for (const [k, v] of [["width", 1280], ["themeId", "light"], ["media", [{ id: "m" }]], ["cardNodes", [{ id: "d" }]], ["style", { a: 1 }]]) {
    const b = { ...a, [k]: v };
    assert.equal(changedClips(a, b).kind, "full", `${k} 变了应该整份`);
    assert.notEqual(projectHash(a), projectHash(b), `${k} 变了哈希应该不同`);
  }
  /*
   * 不在字段表里的元信息(名字)哈希上看不见 —— 哈希只管「画出来一不一样」。
   * 所以补丁那一层必须**按全部自有键**比,不然改个名字会走增量、而增量只带轨道,
   * 镜像里的名字就永远停在旧的上(Agent 的 get_project 读的正是它)。
   */
  const renamed = { ...a, name: "别的名字" };
  assert.equal(changedClips(a, renamed).kind, "full");
  assert.equal(projectHash(renamed), projectHash(a));
});

test("引用没变 / tracks 没变 → 空补丁", () => {
  const a = project([track("t1", 2)]);
  assert.ok(isEmptyPatch(changedClips(a, a)));
  assert.ok(isEmptyPatch(changedClips(a, { ...a })));
  assert.ok(!isEmptyPatch({ kind: "full", project: a }));
});

test("轨道:新增 / 删除 / 换序", () => {
  const t1 = track("t1", 2), t2 = track("t2", 2), t3 = track("t3", 1);
  const a = project([t1, t2]);

  const added = roundTrip(a, project([t1, t2, t3]));
  assert.equal(added.patch.order.length, 3);
  // 新轨道没有基线可比,整条给
  assert.deepEqual(added.patch.tracks, [{ id: "t3", track: t3 }]);

  const removed = roundTrip(a, project([t2]));
  assert.deepEqual(removed.patch.order, ["t2"]);
  assert.deepEqual(removed.patch.tracks, []);
  assert.deepEqual(removed.applied.tracks.map((t) => t.id), ["t2"]);

  const reordered = roundTrip(a, project([t2, t1]));
  assert.deepEqual(reordered.patch.order, ["t2", "t1"]);
  assert.deepEqual(reordered.patch.tracks, []);
  assert.equal(reordered.applied.tracks[0], t2, "换序不该造新对象");
});

test("轨道自身属性:hidden / muted 整组给", () => {
  const t1 = track("t1", 2), t2 = track("t2", 2);
  const a = project([t1, t2]);

  const hidden = roundTrip(a, project([{ ...t1, hidden: true }, t2]));
  assert.equal(hidden.patch.order, null);
  assert.equal(hidden.patch.tracks.length, 1);
  assert.equal(hidden.patch.tracks[0].props.hidden, true);
  assert.equal(hidden.patch.tracks[0].clips, undefined, "只改属性不该带片段");
  assert.equal(hidden.applied.tracks[0].clips, t1.clips, "片段数组该原样留着");
  assert.equal(hidden.applied.tracks[1], t2, "没动的轨道该是同一个对象");

  const muted = roundTrip(a, project([{ ...t1, muted: true }, t2]));
  assert.equal(muted.patch.tracks[0].props.muted, true);

  // 把一个键删掉也能表达(props 是整组,不靠删除表)
  const { hidden: _drop, ...noHidden } = t1;
  const dropped = roundTrip(a, project([noHidden, t2]));
  assert.ok(!("hidden" in dropped.applied.tracks[0]));
});

test("片段:改一个 / 加一个 / 删一个 / 换序", () => {
  const t1 = track("t1", 3), t2 = track("t2", 3);
  const a = project([t1, t2]);

  // 拖一个片段:只有它进补丁,同轨的另外两段保持同一个引用
  const moved = { ...t1.clips[1], start: 5, end: 6 };
  const drag = roundTrip(a, project([{ ...t1, clips: [t1.clips[0], moved, t1.clips[2]] }, t2]));
  assert.equal(drag.patch.tracks.length, 1);
  assert.equal(drag.patch.tracks[0].props, undefined, "轨道属性没动就别带 props");
  assert.deepEqual(drag.patch.tracks[0].clips, [{ id: moved.id, clip: moved }]);
  assert.equal(drag.patch.tracks[0].clipOrder, undefined, "顺序没变就别带 clipOrder");
  assert.equal(drag.applied.tracks[0].clips[0], t1.clips[0]);
  assert.equal(drag.applied.tracks[0].clips[2], t1.clips[2]);
  assert.equal(drag.applied.tracks[1], t2);
  // 一次拖动的补丁应该是「一段」这个量级,不是整份项目
  assert.ok(JSON.stringify(drag.patch).length < 8 * 1024, "一段的补丁不该到 8 KB");

  const fresh = clip("t1-new");
  const added = roundTrip(a, project([{ ...t1, clips: [...t1.clips, fresh] }, t2]));
  assert.deepEqual(added.patch.tracks[0].clips, [{ id: "t1-new", clip: fresh }]);
  assert.deepEqual(added.patch.tracks[0].clipOrder, ["t1-0", "t1-1", "t1-2", "t1-new"]);

  const removed = roundTrip(a, project([{ ...t1, clips: [t1.clips[0], t1.clips[2]] }, t2]));
  assert.deepEqual(removed.patch.tracks[0].clips, [{ id: "t1-1", clip: null }]);
  assert.deepEqual(removed.applied.tracks[0].clips.map((c) => c.id), ["t1-0", "t1-2"]);

  const reordered = roundTrip(a, project([{ ...t1, clips: [t1.clips[2], t1.clips[0], t1.clips[1]] }, t2]));
  assert.equal(reordered.patch.tracks[0].clips, undefined, "只换序不该重发片段");
  assert.deepEqual(reordered.patch.tracks[0].clipOrder, ["t1-2", "t1-0", "t1-1"]);
  assert.equal(reordered.applied.tracks[0].clips[0], t1.clips[2]);

  // 跨轨拖:一段从 t1 挪到 t2,两条轨道都进补丁
  const c = t1.clips[1];
  const across = roundTrip(a, project([
    { ...t1, clips: [t1.clips[0], t1.clips[2]] },
    { ...t2, clips: [...t2.clips, c] },
  ]));
  assert.deepEqual(across.patch.tracks.map((t) => t.id), ["t1", "t2"]);
  assert.equal(across.applied.tracks[1].clips[3], c);
});

test("素材段和卡片段都按引用比", () => {
  const mediaClip = clip("m-0", { kind: "media", mediaId: "v1", mediaOffset: 0 });
  const t1 = { id: "t1", name: "t1", hidden: false, clips: [mediaClip] };
  const a = project([t1]);
  const b = project([{ ...t1, clips: [{ ...mediaClip, mediaOffset: 1.5 }] }]);
  const { patch } = roundTrip(a, b);
  assert.equal(patch.tracks[0].clips[0].clip.mediaOffset, 1.5);
});

test("补丁对不上基线就抛(让镜像翻成 409)", () => {
  const a = project([track("t1", 1)]);
  assert.throws(() => applyProjectPatch(a, { kind: "tracks", order: null, tracks: [{ id: "nope", props: {} }] }), /不存在的轨道/);
  assert.throws(() => applyProjectPatch(a, { kind: "tracks", order: ["nope"], tracks: [] }), /不存在的轨道/);
  assert.throws(() => applyProjectPatch(a, { kind: "tracks", order: null, tracks: [{ id: "t1", clipOrder: ["nope"] }] }), /不存在的片段/);
  assert.throws(() => applyProjectPatch(a, { kind: "weird" }), /未知的补丁类型/);
  assert.equal(applyProjectPatch(a, null), a);
});

test("应用补丁不改原对象(镜像要按版本号留住旧版)", () => {
  const t1 = track("t1", 2);
  const a = project([t1]);
  const before = JSON.stringify(a);
  const next = project([{ ...t1, clips: [{ ...t1.clips[0], start: 9 }, t1.clips[1]] }]);
  const applied = applyProjectPatch(a, changedClips(a, next));
  assert.equal(JSON.stringify(a), before, "基线被就地改了");
  assert.notEqual(applied, a);
  assert.notEqual(applied.tracks, a.tracks);
});

test("三级缓存:拖一个片段只重算 1 个片段 + 1 条轨道", async () => {
  const tracks = Array.from({ length: 17 }, (_, i) => track(`t${i}`, 10));
  const a = project(tracks);

  resetHashStats();
  projectHash(a);
  const cold = hashStats();
  assert.equal(cold.clips, 170);
  assert.equal(cold.tracks, 17);

  // 同一份项目再算一次:一次都不该重算
  resetHashStats();
  projectHash(a);
  assert.deepEqual(hashStats(), { fields: 0, tracks: 0, clips: 0, values: 0 });

  // 拖一条轨道上的一段:store 是不可变更新,只有这一段、这条轨道、tracks 和 project 换新对象
  const t = tracks[9];
  const dragged = { ...t, clips: t.clips.map((c, i) => (i === 4 ? { ...c, start: 3, end: 4 } : c)) };
  const b = project(tracks.map((x, i) => (i === 9 ? dragged : x)));

  resetHashStats();
  const t0 = performance.now();
  const hash = projectHash(b);
  const ms = performance.now() - t0;
  const warm = hashStats();

  assert.equal(warm.clips, 1, `重算了 ${warm.clips} 个片段`);
  assert.equal(warm.tracks, 1, `重算了 ${warm.tracks} 条轨道`);
  assert.equal(warm.fields, 1, "顶层拼一次");
  assert.equal(warm.values, 0, "非轨道字段引用没变,不该重算");
  assert.notEqual(hash, projectHash(a));

  // 计时:单次 ≤ 2 ms。机器忙(几份 npm test 并行)时单次可能正好被挂起,所以不达标就再拖一次重量,
  // 最多 8 次、摊开在约 1 s 里,任一次达标即过。每次都是新拖出来的一条轨道(新对象),工作量与第一次相同
  // (1 段 + 1 轨 + 顶层,下面照样核对计数);判据不变,代码真退化时每一次都超,照样拦得住。
  const times = [ms];
  for (let k = 1; k < 8 && Math.min(...times) > 2; k++) {
    await new Promise((r) => setTimeout(r, 120));
    const again = { ...t, clips: t.clips.map((c, i) => (i === 4 ? { ...c, start: 3 + k, end: 4 + k } : c)) };
    const bk = project(tracks.map((x, i) => (i === 9 ? again : x)));
    resetHashStats();
    const s0 = performance.now();
    projectHash(bk);
    times.push(performance.now() - s0);
    const st = hashStats();
    assert.equal(st.clips, 1, `第 ${k + 1} 次重算了 ${st.clips} 个片段`);
    assert.equal(st.tracks, 1, `第 ${k + 1} 次重算了 ${st.tracks} 条轨道`);
  }
  const best = Math.min(...times);
  assert.ok(best <= 2, `17 轨 × 10 段拖一段重算,量了 ${times.length} 次,最快也用了 ${best.toFixed(3)} ms,超过 2 ms(${times.map((x) => x.toFixed(2)).join(", ")})`);

  // diff 也得是「一段」这个量级
  const patch = changedClips(a, b);
  assert.equal(patch.tracks.length, 1);
  assert.equal(patch.tracks[0].clips.length, 1);
  assert.equal(projectHash(applyProjectPatch(a, patch)), hash);
});

test("clips 在轨道对象里排第几个不影响哈希", () => {
  /*
   * 服务端应用补丁时把轨道重建成 `{...props, clips}` —— `clips` 一定排在最后,
   * 而页面那份里它可能夹在中间。`trackHash` 把片段和自身属性分开算就是为了这个:
   * 分不开的话,一次补丁下来两边的哈希必然不等,每一版都要整份重推。
   */
  const c = clip("c0");
  const a = project([{ id: "t1", clips: [c], name: "t1", hidden: false }]);
  const b = project([{ id: "t1", name: "t1", hidden: false, clips: [c] }]);
  assert.equal(projectHash(b), projectHash(a));
});

test("剪辑段引用的剪辑进项目哈希;没有剪辑段的项目哈希不变;没被引用的剪辑改了不影响", () => {
  const seg = { id: "s1", cardId: "", cutId: "B", start: 0, end: 2, params: {} };
  const cuts = (bClips, cClips = []) => [
    { id: "A", name: "A" },
    { id: "B", name: "B", tracks: [{ id: "tb", name: "tb", clips: bClips }], duration: 5, transitions: [] },
    { id: "C", name: "C", tracks: [{ id: "tc", name: "tc", clips: cClips }], duration: 5, transitions: [] },
  ];
  const plain = project([track("t1", 1)]);
  const withCutsNoSeg = { ...plain, cuts: cuts([clip("b1")]), activeCutId: "A" };
  // 没有剪辑段:多带 cuts 也不改哈希(cuts 本来就不在顶层字段表里)
  assert.equal(projectHash(withCutsNoSeg), projectHash(plain));
  const tracks = [{ id: "t1", name: "t1", clips: [seg] }];
  const a = { ...plain, tracks, cuts: cuts([clip("b1")]), activeCutId: "A" };
  const b = { ...plain, tracks, cuts: cuts([clip("b1", { start: 0.5 })]), activeCutId: "A" };
  const c = { ...plain, tracks, cuts: cuts([clip("b1")], [clip("c1")]), activeCutId: "A" };
  assert.notEqual(projectHash(a), projectHash(b), "被引用剪辑 B 改了,哈希要变");
  // c 和 a 只差没被引用的 C;b1 的 params 每次 clip() 都不同,所以拿 a 的 B 条目重建 c
  const c2 = { ...c, cuts: [a.cuts[0], a.cuts[1], c.cuts[2]] };
  assert.equal(projectHash(c2), projectHash(a), "没被引用的 C 改了,哈希不变");
});
