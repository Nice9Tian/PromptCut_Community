/**
 * 同一条流的稀疏版任务与满密度任务并发推同一个结果键(线上 2026-10-21,`docs/archive/agent-reports/AGENT-cut-stream-fix.md` 缺陷 4):
 * 稀疏任务列完清单之后,满密度那一趟换掉某一段、旧的稀疏分段文件被删,稀疏任务推这一段时不该 ENOENT。
 *
 *   SPR1  collectStreamResult 之后删掉一个分段文件(模拟 `storeSegment` 5 秒后删被替换的分段):pushResult 照样推齐,
 *         推上去的字节就是列清单时的那份(哈希与清单一致)
 *   SPR2  同上,但文件被换成满密度的新字节(同名不同内容的极端情形):推的仍是清单里那份,不报「本机文件在清单之后被改过」
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectStreamResult, pushResult } from '../artifact-transfer.mjs';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sha16 = (b) => sha256(b).slice(0, 16);

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-spr-'));
  const streamKey = sha256('spr-stream');
  const dir = path.join(root, 'streams', streamKey);
  await fs.mkdir(dir, { recursive: true });
  const init = Buffer.concat([Buffer.from('....ftypiso6'), crypto.randomBytes(64)]);
  const initId = sha16(init);
  const manifest = { version: 1, streamKey, kind: 'card', plane: 'local', clipIds: ['c'], fps: 30, originFrame: 0, bound: { x: 0, y: 0, w: 8, h: 8 },
    inits: { [initId]: { codec: 'avc1', width: 8, height: 8, timescale: 15360, rect: null, encoder: 'libx264', bytes: init.length } }, segments: {} };
  await fs.writeFile(path.join(dir, `init-${initId}.mp4`), init);
  const segFiles = [];
  for (let n = 0; n <= 5; n++) {
    const bytes = Buffer.concat([Buffer.from('....moof'), crypto.randomBytes(300 + n)]);
    const file = `${n}-${sha16(bytes)}.m4s`;
    await fs.writeFile(path.join(dir, file), bytes);
    manifest.segments[n] = { file, init: initId, stride: 3, samples: 15, bytes: bytes.length };
    segFiles.push(file);
  }
  await fs.writeFile(path.join(dir, 'stream.json'), JSON.stringify(manifest));
  return { root, dir, streamKey, segFiles };
}

function fakeClient() {
  const got = new Map();
  return { got, async put(ns, bytes) { const hash = sha256(bytes); got.set(hash, bytes); return { hash, uploaded: true }; } };
}

const task = (streamKey) => ({ kind: 'stream', resultKey: streamKey, range: { unit: 'segment', from: 0, to: 5 }, input: { density: 'sparse' } });

test('SPR1 列完清单后分段文件被删:照样推齐,推的是列清单时那份字节', async () => {
  const f = await fixture();
  try {
    const { result, readBlob } = await collectStreamResult({ root: f.root }, task(f.streamKey));
    assert.equal(Object.keys(result.segments).length, 6);
    await fs.rm(path.join(f.dir, f.segFiles[4]));
    const client = fakeClient();
    const pushed = await pushResult(client, result, readBlob);
    assert.equal(pushed.uploaded, 7, '一个开头 + 六个分段都推了');
    assert.ok(client.got.has(result.segments[4].hash), '被删的那一段按清单里的哈希推上去了');
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('SPR2 列完清单后分段文件被换了内容:推的仍是清单里那份', async () => {
  const f = await fixture();
  try {
    const { result, readBlob } = await collectStreamResult({ root: f.root }, task(f.streamKey));
    await fs.writeFile(path.join(f.dir, f.segFiles[2]), Buffer.from('dense-replacement'));
    const client = fakeClient();
    await pushResult(client, result, readBlob);
    assert.ok(client.got.has(result.segments[2].hash));
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
