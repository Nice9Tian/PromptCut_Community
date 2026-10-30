/**
 * 审查环路的教训跨运行保存(runners/api.mjs 的 lessonsStore):放在 ai.json 同目录,
 * 去重、只留最近 30 条、文件坏了不崩。用 PROMPTCUT_AI_CONFIG 指到临时目录,不碰真配置。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lessonsStore } from '../runners/api.mjs';

function withTempConfig(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-lessons-'));
  const prev = process.env.PROMPTCUT_AI_CONFIG;
  process.env.PROMPTCUT_AI_CONFIG = path.join(dir, 'ai.json');
  try { fn(dir); } finally {
    if (prev === undefined) delete process.env.PROMPTCUT_AI_CONFIG; else process.env.PROMPTCUT_AI_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('没有文件时读出空列表;写进去的教训和 ai.json 在同一个目录', () => withTempConfig((dir) => {
  const s = lessonsStore();
  assert.deepEqual(s.read(), []);
  s.add(['先看画面再排卡']);
  assert.ok(fs.existsSync(path.join(dir, 'review-lessons.json')));
  assert.deepEqual(lessonsStore().read(), ['先看画面再排卡']);
}));

test('重复的教训不叠加,重新出现的挪到最后;只留最近 30 条', () => withTempConfig(() => {
  const s = lessonsStore();
  s.add(['一', '二']);
  s.add(['一']);
  assert.deepEqual(s.read(), ['二', '一']);
  s.add(Array.from({ length: 40 }, (_, i) => `教训 ${i}`));
  const all = s.read();
  assert.equal(all.length, 30);
  assert.equal(all.at(-1), '教训 39');
}));

test('文件坏了当作没有,不抛错', () => withTempConfig((dir) => {
  fs.writeFileSync(path.join(dir, 'review-lessons.json'), '{不是 JSON');
  assert.deepEqual(lessonsStore().read(), []);
}));
