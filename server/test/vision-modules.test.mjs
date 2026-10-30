/*
 * `server/vision/**` 的结构守门测试。
 *
 * `server/vite-plugin-vision.ts` 曾经是 2011 行的单文件:ffmpeg 抽帧、渲染并发队列、
 * Chrome worker 池、单卡预渲染、HTTP 路由全挤在一起。拆成 `server/vision/` 之后,
 * 有两件事必须被钉住,否则拆分的收益会悄悄退回去:
 *
 *   1. **模块之间不许有运行时 import 环。** 队列(render-queue)和 worker 池(worker-pool)
 *      互相要用对方的东西 —— 现在的方向是 worker-pool → render-queue 单向,
 *      ui-renderer 要写 worker 池的 lastRenderOrigin 也是走一个单向的 setter。
 *      一旦有人反手加一条回边,模块初始化顺序就会变成运行期的定时炸弹(拿到 undefined 而不报错)。
 *   2. **插件外壳不许再长回去。** 外壳只该做三件事:接线、按 isPrerender 分流、关服务时收 worker。
 *
 * 跑法:`node --test server/test/vision-modules.test.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const VISION = path.join(ROOT, 'server', 'vision');
const SHELL = path.join(ROOT, 'server', 'vite-plugin-vision.ts');

/**
 * 外壳的行数上限。
 *
 * 拆分完成时是 56 行。留到 400 是「防回涨」的红线,不是目标:外壳里再写第二个路由、
 * 或者把某个调度逻辑顺手塞回来,都会先撞上这条线。任务要求的目标值是 300,
 * 这里取更宽的 400 当硬红线 —— 目标由代码评审把,红线由测试把。
 */
const SHELL_MAX_LINES = 400;

const CODE = /\.(mjs|mts|ts|tsx)$/;

function walk(dir, out = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) walk(file, out);
    else if (CODE.test(item.name)) out.push(file);
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file).replaceAll('\\', '/');

/** 一个文件里所有的模块说明符:静态 import / export ... from,以及 import("…") */
function specifiersOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const found = [];
  for (const m of text.matchAll(/(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/gs)) found.push(m[1]);
  for (const m of text.matchAll(/(?:^|[^\w$.])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(m[1]);
  for (const m of text.matchAll(/(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g)) found.push(m[1]);
  return found;
}

/**
 * 把一个说明符解析成仓库里的真实文件。`server/*.ts` 之间互相 import 是不带扩展名的
 * (见仓库里其它 server/*.ts 的写法),所以这里要按扩展名候选补一遍;补不上的
 * (第三方包、node: 内置)返回 null,不进图。
 */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, `${base}.mjs`, `${base}.mts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

test('server/vision/** 内部的 import 图无环', () => {
  /** 文件 → 它 import 的同目录(或子目录)模块 */
  const graph = new Map();
  for (const file of walk(VISION)) {
    const edges = [];
    for (const spec of specifiersOf(file)) {
      const target = resolveSpec(file, spec);
      // 只看 server/vision 内部的边:出圈的那些(../png-post.mjs 之类)由 bakery-deps 那支测试管
      if (target && target.startsWith(VISION)) edges.push(rel(target));
    }
    graph.set(rel(file), edges);
  }
  assert.ok(graph.size >= 8, `server/vision 里应当有拆出来的那几个模块,现在只找到 ${graph.size} 个`);

  const state = new Map(); // 未访问 / 1 在栈上 / 2 已完成
  const cycles = [];
  const visit = (node, stack) => {
    if (state.get(node) === 2) return;
    if (state.get(node) === 1) {
      cycles.push([...stack.slice(stack.indexOf(node)), node].join(' → '));
      return;
    }
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) || []) visit(next, stack);
    stack.pop();
    state.set(node, 2);
  };
  for (const node of graph.keys()) visit(node, []);
  assert.deepEqual(cycles, [], 'server/vision 内部不允许有运行时 import 环');
});

test('插件外壳 server/vite-plugin-vision.ts 不许再长回去', () => {
  const lines = fs.readFileSync(SHELL, 'utf8').split(/\r?\n/).length;
  assert.ok(
    lines < SHELL_MAX_LINES,
    `外壳现在 ${lines} 行,超过了 ${SHELL_MAX_LINES} 行的红线。新逻辑该落在 server/vision/ 的某个模块里,不是外壳里。`,
  );
});

test('外壳仍然导出 visionPlugin / bakeTarget / default(对外接口不能变)', async () => {
  const text = fs.readFileSync(SHELL, 'utf8');
  // vite.config.ts / vite.prerender.config.ts 按名字 import visionPlugin;bakeTarget 是历史上就 export 出去的
  assert.match(text, /export function visionPlugin\(\): Plugin \{/, '外壳要直接定义并导出 visionPlugin');
  assert.match(text, /export \{ bakeTarget \} from "\.\/vision\/bake";/, 'bakeTarget 要继续从外壳导出');
  assert.match(text, /export default visionPlugin;/, 'default export 不能丢');
});
