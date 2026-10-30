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
const NO_CLOUD = fs.existsSync(path.join(HERE, '..', '..', 'cloud')) ? false : '当前工作区无 cloud/ 目录（社区版）';
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

test('EXT1 不设环境变量:按仓库根下的 cloud/ 找,本仓库里找得到 hosted 那一项', { skip: NO_CLOUD }, async () => {
  const table = await withEnv(null, () => loadFresh('default'));
  assert.ok(Array.isArray(table), '导出的应当是数组');
  assert.deepEqual(table.map((x) => x.name), ['hosted'], '本仓库 cloud/docservice/manifest.mjs 现在只有 hosted 一项');
});

test('EXT2 设了环境变量:按它指的目录找,不再看仓库根', async () => {
  const dir = makeCloudDir(['alpha', 'beta']);
  const table = await withEnv(dir, () => loadFresh('env'));
  assert.deepEqual(table.map((x) => x.name), ['alpha', 'beta'], '表的顺序要原样保留(社区先、云端后靠的就是它)');
});

test('EXT3 指到一个没有表的目录:回空数组,不抛 —— 社区版就是这种情况', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-nocloud-'));
  const table = await withEnv(empty, () => loadFresh('missing'));
  assert.deepEqual(table, [], '找不到表时一个扩展都不挂,但不能报错');
});

test('EXT4 表的形状不对(不是数组)也回空数组,不把坏表塞给文档服务', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-badcloud-'));
  fs.mkdirSync(path.join(dir, 'docservice'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docservice', 'manifest.mjs'), 'export default { 不是: "数组" };\n', 'utf8');
  const table = await withEnv(dir, () => loadFresh('bad'));
  assert.deepEqual(table, []);
});

test('EXT5 导出的表冻过:调用方改不动它', async () => {
  const table = await withEnv(null, () => loadFresh('frozen'));
  assert.ok(Object.isFrozen(table));
});
