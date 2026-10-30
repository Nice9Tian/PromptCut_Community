/*
 * T1a 审查 #13:动图的渲染规格和记录在几个进程之间共用。
 *
 * 规格 / 记录落在 `PROMPTCUT_EXPORT_DIR` 下的 `ai-visual/`(`server/vision/routes.ts` 的 `visualDir`),
 * 编辑器进程和预渲染进程(拆分时 `user` / `agent` 两个)看的是同一个目录。这里用真的子进程验:
 *   1. 一个进程 `writeJson` 写下的规格,另一个进程 `readJson` 读得到(GET 不会因为「写在别的进程里」而 404);
 *   2. 一个进程反复改写同一份大规格时,另一个进程每一次读都是完整的一份(先写临时文件再改名),
 *      不会读到半截 JSON(那样 `readJson` 回 null,GET 就是 404);
 *   3. 改名之后目录里不留临时文件。
 * 跑法:`node --test server/test/ai-visual-shared.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gifPaths, readJson, writeJson, atomicWrite } from '../ai-visual.mjs';

const LIB = new URL('../ai-visual.mjs', import.meta.url).href;

/** 在另一个 node 进程里跑一段 ESM,拿回它 stdout 的最后一行 JSON */
function runChild(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`子进程退出 ${code}:${err}`));
      try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch (e) { reject(new Error(`子进程输出不是 JSON:${out}${err}`)); }
    });
  });
}

const withDir = async body => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-ai-visual-shared-'));
  try { return await body(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
};

test('一个进程写下的动图规格,另一个进程读得到(两个方向)', () => withDir(async dir => {
  const key = '0123456789abcdef';
  const spec = { project: { fps: 30, duration: 2, tracks: [] }, clipId: 'c1', times: [0.5, 1.5] };
  // 子进程(当「写规格的 agent 进程」)写,本进程(当「用户点开时的 user 进程」)读
  await runChild(`import { writeJson, gifPaths } from ${JSON.stringify(LIB)};
    await writeJson(${JSON.stringify(dir)}, gifPaths(${JSON.stringify(dir)}, ${JSON.stringify(key)}).spec, ${JSON.stringify(spec)});
    console.log(JSON.stringify({ ok: true }));`);
  assert.deepEqual(await readJson(dir, gifPaths(dir, key).spec), spec);
  // 反过来:本进程写记录,子进程读
  await writeJson(dir, 'v-abc123.json', { tool: 'get_gif', after: { gif: `/api/ai/visual/gif/${key}.gif` } });
  const seen = await runChild(`import { readJson } from ${JSON.stringify(LIB)};
    console.log(JSON.stringify(await readJson(${JSON.stringify(dir)}, 'v-abc123.json')));`);
  assert.equal(seen.after.gif, `/api/ai/visual/gif/${key}.gif`);
}));

test('边改写边读:另一个进程每一次读到的都是完整的一份,改名后不留临时文件', () => withDir(async dir => {
  const name = 'spec-fedcba9876543210.json';
  const big = n => ({ n, pad: 'x'.repeat(2 * 1024 * 1024) });
  await writeJson(dir, name, big(0));
  const ROUNDS = 30;
  // 读者子进程:一直读到看见最后一版,途中任何一次读不出(null / n 缺失)都记下来
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
  assert.equal(result.last, ROUNDS, '读者看到了最后一版');
  assert.ok(result.reads > 1);
  assert.equal(result.broken, 0, `读到了半截规格 ${result.broken} 次`);
  assert.deepEqual(await fs.readdir(dir), [name]);
}));

test('atomicWrite 的函数形式:写临时名失败时不留临时文件,目标文件不动', () => withDir(async dir => {
  const file = path.join(dir, 'gif-k.gif');
  await atomicWrite(file, Buffer.from('old'));
  await assert.rejects(atomicWrite(file, async temp => { await fs.writeFile(temp, 'half'); throw new Error('ffmpeg 挂了'); }), /ffmpeg 挂了/);
  assert.equal(await fs.readFile(file, 'utf8'), 'old');
  assert.deepEqual(await fs.readdir(dir), ['gif-k.gif']);
  // 临时名保留扩展名(ffmpeg 按它选输出格式)
  let seenTemp = '';
  await atomicWrite(file, async temp => { seenTemp = temp; await fs.writeFile(temp, 'new'); });
  assert.match(path.basename(seenTemp), /^gif-k\.\d+\.[0-9a-f]{8}\.tmp\.gif$/);
  assert.equal(await fs.readFile(file, 'utf8'), 'new');
}));
