// 真实验证的依赖准备在两种位置都对:在 .worktrees/<名> 里,和在 main 自己里(ROOT 就是主工作区)。
// 用临时目录和临时 git 仓库模拟,不碰真的主工作区。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { copyDeps, depSources, findPython, mainRootOf } from './cloud-tools-p2-real-lib.mjs';

const MODEL = 'models--Systran--faster-whisper-small';
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, windowsHide: true, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-p2-lib-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return fs.realpathSync.native(d); };
const put = (file, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const seed = (root, tag) => {
  put(path.join(root, 'out', 'pylibs', 'faster_whisper', '__init__.py'), tag);
  put(path.join(root, 'out', 'models', MODEL, 'snapshots', 'r1', 'model.bin'), tag);
  put(path.join(root, 'desktop', 'src-tauri', 'runtime', 'python', 'python.exe'), tag);
};
const listing = (dir) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p)); } }; walk(dir); return out.sort(); };
delete process.env.P2_MAIN_ROOT;

test('mainRootOf: in main itself it is main, in a worktree it is main (git common dir, not directory depth)', (t) => {
  const main = tmp(t);
  git(main, 'init', '-q');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
  const wt = path.join(tmp(t), 'deep', 'er', 'tree');
  git(main, 'worktree', 'add', '-q', wt, '-b', 'p2-lib-test');
  assert.equal(fs.realpathSync.native(mainRootOf(main)), main);
  assert.equal(fs.realpathSync.native(mainRootOf(wt)), main);
});

test('copyDeps when the tree IS the main workspace: sources are its own out/…, copies land in its own out/p2-stt, nothing else is written', (t) => {
  const main = tmp(t);
  seed(main, 'main');
  const before = listing(main);
  copyDeps({ root: main, mainRoot: main });
  assert.equal(fs.readFileSync(path.join(main, 'out', 'p2-stt', 'pylibs', 'faster_whisper', '__init__.py'), 'utf8'), 'main');
  assert.ok(fs.existsSync(path.join(main, 'out', 'p2-stt', 'models', MODEL, 'snapshots', 'r1', 'model.bin')));
  const added = listing(main).filter((f) => !before.includes(f));
  assert.ok(added.length > 0 && added.every((f) => f.startsWith(path.join('out', 'p2-stt'))), added.join(', '));
  copyDeps({ root: main, mainRoot: main });                                 // 已有就不动
  assert.deepEqual(depSources(main, main).roots, [main], 'the same directory is listed once');
});

test('copyDeps in a worktree: own out/… first, else the main workspace; the main workspace is only read', (t) => {
  const main = tmp(t);
  const tree = tmp(t);
  seed(main, 'main');
  const mainBefore = listing(main);
  copyDeps({ root: tree, mainRoot: main });
  assert.equal(fs.readFileSync(path.join(tree, 'out', 'p2-stt', 'pylibs', 'faster_whisper', '__init__.py'), 'utf8'), 'main');
  assert.deepEqual(listing(main), mainBefore, 'nothing written into the main workspace');
  const own = tmp(t);
  seed(own, 'own');
  copyDeps({ root: own, mainRoot: main });
  assert.equal(fs.readFileSync(path.join(own, 'out', 'p2-stt', 'pylibs', 'faster_whisper', '__init__.py'), 'utf8'), 'own', 'the tree\'s own copy wins');
  const empty = tmp(t);
  assert.throws(() => copyDeps({ root: empty, mainRoot: empty }), /找不到可复制的来源/);
});

test('findPython looks in the tree first and then the main workspace', (t) => {
  delete process.env.PROMPTCUT_PYTHON;
  const main = tmp(t);
  const tree = tmp(t);
  seed(main, 'main');
  assert.equal(findPython(tree, main), path.join(main, 'desktop', 'src-tauri', 'runtime', 'python', 'python.exe'));
  assert.equal(findPython(main, main), path.join(main, 'desktop', 'src-tauri', 'runtime', 'python', 'python.exe'));
  seed(tree, 'tree');
  assert.equal(findPython(tree, main), path.join(tree, 'desktop', 'src-tauri', 'runtime', 'python', 'python.exe'));
  assert.equal(findPython(tmp(t), null), null);
});
