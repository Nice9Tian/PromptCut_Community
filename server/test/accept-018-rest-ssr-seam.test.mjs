/**
 * 0.7.18 Acceptance check 2.3-2: Standalone entry points depend on frontend code (`src/`) only
 * through a single loading seam `server/agent/ssr-host.mjs`; standalone entry points do not depend
 * on the desktop shell.
 * Run: npm test -- server/test/accept-018-rest-ssr-seam.test.mjs
 *
 * Why write another one: The existing gatekeeper `cloud-agent-service.test.mjs` CA-SEAM-01 only scans
 * files at **this current level** in `server/agent/service/` and `server/agent-service/`
 * (`readdirSync` does not enter subdirectories), and resolves every relative path as a "directory"
 * rather than "the file's directory", so files in `server/agent/service/perception/` are missed;
 * it also does not follow imports outward (invisible to it if `server/agent/*.mjs` or
 * `server/vite-plugin-cards.ts` imported by standalone entry points import `src/` again). This file
 * covers both gaps:
 *
 *   SEAM-1 Recursively scan both standalone entry directories (including subdirectories), resolve
 *     relative to file directory; no imports pointing to `src/` allowed except ssr-host (strict
 *     version, currently false, marked todo);
 *   SEAM-2 Follow relative imports from these files (transitive closure); no file in the closure
 *     may import `src/` except ssr-host (strict version, currently false, marked todo);
 *   SEAM-3 Ratchet: the current violation list may only shrink, never grow (turns red if a new
 *     import pointing to `src/` is added);
 *   SEAM-4 No file in the closure imports anything under `desktop/` (standalone entry points do
 *     not depend on the desktop shell);
 *   SEAM-5 Scanner self-check: catches imports in various styles from synthetic text; ssr-host
 *     itself indeed uses `load('/src/…')` (the seam is still there).
 *
 * SEAM-1 is now a hard assertion (after 0.7.18 tool table wiring, no direct references remain in
 * either entry directory). SEAM-2 remains `todo`: it faithfully asserts "there should be no
 * violations", but 7 violations currently remain in the closure (all outside the two entry
 * directories: four files under `server/agent/` shared between desktop and cloud, and
 * `server/vite-plugin-cards.ts`), so it fails, but todo failure does not turn `npm test` red. Once
 * product code is fixed (or exceptions are formally written into the contract), remove todo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const norm = (p) => p.split(path.sep).join('/');
const rel = (p) => norm(path.relative(ROOT, p));

/** Standalone entry point code directories (the two named in `docs/plan/cloud-agent-contract.md` section 2.1 "Loading seam") */
const ENTRY_DIRS = ['cloud/server/agent-service', 'server/agent/service'];
const SEAM_FILE = 'server/agent/ssr-host.mjs';

/** Strip block comments and full-line // comments so import examples in comments are not taken as real */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

/** All strings in source code referencing other files: from, import(), import '…', new URL('…', import.meta.url), require(), load('/src/…') */
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

/** Where a spec points: relative paths resolve relative to "file directory"; `/src/…` is vite module id (src under root) */
function targetOf(file, spec) {
  if (spec.startsWith('.')) return path.resolve(path.dirname(file), spec);
  if (spec.startsWith('/src/') || spec.startsWith('/server/')) return path.join(ROOT, spec);
  return null;
}
const inSrc = (t) => t !== null && !rel(t).startsWith('..') && (rel(t) === 'src' || rel(t).startsWith('src/'));
const inDesktop = (t) => t !== null && !rel(t).startsWith('..') && (rel(t) === 'desktop' || rel(t).startsWith('desktop/'));

/** Recursively scan a batch of files, returning "file -> targets pointing to src/" */
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

/** All server/ files reached from these files following relative imports (does not enter src/ or node_modules; ssr-host is not expanded, it is the seam itself) */
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
 * Current violation list (2026-10-13, main at 31e5b781): references pointing to `src/` in standalone
 * entry point code and its transitive closure, excluding ssr-host.
 * The contract (`cloud-agent-contract.md` section 2.1) only recognizes three in creativity.mjs as
 * "present from the start"; the rest appeared later or were not covered in the contract.
 * Ratchet SEAM-3: this table may only shrink. Once one is fixed, delete one line from the table.
 */
const KNOWN = [];

test('SEAM-1 apart from ssr-host, nothing in the two standalone-entry directories (subdirectories included) has an import pointing to src/', () => {
  // Hard assertion after 0.7.18 tool table wiring: kernel functions required by the shot and subject
  // tool packages are fetched via the ssr-host loading seam and injected by the host (account-tools.mjs);
  // neither standalone entry directory (including perception subdirectory) directly references src/ anymore
  assert.ok(entryFiles.length > 40, `should scan quite a few files, actual ${entryFiles.length}`);
  assert.ok(entryFiles.some((f) => rel(f).startsWith('server/agent/service/perception/')), 'should include the perception subdirectory');
  assert.deepEqual(srcImportsOf(entryFiles), []);
});

test('SEAM-2 apart from ssr-host, no file in the transitive closure of the standalone entry imports src/', () => {
  assert.ok(closure.length > entryFiles.length, 'the closure should be larger than the entry directory itself');
  assert.deepEqual(srcImportsOf(closure), []);
});

test('SEAM-3 ratchet: direct references to src/ may only decrease, never increase', () => {
  const now = srcImportsOf(closure);
  const added = now.filter((x) => !KNOWN.includes(x));
  assert.deepEqual(added, [], 'New direct references to src/ were added: either route them through the ssr-host load seam, or document them in the contract first and then add them to KNOWN');
  const gone = KNOWN.filter((x) => !now.includes(x));
  // Fewer is good; only warn, do not block
  if (gone.length) console.log(`# SEAM-3 fixed ${gone.length} references, please remove them from KNOWN:\n#   ${gone.join('\n#   ')}`);
});

test('SEAM-4 no file in the transitive closure of the standalone entry imports anything under desktop/', () => {
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

test('SEAM-5 scanner self-check: references written in every style are caught; ssr-host itself really uses load("/src/…")', () => {
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
  // Resolve relative to file directory: ../../../../src in perception subdirectory points to src at repo root
  const fake = path.join(ROOT, 'server/agent/service/perception/fake.mjs');
  assert.equal(rel(targetOf(fake, '../../../../src/kernel/project.ts')), 'src/kernel/project.ts');
  assert.equal(inSrc(targetOf(fake, '/src/store/core.ts')), true);
  assert.equal(inSrc(targetOf(fake, '../session.mjs')), false);
  // Seam is still there
  const seam = specsOf(fs.readFileSync(path.join(ROOT, SEAM_FILE), 'utf8')).filter((s) => s.startsWith('/src/'));
  assert.ok(seam.length >= 10, `ssr-host should load a dozen or so frontend modules via load('/src/…'), actual ${seam.length}`);
});
