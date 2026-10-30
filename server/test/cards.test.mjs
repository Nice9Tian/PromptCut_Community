// 卡片参数校验 + 建卡源码校验。两个模块都是纯逻辑,这里转译后直接跑,
// 不需要 React、浏览器或 dev server。跑法:node --test server/test/cards.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');

/** assert.throws 不把错误还给你,但这里要断言报错文案本身 */
const caught = (fn) => { try { fn(); } catch (e) { return e; } throw new Error('本该抛错却没有'); };

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cards-test-'));
fs.mkdirSync(OUT, { recursive: true });

function compile(srcRel, outName, rewrites = []) {
  let src = fs.readFileSync(path.join(ROOT, srcRel), 'utf8');
  for (const [from, to] of rewrites) src = src.split(from).join(to);
  // 源文件里真实存在的相对 .mjs(`./frameMode.mjs`、`../xxx.mjs`)指回原地;
  // 上面 rewrites 刚造出来的 `./registry.mjs` 这种只存在于临时目录,原地找不到,原样留着
  src = src.replace(/from (["'])(\.\.?\/[^"']+\.mjs)\1/g, (m, _q, f) => {
    const abs = path.resolve(ROOT, path.dirname(srcRel), f);
    return fs.existsSync(abs) ? `from '${pathToFileURL(abs).href}'` : m;
  });
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const file = path.join(OUT, outName);
  fs.writeFileSync(file, js);
  return 'file:///' + file.replace(/\\/g, '/');
}

const registryUrl = compile('src/kernel/registry.ts', 'registry.mjs');
const cardParamsUrl = compile('src/kernel/cardParams.ts', 'cardParams.mjs', [['./registry.ts', './registry.mjs']]);
// 转译产物落在临时目录里,解析不到 node_modules,所以把 typescript 换成绝对 URL
const tsUrl = pathToFileURL(require_.resolve('typescript')).href;
// 插件里同目录的 .mjs(http-guard、card-overrides、prerender-client……)也一样:转译到临时目录后要指回 server/ 下的原文件
const localMjs = [...new Set([...fs.readFileSync(path.join(ROOT, 'server/vite-plugin-cards.ts'), 'utf8').matchAll(/from '\.\/([\w-]+\.mjs)'/g)].map((m) => m[1]))]
  .map((f) => [`from './${f}'`, `from '${pathToFileURL(path.join(ROOT, 'server', f)).href}'`]);
const pluginUrl = compile('server/vite-plugin-cards.ts', 'cards-plugin.mjs', [["from 'typescript'", `from '${tsUrl}'`], ...localMjs]);

const { registerCards } = await import(registryUrl);
const { validateCardParams, findCard } = await import(cardParamsUrl);
const { checkCardSource, checkSourceEdit, applyCardPatch, translateCardSource, reviewCardSource, suggestControls, installBundledCards } = await import(pluginUrl);

// 一张最小的假卡,形状和真卡一致
registerCards([{
  id: 'demo-card', name: '演示', description: 'd', source: 'native',
  defaults: { lines: '', mode: 'a', size: 10, accent: '#fff' },
  controls: [
    { key: 'lines', label: '内容', type: 'text', required: true, hint: '一行一条。' },
    { key: 'mode', label: '模式', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    { key: 'size', label: '字号', type: 'number' },
    { key: 'accent', label: '主色', type: 'color' },
  ],
  Component: () => null,
}]);

// ── validateCardParams ────────────────────────────────────────────
test('必填项为空 → 拒绝,并带上 hint', () => {
  const e = caught(() => validateCardParams('demo-card', { size: 20 }));
  assert.match(e.message, /lines/);
  assert.match(e.message, /必填/);
  assert.match(e.message, /一行一条/);      // hint 要透出去
});

test('必填项只有空白 → 仍然算没填', () => {
  assert.throws(() => validateCardParams('demo-card', { lines: '   ' }), /必填/);
});

test('必填项填了 → 通过,并返回合并结果', () => {
  const merged = validateCardParams('demo-card', { lines: '0|1|你好|' });
  assert.equal(merged.lines, '0|1|你好|');
  assert.equal(merged.mode, 'a');          // 没传的用 defaults
  assert.equal(merged.size, 10);
});

test('键名写错 → 拒绝,并列出真正的参数名', () => {
  const e = caught(() => validateCardParams('demo-card', { lines: 'x', linez: 'y' }));
  assert.match(e.message, /linez/);
  assert.match(e.message, /不是 demo-card 的参数/);
  assert.match(e.message, /mode/);          // 要告诉它有哪些合法参数
});

test('select 取值不在选项里 → 拒绝并列出可选值', () => {
  const e = caught(() => validateCardParams('demo-card', { lines: 'x', mode: 'c' }));
  assert.match(e.message, /a \/ b/);
});

test('number 收到字符串 → 拒绝', () => {
  assert.throws(() => validateCardParams('demo-card', { lines: 'x', size: '20' }), /要数字/);
});

test('改已有 clip 的次要参数,不该因为本次没带必填项而被拒', () => {
  const merged = validateCardParams('demo-card', { size: 30 }, { lines: '0|1|已经填过了|' });
  assert.equal(merged.size, 30);
  assert.equal(merged.lines, '0|1|已经填过了|');
});

test('卡片不存在 → 报错并列出可用 id', () => {
  const e = caught(() => findCard('no-such-card'));
  assert.match(e.message, /demo-card/);
});

// ── checkCardSource ───────────────────────────────────────────────
const GOOD = `
import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params }: CardProps<Params>) {
  return <motion.div animate={{ opacity: 1 }}>{params.text}</motion.div>;
}
export const priceTag: CardDef<Params> = {
  id: "price-tag", name: "价格", description: "d", source: "user",
  frameMode: "stateful",
  defaults: { text: "¥1" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
`;

test('合格源码 → 通过', () => {
  const r = checkCardSource('price-tag', GOOD, ['odometer'], { mode: 'author' });
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test('id 不是 kebab-case → 拒绝', () => {
  assert.match(checkCardSource('PriceTag', GOOD, [], { mode: 'author' }).errors.join('\n'), /kebab-case/);
});

test('id 和源码里的 id 不一致 → 拒绝', () => {
  const r = checkCardSource('other-id', GOOD, [], { mode: 'author' });
  assert.match(r.errors.join('\n'), /price-tag.*不一致|不一致/s);
});

test('id 撞车 → 拒绝', () => {
  assert.match(checkCardSource('price-tag', GOOD, ['price-tag'], { mode: 'author' }).errors.join('\n'), /已经有 id/);
});

test('mu- 前缀 → 拒绝', () => {
  const src = GOOD.replace('id: "price-tag"', 'id: "mu-thing"');
  assert.match(checkCardSource('mu-thing', src, [], { mode: 'author' }).errors.join('\n'), /mu- 前缀/);
});

test('没有 CardDef 具名导出 → 拒绝', () => {
  const src = GOOD.replace('export const priceTag: CardDef<Params>', 'const priceTag: any');
  assert.match(checkCardSource('price-tag', src, [], { mode: 'author' }).errors.join('\n'), /具名导出/);
});

test('用了 Date.now → 拒绝', () => {
  const src = GOOD.replace('params.text', 'params.text + Date.now()');
  assert.match(checkCardSource('price-tag', src, [], { mode: 'author' }).errors.join('\n'), /Date\.now/);
});

test('用了 setInterval → 拒绝', () => {
  const src = GOOD.replace('return <motion', 'setInterval(() => {}, 16);\n  return <motion');
  assert.match(checkCardSource('price-tag', src, [], { mode: 'author' }).errors.join('\n'), /setTimeout \/ setInterval/);
});

test('用了 IntersectionObserver → 拒绝', () => {
  const src = GOOD.replace('return <motion', 'new IntersectionObserver(() => {});\n  return <motion');
  assert.match(checkCardSource('price-tag', src, [], { mode: 'author' }).errors.join('\n'), /IntersectionObserver/);
});

test('语法错误 → 拒绝并给出行号', () => {
  const src = GOOD.replace('defaults: { text: "¥1" },', 'defaults: { text: "¥1" ,');
  const r = checkCardSource('price-tag', src, [], { mode: 'author' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /语法错误/);
});

test('缺 controls 字段 → 拒绝', () => {
  const src = GOOD.replace('  controls: [{ key: "text", label: "文字", type: "text" }],\n', '');
  assert.match(checkCardSource('price-tag', src, [], { mode: 'author' }).errors.join('\n'), /缺少 controls/);
});

// ── A0:审阅表是 independent 的唯一权威 + frameMode 必填 ──────────────
// 这两条错了不报错,只会让一张毛玻璃卡拿到「独立卡」的待遇:死素材单独存、上云共享,
// 换个下层就糊着别人的画面。所以三条路(内置卡 edit、用户卡 edit、create)各钉一条。
const INDEPENDENT = '  compositing: "independent",\n';

test("A0:用户卡 edit_card 新增 compositing: independent → 拒绝", () => {
  const after = GOOD.replace('  defaults:', INDEPENDENT + '  defaults:');
  const r = checkCardSource('price-tag', after, [], { mode: 'author', before: GOOD });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /审阅表/);
});

test("A0:用户卡 edit_card 只改文案 → 通过", () => {
  const after = GOOD.replace('name: "价格"', 'name: "价钱"');
  const r = checkCardSource('price-tag', after, [], { mode: 'author', before: GOOD });
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test("A0:用户卡本来就写了 independent、这次没新增 → 不追究(差量口径)", () => {
  const withIt = GOOD.replace('  defaults:', INDEPENDENT + '  defaults:');
  const after = withIt.replace('name: "价格"', 'name: "价钱"');
  const r = checkCardSource('price-tag', after, [], { mode: 'author', before: withIt });
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test("A0:create_card 源码里带 compositing: independent → 拒绝(before 是空串,出现即拒)", () => {
  const src = GOOD.replace('  defaults:', INDEPENDENT + '  defaults:');
  const r = checkCardSource('price-tag', src, [], { mode: 'author', before: '' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /capabilities\.json/);
});

test("A0:内置卡 edit_card(checkSourceEdit)新增 independent → 拒绝", () => {
  const after = GOOD.replace('  defaults:', INDEPENDENT + '  defaults:');
  const r = checkSourceEdit('src/cards/native/price-tag.tsx', GOOD, after);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /capabilities\.json/);
});

test("A0:author 模式缺 frameMode → 拒绝;install 模式照收", () => {
  const src = GOOD.replace('  frameMode: "stateful",\n', '');
  assert.match(checkCardSource('price-tag', src, [], { mode: 'author' }).errors.join('\n'), /缺少 frameMode/);
  const installed = checkCardSource('price-tag', src, [], { mode: 'install' });
  assert.equal(installed.ok, true, installed.errors.join('\n'));
});

test("A0:内置 CardDef 文件改完丢了 frameMode → 拒绝", () => {
  const after = GOOD.replace('  frameMode: "stateful",\n', '');
  const r = checkSourceEdit('src/cards/native/price-tag.tsx', GOOD, after);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /缺少 frameMode/);
});

test("A0:CardDef<any>[] 聚合文件没有 frameMode 也能改", () => {
  const before = 'import type { CardDef } from "../../kernel/types";\nimport { a } from "./a";\nexport const nativeCards: CardDef<any>[] = [a];\n';
  const after = before.replace('[a]', '[a, a]');
  const r = checkSourceEdit('src/cards/native/index.ts', before, after);
  assert.equal(r.ok, true, r.errors.join('\n'));
});

// ── 翻译器:机械翻译 + 审查门 + controls 建议 ─────────────────────────
// 审查的分档来自 11 张卡在导出管线上的逐字节比对;这里钉住的是「哪一类代码会被
// 挡在哪一档」,别让以后放宽规则的人不知不觉把接不住的机制放进来。

test('translate:去掉 use client、@/lib/utils 指到本地,并报告改了什么', () => {
  const r = translateCardSource('"use client"\nimport { cn } from "@/lib/utils"\nexport const x = 1');
  assert.equal(/use client/.test(r.source), false);
  assert.match(r.source, /from "\.\.\/magicui\/vendor\/cn"/);
  assert.equal(r.rewrites.length, 2);
});

test('review 第二档:拦的是自带帧循环,不再拦 WebGL / three 本身', () => {
  const tiers = (src) => reviewCardSource(src).map((f) => f.tier);
  // 导出页把 Math.random 钉成带种子的、截图期间关脚本 —— 粒子卡实测逐字节一致,所以这两条不再拒
  assert.deepEqual(tiers('const c = ref.current.getContext("2d")'), []);
  assert.deepEqual(tiers('const x = Math.random()'), []);
  // WebGL 本身放行:导出加了 --enable-unsafe-swiftshader 之后,three 卡实测两趟 20/20 帧逐字节相同
  assert.deepEqual(tiers('const gl = c.getContext("webgl")'), []);
  assert.deepEqual(tiers('import * as THREE from "three"'), []);
  assert.deepEqual(tiers('import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"'), []);
  // 真正接不住的是「三维场景 + 自己跑帧循环」这个组合
  assert.deepEqual(tiers('renderer.setAnimationLoop((t) => draw(t))'), [2]);
  // 裸 rAF 驱动一个 three 场景:以前从这儿溜过去
  assert.deepEqual(tiers('import * as THREE from "three"\nrequestAnimationFrame(function l(){ mesh.rotation.y += 0.01; requestAnimationFrame(l) })'), [2]);
  assert.deepEqual(tiers('const gl = c.getContext("webgl")\nrequestAnimationFrame(loop)'), [2]);
  // 变量名绕过 setAnimationLoop 也拦得住(它同时用了 three)
  assert.deepEqual(tiers('import * as THREE from "three"\nconst fn = "setAnimationLoop"; renderer[fn](cb)'), [2]);
  // 注释里提到不算用了:这条规则的报错文案让人「照 scene-3d.tsx 的写法」,
  // 而那张卡的注释里正好在解释为什么不能用 setAnimationLoop —— 连注释一起匹配就成了自相矛盾
  assert.deepEqual(tiers('// 不要用 setAnimationLoop,它按 delta 累积\nimport * as THREE from "three"\nrenderer.render(s, c)'), []);
  assert.deepEqual(tiers('/* three 的 setAnimationLoop 在这条管线上接不住 */\nconst x = 1'), []);
  // 字符串里的 // 不该被当成注释,后面的代码照样要看得见
  assert.deepEqual(tiers('const url = "http://x"; renderer.setAnimationLoop(cb)'), [2]);
  // 但**不能**见 rAF 就拦:二维卡用 rAF 是这条管线上验证过的,一刀切会误伤一大片
  assert.deepEqual(tiers('requestAnimationFrame(() => setX(1))'), []);
  // 自带帧循环的三维框架:既是第二档,也没装
  assert.deepEqual(tiers('import { Canvas } from "@react-three/fiber"').sort(), [2, 'deps']);
  // 装好的粒子 / Lottie 库是允许的依赖
  assert.deepEqual(tiers('import { tsParticles } from "@tsparticles/engine"\nimport lottie from "lottie-web"'), []);
});

test('review 第三档:鼠标 / hover / 滚动', () => {
  const tiers = (src) => reviewCardSource(src).map((f) => f.tier);
  assert.deepEqual(tiers('window.addEventListener("mousemove", h)'), [3]);
  assert.deepEqual(tiers('<motion.div whileHover={{ scale: 1.1 }} />'), [3]);
  assert.deepEqual(tiers('const { scrollY } = useScroll()'), [3]);
});

test('review 依赖:没装的库拒绝,允许的放行', () => {
  assert.equal(reviewCardSource('import { Sparkles } from "lucide-react"')[0].tier, 'deps');
  assert.deepEqual(
    reviewCardSource('import { motion } from "motion/react"\nimport { cn } from "../magicui/vendor/cn"\nimport type { CardDef } from "../../kernel/types"'),
    [],
  );
});

test('review 动画 class:MagicUI 那 22 组已 vendor 放行,没定义的拒绝', () => {
  assert.deepEqual(reviewCardSource('<span className="animate-shiny-text animate-spin" />'), []);
  const f = reviewCardSource('<span className="animate-wobble" />');
  assert.equal(f.length, 1);
  assert.equal(f[0].tier, 'keyframes');
  assert.match(f[0].detail, /magicui-animations\.css/);
});

test('review 来源/许可证:搬来的没声明 → 拒绝;Commons Clause → 拒绝;MIT → 放行', () => {
  const body = 'export const A = () => null';
  // 直接把 MagicUI 代码贴过来:有 @/lib/utils 的痕迹但没写来源
  const undeclared = reviewCardSource('import { cn } from "@/lib/utils"\n' + body).filter((f) => f.tier === 'license');
  assert.equal(undeclared.length, 1);
  assert.match(undeclared[0].rule, /未声明/);
  // 翻译器已经改掉了 @/lib/utils 这个痕迹,靠 hints.vendored 仍然要求声明
  assert.equal(reviewCardSource(body, { vendored: true }).filter((f) => f.tier === 'license').length, 1);
  const bad = reviewCardSource('/**\n * 来源: https://reactbits.dev/x\n * MIT + Commons Clause\n */\n' + body);
  assert.match(bad.find((f) => f.tier === 'license').rule, /不允许分发/);
  const ok = reviewCardSource('/**\n * 来源: https://magicui.design/docs/components/x\n * MIT License\n */\n' + body);
  assert.deepEqual(ok, []);
});

test('checkCardSource 把审查发现并进 errors,带档位标签', () => {
  const src = GOOD.replace('return <motion', 'renderer.setAnimationLoop((ms) => draw(ms));\n  return <motion');
  const r = checkCardSource('price-tag', src, [], { mode: 'author' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /\[第二档·管线暂不支持\] 自带帧循环/);
  assert.equal(r.findings.length, 1);
});

test('mu- 前缀:文件头声明来源 magicui 的可以用', () => {
  const src = '/**\n * 来源: https://magicui.design/docs/components/thing\n * MIT License\n */\n' + GOOD.replace('id: "price-tag"', 'id: "mu-thing"');
  const r = checkCardSource('mu-thing', src, [], { mode: 'author' });
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test('suggestControls:从 *Props 接口推 controls,跳过 className/children', () => {
  const s = suggestControls(`
    interface ShinyProps extends React.HTMLAttributes<HTMLSpanElement> {
      text: string; shimmerWidth?: number; loop?: boolean; mode: "fast" | "slow"; words: string[]; className?: string; children?: React.ReactNode;
    }`);
  assert.deepEqual(s.map((x) => [x.key, x.type]), [['text', 'text'], ['shimmerWidth', 'number'], ['loop', 'select'], ['mode', 'select'], ['words', 'text']]);
  assert.match(s.find((x) => x.key === 'mode').hint, /fast \/ slow/);
  assert.match(s.find((x) => x.key === 'words').hint, /\|/);
});

// ── applyCardPatch:局部改卡 ────────────────────────────────────────
// 下面这几种情形出错时都不会报错,只会静静地把文件改成别的样子 ——
// 而「改卡时别处莫名其妙也变了」正是这个功能要根治的毛病,所以逐条钉住。

test('唯一命中时只换那一处', () => {
  const r = applyCardPatch('a\nsize: 120\nb', 'size: 120', 'size: 64');
  assert.equal(r.ok, true);
  assert.equal(r.after, 'a\nsize: 64\nb');
  assert.equal(r.replaced, 1);
});

test('replace 里的 $& 不该被当成替换记号展开', () => {
  // String.replace(str, str) 会把 $& 换成刚匹配到的内容;split/join 不会。
  // 这里的 replace 是模型逐字写好的源码,必须原样落盘。
  const r = applyCardPatch('x AAA y', 'AAA', 'cost = "$&"');
  assert.equal(r.after, 'x cost = "$&" y');
});

test('replace 里的 $1 和 $` 一样原样落盘', () => {
  assert.equal(applyCardPatch('[T]', 'T', '.replace(/x/, "$1")').after, '[.replace(/x/, "$1")]');
  assert.equal(applyCardPatch('[T]', 'T', 'a$`b').after, '[a$`b]');
});

test('find 里带正则元字符按字面处理,不当成模式', () => {
  const r = applyCardPatch('const a = arr.map(x => x)', 'arr.map(x => x)', 'arr');
  assert.equal(r.after, 'const a = arr');
});

test('一次都没命中 → 报错并指路 get_card_source', () => {
  const r = applyCardPatch('abc', 'xyz', 'q');
  assert.equal(r.ok, false);
  assert.match(r.error, /get_card_source/);
});

test('命中多处又没说 replaceAll → 报错并说清命中几处', () => {
  const r = applyCardPatch('p p p', 'p', 'q');
  assert.equal(r.ok, false);
  assert.match(r.error, /匹配到 3 处/);
});

test('replaceAll 时全换掉,并如实回报换了几处', () => {
  const r = applyCardPatch('p p p', 'p', 'q', true);
  assert.equal(r.after, 'q q q');
  assert.equal(r.replaced, 3);
});

test('replace 与 find 相同 → 报错,不留一次什么都没干的「成功」', () => {
  assert.equal(applyCardPatch('abc', 'b', 'b').ok, false);
});

test('空 find → 报错(否则会匹配到每一个位置)', () => {
  assert.equal(applyCardPatch('abc', '', 'x').ok, false);
});

// ── installBundledCards:打开 .proc 时把项目里带的定制卡装回本机 ─────────
function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-install-test-'));
  return { root, history: path.join(root, '.pc-work', 'card-history'), user: path.join(root, 'src', 'cards', 'user') };
}
const V2 = GOOD.replace('"¥1"', '"¥2"');

test('install:本机没有 → 写进 src/cards/user/', () => {
  const { root, history, user } = tmpRoot();
  const [r] = installBundledCards({ root, historyDir: history, cards: [{ id: 'price-tag', source: GOOD }], existingIds: ['odometer'] });
  assert.equal(r.status, 'written', r.error);
  assert.equal(fs.readFileSync(path.join(user, 'price-tag.tsx'), 'utf8'), translateCardSource(GOOD).source);
});

test('install:本机一样 → 不动;不一样 → 以项目为准,旧版按内容备份且只备一次', () => {
  const { root, history, user } = tmpRoot();
  installBundledCards({ root, historyDir: history, cards: [{ id: 'price-tag', source: GOOD }], existingIds: [] });
  assert.equal(installBundledCards({ root, historyDir: history, cards: [{ id: 'price-tag', source: GOOD }], existingIds: [] })[0].status, 'unchanged');

  const [r] = installBundledCards({ root, historyDir: history, cards: [{ id: 'price-tag', source: V2 }], existingIds: [] });
  assert.equal(r.status, 'updated');
  assert.match(fs.readFileSync(path.join(user, 'price-tag.tsx'), 'utf8'), /¥2/);
  assert.match(fs.readFileSync(path.join(root, r.backup), 'utf8'), /¥1/, '备份里是被换掉的本机旧版');

  // 两个项目来回打开:同一份旧版只备一次,不会越积越多
  installBundledCards({ root, historyDir: history, cards: [{ id: 'price-tag', source: GOOD }], existingIds: [] });
  installBundledCards({ root, historyDir: history, cards: [{ id: 'price-tag', source: V2 }], existingIds: [] });
  assert.equal(fs.readdirSync(history).length, 2);
});

test('install:过不了审查的不装,本机已有的原样留着', () => {
  const { root, history, user } = tmpRoot();
  installBundledCards({ root, historyDir: history, cards: [{ id: 'price-tag', source: GOOD }], existingIds: [] });
  const bad = GOOD.replace('return <motion.div', 'setTimeout(() => {}, 1);\n  return <motion.div');
  const [r] = installBundledCards({ root, historyDir: history, cards: [{ id: 'price-tag', source: bad }], existingIds: [] });
  assert.equal(r.status, 'rejected');
  assert.match(r.error, /setTimeout/);
  assert.doesNotMatch(fs.readFileSync(path.join(user, 'price-tag.tsx'), 'utf8'), /setTimeout/);
});

test('install:id 挡住路径穿越、不许顶替内置卡', () => {
  const { root, history } = tmpRoot();
  const rs = installBundledCards({
    root, historyDir: history, existingIds: ['price-tag'],
    cards: [{ id: '../../evil', source: GOOD }, { id: 'price-tag', source: GOOD }, { id: 'x', source: 1 }],
  });
  assert.deepEqual(rs.map((r) => r.status), ['rejected', 'rejected', 'rejected']);
  assert.equal(fs.existsSync(path.join(root, 'src', 'evil.tsx')), false);
  assert.match(rs[1].error, /已经有 id/);
});

test('install:有改动层时比对和写入都走改动层,底版不动', () => {
  const { root, history, user } = tmpRoot();
  const layer = path.join(root, 'layer');
  fs.mkdirSync(user, { recursive: true });
  fs.writeFileSync(path.join(user, 'price-tag.tsx'), translateCardSource(GOOD).source);
  process.env.PROMPTCUT_CARD_OVERRIDES = layer;
  try {
    const [r] = installBundledCards({ root, historyDir: history, cards: [{ id: 'price-tag', source: V2 }], existingIds: [] });
    assert.equal(r.status, 'updated');
    assert.match(fs.readFileSync(path.join(layer, 'src', 'cards', 'user', 'price-tag.tsx'), 'utf8'), /¥2/);
    assert.match(fs.readFileSync(path.join(user, 'price-tag.tsx'), 'utf8'), /¥1/, '底版是只读的,补丁只换它');
    assert.equal(installBundledCards({ root, historyDir: history, cards: [{ id: 'price-tag', source: V2 }], existingIds: [] })[0].status, 'unchanged', '比对的是生效的那一份');
  } finally {
    delete process.env.PROMPTCUT_CARD_OVERRIDES;
  }
});
