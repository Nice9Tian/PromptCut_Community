/**
 * 独立渲染主机不再因用户卡分池(c66-host-cards;C6.6 T9 暴露的代码与语义冲突,报告 `docs/archive/agent-reports/AGENT-c66-host-cards.md`)。
 *
 * 语义:独立渲染主机「能认领:全部」(`product/platforms.md`「渲染节点」);每个任务标明要什么能力,节点按自身能力过滤
 * (`mechanism/document-service.md`「渲染任务队列」);用户卡与改过的卡的源码经内容库 `card-source` 同步,另一端自动装上
 * (`docs/plan/c66-design.md` 第 5 节)。
 *
 *   HC1  用户卡不同的两台节点仍在同一池:frameCode 不含 src/cards/user(除装载入口)、换行统一;改别的源码照样换版本
 *   HC2  任务要的卡本机没有就不认领(不报错);经 card-source 同步装上之后能认领,认领、完成走真队列
 *   HC3  改过的卡:同步来的新版装进主机自己的改动层;身份跟着变,旧版任务不再认领、新版的能
 *        (本机原来没有的用户卡也只装进改动层,检出目录一个文件都不写:AGENT-card-overlay)
 *   HC4  同一张卡代码不同,产物不混用:整场景键、本地档 / 共享档结果键都不同;执行器上下文按卡片代码版次重算
 *   HC5  卡片代码身份的索引:刚变过的一段时间不报身份;算法没注入时不缓存
 *   HC6  主机的同步是只读的:本机那份和服务上不同,也从不往项目里写
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

delete process.env.PROMPTCUT_CARD_OVERRIDES;
delete process.env.PROMPTCUT_DATA_DIR;

const { frameCode, isUserCardSource } = await import('../frame-code.mjs');
const { createCardCodeIndex, cardEntryCode, projectCardIds } = await import('../card-code.mjs');
const { checkClaimable } = await import('../render-node/filter.mjs');
const { splitPlan, planTaskOf } = await import('../render-node/split.mjs');
const { resultKeyOf } = await import('../render-node/fingerprint.mjs');
const { createRenderHost, HOST_CAPABILITIES } = await import('../render-node/host.mjs');
const { createRenderQueue } = await import('../render-queue/index.mjs');
const { createWsEndpoint } = await import('../render-node/ws-transport.mjs');
const { createDocService } = await import('../docservice/service.mjs');
const { contentModule } = await import('../docservice/modules/content.mjs');
const { createMemoryStore } = await import('../docservice/store/index.mjs');
const { frameIdentity } = await import('../frame-identity.mjs');
const { cardSnapshotIdentity } = await import('../card-identity.mjs');
const { createPrerenderExecutor } = await import('../prerender-executor.mjs');
const { FramePipeline } = await import('../frame-pipeline.mjs');
const { createLoopback } = await import('./fake-loopback-transport.mjs');
const { createTimerClock } = await import('./fake-render-executor.mjs');
const cards = await import('../vite-plugin-cards.ts');

const FP = 'fedcba9876543210';
const CV = 'c0de-host-cards';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, what = '条件') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等 ${what} 超时(${ms} ms)`);
    await sleep(20);
  }
}

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

/** 改动层只由环境变量决定(`card-overrides.mjs` 的 `overridesRoot` 每次现读):按调用临时设上 */
function withOverlay(dir, fn) {
  const before = process.env.PROMPTCUT_CARD_OVERRIDES;
  if (dir) process.env.PROMPTCUT_CARD_OVERRIDES = dir; else delete process.env.PROMPTCUT_CARD_OVERRIDES;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.PROMPTCUT_CARD_OVERRIDES; else process.env.PROMPTCUT_CARD_OVERRIDES = before;
  }
}

const cardSource = (text) => `import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params }: CardProps<Params>) {
  return <motion.div animate={{ opacity: 1 }}>{params.text}</motion.div>;
}
export const priceTag: CardDef<Params> = {
  id: "price-tag", name: "价格", description: "d", source: "user",
  frameMode: "stateful",
  defaults: { text: "${text}" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
`;
const USER_KEY = 'src/cards/user/price-tag.tsx';
const GLASS = `import type { CardDef } from "../../kernel/types";
export const glass: CardDef<{ n: number }> = {
  id: "glass", name: "glass", description: "d", source: "native",
  frameMode: "stateful",
  defaults: { n: 1 },
  controls: [],
  Component: () => null,
};
`;

/** 一个最小的「检出」:几份源码、用户卡装载入口、一张内置卡 */
function checkout(prefix, extra = {}) {
  const root = tmp(prefix);
  put(root, 'src/kernel/a.ts', 'export const a = 1;\n');
  put(root, 'src/cards/user/index.ts', 'export const userCards = [];\n');
  put(root, 'src/cards/native/glass.tsx', GLASS);
  for (const [rel, text] of Object.entries(extra)) put(root, rel, text);
  return root;
}

/* ================================================================== HC1 */

test('HC1 用户卡不同的两台节点仍在同一池:frameCode 不含 src/cards/user(装载入口除外),换行统一', () => {
  const a = checkout('pc-hc1-a-', { [USER_KEY]: cardSource('v1'), 'src/cards/user/_scopes.json': '{"price-tag":{"scope":"project"}}' });
  const b = checkout('pc-hc1-b-');
  const c = checkout('pc-hc1-c-', { [USER_KEY]: cardSource('another'), 'src/cards/user/lib/helper.ts': 'export const h = 2;\n' });
  // 同一份源码,Windows 检出的换行
  const d = checkout('pc-hc1-d-');
  for (const rel of ['src/kernel/a.ts', 'src/cards/user/index.ts', 'src/cards/native/glass.tsx']) {
    put(d, rel, fs.readFileSync(path.join(b, rel), 'utf8').replace(/\n/g, '\r\n'));
  }
  const code = frameCode(b);
  assert.match(code, /^[0-9a-f]{64}$/);
  assert.equal(frameCode(a), code, '多一张用户卡(和归属表)不换代码版本');
  assert.equal(frameCode(c), code, '用户卡不同、多一个用户卡依赖文件也不换');
  assert.equal(frameCode(d), code, 'CRLF 检出与 LF 检出同一个代码版本');

  // 装载入口、内置卡、别的源码仍在代码版本里
  const e = checkout('pc-hc1-e-', { 'src/kernel/a.ts': 'export const a = 2;\n' });
  assert.notEqual(frameCode(e), code, '改了内核源码换代码版本');
  const f = checkout('pc-hc1-f-', { 'src/cards/user/index.ts': 'export const userCards = [1];\n' });
  assert.notEqual(frameCode(f), code, '用户卡装载入口是渲染器代码,改了换版本');
  const g = checkout('pc-hc1-g-', { 'src/cards/native/glass.tsx': GLASS.replace('n: 1', 'n: 2') });
  assert.notEqual(frameCode(g), code, '改了内置卡换版本');

  assert.equal(isUserCardSource('src/cards/user/x.tsx'), true);
  assert.equal(isUserCardSource('src/cards/user/_scopes.json'), true);
  assert.equal(isUserCardSource('src/cards/user/lib/h.ts'), true);
  assert.equal(isUserCardSource('src/cards/user/index.ts'), false);
  assert.equal(isUserCardSource('src\\cards\\user\\x.tsx'), true);
  assert.equal(isUserCardSource('src/cards/native/x.tsx'), false);

  // 过滤:创建者(有用户卡)发布的任务,没有这张卡的主机照样过代码版本这一关
  const task = { kind: 'snapshot', source: { projectId: 'p' }, weight: { class: 'medium' },
    requires: { envFingerprint: FP, codeVersion: frameCode(a), cardSources: {}, transcode: false, userCards: true, graphCards: false } };
  assert.deepEqual(checkClaimable(task, { profile: 'host', envFingerprint: FP, codeVersions: [frameCode(b)], capabilities: HOST_CAPABILITIES }), { ok: true });
});

/* ================================================================== 文档服务、队列夹具 */

async function startDoc(t) {
  const service = createDocService({
    log: () => {},
    authenticate: (req) => {
      const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
      return { userId: q.get('user') ?? 'u', deviceId: q.get('dev') ?? 'd', role: q.get('role') ?? 'page', tenantId: 't-hc' };
    },
    modules: [contentModule({ store: createMemoryStore() })],
  });
  const { port } = await service.listen(0, '127.0.0.1');
  t.after(() => service.close());
  return { url: (user, role = 'page') => `ws://127.0.0.1:${port}/?user=${user}&dev=dev-${user}&role=${role}` };
}

/** 另开一条连接对内容库发一条请求,回回包 */
async function rpc(doc, message) {
  const ws = new WebSocket(doc.url('creator'), ['promptcut.v1']);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const reply = await new Promise((resolve) => {
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.reqId === 'r1') resolve(m); });
    ws.send(JSON.stringify({ ...message, reqId: 'r1' }));
  });
  ws.close();
  return reply;
}
const putCard = (doc, key, body) => rpc(doc, { type: 'content.put', kind: 'card-source', key, body, session: 'creator-session' });

/** 进程内一个项目的队列 + 一个页面发布方 + 主机(一个项目、一个节点,节点的 cardSourceVersions 是视图) */
function queueWithHost({ view, executor, sink }) {
  const clock = createTimerClock();
  const lb = createLoopback();
  const queue = createRenderQueue({ now: clock.now, send: lb.queueSend, epoch: 'epoch-hc' });
  lb.attach(queue);
  const page = lb.connect('page', { userId: 'alice@page-device-0001', tenantId: 'proj-hc' });
  const inbox = [];
  page.onMessage((m) => inbox.push(m));
  page.send({ type: 'publisher.hello', publisherId: 'page-hc' });
  const host = createRenderHost({
    entries: [{ projectId: 'proj-hc', url: 'ws://unused.invalid/docservice' }],
    connect: () => ({ endpoint: lb.connect('host-0', { userId: 'renderbox@host-device-0001', tenantId: 'proj-hc' }), executor, sink }),
    nodeIdOf: () => 'host:hc/p0',
    envFingerprint: FP, codeVersion: CV, cardSourceVersions: view, maxConcurrent: 2,
    now: clock.now, random: () => 0,
  });
  const settle = async () => {
    for (let round = 0; round < 500; round++) {
      lb.flush();
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
      if (lb.pending() === 0) return;
    }
    throw new Error('消息往返不收敛');
  };
  const step = async (n = 1) => {
    for (let i = 0; i < n; i++) { await settle(); host.tick(); await settle(); queue.tick(); await settle(); clock.advance(250); }
  };
  return {
    host, queue, step,
    publish: (tasks) => page.send({ type: 'task.publish', tasks }),
    claims: () => lb.log().filter((e) => e.dir === 'in' && e.connId === 'host-0' && e.message.type === 'task.claim').map((e) => e.message.id),
    done: (id) => inbox.filter((m) => m.type === 'task.done' && m.id === id).length,
  };
}

function fakeExecutor() {
  const calls = [];
  return { calls, async plan() { throw new Error('host 不认领 plan'); }, async render(task) { calls.push(task.id); return { fake: task.id }; } };
}
const fakeSink = () => ({ async has() { return false; }, async put() { return { complete: true, result: {} }; } });

/** 一版项目的切分:一个共享档的用户卡片段、一个本地档的内置卡片段 */
function splitFor({ entryKey, versions, userSnapshotKey = 'sk-user' }) {
  const control = (o) => ({ count: 30, sampling: { firstFrame: 0 }, ...o });
  return splitPlan({
    planTask: planTaskOf({ projectId: 'proj-hc', projectRev: 3 }),
    entryKey,
    cardPlan: [
      control({ clipId: 'clip-user', cardId: 'price-tag', snapshotKey: userSnapshotKey, tier: 'shared', capabilities: { frameMode: 'stateful', compositing: 'independent' } }),
      control({ clipId: 'clip-glass', cardId: 'glass', snapshotKey: 'sk-glass', tier: 'local', capabilities: { frameMode: 'stateful', compositing: 'belowDependent' } }),
    ],
    envFingerprint: FP, codeVersion: CV, cardSourceVersions: versions,
    isUserCard: (c) => c.cardId === 'price-tag',
  });
}

/* ================================================================== HC2 + HC3 */

test('HC2/HC3 任务要的卡本机没有就不认领;经 card-source 同步装进改动层后能认领(检出目录不写);改过的新版也装进改动层', { timeout: 30000 }, async (t) => {
  const doc = await startDoc(t);

  // ---- 创建者:本检出里有用户卡 v1,传上内容库;这一版的切分
  const creator = checkout('pc-hc2-creator-', { [USER_KEY]: cardSource('v1') });
  const creatorIndex = createCardCodeIndex({ identityOf: (id) => withOverlay(null, () => cards.cardCodeIdentity(creator, id)), settleMs: 0 });
  const project = { tracks: [{ clips: [{ cardId: 'price-tag' }, { cardId: 'glass' }] }] };
  assert.deepEqual(projectCardIds(project), ['glass', 'price-tag']);
  const v1 = creatorIndex.projectVersions(project);
  assert.deepEqual(Object.keys(v1), ['price-tag'], '只有用户卡是定制卡;没改过的内置卡由全局代码版本覆盖');
  assert.match(v1['price-tag'], /^[0-9a-f]{32}$/);
  const stored = await putCard(doc, USER_KEY, cardSource('v1'));
  assert.equal(stored.type, 'content.stored');
  const entryKey1 = frameIdentity(project, cardEntryCode(CV, v1));
  const tasks1 = splitFor({ entryKey: entryKey1, versions: v1 });
  assert.equal(tasks1.length, 2);
  for (const task of tasks1) assert.deepEqual(task.requires.cardSources, v1, `${task.tier} 档要 price-tag 的代码(共享档是自己那张,本地档是整个场景)`);

  // ---- 主机:检出里没有这张卡,有自己的改动层
  const hostRoot = checkout('pc-hc2-host-');
  const overlay = tmp('pc-hc2-overlay-');
  const hostData = tmp('pc-hc2-data-');
  const hostIndex = createCardCodeIndex({ identityOf: (id) => withOverlay(overlay, () => cards.cardCodeIdentity(hostRoot, id)), settleMs: 0 });
  const node = { profile: 'host', envFingerprint: FP, codeVersions: [CV], capabilities: HOST_CAPABILITIES, cardSourceVersions: hostIndex.view };
  for (const task of tasks1) {
    assert.deepEqual(checkClaimable(task, node), { ok: false, rule: 1, reason: 'card-source' }, '本机没有这张卡:不认领,不抛错');
  }
  // 真队列:看得见、认领 0 次
  const executor = fakeExecutor();
  const env = queueWithHost({ view: hostIndex.view, executor, sink: fakeSink() });
  env.host.start();
  env.publish(tasks1);
  await env.step(12);
  assert.equal(env.host.nodes()[0].seen, 2, '两个任务都看得见');
  assert.deepEqual(env.claims(), [], '一条认领都没发');

  // ---- 主机的卡片同步(只读,真 WebSocket 连文档服务的内容库):装上 v1
  process.env.PROMPTCUT_CARD_OVERRIDES = overlay;
  t.after(() => { delete process.env.PROMPTCUT_CARD_OVERRIDES; });
  const endpoint = createWsEndpoint({ url: doc.url('renderbox', 'render'), protocols: () => ['promptcut.v1'], backoff: { baseMs: 50, maxMs: 200 } });
  t.after(() => endpoint.close());
  let touched = 0;
  const sync = cards.createHostCardSync({ root: hostRoot, dataDir: hostData, projectId: 'proj-hc', url: doc.url('renderbox', 'render'), endpoint, before: () => { touched++; hostIndex.touch(); } });
  t.after(() => sync.close());
  const overlayFile = path.join(overlay, USER_KEY);
  const userDirBefore = fs.readdirSync(path.join(hostRoot, 'src', 'cards', 'user')).sort();
  await waitFor(() => fs.existsSync(overlayFile), 5000, '主机装上 price-tag');
  await sync.idle();
  assert.equal(touched, 1, '装卡之前重新计稳定期');
  assert.equal(fs.readFileSync(overlayFile, 'utf8'), cardSource('v1'), '本机原来没有的用户卡装进主机自己的改动层');
  assert.equal(fs.existsSync(path.join(hostRoot, USER_KEY)), false, '检出目录不写');
  assert.deepEqual(fs.readdirSync(path.join(hostRoot, 'src', 'cards', 'user')).sort(), userDirBefore);
  assert.equal(sync.status().records[USER_KEY].rev, 1);
  // Vite 的文件监听作废模块之后才发变更通知;这里直接清(onCardSourceChange 的订阅方做的就是这件事)
  hostIndex.invalidate();
  assert.deepEqual(hostIndex.projectVersions(project), v1, '装上之后主机算出和创建者一样的身份');
  for (const task of tasks1) assert.deepEqual(checkClaimable(task, node), { ok: true });
  await env.step(12);
  assert.deepEqual(env.claims().sort(), tasks1.map((x) => x.id).sort(), '装上之后下一拍就认领');
  for (const task of tasks1) assert.equal(env.done(task.id), 1, `${task.id} 恰好一次 task.done`);

  // ---- HC3:创建者改卡 v2;主机按 content.watch 当场装进改动层,检出目录照旧不写
  await putCard(doc, USER_KEY, cardSource('v2'));
  await waitFor(() => fs.existsSync(overlayFile) && fs.readFileSync(overlayFile, 'utf8') === cardSource('v2'), 5000, '主机把 v2 装进改动层');
  await sync.idle();
  assert.equal(fs.existsSync(path.join(hostRoot, USER_KEY)), false, '检出目录照旧不写');
  assert.equal(sync.status().records[USER_KEY].rev, 2);
  hostIndex.invalidate();
  put(creator, USER_KEY, cardSource('v2'));
  creatorIndex.invalidate();
  const v2 = creatorIndex.projectVersions(project);
  assert.notEqual(v2['price-tag'], v1['price-tag']);
  assert.deepEqual(hostIndex.projectVersions(project), v2, '主机的身份跟着变成 v2');
  const tasks2 = splitFor({ entryKey: frameIdentity(project, cardEntryCode(CV, v2)), versions: v2, userSnapshotKey: 'sk-user-v2' });
  for (const task of tasks1) assert.deepEqual(checkClaimable(task, node), { ok: false, rule: 1, reason: 'card-source' }, 'v1 的任务不再认领');
  for (const task of tasks2) assert.deepEqual(checkClaimable(task, node), { ok: true }, 'v2 的任务能认领');
  env.publish(tasks2);
  await env.step(12);
  for (const task of tasks2) assert.equal(env.done(task.id), 1, `${task.id} 恰好一次 task.done`);
  env.host.shutdown();
});

/* ================================================================== HC4 */

test('HC4 同一张卡代码不同,产物不混用:整场景键、本地档与共享档的结果键都不同;执行器上下文按卡片代码版次重算', async () => {
  const project = { id: 'hc4', fps: 30, width: 1920, height: 1080, duration: 2, style: {}, media: [], tracks: [{ id: 't', clips: [{ id: 'c', cardId: 'price-tag', start: 0, end: 2, params: {} }] }] };
  const v1 = { 'price-tag': 'a'.repeat(32) };
  const v2 = { 'price-tag': 'b'.repeat(32) };
  // 整场景键
  assert.equal(cardEntryCode(CV, {}), CV, '没有定制卡时就是全局代码版本');
  assert.notEqual(cardEntryCode(CV, v1), cardEntryCode(CV, v2));
  assert.equal(cardEntryCode(CV, { b: '2', a: '1' }), cardEntryCode(CV, { a: '1', b: '2' }), '与键的顺序无关');
  const e1 = frameIdentity(project, cardEntryCode(CV, v1));
  const e2 = frameIdentity(project, cardEntryCode(CV, v2));
  assert.notEqual(e1, e2);

  // FramePipeline.entry:注入的身份进整场景键、记在 entry 上
  const root = tmp('pc-hc4-pipe-');
  let versions = v1;
  const pipeline = new FramePipeline({ root, origin: () => '', code: () => CV, cardSources: () => versions });
  try {
    const a = await pipeline.entry(project);
    assert.equal(a.key, e1);
    assert.deepEqual(a.cardSources, v1);
    versions = v2;
    const b = await pipeline.entry(project);
    assert.equal(b.key, e2, '同一版项目、卡片代码不同 → 不同的整场景条目');
    assert.notEqual(a.dir, b.dir);
    versions = {};
    assert.equal((await pipeline.entry(project)).key, frameIdentity(project, CV));
  } finally {
    await pipeline.close?.();
  }

  // 本地档:内容键里的 entry.key 不同 → 结果键不同
  const local = (entryKey, v) => splitFor({ entryKey, versions: v }).find((x) => x.tier === 'local');
  const l1 = local(e1, v1), l2 = local(e2, v2);
  assert.notEqual(l1.input.contentKey, l2.input.contentKey);
  assert.notEqual(l1.resultKey, l2.resultKey);
  assert.equal(l1.resultKey, resultKeyOf(`${e1}/sk-glass`, FP));
  // 共享档:键里的源码版本不同 → 共享键不同(`card-identity.mjs`)
  const node = { cardId: 'price-tag', params: {} };
  const s1 = cardSnapshotIdentity(node, { sourceVersion: 'user:v1-source', fps: 30, phase: 0, duration: 60, stage: { width: 1920, height: 1080 } });
  const s2 = cardSnapshotIdentity(node, { sourceVersion: 'user:v2-source', fps: 30, phase: 0, duration: 60, stage: { width: 1920, height: 1080 } });
  assert.notEqual(s1, s2);
  // 手里是 v1 的节点不认领 v2 的任务,反过来也一样
  const holder = (v) => ({ profile: 'host', envFingerprint: FP, codeVersions: [CV], capabilities: HOST_CAPABILITIES, cardSourceVersions: { 'price-tag': [v['price-tag']] } });
  for (const task of splitFor({ entryKey: e2, versions: v2 })) assert.equal(checkClaimable(task, holder(v1)).reason, 'card-source');
  for (const task of splitFor({ entryKey: e1, versions: v1 })) assert.equal(checkClaimable(task, holder(v2)).reason, 'card-source');

  // 执行器:同一版项目,卡片代码版次变了就按新代码重算上下文(不拿旧的 control 对任务)
  let stamp = 0;
  let planned = 0;
  const fakePipeline = { async planForQueue() { planned++; return { entry: { key: `e${planned}`, cardPlan: [] }, context: { cardPlan: [] } }; } };
  const projects = { async get() { return { tracks: [], duration: 1 }; } };
  const executor = createPrerenderExecutor({ pipeline: fakePipeline, projects, codeStamp: () => stamp });
  const planTask = { id: 'plan:p@1', kind: 'plan', source: { projectId: 'p', projectRev: 1 } };
  await executor.plan(planTask);
  await executor.plan(planTask);
  assert.equal(planned, 1, '版次没变:复用');
  stamp = 1;
  await executor.plan(planTask);
  assert.equal(planned, 2, '卡片代码变了:重算');
});

/* ================================================================== HC5 */

test('HC5 卡片代码身份的索引:刚变过的一段时间不报;算法没注入时不缓存;按需现算', () => {
  let now = 1000;
  let ready = false;
  let calls = 0;
  const index = createCardCodeIndex({
    identityOf: (id) => { calls++; if (!ready) return undefined; return id === 'x' ? { version: 'vx', custom: true } : id === 'b' ? { version: 'vb', custom: false } : null; },
    now: () => now, settleMs: 1500,
  });
  assert.deepEqual(index.view.x, [], '算法没注入');
  assert.deepEqual(index.projectVersions({ tracks: [{ clips: [{ cardId: 'x' }] }] }), {});
  ready = true;
  assert.deepEqual(index.view.x, ['vx'], '没缓存上次的「没有」');
  assert.deepEqual(index.view.b, ['vb'], '没改过的内置卡也报身份(节点那一侧不分)');
  assert.deepEqual(index.view.nope, []);
  assert.deepEqual(index.projectVersions({ tracks: [{ clips: [{ cardId: 'x' }, { cardId: 'b' }] }], cardNodes: [{ cardId: 'x' }] }), { x: 'vx' }, '只列定制卡');
  const before = calls;
  void index.view.x;
  assert.equal(calls, before, '按卡缓存');
  index.invalidate();
  assert.equal(index.epoch, 1);
  assert.deepEqual(index.view.x, [], '刚变过:不报');
  now += 1499;
  assert.deepEqual(index.view.x, []);
  now += 1;
  assert.deepEqual(index.view.x, ['vx'], '稳下来之后照常');
  index.touch();
  assert.deepEqual(index.view.x, [], '要装卡了:重新计时');
  assert.equal(index.epoch, 1, 'touch 不换版次');
  assert.deepEqual(projectCardIds({ tracks: [{ clips: [{ cardId: 'b' }] }], cuts: [{ tracks: [{ clips: [{ cardId: 'a' }] }] }], cardNodes: { n1: { cardId: 'c' } } }), ['a', 'b', 'c']);
});

/* ================================================================== HC6 */

test('HC6 主机的卡片同步只读:本机那份和服务上不同,装服务上的、从不往项目里写', { timeout: 20000 }, async (t) => {
  const doc = await startDoc(t);
  await putCard(doc, USER_KEY, cardSource('server'));
  // 主机检出里已有一份不同的(例如别的项目装进来的)
  const hostRoot = checkout('pc-hc6-host-', { [USER_KEY]: cardSource('local') });
  const overlay = tmp('pc-hc6-overlay-');
  const hostData = tmp('pc-hc6-data-');
  process.env.PROMPTCUT_CARD_OVERRIDES = overlay;
  t.after(() => { delete process.env.PROMPTCUT_CARD_OVERRIDES; });
  const endpoint = createWsEndpoint({ url: doc.url('renderbox', 'render'), protocols: () => ['promptcut.v1'], backoff: { baseMs: 50, maxMs: 200 } });
  t.after(() => endpoint.close());
  const sent = [];
  const spy = { ...endpoint, send: (m) => { sent.push(m.type); return endpoint.send(m); }, onMessage: (h) => endpoint.onMessage(h), onOpen: (h) => endpoint.onOpen(h), onClose: (h) => endpoint.onClose(h), get connected() { return endpoint.connected; } };
  const sync = cards.createHostCardSync({ root: hostRoot, dataDir: hostData, projectId: 'proj-hc6', url: doc.url('renderbox', 'render'), endpoint: spy });
  t.after(() => sync.close());
  const overlayFile = path.join(overlay, USER_KEY);
  await waitFor(() => fs.existsSync(overlayFile), 5000, '装进改动层');
  await sync.idle();
  assert.equal(fs.readFileSync(overlayFile, 'utf8'), cardSource('server'));
  assert.equal(fs.readFileSync(path.join(hostRoot, USER_KEY), 'utf8'), cardSource('local'), '底版不动');
  assert.ok(!sent.includes('content.put'), `只读:没发过 content.put(发过 ${[...new Set(sent)].join(', ')})`);
  const got = await rpc(doc, { type: 'content.get', kind: 'card-source', key: USER_KEY });
  assert.equal(got.rev, 1, '项目里的 cardRev 没被主机推高');
  assert.equal(got.body, cardSource('server'));
  // 本机再改一份:仍不上传
  put(overlay, USER_KEY, cardSource('local-again'));
  assert.equal(sync.status().pending?.length ?? 0, 0);
  // 备份在主机自己的数据目录里,不在检出的 out/ 下
  assert.ok(!fs.existsSync(path.join(hostRoot, 'out')), '检出里没有 out/card-edits');
  void sha;
});
