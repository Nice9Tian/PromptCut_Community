/**
 * 队列节点与文档服务的依赖守门。跑:node --test server/test/render-node-deps.test.mjs
 *
 * `server/render-node/` 要在没有 node_modules 的机器上跑(契约 A.1 / B 节),文档
 * 服务部署时也只拷 `server/docservice/`、`server/render-queue/`、`server/render-node/`
 * 这几个目录。所以从这些目录出发的整棵依赖树里只许出现两种说明符:
 *   - `node:` 前缀的 Node 内置模块;
 *   - 仓库内的相对路径(`./`、`../`),并递归检查被引的文件。
 * 任何裸包名(`pngjs`、`puppeteer`、`ws`……)都不行 —— 在没装依赖的机器上启动
 * 就会 ERR_MODULE_NOT_FOUND。曾经的实例:split.mjs → snapshot-store.mjs →
 * frame-mov.mjs → pngjs(现在 split.mjs 改从 snapshot-tier.mjs 取 snapshotTier)。
 *
 * 静态解析:`import … from '…'`、`export … from '…'`、`import '…'`、
 * `import('…')`、`require('…')`。只扫字面量说明符;注释里的同形文字也会被扫到,
 * 那是有意的保守。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serverDir, '..');

const SPECIFIER_PATTERNS = [
  /\bimport\s+(?:[\w*${}\s,]+?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

export function specifiersOf(source) {
  const found = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

const listEntries = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return listEntries(full);
  return /\.(mjs|cjs|js)$/.test(entry.name) ? [full] : [];
});

/** 从入口出发静态遍历;回 { files, violations }。 */
function walk(entries) {
  const seen = new Set();
  const violations = [];
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = path.relative(repoRoot, file).replace(/\\/g, '/');
    if (!fs.existsSync(file)) { violations.push(`${rel}: 文件不存在`); continue; }
    for (const spec of specifiersOf(fs.readFileSync(file, 'utf8'))) {
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const target = path.resolve(path.dirname(file), spec);
        if (!target.startsWith(repoRoot + path.sep)) { violations.push(`${rel}: '${spec}' 指到仓库外`); continue; }
        queue.push(target);
        continue;
      }
      violations.push(`${rel}: '${spec}' 不是 node: 内置模块也不是相对路径`);
    }
  }
  return { files: [...seen].map(f => path.relative(repoRoot, f).replace(/\\/g, '/')).sort(), violations };
}

test('D0 说明符解析认得全部写法', () => {
  const source = [
    "import fs from 'node:fs';",
    "import { a,\n  b } from './a.mjs';",
    "import * as ns from \"../b.mjs\";",
    "import './side.mjs';",
    "export { c } from './c.mjs';",
    "export * from './d.mjs';",
    "export * as e from './e.mjs';",
    "const f = await import('./f.mjs');",
    "const g = require('pngjs');",
  ].join('\n');
  assert.deepEqual(specifiersOf(source).sort(),
    ['../b.mjs', './a.mjs', './c.mjs', './d.mjs', './e.mjs', './f.mjs', './side.mjs', 'node:fs', 'pngjs'].sort());
});

test('D1 server/render-node/ 的整棵依赖树只有 node: 内置模块和仓库内相对路径', () => {
  const entries = listEntries(path.join(serverDir, 'render-node'));
  assert.ok(entries.length > 0, 'render-node 下没有文件');
  const { files, violations } = walk(entries);
  assert.deepEqual(violations, [], `依赖树:\n${files.join('\n')}`);
  // 回归点:不再经 snapshot-store.mjs(它引 frame-mov.mjs → pngjs)
  assert.ok(!files.includes('server/snapshot-store.mjs'), 'render-node 又引到了 snapshot-store.mjs');
  assert.ok(files.includes('server/snapshot-tier.mjs'));
});

test('D2 server/docservice/ 与 server/render-queue/ 的整棵依赖树同样干净', () => {
  const entries = [
    ...listEntries(path.join(serverDir, 'docservice')),
    ...listEntries(path.join(serverDir, 'render-queue')),
  ];
  assert.ok(entries.length > 0);
  const { files, violations } = walk(entries);
  assert.deepEqual(violations, [], `依赖树:\n${files.join('\n')}`);
});
