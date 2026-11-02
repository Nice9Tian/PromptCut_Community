/**
 * 参数面板与时间轴副标题看的参数视图(`paramsView.ts`)。跑:
 *   node --test src/editor/left/paramsView.test.mjs
 *
 *   PV-01 先查能跑的定义,没有再用同步来的用户卡的只读视图;两边都没有回 undefined
 *   PV-02 画不出控件时的文案:同步卡源码里有控件却一个都没认出来 → 「在线浏览器模式暂不支持修改这张卡的参数…」;
 *         真没有控件 →「这张卡没有可调参数」;有控件 → null
 *   PV-03 副标题:第一个文字控件的当前值 → 默认值 → 说明
 *   PV-04 只认出一部分控件:认出的照常画,下面一行「在线浏览器模式暂不支持修改这张卡的其余参数…」
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const V = await import(srcUrl("editor/left/paramsView.ts"));
const P = await import(srcUrl("online/pageFlag.ts"));
const PU = await import(srcUrl("online/onlineUnsupported.ts"));

test("PV-01 先查定义,没有再用同步视图", () => {
  const built = { id: "b", name: "内置", defaults: {}, controls: [], Component: () => null };
  const view = { id: "s", name: "同步", defaults: { a: 1 }, controls: [], controlsIncomplete: false, synced: true };
  const lookup = { getCard: (id) => (id === "b" ? built : undefined), syncedCardView: (id) => (id === "s" || id === "b" ? view : undefined) };
  assert.equal(V.paramsCardView("b", lookup), built, "定义优先");
  assert.equal(V.paramsCardView("s", lookup), view);
  assert.equal(V.paramsCardView("x", lookup), undefined);
  assert.equal(V.paramsCardView(undefined, lookup), undefined);
});

test("PV-02 画不出控件时的文案", () => {
  const unsupported = PU.onlineUnsupported("changing this card's parameters");
  assert.ok(unsupported.includes("changing this card's parameters"), unsupported); // 前后缀来自 src/online/pageFlag.ts(还是中文)
  assert.equal(V.paramsEmptyText({ name: "s", defaults: {}, controls: [], controlsIncomplete: true }), unsupported, "源码有控件、一个都没认出来");
  assert.equal(V.paramsEmptyText({ name: "s", defaults: {}, controls: [], controlsIncomplete: false }), V.NO_PARAMS_TEXT);
  assert.equal(V.paramsEmptyText({ name: "b", defaults: {}, controls: [] }), "This card has no adjustable parameters", "能跑的定义没有控件");
  assert.equal(V.paramsEmptyText(undefined), V.NO_PARAMS_TEXT, "Unknown card");
  assert.equal(V.paramsEmptyText({ name: "s", defaults: {}, controls: [{ key: "t", label: "t", type: "text" }], controlsIncomplete: true }), null, "认出一部分:照常画认出的那些");
});

test("PV-03 副标题", () => {
  const view = { name: "s", description: "Description", defaults: { text: " 默认 " }, controls: [{ key: "n", label: "n", type: "number" }, { key: "text", label: "Text", type: "text" }] };
  assert.equal(V.clipSubtitleOf(view, { text: "改过" }), "改过");
  assert.equal(V.clipSubtitleOf(view, {}), "默认");
  assert.equal(V.clipSubtitleOf({ ...view, defaults: {} }, {}), "Description");
  assert.equal(V.clipSubtitleOf({ name: "s", defaults: {}, controls: [] }, {}), "");
  assert.equal(V.clipSubtitleOf(undefined, {}), "");
});

test("PV-04 只认出一部分控件:照常画认出的,下面一行提示其余参数在线改不了", () => {
  const partial = { name: "s", defaults: {}, controls: [{ key: "t", label: "t", type: "text" }], controlsIncomplete: true };
  assert.equal(V.paramsPartialText(partial), PU.onlineUnsupported("changing this card's remaining parameters"));
  assert.ok(V.paramsPartialText(partial).includes("changing this card's remaining parameters"));
  assert.equal(V.paramsEmptyText(partial), null, "认出的照常画");
  assert.equal(V.paramsPartialText({ ...partial, controlsIncomplete: false }), null, "全认出:不提示");
  assert.equal(V.paramsPartialText({ ...partial, controls: [] }), null, "一个都没认出:走空态那句,不重复提示");
  assert.equal(V.paramsPartialText({ name: "b", defaults: {}, controls: [{ key: "t", label: "t", type: "text" }] }), null, "能跑的定义");
  assert.equal(V.paramsPartialText(undefined), null);
});

test("PV-05 没认出的控件逐条说明:哪一条、为什么;超过 5 条说「等 N 条」;没有逐条记录回 null", () => {
  const base = { name: "同步", defaults: {}, controls: [{ key: "a", label: "A", type: "text" }], controlsIncomplete: true };
  assert.equal(V.paramsSkippedText({ ...base }), null, "旧页面没有逐条记录");
  assert.equal(V.paramsSkippedText({ ...base, controlsIncomplete: false, skippedControls: [{ reason: "x" }] }), null);
  const one = V.paramsSkippedText({ ...base, skippedControls: [{ key: "side", label: "Position", type: "select", reason: "下拉缺选项(options)" }] });
  assert.equal(one, 'Unrecognized parameters: "Position" (side):下拉缺选项(options)');
  const mixed = V.paramsSkippedText({ ...base, skippedControls: [{ key: "k", reason: "r1" }, { label: "只有标签", reason: "r2" }, { reason: "展开的 X 取不到:内容库里没有 ./x 这个文件" }] });
  assert.equal(mixed, 'Unrecognized parameters: k:r1;"只有标签":r2;a control:展开的 X 取不到:内容库里没有 ./x 这个文件');
  const many = V.paramsSkippedText({ ...base, skippedControls: Array.from({ length: 7 }, (_, i) => ({ key: `k${i}`, reason: "r" })) });
  assert.match(many, /k4:r; and 7 more$/);
  assert.ok(!many.includes("k5"));
  // 一个都没认出时,空白文案照旧,逐条说明另起一行(ParamsForm 画在它下面)
  assert.equal(V.paramsEmptyText({ ...base, controls: [], skippedControls: [{ reason: "r" }] }), PU.onlineUnsupported("changing this card's parameters"));
});
