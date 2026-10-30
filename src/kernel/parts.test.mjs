/**
 * kernel/parts.ts 的单测。跑:node --test src/kernel/parts.test.mjs
 *
 * 部件实例树是组合卡的全部内容,Agent 的 add_part / set_part / remove_part / move_part 都落在这里:
 *   - 增删改移返回新树、原树不动;
 *   - 校验一处不过整棵不写,错误说人话;
 *   - 世界坐标按父框逐级合成;时序按 enterMs 逐级累加。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { addPart, removePart, updatePart, movePart, validatePartFrame, validatePartTree, placeParts, partsTiming, findPart, flattenParts, MAX_PART_NODES } from "./parts.ts";

const title = {
  id: "text-title", name: "标题", description: "", role: "text",
  defaults: { text: "T", size: 48 },
  controls: [{ key: "text", label: "标题", type: "text", required: true }, { key: "size", label: "字号", type: "number" }],
  defaultFrame: { x: 100, y: 100, w: 800, h: 160 },
  settleMs: () => 600,
  after: "hold",
  Component: () => null,
};
const pins = {
  id: "list-pins", name: "钉板要点", description: "", role: "list",
  defaults: { items: "a|b|c", stepMs: 200 },
  controls: [{ key: "items", label: "要点", type: "text", required: true }, { key: "stepMs", label: "间隔", type: "number" }],
  settleMs: (p) => (p.items.split("|").filter(Boolean).length - 1) * p.stepMs + 400,
  after: "hold",
  Component: () => null,
};
const box = { id: "group-box", name: "组", description: "", role: "group", defaults: {}, controls: [], after: "evolve", Component: () => null };
const lookup = (id) => ({ "text-title": title, "list-pins": pins, "group-box": box })[id];

test("addPart:默认框来自部件、参数和 defaults 合并、原树不动;removePart / updatePart / movePart 各回新树", () => {
  const t0 = [];
  const { tree: t1, node } = addPart(t0, { partId: "text-title", params: { text: "Hi" } }, lookup);
  assert.equal(t0.length, 0, "原树不动");
  assert.deepEqual(node.frame, { x: 100, y: 100, w: 800, h: 160 });
  assert.deepEqual(node.params, { text: "Hi", size: 48 });

  const { tree: t2 } = addPart(t1, { partId: "list-pins", id: "pins", frame: { x: 0, y: 300 }, enterMs: 300 }, lookup);
  assert.deepEqual(t2.map((n) => n.id), [node.id, "pins"]);
  assert.equal(t1.length, 1);

  const { tree: t3 } = updatePart(t2, "pins", { params: { stepMs: 500 }, frame: null, label: "要点" }, lookup);
  const pinsNode = findPart(t3, "pins").node;
  assert.equal(pinsNode.params.stepMs, 500);
  assert.equal(pinsNode.params.items, "a|b|c", "稀疏合并");
  assert.equal(pinsNode.frame, undefined, "frame null = 清掉");
  assert.equal(pinsNode.label, "要点");
  assert.equal(findPart(t2, "pins").node.params.stepMs, 200, "原树不动");

  const { tree: t4 } = addPart(t3, { partId: "group-box", id: "g" }, lookup, { index: 0 });
  const t5 = movePart(t4, "pins", { parentId: "g" });
  assert.deepEqual(t5.map((n) => n.id), ["g", node.id]);
  assert.deepEqual(findPart(t5, "g").node.children.map((n) => n.id), ["pins"]);
  assert.equal(findPart(t5, "pins").parentId, "g");
  assert.equal(flattenParts(t5).length, 3);

  const t6 = removePart(t5, "g");
  assert.deepEqual(flattenParts(t6).map((n) => n.id), [node.id], "删父节点连子树一起删");
});

test("校验:说人话,一处不过整棵拒", () => {
  assert.throws(() => addPart([], { partId: "nope" }, lookup), /没有 id 为 "nope" 的部件/);
  assert.throws(() => addPart([], { partId: "text-title", params: { size: "big" } }, lookup), /要数字/);
  assert.throws(() => addPart([], { partId: "text-title", params: { text: "" } }, lookup), /必填/);
  assert.throws(() => addPart([], { partId: "text-title", params: { nope: 1 } }, lookup), /不是部件 text-title 的参数/);
  assert.throws(() => addPart([], { partId: "text-title", frame: { x: 1 } }, lookup), /frame.x \/ frame.y 必须是数字/);
  assert.throws(() => addPart([], { partId: "text-title", enterMs: -1 }, lookup), /非负/);
  const { tree } = addPart([], { partId: "text-title", id: "a" }, lookup);
  assert.throws(() => addPart(tree, { partId: "text-title", id: "a" }, lookup), /已经存在/);
  assert.throws(() => movePart(tree, "a", { parentId: "a" }), /自己的子树/);
  assert.throws(() => removePart(tree, "zzz"), /找不到部件实例/);
  // 整棵校验:第二个坏了第一个也不算
  assert.throws(() => validatePartTree([{ id: "a", partId: "text-title", params: { text: "x" } }, { id: "a", partId: "text-title", params: { text: "y" } }], lookup), /重复/);
  assert.throws(() => validatePartTree("nope", lookup), /要是数组/);
  const ok = validatePartTree([{ id: "a", partId: "text-title", params: { text: "x" }, frame: { x: 1, y: 2 }, enterMs: 0, children: [{ id: "b", partId: "list-pins", params: {} }] }], lookup);
  assert.equal(ok[0].enterMs, undefined, "0 不存");
  assert.deepEqual(ok[0].children[0].params, { items: "a|b|c", stepMs: 200 }, "子实例参数也补齐默认值");
});

test("placeParts:局部框相对父框逐级合成成画面矩形;缩放绕锚点", () => {
  const tree = [
    { id: "g", partId: "group-box", params: {}, frame: { x: 100, y: 50, w: 800, h: 400 }, children: [
      { id: "t", partId: "text-title", params: {}, frame: { x: 10, y: 20, w: 200, h: 100 } },
      { id: "s", partId: "text-title", params: {}, frame: { x: 400, y: 200, w: 200, h: 100, anchor: [0.5, 0.5], scale: 2 } },
    ] },
    { id: "full", partId: "list-pins", params: {} },
  ];
  const placed = placeParts(tree, { box: { left: 0, top: 0, width: 1920, height: 1080 }, scale: 1 });
  assert.deepEqual(placed.get("g").world, { left: 100, top: 50, width: 800, height: 400 });
  assert.deepEqual(placed.get("t").world, { left: 110, top: 70, width: 200, height: 100 }, "子框加上父框的偏移");
  const s = placed.get("s").world;
  assert.deepEqual([s.left, s.top, s.width, s.height], [100 + 300 - 100, 50 + 150 - 50, 400, 200], "锚点居中、放大 2 倍:中心不动,四周各撑出去一半");
  assert.deepEqual(placed.get("full").world, { left: 0, top: 0, width: 1920, height: 1080 }, "没有框 = 铺满父框");
  // 组合卡本身缩到一半、挪到 (200,100)
  const half = placeParts(tree, { box: { left: 200, top: 100, width: 960, height: 540 }, scale: 0.5 });
  assert.deepEqual(half.get("g").world, { left: 250, top: 125, width: 400, height: 200 });
  assert.deepEqual(half.get("t").world, { left: 255, top: 135, width: 100, height: 50 });
});

test("partsTiming:enterMs 逐级累加,settleMs 按部件公式,after 取最活跃的那个", () => {
  const tree = [
    { id: "t", partId: "text-title", params: {}, enterMs: 100 },
    { id: "g", partId: "group-box", params: {}, enterMs: 500, children: [
      { id: "p", partId: "list-pins", params: { items: "a|b|c|d", stepMs: 250 }, enterMs: 200 },
    ] },
  ];
  const tm = partsTiming(tree, lookup);
  assert.deepEqual(tm.parts.get("t"), { enterMs: 100, settleMs: 700, after: "hold" });
  assert.equal(tm.parts.get("p").enterMs, 700, "子实例的进场 = 父进场 + 自己的 enterMs");
  assert.equal(tm.parts.get("p").settleMs, 700 + 3 * 250 + 400);
  assert.equal(tm.settleMs, 700 + 3 * 250 + 400);
  assert.equal(tm.after, "evolve", "有一个部件一直在变,整张卡就算一直在变");
  assert.equal(partsTiming([tree[0]], lookup).after, "hold");
});

test("树有节点上限;frame 写回时重建成固定键序", () => {
  const many = Array.from({ length: MAX_PART_NODES + 1 }, (_, i) => ({ id: "n" + i, partId: "text-title", params: { text: "x" } }));
  assert.throws(() => validatePartTree(many, lookup), /最多/);
  const ok = validatePartTree([{ id: "a", partId: "text-title", params: { text: "x" }, frame: { scale: 2, y: 1, x: 0, anchor: [0.5, 0.5] } }], lookup);
  assert.deepEqual(Object.keys(ok[0].frame), ["x", "y", "anchor", "scale"]);
});

/*
 * 部件级三维:**拒绝**,不是支持。
 *
 * clip 级的 FRAME_KEYS 补三维是为了修 set_clip(见 envelope.test.mjs);部件这一层
 * 一并放行过一版,但渲染接不住 —— CSS 的 perspective 只作用于直接子元素,传不到部件那一格,
 * 实测部件 rotateY(40°) 的外接框高度在卡片没有 preserve-3d 时是 300.00(纯仿射)、
 * 有 preserve-3d 时才是 336.44(真透视),而卡片一带 opacity/filter 又回到 300.00。
 * 三种情况三个结果,所以当场拒掉,理由说清楚。
 */
test("部件的 frame 拒绝三维,并告诉调用方该怎么办", () => {
  for (const k of ["rotateX", "rotateY", "translateZ"]) {
    assert.throws(
      () => validatePartFrame({ x: 0, y: 0, [k]: 30 }, "部件 a"),
      new RegExp(`暂时不支持 ${k}`),
      `${k} 该被拒`,
    );
  }
  // 报错要指路,不能只说「不认识」
  assert.throws(() => validatePartFrame({ x: 0, y: 0, rotateY: 30 }, "部件 a"), /set_position/);
});

test("部件的 frame:平面那几项照常收,而且不带多余的键", () => {
  assert.deepEqual(validatePartFrame({ x: 1, y: 2, scale: 0.5, rotate: 8 }, "部件 a"), { x: 1, y: 2, scale: 0.5, rotate: 8 });
});

test("部件的 frame:不认识的键仍然按老话术拒", () => {
  assert.throws(() => validatePartFrame({ x: 0, y: 0, wat: 1 }, "部件 a"), /不认识 "wat"/);
});
