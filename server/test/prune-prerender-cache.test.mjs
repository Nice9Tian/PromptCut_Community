import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findStale, removeStale, looksLikeFrameLibrary, M4_KEYS_SINCE } from '../prerender-cache-prune.mjs';

const key = n => n.toString(16).padStart(64, '0');
const BEFORE = Date.parse('2026-09-24T12:00:00Z');
const OLD = new Date(BEFORE - 3600_000);
const NEW = new Date(BEFORE + 3600_000);

async function file(root, rel, when) {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, 'x'.repeat(10));
  await fs.utimes(full, when, when);
  return full;
}
/** 把目录自身的 mtime 也拨回去(建文件会刷新它),从最里层往外 */
async function age(root, rel, when) {
  const parts = rel.split('/');
  for (let i = parts.length; i > 0; i--) await fs.utimes(path.join(root, ...parts.slice(0, i)), when, when);
}

async function library() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-prune-'));
  await file(root, `controls-html/${key(1)}/0.html`, OLD); await age(root, `controls-html/${key(1)}`, OLD);
  await file(root, `controls-html/${key(2)}/0.html`, NEW);
  // 旧目录里有一个新文件:整个目录保留
  await file(root, `controls/${key(3)}/mov/frames/000000.png`, OLD);
  await file(root, `controls/${key(3)}/mov/frames/000001.png`, NEW);
  await file(root, `controls-local/${key(4)}/${key(5)}/0.html`, OLD); await age(root, `controls-local/${key(4)}/${key(5)}`, OLD);
  await file(root, `streams/${key(6)}/stream.json`, OLD); await age(root, `streams/${key(6)}`, OLD);
  await file(root, `tracks/${key(7)}/000000.png`, OLD); await age(root, `tracks/${key(7)}`, OLD);
  await file(root, `${key(8)}/html-manifest.json`, OLD); await age(root, key(8), OLD);
  // 不该碰的:锁目录、认不出的目录名、根下的普通文件
  await file(root, `controls-lock/${key(9)}.json`, OLD);
  await file(root, `controls-html/not-a-key/0.html`, OLD);
  await file(root, 'readme.txt', OLD);
  return root;
}

test('找旧目录:最新文件早于分界的键目录才算旧,六类都认', async () => {
  const root = await library();
  try {
    const { stale, kept } = await findStale(root, BEFORE);
    const names = stale.map(item => `${item.family}:${path.relative(root, item.dir).replaceAll('\\', '/')}`).sort();
    assert.deepEqual(names, [
      `controls-html:controls-html/${key(1)}`,
      `controls-local:controls-local/${key(4)}/${key(5)}`,
      `entry:${key(8)}`,
      `streams:streams/${key(6)}`,
      `tracks:tracks/${key(7)}`,
    ].sort());
    assert.equal(kept, 2, '新写的共享档与带新文件的 PNG 缓存保留');
    assert.ok(stale.every(item => item.bytes > 0 && item.newest < BEFORE));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('删旧目录:只删找出来的,本地档外层空了一并删,锁目录和别的东西不动', async () => {
  const root = await library();
  try {
    const { stale } = await findStale(root, BEFORE);
    assert.equal(await removeStale(root, stale), stale.length);
    const exists = rel => fs.access(path.join(root, rel)).then(() => true, () => false);
    for (const item of stale) assert.equal(await exists(path.relative(root, item.dir)), false);
    assert.equal(await exists(`controls-local/${key(4)}`), false, '本地档外层删空了');
    assert.equal(await exists(`controls-html/${key(2)}`), true);
    assert.equal(await exists(`controls/${key(3)}/mov/frames/000000.png`), true);
    assert.equal(await exists(`controls-lock/${key(9)}.json`), true);
    assert.equal(await exists('controls-html/not-a-key/0.html'), true);
    assert.equal(await exists('readme.txt'), true);
    assert.deepEqual((await findStale(root, BEFORE)).stale, [], '再跑一次没有可删的');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('防指错:不像帧库的目录不处理;缺省分界是 M4 合并时刻', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-prune-'));
  try {
    assert.equal(await looksLikeFrameLibrary(root), false);
    await fs.mkdir(path.join(root, 'controls-html'));
    assert.equal(await looksLikeFrameLibrary(root), true);
    assert.equal(M4_KEYS_SINCE, Date.parse('2026-09-24T12:15:16Z'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
