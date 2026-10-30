// node --test src/kernel/emphasis.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { emphasisFilter, normalizeEmphasis, describeEmphasis, EMPHASIS_DEFAULTS } = await import("./emphasis.ts");

test("normalizeEmphasis:补默认、夹范围,kind 不认识返回 null", () => {
  assert.equal(normalizeEmphasis(null), null);
  assert.equal(normalizeEmphasis({ kind: "glow" }), null);
  assert.deepEqual(normalizeEmphasis({ kind: "shadow" }), { kind: "shadow", ...EMPHASIS_DEFAULTS.shadow });
  const big = normalizeEmphasis({ kind: "outline", size: 999, opacity: 5, dx: -9999 });
  assert.equal(big.size, 80);
  assert.equal(big.opacity, 1);
  assert.equal(big.dx, -200);
  // 不是数就用默认值,不会算出 NaN
  assert.equal(normalizeEmphasis({ kind: "shadow", size: "粗" }).size, EMPHASIS_DEFAULTS.shadow.size);
  assert.equal(normalizeEmphasis({ kind: "shadow", color: "   " }).color, "#000000");
});

test("阴影:一条 drop-shadow,偏移和模糊都写进去", () => {
  const f = emphasisFilter({ kind: "shadow", color: "#000", size: 10, opacity: 1, dx: 0, dy: 4 });
  assert.equal(f, "drop-shadow(0px 4px 10px #000)");
});

test("不透明度用 color-mix 兑,不去解析颜色串本身", () => {
  const f = emphasisFilter({ kind: "shadow", color: "rgb(10 20 30)", size: 8, opacity: 0.5, dx: 0, dy: 0 });
  assert.match(f, /color-mix\(in srgb, rgb\(10 20 30\) 50%, transparent\)/);
});

test("描边:八个方向绕一圈,线宽就是半径;粗的加一丝模糊填缝", () => {
  const thin = emphasisFilter({ kind: "outline", color: "#fff", size: 3, opacity: 1 });
  assert.equal(thin.match(/drop-shadow/g).length, 8);
  assert.match(thin, /drop-shadow\(3px 0px 0px #fff\)/); // 正右方向
  assert.equal(/0px 0px 0px/.test(thin.split(" drop-shadow")[0]), false);

  const thick = emphasisFilter({ kind: "outline", color: "#fff", size: 10, opacity: 1 });
  assert.equal(thick.match(/drop-shadow/g).length, 8);
  assert.match(thick, /drop-shadow\(10px 0px 2px #fff\)/); // 模糊 = 10 × 0.2
});

test("scale:素材层按自己的倍率放大线宽,舞台整体缩放时不用传", () => {
  const a = emphasisFilter({ kind: "shadow", color: "#000", size: 10, opacity: 1, dx: 0, dy: 5 }, 2);
  assert.equal(a, "drop-shadow(0px 10px 20px #000)");
});

test("没有 / 尺寸为 0 / 全透明 → 空串(空串就等于不写 filter,老项目 DOM 不变)", () => {
  assert.equal(emphasisFilter(null), "");
  assert.equal(emphasisFilter(undefined), "");
  assert.equal(emphasisFilter({ kind: "shadow", size: 0 }), "");
  assert.equal(emphasisFilter({ kind: "outline", opacity: 0 }), "");
});

test("describeEmphasis:界面和 Agent 回显同一句话", () => {
  assert.equal(describeEmphasis(null), "无");
  assert.match(describeEmphasis({ kind: "outline", size: 6, color: "#fff", opacity: 1 }), /描边 6px/);
  assert.match(describeEmphasis({ kind: "shadow" }), /阴影 18px · 偏移 0,8/);
});
