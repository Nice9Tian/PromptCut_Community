// Agent 读 / 改卡片源码(0.4 起内置卡也能改)和只读 DOM 树用到的纯函数。
// 转译 server/vite-plugin-cards.ts 后直接跑,不需要浏览器或 dev server。
// 跑法:node --test server/test/card-source.test.mjs
//
// 这些函数错了都不会报错:找错文件就改错卡,闭包漏了范围就开出去一个改内核的口子,
// 行号换算错了模型就对着别的行改。所以把几条钉死。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-card-source-test-'));

let src = fs.readFileSync(path.join(ROOT, 'server/vite-plugin-cards.ts'), 'utf8');
src = src.split("from 'typescript'").join(`from '${pathToFileURL(require_.resolve('typescript')).href}'`);
// 插件里同目录的 .mjs(http-guard、card-overrides、prerender-client……)转译到临时目录后要指回 server/ 下的原文件
// (子目录里的也一样:`./hosted-render/source-gate.mjs`)
src = src.replace(/from '\.\/([\w/-]+\.mjs)'/g, (_m, f) => `from '${pathToFileURL(path.join(ROOT, 'server', f)).href}'`);
src = src.replace(/from '(\.\.\/src\/[^']+\.mjs)'/g, (_m, f) => `from '${pathToFileURL(path.resolve(ROOT, 'server', f)).href}'`);
const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
fs.writeFileSync(path.join(OUT, 'plugin.mjs'), js);
const {
  isEditablePath, findCardFile, importClosure, sharedByCounts, checkSourceEdit,
  decodeMappings, originalPosition, formatDomTree, isolateClipForDom,
} = await import(pathToFileURL(path.join(OUT, 'plugin.mjs')).href);

// ── 找文件 ────────────────────────────────────────────────────────
test('内置卡按 id 找到定义文件', () => {
  assert.equal(findCardFile(ROOT, 'rank-bars'), 'src/cards/native/rank-bars.tsx');
  assert.equal(findCardFile(ROOT, 'mu-number-ticker'), 'src/cards/magicui/number-ticker.card.tsx');
});

test('不存在的 id、带路径的 id 一律找不到', () => {
  assert.equal(findCardFile(ROOT, 'no-such-card-xyz'), null);
  assert.equal(findCardFile(ROOT, '../render/Stage'), null);
});

// ── 能改的范围 ────────────────────────────────────────────────────
test('只开到卡片目录和部件库,内核 / 测试 / 越界路径一律不开', () => {
  assert.equal(isEditablePath('src/cards/native/hud.css'), true);
  assert.equal(isEditablePath('src/parts/lib/chart-rank.tsx'), true);
  assert.equal(isEditablePath('src/render/Stage.tsx'), false);
  assert.equal(isEditablePath('server/vite-plugin-cards.ts'), false);
  assert.equal(isEditablePath('src/cards/../render/Stage.tsx'), false);
  assert.equal(isEditablePath('src/parts/lib/x.test.ts'), false);
  assert.equal(isEditablePath('src/cards/user/_scopes.json'), false);
});

test('源码闭包:第一个是定义文件,其余全在可改范围内,Magic UI 卡带上它的 vendor 实现', () => {
  const c = importClosure(ROOT, 'src/cards/magicui/number-ticker.card.tsx');
  assert.equal(c[0], 'src/cards/magicui/number-ticker.card.tsx');
  assert.ok(c.every(isEditablePath), c.join(', '));
  assert.ok(c.some((f) => f.startsWith('src/cards/magicui/vendor/')), '要能顺着 import 找到 vendor 里的组件:' + c.join(', '));
});

test('共用计数:每张卡的定义文件至少被它自己算一次', () => {
  const counts = sharedByCounts(ROOT);
  assert.ok((counts.get('src/cards/native/rank-bars.tsx') || 0) >= 1);
});

// ── 编辑校验 ──────────────────────────────────────────────────────
test('语法错误拒绝,并带行号', () => {
  const r = checkSourceEdit('src/parts/lib/x.tsx', 'const a = 1;\n', 'const a = 1;\nconst b = ;\n');
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /语法错误\(第 2 行\)/);
});

test('不许新加 Date.now;原来就有的不追究', () => {
  const before = 'export const f = () => Date.now();\n';
  assert.equal(checkSourceEdit('src/parts/lib/x.ts', before, before.replace('f', 'g')).ok, true);
  const r = checkSourceEdit('src/parts/lib/x.ts', before, before + 'export const h = () => Date.now();\n');
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /Date\.now/);
});

test('CardDef 的导出和 id 不许改掉', () => {
  const before = 'export const c: CardDef<P> = { id: "a-card", name: "x" };\n';
  const r1 = checkSourceEdit('src/cards/native/a.tsx', before, before.replace('"a-card"', '"b-card"'));
  assert.equal(r1.ok, false);
  assert.match(r1.errors.join('\n'), /id 从 "a-card" 变成了 "b-card"/);
  const r2 = checkSourceEdit('src/cards/native/a.tsx', before, 'const c = { id: "a-card" };\n');
  assert.equal(r2.ok, false);
  assert.match(r2.errors.join('\n'), /CardDef/);
});

test('样式文件不做语法检查,但照样挡新加的危险写法以外的东西', () => {
  assert.equal(checkSourceEdit('src/cards/native/hud.css', '.a{color:red}', '.a{color:blue}').ok, true);
});

// ── source map ───────────────────────────────────────────────────
test('VLQ 解码 + 位置换算(手算过的一段)', () => {
  // 第 1 行两段:[0,0,0,0] 和 [2,0,0,2];第 2 行一段:原行 +1 → [0,0,1,2]
  const dec = decodeMappings('AAAA,EAAE;AACA');
  assert.deepEqual(dec, [[[0, 0, 0, 0], [2, 0, 0, 2]], [[0, 0, 1, 2]]]);
  assert.deepEqual(originalPosition(dec, 1, 3), { line: 1, col: 3 });
  assert.deepEqual(originalPosition(dec, 1, 1), { line: 1, col: 1 });
  assert.deepEqual(originalPosition(dec, 2, 5), { line: 2, col: 3 });
  assert.equal(originalPosition(dec, 9, 1), null);
});

// ── DOM 树格式化 ──────────────────────────────────────────────────
const node = (ref, parent, extra = {}) => ({
  ref, parent, tag: 'div', cls: '', text: '', owner: 'Card', site: null, rect: [0, 0, 10, 10], wrap: 0, desc: 0, children: [], ...extra,
});

test('列表项标出「同一行源码生成了 N 个兄弟节点」,超出层数的标出怎么往下看', () => {
  const nodes = [
    node(0, -1, { children: [1, 2], desc: 3, wrap: 6, where: 'src/cards/native/a.tsx:10' }),
    node(1, 0, { children: [3], desc: 1, where: 'src/cards/native/a.tsx:20', text: '第一项' }),
    node(2, 0, { where: 'src/cards/native/a.tsx:20', text: '第二项' }),
    node(3, 1, { where: 'src/cards/native/a.tsx:21' }),
  ];
  const out = formatDomTree(nodes, 0, 1);
  assert.match(out, /\[ref_0\].*折叠了 6 层包装/);
  assert.match(out, /\[ref_1\].*"第一项".*同一行源码生成了 2 个兄弟节点/);
  assert.match(out, /\[ref_1\].*还有 1 个后代,传 ref:1 往下看/);
  assert.doesNotMatch(out, /\[ref_3\]/, '超出层数的不展开');
  assert.match(formatDomTree(nodes, 1, 1), /^\[ref_1\][\s\S]*\n  \[ref_3\]/, '从 ref 往下看');
});

// ── 片段隔离 ──────────────────────────────────────────────────────
test('只留下要看的那个片段和它用的素材', () => {
  const project = {
    fps: 30, media: [{ id: 'm1' }, { id: 'm2' }],
    tracks: [{ id: 't1', hidden: true, clips: [{ id: 'a', cardId: 'x', start: 0, end: 1 }] }, { id: 't2', clips: [{ id: 'b', mediaId: 'm2', start: 0, end: 1 }] }],
  };
  const r = isolateClipForDom(project, 'b');
  assert.equal(r.clip.id, 'b');
  assert.equal(r.project.tracks.length, 1);
  assert.deepEqual(r.project.media.map((m) => m.id), ['m2']);
  assert.equal(isolateClipForDom(project, 'zz'), null);
  assert.equal(isolateClipForDom(project, 'a').project.tracks[0].hidden, false, '隐藏的轨道单独看时要显示出来');
});
