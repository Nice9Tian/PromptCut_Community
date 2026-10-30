/**
 * 0.7.18 逐项验收 2.1-12「缺失视觉/音频素材」里 main 上现在就能验的那一小块:随软件分发的占位人声文件本身。
 * 契约(account-binding-contract.md「缺失素材占位」)写明:`src/audio/assets/missing-material.wav`,PCM 16 位、48 kHz、单声道、1.37 秒、
 * 131,564 字节,SHA-256 `5E615376504BDD9350A88E890E3FE320109719A5DAB42D760BC658B993CCF4E7`;它不是项目素材,不存进项目。
 * 画面占位、弹窗、找回、在线浏览器与导出放得出来,都在分支 `claude/v18-missing` 上,main 上验不了(见地图 2.1-12)。
 *
 * 跑:npm test -- server/test/accept-018-files-missing-voice.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const WAV = path.join(ROOT, 'src', 'audio', 'assets', 'missing-material.wav');

test('ACC018-VOICE-1 占位人声文件与契约写的一致:大小、SHA-256、PCM16/48kHz/单声道、时长 1.37 秒', () => {
  const bytes = fs.readFileSync(WAV);
  assert.equal(bytes.length, 131_564);
  assert.equal(createHash('sha256').update(bytes).digest('hex').toUpperCase(), '5E615376504BDD9350A88E890E3FE320109719A5DAB42D760BC658B993CCF4E7');
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  // 找 fmt 和 data 块
  let p = 12, fmt = null, dataBytes = null;
  while (p + 8 <= bytes.length) {
    const id = bytes.toString('ascii', p, p + 4), size = bytes.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { format: bytes.readUInt16LE(p + 8), channels: bytes.readUInt16LE(p + 10), rate: bytes.readUInt32LE(p + 12), bits: bytes.readUInt16LE(p + 22) };
    if (id === 'data') dataBytes = size;
    p += 8 + size + (size % 2);
  }
  assert.deepEqual(fmt, { format: 1, channels: 1, rate: 48_000, bits: 16 });
  assert.ok(Math.abs(dataBytes / 2 / 48_000 - 1.37) < 0.005, `时长 ${dataBytes / 2 / 48_000} 秒`);
});

test('ACC018-VOICE-2 占位人声不是项目素材:项目文件(.proc 序列化)里不含它的路径或哈希', () => {
  // 序列化只在 proc.ts;这里只守「仓库里没有任何东西把这个 wav 登记成项目素材或预置进素材库」的文本事实。
  const hash = '5e615376504bdd9350a88e890e3fe320109719a5dab42d760bc658b993ccf4e7';
  const hits = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'dist-online', '.worktrees', 'out'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(ts|tsx|mjs|json)$/.test(e.name) && !/accept-018/.test(e.name) && /project|media|proc/i.test(e.name)) {
      const text = fs.readFileSync(full, 'utf8');
      if (text.includes(hash) || text.includes('missing-material.wav')) hits.push(path.relative(ROOT, full));
    }
  } };
  walk(path.join(ROOT, 'src')); walk(path.join(ROOT, 'server'));
  // A3 之后闭源的那几摊在 cloud/ 下（公开仓库里没有这个目录）；这道检查原来就管着它们，搬走以后也要接着管
  for (const d of ['cloud/src', 'cloud/server']) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  const isTest = (h) => /\.test\./.test(h) || h.split(path.sep).includes('test');
  assert.deepEqual(hits.filter(h => !isTest(h)), [], '项目/素材/打包相关代码不登记这个文件');
});
