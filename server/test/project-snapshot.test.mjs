/**
 * 项目快照（契约 `docs/plan/render-queue-contract.md` J.1、J.2，J.7 用例 J1～J4）。
 * 跑：node --test server/test/project-snapshot.test.mjs
 *
 * 只照契约写，不看实现。
 *
 * 约定：
 *   - 真文档服务：独立模式、端口 0、`autoTick: false`，挂 C6.3 的项目模块 `projectModule({ store, now })`；
 *     存储用 memory，或临时目录上的文件存储（J3 重启）。
 *   - 线上协议照 J.1：
 *       `project.snapshot.put { projectId, projectRev, digest, index, count, data }`
 *         → `project.snapshot.stored { projectId, projectRev, received, count, complete }` 或 `error { reason }`；
 *       `project.snapshot.get { projectId, projectRev }`
 *         → 若干 `project.snapshot.part { …, index, count, data }`（index 升序），最后 `project.snapshot.end { …, digest }`；
 *         没有这份快照时回 `project.snapshot.part { …, missing: true }`。
 *     回包都带请求的 `reqId`，测试按 `reqId` 收。
 *   - 摘要 = 项目 JSON 全文的 sha256 十六进制；版本先经 `project.announce` 登记（C6.3 第 1 节）。
 *   - 客户端 `createProjectClient(endpoint, { timeoutMs })`（J.2），端点用 M5a 的 `createWsEndpoint`。
 *     「服务端不回」用一个吞掉 `project.*` 的假模块，或者一个只记下发出消息的假端点。
 *
 * 被测模块（项目模块的快照部分、`project-client.mjs`）还没有时，每条用例各自失败、报原因。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadStore, loadProject, tempDir, startStandalone, ask } from './fake-docservice-env.mjs';
import { connectEndpoint, until } from './fake-manifest-env.mjs';

const T0 = 1_700_000_000_000;
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const CHUNK_MAX = 512 * 1024;

/** 起一台只挂项目模块的文档服务 */
async function start({ store, dir } = {}) {
  const { createMemoryStore, createFileStore } = await loadStore();
  const makeProject = await loadProject();
  const s = store ?? (dir ? createFileStore({ dir }) : createMemoryStore());
  const now = () => T0;
  const env = await startStandalone({ modules: [makeProject({ store: s, now })], now });
  return { ...env, store: s };
}

/** 一段项目 JSON 文本（`size` 大约多少字符；`seed` 换内容） */
function projectText(seed, size = 2000, { cjk = false } = {}) {
  const filler = cjk ? '字幕轨道卡片'.repeat(Math.ceil(size / 6)).slice(0, size) : 'x'.repeat(size);
  return JSON.stringify({ id: `proj-${seed}`, seed, fps: 30, width: 1920, height: 1080, tracks: [{ id: 't1', clips: [] }], note: filler });
}

/** 按字符切成 n 片（只用 BMP 字符，不会切开代理对） */
function chunksOf(text, n) {
  const size = Math.ceil(text.length / n);
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

let seq = 0;
const put = (c, fields) => ask(c, { type: 'project.snapshot.put', ...fields });

/** 发 get，按 reqId 收全部回包：part…end，或一条 missing；回 { parts, end, missing, replies } */
async function getSnapshot(c, projectId, projectRev, ms = 5000) {
  const reqId = `get-${++seq}`;
  c.send({ type: 'project.snapshot.get', projectId, projectRev, reqId });
  const replies = [];
  for (;;) {
    const m = await c.next((x) => x?.reqId === reqId, ms);
    replies.push(m);
    if (m.type === 'project.snapshot.part' && m.missing === true) return { parts: [], end: null, missing: true, replies };
    if (m.type === 'project.snapshot.end') {
      return { parts: replies.filter((r) => r.type === 'project.snapshot.part'), end: m, missing: false, replies };
    }
    if (m.type === 'error') return { parts: [], end: null, missing: false, error: m, replies };
    assert.equal(m.type, 'project.snapshot.part', `get 的回包只能是 part / end：${JSON.stringify(m).slice(0, 300)}`);
  }
}

/** 把 get 的分片拼起来，顺带核对 J.1 的形状 */
function assemble(got, projectId, projectRev) {
  assert.equal(got.missing, false, 'get 取得到');
  assert.ok(got.end, '最后一条是 project.snapshot.end');
  const { parts, end } = got;
  assert.ok(parts.length >= 1, '至少一片');
  parts.forEach((p, i) => {
    assert.equal(p.index, i, `分片按 index 升序、从 0 起、连续：第 ${i} 条是 index ${p.index}`);
    assert.equal(p.count, parts.length, `每片的 count 等于分片数：${p.count} / ${parts.length}`);
    assert.equal(p.projectId, projectId);
    assert.equal(p.projectRev, projectRev);
    assert.equal(typeof p.data, 'string');
  });
  assert.equal(end.projectId, projectId);
  assert.equal(end.projectRev, projectRev);
  const text = parts.map((p) => p.data).join('');
  assert.equal(end.digest, sha256(text), 'end.digest 是全文的 sha256');
  assert.ok(got.replies.indexOf(end) === got.replies.length - 1, 'end 在最后');
  return text;
}

/** announce 这份文本的摘要，回 projectRev */
async function announce(c, projectId, text) {
  const ack = await ask(c, { type: 'project.announce', projectId, digest: sha256(text) });
  assert.equal(ack.type, 'project.announced', `announce 成功：${JSON.stringify(ack)}`);
  return ack.projectRev;
}

/** 按给定顺序上传 chunks（`order` 是 index 列表，可以重复），回每条回包 */
async function upload(c, projectId, projectRev, text, chunks, order = chunks.map((_, i) => i), digest = sha256(text)) {
  const replies = [];
  for (const index of order) {
    replies.push(await put(c, { projectId, projectRev, digest, index, count: chunks.length, data: chunks[index] }));
  }
  return replies;
}

/* ------------------------------------------------------------------ J1 */

test('J1 分片上传后 get 按序收到全部分片与 end，拼起来与原文逐字节相同；回包带 reqId', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  const text = projectText('j1', 6000, { cjk: true });
  const rev = await announce(c, 'proj-j1', text);
  assert.equal(rev, 1);
  const chunks = chunksOf(text, 3);
  const replies = await upload(c, 'proj-j1', rev, text, chunks);
  replies.forEach((r, i) => {
    assert.equal(r.type, 'project.snapshot.stored', `第 ${i} 片回 stored：${JSON.stringify(r)}`);
    assert.deepEqual(
      { projectId: r.projectId, projectRev: r.projectRev, received: r.received, count: r.count, complete: r.complete },
      { projectId: 'proj-j1', projectRev: 1, received: i + 1, count: 3, complete: i === 2 },
      `第 ${i} 片的回包`,
    );
  });

  const got = await getSnapshot(c, 'proj-j1', 1);
  const back = assemble(got, 'proj-j1', 1);
  assert.equal(Buffer.compare(Buffer.from(back, 'utf8'), Buffer.from(text, 'utf8')), 0, '拼起来与原文逐字节相同');
  assert.ok(got.replies.every((m) => typeof m.reqId === 'string'), 'get 的每条回包都带 reqId');

  // 另一条连接（另一台节点）也取得到
  const d = await env.connect('bob');
  assert.equal(assemble(await getSnapshot(d, 'proj-j1', 1), 'proj-j1', 1), text);
});

test('J1 乱序上传、重传同一片：结果与顺序上传相同；收齐之前 get 回 missing', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  const text = projectText('j1-shuffle', 9000);
  const rev = await announce(c, 'proj-j1b', text);
  const chunks = chunksOf(text, 4);

  const first = await upload(c, 'proj-j1b', rev, text, chunks, [2, 0]);
  assert.ok(first.every((r) => r.type === 'project.snapshot.stored' && r.complete === false), `没收齐：${JSON.stringify(first)}`);
  assert.deepEqual(first.map((r) => r.received), [1, 2]);
  assert.equal((await getSnapshot(c, 'proj-j1b', rev)).missing, true, '收齐之前没有这份快照');

  const dup = await put(c, { projectId: 'proj-j1b', projectRev: rev, digest: sha256(text), index: 2, count: 4, data: chunks[2] });
  assert.equal(dup.type, 'project.snapshot.stored', `重传同一片照常回 stored：${JSON.stringify(dup)}`);
  assert.equal(dup.received, 2, '重传不重复计数');
  assert.equal(dup.complete, false);

  const rest = await upload(c, 'proj-j1b', rev, text, chunks, [3, 1]);
  assert.deepEqual(rest.map((r) => [r.received, r.complete]), [[3, false], [4, true]]);
  assert.equal(assemble(await getSnapshot(c, 'proj-j1b', rev), 'proj-j1b', rev), text, '乱序、重传之后拼出的与原文相同');

  // 同一项目的下一版：各版各存一份，互不覆盖
  const text2 = projectText('j1-shuffle-v2', 3000);
  const rev2 = await announce(c, 'proj-j1b', text2);
  assert.equal(rev2, rev + 1);
  await upload(c, 'proj-j1b', rev2, text2, chunksOf(text2, 2), [1, 1, 0]);
  assert.equal(assemble(await getSnapshot(c, 'proj-j1b', rev2), 'proj-j1b', rev2), text2);
  assert.equal(assemble(await getSnapshot(c, 'proj-j1b', rev), 'proj-j1b', rev), text, '上一版的快照仍在（快照不可变）');
});

test('J1 大快照（约 1.5 MiB，每片 ≤ 512 KiB）：get 分多片送回，拼起来相同，连接不被背压关掉', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  const text = projectText('j1-big', Math.floor(1.5 * 1024 * 1024));
  const rev = await announce(c, 'proj-big', text);
  const chunks = chunksOf(text, 4);
  assert.ok(chunks.every((s) => Buffer.byteLength(s, 'utf8') <= CHUNK_MAX), '夹具：每片 ≤ 512 KiB');
  const replies = await upload(c, 'proj-big', rev, text, chunks);
  assert.equal(replies.at(-1).complete, true, `收齐：${JSON.stringify(replies.at(-1))}`);

  const closedEarly = { v: false };
  const whenClosed = c.closed.then((e) => { closedEarly.v = true; throw new Error(`取快照途中连接被关闭：${e?.code}/${e?.reason}（出站背压上限是 1 MiB，H.2）`); });
  whenClosed.catch(() => {});
  const got = await Promise.race([getSnapshot(c, 'proj-big', rev, 8_000), whenClosed]);
  const back = assemble(got, 'proj-big', rev);
  assert.equal(back.length, text.length);
  assert.equal(back, text, '拼起来与原文相同');
  for (const p of got.parts) assert.ok(Buffer.byteLength(p.data, 'utf8') <= CHUNK_MAX, `get 的每片也 ≤ 512 KiB：${Buffer.byteLength(p.data, 'utf8')}`);
  assert.equal(closedEarly.v, false, '取大快照时连接没有被关掉（契约 J.1 允许整份到 32 MiB）');
});

/* ------------------------------------------------------------------ J2 */

test('J2 摘要不符回 digest-mismatch，已收分片全部丢弃；之后按正确内容重传可以收齐', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  const text = projectText('j2', 5000);
  const rev = await announce(c, 'proj-j2', text);
  const chunks = chunksOf(text, 3);

  // 1. 数据被改过：全文的 sha256 对不上 digest
  const tampered = [...chunks];
  tampered[1] = tampered[1].replace(/x/, 'y');
  const r1 = await upload(c, 'proj-j2', rev, text, tampered);
  assert.deepEqual(r1.slice(0, 2).map((r) => r.type), ['project.snapshot.stored', 'project.snapshot.stored']);
  assert.equal(r1[2].type, 'error', `收齐后校验不过回 error：${JSON.stringify(r1[2])}`);
  assert.equal(r1[2].reason, 'digest-mismatch');
  assert.equal((await getSnapshot(c, 'proj-j2', rev)).missing, true, '校验不过的不留');

  // 已收的分片全部丢弃：重新上传从 received 1 起算
  const again = await put(c, { projectId: 'proj-j2', projectRev: rev, digest: sha256(text), index: 0, count: 3, data: chunks[0] });
  assert.equal(again.type, 'project.snapshot.stored');
  assert.equal(again.received, 1, `之前的分片已丢弃：${JSON.stringify(again)}`);
  const rest = await upload(c, 'proj-j2', rev, text, chunks, [1, 2]);
  assert.equal(rest.at(-1).complete, true);
  assert.equal(assemble(await getSnapshot(c, 'proj-j2', rev), 'proj-j2', rev), text);

  // 2. 数据与自报的 digest 一致，但 digest 不是这一版 announce 登记的那个
  const other = projectText('j2-other', 4000);
  const rev2 = await announce(c, 'proj-j2b', text);
  const r2 = await upload(c, 'proj-j2b', rev2, other, chunksOf(other, 2));
  // 契约只说「收齐后校验」；实现也可以在第一片就拒。两种都接受，但必须报 digest-mismatch、不能收齐
  const errors = r2.filter((r) => r.type === 'error');
  assert.ok(errors.length >= 1, `digest 不等于 announce 登记的摘要：要回 error：${JSON.stringify(r2)}`);
  assert.ok(errors.every((e) => e.reason === 'digest-mismatch'), JSON.stringify(errors));
  assert.ok(!r2.some((r) => r.complete === true), '不能收齐');
  assert.equal((await getSnapshot(c, 'proj-j2b', rev2)).missing, true);
});

test('J2 没 announce 过的版本回 unknown-rev（不存在的项目、比当前版本新的版本）', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  const text = projectText('j2-rev', 1000);
  const r0 = await put(c, { projectId: 'never-announced', projectRev: 1, digest: sha256(text), index: 0, count: 1, data: text });
  assert.equal(r0.type, 'error', JSON.stringify(r0));
  assert.equal(r0.reason, 'unknown-rev');

  const rev = await announce(c, 'proj-j2c', text);
  const r1 = await put(c, { projectId: 'proj-j2c', projectRev: rev + 1, digest: sha256(text), index: 0, count: 1, data: text });
  assert.equal(r1.type, 'error', JSON.stringify(r1));
  assert.equal(r1.reason, 'unknown-rev');
  // 登记过的这一版照常
  const ok = await put(c, { projectId: 'proj-j2c', projectRev: rev, digest: sha256(text), index: 0, count: 1, data: text });
  assert.deepEqual([ok.type, ok.complete], ['project.snapshot.stored', true]);
});

/* ------------------------------------------------------------------ J3 */

test('J3 文件存储：服务关掉后在同一目录新建，快照仍能取回；取不存在的版本回 missing；没有残留的临时文件', async (t) => {
  const dir = tempDir(t, 'pc-m5b-snap-');
  const env1 = await start({ dir });
  t.after(env1.cleanup);
  const a = await env1.connect('alice');
  const text = projectText('j3', 7000, { cjk: true });
  const rev = await announce(a, 'scene:j3', text);
  const replies = await upload(a, 'scene:j3', rev, text, chunksOf(text, 3), [1, 0, 2]);
  assert.equal(replies.at(-1).complete, true);
  const text2 = projectText('j3-v2', 500);
  const rev2 = await announce(a, 'scene:j3', text2);
  await upload(a, 'scene:j3', rev2, text2, [text2]);
  await env1.cleanup();

  const env2 = await start({ dir });
  t.after(env2.cleanup);
  const b = await env2.connect('bob');
  assert.equal(assemble(await getSnapshot(b, 'scene:j3', rev), 'scene:j3', rev), text, '重启后第一版仍在');
  assert.equal(assemble(await getSnapshot(b, 'scene:j3', rev2), 'scene:j3', rev2), text2, '重启后第二版仍在');

  const miss = await getSnapshot(b, 'scene:j3', rev2 + 5);
  assert.equal(miss.missing, true, '取不存在的版本回 missing');
  const m = miss.replies[0];
  assert.deepEqual({ type: m.type, projectId: m.projectId, projectRev: m.projectRev, missing: m.missing },
    { type: 'project.snapshot.part', projectId: 'scene:j3', projectRev: rev2 + 5, missing: true });
  assert.equal((await getSnapshot(b, 'no-such-project', 1)).missing, true, '没有的项目同样回 missing');

  const files = readdirSync(join(dir, 'projects'));
  assert.ok(files.some((f) => f.endsWith('.json')), `快照文件落在 <dir>/projects/ 下、扩展名 .json：${JSON.stringify(files)}`);
  assert.ok(files.every((f) => f.endsWith('.json') || f.endsWith('.ndjson')), `没有残留的临时文件（写入经临时文件加改名）：${JSON.stringify(files)}`);
});

test('J3 存储层：memory 与文件两种存储都有 writeBlob / readBlob，读回原文，没写过的回 null', async (t) => {
  const { createMemoryStore, createFileStore } = await loadStore();
  const dir = tempDir(t, 'pc-m5b-blob-');
  const text = projectText('blob', 3000, { cjk: true });
  for (const [name, store] of [['memory', createMemoryStore()], ['file', createFileStore({ dir })]]) {
    assert.equal(typeof store.writeBlob, 'function', `${name}：有 writeBlob`);
    assert.equal(typeof store.readBlob, 'function', `${name}：有 readBlob`);
    assert.equal(await store.readBlob('projects/p@1'), null, `${name}：没写过的回 null`);
    await store.writeBlob('projects/p@1', text);
    assert.equal(await store.readBlob('projects/p@1'), text, `${name}：读回原文`);
    await store.writeBlob('projects/p@1', `${text}!`);
    assert.equal(await store.readBlob('projects/p@1'), `${text}!`, `${name}：再写覆盖`);
    assert.equal(await store.readBlob('projects/p@2'), null, `${name}：别的名字互不串`);
  }
});

/* ------------------------------------------------------------------ J4 */

let clientMod = null, clientErr = null;
async function loadProjectClient() {
  if (!clientMod && !clientErr) {
    try { clientMod = await import('../render-node/project-client.mjs'); } catch (err) { clientErr = err; }
  }
  if (clientErr) throw new Error(`载不进 server/render-node/project-client.mjs：${clientErr.message}`);
  assert.equal(typeof clientMod.createProjectClient, 'function', `project-client.mjs 要导出 createProjectClient；导出：${Object.keys(clientMod).join(', ')}`);
  return clientMod;
}

/** 起服务、连端点、建客户端 */
async function clientRig(t, { modules, timeoutMs } = {}) {
  const { createProjectClient } = await loadProjectClient();
  let env;
  if (modules) env = await startStandalone({ modules });
  else env = await start();
  const endpoints = new Set();
  t.after(async () => { for (const ep of endpoints) { try { ep.close(); } catch { /* 已关 */ } } await env.cleanup(); });
  const url = `ws://127.0.0.1:${env.port}/?user=node-a`;
  const endpoint = await connectEndpoint(url, { env: { endpoints } });
  const sent = [];
  const send = endpoint.send.bind(endpoint);
  const wrapped = {
    send: (m) => { sent.push(m); return send(m); },
    onMessage: endpoint.onMessage, onOpen: endpoint.onOpen, onClose: endpoint.onClose, close: endpoint.close, stats: endpoint.stats,
    get connected() { return endpoint.connected; }, get closed() { return endpoint.closed; },
  };
  const client = createProjectClient(wrapped, timeoutMs === undefined ? undefined : { timeoutMs });
  return { env, endpoint, client, sent };
}

async function settleOf(promise) {
  const t0 = Date.now();
  try { return { ok: true, value: await promise, ms: Date.now() - t0 }; } catch (error) { return { ok: false, error, ms: Date.now() - t0 }; }
}

test('J4 createProjectClient：announce、putSnapshot、get 往返；大文本自动分片（每片 ≤ 512 KiB）；没有的版本 get 回 null；index.mjs 转出', async (t) => {
  const { client, sent } = await clientRig(t);
  const project = { id: 'proj-j4', fps: 30, tracks: [{ id: 't', clips: [{ id: 'c1', start: 0, end: 1 }] }], big: 'z'.repeat(1_200_000), cjk: '中文项目' };
  const text = JSON.stringify(project);
  const digest = sha256(text);

  const a1 = await client.announce('proj-j4', digest, 'tab-1');
  assert.deepEqual({ projectRev: a1.projectRev, changed: a1.changed }, { projectRev: 1, changed: true });
  const a2 = await client.announce('proj-j4', digest);
  assert.deepEqual({ projectRev: a2.projectRev, changed: a2.changed }, { projectRev: 1, changed: false }, '同一摘要不加版本');

  await client.putSnapshot('proj-j4', 1, digest, text);
  const puts = sent.filter((m) => m.type === 'project.snapshot.put');
  assert.ok(puts.length >= 3, `1.2 MB 的文本至少分 3 片：${puts.length}`);
  assert.ok(puts.length <= 64, 'count ≤ 64');
  for (const m of puts) {
    assert.ok(Buffer.byteLength(m.data, 'utf8') <= CHUNK_MAX, `每片 ≤ 512 KiB：${Buffer.byteLength(m.data, 'utf8')}`);
    assert.equal(m.count, puts.length);
    assert.equal(m.digest, digest);
    assert.equal(m.projectRev, 1);
  }
  assert.deepEqual(puts.map((m) => m.index).sort((x, y) => x - y), puts.map((_, i) => i), 'index 0..count-1 各一片');

  const back = await client.get('proj-j4', 1);
  assert.deepEqual(back, project, 'get 拼接、校验、JSON.parse 后与原对象相同');
  assert.equal(await client.get('proj-j4', 2), null, '没有的版本回 null');
  assert.equal(await client.get('no-such', 1), null, '没有的项目回 null');

  const reqIds = sent.map((m) => m.reqId);
  assert.ok(reqIds.every((id) => typeof id === 'string' && id.length > 0), '每个请求都带字符串 reqId');
  assert.equal(new Set(reqIds).size, reqIds.length, 'reqId 互不相同');
  assert.ok(reqIds.every((id) => !id.startsWith('content#')), `reqId 带自己的前缀，不与内容库客户端相同：${reqIds[0]}`);

  const idx = await import('../render-node/index.mjs');
  assert.equal(idx.createProjectClient, (await loadProjectClient()).createProjectClient, 'render-node/index.mjs 转出 createProjectClient');
});

test('J4 并发两份不串：两个项目同时 announce、putSnapshot、get，各拿回自己的', async (t) => {
  const { client } = await clientRig(t);
  const make = (seed) => ({ id: `proj-${seed}`, seed, pad: `${seed}-`.repeat(5_000) });
  const projects = [make('left'), make('right')];
  const texts = projects.map((p) => JSON.stringify(p));
  const revs = await Promise.all(projects.map((p, i) => client.announce(p.id, sha256(texts[i]))));
  await Promise.all(projects.map((p, i) => client.putSnapshot(p.id, revs[i].projectRev, sha256(texts[i]), texts[i])));
  const [l, r] = await Promise.all(projects.map((p, i) => client.get(p.id, revs[i].projectRev)));
  assert.deepEqual(l, projects[0]);
  assert.deepEqual(r, projects[1]);
  // 同一项目两个版本并发
  const v2 = { ...projects[0], seed: 'left-v2' };
  const t2 = JSON.stringify(v2);
  const rev2 = (await client.announce(v2.id, sha256(t2))).projectRev;
  await client.putSnapshot(v2.id, rev2, sha256(t2), t2);
  const [old, cur] = await Promise.all([client.get(v2.id, revs[0].projectRev), client.get(v2.id, rev2)]);
  assert.deepEqual(old, projects[0]);
  assert.deepEqual(cur, v2);
});

test('J4 putSnapshot 被服务端拒绝（摘要不符）：抛出，错误带 reason', async (t) => {
  const { client } = await clientRig(t);
  const text = JSON.stringify({ id: 'p', v: 1 });
  const { projectRev } = await client.announce('proj-j4-bad', sha256(text));
  const other = JSON.stringify({ id: 'p', v: 2 });
  const r = await settleOf(client.putSnapshot('proj-j4-bad', projectRev, sha256(other), other));
  assert.equal(r.ok, false, '摘要与 announce 登记的不符：失败');
  assert.equal(r.error.reason, 'digest-mismatch', `错误带 reason：${r.error?.message}`);
  const u = await settleOf(client.putSnapshot('proj-j4-bad', projectRev + 3, sha256(text), text));
  assert.equal(u.ok, false);
  assert.equal(u.error.reason, 'unknown-rev');
});

/** 吞掉 project.* 的模块：收到什么都不回 */
const silentProject = () => ({ name: 'silent-project', types: ['project.'], channels: [], handle() {} });

test('J4 服务端不回：超时抛 code: timeout（announce、putSnapshot、get 都是）', async (t) => {
  const { client } = await clientRig(t, { modules: [silentProject()], timeoutMs: 300 });
  for (const [what, call] of [
    ['announce', () => client.announce('p', sha256('x'))],
    ['putSnapshot', () => client.putSnapshot('p', 1, sha256('x'), 'x')],
    ['get', () => client.get('p', 1)],
  ]) {
    const r = await settleOf(call());
    assert.equal(r.ok, false, `${what}：不回包就失败`);
    assert.equal(r.error.code, 'timeout', `${what}：code 是 timeout：${r.error?.message}`);
    assert.ok(r.ms >= 250 && r.ms < 5000, `${what}：按 timeoutMs 计时：${r.ms} ms`);
  }
});

test('J4 断线：在途请求立即以 code: disconnected 失败，不等超时；重连后不重放', async (t) => {
  const { env, endpoint, client, sent } = await clientRig(t, { modules: [silentProject()], timeoutMs: 20_000 });
  const inflight = [client.announce('p', sha256('y')), client.get('p', 1), client.putSnapshot('p', 1, sha256('y'), 'y')].map(settleOf);
  await until(() => sent.length >= 3, { timeoutMs: 2000 });
  const closedSeen = new Promise((resolve) => endpoint.onClose(resolve));
  await env.service.close();
  await closedSeen;
  const t0 = Date.now();
  const results = await Promise.all(inflight);
  assert.ok(Date.now() - t0 < 3000, '断线后立即失败，不等 20 s');
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'disconnected', `code 是 disconnected：${r.error?.message}`);
  }
  const before = sent.length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(sent.length, before, '断线后不重放');
});

/** 假端点：只记下发出的消息，由测试决定回什么 */
function fakeEndpoint() {
  const handlers = { message: [], open: [], close: [] };
  const sent = [];
  return {
    sent,
    send(m) { sent.push(JSON.parse(JSON.stringify(m))); return true; },
    onMessage(h) { handlers.message.push(h); },
    onOpen(h) { handlers.open.push(h); },
    onClose(h) { handlers.close.push(h); },
    close() {},
    connected: true,
    closed: false,
    stats: () => ({}),
    deliver(m) { for (const h of [...handlers.message]) h(JSON.parse(JSON.stringify(m))); },
  };
}

test('J4 get 校验摘要：分片拼出的全文与 end.digest 对不上时拒绝；回包乱序、夹着别的 reqId 的消息时按 reqId 配对', async () => {
  const { createProjectClient } = await loadProjectClient();
  const ep = fakeEndpoint();
  const client = createProjectClient(ep, { timeoutMs: 3000 });
  const good = { id: 'g', n: 1 };
  const goodText = JSON.stringify(good);

  const pBad = settleOf(client.get('bad', 1));
  const pGood = client.get('good', 1);
  await until(() => ep.sent.length === 2, { timeoutMs: 2000 });
  const [reqBad, reqGood] = ep.sent;
  assert.notEqual(reqBad.reqId, reqGood.reqId);
  // 无关消息
  ep.deliver({ type: 'project.snapshot.part', projectId: 'good', projectRev: 1, index: 0, count: 1, data: '{"wrong":true}', reqId: 'not-mine' });
  ep.deliver({ type: 'project.rev', projectId: 'good', projectRev: 2 });
  // good 的分片与 bad 的分片交错
  const half = Math.ceil(goodText.length / 2);
  ep.deliver({ type: 'project.snapshot.part', projectId: 'good', projectRev: 1, index: 0, count: 2, data: goodText.slice(0, half), reqId: reqGood.reqId });
  ep.deliver({ type: 'project.snapshot.part', projectId: 'bad', projectRev: 1, index: 0, count: 1, data: '{"a":1}', reqId: reqBad.reqId });
  ep.deliver({ type: 'project.snapshot.part', projectId: 'good', projectRev: 1, index: 1, count: 2, data: goodText.slice(half), reqId: reqGood.reqId });
  ep.deliver({ type: 'project.snapshot.end', projectId: 'bad', projectRev: 1, digest: sha256('{"a":2}'), reqId: reqBad.reqId });
  ep.deliver({ type: 'project.snapshot.end', projectId: 'good', projectRev: 1, digest: sha256(goodText), reqId: reqGood.reqId });

  assert.deepEqual(await pGood, good, '按 reqId 拼出自己的快照');
  const bad = await pBad;
  assert.equal(bad.ok, false, '摘要对不上：拒绝，不回错的内容');
});
