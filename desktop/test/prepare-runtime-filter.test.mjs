// prepare-runtime 拷源码树时的过滤:`.git` 不论是文件还是目录都不能进 runtime/app。
//
// 背景:build-release --from-head 用一棵临时 git worktree 当源码根,worktree 根上的 `.git`
// 是 `gitdir: …` 指针**文件**。过滤原先只对目录生效,这个文件被拷进了运行时目录、补丁清单
// (0.7.13 的 manifest 里第一个键就是 ".git")和安装包。
// 跑法:node --test desktop/test/prepare-runtime-filter.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { shouldCopyApp, copyRecursive, isDirectRun } from '../scripts/prepare-runtime.mjs';

/** 递归列出目录下所有文件的相对路径(正斜杠,已排序) */
function listFiles(dir, base = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listFiles(path.join(dir, ent.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

function write(root, rel, body = 'x') {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

function withTmp(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-prep-filter-'));
  try { fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('shouldCopyApp: .git is blocked both as a file and as a directory, normal names pass', () => {
  assert.equal(shouldCopyApp('.git', '/src/.git', false), false, '.git file (worktree pointer)');
  assert.equal(shouldCopyApp('.git', '/src/.git', true), false, '.git directory');
  assert.equal(shouldCopyApp('package.json', '/src/package.json', false), true);
  assert.equal(shouldCopyApp('src', '/src/src', true), true);
  // 只有 .git 按名字不分文件/目录;其它 SKIP_DIRS 名字仍只对目录生效,同名源码文件照拷
  assert.equal(shouldCopyApp('node_modules', '/src/node_modules', true), false);
  assert.equal(shouldCopyApp('release', '/src/docs/release', false), true);
  // .gitignore 之类不是 .git,必须保留
  assert.equal(shouldCopyApp('.gitignore', '/src/.gitignore', false), true);
  assert.equal(shouldCopyApp('.github', '/src/.github', true), true);
});

test('shouldCopyApp: .worktrees stays out of the installer entirely (hit while releasing 0.7.25 on 2026-10-24)', () => {
  // 少这一条就是把每一条分支的整份源码发给用户:那次 runtime/app 从 378 MB 涨到 11 GB
  // (光 .worktrees/_export-baseline 那份像素基线就 7.9 GB),makensis 直接挂
  assert.equal(shouldCopyApp('.worktrees', '/src/.worktrees', true), false);
  // 按名字挡,所以在哪一层都挡得住
  assert.equal(shouldCopyApp('.worktrees', '/src/a/b/.worktrees', true), false);
  // 同名的普通文件不受影响(和别的 SKIP_DIRS 口径一致:只对目录生效)
  assert.equal(shouldCopyApp('.worktrees', '/src/docs/.worktrees', false), true);
});

test('copyRecursive + shouldCopyApp: the root .git pointer file does not reach the target, normal files are all there', () => {
  withTmp((tmp) => {
    const src = path.join(tmp, 'src');
    const dest = path.join(tmp, 'dest');
    write(src, '.git', 'gitdir: D:/somewhere/.git/worktrees/release-src\n');
    write(src, 'package.json', '{}');
    write(src, 'src/main.ts', 'export {};');
    write(src, 'server/a.mjs', '1');
    write(src, '.gitignore', 'node_modules');
    write(src, 'node_modules/foo/index.js', 'skip');

    copyRecursive(src, dest, shouldCopyApp);

    assert.deepEqual(listFiles(dest), ['.gitignore', 'package.json', 'server/a.mjs', 'src/main.ts']);
    assert.equal(fs.existsSync(path.join(dest, '.git')), false);
  });
});

test('copyRecursive + shouldCopyApp: .git directories (including submodule .git files in subdirectories) do not reach the target', () => {
  withTmp((tmp) => {
    const src = path.join(tmp, 'src');
    const dest = path.join(tmp, 'dest');
    write(src, '.git/HEAD', 'ref: refs/heads/main\n');
    write(src, '.git/objects/ab/cdef', 'blob');
    write(src, 'vendor/sub/.git', 'gitdir: ../../.git/modules/sub\n'); // 子模块:嵌套层的 .git 文件
    write(src, 'vendor/sub/lib.js', 'ok');
    write(src, 'vendor/nested/.git/config', 'cfg'); // 嵌套层的 .git 目录
    write(src, 'vendor/nested/index.js', 'ok');
    write(src, 'README.md', 'hi');

    copyRecursive(src, dest, shouldCopyApp);

    assert.deepEqual(listFiles(dest), ['README.md', 'vendor/nested/index.js', 'vendor/sub/lib.js']);
    assert.equal(fs.existsSync(path.join(dest, '.git')), false);
    assert.equal(fs.existsSync(path.join(dest, 'vendor', 'sub', '.git')), false);
    assert.equal(fs.existsSync(path.join(dest, 'vendor', 'nested', '.git')), false);
  });
});

test('when the script runs directly, main still runs (--check is read-only, the exit code depends on whether this machine has a runtime, here we only check that it started)', () => {
  const script = fileURLToPath(new URL('../scripts/prepare-runtime.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8', timeout: 120_000 });
  assert.match(r.stdout, /PromptCut prepare-runtime \(--check\)/);
});

test('running directly with a different casing (lowercase drive letter, uppercase directory), main still runs; isDirectRun recognizes the different spellings too', () => {
  const script = fileURLToPath(new URL('../scripts/prepare-runtime.mjs', import.meta.url));
  // win32:整条路径改大写再把盘符改回小写;其它平台没有这种别名,原样跑(这条退化成「路径原样」)
  const variant = process.platform === 'win32'
    ? script.toUpperCase().replace(/\.MJS$/, '.mjs').replace(/^[A-Z]:/, (d) => d.toLowerCase())
    : script;
  const r = spawnSync(process.execPath, [variant, '--check'], { encoding: 'utf8', timeout: 120_000 });
  assert.match(r.stdout, /PromptCut prepare-runtime \(--check\)/);
  const metaUrl = pathToFileURL(script).href;
  assert.equal(isDirectRun(metaUrl, script), true);
  assert.equal(isDirectRun(metaUrl, variant), true);
  assert.equal(isDirectRun(metaUrl, path.join(path.dirname(script), 'make-patch.mjs')), false);
  assert.equal(isDirectRun(metaUrl, undefined), false);
});
