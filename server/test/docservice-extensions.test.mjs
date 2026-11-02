/**
 * `server/docservice/extensions.mjs` 的单测：云端加载表怎么找、找不到怎么办（接缝总纲
 * `docs/plan/community-boundary.md` 第一、二节）。
 *
 * 为什么非测不可：这个模块的失败方式是**静默的** —— 路径指错就是「一个扩展都不挂」，没有异常、没有日志，
 * 而私有仓库里两边文件都齐，缺了也看不出来。子模块布局（公开仓库挂在私有仓库的 `community/` 下）正是
 * 会让相对路径指错的那种布局，所以 `PROMPTCUT_CLOUD_DIR` 这条路必须有测试钉住，不能只靠缺省那条跑通。
 *
 * 模块在求值阶段就把表读完了（顶层 await），所以每个用例都用带查询串的动态 import 拿一份新的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 社区版（公开仓库）里没有 cloud/：测闭源那一半的几条在那边跳过，和 agent-extensions 的 EXT1 同一个做法
const NO_CLOUD = fs.existsSync(path.join(HERE, '..', '..', 'cloud')) ? false : 'The current checkout has no cloud/ directory (community edition)';
const ENTRY = path.join(HERE, '..', 'docservice', 'extensions.mjs');

/** 载一份新的 `extensions.mjs`（绕开模块缓存，让顶层 await 重新跑一遍） */
async function loadFresh(tag) {
  const mod = await import(`${pathToFileURL(ENTRY).href}?case=${tag}`);
  return mod.docServiceExtensions;
}

/** 造一个临时云端目录，里面放一张表 */
function makeCloudDir(items) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cloud-'));
  fs.mkdirSync(path.join(dir, 'docservice'), { recursive: true });
  const body = `export const manifest = ${JSON.stringify(items)}.map((name) => ({ name, create: () => ({ name }) }));\nexport default manifest;\n`;
  fs.writeFileSync(path.join(dir, 'docservice', 'manifest.mjs'), body, 'utf8');
  return dir;
}

const withEnv = async (value, fn) => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'PROMPTCUT_CLOUD_DIR');
  const old = process.env.PROMPTCUT_CLOUD_DIR;
  if (value === null) delete process.env.PROMPTCUT_CLOUD_DIR;
  else process.env.PROMPTCUT_CLOUD_DIR = value;
  try {
    return await fn();
  } finally {
    if (had) process.env.PROMPTCUT_CLOUD_DIR = old;
    else delete process.env.PROMPTCUT_CLOUD_DIR;
  }
};

test('EXT1 without the environment variable: looks under cloud/ in the repo root, and the hosted entry is found in this repo', { skip: NO_CLOUD }, async () => {
  const table = await withEnv(null, () => loadFresh('default'));
  assert.ok(Array.isArray(table), 'the export should be an array');
  assert.deepEqual(table.map((x) => x.name), ['hosted'], 'in this repo cloud/docservice/manifest.mjs currently has only the hosted entry');
});

test('EXT2 with the environment variable set: looks in the directory it points to, no longer at the repo root', async () => {
  const dir = makeCloudDir(['alpha', 'beta']);
  const table = await withEnv(dir, () => loadFresh('env'));
  assert.deepEqual(table.map((x) => x.name), ['alpha', 'beta'], 'table order must be preserved as is (community first, cloud last relies on exactly this)');
});

test('EXT3 pointed at a directory with no table: returns an empty array, does not throw. This is exactly the case of the community edition', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-nocloud-'));
  const table = await withEnv(empty, () => loadFresh('missing'));
  assert.deepEqual(table, [], 'When no table is found, no extension is attached, but it must not raise an error');
});

test('EXT4 a table with the wrong shape (not an array) also returns an empty array, so a bad table is never handed to the document service', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-badcloud-'));
  fs.mkdirSync(path.join(dir, 'docservice'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docservice', 'manifest.mjs'), 'export default { notAnArray: "array" };\n', 'utf8');
  const table = await withEnv(dir, () => loadFresh('bad'));
  assert.deepEqual(table, []);
});

test('EXT5 the exported table is frozen: callers cannot modify it', async () => {
  const table = await withEnv(null, () => loadFresh('frozen'));
  assert.ok(Object.isFrozen(table));
});
