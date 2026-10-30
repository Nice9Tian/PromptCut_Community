/**
 * 0.7.18 验收 2.3-2:独立入口对前端代码(`src/`)的依赖只经一处载入缝 `server/agent/ssr-host.mjs`;独立入口不依赖桌面壳。
 * 跑:npm test -- server/test/accept-018-rest-ssr-seam.test.mjs
 *
 * 为什么另写一条:已有的守门 `cloud-agent-service.test.mjs` 的 CA-SEAM-01 只扫 `server/agent/service/` 与 `server/agent-service/`
 * 这两个目录**当前这一层**的文件(`readdirSync` 不进子目录),并且把每条相对路径都按「目录」而不是「文件所在目录」解析,
 * 所以 `server/agent/service/perception/` 里的文件扫不到;它也不跟着 import 往外走(独立入口 import 的 `server/agent/*.mjs`、
 * `server/vite-plugin-cards.ts` 里再 import `src/` 的,它看不见)。本文件补这两处:
 *
 *   SEAM-1 递归扫两个独立入口目录(含子目录),按文件所在目录解析,除 ssr-host 外不许有指向 `src/` 的 import(强版,现状不成立,标 todo);
 *   SEAM-2 从这些文件出发跟着相对 import 走(传递闭包),闭包里除 ssr-host 外不许有任何文件 import `src/`(强版,现状不成立,标 todo);
 *   SEAM-3 棘轮:现状的违反清单只许少、不许多(新增一处指向 `src/` 的 import 就红);
 *   SEAM-4 闭包里没有文件 import `desktop/` 下的东西(独立入口不依赖桌面壳);
 *   SEAM-5 扫描器自检:对一段合成文本能抓到各种写法的 import;ssr-host 自己确实在用 `load('/src/…')`(缝还在)。
 *
 * SEAM-1 已是硬断言(0.7.18 工具表接线之后两个入口目录里不再有直接引用)。SEAM-2 仍是 `todo`:它如实断言「应当没有违反」,
 * 现状闭包里还有 7 处(都在两个入口目录之外:`server/agent/` 下桌面与云端共用的四个文件、`server/vite-plugin-cards.ts`),
 * 所以会失败,但 todo 的失败不让 `npm test` 变红。修好产品代码(或把例外正式写进契约)以后,把 todo 去掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const norm = (p) => p.split(path.sep).join('/');
const rel = (p) => norm(path.relative(ROOT, p));

/** 独立入口自己的代码目录(`docs/plan/cloud-agent-contract.md` 第 2.1 节「载入缝」那一条点名的两个) */
const ENTRY_DIRS = ['cloud/server/agent-service', 'server/agent/service'];
const SEAM_FILE = 'server/agent/ssr-host.mjs';

/** 去掉块注释和整行 // 注释,免得注释里写的 import 示例被当成真的 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

/** 一段源码里所有「引用别的文件」的字符串:from、import()、import '…'、new URL('…', import.meta.url)、require()、load('/src/…') */
export function specsOf(text) {
  const out = [];
  const re = /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+|\bnew\s+URL\(\s*|\brequire\(\s*|\bload(?:Module)?\(\s*)(['"`])([^'"`\n]+)\1/gm;
  for (const m of stripComments(text).matchAll(re)) out.push(m[2]);
  return out;
}

function listFiles(dir) {
  const out = [];
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...listFiles(rel(p))); }
    else if (/\.(mjs|js|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 一个 spec 指到哪:相对路径按「文件所在目录」解析;`/src/…` 是 vite 的模块 id(根目录下的 src) */
function targetOf(file, spec) {
  if (spec.startsWith('.')) return path.resolve(path.dirname(file), spec);
  if (spec.startsWith('/src/') || spec.startsWith('/server/')) return path.join(ROOT, spec);
  return null;
}
const inSrc = (t) => t !== null && !rel(t).startsWith('..') && (rel(t) === 'src' || rel(t).startsWith('src/'));
const inDesktop = (t) => t !== null && !rel(t).startsWith('..') && (rel(t) === 'desktop' || rel(t).startsWith('desktop/'));

/** 递归扫某批文件,返回「文件 -> 指向 src/ 的目标」 */
function srcImportsOf(files) {
  const bad = [];
  for (const f of files) {
    if (rel(f) === SEAM_FILE) continue;
    for (const spec of specsOf(fs.readFileSync(f, 'utf8'))) {
      const t = targetOf(f, spec);
      if (inSrc(t)) bad.push(`${rel(f)} -> ${rel(t)}`);
    }
  }
  return [...new Set(bad)].sort();
}

/** 从这些文件出发,跟着相对 import 走到的所有 server/ 文件(不进 src/,不进 node_modules;ssr-host 不展开,它就是那条缝) */
function closureOf(starts) {
  const seen = new Set();
  const queue = [...starts];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (rel(f) === SEAM_FILE || !fs.existsSync(f)) continue;
    for (const spec of specsOf(fs.readFileSync(f, 'utf8'))) {
      const t = targetOf(f, spec);
      if (t === null || inSrc(t) || inDesktop(t)) continue;
      if (rel(t).startsWith('..')) continue;
      if (/\.(mjs|js|ts)$/.test(t)) queue.push(t);
    }
  }
  return [...seen];
}

const entryFiles = ENTRY_DIRS.flatMap(listFiles);
const closure = closureOf(entryFiles);

/**
 * 现状清单(2026-10-13,main 在 31e5b781):独立入口代码及其传递闭包里,除 ssr-host 之外指向 `src/` 的引用。
 * 契约(`cloud-agent-contract.md` 2.1 节)只认其中 creativity.mjs 的三处是「起点就有的」;其余是后来出现的或者契约没写到的。
 * 棘轮 SEAM-3:这张表只许缩小。修掉一处就从表里删掉一行。
 */
const KNOWN = [];

test('SEAM-1 独立入口两个目录(含子目录)里除 ssr-host 外没有指向 src/ 的 import', () => {
  // 0.7.18 工具表接线之后是硬断言:镜头、主体两个工具包要的内核函数经 ssr-host 的载入缝取来、由宿主(account-tools.mjs)注入,
  // 两个独立入口目录里(含 perception 子目录)不再有任何文件直接引用 src/
  assert.ok(entryFiles.length > 40, `应扫到不少文件,实际 ${entryFiles.length}`);
  assert.ok(entryFiles.some((f) => rel(f).startsWith('server/agent/service/perception/')), '应包含 perception 子目录');
  assert.deepEqual(srcImportsOf(entryFiles), []);
});

test('SEAM-2 独立入口的传递闭包里除 ssr-host 外没有任何文件 import src/', () => {
  assert.ok(closure.length > entryFiles.length, '闭包应比入口目录本身大');
  assert.deepEqual(srcImportsOf(closure), []);
});

test('SEAM-3 棘轮:指向 src/ 的直接引用只许少、不许多', () => {
  const now = srcImportsOf(closure);
  const added = now.filter((x) => !KNOWN.includes(x));
  assert.deepEqual(added, [], '新增了指向 src/ 的直接引用:要么改走 ssr-host 的载入缝,要么先在契约里写明再加进 KNOWN');
  const gone = KNOWN.filter((x) => !now.includes(x));
  // 少了是好事,只提示不拦
  if (gone.length) console.log(`# SEAM-3 已修掉 ${gone.length} 处,请从 KNOWN 里删掉:\n#   ${gone.join('\n#   ')}`);
});

test('SEAM-4 独立入口的传递闭包里没有文件 import desktop/ 下的东西', () => {
  const bad = [];
  for (const f of closure) {
    if (rel(f) === SEAM_FILE) continue;
    for (const spec of specsOf(fs.readFileSync(f, 'utf8'))) {
      const t = targetOf(f, spec);
      if (inDesktop(t)) bad.push(`${rel(f)} -> ${rel(t)}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('SEAM-5 扫描器自检:各种写法的引用都抓得到;ssr-host 自己确实在用 load("/src/…")', () => {
  const sample = [
    "import { a } from '../../src/kernel/x.mjs';",
    "export { b } from '../../../src/kernel/y.mjs';",
    "const m = await import('../../../../src/kernel/z.ts');",
    "const k = import(new URL('../../../../src/kernel/project.ts', import.meta.url).href);",
    "import '../../src/side-effect.ts';",
    "await load('/src/store/core.ts');",
    "// import('../../src/in-comment.ts')",
    "/* from '../../src/in-block.ts' */",
    "const ok = await import('node:fs');",
  ].join('\n');
  const specs = specsOf(sample);
  assert.deepEqual(specs, [
    '../../src/kernel/x.mjs', '../../../src/kernel/y.mjs', '../../../../src/kernel/z.ts', '../../../../src/kernel/project.ts', '../../src/side-effect.ts', '/src/store/core.ts', 'node:fs',
  ]);
  // 按文件所在目录解析:perception 子目录里的 ../../../../src 指到仓库根的 src
  const fake = path.join(ROOT, 'server/agent/service/perception/fake.mjs');
  assert.equal(rel(targetOf(fake, '../../../../src/kernel/project.ts')), 'src/kernel/project.ts');
  assert.equal(inSrc(targetOf(fake, '/src/store/core.ts')), true);
  assert.equal(inSrc(targetOf(fake, '../session.mjs')), false);
  // 缝还在
  const seam = specsOf(fs.readFileSync(path.join(ROOT, SEAM_FILE), 'utf8')).filter((s) => s.startsWith('/src/'));
  assert.ok(seam.length >= 10, `ssr-host 应经 load('/src/…') 载入十几个前端模块,实际 ${seam.length}`);
});
