/**
 * Gatekeeper: the Agent runtime is the npm package `promptcut-harness`, not a copy in this repository.
 *
 * Why: until 2026-11 the harness lived in `server/harness/` and everything reached it by relative
 * path. It moved to its own repository (https://github.com/Nice9Tian/promptcut-harness) so that every
 * edition built from this code shares one harness by version instead of by merge. A relative import
 * that quietly brings a copy back, or an alias that points at one, would split it again.
 *
 * 1. Nothing in this repository imports `server/harness/` or the old `#promptcut-harness` alias, and
 *    that directory is gone.
 * 2. `package.json` depends on the package, and the installed package has no dependencies of its own
 *    (the desktop runtime is assembled with `npm ci`; a harness that pulled in a tree of packages
 *    would change what ships).
 * 3. Every `promptcut-harness/...` specifier used here resolves in the installed version: a subpath
 *    the package does not export fails at import time, on the first Agent run and not before.
 *
 * The harness's own tests (Agent loop, providers, retry, compaction, ...) live in that repository.
 * What stays here are the tests of how PromptCut binds it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = 'server/test/harness-package.test.mjs';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'target', 'runtime', 'docs', '.vite', '.claude', '.worktrees']);
const CODE = /\.(mjs|cjs|js|ts|tsx)$/;

/** Module specifiers a source text imports (static, dynamic, re-export, `new URL(x, import.meta.url)`). */
export function specifiersOf(text) {
  const found = [];
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?(['"`])([^'"`\n]+)\1/g,
    /\bimport\s*\(\s*(['"`])([^'"`\n]+)\1/g,
    /\bnew\s+URL\s*\(\s*(['"`])([^'"`\n]+)\1\s*,\s*import\.meta\.url/g,
    /\bimport\.meta\.resolve\s*\(\s*(['"`])([^'"`\n]+)\1/g,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.push(match[2]);
  return found;
}
const isOldCopy = (spec, fromRel) => spec === '#promptcut-harness' || spec.startsWith('#promptcut-harness/') ||
  (spec.startsWith('.') && path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec)).startsWith('server/harness/'));
const isPackage = spec => spec === 'promptcut-harness' || spec.startsWith('promptcut-harness/');

function scan() {
  const old = [], used = new Map();
  let files = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(rel); continue; }
      if (!entry.isFile() || !CODE.test(entry.name) || rel === SELF) continue;
      files += 1;
      for (const spec of specifiersOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) {
        if (isOldCopy(spec, rel)) old.push(`${rel}: ${spec}`);
        else if (isPackage(spec)) { if (!used.has(spec)) used.set(spec, rel); }
      }
    }
  };
  walk('');
  return { old, used, files };
}

test('Gatekeeper: nothing imports a copy of the harness, and there is no copy', () => {
  const { old, used, files } = scan();
  assert.ok(files > 500, `Source files were scanned: ${files}`);
  assert.ok(used.size >= 10, `Imports of the package were found: ${used.size}`);
  assert.deepEqual(old, [], `These import the harness from inside the repository; import it from the package "promptcut-harness":\n${old.join('\n')}`);
  assert.equal(fs.existsSync(path.join(ROOT, 'server', 'harness')), false, 'server/harness/ is back: changes to the harness belong in the promptcut-harness repository');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.imports ?? {}).filter(key => key.startsWith('#promptcut-harness')), [], 'package.json has no alias for the harness');
  assert.equal(typeof manifest.dependencies?.['promptcut-harness'], 'string', 'package.json depends on promptcut-harness');
});

test('Gatekeeper: the installed harness has no dependencies, and every subpath used here is one it exports', () => {
  const installed = createRequire(import.meta.url)('promptcut-harness/package.json');
  assert.equal(installed.name, 'promptcut-harness');
  assert.deepEqual(Object.keys(installed.dependencies ?? {}), [], `promptcut-harness ${installed.version} must stay free of dependencies`);
  const unresolved = [];
  for (const [spec, rel] of scan().used) {
    try { import.meta.resolve(spec); } catch (error) { unresolved.push(`${spec} (first used in ${rel}): ${error.code ?? error.message}`); }
  }
  assert.deepEqual(unresolved, [], `promptcut-harness ${installed.version} does not export:\n${unresolved.join('\n')}`);
});

test('Gatekeeper itself recognizes the forms it looks for (do not let the scan silently fail)', () => {
  assert.deepEqual(specifiersOf([
    "import { Agent } from '../harness/agent.mjs';",
    'const m = await import("../../harness/providers/openai.mjs");',
    "export * from '#promptcut-harness/skills.mjs';",
    "import(new URL('./harness/env-snapshot.mjs', import.meta.url).href)",
    "import { MessageHistory } from 'promptcut-harness/history';",
    "path.dirname(fileURLToPath(import.meta.resolve('promptcut-harness')))",
  ].join('\n')), ['../harness/agent.mjs', '#promptcut-harness/skills.mjs', 'promptcut-harness/history', '../../harness/providers/openai.mjs',
    './harness/env-snapshot.mjs', 'promptcut-harness']);
  assert.equal(isOldCopy('../harness/agent.mjs', 'server/runners/api.mjs'), true);
  assert.equal(isOldCopy('./harness/env-snapshot.mjs', 'server/vite-plugin-ai.ts'), true);
  assert.equal(isOldCopy('#promptcut-harness', 'server/x.mjs'), true);
  assert.equal(isOldCopy('../harness/agent.mjs', 'scripts/probes/x.mjs'), false, 'A harness directory somewhere else is not the old copy');
  assert.equal(isOldCopy('promptcut-harness/agent', 'server/runners/api.mjs'), false);
  assert.equal(isPackage('promptcut-harness/tools/textEditor'), true); assert.equal(isPackage('promptcut-harness-extra'), false);
});
