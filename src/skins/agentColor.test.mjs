import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_FALLBACK_HUE, AGENT_HUE, agentColorFor, hueGap, oklchOf } from "./agentColor.ts";

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

test("oklchOf:白、黑、纯红的已知值", () => {
  const w = oklchOf("#ffffff");
  close(w.l, 1, 0.001, "白的明度");
  close(w.c, 0, 0.001, "白的纯度");
  close(oklchOf("#000000").l, 0, 0.001, "黑的明度");
  const red = oklchOf("#ff0000");
  close(red.l, 0.628, 0.002, "红的明度");
  close(red.c, 0.2577, 0.002, "红的纯度");
  close(red.h, 29.23, 0.2, "红的色相");
  assert.equal(oklchOf("not-a-color"), null);
});

for (const [name, accent] of [["studio 深色强调色", "#00DBDB"], ["studio 浅色强调色", "#0E7A85"], ["极光强调色", "#14b8a6"]]) {
  test(`${name} ${accent} → 同明度、同纯度的黄`, () => {
    const a = oklchOf(accent);
    const y = oklchOf(agentColorFor(accent));
    close(y.l, a.l, 0.006, "明度");
    close(y.c, Math.max(0.09, a.c), 0.006, "纯度");
    assert.ok(hueGap(y.h, AGENT_HUE) < 2, `色相应在黄色 ${AGENT_HUE}° 附近,实际 ${y.h}`);
  });
}

test("琥珀强调色本身是黄橙:Agent 换成紫色,不和强调色撞色", () => {
  const accent = "#f59e0b";
  const y = oklchOf(agentColorFor(accent));
  assert.ok(hueGap(y.h, AGENT_FALLBACK_HUE) < 3, `应该是紫色,实际色相 ${y.h}`);
  close(y.l, oklchOf(accent).l, 0.006, "明度仍然跟强调色一致");
});

test("换色相后出了 sRGB 色域:明度、色相不动,只降纯度", () => {
  // 霓虹的品红 #ec4899:明度约 0.66、纯度约 0.2,黄色在这个明度放不下这么浓
  const accent = "#ec4899";
  const out = agentColorFor(accent);
  assert.match(out, /^#[0-9a-f]{6}$/);
  const a = oklchOf(accent);
  const y = oklchOf(out);
  close(y.l, a.l, 0.01, "明度");
  assert.ok(y.c <= a.c + 0.001, "纯度只会降不会升");
  assert.ok(hueGap(y.h, AGENT_HUE) < 4, `色相仍是黄,实际 ${y.h}`);
});

test("灰色强调色也给出看得出是黄的颜色;解析不了给固定黄", () => {
  const y = oklchOf(agentColorFor("#888888"));
  assert.ok(y.c >= 0.08, `纯度至少 0.08,实际 ${y.c}`);
  assert.ok(hueGap(y.h, AGENT_HUE) < 3);
  assert.equal(agentColorFor("oops"), "#d6b13c");
});
