/**
 * Sparse-version task and full-density task for the same stream concurrently push the same result
 * key (production 2026-10-21, `docs/archive/agent-reports/AGENT-cut-stream-fix.md` defect 4):
 * after the sparse task finishes listing manifest, the full-density pass replaces a segment and
 * old sparse segment file is deleted; pushing this segment in sparse task should not ENOENT.
 *
 *   SPR1  Delete a segment file after collectStreamResult (simulating `storeSegment` deleting the
 *         replaced segment after 5 seconds): pushResult still pushes completely, and pushed bytes
 *         match the ones from when manifest was listed (hash matches manifest)
 *   SPR2  Same as above, but file is replaced with new full-density bytes (extreme case of same
 *         name, different content): still pushes version from manifest, without reporting "local
 *         file was modified after manifest"
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

test('SPR1 segment file deleted after the manifest was listed: still pushed in full, pushing the bytes as they were when the manifest was listed', async () => {
  const f = await fixture();
  try {
    const { result, readBlob } = await collectStreamResult({ root: f.root }, task(f.streamKey));
    assert.equal(Object.keys(result.segments).length, 6);
    await fs.rm(path.join(f.dir, f.segFiles[4]));
    const client = fakeClient();
    const pushed = await pushResult(client, result, readBlob);
    assert.equal(pushed.uploaded, 7, 'One init + six segments were all pushed');
    assert.ok(client.got.has(result.segments[4].hash), 'The deleted segment was pushed using the hash in the manifest');
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('SPR2 segment file contents replaced after the manifest was listed: what is pushed is still the one in the manifest', async () => {
  const f = await fixture();
  try {
    const { result, readBlob } = await collectStreamResult({ root: f.root }, task(f.streamKey));
    await fs.writeFile(path.join(f.dir, f.segFiles[2]), Buffer.from('dense-replacement'));
    const client = fakeClient();
    await pushResult(client, result, readBlob);
    assert.ok(client.got.has(result.segments[2].hash));
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
