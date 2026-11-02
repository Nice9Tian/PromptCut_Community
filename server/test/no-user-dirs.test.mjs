/**
 * 守门：测试与探针不写用户的 `%USERPROFILE%\Videos\PromptCut`（桌面版的导出目录，帧库在它下面）。
 *
 * 编辑器、预渲染进程的输出目录是「`PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR` 优先，缺省仓库 `out/`」；
 * 从桌面版的环境里跑测试或探针，子进程会继承桌面壳设的这两个变量，把帧库写进用户目录。做法见
 * `scripts/lib/user-dirs.mjs`。这里守四件事：
 *   1. `user-dirs.mjs` 的判定与摘除本身；
 *   2. `npm test` 的全局准备摘掉了这两个变量（静态核对 + 在全局准备之下运行时核对）；
 *   3. `scripts/` 下每个会起编辑器 / 托管组合 / 渲染进程 / `FramePipeline` 的脚本，第一个 import 都是
 *      `no-user-dirs.mjs`（产品入口在白名单里，写明原因）；
 *   4. `export-e2e.mjs` 的素材镜像是真目录加硬链接：新写的文件不进素材目录，删镜像不动素材。
 * 全部不依赖本机环境：路径判定用假的 home，扫描只读仓库文件，镜像用临时目录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_DIR_ENV_KEYS, userExportDir, isUnderUserExportDir, scrubUserDirEnv, assertNoUserExportDir } from '../../scripts/lib/user-dirs.mjs';
import { mirrorMediaLibrary } from '../../scripts/lib/dev-server.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('user-dirs: detection of the user\'s export directory (fake home)', () => {
  const home = path.resolve(os.tmpdir(), 'fake-home-no-user-dirs');
  assert.equal(userExportDir(home), path.join(home, 'Videos', 'PromptCut'));
  assert.equal(isUnderUserExportDir(path.join(home, 'Videos', 'PromptCut'), home), true);
  assert.equal(isUnderUserExportDir(path.join(home, 'Videos', 'PromptCut', 'frame-library'), home), true);
  assert.equal(isUnderUserExportDir(path.join(home, 'Videos', 'PromptCutX'), home), false, 'a sibling directory with the same prefix does not count');
  assert.equal(isUnderUserExportDir(path.join(home, 'Videos'), home), false);
  assert.equal(isUnderUserExportDir(path.join(REPO, 'out'), home), false);
  assert.equal(isUnderUserExportDir(undefined, home), false);
  assert.equal(isUnderUserExportDir('', home), false);
  if (process.platform === 'win32') {
    assert.equal(isUnderUserExportDir(path.join(home, 'VIDEOS', 'promptcut', 'media').toUpperCase(), home), true, 'case-insensitive on Windows');
  }
});

test('user-dirs: strips the output and data directory variables and leaves the rest alone; throws when explicitly pointed at a user directory', () => {
  assert.deepEqual([...USER_DIR_ENV_KEYS].sort(), ['PROMPTCUT_ARTIFACT_DIR', 'PROMPTCUT_DATA_DIR', 'PROMPTCUT_EXPORT_DIR']);
  const videos = userExportDir();
  const env = { PROMPTCUT_EXPORT_DIR: videos, PROMPTCUT_DATA_DIR: 'C:/x/data', PROMPTCUT_ARTIFACT_DIR: 'C:/x/artifacts', PROMPTCUT_STREAMS: '0', PATH: 'p' };
  const removed = scrubUserDirEnv(env);
  assert.deepEqual(removed.map((r) => r.key).sort(), ['PROMPTCUT_ARTIFACT_DIR', 'PROMPTCUT_DATA_DIR', 'PROMPTCUT_EXPORT_DIR']);
  assert.deepEqual(env, { PROMPTCUT_STREAMS: '0', PATH: 'p' });
  assert.deepEqual(scrubUserDirEnv(env), [], 'stripping again finds nothing');

  assert.throws(() => assertNoUserExportDir({ PROMPTCUT_EXPORT_DIR: path.join(videos, 'frame-library') }), /must not write there/);
  assert.throws(() => assertNoUserExportDir({ PROMPTCUT_DATA_DIR: videos }), /PROMPTCUT_DATA_DIR/);
  assert.throws(() => assertNoUserExportDir({ PROMPTCUT_ARTIFACT_DIR: videos }), /PROMPTCUT_ARTIFACT_DIR/);
  assert.doesNotThrow(() => assertNoUserExportDir({ PROMPTCUT_EXPORT_DIR: path.join(os.tmpdir(), 'e2e'), PROMPTCUT_DATA_DIR: path.join(REPO, 'out') }));
  assert.doesNotThrow(() => assertNoUserExportDir({}));
});

test('the global setup of npm test strips PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR', () => {
  const src = fs.readFileSync(path.join(REPO, 'server', 'test', 'global-setup.mjs'), 'utf8');
  assert.match(src, /import\s*\{[^}]*\bscrubUserDirEnv\b[^}]*\}\s*from\s*'\.\.\/\.\.\/scripts\/lib\/user-dirs\.mjs'/);
  const body = src.slice(src.indexOf('export async function globalSetup'));
  assert.match(body.slice(0, body.indexOf('\n}')), /scrubUserDirEnv\(process\.env\)/, 'globalSetup must strip this process\'s environment');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  // npm test 经 scripts/test-suite.mjs 起全量命令（见该文件头），全局准备的参数写在那里
  assert.equal(pkg.scripts.test, 'node scripts/test-suite.mjs', 'the entry point of npm test is a wrapper script');
  const suite = fs.readFileSync(path.join(REPO, 'scripts', 'test-suite.mjs'), 'utf8');
  assert.match(suite, /--test-global-setup=server\/test\/global-setup\.mjs/, 'npm test must go through this global setup');

  // 在全局准备之下运行(它设的 PROMPTCUT_TEST_BAD_PORTS_HELD 在)时,本进程的环境已经摘过
  if (process.env.PROMPTCUT_TEST_BAD_PORTS_HELD !== undefined) {
    for (const key of USER_DIR_ENV_KEYS) {
      assert.ok(!isUnderUserExportDir(process.env[key]), `${key}=${process.env[key]} points to the user's Videos\\PromptCut`);
    }
  }
});

/** 会起编辑器(vite)、托管组合、渲染主机或进程、导出、或在本进程里建 FramePipeline 的脚本 */
const STARTS_PROCESS = /vite\.js|viteBin\(|startDevServer\(|hosted\/main|hosted', 'main|render-host\.mjs|render-worker\.mjs|export-frames\.mjs|verify-determinism\.mjs|new FramePipeline|frameService\(|replay-frames\.mjs/;

/** 产品入口:要的就是用户的目录,不摘 */
const PRODUCT_ENTRIES = new Map([
  ['cloud/scripts/render-host.mjs', 'standalone render host, sets PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR explicitly from --data'],
  ['scripts/dev-lan.mjs', 'starts the real editor in LAN mode so the user can reach their own project from a phone; stripping these two variables would redirect the project to the repository\'s out/ and port.json would not be written'],
  ['scripts/lib/user-dirs.mjs', 'itself'],
  ['scripts/lib/no-user-dirs.mjs', 'itself'],
]);

function listMjs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'archive' && e.name !== 'node_modules') listMjs(p, out); }
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

test('scripts under scripts/ that spawn child processes or a FramePipeline all have no-user-dirs.mjs as their first import', () => {
  const offenders = [];
  let checked = 0;
  for (const file of listMjs(path.join(REPO, 'scripts'))) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    if (PRODUCT_ENTRIES.has(rel)) continue;
    const src = fs.readFileSync(file, 'utf8');
    if (!STARTS_PROCESS.test(src)) continue;
    checked++;
    const first = src.match(/^import[\s{*'"][^\n]*/m)?.[0] || '(no import)';
    const want = path.relative(path.dirname(file), path.join(REPO, 'scripts', 'lib', 'no-user-dirs.mjs')).split(path.sep).join('/');
    const spec = want.startsWith('.') ? want : `./${want}`;
    if (!first.startsWith(`import '${spec}'`)) offenders.push(`${rel}: first import is ${first.slice(0, 80)}, should import '${spec}'`);
  }
  assert.ok(checked >= 20, `too few scripts scanned (${checked}), the detection rule may be broken`);
  assert.deepEqual(offenders, [], 'these scripts start the editor or a render process but do not strip the external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR first');
});

test('export-e2e asset mirror: a real directory + hard links, newly written files do not go into the asset catalog, and deleting the mirror leaves the assets alone', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-media-mirror-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const src = path.join(base, 'lib');
  const dest = path.join(base, 'work', 'media');
  fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'aa.mp4'), 'video-bytes');
  fs.writeFileSync(path.join(src, 'sub', 'bb.png'), 'png-bytes');
  fs.writeFileSync(path.join(src, 'index.json'), '{"version":1,"items":{}}');

  const n = mirrorMediaLibrary(src, dest);
  assert.deepEqual(n, { linked: 2, copied: 1, skipped: 0 });
  assert.ok(!fs.lstatSync(dest).isSymbolicLink() && fs.lstatSync(dest).isDirectory(), 'the mirror is a real directory, not a link');
  assert.equal(fs.readFileSync(path.join(dest, 'aa.mp4'), 'utf8'), 'video-bytes');
  assert.equal(fs.statSync(path.join(src, 'aa.mp4')).nlink, 2, 'asset files are hard links');
  assert.equal(fs.readFileSync(path.join(dest, 'sub', 'bb.png'), 'utf8'), 'png-bytes');

  // 编辑器往内容库里写:新文件、改索引 —— 都不能出现在素材目录里
  fs.writeFileSync(path.join(dest, 'bake-x.png'), 'new');
  fs.writeFileSync(path.join(dest, 'index.json'), '{"version":1,"items":{"x":{}}}');
  assert.equal(fs.existsSync(path.join(src, 'bake-x.png')), false);
  assert.equal(fs.readFileSync(path.join(src, 'index.json'), 'utf8'), '{"version":1,"items":{}}');

  // 删整个镜像,素材都还在
  fs.rmSync(path.join(base, 'work'), { recursive: true, force: true });
  assert.equal(fs.readFileSync(path.join(src, 'aa.mp4'), 'utf8'), 'video-bytes');
  assert.equal(fs.readFileSync(path.join(src, 'sub', 'bb.png'), 'utf8'), 'png-bytes');
  assert.equal(fs.statSync(path.join(src, 'aa.mp4')).nlink, 1);

  assert.throws(() => mirrorMediaLibrary(path.join(base, 'nope'), path.join(base, 'm2')), /Asset directory does not exist/);
  fs.mkdirSync(path.join(base, 'exists'));
  assert.throws(() => mirrorMediaLibrary(src, path.join(base, 'exists')), /already exists/);
});
