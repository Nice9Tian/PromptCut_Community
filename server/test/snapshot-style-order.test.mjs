/**
 * X6(`docs/plan/m6c-contract.md`):快照的内联 style 按属性名的确定顺序输出,与浏览器枚举
 * `CSSStyleDeclaration` 的顺序无关 —— 同样的内容在不同进程里得到同样的块哈希。
 *
 * 转译 `src/render/snapshot/inlineStyles.ts` 后直接跑,不起浏览器:`getComputedStyle` / `document`
 * 换成最小的假实现,同一份计算样式按不同的枚举顺序喂两遍,比克隆体上写出的 style 串。
 * 真浏览器、两个预渲染进程的逐张比对原先在 `scripts/probes/snapshot-hash-probe.mjs`；那支探针 2026-10-23 已删
 * （它要求 `snapshotTier() === 'shared'`，而每张卡的快照 2026-10-16 撤掉后该函数恒回 `'none'`，整支必然失败）。
 * 删除依据与当时的读数见 `docs/reports/AGENT-claude-probe-audit.md`。本文件的断言不依赖它。
 *
 * 跑法:node --test server/test/snapshot-style-order.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-style-order-test-'));
const propsUrl = pathToFileURL(path.join(ROOT, 'src', 'render', 'snapshot', 'snapshotStyleProps.mjs')).href;
const src = fs.readFileSync(path.join(ROOT, 'src', 'render', 'snapshot', 'inlineStyles.ts'), 'utf8')
  .split('from "./snapshotStyleProps.mjs"').join(`from "${propsUrl}"`);
const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
fs.writeFileSync(path.join(OUT, 'inlineStyles.mjs'), js);
const { serializeDeclarations, inlineDOMStyles, STOP_CLOCKS } = await import(pathToFileURL(path.join(OUT, 'inlineStyles.mjs')).href);

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const sha = text => createHash('sha256').update(text).digest('hex');

/** 确定的伪随机洗牌(种子不同 → 顺序不同),不引依赖 */
function shuffled(list, seed) {
  const out = [...list];
  let s = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ------------------------------------------------------------------ 假 DOM */

/** 计算样式:`entries` 的顺序就是枚举顺序 */
function fakeComputed(entries) {
  const names = entries.map(([name]) => name);
  const values = new Map(entries);
  return {
    length: names.length,
    item: i => names[i],
    getPropertyValue: name => values.get(name) ?? '',
    zoom: values.get('zoom') ?? '1',
  };
}

class FakeElement {
  constructor(tag, { computed = [], inline = [], attrs = {} } = {}) {
    this.tagName = tag.toUpperCase();
    this.namespaceURI = HTML_NS;
    this.parentElement = null;
    this.children = [];
    this.computed = computed;
    this.attrs = new Map(Object.entries(attrs));
    this.style = { length: inline.length, item: i => inline[i] };
  }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  hasAttribute(name) { return this.attrs.has(name); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  remove() {
    const parent = this.parentElement;
    if (parent) parent.children = parent.children.filter(c => c !== this);
    this.parentElement = null;
  }
  getAnimations() { return []; }
}

/** 同标签基线:探针元素的计算样式(`ensureBaselines` 经 `document.createElement` 造) */
const BASELINE = {
  DIV: [['color', 'rgb(0, 0, 0)'], ['display', 'block'], ['opacity', '1'], ['position', 'static'], ['will-change', 'auto']],
  SPAN: [['color', 'rgb(0, 0, 0)'], ['display', 'inline'], ['opacity', '1'], ['position', 'static'], ['will-change', 'auto']],
};

function installDom() {
  const prevDocument = globalThis.document;
  const prevGcs = globalThis.getComputedStyle;
  globalThis.document = {
    createElement: tag => new FakeElement(tag, { computed: BASELINE[tag.toUpperCase()] ?? [] }),
    createElementNS: (_ns, tag) => new FakeElement(tag, { computed: [] }),
  };
  globalThis.getComputedStyle = el => fakeComputed(el.computed);
  return () => { globalThis.document = prevDocument; globalThis.getComputedStyle = prevGcs; };
}

/**
 * 一张小卡:场景根 → div(自定义属性若干 + 前缀属性 + mask-position 简写)→ span。
 * `order(entries, who)` 决定每个元素计算样式的枚举顺序 —— 模拟两个进程里浏览器给出的不同顺序。
 */
function buildTree(order) {
  const rootComputed = [['color', 'rgb(255, 255, 255)'], ['display', 'block'], ['font-size', '16px'], ['--accent', '#39f'], ['--pad', '12px']];
  const divComputed = [
    ['color', 'rgb(255, 255, 255)'], ['display', 'flex'], ['font-size', '16px'], ['mask-position', '0% 0%'], ['opacity', '0.5'],
    ['position', 'absolute'], ['width', '823.5px'], ['will-change', 'auto'],
    ['-webkit-mask-position-x', '0%'], ['-webkit-mask-position-y', '0%'], ['-webkit-text-fill-color', 'rgb(255, 0, 0)'], ['-webkit-writing-mode', 'horizontal-tb'],
    ['--accent', '#39f'], ['--pad', '12px'], ['--z-last', '1'], ['--a-first', '2'], ['--mid', 'calc(1px + 2px)'],
  ];
  const spanComputed = [['color', 'rgb(255, 0, 0)'], ['display', 'inline'], ['font-size', '16px'], ['opacity', '1'], ['--accent', '#39f'], ['--pad', '12px'], ['--span-only', 'x']];
  const root = new FakeElement('div', { computed: order(rootComputed, 'root'), attrs: { 'data-pc-scene': '' } });
  const div = root.appendChild(new FakeElement('div', { computed: order(divComputed, 'div'), inline: ['opacity'] }));
  const span = div.appendChild(new FakeElement('span', { computed: order(spanComputed, 'span') }));
  const orig = [root, div, span];
  const copy = orig.map(el => new FakeElement(el.tagName.toLowerCase()));
  return { root, orig, copy };
}

function styleStrings(order) {
  const restore = installDom();
  try {
    const { root, orig, copy } = buildTree(order);
    inlineDOMStyles(root, orig, copy);
    return copy.map(el => el.getAttribute('style'));
  } finally { restore(); }
}

/* ------------------------------------------------------------------ 用例 */

test('X6-1 serializeDeclarations:同一组声明不论先后,拼出同一个串', () => {
  const decls = [['width', '10px'], ['--b', '1'], ['-webkit-text-fill-color', 'red'], ['color', 'red'], ['--a', '2'], ['align-items', 'center'], ['-webkit-box-flex', '0']];
  const want = serializeDeclarations([...decls]);
  for (let seed = 1; seed <= 50; seed++) assert.equal(serializeDeclarations(shuffled(decls, seed)), want, `种子 ${seed}`);
});

test('X6-2 顺序是「标准属性、前缀属性、自定义属性」三组,组内按 UTF-16 码元序', () => {
  const text = serializeDeclarations([
    ['--z', '1'], ['width', '1px'], ['-webkit-writing-mode', 'horizontal-tb'], ['--A', '2'], ['--a', '3'],
    ['align-items', 'center'], ['-webkit-mask-position-x', '0%'], ['mask-position', '0% 0%'], ['Z-upper', 'x'],
  ]);
  assert.equal(text, 'Z-upper:x;align-items:center;mask-position:0% 0%;width:1px;'
    + '-webkit-mask-position-x:0%;-webkit-writing-mode:horizontal-tb;'
    + '--A:2;--a:3;--z:1;');
});

test('X6-3 标准段、前缀段的先后与 Chrome 自己的枚举一致(简写 mask-position 仍在 -webkit-mask-position-x/y 之前)', () => {
  // Chrome 152 的枚举:标准属性按字母、前缀属性按字母、自定义属性(本分支报告 X6 一节的实测)
  const chromeOrder = [['align-items', 'center'], ['mask-position', '0% 0%'], ['writing-mode', 'horizontal-tb'],
    ['-webkit-mask-position-x', '0%'], ['-webkit-mask-position-y', '0%'], ['-webkit-writing-mode', 'horizontal-tb']];
  const old = chromeOrder.map(([p, v]) => `${p}:${v};`).join('');
  assert.equal(serializeDeclarations(shuffled(chromeOrder, 7)), old, '没有自定义属性时,输出与按 Chrome 枚举顺序拼的旧串逐字节相同');
});

test('X6-4 inlineDOMStyles:计算样式的枚举顺序不同(模拟两个进程),克隆体上的 style 串逐字节相同', () => {
  const asIs = styleStrings(entries => entries);
  const reversed = styleStrings(entries => [...entries].reverse());
  const hashes = new Set([asIs, reversed].map(list => sha(list.join('\n'))));
  for (let seed = 1; seed <= 20; seed++) hashes.add(sha(styleStrings((entries, who) => shuffled(entries, seed * 31 + who.length)).join('\n')));
  assert.equal(hashes.size, 1, '22 种枚举顺序应当只得出一种快照');
  for (const text of asIs) assert.ok(text.endsWith(STOP_CLOCKS), '末尾仍是停钟那一条');
  // 判据没变:自己新加的自定义属性照写,和父元素相同的(--accent、--pad)照省;三组的先后照 X6-2
  assert.equal(asIs[1], 'display:flex;mask-position:0% 0%;opacity:0.5;position:absolute;width:823.5px;'
    + '-webkit-mask-position-x:0%;-webkit-mask-position-y:0%;-webkit-text-fill-color:rgb(255, 0, 0);-webkit-writing-mode:horizontal-tb;'
    + '--a-first:2;--mid:calc(1px + 2px);--z-last:1;' + STOP_CLOCKS);
  assert.doesNotMatch(asIs[2], /font-size/, '和父元素相同的继承属性照旧省掉');
  assert.match(asIs[1], /opacity:0\.5;/, '自带内联样式的属性照旧强制内联');
});

test('X6-5 will-change 合并后按名字落位,只出现一次', () => {
  const decls = [['--x', '1'], ['opacity', '0.5'], ['will-change', 'transform, opacity'], ['color', 'red']];
  const text = serializeDeclarations(decls);
  assert.equal(text, 'color:red;opacity:0.5;will-change:transform, opacity;--x:1;');
  assert.equal(text.split('will-change').length - 1, 1);
});
