/**
 * C6.6 上传队列（`docs/plan/c66-design.md` 第 2 节「项目里的记录」、第 3 节；验收 T2、T3）。
 * 跑：node --test server/test/c66-upload.test.mjs
 *
 * 只照设计稿写，没看实现。队列的名字与形状是假设 K2（见 `c66-kit.mjs` 文件头）。
 * 素材服务是真 HTTP（`fake-asset-service.mjs`，memory 实现，分片 64 KiB）；队列的每个请求经记录用的 `fetch`，
 * 顺序、分片号、断网都从这里看、从这里造。素材字节是伪随机数据（队列不看内容，只按哈希传）。
 * 被测模块不存在时每条用例各自失败、报原因。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAssetHarness } from './fake-asset-service.mjs';
import {
  ROOT, tempDir, sha256, bytesOf, recordingFetch, chunksOf, loadUploadQueue, sleep,
} from './c66-kit.mjs';

const CHUNK = 64 * 1024;
const harness = createAssetHarness();
const DIR = tempDir('pc-c66-upload-');
after(async () => { await harness.cleanup(); fs.rmSync(DIR, { recursive: true, force: true }); });

let seq = 0;
/** 写一个伪随机文件，回 `{ hash, path, ext, size, bytes }` */
function file(size, ext = 'mp4') {
  const bytes = bytesOf(size, ++seq * 7919);
  const p = path.join(DIR, `f${seq}.${ext}`);
  fs.writeFileSync(p, bytes);
  return { hash: sha256(bytes), path: p, ext, size, bytes };
}
const tier = ({ hash, path: p, ext }) => ({ hash, path: p, ext });
const chunkCount = (f) => Math.ceil(f.size / CHUNK);

/** 三个素材：A、B 是视频（两档），C 是图片（只有素材原尺寸） */
function materials() {
  const A = { small: file(150 * 1024), original: file(600 * 1024) };
  const B = { small: file(100 * 1024), original: file(300 * 1024) };
  const C = { original: file(70 * 1024, 'png') };
  const items = [
    { id: 'A', tiers: { small: tier(A.small), original: tier(A.original) } },
    { id: 'B', tiers: { small: tier(B.small), original: tier(B.original) } },
    { id: 'C', tiers: { original: tier(C.original) } },
  ];
  return { A, B, C, items };
}

/** 只看写请求（PUT 分片、POST complete），把连续同哈希的并成一段：[{ hash, puts: [n...], completed }] */
function writeRuns(log) {
  const runs = [];
  for (const e of log) {
    if (e.ns !== 'media' || (e.action !== 'put' && e.action !== 'complete')) continue;
    let last = runs[runs.length - 1];
    if (!last || last.hash !== e.hash) { last = { hash: e.hash, puts: [], completed: false }; runs.push(last); }
    if (e.action === 'put') last.puts.push(e.n);
    else last.completed = true;
  }
  return runs;
}

let qseq = 0;
const queueFile = () => path.join(DIR, `upload-queue-${++qseq}.json`);

async function drainWithin(q, ms) {
  let settled = false;
  const p = q.drain().then(() => { settled = true; }, () => { settled = true; });
  await Promise.race([p, sleep(ms)]);
  return settled;
}

// ------------------------------------------------------------------ T3

test('C66-T3-01 所有素材小尺寸先传、再按进队先后传素材原尺寸；上一档 complete 之后才写下一档', async () => {
  const createQueue = await loadUploadQueue();
  const srv = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true });
  const rec = recordingFetch();
  const { A, B, C, items } = materials();
  const q = createQueue({ file: queueFile(), base: srv.base, fetch: rec.fetch, chunkSize: CHUNK });
  for (const it of items) await q.enqueue(it);
  assert.equal(await drainWithin(q, 20_000), true, 'drain 要在 20 s 内跑完');
  await q.close();

  const runs = writeRuns(rec.log);
  const order = [A.small, B.small, A.original, B.original, C.original];
  assert.deepEqual(runs.map((r) => r.hash), order.map((f) => f.hash),
    `写请求要按「A 小、B 小、A 原、B 原、C 原」成段出现、不交错；实际段序：${runs.map((r) => r.hash.slice(0, 6)).join(' → ')}`);
  runs.forEach((r, i) => {
    assert.equal(r.completed, true, `第 ${i + 1} 段（${r.hash.slice(0, 6)}）以 complete 收尾`);
    assert.deepEqual([...new Set(r.puts)].sort((a, b) => a - b), [...Array(chunkCount(order[i])).keys()], `第 ${i + 1} 段传齐所有分片`);
  });
  // 每一段里 complete 是最后一个写请求
  const writes = rec.log.filter((e) => e.ns === 'media' && (e.action === 'put' || e.action === 'complete'));
  for (const f of order) {
    const idx = writes.map((e, i) => (e.hash === f.hash ? i : -1)).filter((i) => i >= 0);
    assert.equal(writes[idx[idx.length - 1]].action, 'complete', `${f.hash.slice(0, 6)} 的最后一个写请求是 complete`);
  }
  for (const f of order) assert.equal((await chunksOf(srv.base, f.hash)).complete, true, `${f.hash.slice(0, 6)} 在素材服务上 complete`);
  await srv.close();
});

// ------------------------------------------------------------------ T2

test('C66-T2-01 上传中断网、重启后续传：同一个 upload-queue.json 建新队列，只补缺的分片；素材小尺寸、素材原尺寸的 chunks 分别报 complete', async () => {
  const createQueue = await loadUploadQueue();
  const srv = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true });
  const { A, B, C, items } = materials();
  const qf = queueFile();

  // 第一个实例：A 素材原尺寸传过 3 片就断网，之后一直不通（这个实例不再恢复，模拟进程被关掉）
  let aOrigPuts = 0;
  const rec1 = recordingFetch((info, _log, state) => {
    if (info.action === 'put' && info.hash === A.original.hash && ++aOrigPuts > 3) {
      state.offline = true;
      throw new TypeError('fetch failed (测试断网)');
    }
    return undefined;
  });
  const q1 = createQueue({ file: qf, base: srv.base, fetch: rec1.fetch, chunkSize: CHUNK });
  for (const it of items) await q1.enqueue(it);
  await drainWithin(q1, 3000);
  await q1.close();

  assert.ok(fs.existsSync(qf), 'upload-queue.json 要落盘');
  assert.equal((await chunksOf(srv.base, A.small.hash)).complete, true, '断网前 A 的素材小尺寸已经传完');
  const mid = await chunksOf(srv.base, A.original.hash);
  assert.equal(mid.complete, false, '断网时 A 素材原尺寸没传完');
  const received = new Set(mid.received);
  assert.ok(received.size >= 1 && received.size < chunkCount(A.original), `A 素材原尺寸收了一部分分片：${[...received]}`);
  assert.equal((await chunksOf(srv.base, B.small.hash)).complete, true, '断网前 B 的素材小尺寸也已经传完（所有素材小尺寸先于任何素材原尺寸）');
  for (const f of [B.original, C.original]) {
    assert.equal((await chunksOf(srv.base, f.hash)).received.length, 0, `A 素材原尺寸没完之前 B、C 的素材原尺寸一片都没传（${f.hash.slice(0, 6)}）`);
  }

  // 第二个实例：同一个队列文件，不再 enqueue，网络正常
  const rec2 = recordingFetch();
  const q2 = createQueue({ file: qf, base: srv.base, fetch: rec2.fetch, chunkSize: CHUNK });
  assert.equal(await drainWithin(q2, 20_000), true, '续传要在 20 s 内跑完');
  await q2.close();

  const puts = (f) => rec2.log.filter((e) => e.action === 'put' && e.hash === f.hash).map((e) => e.n);
  assert.deepEqual(puts(A.small), [], '已 complete 的 A 素材小尺寸不重传');
  assert.deepEqual(puts(B.small), [], '已 complete 的 B 素材小尺寸不重传');
  const missing = [...Array(chunkCount(A.original)).keys()].filter((n) => !received.has(n));
  assert.deepEqual([...puts(A.original)].sort((a, b) => a - b), missing, 'A 素材原尺寸只补缺的分片，每片一次');
  const runs = writeRuns(rec2.log).map((r) => r.hash);
  assert.deepEqual(runs, [A.original.hash, B.original.hash, C.original.hash], '续传按「A 原、B 原、C 原」（两份素材小尺寸重启前已传完）');

  for (const [name, f] of Object.entries({ 'A 素材小尺寸': A.small, 'A 素材原尺寸': A.original, 'B 素材小尺寸': B.small, 'B 素材原尺寸': B.original, 'C 素材原尺寸': C.original })) {
    const st = await chunksOf(srv.base, f.hash);
    assert.equal(st.complete, true, `${name} 的 GET media/<hash>/chunks 报 complete: true`);
  }

  // 两档都 complete 才出队：再起一个实例，什么都不写
  const rec3 = recordingFetch();
  const q3 = createQueue({ file: qf, base: srv.base, fetch: rec3.fetch, chunkSize: CHUNK });
  assert.equal(await drainWithin(q3, 5000), true);
  await q3.close();
  assert.deepEqual(rec3.log.filter((e) => e.action === 'put' || e.action === 'complete'), [], '队列已空：再起实例不发任何写请求');
  await srv.close();
});

test('C66-T2-02 素材服务上已 complete 的档不重传（问过 chunks 就跳过）', async () => {
  const createQueue = await loadUploadQueue();
  const srv = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true });
  const { A, items } = materials();
  // 事先把 A 的素材小尺寸放进素材服务
  const st = srv.stores.media;
  for (let n = 0; n < chunkCount(A.small); n++) {
    const part = A.small.bytes.subarray(n * CHUNK, Math.min(A.small.size, (n + 1) * CHUNK));
    const r = await st.putChunk(A.small.hash, n, { size: A.small.size, ext: 'mp4' }, [part]);
    assert.equal(r.status, 'ok');
  }
  assert.equal((await st.complete(A.small.hash)).status, 'ok');
  const rec = recordingFetch();
  const q = createQueue({ file: queueFile(), base: srv.base, fetch: rec.fetch, chunkSize: CHUNK });
  await q.enqueue(items[0]);
  assert.equal(await drainWithin(q, 20_000), true);
  await q.close();
  assert.deepEqual(rec.log.filter((e) => e.action === 'put' && e.hash === A.small.hash), [], '已 complete 的素材小尺寸一片都不传');
  assert.equal((await chunksOf(srv.base, A.original.hash)).complete, true);
  await srv.close();
});

test('C66-T2-03 同步状态不进项目：MediaTiers 只有 small / original，MediaAsset 没有上传、同步、可播性一类字段', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'kernel', 'project.ts'), 'utf8');
  const fieldsOf = (name) => {
    const m = new RegExp(`export interface ${name}\\s*\\{`).exec(src);
    assert.ok(m, `project.ts 里要有 interface ${name}`);
    // 取到配对的右花括号
    let depth = 0, i = m.index + m[0].length - 1, end = -1;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { end = i; break; }
    }
    const body = src.slice(m.index + m[0].length, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // 只取第一层的字段名
    const names = [];
    let d = 0;
    for (const line of body.split('\n')) {
      const hit = d === 0 ? /^\s*([A-Za-z_$][\w$]*)\??\s*:/.exec(line) : null;
      if (hit) names.push(hit[1]);
      d += (line.match(/[{(<[]/g) ?? []).length - (line.match(/[})>\]]/g) ?? []).length;
    }
    return names;
  };
  assert.deepEqual(fieldsOf('MediaTiers').sort(), ['original', 'small'], 'MediaTiers 只有两档的哈希');
  const bad = fieldsOf('MediaAsset').filter((n) => /upload|sync|complete|received|chunk|playab|progress|queue|transfer/i.test(n));
  assert.deepEqual(bad, [], `MediaAsset 不该有同步状态 / 可播性字段：${bad.join(', ')}`);
});
