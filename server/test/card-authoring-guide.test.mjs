/**
 * 建卡指南（`server/card-authoring-guide.md`）和建卡检查、remotion 式的框架对得上。
 * 跑：node scripts/test-suite.mjs server/test/card-authoring-guide.test.mjs
 *
 *   GA-01  指南里标成「完整卡片」的代码例子，逐个过建卡检查（`checkCardSource`，建卡口径）；三个 remotion 式的例子与测试夹具一致
 *   GA-02  指南第 2.4 节「会被当场拒绝的写法」每一行对应一个检查的规则代号，对照表钉在这里；每一行的样例真的被拒、指出行号；
 *          检查里的每个规则代号在指南里都有一行（指南没有漏的）
 *   GA-03  指南第 2.5 节「能引用的模块」和检查里的名单（`REMOTION_IMPORT_ALLOW`）逐项相同
 *   GA-04  指南第 2.1 节的工具表和框架的对外导出逐个相同；表里写的缺省值与例子数字和代码对得上
 *   GA-05  指南里 `beginFrameWork` 的片段放进一张卡里能过建卡检查
 *   GA-06  指南不再说过时的话：frameMode 是必填；旧值都按 motion 式读；不规定优先用哪一种；没有旧名词「图卡」
 *   GA-07  工具说明与 Agent 提示词里讲怎么写卡的地方和指南一致（提到两种写法与必填的 frameMode）
 *
 * 这份指南是 Agent 建卡时读的东西，指南里写错一个名字、一个缺省值，Agent 照着写就会被拒或画错，所以逐项钉。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// 这份单测不碰改动层
delete process.env.PROMPTCUT_CARD_OVERRIDES;

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const GUIDE = read('server/card-authoring-guide.md');

const cards = await import('../vite-plugin-cards.ts');
const { inspectRemotionStyle, REMOTION_IMPORT_ALLOW } = await import('../remotion-style-check.mjs');
const F = await import('../../src/kernel/remotionStyle/index.ts');
const { normalizeFrameMode } = await import('../../src/kernel/frameMode.mjs');

/** 指南里 `## 标题` 或 `### 标题` 开头的一节（到下一个同级或更高级标题为止） */
function section(heading) {
  const lines = GUIDE.split('\n');
  const start = lines.findIndex((l) => l.startsWith(heading));
  assert.ok(start >= 0, `指南里找不到「${heading}」这一节`);
  const level = /^#+/.exec(lines[start])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+) /.exec(lines[i]);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}
/** 一节里第一张表的数据行：每行拆成格子（`\|` 不拆） */
function tableRows(text) {
  const rows = [];
  let inTable = false;
  for (const line of text.split('\n')) {
    if (/^\|/.test(line)) {
      inTable = true;
      if (/^\|[-| ]+\|$/.test(line)) continue;
      rows.push(line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim()));
    } else if (inTable) break;
  }
  return rows.slice(1); // 去掉表头
}
const author = (id, source) => cards.checkCardSource(id, source, [], { mode: 'author', before: '' });
const idOf = (source) => /\bid:\s*"([^"]+)"/.exec(source)[1];

/* ------------------------------------------------------------------ GA-01 */

const FULL = [...GUIDE.matchAll(/```tsx 完整卡片\n([\s\S]*?)\n```/g)].map((m) => m[1]);

test('GA-01 指南里标成「完整卡片」的代码例子，逐个过建卡检查', () => {
  // 三个 remotion 式的例子、三个素材效果卡例子、一个 motion 式的例子
  assert.equal(FULL.length, 7, '指南里应有 7 个完整卡片例子');
  const ids = new Set();
  const modes = [];
  for (const source of FULL) {
    const id = idOf(source);
    assert.ok(!ids.has(id), `例子的 id 重复：${id}`);
    ids.add(id);
    const r = author(id, source);
    assert.deepEqual(r.errors, [], `指南例子 ${id} 应当过建卡检查`);
    assert.equal(r.ok, true);
    modes.push(/frameMode:\s*"(direct|stateful)"/.exec(source)?.[1]);
  }
  assert.deepEqual(modes.filter((m) => m === 'direct').length, 6, '6 个 remotion 式（3 张动效卡 + 3 个素材效果卡）');
  assert.deepEqual(modes.filter((m) => m === 'stateful').length, 1, '1 个 motion 式');
  // 声明成 remotion 式的，按 remotion 式的规矩查，一条违规都没有
  for (const source of FULL.filter((s) => /frameMode:\s*"direct"/.test(s))) {
    const r = inspectRemotionStyle(source);
    assert.equal(r.declared, 'direct');
    assert.deepEqual(r.violations, [], `${idOf(source)} 不该有违规`);
  }
});

test('GA-01b 三个 remotion 式的例子和测试夹具里的示例卡保持一致（只少了夹具开头那行说明）', () => {
  const guideBlocks = new Map(FULL.map((s) => [idOf(s), s]));
  for (const name of ['rs-title-reveal', 'rs-bar-race', 'rs-orbit-canvas']) {
    const fixture = read(`server/test/fixtures/remotion-style/${name}.tsx`).replace(/^\/\*\*[^\n]*\*\/\n/, '').trimEnd();
    assert.equal(guideBlocks.get(name), fixture, `指南里的 ${name} 要和夹具一致`);
  }
});

test('GA-01c 三个素材效果卡例子用不到框架的工具，各写一行裸导入；只引名单里的模块', () => {
  for (const id of ['invert-filter', 'crossfade', 'gain-audio']) {
    const source = FULL.find((s) => idOf(s) === id);
    assert.ok(source, `缺例子 ${id}`);
    assert.match(source, /^import "\.\.\/\.\.\/kernel\/remotionStyle";$/m, `${id} 要有一行裸导入`);
    assert.ok(!/from\s+"[^"]*remotionStyle"/.test(source), `${id} 用不到框架的工具，只写裸导入`);
    assert.match(source, /frameMode:\s*"direct"/);
    assert.deepEqual(inspectRemotionStyle(source).violations, [], id);
    assert.deepEqual(inspectRemotionStyle(source.replace('import "../../kernel/remotionStyle";\n', '')).violations.map((v) => v.rule), ['framework'], `${id} 去掉裸导入就该被拒`);
    const specs = [...source.matchAll(/(?:from|^import)\s+"([^"]+)"/gm)].map((m) => m[1]);
    for (const spec of specs) {
      const at = path.posix.normalize(path.posix.join('src/cards/user', spec)).replace(/\/index$/, '');
      assert.ok(REMOTION_IMPORT_ALLOW.includes(at), `${id} 引了名单之外的 ${spec}`);
    }
  }
});

/* ------------------------------------------------------------------ GA-02 */

/** 一张最小的合规 remotion 式的卡，样例在它的某个位置塞一条违规 */
function cardWith({ imports = '', top = '', body = '', jsx = '<div style={{ opacity: t }} />', mode = '"direct"', framework = true } = {}) {
  return [
    framework ? 'import "../../kernel/remotionStyle";' : '',
    'import { useMemo, useRef, useLayoutEffect } from "react";',
    'import type { CardDef, CardProps } from "../../kernel/types";',
    imports,
    top,
    'interface P { x: number }',
    'function C({ params, t = 0 }: CardProps<P>) {',
    body,
    `  return ${jsx};`,
    '}',
    `export const c: CardDef<P> = { id: "ga-row", name: "n", description: "d", source: "user", frameMode: ${mode}, defaults: { x: 1 }, controls: [{ key: "x", label: "x", type: "number" }], Component: C };`,
    '',
  ].join('\n');
}

/**
 * 指南第 2.4 节每一行（第一格的原文）→ 检查里的规则代号，以及一份只违反这一行的样例。
 * 指南里加一行、改一行的措辞，这里要跟着改，对照表就是这样钉住的。
 */
const REJECTED = [
  { guide: '引用名单之外的模块（含同目录的辅助文件 `./xxx`、样式文件、没列在名单里的第三方库），动态 `import()`、`require()`', rule: 'import', source: cardWith({ imports: 'import lottie from "lottie-web";' }) },
  { guide: '`motion` / `motion/react`、`<motion.div>`、`whileHover` 这类交互属性', rule: 'motion', source: cardWith({ imports: 'import { motion } from "motion/react";', jsx: '<motion.div animate={{ opacity: 1 }} />' }) },
  { guide: '`<AnimatePresence>`', rule: 'presence', source: cardWith({ jsx: '<AnimatePresence><div /></AnimatePresence>' }) },
  { guide: 'CSS 动画与过渡：样式里的 `animation*`、`transition*`；样式文本里的 `@keyframes`；类名 `animate-*`、`transition*`；元素的 `.animate()`；SVG 的 `<animate>`', rule: 'css-animation', source: cardWith({ jsx: '<div style={{ transition: "opacity 1s" }} />' }) },
  { guide: '`Date.now()`、不带参数的 `new Date()`、`performance`', rule: 'real-time', source: cardWith({ body: '  const n = Date.now();' }) },
  { guide: '`setTimeout`、`setInterval`、`setImmediate`、`requestIdleCallback`', rule: 'timer', source: cardWith({ body: '  setTimeout(() => {}, 10);' }) },
  { guide: '`requestAnimationFrame`、`cancelAnimationFrame`、`setAnimationLoop`、`requestVideoFrameCallback`', rule: 'frame-callback', source: cardWith({ body: '  requestAnimationFrame(() => {});' }) },
  { guide: '`Math.random`、`crypto`', rule: 'random', source: cardWith({ body: '  const r = Math.random();' }) },
  { guide: '`useState` 等记状态的 hook', rule: 'state', source: cardWith({ imports: 'import { useState } from "react";', body: '  const [n] = useState(0);' }) },
  { guide: '`useRef(初值)`、往 `.current` 里写', rule: 'state', source: cardWith({ body: '  const r = useRef(0);' }) },
  { guide: '往文件顶层的名字或导入的东西里写（赋值、自增、`delete`、`push` 这类会改内容的方法、`Object.assign`）', rule: 'state', source: cardWith({ top: 'const BOX = { n: 0 };', body: '  BOX.n += 1;' }) },
  { guide: '`window`、`globalThis`、`self`、`localStorage` 等全局对象，`eval`、`Function()`', rule: 'state', source: cardWith({ body: '  const w = window;' }) },
  { guide: '顶层的 `let` / `var` / `class` / `enum`、直接执行的语句，顶层初始化式里的 `new`、`await`、赋值', rule: 'top-level', source: cardWith({ top: 'let n = 0;' }) },
  { guide: '`IntersectionObserver`', rule: 'viewport', source: cardWith({ body: '  const o = new IntersectionObserver(() => {});' }) },
  { guide: '`frameMode` 写成变量或算出来的值', rule: 'frame-mode', source: cardWith({ top: 'const MODES = ["direct"] as const;', mode: 'MODES[0]' }) },
  { guide: '没有一句引用框架的 import（只带类型的 `import type …` 不算）', rule: 'framework', source: cardWith({ framework: false }) },
];

test('GA-02 指南第 2.4 节每一行对应一个检查的规则代号，样例真的被拒并指出行号', () => {
  const base = author('ga-row', cardWith());
  assert.deepEqual(base.errors, [], '对照用的合规卡本身要能过');

  const rows = tableRows(section('### 2.4'));
  assert.deepEqual(rows.map((r) => r[0]), REJECTED.map((r) => r.guide), '指南第 2.4 节的行和对照表逐行一致（同一个次序）');
  for (const row of rows) assert.equal(row.length, 3, `每行三格：${row[0]}`);

  for (const { guide, rule, source } of REJECTED) {
    const seen = inspectRemotionStyle(source);
    const hit = seen.violations.filter((v) => v.rule === rule);
    assert.ok(hit.length > 0, `「${guide}」应当触发规则 ${rule}，实际：${JSON.stringify(seen.violations.map((v) => v.rule))}`);
    const r = author('ga-row', source);
    assert.equal(r.ok, false, `「${guide}」的样例应当被建卡拒绝`);
    for (const v of hit) {
      assert.ok(v.line >= 1);
      assert.ok(r.errors.some((e) => e.startsWith(`[remotion 式] 第 ${v.line} 行：`)), `「${guide}」的报错要指出第 ${v.line} 行`);
    }
  }
});

test('GA-02b 检查里的每个规则代号在指南里都有对应的行；对照表里的代号都真实存在', () => {
  const source = read('server/remotion-style-check.mjs');
  const inCode = new Set([...source.matchAll(/\bhit\(\s*[^,]+,\s*'([a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(inCode.size >= 13, `从检查源码里应读到全部 13 个规则代号，实际 ${[...inCode]}`);
  const inGuide = new Set(REJECTED.map((r) => r.rule));
  assert.deepEqual([...inGuide].sort(), [...inCode].sort(), '指南第 2.4 节覆盖检查里的每一个规则代号，一个不多一个不少');
  // 检查文件头那张规则表里列的代号也是这些
  const header = new Set([...source.slice(0, source.indexOf('import ts')).matchAll(/^ \* \| `([a-z-]+)` \|/gm)].map((m) => m[1]));
  assert.deepEqual([...header].sort(), [...inCode].sort(), '检查文件头的规则表和代码里实际用的代号一致');
});

/* ------------------------------------------------------------------ GA-03 */

test('GA-03 指南第 2.5 节「能引用的模块」和检查里的名单逐项相同', () => {
  const rows = tableRows(section('### 2.5'));
  const guideSpecs = rows.flatMap((r) => [...r[0].matchAll(/`([^`]+)`/g)].map((m) => m[1]));
  const asRepoPath = (spec) => {
    if (!spec.startsWith('.')) return spec;
    return path.posix.normalize(path.posix.join('src/cards/user', spec)).replace(/\/index$/, '');
  };
  assert.deepEqual(guideSpecs.map(asRepoPath).sort(), [...REMOTION_IMPORT_ALLOW].sort(), '指南名单 = REMOTION_IMPORT_ALLOW');
});

/* ------------------------------------------------------------------ GA-04 */

test('GA-04 指南第 2.1 节的工具表和框架的对外导出逐个相同', () => {
  const rows = tableRows(section('### 2.1'));
  const named = rows.flatMap((r) => [...r[0].matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]));
  const exported = Object.keys(F).sort();
  assert.deepEqual([...new Set(named)].sort(), exported, '指南里列的工具 = 框架对外导出的全部名字');
  // 指南里列的 Easing 成员都真的存在，反过来 Easing 里的成员也都列了
  const easingRow = rows.find((r) => r[0] === '`Easing`');
  const easingNames = [...easingRow[1].matchAll(/`([A-Za-z]+)(?:\(|`)/g)].map((m) => m[1]);
  for (const name of easingNames) assert.ok(name in F.Easing, `Easing.${name} 不存在`);
  assert.deepEqual([...new Set(easingNames)].sort(), Object.keys(F.Easing).sort(), 'Easing 的成员指南里一个不漏');
});

test('GA-04b 指南里写的缺省值和例子数字和代码对得上', () => {
  // interpolate：范围之外缺省停在端点；匀速；可以延伸
  assert.equal(F.interpolate(0.2, [0, 0.4], [0, 1]), 0.5);
  assert.equal(F.interpolate(9, [0, 0.4], [0, 1]), 1);
  assert.equal(F.interpolate(-3, [0, 0.4], [0, 1]), 0);
  assert.ok(F.interpolate(9, [0, 0.4], [0, 1], { extrapolateRight: 'extend' }) > 1);
  assert.throws(() => F.interpolate(0, [0], [1]));
  assert.throws(() => F.interpolate(0, [1, 0], [0, 1]));
  assert.throws(() => F.interpolate(0, [0, 1], [0, 1, 2]));
  // tween：from = 0、to = 1、delay = 0，缺省缓动 easeOut；开始前是 from，走完是 to
  assert.equal(F.tween(0, { duration: 1 }), 0);
  assert.equal(F.tween(5, { duration: 1 }), 1);
  assert.equal(F.tween(0.5, { duration: 1 }), F.Easing.easeOut(0.5));
  assert.notEqual(F.tween(0.5, { duration: 1 }), 0.5, '缺省缓动不是匀速');
  assert.equal(F.tween(0.1, { from: 40, to: 0, delay: 0.2, duration: 0.5 }), 40);
  assert.equal(F.tween(0.7, { from: 40, to: 0, delay: 0.2, duration: 0.5 }), 0);
  // interpolate 缺省匀速、tween 缺省 easeOut：同样的区间中点不一样
  assert.equal(F.interpolate(0.5, [0, 1], [0, 1]), 0.5);
  // spring：缺省 from 0、to 1、delay 之前是 from；clamp 缺省不夹（会过冲）
  assert.equal(F.spring(0, {}), 0);
  assert.equal(F.spring(0.1, { delay: 0.5, from: 3 }), 3);
  let overshoot = false;
  for (let i = 1; i < 120; i++) if (F.spring(i / 60, { stiffness: 180, damping: 12 }) > 1) overshoot = true;
  assert.ok(overshoot, '欠阻尼的弹簧缺省会过冲');
  for (let i = 1; i < 120; i++) assert.ok(F.spring(i / 60, { stiffness: 180, damping: 12, clamp: true }) <= 1, 'clamp: true 不过冲');
  assert.ok(Math.abs(F.springDuration({ stiffness: 180, damping: 12 }) - 1.17) < 0.01, 'springDuration 例子约 1.17');
  // stagger / staggerDuration
  assert.ok(F.stagger(0.1, 2, { each: 0.08 }) < 0, '还没轮到的元素是负数');
  assert.ok(Math.abs(F.stagger(0.16, 2, { each: 0.08 })) < 1e-12, '轮到的那一刻是 0');
  assert.throws(() => F.stagger(0, 0, { each: 0.1, from: 'center' }), /count/);
  assert.ok(Math.abs(F.staggerDuration(5, { each: 0.08 }, 0.4) - 0.72) < 1e-9, 'staggerDuration 例子 = 0.72');
  // random：必须给种子；[0,1)；同样的种子序号同样的数；randomInt 两头取得到
  assert.throws(() => F.random(), /种子|有限/);
  assert.throws(() => F.random(undefined, 1));
  const r = F.random(7, 3);
  assert.ok(r >= 0 && r < 1);
  assert.equal(F.random(7, 3), r);
  assert.notEqual(F.random(7, 3, 'hue'), r);
  const ints = new Set();
  for (let i = 0; i < 400; i++) ints.add(F.randomInt(1, 6, 9, i));
  assert.deepEqual([...ints].sort(), [1, 2, 3, 4, 5, 6]);
  for (let i = 0; i < 200; i++) assert.ok(Math.abs(F.noise(i * 0.37, 5, 'n')) <= 1);
  // loop / pingPong
  assert.equal(F.loop(5, 2), 1);
  assert.equal(F.pingPong(1.5, 1), 0.5);
  // 指南 2.1 表里写的取值范围与签名
  for (let i = 0; i <= 40; i++) { const v = F.pingPong(i * 0.13, 1); assert.ok(v >= 0 && v <= 1, 'pingPong 返回 [0, period]'); const w = F.loop(i * 0.37, 2); assert.ok(w >= 0 && w < 2, 'loop 返回 [0, period)'); }
  assert.equal(F.pingPong(1, 1), 1);
  assert.equal(F.tween(0.5, { duration: 0 }), 1, 'tween 的 duration 不大于 0：t 到了 delay 就是 to');
  assert.equal(F.tween(-1, { duration: 0 }), 0);
  assert.ok(Math.abs(F.staggerDuration(3, { each: 0.1, delay: 0.5 }, 0) - 0.7) < 1e-9, 'staggerDuration 把 delay 算进去');
  assert.equal(F.interpolate(5, [0, 1], [0, 1], { extrapolateRight: 'clamp' }), 1);
  assert.throws(() => F.interpolateColors(0, [0, 1], ['red', '#000']), /认不出/, 'interpolateColors 认不出颜色名会抛错');
  assert.throws(() => F.interpolateColors(0, [0, 1], ['hsl(0, 0%, 0%)', '#000']), /认不出/);
  // 颜色
  assert.equal(F.interpolateColors(0, [0, 1], ['#ff0000', '#0000ff']), 'rgba(255, 0, 0, 1)');
  assert.equal(F.interpolateColors(1, [0, 1], ['#ff0000', '#0000ff']), 'rgba(0, 0, 255, 1)');
});

/* ------------------------------------------------------------------ GA-05 */

test('GA-05 指南里 beginFrameWork 的片段放进一张卡里能过建卡检查', () => {
  const block = [...GUIDE.matchAll(/```tsx\n([\s\S]*?)\n```/g)].map((m) => m[1]).find((b) => b.includes('beginFrameWork("'));
  assert.ok(block, '指南里应有 beginFrameWork 的片段');
  const importLine = block.split('\n').find((l) => l.startsWith('import '));
  const body = block.split('\n').slice(block.split('\n').findIndex((l) => l.includes('// 组件里')) + 1).join('\n');
  const source = [
    'import "../../kernel/remotionStyle";',
    'import { useLayoutEffect, useMemo } from "react";',
    'import type { CardDef, CardProps } from "../../kernel/types";',
    importLine,
    'interface P { src: string }',
    'function C({ params, t = 0 }: CardProps<P>) {',
    '  const draw = (_img: HTMLImageElement, _t: number) => {};',
    body,
    '  return <div />;',
    '}',
    'export const c: CardDef<P> = { id: "ga-async", name: "n", description: "d", source: "user", frameMode: "direct", defaults: { src: "" }, controls: [{ key: "src", label: "图", type: "text" }], Component: C };',
    '',
  ].join('\n');
  const r = author('ga-async', source);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(inspectRemotionStyle(source).violations, []);
});

/* ------------------------------------------------------------------ GA-06 */

test('GA-06 指南不再说过时的话', () => {
  // frameMode 必填（建卡实际会拒绝没写的）
  const price = FULL.find((x) => idOf(x) === 'price-tag');
  assert.ok(price, '指南里有价格标签例子');
  const missing = cards.checkCardSource('no-mode', price.replace(/\n\s*frameMode:[^\n]*/, '').replace('price-tag', 'no-mode'), [], { mode: 'author', before: '' });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => /frameMode/.test(e)), '没写 frameMode 会被拒绝');
  assert.match(GUIDE, /\| `frameMode` \| ✓ \|/, '字段表里 frameMode 标必填');
  assert.doesNotMatch(GUIDE, /\| `frameMode` \| 建议 \|/);
  // 旧值都按 motion 式读
  assert.equal(normalizeFrameMode('react'), 'stateful');
  assert.equal(normalizeFrameMode('non-react'), 'stateful');
  assert.match(GUIDE, /旧值 `"react"`、`"non-react"` \*\*都按 motion 式读\*\*/);
  assert.doesNotMatch(GUIDE, /原 `frameMode: "react"` 按 `"direct"` 读取/);
  // 不规定优先用哪一种
  assert.doesNotMatch(GUIDE, /优先(使用|用|选)[^。\n]*(direct|remotion|motion)/i);
  assert.match(GUIDE, /没有哪一种更推荐/);
  // 中性：不暗示偏向，两个方向的改写都说到
  assert.doesNotMatch(GUIDE, /不要求改写成 remotion 式/);
  assert.doesNotMatch(GUIDE, /跳到哪一帧都一样」，用 remotion 式/);
  assert.match(GUIDE, /把 motion 式的卡改成 remotion 式[^。]*把 remotion 式的卡改成 motion 式/);
  assert.match(GUIDE, /内置卡里两种写法的都有，都不用改写/);
  assert.doesNotMatch(GUIDE, /PromptCut 里的 2D 动效卡只有两种写法/);
  // 必填参数的默认值：校验的是合并之后的结果，所以带非空默认值的 required 没有作用；例子里不能出现这种写法
  assert.match(GUIDE, /默认值非空的参数标 `required` 不起作用/);
  for (const ex of FULL) assert.doesNotMatch(ex, /required: true[^\n]*\n/, `例子 ${idOf(ex)} 里不该有「带非空默认值的 required」`);
  // 旧名词（「地图卡」「示意图卡」不是旧名词）
  assert.doesNotMatch(GUIDE.replace(/地图卡|示意图卡/g, ''), /图卡/, '指南里不再有旧名词「图卡」');
  // 补渲、烘焙、冻结
  assert.doesNotMatch(GUIDE, /烘焙|冻结|补渲/);
  // 不再一律劝人「动画交给 motion/react」：出现在 motion 式的语境里
  for (const m of GUIDE.matchAll(/动画交给 `motion\/react`/g)) {
    const before = GUIDE.slice(Math.max(0, m.index - 200), m.index);
    assert.match(before, /motion 式/, '「动画交给 motion/react」只能出现在讲 motion 式的地方');
  }
  // compositing：只有 independent 会被拒
  assert.match(GUIDE, /不要在源码里写 `compositing: 'independent'`/);
  // get_card_source 内置卡也能读
  assert.doesNotMatch(GUIDE, /get_card_source` 对它们会报错/);
});

/* ------------------------------------------------------------------ GA-07 */

test('GA-07 工具说明与 Agent 提示词里讲怎么写卡的地方和指南一致', () => {
  const tools = read('server/tools/cards.mjs');
  const descriptionOf = (name) => {
    const at = tools.indexOf(`name: "${name}",`);
    assert.ok(at >= 0, `server/tools/cards.mjs 里找不到 ${name}`);
    const m = /description: ("(?:[^"\\]|\\.)*")/.exec(tools.slice(at));
    assert.ok(m, `server/tools/cards.mjs 里找不到 ${name} 的说明`);
    return JSON.parse(m[1]);
  };
  const guideTool = descriptionOf('card_authoring_guide');
  const createTool = descriptionOf('create_card');
  const editTool = descriptionOf('edit_card');
  for (const [name, text] of [['card_authoring_guide', guideTool], ['create_card', createTool]]) {
    assert.match(text, /remotion 式/, `${name} 的说明要提到 remotion 式`);
    assert.match(text, /motion 式/, `${name} 的说明要提到 motion 式`);
    assert.match(text, /frameMode/, `${name} 的说明要提到必填的 frameMode`);
  }
  assert.match(editTool, /remotion 式/, 'edit_card 的说明要提到 remotion 式的卡按规矩检查');
  const prompt = read('server/ai-system-prompt.md');
  assert.match(prompt, /remotion 式/);
  assert.match(prompt, /frameMode/);
  assert.doesNotMatch(prompt, /动画交给 `?motion\/react`?/, '提示词不再一律劝人动画交给 motion/react');
  const cloud = read('server/agent/service/cloud-tools.mjs');
  assert.match(cloud, /frameMode/, '云端 Agent 的提示词要提到 frameMode');
});

test('GA-08 指南里「第 N.M 节」「N.M 节」「第 N 节」的引用都指向真有的标题', () => {
  const heads = new Set([...GUIDE.matchAll(/^#{2,3} (\d+(?:\.\d+)?)[ .]/gm)].map((m) => m[1]));
  const bad = [];
  for (const m of GUIDE.matchAll(/第?\s*(\d+\.\d+)\s*节/g)) if (!heads.has(m[1])) bad.push(m[0]);
  for (const m of GUIDE.matchAll(/第\s*(\d+)\s*节/g)) if (!heads.has(m[1])) bad.push(m[0]);
  assert.deepEqual(bad, [], '引用了不存在的小节');
  // 指南的 12 个标题编号没有缺号
  for (const n of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "2.1", '2.6', '3.1', '4.1', '4.7', '8.1']) assert.ok(heads.has(n), `缺标题 ${n}`);
});

test('GA-09 指南里的每一处「第 N.M 节」指的内容和标题对得上（抽查几处关键引用）', () => {
  const titleOf = (n) => new RegExp(`^#{2,3} ${n.replace('.', '\\.')}[ .]([^\\n]*)`, 'm').exec(GUIDE)?.[1] ?? '';
  assert.match(titleOf('4.3'), /素材效果卡路线/);
  assert.match(titleOf('4.2'), /默认值规则/);
  assert.match(titleOf('4.4'), /部件树与生命周期/);
  assert.match(titleOf('4.6'), /素材封装卡/);
  assert.match(titleOf('2.4'), /当场拒绝/);
  assert.match(titleOf('2.5'), /可以引用的模块/);
  assert.match(GUIDE, /素材目录里的 Lottie 已经是现成的卡，见 4\.6 节/);
  assert.match(GUIDE, /素材效果卡路线|第 4\.3 节/);
});
