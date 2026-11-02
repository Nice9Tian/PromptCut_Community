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
  assert.ok(start >= 0, `cannot find the section "${heading}" in the guide`);
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

const FULL = [...GUIDE.matchAll(/```tsx complete card\n([\s\S]*?)\n```/g)].map((m) => m[1]);

test('GA-01 code examples in the guide marked "complete card" each pass the card-creation check', () => {
  // 三个 remotion 式的例子、三个素材效果卡例子、一个 motion 式的例子
  assert.equal(FULL.length, 7, 'the guide should have 7 complete card examples');
  const ids = new Set();
  const modes = [];
  for (const source of FULL) {
    const id = idOf(source);
    assert.ok(!ids.has(id), `duplicate example id: ${id}`);
    ids.add(id);
    const r = author(id, source);
    assert.deepEqual(r.errors, [], `guide example ${id} should pass the card-creation check`);
    assert.equal(r.ok, true);
    modes.push(/frameMode:\s*"(direct|stateful)"/.exec(source)?.[1]);
  }
  assert.deepEqual(modes.filter((m) => m === 'direct').length, 6, '6 remotion-style (3 motion cards + 3 media effect cards)');
  assert.deepEqual(modes.filter((m) => m === 'stateful').length, 1, '1 motion-style');
  // 声明成 remotion 式的，按 remotion 式的规矩查，一条违规都没有
  for (const source of FULL.filter((s) => /frameMode:\s*"direct"/.test(s))) {
    const r = inspectRemotionStyle(source);
    assert.equal(r.declared, 'direct');
    assert.deepEqual(r.violations, [], `${idOf(source)} should have no violations`);
  }
});

test('GA-01b the three remotion-style examples match the sample cards in the test fixtures (only missing the explanatory line at the top of the fixture)', () => {
  const guideBlocks = new Map(FULL.map((s) => [idOf(s), s]));
  for (const name of ['rs-title-reveal', 'rs-bar-race', 'rs-orbit-canvas']) {
    const fixture = read(`server/test/fixtures/remotion-style/${name}.tsx`).replace(/^\/\*\*[^\n]*\*\/\n/, '').trimEnd();
    assert.equal(guideBlocks.get(name), fixture, `${name} in the guide must match the fixture`);
  }
});

test('GA-01c the three media effect card examples do not use the framework\'s tools, so each writes a single bare import; they import only modules on the list', () => {
  for (const id of ['invert-filter', 'crossfade', 'gain-audio']) {
    const source = FULL.find((s) => idOf(s) === id);
    assert.ok(source, `missing example ${id}`);
    assert.match(source, /^import "\.\.\/\.\.\/kernel\/remotionStyle";$/m, `${id} must have one bare import line`);
    assert.ok(!/from\s+"[^"]*remotionStyle"/.test(source), `${id} does not use the framework's tools, only a bare import`);
    assert.match(source, /frameMode:\s*"direct"/);
    assert.deepEqual(inspectRemotionStyle(source).violations, [], id);
    assert.deepEqual(inspectRemotionStyle(source.replace('import "../../kernel/remotionStyle";\n', '')).violations.map((v) => v.rule), ['framework'], `${id} should be rejected once the bare import is removed`);
    const specs = [...source.matchAll(/(?:from|^import)\s+"([^"]+)"/gm)].map((m) => m[1]);
    for (const spec of specs) {
      const at = path.posix.normalize(path.posix.join('src/cards/user', spec)).replace(/\/index$/, '');
      assert.ok(REMOTION_IMPORT_ALLOW.includes(at), `${id} imports ${spec}, which is not on the list`);
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
  { guide: 'Importing modules outside the list (including helper files in the same directory `./xxx`, style files, third-party libraries not on the list), dynamic `import()`, `require()`', rule: 'import', source: cardWith({ imports: 'import lottie from "lottie-web";' }) },
  { guide: '`motion` / `motion/react`, `<motion.div>`, and interaction props such as `whileHover`', rule: 'motion', source: cardWith({ imports: 'import { motion } from "motion/react";', jsx: '<motion.div animate={{ opacity: 1 }} />' }) },
  { guide: '`<AnimatePresence>`', rule: 'presence', source: cardWith({ jsx: '<AnimatePresence><div /></AnimatePresence>' }) },
  { guide: 'CSS animations and transitions: `animation*` and `transition*` in styles; `@keyframes` in style text; class names `animate-*` and `transition*`; an element\'s `.animate()`; SVG `<animate>`', rule: 'css-animation', source: cardWith({ jsx: '<div style={{ transition: "opacity 1s" }} />' }) },
  { guide: '`Date.now()`, `new Date()` without arguments, `performance`', rule: 'real-time', source: cardWith({ body: '  const n = Date.now();' }) },
  { guide: '`setTimeout`, `setInterval`, `setImmediate`, `requestIdleCallback`', rule: 'timer', source: cardWith({ body: '  setTimeout(() => {}, 10);' }) },
  { guide: '`requestAnimationFrame`, `cancelAnimationFrame`, `setAnimationLoop`, `requestVideoFrameCallback`', rule: 'frame-callback', source: cardWith({ body: '  requestAnimationFrame(() => {});' }) },
  { guide: '`Math.random`, `crypto`', rule: 'random', source: cardWith({ body: '  const r = Math.random();' }) },
  { guide: '`useState` and other hooks that keep state', rule: 'state', source: cardWith({ imports: 'import { useState } from "react";', body: '  const [n] = useState(0);' }) },
  { guide: '`useRef(initial value)`, writing to `.current`', rule: 'state', source: cardWith({ body: '  const r = useRef(0);' }) },
  { guide: 'Writing to top-level names or imported things (assignment, increment, `delete`, mutating methods such as `push`, `Object.assign`)', rule: 'state', source: cardWith({ top: 'const BOX = { n: 0 };', body: '  BOX.n += 1;' }) },
  { guide: 'Global objects such as `window`, `globalThis`, `self`, `localStorage`, plus `eval`, `Function()`', rule: 'state', source: cardWith({ body: '  const w = window;' }) },
  { guide: 'Top-level `let` / `var` / `class` / `enum`, directly executed statements, and `new`, `await`, assignments in top-level initializers', rule: 'top-level', source: cardWith({ top: 'let n = 0;' }) },
  { guide: '`IntersectionObserver`', rule: 'viewport', source: cardWith({ body: '  const o = new IntersectionObserver(() => {});' }) },
  { guide: '`frameMode` written as a variable or a computed value', rule: 'frame-mode', source: cardWith({ top: 'const MODES = ["direct"] as const;', mode: 'MODES[0]' }) },
  { guide: 'No import statement that references the framework (a type-only `import type …` does not count)', rule: 'framework', source: cardWith({ framework: false }) },
];

test('GA-02 each row in section 2.4 of the guide corresponds to a rule code of the check, and the sample is really rejected with the line number pointed out', () => {
  const base = author('ga-row', cardWith());
  assert.deepEqual(base.errors, [], 'the compliant reference card used for comparison must itself pass');

  const rows = tableRows(section('### 2.4'));
  assert.deepEqual(rows.map((r) => r[0]), REJECTED.map((r) => r.guide), 'the rows in section 2.4 of the guide match the mapping table row by row (same order)');
  for (const row of rows) assert.equal(row.length, 3, `three cells per row: ${row[0]}`);

  for (const { guide, rule, source } of REJECTED) {
    const seen = inspectRemotionStyle(source);
    const hit = seen.violations.filter((v) => v.rule === rule);
    assert.ok(hit.length > 0, `"${guide}" should trigger rule ${rule}, actual: ${JSON.stringify(seen.violations.map((v) => v.rule))}`);
    const r = author('ga-row', source);
    assert.equal(r.ok, false, `the sample for "${guide}" should be rejected by card creation`);
    for (const v of hit) {
      assert.ok(v.line >= 1);
      assert.ok(r.errors.some((e) => e.startsWith(`[Remotion-style] line ${v.line}:`)), `the error for "${guide}" must point out line ${v.line}`);
    }
  }
});

test('GA-02b every rule code in the check has a corresponding row in the guide; every code in the mapping table really exists', () => {
  const source = read('server/remotion-style-check.mjs');
  const inCode = new Set([...source.matchAll(/\bhit\(\s*[^,]+,\s*'([a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(inCode.size >= 13, `all 13 rule codes should be read from the check source, actual ${[...inCode]}`);
  const inGuide = new Set(REJECTED.map((r) => r.rule));
  assert.deepEqual([...inGuide].sort(), [...inCode].sort(), 'section 2.4 of the guide covers every rule code in the check, no more and no fewer');
  // 检查文件头那张规则表里列的代号也是这些
  const header = new Set([...source.slice(0, source.indexOf('import ts')).matchAll(/^ \* \| `([a-z-]+)` \|/gm)].map((m) => m[1]));
  assert.deepEqual([...header].sort(), [...inCode].sort(), 'the rule table in the check file header matches the codes actually used in the code');
});

/* ------------------------------------------------------------------ GA-03 */

test('GA-03 "modules that can be imported" in section 2.5 of the guide match the list in the check item by item', () => {
  const rows = tableRows(section('### 2.5'));
  const guideSpecs = rows.flatMap((r) => [...r[0].matchAll(/`([^`]+)`/g)].map((m) => m[1]));
  const asRepoPath = (spec) => {
    if (!spec.startsWith('.')) return spec;
    return path.posix.normalize(path.posix.join('src/cards/user', spec)).replace(/\/index$/, '');
  };
  assert.deepEqual(guideSpecs.map(asRepoPath).sort(), [...REMOTION_IMPORT_ALLOW].sort(), 'guide list = REMOTION_IMPORT_ALLOW');
});

/* ------------------------------------------------------------------ GA-04 */

test('GA-04 the tool table in section 2.1 of the guide matches the framework\'s public exports one by one', () => {
  const rows = tableRows(section('### 2.1'));
  const named = rows.flatMap((r) => [...r[0].matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]));
  const exported = Object.keys(F).sort();
  assert.deepEqual([...new Set(named)].sort(), exported, 'tools listed in the guide = all names exported by the framework');
  // 指南里列的 Easing 成员都真的存在，反过来 Easing 里的成员也都列了
  const easingRow = rows.find((r) => r[0] === '`Easing`');
  const easingNames = [...easingRow[1].matchAll(/`([A-Za-z]+)(?:\(|`)/g)].map((m) => m[1]);
  for (const name of easingNames) assert.ok(name in F.Easing, `Easing.${name} does not exist`);
  assert.deepEqual([...new Set(easingNames)].sort(), Object.keys(F.Easing).sort(), 'the guide misses none of the Easing members');
});

test('GA-04b the defaults and example numbers written in the guide agree with the code', () => {
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
  assert.notEqual(F.tween(0.5, { duration: 1 }), 0.5, 'the default easing is not linear');
  assert.equal(F.tween(0.1, { from: 40, to: 0, delay: 0.2, duration: 0.5 }), 40);
  assert.equal(F.tween(0.7, { from: 40, to: 0, delay: 0.2, duration: 0.5 }), 0);
  // interpolate 缺省匀速、tween 缺省 easeOut：同样的区间中点不一样
  assert.equal(F.interpolate(0.5, [0, 1], [0, 1]), 0.5);
  // spring：缺省 from 0、to 1、delay 之前是 from；clamp 缺省不夹（会过冲）
  assert.equal(F.spring(0, {}), 0);
  assert.equal(F.spring(0.1, { delay: 0.5, from: 3 }), 3);
  let overshoot = false;
  for (let i = 1; i < 120; i++) if (F.spring(i / 60, { stiffness: 180, damping: 12 }) > 1) overshoot = true;
  assert.ok(overshoot, 'an underdamped spring overshoots by default');
  for (let i = 1; i < 120; i++) assert.ok(F.spring(i / 60, { stiffness: 180, damping: 12, clamp: true }) <= 1, 'clamp: true does not overshoot');
  assert.ok(Math.abs(F.springDuration({ stiffness: 180, damping: 12 }) - 1.17) < 0.01, 'the springDuration example is about 1.17');
  // stagger / staggerDuration
  assert.ok(F.stagger(0.1, 2, { each: 0.08 }) < 0, 'an element whose turn has not come is negative');
  assert.ok(Math.abs(F.stagger(0.16, 2, { each: 0.08 })) < 1e-12, 'the moment its turn comes it is 0');
  assert.throws(() => F.stagger(0, 0, { each: 0.1, from: 'center' }), /count/);
  assert.ok(Math.abs(F.staggerDuration(5, { each: 0.08 }, 0.4) - 0.72) < 1e-9, 'the staggerDuration example = 0.72');
  // random：必须给种子；[0,1)；同样的种子序号同样的数；randomInt 两头取得到
  assert.throws(() => F.random(), /seed|finite/);
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
  for (let i = 0; i <= 40; i++) { const v = F.pingPong(i * 0.13, 1); assert.ok(v >= 0 && v <= 1, 'pingPong returns [0, period]'); const w = F.loop(i * 0.37, 2); assert.ok(w >= 0 && w < 2, 'loop returns [0, period)'); }
  assert.equal(F.pingPong(1, 1), 1);
  assert.equal(F.tween(0.5, { duration: 0 }), 1, 'when tween\'s duration is not greater than 0: once t reaches delay the value is to');
  assert.equal(F.tween(-1, { duration: 0 }), 0);
  assert.ok(Math.abs(F.staggerDuration(3, { each: 0.1, delay: 0.5 }, 0) - 0.7) < 1e-9, 'staggerDuration includes the delay');
  assert.equal(F.interpolate(5, [0, 1], [0, 1], { extrapolateRight: 'clamp' }), 1);
  assert.throws(() => F.interpolateColors(0, [0, 1], ['red', '#000']), /cannot recognize/, 'interpolateColors throws on color names it cannot recognize');
  assert.throws(() => F.interpolateColors(0, [0, 1], ['hsl(0, 0%, 0%)', '#000']), /cannot recognize/);
  // 颜色
  assert.equal(F.interpolateColors(0, [0, 1], ['#ff0000', '#0000ff']), 'rgba(255, 0, 0, 1)');
  assert.equal(F.interpolateColors(1, [0, 1], ['#ff0000', '#0000ff']), 'rgba(0, 0, 255, 1)');
});

/* ------------------------------------------------------------------ GA-05 */

test('GA-05 the beginFrameWork snippet in the guide passes the card-creation check when placed in a card', () => {
  const block = [...GUIDE.matchAll(/```tsx\n([\s\S]*?)\n```/g)].map((m) => m[1]).find((b) => b.includes('beginFrameWork("'));
  assert.ok(block, 'the guide should have a beginFrameWork snippet');
  const importLine = block.split('\n').find((l) => l.startsWith('import '));
  const body = block.split('\n').slice(block.split('\n').findIndex((l) => l.includes('// in the component')) + 1).join('\n');
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
    'export const c: CardDef<P> = { id: "ga-async", name: "n", description: "d", source: "user", frameMode: "direct", defaults: { src: "" }, controls: [{ key: "src", label: "Image", type: "text" }], Component: C };',
    '',
  ].join('\n');
  const r = author('ga-async', source);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(inspectRemotionStyle(source).violations, []);
});

/* ------------------------------------------------------------------ GA-06 */

test('GA-06 the guide no longer says outdated things', () => {
  // frameMode 必填（建卡实际会拒绝没写的）
  const price = FULL.find((x) => idOf(x) === 'price-tag');
  assert.ok(price, 'the guide has a price tag example');
  const missing = cards.checkCardSource('no-mode', price.replace(/\n\s*frameMode:[^\n]*/, '').replace('price-tag', 'no-mode'), [], { mode: 'author', before: '' });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => /frameMode/.test(e)), 'omitting frameMode gets rejected');
  assert.match(GUIDE, /\| `frameMode` \| ✓ \|/, 'the field table marks frameMode as required');
  assert.doesNotMatch(GUIDE, /\| `frameMode` \| recommended \|/);
  // 旧值都按 motion 式读
  assert.equal(normalizeFrameMode('react'), 'stateful');
  assert.equal(normalizeFrameMode('non-react'), 'stateful');
  assert.match(GUIDE, /old values `"react"` and `"non-react"` \*\*are both read as motion-style\*\*/);
  assert.doesNotMatch(GUIDE, /original `frameMode: "react"` is read as `"direct"`/);
  // 不规定优先用哪一种
  assert.doesNotMatch(GUIDE, /prefer (to )?(use|using|choose|choosing)[^.\n]*(direct|remotion|motion)/i);
  assert.match(GUIDE, /neither is more recommended/);
  // 中性：不暗示偏向，两个方向的改写都说到
  assert.doesNotMatch(GUIDE, /does not require rewriting as remotion-style/);
  assert.doesNotMatch(GUIDE, /the same at whichever frame you jump to", use remotion-style/);
  assert.match(GUIDE, /change a motion-style card into remotion-style[^.]*change a remotion-style card into motion-style/);
  assert.match(GUIDE, /built-in cards include both styles, neither needs rewriting/);
  assert.doesNotMatch(GUIDE, /2D motion cards in PromptCut have only two styles/);
  // 必填参数的默认值：校验的是合并之后的结果，所以带非空默认值的 required 没有作用；例子里不能出现这种写法
  assert.match(GUIDE, /marking a parameter with a non-empty default as `required` has no effect/);
  for (const ex of FULL) assert.doesNotMatch(ex, /required: true[^\n]*\n/, `example ${idOf(ex)} should not contain "required with a non-empty default"`);
  // 旧名词（「地图卡」「示意图卡」不是旧名词）
  assert.doesNotMatch(GUIDE.replace(/map card|diagram card/g, ''), /image card/, 'the guide no longer contains the old term "image card"');
  // 补渲、烘焙、冻结
  assert.doesNotMatch(GUIDE, /bak(e|ed|ing)|freez(e|ing)|frozen|catch-up render/);
  // 不再一律劝人「动画交给 motion/react」：出现在 motion 式的语境里
  for (const m of GUIDE.matchAll(/leave animation to `motion\/react`/g)) {
    const before = GUIDE.slice(Math.max(0, m.index - 200), m.index);
    assert.match(before, /motion-style/, '"leave animation to motion/react" may only appear where motion-style is discussed');
  }
  // compositing：只有 independent 会被拒
  assert.match(GUIDE, /do not write `compositing: 'independent'` in the source code/);
  // get_card_source 内置卡也能读
  assert.doesNotMatch(GUIDE, /get_card_source` will report an error for them/);
});

/* ------------------------------------------------------------------ GA-07 */

test('GA-07 the parts of the tool descriptions and Agent prompts that explain how to write cards agree with the guide', () => {
  const tools = read('server/tools/cards.mjs');
  const descriptionOf = (name) => {
    const at = tools.indexOf(`name: "${name}",`);
    assert.ok(at >= 0, `cannot find ${name} in server/tools/cards.mjs`);
    const m = /description: ("(?:[^"\\]|\\.)*")/.exec(tools.slice(at));
    assert.ok(m, `cannot find the description of ${name} in server/tools/cards.mjs`);
    return JSON.parse(m[1]);
  };
  const guideTool = descriptionOf('card_authoring_guide');
  const createTool = descriptionOf('create_card');
  const editTool = descriptionOf('edit_card');
  for (const [name, text] of [['card_authoring_guide', guideTool], ['create_card', createTool]]) {
    assert.match(text, /remotion-style/, `the description of ${name} must mention remotion-style`);
    assert.match(text, /motion-style/, `the description of ${name} must mention motion-style`);
    assert.match(text, /frameMode/, `the description of ${name} must mention the required frameMode`);
  }
  assert.match(editTool, /remotion-style/, 'the description of edit_card must mention that remotion-style cards are checked against the rules');
  const prompt = read('server/ai-system-prompt.md');
  assert.match(prompt, /remotion-style/);
  assert.match(prompt, /frameMode/);
  assert.doesNotMatch(prompt, /leave animation to `?motion\/react`?/, 'the prompt no longer advises leaving animation to motion/react in every case');
  const cloud = read('server/agent/service/cloud-tools.mjs');
  assert.match(cloud, /frameMode/, 'the Cloud Agent prompt must mention frameMode');
});

test('GA-08 references in the guide such as "section N.M" and "section N" all point to headings that really exist', () => {
  const heads = new Set([...GUIDE.matchAll(/^#{2,3} (\d+(?:\.\d+)?)[ .]/gm)].map((m) => m[1]));
  const bad = [];
  for (const m of GUIDE.matchAll(/section\s*(\d+\.\d+)/g)) if (!heads.has(m[1])) bad.push(m[0]);
  for (const m of GUIDE.matchAll(/section\s*(\d+)/g)) if (!heads.has(m[1])) bad.push(m[0]);
  assert.deepEqual(bad, [], 'references sections that do not exist');
  // 指南的 12 个标题编号没有缺号
  for (const n of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "2.1", '2.6', '3.1', '4.1', '4.7', '8.1']) assert.ok(heads.has(n), `missing heading ${n}`);
});

test('GA-09 every "section N.M" reference in the guide matches the content of its heading (spot-checking a few key references)', () => {
  const titleOf = (n) => new RegExp(`^#{2,3} ${n.replace('.', '\\.')}[ .]([^\\n]*)`, 'm').exec(GUIDE)?.[1] ?? '';
  assert.match(titleOf('4.3'), /media effect card route/);
  assert.match(titleOf('4.2'), /default value rules/);
  assert.match(titleOf('4.4'), /part tree and lifecycle/);
  assert.match(titleOf('4.6'), /media wrapper card/);
  assert.match(titleOf('2.4'), /rejected on the spot/);
  assert.match(titleOf('2.5'), /modules that can be imported/);
  assert.match(GUIDE, /Lottie in the asset catalog is already a ready-made card, see section 4\.6/);
  assert.match(GUIDE, /media effect card route|section 4\.3/);
});
