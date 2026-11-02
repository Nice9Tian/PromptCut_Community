/*
 * T1a review #13: render specs and records for animated images are shared across multiple processes.
 *
 * Specs / records land in `ai-visual/` under `PROMPTCUT_EXPORT_DIR` (`visualDir` in
 * `server/vision/routes.ts`), and the editor process and prerender process (the two `user` / `agent`
 * processes when split) look at the same directory. Verified here with real child processes:
 *   1. Specs written by `writeJson` in one process can be read by `readJson` in another process (GET
 *      will not 404 because it was "written in another process");
 *   2. When one process repeatedly rewrites the same large spec, every read by the other process is
 *      a complete copy (writes a temp file first then renames), without reading partial JSON (which
 *      would make `readJson` return null and GET return 404);
 *   3. No temp files remain in the directory after renaming.
 * How to run: `node --test server/test/ai-visual-shared.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gifPaths, readJson, writeJson, atomicWrite } from '../ai-visual.mjs';

const LIB = new URL('../ai-visual.mjs', import.meta.url).href;

/** Run ESM in another node process and get back the last line of JSON from its stdout */
function runChild(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`Child process exited with code ${code}: ${err}`));
      try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch (e) { reject(new Error(`Child process output is not JSON: ${out}${err}`)); }
    });
  });
}

const withDir = async body => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-ai-visual-shared-'));
  try { return await body(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
};

test('The animated-image spec written by one process can be read by another (both directions)', () => withDir(async dir => {
  const key = '0123456789abcdef';
  const spec = { project: { fps: 30, duration: 2, tracks: [] }, clipId: 'c1', times: [0.5, 1.5] };
  // Child process writes (as "agent process writing specs"), this process reads (as "user process when user clicks")
  await runChild(`import { writeJson, gifPaths } from ${JSON.stringify(LIB)};
    await writeJson(${JSON.stringify(dir)}, gifPaths(${JSON.stringify(dir)}, ${JSON.stringify(key)}).spec, ${JSON.stringify(spec)});
    console.log(JSON.stringify({ ok: true }));`);
  assert.deepEqual(await readJson(dir, gifPaths(dir, key).spec), spec);
  // Conversely: this process writes records, child process reads
  await writeJson(dir, 'v-abc123.json', { tool: 'get_gif', after: { gif: `/api/ai/visual/gif/${key}.gif` } });
  const seen = await runChild(`import { readJson } from ${JSON.stringify(LIB)};
    console.log(JSON.stringify(await readJson(${JSON.stringify(dir)}, 'v-abc123.json')));`);
  assert.equal(seen.after.gif, `/api/ai/visual/gif/${key}.gif`);
}));

test('Reading while rewriting: the other process always reads a complete copy, and no temp file is left after the rename', () => withDir(async dir => {
  const name = 'spec-fedcba9876543210.json';
  const big = n => ({ n, pad: 'x'.repeat(2 * 1024 * 1024) });
  await writeJson(dir, name, big(0));
  const ROUNDS = 30;
  // Reader child process: keeps reading until seeing the final version, recording any failed read (null / missing n) along the way
  const reader = runChild(`import { readJson } from ${JSON.stringify(LIB)};
    let reads = 0, broken = 0, last = -1;
    const t0 = Date.now();
    while (last < ${ROUNDS} && Date.now() - t0 < 20000) {
      const v = await readJson(${JSON.stringify(dir)}, ${JSON.stringify(name)});
      reads++;
      if (!v || typeof v.n !== 'number' || v.pad.length !== ${2 * 1024 * 1024}) broken++;
      else last = v.n;
    }
    console.log(JSON.stringify({ reads, broken, last }));`);
  for (let n = 1; n <= ROUNDS; n++) await writeJson(dir, name, big(n));
  const result = await reader;
  assert.equal(result.last, ROUNDS, 'The reader saw the last version');
  assert.ok(result.reads > 1);
  assert.equal(result.broken, 0, `Read a half-written spec ${result.broken} times`);
  assert.deepEqual(await fs.readdir(dir), [name]);
}));

test('Function form of atomicWrite: when writing the temp name fails, no temp file is left and the target file is untouched', () => withDir(async dir => {
  const file = path.join(dir, 'gif-k.gif');
  await atomicWrite(file, Buffer.from('old'));
  await assert.rejects(atomicWrite(file, async temp => { await fs.writeFile(temp, 'half'); throw new Error('ffmpeg crashed'); }), /ffmpeg crashed/);
  assert.equal(await fs.readFile(file, 'utf8'), 'old');
  assert.deepEqual(await fs.readdir(dir), ['gif-k.gif']);
  // Preserve extension in temporary name (ffmpeg picks output format based on it)
  let seenTemp = '';
  await atomicWrite(file, async temp => { seenTemp = temp; await fs.writeFile(temp, 'new'); });
  assert.match(path.basename(seenTemp), /^gif-k\.\d+\.[0-9a-f]{8}\.tmp\.gif$/);
  assert.equal(await fs.readFile(file, 'utf8'), 'new');
}));
