/**
 * 任务 D（`claude/queue-maint`）：页面只是忙，不被 D2（队列锁闲置接手，M7 契约第 3.4 节）接手。
 * 出处：`docs/reports/REPORT-M7.md` 第 11 节第 1 行 ——「锁闲置只看产出，不看页面是在忙还是走了」。
 *
 * 改法（M7 D2 补充〔裁〕）：`node.welcome` 带 `activeIntervalMs`；节点忙着（生成别的卡、后台舞台在测量或补跑）时发
 * `node.active { busy }`；锁记下最后为它产出的节点，那个节点此刻连着、指纹没变、报过忙时，回包的 `lockIdleMs` 按
 * 「最后一次产出或报忙」算。页面断开、停报、从没报过（旧页面）时只看产出，同改动之前。
 *
 *   QM-D-01 welcome 带间隔，且间隔远小于接手门槛
 *   QM-D-02 页面忙（在报 node.active、这张卡没产出）：闲置不涨，切分方判不接手（发布回包、认领回包两条路）
 *   QM-D-03 页面断开：报过的忙立即不作数，闲置按最后一次产出算，照旧接手
 *   QM-D-04 页面连着但停报忙：从最后一次报忙起算，超 30 s 照旧接手
 *   QM-D-05 页面恢复产出：锁续上（仍在它的指纹上、闲置归零、记的节点仍是它）
 *   QM-D-06 旧页面（不报 node.active）：两个队列实例、同一串消息，回包与改动前的算法一致
 *   QM-D-07 别的节点报忙不作数：同指纹的另一个节点、换了指纹重新报到的原节点
 *   QM-D-08 消息格式：busy 不是字符串 / 太长回 bad-message；不是节点的连接回 not-registered；成功不回包
 *   QM-D-09 describe：报过忙的节点才多 activeAt / activeBusy
 *   QM-D-10 进程内（真队列 + 真切分方）：浏览器锁着卡、忙 60 s 不产出，新一版计划不被接手；随后断开，再下一版被 pc 接手
 *
 * 跑：node --test server/test/queue-maint-d2-busy.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRenderQueue, clipsPlanTaskOf } from '../render-queue/index.mjs';
import { NODE_ACTIVE_INTERVAL_MS, LOCK_IDLE_TAKEOVER_MS } from '../render-queue/constants.mjs';
import { NODE_TYPES } from '../render-queue/messages.mjs';
import { createLocalNode, idleLockTakeover } from '../render-node/local-node.mjs';
import { createQueueHarness, makeTaskInput, T0 } from './fake-render-queue-env.mjs';

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const rk = (contentKey, fp) => sha256(`${contentKey}\n${fp}`);
const P = 'pppppppppppppppp';
const B = 'bbbbbbbbbbbbbbbb';
const X = 'xxxxxxxxxxxxxxxx';
const CV = 'c0de5a';

function snap(ck, fp, from = 0) {
  return makeTaskInput({ projectId: 'p1', kind: 'snapshot', resultKey: rk(ck, fp), range: [from, from + 59], input: { clipId: `clip-${ck}`, contentKey: ck }, requires: { envFingerprint: fp } });
}

/** 发布方 p、切分节点 pc（P）、同用户的浏览器节点 bw（B，watch p1） */
function setup() {
  const h = createQueueHarness(createRenderQueue);
  h.publisher('p', 'pub-p');
  h.node('pc', 'node-pc', { hello: { envFingerprint: P } });
  h.node('bw', 'node-bw', { profile: 'browser', watch: ['p1'], hello: { envFingerprint: B } });
  h.bus.clear();
  return h;
}
const active = (h, conn, busy = 'bake') => h.handle(conn, { type: 'node.active', ...(busy === undefined ? {} : { busy }) });
/** pc 照自己的指纹发一份被锁在 B 上的卡：回包（card-locked，带 lockIdleMs / lockUndone） */
const probe = (h, ck = 'ck1') => {
  const out = h.publish('p', [snap(ck, P, 0)]);
  return out.one('p', 'task.published').results[0];
};
const takes = (r) => idleLockTakeover(`snapshot:${'ck1'}`, r.lockedBy, r);

/** 浏览器锁住 ck1（认领第一段、报一次进度），第二段还 open */
function lockOnBrowser(h, before = []) {
  const br0 = snap('ck1', B, 0), br1 = snap('ck1', B, 60);
  h.publish('p', [...before, br0, br1]);
  const c = h.claim('bw', br0.id, 1).one('bw', 'task.claimed');
  h.progress('bw', br0.id, c.token, 1);
  h.complete('bw', br0.id, c.token, {});
  return { br0, br1 };
}

test('QM-D-01 node.welcome 带 activeIntervalMs（新队列认 node.active）；间隔远小于接手门槛 30 s', () => {
  const h = createQueueHarness(createRenderQueue);
  const out = h.node('bw', 'node-bw', { profile: 'browser', watch: null, hello: { envFingerprint: B } });
  const w = out.one('bw', 'node.welcome');
  assert.equal(w.activeIntervalMs, NODE_ACTIVE_INTERVAL_MS);
  assert.ok(NODE_ACTIVE_INTERVAL_MS * 2 < LOCK_IDLE_TAKEOVER_MS, '两次报忙之间锁的闲置远到不了接手门槛');
  assert.ok(NODE_TYPES.has('node.active'), 'node.active 是节点连接的消息（文档服务按这张表路由给队列）');
});

test('QM-D-02 页面忙：锁着 ck1、手里在做别的（每 10 s 报一次 node.active），60 s 没为 ck1 产出 —— 闲置不涨，切分方不接手', () => {
  const h = setup();
  const own1 = snap('ck1', P, 60);   // 切分方那份在上锁之前就发过（不带 dual，上锁后留着、被锁挡住）
  lockOnBrowser(h, [own1]);
  for (let i = 0; i < 6; i++) { h.advance(NODE_ACTIVE_INTERVAL_MS); active(h, 'bw', 'bake'); }
  h.advance(4_000);
  const r = probe(h);
  assert.equal(r.error, 'card-locked');
  assert.equal(r.lockedBy, B);
  assert.equal(r.lockIdleMs, 4_000, '从最后一次报忙起算');
  assert.equal(r.lockUndone, 1, '第二段还没做');
  assert.equal(takes(r), false, '切分方判不接手');
  // 认领回包那条路（切分方拿着旧视图来认领被锁的卡）同样按报忙算
  const rej = h.claim('pc', own1.id, 1).one('pc', 'task.claim-rejected');
  assert.deepEqual([rej.reason, rej.lockIdleMs], ['card-locked', 4_000]);
  assert.equal(h.describe().locks.find((l) => l.lockKey === 'snapshot:ck1').envFingerprint, B, '锁仍在浏览器上');
});

test('QM-D-03 页面断开：报过的忙立即不作数，闲置按最后一次产出算，超 30 s 照旧接手', () => {
  const h = setup();
  lockOnBrowser(h);
  for (let i = 0; i < 4; i++) { h.advance(NODE_ACTIVE_INTERVAL_MS); active(h, 'bw'); }
  h.disconnect('bw');
  const r = probe(h);
  assert.equal(r.lockIdleMs, 4 * NODE_ACTIVE_INTERVAL_MS, '断开之后只看产出（40 s 前完成的那一段）');
  assert.equal(takes(r), true, '照旧接手');
  // 宽限期内重连回来又报忙：重新作数（页面没走）
  h.node('bw2', 'node-bw', { profile: 'browser', watch: ['p1'], hello: { envFingerprint: B } });
  active(h, 'bw2');
  h.advance(1_000);
  assert.equal(probe(h).lockIdleMs, 1_000);
});

test('QM-D-04 页面连着但不再报忙（闲着、隐藏、只是在播放）：从最后一次报忙起算，超 30 s 照旧接手', () => {
  const h = setup();
  lockOnBrowser(h);
  h.advance(NODE_ACTIVE_INTERVAL_MS);
  active(h, 'bw');
  h.advance(30_000);
  const at30 = probe(h);
  assert.equal(at30.lockIdleMs, 30_000);
  assert.equal(takes(at30), false, '严格超过 30 s 才接手');
  h.advance(1);
  const r = probe(h);
  assert.equal(r.lockIdleMs, 30_001);
  assert.equal(takes(r), true);
});

test('QM-D-05 页面忙完回来接着做 ck1：锁续上（仍在 B 上、闲置归零、记的节点仍是它），之后再忙照样不被接手', () => {
  const h = setup();
  const { br1 } = lockOnBrowser(h);
  for (let i = 0; i < 5; i++) { h.advance(NODE_ACTIVE_INTERVAL_MS); active(h, 'bw'); }
  h.advance(2_000);
  const c = h.claim('bw', br1.id, 1).one('bw', 'task.claimed');
  assert.ok(c, '浏览器照常认领到第二段');
  const r0 = probe(h);
  assert.deepEqual([r0.lockedBy, r0.lockIdleMs], [B, 0]);
  h.advance(25_000);
  h.progress('bw', br1.id, c.token, 30);
  h.advance(20_000);
  active(h, 'bw', 'stage');
  h.advance(3_000);
  assert.equal(probe(h).lockIdleMs, 3_000, '续约记下了节点，之后的报忙照样作数');
  h.complete('bw', br1.id, c.token, {});
  const done = probe(h);
  assert.deepEqual([done.lockIdleMs, done.lockUndone], [0, 0]);
});

test('QM-D-06 旧页面（不报 node.active）：回包与改动前的算法（此刻减最后一次产出）一致，连着也照旧接手', () => {
  const h = setup();
  lockOnBrowser(h);
  const seen = [];
  for (const step of [5_000, 10_000, 15_000, 1, 30_000]) {
    h.advance(step);
    const r = probe(h);
    seen.push(r.lockIdleMs);
    assert.equal(r.lockIdleMs, h.now() - T0, '最后一次产出在 T0（完成第一段）');
  }
  assert.deepEqual(seen, [5_000, 15_000, 30_000, 30_001, 60_001]);
  assert.equal(h.nodeInfo('node-bw').connected, true, '旧页面一直连着');
  assert.equal(takes(probe(h)), true, '连着也照旧接手（行为同改动之前）');
  assert.equal('activeAt' in h.nodeInfo('node-bw'), false);
});

test('QM-D-07 别的节点报忙不作数：同指纹、同用户的另一个页面；换了指纹重新报到的原节点', () => {
  const h = setup();
  lockOnBrowser(h);
  h.node('bw2', 'node-bw2', { profile: 'browser', watch: ['p1'], hello: { envFingerprint: B } });
  h.node('bw3', 'node-bw3', { profile: 'browser', userId: 'u2', watch: ['p1'], hello: { envFingerprint: B } });
  for (let i = 0; i < 4; i++) { h.advance(NODE_ACTIVE_INTERVAL_MS); active(h, 'bw2'); active(h, 'bw3'); }
  assert.equal(probe(h).lockIdleMs, 40_000, '锁记的是 node-bw，别的节点报忙不算');
  // node-bw 换了指纹重新报到：它再报忙也不作数（锁在 B 上，它已不是 B 的环境）
  h.hello('bw', 'node-bw', { profile: 'browser', envFingerprint: X });
  active(h, 'bw');
  h.advance(1_000);
  assert.equal(probe(h).lockIdleMs, 41_000);
});

test('QM-D-08 node.active 的格式：busy 不是字符串或超过 32 字回 bad-message；没报到的连接回 not-registered；成功不回包', () => {
  const h = setup();
  const ok = active(h, 'bw', 'bake');
  assert.deepEqual(ok.types('bw'), [], '成功不回包');
  const none = h.handle('bw', { type: 'node.active', reqId: 'r1' });
  assert.deepEqual(none.types('bw'), [], '不带 busy 也收；带了 reqId 也不回');
  for (const busy of [1, true, {}, 'x'.repeat(33)]) {
    const out = h.handle('bw', { type: 'node.active', busy, reqId: 'r2' });
    const e = out.one('bw', 'error');
    assert.deepEqual([e.reason, e.reqId], ['bad-message', 'r2'], JSON.stringify(busy));
  }
  h.publisher('p2', 'pub-2');
  const out = h.handle('p2', { type: 'node.active' });
  assert.equal(out.one('p2', 'error').reason, 'not-registered');
});

test('QM-D-09 describe：报过忙的节点多 activeAt / activeBusy，别的节点形状不变', () => {
  const h = setup();
  h.advance(1_234);
  active(h, 'bw', 'stage');
  const bw = h.nodeInfo('node-bw');
  assert.deepEqual([bw.activeAt, bw.activeBusy], [T0 + 1_234, 'stage']);
  assert.equal('activeAt' in h.nodeInfo('node-pc'), false);
});

/* ------------------------------------------------------------------ 进程内：真队列 + 真切分方 */

const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const weightOf = () => ({ class: 'medium', estMs: null });

function inproc() {
  let t = T0;
  const routes = new Map();
  const log = [];
  const q = createRenderQueue({ now: () => t, send: (connId, message) => { const m = JSON.parse(JSON.stringify(message)); log.push({ connId, m }); routes.get(connId)?.(m); } });
  const endpointOf = (connId, principal) => {
    q.connect(connId, principal);
    return { send: (m) => q.handle(connId, JSON.parse(JSON.stringify(m))), onMessage: (h) => routes.set(connId, h) };
  };
  return { q, log, now: () => t, advance(ms) { t += ms; q.tick(); }, endpointOf, of: (connId, type) => log.filter((e) => e.connId === connId && e.m.type === type).map((e) => e.m) };
}

function control(clipId, contentKey, count) {
  return {
    key: `png-${clipId}`, snapshotKey: rk(contentKey, P), contentKey, tier: 'shared', capabilities: { frameMode: 'stateful', compositing: 'independent' },
    clipId, nodeId: `n:${clipId}`, start: 0, end: count / 30, count,
    sampling: { firstFrame: 0, fps: { numerator: 30, denominator: 1 }, phase: { numerator: 0, denominator: 1 } }, compositing: 'independent', envFingerprint: P,
  };
}

function pcSplitter(env, cardPlan) {
  const endpoint = env.endpointOf('pc', { userId: 'rig@pc', tenantId: 't1' });
  const local = createLocalNode({
    nodeId: 'pc-1', node: { profile: 'pc', envFingerprint: P, codeVersions: [CV] }, endpoint, now: env.now, codeVersion: CV,
    executor: { plan: async () => ({ entryKey: 'entry-1', cardPlan, weightOf, anchorFrames: [] }), render: async () => null },
    sink: { has: async () => false, put: async () => ({ complete: true }) },
    // 细任务不让 pc 做：只切分，锁的走向由测试掌握
    isIdle: () => local.session.known().some((t) => t.kind === 'plan'), takeoverLocked: idleLockTakeover,
  });
  local.start();
  return local;
}

test('QM-D-10 进程内：浏览器锁着卡、手里忙别的 60 s（报忙、不产出）—— 新一版计划不被 pc 接手；浏览器断开后再下一版被 pc 接手', async () => {
  const env = inproc();
  const a = control('a', 'ck-a', 120);
  const pc = pcSplitter(env, [a]);
  const page = env.endpointOf('page', { userId: 'zoe@devA', tenantId: 't1' });
  page.send({ type: 'publisher.hello', publisherId: 'pub-page' });
  const br = env.endpointOf('br', { userId: 'zoe@devA', tenantId: 't1' });
  br.send({ type: 'node.hello', nodeId: 'n-br', profile: 'browser', envFingerprint: B });
  br.send({ type: 'queue.watch', projects: ['p1'] });
  assert.equal(env.of('br', 'node.welcome')[0].activeIntervalMs, NODE_ACTIVE_INTERVAL_MS);

  const plan1 = clipsPlanTaskOf({ projectId: 'p1', projectRev: 1, clips: ['a'], codeVersion: CV });
  page.send({ type: 'task.publish', tasks: [plan1] });
  pc.tick();
  await flush();
  const brTasks = env.q.describe().tasks.filter((t) => t.id.startsWith(`snapshot:${rk('ck-a', B)}`));
  assert.equal(brTasks.length, 2);
  br.send({ type: 'task.claim', id: brTasks[0].id, expectVersion: 1 });
  const token = env.of('br', 'task.claimed').find((m) => m.id === brTasks[0].id).token;
  br.send({ type: 'task.progress', id: brTasks[0].id, token, done: 60 });
  br.send({ type: 'task.complete', id: brTasks[0].id, token, result: {} });

  // 页面在忙别的（别的卡、测量）：60 s 没为这张卡产出，但每 10 s 报一次忙
  for (let i = 0; i < 6; i++) { env.advance(NODE_ACTIVE_INTERVAL_MS); br.send({ type: 'node.active', busy: 'stage' }); }
  const plan2 = clipsPlanTaskOf({ projectId: 'p1', projectRev: 2, clips: ['a'], codeVersion: CV });
  const mark = env.log.length;
  page.send({ type: 'task.publish', tasks: [plan2] });
  pc.tick();
  await flush();
  assert.ok(env.of('pc', 'task.claimed').some((m) => m.id === plan2.id), '第二版计划由 pc 认领、切分过');
  let d = env.q.describe();
  assert.equal(d.locks.find((l) => l.lockKey === 'snapshot:ck-a').envFingerprint, B, '页面只是忙：锁仍在浏览器上');
  assert.equal(d.tasks.find((t) => t.id === brTasks[1].id).state, 'open', '浏览器那份第二段还在，等它回来做');
  assert.equal(d.tasks.find((t) => t.id === brTasks[0].id).state, 'done', '已做的那段不白费');
  assert.ok(!env.log.slice(mark).some((e) => e.connId === 'pc' && e.m.type === 'task.published' && e.m.results.some((r) => r.created && r.id.includes(rk('ck-a', P)))),
    'pc 没按自己的指纹另起一套键');

  // 浏览器走了：断开，宽限期过后下一版计划由 pc 接手整张卡
  env.q.disconnect('br');
  env.advance(11_000);
  env.advance(5_000);
  const plan3 = clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips: ['a'], codeVersion: CV });
  page.send({ type: 'task.publish', tasks: [plan3] });
  pc.tick();
  await flush();
  d = env.q.describe();
  assert.equal(d.locks.find((l) => l.lockKey === 'snapshot:ck-a').envFingerprint, P, '页面走了：锁转给 pc');
  assert.equal(d.tasks.find((t) => t.id === brTasks[1].id).lastError, 'superseded');
  pc.stop();
  await pc.settled();
});
