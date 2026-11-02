/**
 * Dependency gatekeeper for queue nodes and document service.
 * Run: node --test server/test/render-node-deps.test.mjs
 *
 * `server/render-node/` needs to run on machines without node_modules (contract section A.1 / B),
 * and deployment of document service only copies `server/docservice/`, `server/render-queue/`,
 * and `server/render-node/`. Therefore, only two kinds of specifiers may appear in the entire
 * dependency tree originating from these directories:
 *   - Node built-in modules prefixed with `node:`;
 *   - Relative paths within the repository (`./`, `../`), recursively checking referenced files.
 * Any bare package name (`pngjs`, `puppeteer`, `ws`…) is forbidden: starting on a machine without
 * installed dependencies causes ERR_MODULE_NOT_FOUND. A previous example: split.mjs →
 * snapshot-store.mjs → frame-mov.mjs → pngjs (split.mjs now takes snapshotTier from
 * snapshot-tier.mjs instead).
 *
 * Static parsing: `import … from '…'`, `export … from '…'`, `import '…'`, `import('…')`,
 * `require('…')`. Only scans literal specifiers; matching text in comments is also scanned,
 * which is intentionally conservative.
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

/** Statically traverse starting from entry; returns { files, violations }. */
function walk(entries) {
  const seen = new Set();
  const violations = [];
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = path.relative(repoRoot, file).replace(/\\/g, '/');
    if (!fs.existsSync(file)) { violations.push(`${rel}: file does not exist`); continue; }
    for (const spec of specifiersOf(fs.readFileSync(file, 'utf8'))) {
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const target = path.resolve(path.dirname(file), spec);
        if (!target.startsWith(repoRoot + path.sep)) { violations.push(`${rel}: '${spec}' points outside the repository`); continue; }
        queue.push(target);
        continue;
      }
      violations.push(`${rel}: '${spec}' is neither a node: built-in module nor a relative path`);
    }
  }
  return { files: [...seen].map(f => path.relative(repoRoot, f).replace(/\\/g, '/')).sort(), violations };
}

test('D0 specifier parsing recognizes all forms', () => {
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

test('D1 the whole dependency tree of server/render-node/ has only node: built-in modules and relative paths within the repository', () => {
  const entries = listEntries(path.join(serverDir, 'render-node'));
  assert.ok(entries.length > 0, 'No files under render-node');
  const { files, violations } = walk(entries);
  assert.deepEqual(violations, [], `Dependency tree:\n${files.join('\n')}`);
  // Regression point: no longer goes through snapshot-store.mjs (it imports frame-mov.mjs → pngjs)
  assert.ok(!files.includes('server/snapshot-store.mjs'), 'render-node pulled in snapshot-store.mjs again');
  assert.ok(files.includes('server/snapshot-tier.mjs'));
});

test('D2 the whole dependency tree of server/docservice/ and server/render-queue/ is equally clean', () => {
  const entries = [
    ...listEntries(path.join(serverDir, 'docservice')),
    ...listEntries(path.join(serverDir, 'render-queue')),
  ];
  assert.ok(entries.length > 0);
  const { files, violations } = walk(entries);
  assert.deepEqual(violations, [], `Dependency tree:\n${files.join('\n')}`);
});
