import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "../../testing/registerTs.mjs";

const contract = await import("./contract.ts");
const style = await import("./placeholderStyle.ts");
const { PLACEHOLDER_CSS, PERF_DEGRADED } = style;
const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const component = readFileSync(new URL("./placeholderPlane.tsx", import.meta.url), "utf8");

test("the module satisfies the handoff shape", () => {
  assert.match(index, /export \{ PlaceholderPlane \}/);
  assert.match(index, /export \{ PLACEHOLDER_CSS, PERF_DEGRADED \}/);
  assert.equal(typeof PLACEHOLDER_CSS, "string");
  assert.ok(!/filter\s*:|backdrop-filter\s*:/.test(PLACEHOLDER_CSS));
  assert.ok(!/\[hidden\]/.test(PLACEHOLDER_CSS));
  assert.match(index, /export const maxAnimated = /);
  assert.match(index, /export function layersFor\(/);
});

test("CSS animations have the reserved prefix and only animate opacity or transform", () => {
  const names = [...PLACEHOLDER_CSS.matchAll(/@keyframes\s+([\w-]+)\s*\{([^}]*\}[^}]*)\}/g)];
  // 降级时只剩 120 ms 出现延迟那一条;不降级时还有沙漏转动
  assert.equal(names.length, PERF_DEGRADED ? 1 : 2);
  for (const [, name, body] of names) {
    assert.ok(contract.isPlaceholderAnimation({ animationName: name }));
    const props = [...body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]);
    assert.ok(props.every((p) => p === "opacity" || p === "transform"), `${name}: ${props}`);
  }
  assert.match(PLACEHOLDER_CSS, /pc-ph-reveal 120ms/, "The 120 ms reveal delay is kept after downgrade");
});

test("solid and badge geometry render the required root; badge never has noise", () => {
  assert.match(component, /memo\(function PlaceholderPlane/);
  assert.match(component, /data-pc-placeholder-plane=""/);
  assert.match(component, /position: "absolute"/);
  assert.match(component, /geometry\.center\.x - 14/);
  assert.doesNotMatch(PLACEHOLDER_CSS, /\[data-pc-placeholder-kind="badge"\]\s*\{[^}]*background-image/s);
});

test("Performance downgrade (P4 circuit-breaker protocol): no noise overlay, hourglass does not spin, no new compositing layer", () => {
  if (!PERF_DEGRADED) return;
  assert.ok(!PLACEHOLDER_CSS.includes("background-image"), "No noise texture");
  assert.ok(!/pc-ph-turn/.test(PLACEHOLDER_CSS), "No spin animation");
  // index.ts 引 .tsx,node 直接 import 不了,按源码核对降级分支
  assert.match(index, /maxAnimated = PERF_DEGRADED \? 0 : 1/);
  assert.match(index, /if \(PERF_DEGRADED\) return 0;/);
});

test("P3 integration fix: the root element does not set pointer-events:none (hit testing relies on elementsFromPoint)", () => {
  assert.doesNotMatch(PLACEHOLDER_CSS, /pointer-events\s*:\s*none/);
  if (!PERF_DEGRADED) assert.match(PLACEHOLDER_CSS, /\[data-pc-placeholder-static\] \.pc-ph-hourglass/);
});

test("No \"Needs local PC render assist\": this icon appears nowhere in the component, styles or interface (user decision, 2026-10-21)", () => {
  const code = component.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /unsupported|UNSUPPORTED_TEXT|pc-ph-offline|needs local PC/);
  assert.doesNotMatch(PLACEHOLDER_CSS, /unsupported/);
  assert.equal(contract.UNSUPPORTED_TEXT, undefined);
  assert.equal(style.PLACEHOLDER_ONLINE_CSS, undefined);
  assert.doesNotMatch(index, /PLACEHOLDER_ONLINE_CSS/);
});

test("fit: the hourglass scales up by a multiplier computed from one side of the stage (center fixed); no transform is written when the multiplier is 1", () => {
  // 沙漏:徽标的圆整个放大;铺满形态只放大中间那个(噪点铺在根元素上,不缩放)
  assert.match(component, /width: 28, height: 28, \.\.\.\(s !== 1 \? \{ transform: `scale\(\$\{s\}\)` \} : null\)/);
  assert.match(component, /className="pc-ph-center"[^>]*style=\{solid && s !== 1 \? \{ transform: `translate\(-50%, -50%\) scale\(\$\{s\}\)` \}/);
  // 不再用 CSS 变量
  assert.doesNotMatch(component + PLACEHOLDER_CSS, /--pc-ph-ui-scale/);
  assert.doesNotMatch(PLACEHOLDER_CSS, /data-pc-placeholder-layout/);
});
