// Filtering when prepare-runtime copies the source tree: `.git` must not enter runtime/app
// whether it is a file or a directory.
//
// Background: build-release --from-head uses a temporary git worktree as the source root; `.git` at the
// worktree root is a `gitdir: …` pointer **file**. Filtering previously only applied to directories, so
// this file was copied into the runtime directory, patch manifest (first key in 0.7.13 manifest was ".git"),
// and installer package.
// How to run: node --test desktop/test/prepare-runtime-filter.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { shouldCopyApp, copyRecursive, isDirectRun } from '../scripts/prepare-runtime.mjs';

/** Recursively list relative paths of all files under a directory (forward slashes, sorted) */
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
  // Only .git matches by name regardless of file/directory; other SKIP_DIRS names still only
  // apply to directories, and source files with the same name are copied as usual
  assert.equal(shouldCopyApp('node_modules', '/src/node_modules', true), false);
  assert.equal(shouldCopyApp('release', '/src/docs/release', false), true);
  // Files like .gitignore are not .git and must be preserved
  assert.equal(shouldCopyApp('.gitignore', '/src/.gitignore', false), true);
  assert.equal(shouldCopyApp('.github', '/src/.github', true), true);
});

test('shouldCopyApp: .worktrees stays out of the installer entirely (hit while releasing 0.7.25 on 2026-10-24)', () => {
  // Missing this means distributing full source code of every branch to users: that time
  // runtime/app ballooned from 378 MB to 11 GB (just the pixel baseline in
  // .worktrees/_export-baseline was 7.9 GB), crashing makensis directly
  assert.equal(shouldCopyApp('.worktrees', '/src/.worktrees', true), false);
  // Blocked by name, so it gets caught at any depth
  assert.equal(shouldCopyApp('.worktrees', '/src/a/b/.worktrees', true), false);
  // Regular files with the same name are unaffected (consistent with other SKIP_DIRS criteria:
  // applies only to directories)
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
    write(src, 'vendor/sub/.git', 'gitdir: ../../.git/modules/sub\n'); // Submodules: .git files at nested levels
    write(src, 'vendor/sub/lib.js', 'ok');
    write(src, 'vendor/nested/.git/config', 'cfg'); // .git directories at nested levels
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
  // win32: convert full path to uppercase then convert drive letter back to lowercase; other
  // platforms have no such alias and run as-is (this degenerates into "path as-is")
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
